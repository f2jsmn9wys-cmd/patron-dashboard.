// POST /api/telegram — Telegram bot webhook.
//
// Flow: Telegram sends every message your bot receives to this endpoint.
// Text or voice -> transcribe (voice) -> classify with Claude into a small
// set of known actions -> read/modify/write the SAME Supabase `app_state`
// rows the app's own cloud sync uses (so it shows up instantly on every
// synced device) -> reply with a confirmation in the chat.
//
// Env vars needed (Vercel -> Project -> Settings -> Environment Variables):
//   TELEGRAM_BOT_TOKEN   from @BotFather
//   ANTHROPIC_API_KEY    classifies the message (cheap Haiku call)
//   OPENAI_API_KEY       optional — transcribes voice notes (Whisper).
//                         Without it, voice messages get a friendly "send text" reply.
//   SUPABASE_URL, SUPABASE_ANON_KEY — same project as the app's own cloud sync
//
// After setting the env vars, point Telegram at this URL once:
//   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://YOUR-APP.vercel.app/api/telegram

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_ANON_KEY || '').trim();
const TG_API = TG_TOKEN ? `https://api.telegram.org/bot${TG_TOKEN}` : null;

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 200; res.end('ok'); return; }
  if (!TG_API) { res.statusCode = 200; res.end('not_configured'); return; }

  let update = req.body;
  if (typeof update === 'string') { try { update = JSON.parse(update); } catch (_) { update = null; } }
  const msg = update && update.message;
  const chatId = msg && msg.chat && msg.chat.id;
  if (!msg || !chatId) { res.statusCode = 200; res.end('ok'); return; }

  try {
    let text = (msg.text || '').trim();
    if (!text && msg.voice) {
      text = await transcribeVoice(msg.voice.file_id);
      if (!text) {
        await reply(chatId, '🎙️ Konnte die Sprachnachricht nicht transkribieren (OPENAI_API_KEY fehlt oder leer) — bitte als Text schicken.');
        res.end('ok'); return;
      }
    }
    if (!text) {
      await reply(chatId, 'Schick mir Text oder eine Sprachnachricht, z.B. "2L Wasser getrunken" oder "Gewicht heute 77.5kg".');
      res.end('ok'); return;
    }

    const actions = await classify(text);
    const confirmations = [];
    for (const action of actions) confirmations.push(await applyAction(action));
    await reply(chatId, confirmations.join('\n'));
  } catch (e) {
    try { await reply(chatId, '⚠️ Da ist etwas schiefgelaufen: ' + (e && e.message || String(e))); } catch (_) {}
  }
  res.statusCode = 200; res.end('ok');
};

async function reply(chatId, text) {
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function transcribeVoice(fileId) {
  if (!OPENAI_KEY) return '';
  const fj = await (await fetch(`${TG_API}/getFile?file_id=${fileId}`)).json();
  const path = fj && fj.result && fj.result.file_path;
  if (!path) return '';
  const audioRes = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${path}`);
  const buf = Buffer.from(await audioRes.arrayBuffer());
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/ogg' }), 'voice.ogg');
  form.append('model', 'whisper-1');
  const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: form,
  });
  const tj = await tr.json();
  return ((tj && tj.text) || '').trim();
}

// Claude sorts the message into one or more known shapes. A single message
// can carry several facts at once (water + weight + a workout, etc.) — it
// always returns a JSON array, one object per fact it found.
async function classify(text) {
  if (!ANTHROPIC_KEY) return [{ type: 'note', text }];
  const sys = 'Du ordnest deutsche oder englische Nachrichten einer Fitness-/Gesundheits-Tracking-App in eine oder mehrere ' +
    'Kategorien ein. Eine Nachricht kann MEHRERE Fakten enthalten (z.B. Wasser UND Gewicht UND ein Workout) — gib dann ' +
    'mehrere Objekte zurueck, eines pro Fakt. Antworte NUR mit einem kompakten JSON-Array, ohne Erklaerung, ohne Markdown-Codeblock.\n\n' +
    'Moegliche Objekte:\n' +
    '{"type":"water","glasses":<Anzahl 250ml-Glaeser; 1 Liter = 4>}\n' +
    '{"type":"weight","kg":<Koerpergewicht als Zahl>}\n' +
    '{"type":"sleep","hours":<Schlafstunden als Zahl; bei einer Spanne wie "4-5h" den Mittelwert nehmen>}\n' +
    '{"type":"food","name":"<kurze Beschreibung der Mahlzeit/des Lebensmittels>","cal":<geschaetzte kcal>,"p":<Protein g>,"c":<Kohlenhydrate g>,"f":<Fett g>}\n' +
    '{"type":"workout","exercises":[{"name":"<Uebungsname, saubere Standardschreibweise z.B. "Bench Press">","sets":[{"reps":<Zahl>,"weight":<kg als Zahl, 0 falls Koerpergewicht>}]}]}\n' +
    '{"type":"todo","items":["<Aufgabe 1>","<Aufgabe 2>"]}\n' +
    '{"type":"note","text":"<Originalnachricht oder der Teil davon, leicht aufgeraeumt>"}\n\n' +
    'LOESCHEN/ZURUECKSETZEN — nur wenn die Nachricht klar eine Loesch-/Korrektur-Absicht ausdrueckt ' +
    '(Woerter wie "loesche", "entferne", "raus", "zurueck", "abziehen", "weg damit", "stornieren", "rueckgaengig"):\n' +
    '{"type":"water_delete","glasses":<Anzahl zu entfernender Glaeser; falls nicht genannt: 1>}\n' +
    '{"type":"weight_delete"} (loescht den heutigen Gewichtseintrag)\n' +
    '{"type":"sleep_delete"} (loescht den heutigen Schlafeintrag)\n' +
    '{"type":"food_delete","name":"<optional: welche Mahlzeit; sonst wird die zuletzt eingetragene heutige Mahlzeit geloescht>"}\n' +
    '{"type":"workout_delete","exercise":"<optional: Uebungsname; sonst werden ALLE heute geloggten Saetze entfernt>"}\n' +
    '{"type":"todo_delete","text":"<optional: welche Aufgabe; sonst werden ALLE heutigen Todos geloescht>"}\n' +
    '{"type":"reset_all"} — NUR wenn die Nachricht ausdruecklich verlangt, WIRKLICH ALLES zurueckzusetzen/zu loeschen ' +
    '(z.B. "loesche alle eintraege komplett", "setze alles auf null/zurueck"). Im Zweifel NICHT reset_all nehmen, sondern note.\n\n' +
    'Regeln:\n' +
    '- "food" ist fuer einzelne Mahlzeiten/Snacks ("habe einen Apfel gegessen", "Mittagessen: Hühnchen mit Reis"), NICHT für allgemeine Ernaehrungsfragen.\n' +
    '- "workout" ist fuer Trainingseinheiten/Saetze, egal ob ein einzelner Satz ("Bankdruecken 80kg x8") oder ein ganzes eingefuegtes Workout ' +
    'mit mehreren Uebungen/Zeilen (z.B. eine Liste "Uebung Saetzexwdh@gewicht" pro Zeile). Erkenne JEDE Zeile als eigene Uebung mit ihren Saetzen.\n' +
    '- "todo" ist fuer Aufgaben/Vorhaben fuer heute ("speichere diese todos fuer heute: einkaufen, anrufen", "ich muss noch X erledigen").\n' +
    '- Schaetze bei "food" realistische Makros nach bestem Wissen, auch wenn die Mahlzeit nur grob beschrieben ist.\n' +
    '- Wenn ein Teil der Nachricht zu keiner bekannten Kategorie passt oder alles unklar/eine reine Beobachtung ist, nimm "note" dafuer.\n\n' +
    'Beispiele:\n' +
    '"Habe heute 2L Wasser getrunken und mein Gewicht ist bei 99" -> [{"type":"water","glasses":8},{"type":"weight","kg":99}]\n' +
    '"habe 5h geschlafen" -> [{"type":"sleep","hours":5}]\n' +
    '"normalerweise schlafe ich so 4-5h" -> [{"type":"sleep","hours":4.5}]\n' +
    '"Bankdruecken 3x8 80kg\\nKniebeuge 3x5 100kg" -> [{"type":"workout","exercises":[{"name":"Bench Press","sets":[{"reps":8,"weight":80},{"reps":8,"weight":80},{"reps":8,"weight":80}]},{"name":"Squat","sets":[{"reps":5,"weight":100},{"reps":5,"weight":100},{"reps":5,"weight":100}]}]}]\n' +
    '"loesche drei glaeser wasser raus" -> [{"type":"water_delete","glasses":3}]\n' +
    '"loesche meinen schlaf heute" -> [{"type":"sleep_delete"}]\n' +
    '"speichere diese todos fuer heute: waesche waschen, einkaufen" -> [{"type":"todo","items":["Wäsche waschen","Einkaufen"]}]\n' +
    '"loesche alle eintraege komplett, alles auf null" -> [{"type":"reset_all"}]';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      system: sys,
      messages: [{ role: 'user', content: text }],
    }),
  });
  const j = await r.json();
  const out = (j && j.content && j.content[0] && j.content[0].text) || '';
  const m = out.match(/\[[\s\S]*\]/);
  try {
    const arr = m ? JSON.parse(m[0]) : null;
    return Array.isArray(arr) && arr.length ? arr : [{ type: 'note', text }];
  } catch (_) { return [{ type: 'note', text }]; }
}

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function sbGet(key) {
  const r = await fetch(`${SB_URL}/rest/v1/app_state?key=eq.${encodeURIComponent(key)}&select=data`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  const j = await r.json();
  return (j && j[0] && j[0].data) || null;
}
async function sbUpsert(key, data) {
  await fetch(`${SB_URL}/rest/v1/app_state`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'content-type': 'application/json', Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
  });
}

async function applyAction(action) {
  if (!SB_URL || !SB_KEY) {
    return 'ℹ️ Verstanden, aber SUPABASE_URL/SUPABASE_ANON_KEY fehlen noch als Vercel-Env-Vars auf dem Server.';
  }

  // Water rides inside the app's whole-device snapshot row, under the same
  // localStorage key water.html itself uses (water_standalone_v1).
  if (action.type === 'water') {
    const glasses = Math.max(1, Math.round(Number(action.glasses) || 1));
    const snap = (await sbGet('patron-device-snapshot')) || { blob: {}, ts: 0 };
    snap.blob = snap.blob || {};
    let water;
    try { water = JSON.parse(snap.blob.water_standalone_v1 || '{}'); } catch (_) { water = {}; }
    water.logs = water.logs || {};
    const k = todayKey();
    water.logs[k] = (water.logs[k] || 0) + glasses;
    snap.blob.water_standalone_v1 = JSON.stringify(water);
    snap.ts = Date.now();
    await sbUpsert('patron-device-snapshot', snap);
    return `💧 ${glasses} Glas/Gläser Wasser eingetragen (heute insgesamt: ${water.logs[k]}).`;
  }

  // Weight is displayed on the Progress page. On load it overrides local
  // state with PatronDB.get('patron-progress'), which reads localStorage key
  // "patron_db_patron-progress" — THAT key (not progress_standalone_v1) is
  // what actually rides in the cloud snapshot and wins on every page load.
  if (action.type === 'weight') {
    const kg = Number(action.kg);
    if (!kg) return '⚠️ Konnte das Gewicht nicht lesen — bitte z.B. "Gewicht 77.5kg" schreiben.';
    const snap = (await sbGet('patron-device-snapshot')) || { blob: {}, ts: 0 };
    snap.blob = snap.blob || {};
    let progress;
    try { progress = JSON.parse(snap.blob['patron_db_patron-progress'] || '{}'); } catch (_) { progress = {}; }
    progress.units = progress.units || 'kg';
    progress.entries = Array.isArray(progress.entries) ? progress.entries : [];
    const k = todayKey();
    const idx = progress.entries.findIndex((e) => e.dateKey === k);
    if (idx >= 0) progress.entries[idx].weightKg = kg; else progress.entries.push({ dateKey: k, weightKg: kg });
    snap.blob['patron_db_patron-progress'] = JSON.stringify(progress);
    // Also keep the page's own non-cloud-keyed copy in sync for consistency.
    snap.blob.progress_standalone_v1 = JSON.stringify(progress);
    snap.ts = Date.now();
    await sbUpsert('patron-device-snapshot', snap);
    return `⚖️ Gewicht heute auf ${kg}kg eingetragen.`;
  }

  // Sleep rides under "patron_health_v1" — the suite-wide vitals record also
  // written by the dashboard's manual-entry form / Apple Watch / Whoop.
  if (action.type === 'sleep') {
    const hours = Number(action.hours);
    if (!hours) return '⚠️ Konnte die Schlafdauer nicht lesen — bitte z.B. "5h geschlafen" schreiben.';
    const snap = (await sbGet('patron-device-snapshot')) || { blob: {}, ts: 0 };
    snap.blob = snap.blob || {};
    let health;
    try { health = JSON.parse(snap.blob.patron_health_v1 || '{}'); } catch (_) { health = {}; }
    const target = health.sleepTargetHours || 8;
    health.source = 'manual';
    health.connected = true;
    health.ts = Date.now();
    health.sleepHours = hours;
    health.sleepPerf = Math.round(Math.min(100, (hours / target) * 100));
    health.sleepTargetHours = target;
    snap.blob.patron_health_v1 = JSON.stringify(health);
    snap.ts = Date.now();
    await sbUpsert('patron-device-snapshot', snap);
    return `😴 ${hours}h Schlaf eingetragen (${health.sleepPerf}% vom Ziel).`;
  }

  // Food rides under "macros_standalone_v1": { [dateKey]: [{name,cal,p,c,f}], goalCal }.
  if (action.type === 'food') {
    const snap = (await sbGet('patron-device-snapshot')) || { blob: {}, ts: 0 };
    snap.blob = snap.blob || {};
    let macros;
    try { macros = JSON.parse(snap.blob.macros_standalone_v1 || '{}'); } catch (_) { macros = {}; }
    const k = todayKey();
    macros[k] = Array.isArray(macros[k]) ? macros[k] : [];
    const entry = {
      name: action.name || 'Mahlzeit',
      cal: Math.round(Number(action.cal) || 0),
      p: Math.round(Number(action.p) || 0),
      c: Math.round(Number(action.c) || 0),
      f: Math.round(Number(action.f) || 0),
    };
    macros[k].push(entry);
    snap.blob.macros_standalone_v1 = JSON.stringify(macros);
    snap.ts = Date.now();
    await sbUpsert('patron-device-snapshot', snap);
    return `🍽️ "${entry.name}" eingetragen (${entry.cal} kcal, ${entry.p}g P / ${entry.c}g C / ${entry.f}g F).`;
  }

  // Workouts ride in gym's own row (key "po-coach"), under po_coach_v1's
  // exercises[] (matched by name, created if new) and logs{} (one entry per set).
  if (action.type === 'workout' && Array.isArray(action.exercises) && action.exercises.length) {
    const state = (await sbGet('po-coach')) || {};
    const coach = state.po_coach_v1 = state.po_coach_v1 || { days: [], gyms: [], exercises: [], logs: {}, units: 'kg' };
    coach.exercises = Array.isArray(coach.exercises) ? coach.exercises : [];
    coach.logs = coach.logs && typeof coach.logs === 'object' ? coach.logs : {};
    const defaultDay = coach.filterDay || (coach.days[0] && coach.days[0].id) || 'push';
    const defaultGym = coach.filterGym || (coach.gyms[0] && coach.gyms[0].id) || 'home';

    const summaries = [];
    let createdCount = 0;
    action.exercises.forEach((ex, exIdx) => {
      const name = (ex.name || '').trim();
      if (!name) return;
      const sets = Array.isArray(ex.sets) ? ex.sets.filter((s) => s && Number(s.reps) > 0) : [];
      if (!sets.length) return;

      let exObj = coach.exercises.find((e) => e.name && e.name.toLowerCase() === name.toLowerCase());
      if (!exObj) {
        const reps = sets.map((s) => Number(s.reps));
        const weights = sets.map((s) => Number(s.weight) || 0);
        exObj = {
          id: 'tg_' + Date.now() + '_' + exIdx,
          day: defaultDay, gym: defaultGym, name,
          step: 2.5, repMin: Math.min(...reps), repMax: Math.max(...reps, Math.min(...reps) + 2),
          startWeight: Math.max(...weights, 0),
        };
        coach.exercises.push(exObj);
        createdCount++;
      }
      coach.logs[exObj.id] = Array.isArray(coach.logs[exObj.id]) ? coach.logs[exObj.id] : [];
      sets.forEach((s, i) => {
        coach.logs[exObj.id].push({
          date: new Date(Date.now() + exIdx * 1000 + i).toISOString(),
          reps: Number(s.reps), weight: Number(s.weight) || 0,
        });
      });
      const topSet = sets.reduce((a, b) => (Number(b.weight) || 0) > (Number(a.weight) || 0) ? b : a, sets[0]);
      summaries.push(`${name}: ${sets.length} Satz/Sätze (Top ${topSet.weight || 0}kg × ${topSet.reps})`);
    });

    if (!summaries.length) return '⚠️ Konnte aus dem Workout keine gültigen Sätze herauslesen.';
    await sbUpsert('po-coach', state);
    return `🏋️ Workout gespeichert${createdCount ? ` (${createdCount} neue Übung/en angelegt)` : ''}:\n` + summaries.join('\n');
  }

  if (action.type === 'todo') {
    const items = Array.isArray(action.items) ? action.items.filter(Boolean) : [];
    if (!items.length) return '⚠️ Keine Todos gefunden.';
    const key = 'goals:' + todayKey();
    const snap = (await sbGet('patron-device-snapshot')) || { blob: {}, ts: 0 };
    snap.blob = snap.blob || {};
    let list;
    try { list = JSON.parse(snap.blob[key] || '[]'); } catch (_) { list = []; }
    if (!Array.isArray(list)) list = [];
    items.forEach((text) => list.push({ text: String(text), done: false }));
    snap.blob[key] = JSON.stringify(list);
    snap.ts = Date.now();
    await sbUpsert('patron-device-snapshot', snap);
    return `✅ ${items.length} Todo(s) für heute gespeichert: ${items.join(', ')}.`;
  }

  if (action.type === 'water_delete') {
    const glasses = Math.max(1, Math.round(Number(action.glasses) || 1));
    const snap = (await sbGet('patron-device-snapshot')) || { blob: {}, ts: 0 };
    snap.blob = snap.blob || {};
    let water;
    try { water = JSON.parse(snap.blob.water_standalone_v1 || '{}'); } catch (_) { water = {}; }
    water.logs = water.logs || {};
    const k = todayKey();
    water.logs[k] = Math.max(0, (water.logs[k] || 0) - glasses);
    snap.blob.water_standalone_v1 = JSON.stringify(water);
    snap.ts = Date.now();
    await sbUpsert('patron-device-snapshot', snap);
    return `💧 ${glasses} Glas/Gläser entfernt (heute jetzt: ${water.logs[k]}).`;
  }

  if (action.type === 'weight_delete') {
    const snap = (await sbGet('patron-device-snapshot')) || { blob: {}, ts: 0 };
    snap.blob = snap.blob || {};
    let progress;
    try { progress = JSON.parse(snap.blob['patron_db_patron-progress'] || '{}'); } catch (_) { progress = {}; }
    progress.entries = Array.isArray(progress.entries) ? progress.entries : [];
    const k = todayKey();
    const before = progress.entries.length;
    progress.entries = progress.entries.filter((e) => e.dateKey !== k);
    snap.blob['patron_db_patron-progress'] = JSON.stringify(progress);
    snap.blob.progress_standalone_v1 = JSON.stringify(progress);
    snap.ts = Date.now();
    await sbUpsert('patron-device-snapshot', snap);
    return progress.entries.length < before ? '⚖️ Heutiger Gewichtseintrag gelöscht.' : 'ℹ️ Es gab heute keinen Gewichtseintrag zum Löschen.';
  }

  if (action.type === 'sleep_delete') {
    const snap = (await sbGet('patron-device-snapshot')) || { blob: {}, ts: 0 };
    snap.blob = snap.blob || {};
    let health;
    try { health = JSON.parse(snap.blob.patron_health_v1 || '{}'); } catch (_) { health = {}; }
    delete health.sleepHours; delete health.sleepPerf;
    health.ts = Date.now();
    snap.blob.patron_health_v1 = JSON.stringify(health);
    snap.ts = Date.now();
    await sbUpsert('patron-device-snapshot', snap);
    return '😴 Heutiger Schlafeintrag gelöscht.';
  }

  if (action.type === 'food_delete') {
    const snap = (await sbGet('patron-device-snapshot')) || { blob: {}, ts: 0 };
    snap.blob = snap.blob || {};
    let macros;
    try { macros = JSON.parse(snap.blob.macros_standalone_v1 || '{}'); } catch (_) { macros = {}; }
    const k = todayKey();
    const list = Array.isArray(macros[k]) ? macros[k] : [];
    let removed = null;
    if (action.name) {
      const idx = list.findIndex((e) => e.name && e.name.toLowerCase().includes(String(action.name).toLowerCase()));
      if (idx >= 0) removed = list.splice(idx, 1)[0];
    } else if (list.length) {
      removed = list.pop();
    }
    macros[k] = list;
    snap.blob.macros_standalone_v1 = JSON.stringify(macros);
    snap.ts = Date.now();
    await sbUpsert('patron-device-snapshot', snap);
    return removed ? `🍽️ "${removed.name}" wieder entfernt.` : 'ℹ️ Keine passende Mahlzeit zum Löschen gefunden.';
  }

  if (action.type === 'workout_delete') {
    const state = (await sbGet('po-coach')) || {};
    const coach = state.po_coach_v1;
    if (!coach || !coach.logs) return 'ℹ️ Es gibt noch keine Trainings-Logs.';
    const k = todayKey();
    let removedCount = 0;
    const ids = action.exercise
      ? coach.exercises.filter((e) => e.name && e.name.toLowerCase().includes(String(action.exercise).toLowerCase())).map((e) => e.id)
      : Object.keys(coach.logs);
    ids.forEach((id) => {
      const before = (coach.logs[id] || []).length;
      coach.logs[id] = (coach.logs[id] || []).filter((l) => !l.date || !l.date.startsWith(k));
      removedCount += before - coach.logs[id].length;
    });
    await sbUpsert('po-coach', state);
    return removedCount ? `🏋️ ${removedCount} heutige(n) Satz/Sätze gelöscht.` : 'ℹ️ Keine passenden heutigen Sätze gefunden.';
  }

  if (action.type === 'todo_delete') {
    const key = 'goals:' + todayKey();
    const snap = (await sbGet('patron-device-snapshot')) || { blob: {}, ts: 0 };
    snap.blob = snap.blob || {};
    let list;
    try { list = JSON.parse(snap.blob[key] || '[]'); } catch (_) { list = []; }
    if (!Array.isArray(list)) list = [];
    const before = list.length;
    list = action.text
      ? list.filter((g) => !(g.text && g.text.toLowerCase().includes(String(action.text).toLowerCase())))
      : [];
    snap.blob[key] = JSON.stringify(list);
    snap.ts = Date.now();
    await sbUpsert('patron-device-snapshot', snap);
    return before - list.length > 0 || (!action.text && before > 0) ? '✅ Todo(s) gelöscht.' : 'ℹ️ Keine passenden Todos gefunden.';
  }

  if (action.type === 'reset_all') {
    const snap = (await sbGet('patron-device-snapshot')) || { blob: {}, ts: 0 };
    snap.blob = snap.blob || {};
    let water; try { water = JSON.parse(snap.blob.water_standalone_v1 || '{}'); } catch (_) { water = {}; }
    water.logs = {};
    snap.blob.water_standalone_v1 = JSON.stringify(water);

    let progress; try { progress = JSON.parse(snap.blob['patron_db_patron-progress'] || '{}'); } catch (_) { progress = {}; }
    progress.entries = [];
    snap.blob['patron_db_patron-progress'] = JSON.stringify(progress);
    snap.blob.progress_standalone_v1 = JSON.stringify(progress);

    let health; try { health = JSON.parse(snap.blob.patron_health_v1 || '{}'); } catch (_) { health = {}; }
    delete health.sleepHours; delete health.sleepPerf;
    snap.blob.patron_health_v1 = JSON.stringify(health);

    let macros; try { macros = JSON.parse(snap.blob.macros_standalone_v1 || '{}'); } catch (_) { macros = {}; }
    const goalCal = macros.goalCal;
    macros = goalCal != null ? { goalCal } : {};
    snap.blob.macros_standalone_v1 = JSON.stringify(macros);

    const todoKey = 'goals:' + todayKey();
    snap.blob[todoKey] = JSON.stringify([]);

    snap.ts = Date.now();
    await sbUpsert('patron-device-snapshot', snap);

    const state = (await sbGet('po-coach')) || {};
    if (state.po_coach_v1) { state.po_coach_v1.logs = {}; }
    state.po_coach_weights = [];
    await sbUpsert('po-coach', state);

    await sbUpsert('telegram-notes', { items: [] });

    return '🧹 Alles zurückgesetzt: Wasser, Gewicht, Schlaf, Essen, Trainings-Logs, heutige Todos und Notizen sind auf null.';
  }

  // Fallback: a running notes log so nothing typed ever gets lost, even if
  // it didn't match a known page yet.
  const notes = (await sbGet('telegram-notes')) || { items: [] };
  notes.items = notes.items || [];
  notes.items.unshift({ text: action.text || '', at: new Date().toISOString() });
  notes.items = notes.items.slice(0, 200);
  await sbUpsert('telegram-notes', notes);
  return `📝 Notiert: "${action.text || ''}"`;
}
