// Cricket 07 for Mac (and Windows): a desktop wrapper for Dhaiwat's browser port of EA Sports Cricket 07
// (https://cricket07.dhaiwat.com, source: https://github.com/Dhaiwat10/cricket07-browser).
//
// This app contains no game code or game files. On first launch it loads the port's page and engine
// from the site, the same way a browser does, and keeps a copy of everything (the page files here, the
// game files in the page's own storage). After that it plays offline.
const { app, BrowserWindow, protocol, net, shell, Menu, powerSaveBlocker, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const saves = require('./saves');
const { takeScreenshot, showScreenshots } = require('./screenshot');
const { names, COUNT } = require('./names');

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
const settings = () => { try { return { realNames: true, ...JSON.parse(fs.readFileSync(SETTINGS(), 'utf8')) }; } catch { return { realNames: true }; } };
const saveSettings = (s) => fs.writeFileSync(SETTINGS(), JSON.stringify(s, null, 2));

// ---------------------------------------------------------------- serving the page

// Small changes to the port's page for a desktop window. Each is skipped if the page has changed.
function adapt(rel, buf) {
  let text = buf.toString('utf8');
  if (rel === 'index.html') {
    // no web analytics in the app
    text = text.replace(/<!-- Cloudflare Web Analytics[\s\S]*?<\/script>\n?/, '');
  } else if (rel === 'c07.js') {
    // keep the 4:3 picture and let the window stretch it to fill the screen (no black bars)
    text = text.replace(
      /canvas\.width = Math\.max\(640, Math\.round\(r\.width \* dpr\)\);\s*canvas\.height = Math\.max\(480, Math\.round\(r\.height \* dpr\)\);/,
      'canvas.height = Math.max(480, Math.round(r.height * dpr));\n  canvas.width = Math.max(640, Math.round(canvas.height * 4 / 3));');
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

// The game fills the window: no rounded stage, credit line or side panel (the keyboard panel is in View).
const APP_CSS = `
  main { padding: 0 !important; gap: 0 !important; }
  #stage { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
    aspect-ratio: auto !important; border-radius: 0 !important; box-shadow: none !important; }
  .credit, #kbd-show, #fs, #fstip { display: none !important; }
  canvas, canvas:focus { outline: none !important; }
  #kbd { display: none !important; }
  body.kbd-on #kbd { display: block !important; z-index: 5; }
  /* the app starts solo play itself, so the Solo / Multiplayer screens are never shown */
  #view-home, #view-online, #view-lobby { display: none !important; }
`;

let win = null;

// Loads the page and waits until the game files are in place (the first launch downloads them),
// then runs any pending tasks and starts solo play, skipping the Solo / Multiplayer screen.
async function startGame(beforePlay) {
  if (!win.webContents.isCrashed()) {
    // a running game keeps the page too busy to navigate away, so end its process first
    if (win.webContents.getURL()) win.webContents.forcefullyCrashRenderer();
  }
  await win.loadURL(START_URL).catch(() => {});
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

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 800, minHeight: 600, fullscreen: true,
    backgroundColor: '#000000', title: 'Cricket 07',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.webContents.on('dom-ready', () => win.webContents.insertCSS(APP_CSS));
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

  startGame();
}

async function toggleRealNames(item) {
  const s = settings();
  s.realNames = item.checked;
  saveSettings(s);
  await dialog.showMessageBox(win, {
    message: item.checked ? 'Real player names on' : 'Original game names on',
    detail: 'The game restarts to apply this. Save your profile first if you changed any settings (My Cricket → Load / Save).',
  });
  startGame();
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    process.platform === 'darwin' ? { role: 'appMenu' } : { label: 'File', submenu: [{ role: 'quit' }] },
    { label: 'Game', submenu: [
      { label: 'Real Player Names', type: 'checkbox', checked: settings().realNames, click: toggleRealNames,
        toolTip: `Shows real names for ${COUNT} players the game gave made-up names` },
      { type: 'separator' },
      { label: 'Restart Game', accelerator: 'CmdOrCtrl+R', click: () => startGame() },
      { type: 'separator' },
      { label: 'Take Screenshot', accelerator: 'CmdOrCtrl+Shift+S', click: () => takeScreenshot(win) },
      { label: process.platform === 'darwin' ? 'Show Screenshots in Finder' : 'Show Screenshots Folder', click: () => showScreenshots() },
    ] },
    { label: 'Saves', submenu: [
      { label: 'Back Up Saves Now', click: () => win && saves.backupNow(win) },
      { label: 'Restore Saves…', click: () => win && saves.restore(win, startGame) },
      { type: 'separator' },
      { label: 'Show Backups in Finder', click: () => saves.showBackups() },
    ] },
    { label: 'View', submenu: [
      { role: 'togglefullscreen' },
      { label: 'Keyboard Controls', accelerator: 'CmdOrCtrl+K', click: () =>
        win?.webContents.executeJavaScript(`document.body.classList.toggle('kbd-on')`) },
      { type: 'separator' }, { role: 'toggleDevTools' },
    ] },
    ...(process.platform === 'darwin' ? [{ role: 'windowMenu' }] : []),
    { role: 'help', submenu: [
      { label: 'About the Browser Port', click: () => shell.openExternal('https://github.com/Dhaiwat10/cricket07-browser') },
      { label: 'This App on GitHub', click: () => shell.openExternal('https://github.com/udeshvirk/cricket07-mac') },
    ] },
  ]));
}

app.whenReady().then(() => {
  protocol.handle(SCHEME, (request) => handle(request).catch((err) => new Response(String(err), { status: 503, headers: ISOLATION })));
  buildMenu();
  createWindow();
});

// The game keeps worker threads busy, which can stall a normal quit; end the app right away instead.
app.on('window-all-closed', () => app.exit(0));
app.on('before-quit', () => app.exit(0));
