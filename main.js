// Cricket 07 for Mac (and Windows): a desktop wrapper for Dhaiwat's browser port of EA Sports Cricket 07
// (https://cricket07.dhaiwat.com, source: https://github.com/Dhaiwat10/cricket07-browser).
//
// This app contains no game code or game files. On first launch it loads the port's page and engine
// from the site, the same way a browser does, and keeps a copy of everything (the page files here, the
// game files in the page's own storage). After that it plays offline.
const { app, BrowserWindow, protocol, net, shell, Menu, powerSaveBlocker, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const saves = require('./saves');
const { takeScreenshot, showScreenshots } = require('./screenshot');
const { names } = require('./names');
const updates = require('./updates');

const REMOTE = 'https://cricket07.dhaiwat.com/';
const SCHEME = 'c07';
const START_URL = `${SCHEME}://app/index.html`;

// The files the port's page needs. Only these are fetched and kept.
const ENGINE_FILES = new Set(['index.html', 'c07.js', 'netplay.js', 'audio-worklet.js', 'cricket07-logo.png',
  'favicon.ico', 'build/cricket07.js', 'build/cricket07.wasm']);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json' };

app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

// The engine uses threads, which need cross-origin isolation.
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const userFile = (...p) => path.join(app.getPath('userData'), ...p);
const ENGINE_DIR = () => userFile('engine');

// ---------------------------------------------------------------- settings

const SETTINGS = () => userFile('settings.json');
const DEFAULTS = { realNames: true, fxaa: true, aniso: true, mips: true, sharpen: true, vivid: false, wide: true, msaa: true, upscale: true, auto: true, fps: false, skipIntro: true, autoUpdate: true };
const settings = () => { try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS(), 'utf8')) }; } catch { return { ...DEFAULTS }; } };
const saveSettings = (s) => fs.writeFileSync(SETTINGS(), JSON.stringify(s, null, 2));
const gfxQuery = (s) => [s.fxaa ? '' : 'fxaa=0', s.aniso ? '' : 'aniso=0', s.mips ? '' : 'mips=0',
  s.sharpen ? '' : 'sharpen=0', s.vivid ? 'vivid=1' : '', s.wide ? 'wide=1' : '', s.msaa ? 'msaa=1' : '', s.upscale ? 'upscale=1' : '',
  s.auto ? (s.autoLevel ? `level=${s.autoLevel}` : '') : 'auto=0', s.fps ? 'fps=1' : ''].filter(Boolean).join('&');
// settings that switch while the game runs (the others apply when the game starts)
const LIVE = {
  fxaa: (v) => `window.c07Enhance.fxaa = ${v}`,
  sharpen: (v) => `window.c07Enhance.sharpen = ${v ? 0.5 : 0}`,
  vivid: (v) => `window.c07Enhance.vivid = ${v}`,
  auto: (v) => `window.c07Enhance.setAuto?.(${v})`,
  fps: (v) => `window.c07Enhance.fps = ${v}`,
};
const MAC = process.platform === 'darwin';

// ---------------------------------------------------------------- serving the page

// The game fills the window and starts by itself: from the first frame there is only a black screen, plus a
// short status line (and progress bar) while the game files download on the first launch.
const PAGE_CSS = `
  html, body { background: #000 !important; }
  main { padding: 0 !important; gap: 0 !important; }
  #stage { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
    aspect-ratio: auto !important; border-radius: 0 !important; box-shadow: none !important; }
  #panel { background: #000 !important; }
  #view-loading .brand, #view-home, #view-online, #view-lobby, .credit, #kbd-show, #fs, #fstip, #kbd { display: none !important; }
  body.kbd-on #kbd { display: block !important; z-index: 5; }
  #view-loading { animation: none !important; }
  #status { color: #9fb3a5 !important; font-size: 14px; }
  canvas, canvas:focus { outline: none !important; }
`;

// Small changes to the port's page for a desktop window. Each is skipped if the page has changed.
function adapt(rel, buf) {
  let text = buf.toString('utf8');
  if (rel === 'index.html') {
    // no web analytics in the app
    text = text.replace(/<!-- Cloudflare Web Analytics[\s\S]*?<\/script>\n?/, '');
    text = text.replace(/<script[^>]*static\.cloudflareinsights\.com[^>]*><\/script>\s*/g, '');   // the host's injected tag
    // graphics enhancements (enhance.js, part of this app) load before the port's scripts
    text = text.replace('<script src="netplay.js"></script>', '<script src="enhance.js"></script>\n<script src="netplay.js"></script>');
    // the app's layout is part of the page, so the very first frame is already right (black, no website layout)
    text = text.replace('</head>', `<style id="desktop-app">${PAGE_CSS}</style>\n</head>`);
  } else if (rel === 'c07.js') {
    // keep the 4:3 picture and let the window stretch it over the screen (no black bars), unless widescreen
    // (enhance.js) is on, which draws the scene at the window's own shape
    text = text.replace(
      /canvas\.width = Math\.max\(640, Math\.round\(r\.width \* dpr\)\);\s*canvas\.height = Math\.max\(480, Math\.round\(r\.height \* dpr\)\);/,
      'const sc = window.c07Enhance?.scale || 1;\n  canvas.height = Math.max(480, Math.round(r.height * dpr * sc));\n  canvas.width = window.c07Enhance?.wide ? Math.max(640, Math.round(r.width * dpr * sc)) : Math.max(640, Math.round(canvas.height * 4 / 3));');
  } else return buf;
  return Buffer.from(text);
}

async function engineFile(rel) {
  const file = path.join(ENGINE_DIR(), ...rel.split('/'));
  if (!fs.existsSync(file)) {
    const res = await net.fetch(REMOTE + rel, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.part', body);
    fs.renameSync(file + '.part', file);
  }
  return fs.readFileSync(file);
}

const FIRST_RUN_OFFLINE = `<!doctype html><meta charset="utf-8"><title>Cricket 07</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#070b08;color:#eef4ef;font:16px -apple-system,sans-serif;text-align:center">
<div><h2>Internet needed for the first launch</h2><p style="color:#9fb3a5;max-width:40ch">The first launch downloads the game (about 1.2 GB).
After that it works offline.<br>Connect to the internet, then choose Game → Restart Game (${process.platform === 'darwin' ? '⌘R' : 'Ctrl+R'}).</p></div></body>`;

const manifestCache = () => userFile('manifest.json');
const engineInfo = () => ({ remote: REMOTE, dir: ENGINE_DIR(), manifest: manifestCache() });

async function handle(request) {
  const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '') || 'index.html';
  const json = { 'Content-Type': 'application/json', ...ISOLATION };
  if (rel === 'game/manifest.json') {
    // kept after the first fetch, so the game files always match the engine that was kept with them
    if (fs.existsSync(manifestCache())) return new Response(fs.readFileSync(manifestCache()), { headers: json });
    const res = await net.fetch(REMOTE + rel, { cache: 'no-store' });
    if (!res.ok) return new Response('', { status: res.status, headers: ISOLATION });
    const body = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(manifestCache(), body);
    return new Response(body, { headers: json });
  }
  if (rel.startsWith('game/')) {
    // game files: the page streams these into its storage once, resuming with Range requests
    const headers = {};
    const range = request.headers.get('Range');
    if (range) headers.Range = range;
    const res = await net.fetch(REMOTE + rel.split('/').map(encodeURIComponent).join('/'), { headers, cache: 'no-store' });
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(ISOLATION)) h.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }
  if (rel === 'blank.html') {
    // an empty page on the game's origin, for storage work while the game isn't running
    return new Response('<!doctype html><body style="background:#000">', { headers: { 'Content-Type': 'text/html', ...ISOLATION } });
  }
  if (rel === 'enhance.js') {
    return new Response(fs.readFileSync(path.join(__dirname, 'enhance.js')), { headers: { 'Content-Type': 'text/javascript', ...ISOLATION } });
  }
  if (!ENGINE_FILES.has(rel)) return new Response('Not found', { status: 404, headers: ISOLATION });
  try {
    const body = adapt(rel, await engineFile(rel));
    return new Response(body, { headers: { 'Content-Type': TYPES[path.extname(rel)] || 'application/octet-stream', ...ISOLATION } });
  } catch (err) {
    if (rel === 'index.html') return new Response(FIRST_RUN_OFFLINE, { headers: { 'Content-Type': 'text/html', ...ISOLATION } });
    return new Response(String(err), { status: 503, headers: ISOLATION });
  }
}

// ---------------------------------------------------------------- window

let win = null;
let applied = {};   // the settings the running game started with

// Loads the page and waits until the game files are in place (the first launch downloads them),
// then runs any pending tasks and starts solo play, skipping the Solo / Multiplayer screen.
async function startGame(beforePlay) {
  gameStopped = false;
  // a running game keeps the page too busy to navigate away, so end its process first
  if (win.webContents.getURL()) endPage();
  applied = settings();
  await win.loadURL(START_URL + '?' + gfxQuery(applied)).catch(() => {});
  for (;;) {
    const state = await win.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('view-home');
      if (!el) return 'none';
      if (el.classList.contains('hidden')) return 'wait';
      // game files are ready: show a short message instead of the (hidden) Solo / Multiplayer screen
      document.getElementById('view-loading').classList.remove('hidden');
      document.getElementById('status').textContent = 'Starting the game…';
      return 'home';
    })()`).catch(() => 'none');
    if (state === 'home') break;
    if (state === 'none') return;   // the offline notice, or an error page
    await new Promise((r) => setTimeout(r, 150));
  }
  await saves.autoBackup(win);
  await applyNamesSetting();
  await applyIntroSetting();
  if (beforePlay) await beforePlay();
  await win.webContents.executeJavaScript(`document.getElementById('play').click()`);
  win.webContents.executeJavaScript(HINT_JS).catch(() => {});
}

// A short hint once the game starts, since the menu bar is hidden in full screen
const HINT_JS = `(() => {
  const d = document.createElement('div');
  d.textContent = 'Press ${MAC ? '\u2318,' : 'Ctrl+,'} for settings';
  d.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9;padding:8px 18px;border-radius:99px;' +
    'background:rgba(0,0,0,.7);color:#fff;font:14px -apple-system,system-ui,sans-serif;pointer-events:none;opacity:0;transition:opacity .6s';
  document.body.appendChild(d);
  setTimeout(() => { d.style.opacity = '1'; }, 11000);   // after the intro logos
  setTimeout(() => { d.style.opacity = '0'; }, 18000);
  setTimeout(() => d.remove(), 19000);
})()`;

// Skip intro: the EA Sports logo movie is the one startup video the game needs; with the file renamed the game
// simply goes on to the next screen. Renamed back when the setting is off.
async function applyIntroSetting() {
  const [from, to] = settings().skipIntro ? ['eaep.vp6', 'eaep.vp6.skip'] : ['eaep.vp6.skip', 'eaep.vp6'];
  await win.webContents.executeJavaScript(`(async () => {
    try {
      const d = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('c07game')).getDirectoryHandle('Data');
      const h = await d.getFileHandle('${from}').catch(() => null);
      if (!h) return;
      await d.removeEntry('${to}').catch(() => {});   // a stale copy (the launcher may have fetched it again)
      await h.move('${to}');
    } catch (err) { console.warn('skip intro:', err); }
  })()`).catch(() => {});
}

async function applyNamesSetting() {
  try {
    const want = settings().realNames ? 'real' : 'original';
    if ((await names(win, 'status')) !== want) {
      await win.webContents.executeJavaScript(`document.getElementById('status') && (document.getElementById('status').textContent = 'Updating player names…'); 0`);
      await names(win, want);
    }
  } catch (err) { console.error('player names:', err); }
}

// Ends the page's process on purpose (to restart the game or work on its storage).
let endedAt = 0;
function endPage() {
  if (win.webContents.isCrashed()) return;
  endedAt = Date.now();
  win.webContents.forcefullyCrashRenderer();
}

// The engine can stop by itself: on slow machines its sound system can get stuck in a loop and crash, often
// right after Quit in the game's menu. Instead of a frozen picture, say so and offer Quit / Start again.
let gameStopped = false;
const STOPPED_HTML = `<div style="position:absolute;inset:0;margin:auto;width:max-content;height:max-content;text-align:center;
  padding:28px 36px;border-radius:14px;background:rgba(10,18,12,.94);color:#eef4ef;font:16px -apple-system,system-ui,sans-serif">
  <div style="font-size:20px;font-weight:600;margin-bottom:8px">The game has stopped</div>
  <div style="color:#9fb3a5;margin-bottom:20px">If you chose Quit in the game, choose Quit here too.</div>
  <button data-c07="quit" style="font:inherit;padding:8px 22px;margin:0 6px;border-radius:8px;border:0;background:#2c6b3c;color:#fff;cursor:pointer">Quit (Esc)</button>
  <button data-c07="restart" style="font:inherit;padding:8px 22px;margin:0 6px;border-radius:8px;border:0;background:#3a463d;color:#fff;cursor:pointer">Start again (Enter)</button>
</div>`;
// the buttons report through the page title (the page has no other way to reach the app)
const STOPPED_JS = `(() => {
  document.getElementById('c07-stopped')?.remove();
  const d = document.createElement('div');
  d.id = 'c07-stopped';
  d.style.cssText = 'position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.55)';
  d.innerHTML = ${JSON.stringify(STOPPED_HTML)};
  d.addEventListener('click', (e) => { const a = e.target.dataset?.c07; if (a) document.title = 'c07:' + a + ':' + Date.now(); });
  document.body.appendChild(d);
  document.exitPointerLock?.();
})()`;
function showStopped(why) {
  if (gameStopped) return;
  gameStopped = true;
  console.error('game stopped:', why);
  win.webContents.executeJavaScript(STOPPED_JS).catch(() => {});
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 800, minHeight: 600, fullscreen: true,
    backgroundColor: '#000000', title: 'Cricket 07',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  // Quit in the game's own menu stops the game but leaves its last frame on screen; close the app instead.
  win.webContents.on('console-message', (e) => {
    const m = e.message || '';
    if (/^\[kernel32\] (ExitProcess|TerminateProcess)\(/.test(m)) setTimeout(() => app.exit(0), 300);
    else if (/^(Aborted\(|worker sent an error!|guest heap exhausted)/.test(m)) showStopped(m);
    else if (m.startsWith('[enhance] speed level ')) {
      const level = +m.slice(22) || 0, s = settings();
      if (s.auto && (s.autoLevel || 0) !== level) saveSettings({ ...s, autoLevel: level });
    }
  });
  win.webContents.on('page-title-updated', (e, title) => {
    const a = /^c07:(quit|restart):/.exec(title)?.[1];
    if (!a || !gameStopped) return;
    e.preventDefault();
    if (a === 'quit') app.exit(0); else startGame();
  });
  // the page's process ended without being asked to (out of memory, a crash): same message, on a plain page
  win.webContents.on('render-process-gone', (_e, d) => {
    if (Date.now() - endedAt < 5000 || d.reason === 'clean-exit') return;
    gameStopped = false;
    win.loadURL(`${SCHEME}://app/blank.html`).then(() => showStopped('page process ' + d.reason)).catch(() => {});
  });

  // In front: keep the display awake (controller play doesn't count as activity). Switched away: mute.
  let blocker = null;
  const setActive = (on) => {
    win.webContents.setAudioMuted(!on);
    if (on && blocker === null) blocker = powerSaveBlocker.start('prevent-display-sleep');
    if (!on && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
  };
  win.on('focus', () => setActive(true));
  win.on('blur', () => setActive(false));
  win.once('ready-to-show', () => setActive(win.isFocused()));
  win.on('close', () => app.exit(0));

  // The game takes every key it knows (and cancels it), so menu shortcuts never fire while it has focus.
  // Catch them here first, before the game sees them.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt) return;
    if (gameStopped && !input.meta && !input.control) {
      if (input.key === 'Escape') { event.preventDefault(); app.exit(0); return; }
      if (input.key === 'Enter') { event.preventDefault(); startGame(); return; }
    }
    if (!MAC && input.key === 'F11') { event.preventDefault(); win.setFullScreen(!win.isFullScreen()); return; }
    if (!(MAC ? input.meta : input.control)) return;
    const k = input.key.toLowerCase();
    const run = {
      ',': () => openSettings(),
      's': input.shift ? () => takeScreenshot(win) : null,
      'k': () => win.webContents.executeJavaScript(`document.body.classList.toggle('kbd-on')`),
      'r': () => startGame(),
      'f': MAC && input.control ? () => win.setFullScreen(!win.isFullScreen()) : null,
      'q': () => app.exit(0),
      'h': MAC ? () => app.hide() : null,
      'm': () => win.minimize(),
    }[k];
    if (run) { event.preventDefault(); run(); }
  });

  startGame();
  autoCheckUpdates();   // once per launch, whether or not the game starts (a newer engine may be the fix)
}

// ---------------------------------------------------------------- settings window (⌘, / Ctrl+,)
// A sheet over the game window, so it works in full screen where the menu bar is hidden.
let settingsWin = null;
function openSettings() {
  if (settingsWin) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    parent: win, modal: true, show: false, width: 560, height: Math.min(1180, screen.getDisplayMatching(win.getBounds()).workAreaSize.height - 60), resizable: false,
    backgroundColor: '#0b130d', title: 'Settings', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'settings-preload.js') },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; win?.focus(); });
}

// ---------------------------------------------------------------- updates
// Once a day, a while after the game starts, check for a new app release and a newer game engine. A short
// notice appears in the game the first time an update is found; the details are in Settings.
let autoCheckTimer = null;
function autoCheckUpdates() {
  clearTimeout(autoCheckTimer);
  autoCheckTimer = setTimeout(async () => {
    if (!settings().autoUpdate) return;
    if (updates.due()) await updates.check(engineInfo()).catch(() => {});
    const notes = updates.unannounced();
    if (!notes.length || !win) return;
    const st = updates.readState();
    const text = notes.includes('app') ? `Version ${st.app.version} of the app is available`
      : 'A newer game engine is available';
    win.webContents.executeJavaScript(TOAST_JS(`${text} · ${MAC ? '\u2318,' : 'Ctrl+,'} for details`)).catch(() => {});
    updates.markAnnounced();
  }, 30000);
}
const TOAST_JS = (text) => `(() => {
  const d = document.createElement('div');
  d.textContent = ${JSON.stringify(text)};
  d.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9;padding:9px 20px;border-radius:99px;' +
    'background:rgba(20,60,32,.92);color:#fff;font:14px -apple-system,system-ui,sans-serif;pointer-events:none;opacity:0;transition:opacity .6s';
  document.body.appendChild(d);
  setTimeout(() => { d.style.opacity = '1'; }, 50);
  setTimeout(() => { d.style.opacity = '0'; }, 9000);
  setTimeout(() => d.remove(), 10000);
})()`;

let engineBusy = false, engineError = null;
const updateInfo = () => ({ appVersion: app.getVersion(), ...updates.readState(), engineBusy, engineError });

ipcMain.handle('settings:get', () => ({ values: settings(), applied, platform: process.platform, updates: updateInfo() }));
ipcMain.handle('settings:set', (_e, key, value) => {
  if (!(key in DEFAULTS)) return;
  saveSettings({ ...settings(), [key]: !!value, ...(key === 'auto' ? { autoLevel: 0 } : {}) });
  if (LIVE[key]) win?.webContents.executeJavaScript(`window.c07Enhance && (${LIVE[key](!!value)})`).catch(() => {});
});
ipcMain.handle('settings:action', async (_e, name) => {
  const close = () => settingsWin?.close();
  switch (name) {
    case 'close': return close();
    case 'restart': close(); return startGame();
    case 'screenshot': close(); await new Promise((r) => setTimeout(r, 400)); return takeScreenshot(win);
    case 'screenshots': return showScreenshots();
    case 'backup': return saves.backupNow(settingsWin || win);
    case 'restore': close(); return saves.restore(win, startGame);
    case 'backups': return saves.showBackups();
    case 'update-check': await updates.check(engineInfo()).catch(() => {}); return updateInfo();
    case 'update-download': { const u = updates.readState().app?.url; if (u) shell.openExternal(u); return; }
    case 'update-engine': {
      if (engineBusy) return updateInfo();
      engineBusy = true; engineError = null;
      const say = (t) => settingsWin?.webContents.send('update-progress', t);
      try {
        await updates.updateEngine(engineInfo(), [...ENGINE_FILES], say);
        say('Done. Restarting the game…');
        await new Promise((r) => setTimeout(r, 800));
        close();
        // With the game stopped, put the game data back to the exact original (real names are re-applied as
        // the game starts). Otherwise its changed size makes the new launcher download it all again.
        endPage();
        await win.loadURL(`${SCHEME}://app/blank.html`).catch(() => {});
        await names(win, 'original').catch(() => {});
        startGame();
      } catch (err) {
        engineError = `The engine couldn't be updated: ${err.message}`;
        say(engineError);
      } finally { engineBusy = false; }
      return updateInfo();
    }
  }
});

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    MAC ? { label: app.name, submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => openSettings() },
      { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ] } : { label: 'File', submenu: [
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => openSettings() },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { label: 'Game', submenu: [
      { label: 'Restart Game', accelerator: 'CmdOrCtrl+R', click: () => startGame() },
      { type: 'separator' },
      { label: 'Take Screenshot', accelerator: 'CmdOrCtrl+Shift+S', click: () => takeScreenshot(win) },
      { label: MAC ? 'Show Screenshots in Finder' : 'Show Screenshots Folder', click: () => showScreenshots() },
    ] },
    { label: 'Saves', submenu: [
      { label: 'Back Up Saves Now', click: () => win && saves.backupNow(win) },
      { label: 'Restore Saves…', click: () => win && saves.restore(win, startGame) },
      { type: 'separator' },
      { label: MAC ? 'Show Backups in Finder' : 'Show Backups Folder', click: () => saves.showBackups() },
    ] },
    { label: 'View', submenu: [
      { role: 'togglefullscreen' },
      { label: 'Keyboard Controls', accelerator: 'CmdOrCtrl+K', click: () =>
        win?.webContents.executeJavaScript(`document.body.classList.toggle('kbd-on')`) },
      { type: 'separator' }, { role: 'toggleDevTools' },
    ] },
    ...(MAC ? [{ role: 'windowMenu' }] : []),
    { role: 'help', submenu: [
      { label: 'About the Browser Port', click: () => shell.openExternal('https://github.com/Dhaiwat10/cricket07-browser') },
      { label: 'This App on GitHub', click: () => shell.openExternal('https://github.com/udeshvirk/cricket07-desktop') },
    ] },
  ]));
}

// Only one copy may run: two copies sharing the game's storage make the browser engine treat it as damaged
// and wipe it (game files and saves). A second launch just brings the running game to the front.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

app.whenReady().then(() => {
  protocol.handle(SCHEME, (request) => handle(request).catch((err) => new Response(String(err), { status: 503, headers: ISOLATION })));
  buildMenu();
  createWindow();
});

// The game keeps worker threads busy, which can stall a normal quit; end the app right away instead.
app.on('window-all-closed', () => app.exit(0));
app.on('before-quit', () => app.exit(0));
// quit requests from scripts and system tools (Electron ignores these signals otherwise)
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => app.exit(0));
