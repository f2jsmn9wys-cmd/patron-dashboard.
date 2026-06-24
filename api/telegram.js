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

// Claude sorts the message into one of a few known shapes. Kept deliberately
// small (water / weight / note) — easy to extend with the same pattern later
// (food, finance, supplements, gym sets) once this is proven out.
async function classify(text) {
  if (!ANTHROPIC_KEY) return [{ type: 'note', text }];
  const sys = 'Du ordnest kurze deutsche oder englische Nachrichten einer Tracking-App in eine oder mehrere Kategorien ein. ' +
    'Eine einzelne Nachricht kann MEHRERE Fakten enthalten (z.B. Wasser UND Gewicht) — gib dann mehrere Objekte zurueck. ' +
    'Antworte NUR mit einem kompakten JSON-Array, ohne Erklaerung, ohne Markdown-Codeblock.\n' +
    'Moegliche Objekte im Array:\n' +
    '{"type":"water","glasses":<Anzahl 250ml-Glaeser; 1 Liter = 4>}\n' +
    '{"type":"weight","kg":<Zahl>}\n' +
    '{"type":"note","text":"<Originalnachricht oder der Teil davon, leicht aufgeraeumt>"}\n' +
    'Wenn ein Teil der Nachricht zu keiner bekannten Kategorie passt oder alles unklar ist, nimm "note" dafuer. ' +
    'Beispiel Eingabe "Habe heute 2L Wasser getrunken und mein Gewicht ist bei 99" -> ' +
    '[{"type":"water","glasses":8},{"type":"weight","kg":99}]';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
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

  // Weight is displayed on the Progress page, which reads its own
  // "progress_standalone_v1" key ({units, entries:[{dateKey, weightKg}]}) —
  // that key rides inside the same whole-device snapshot row as water.
  if (action.type === 'weight') {
    const kg = Number(action.kg);
    if (!kg) return '⚠️ Konnte das Gewicht nicht lesen — bitte z.B. "Gewicht 77.5kg" schreiben.';
    const snap = (await sbGet('patron-device-snapshot')) || { blob: {}, ts: 0 };
    snap.blob = snap.blob || {};
    let progress;
    try { progress = JSON.parse(snap.blob.progress_standalone_v1 || '{}'); } catch (_) { progress = {}; }
    progress.units = progress.units || 'kg';
    progress.entries = Array.isArray(progress.entries) ? progress.entries : [];
    const k = todayKey();
    const idx = progress.entries.findIndex((e) => e.dateKey === k);
    if (idx >= 0) progress.entries[idx].weightKg = kg; else progress.entries.push({ dateKey: k, weightKg: kg });
    snap.blob.progress_standalone_v1 = JSON.stringify(progress);
    snap.ts = Date.now();
    await sbUpsert('patron-device-snapshot', snap);
    return `⚖️ Gewicht heute auf ${kg}kg eingetragen.`;
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
