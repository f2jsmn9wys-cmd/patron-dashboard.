/* ============================================================
 * bottomnav.js — a fixed, horizontally-scrollable bottom tab bar
 * shared across every page in the suite. Drop-in:
 *   <script src="bottomnav.js"></script>
 * Mounts itself once the DOM is ready, highlights the current page,
 * and never touches the host page's own markup or state.
 * ============================================================ */
(function () {
  if (window.__patronBottomNav) return;
  window.__patronBottomNav = true;

  var NAV = [
    { file: 'index.html',    icon: '🏠', label: 'Home' },
    { file: 'peak.html',     icon: '🔆', label: 'Peak' },
    { file: 'finance.html',  icon: '💰', label: 'Finance' },
    { file: 'gym.html',      icon: '🏋️', label: 'Gym' },
    { file: 'food.html',     icon: '🥤', label: 'Food' },
    { file: 'fitband.html',  icon: '🔋', label: 'Band' },
    { file: 'mentor.html',   icon: '🌟', label: 'Mentor' },
    { file: 'creator.html',  icon: '🎬', label: 'Creator' },
    { file: 'goals.html',    icon: '🎯', label: 'Goals' },
    { file: 'progress.html', icon: '📈', label: 'Progress' },
  ];

  function currentFile() {
    var p = location.pathname.split('/').pop();
    return p === '' ? 'index.html' : p;
  }

  function injectStyle() {
    var style = document.createElement('style');
    style.textContent =
      'body{padding-bottom:64px !important}' +
      '.po-bottomnav{position:fixed;left:0;right:0;bottom:0;z-index:9000;display:flex;gap:4px;overflow-x:auto;' +
        'padding:8px max(10px,env(safe-area-inset-left)) calc(8px + env(safe-area-inset-bottom)) max(10px,env(safe-area-inset-right));' +
        'background:rgba(5,6,10,.85);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);' +
        'border-top:1px solid rgba(255,255,255,.08);scrollbar-width:none}' +
      '.po-bottomnav::-webkit-scrollbar{display:none}' +
      '.po-bottomnav a{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:2px;min-width:58px;' +
        'padding:6px 8px;border-radius:12px;text-decoration:none;color:rgba(255,255,255,.5);' +
        'font-family:ui-monospace,monospace;font-size:9.5px;letter-spacing:.04em;text-transform:uppercase}' +
      '.po-bottomnav a .po-bn-ico{font-size:18px;line-height:1}' +
      '.po-bottomnav a.po-bn-active{color:#6EE7B7;background:rgba(110,231,183,.10)}';
    document.head.appendChild(style);
  }

  function mount() {
    injectStyle();
    var cur = currentFile();
    var nav = document.createElement('nav');
    nav.className = 'po-bottomnav';
    nav.innerHTML = NAV.map(function (item) {
      var active = item.file === cur ? ' po-bn-active' : '';
      return '<a href="' + item.file + '" class="' + active.trim() + '">' +
        '<span class="po-bn-ico" aria-hidden="true">' + item.icon + '</span>' +
        '<span>' + item.label + '</span></a>';
    }).join('');
    document.body.appendChild(nav);
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
