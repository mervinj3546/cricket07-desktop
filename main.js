// Cricket 07 for Mac (and Windows): a desktop wrapper for Dhaiwat's browser port of EA Sports Cricket 07
// (https://cricket07.dhaiwat.com, source: https://github.com/Dhaiwat10/cricket07-browser).
//
// This app contains no game code or game files. On first launch it loads the port's page and engine
// from the site, the same way a browser does, and keeps a copy of everything (the page files here, the
// game files in the page's own storage). After that it plays offline.
const { app, BrowserWindow, protocol, net, shell, Menu, powerSaveBlocker, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const saves = require('./saves');
const { takeScreenshot, showScreenshots } = require('./screenshot');
const { names } = require('./names');

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
const DEFAULTS = { realNames: true, fxaa: true, aniso: true, mips: true, sharpen: true, vivid: false, wide: true };
const settings = () => { try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS(), 'utf8')) }; } catch { return { ...DEFAULTS }; } };
const saveSettings = (s) => fs.writeFileSync(SETTINGS(), JSON.stringify(s, null, 2));
const gfxQuery = (s) => [s.fxaa ? '' : 'fxaa=0', s.aniso ? '' : 'aniso=0', s.mips ? '' : 'mips=0',
  s.sharpen ? '' : 'sharpen=0', s.vivid ? 'vivid=1' : '', s.wide ? 'wide=1' : ''].filter(Boolean).join('&');
// settings that switch while the game runs (the others apply when the game starts)
const LIVE = {
  fxaa: (v) => `window.c07Enhance.fxaa = ${v}`,
  sharpen: (v) => `window.c07Enhance.sharpen = ${v ? 0.5 : 0}`,
  vivid: (v) => `window.c07Enhance.vivid = ${v}`,
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
    // graphics enhancements (enhance.js, part of this app) load before the port's scripts
    text = text.replace('<script src="netplay.js"></script>', '<script src="enhance.js"></script>\n<script src="netplay.js"></script>');
    // the app's layout is part of the page, so the very first frame is already right (black, no website layout)
    text = text.replace('</head>', `<style id="desktop-app">${PAGE_CSS}</style>\n</head>`);
  } else if (rel === 'c07.js') {
    // keep the 4:3 picture and let the window stretch it over the screen (no black bars), unless widescreen
    // (enhance.js) is on, which draws the scene at the window's own shape
    text = text.replace(
      /canvas\.width = Math\.max\(640, Math\.round\(r\.width \* dpr\)\);\s*canvas\.height = Math\.max\(480, Math\.round\(r\.height \* dpr\)\);/,
      'canvas.height = Math.max(480, Math.round(r.height * dpr));\n  canvas.width = window.c07Enhance?.wide ? Math.max(640, Math.round(r.width * dpr)) : Math.max(640, Math.round(canvas.height * 4 / 3));');
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
  if (!win.webContents.isCrashed()) {
    // a running game keeps the page too busy to navigate away, so end its process first
    if (win.webContents.getURL()) win.webContents.forcefullyCrashRenderer();
  }
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

async function applyNamesSetting() {
  try {
    const want = settings().realNames ? 'real' : 'original';
    if ((await names(win, 'status')) !== want) {
      await win.webContents.executeJavaScript(`document.getElementById('status') && (document.getElementById('status').textContent = 'Updating player names…'); 0`);
      await names(win, want);
    }
  } catch (err) { console.error('player names:', err); }
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
    if (/^\[kernel32\] (ExitProcess|TerminateProcess)\(/.test(e.message || '')) setTimeout(() => app.exit(0), 300);
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
}

// ---------------------------------------------------------------- settings window (⌘, / Ctrl+,)
// A sheet over the game window, so it works in full screen where the menu bar is hidden.
let settingsWin = null;
function openSettings() {
  if (settingsWin) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    parent: win, modal: true, show: false, width: 560, height: 880, resizable: false,
    backgroundColor: '#0b130d', title: 'Settings', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'settings-preload.js') },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; win?.focus(); });
}

ipcMain.handle('settings:get', () => ({ values: settings(), applied, platform: process.platform }));
ipcMain.handle('settings:set', (_e, key, value) => {
  if (!(key in DEFAULTS)) return;
  saveSettings({ ...settings(), [key]: !!value });
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
      { label: 'This App on GitHub', click: () => shell.openExternal('https://github.com/udeshvirk/cricket07-mac') },
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
