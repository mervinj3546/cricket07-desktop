// End-to-end check of the app on a fresh machine (used by .github/workflows/windows-test.yml).
// Run with: npx electron test/smoke.js   (env OUT = folder for screenshots and the log, MODE = full|lite)
//
// It goes through what a new user does: first launch, choose the download, wait for the game, then menus,
// Settings (Ctrl/⌘+,), a screenshot (Ctrl/⌘+Shift+S), Shift reaching the game, and quitting. Every step is
// logged and photographed; the process exits non-zero if a step fails.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUT = path.resolve(process.env.OUT || 'smoke-out');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'log.txt');
const t0 = Date.now();
const log = (...a) => { const line = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${a.join(' ')}`; console.log(line); fs.appendFileSync(LOG, line + '\n'); };

// the app's own name and version (run this way, Electron would report its own)
const pkg = require('../package.json');
app.setName(pkg.productName);
app.getVersion = () => pkg.version;

// a fresh user folder, and software graphics when the machine has no GPU (CI machines)
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'c07-smoke-')));
if (process.env.SOFTWARE_GPU) {
  app.commandLine.appendSwitch('use-webgpu-adapter', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}
process.on('uncaughtException', (e) => log('MAIN EXCEPTION', e.stack));

// the app closes itself when the game quits (main.js); note it instead, so the test can finish
const realExit = app.exit.bind(app);
let appExitAt = 0;
app.exit = (code) => { if (!appExitAt) { appExitAt = Date.now(); log('app.exit called by the app, code', code); } };
require('../main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MOD = process.platform === 'darwin' ? 'meta' : 'control';
let failures = 0;
const fail = (msg) => { failures++; log('FAIL', msg); };
let shotN = 0;
async function shot(win, name) {
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${String(++shotN).padStart(2, '0')}-${name}.png`), img.resize({ width: 1280 }).toPNG());
  } catch (err) { log('screenshot failed', name, err.message); }
}
const js = (win, code) => win.webContents.executeJavaScript(code).catch((e) => `JS ERROR ${e.message}`);
const key = async (win, keyCode, modifiers = []) => {
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  await sleep(120);
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await sleep(700);
};
const state = (win) => js(win, `(() => {
  const p = document.getElementById('panel'); if (!p) return 'no page';
  if (p.classList.contains('hidden')) return 'GAME RUNNING';
  const m = document.getElementById('view-mode');
  return (m && !m.classList.contains('hidden') ? 'MODE CHOICE: ' : '') + (document.getElementById('status')?.textContent || '');
})()`);

let started = false;
app.on('browser-window-created', (_e, win) => {
  if (win.getParentWindow() || started) return;
  started = true;
  win.webContents.on('console-message', (e) => fs.appendFileSync(path.join(OUT, 'page-console.txt'), `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${e.message}\n`));
  win.webContents.on('render-process-gone', (_e, d) => log('RENDERER GONE', d.reason));
  (async () => {
    try {
      log('platform', process.platform, process.arch, 'electron', process.versions.electron, 'app', app.getVersion());
      // 1. first launch: wait for the download choice (or the game, if the files are already there)
      let last = '';
      const deadline = Date.now() + 25 * 60 * 1000;
      let chose = false, shotAt = 0;
      for (;;) {
        await sleep(1000);
        const st = await state(win);
        const short = st.replace(/\d+ \/ \d+ MB.*$/, 'n MB …');
        if (short !== last) { log('STATE', st.slice(0, 160)); last = short; }
        if (st.startsWith('MODE CHOICE') && !chose) {
          await shot(win, 'first-launch-choice');
          const which = process.env.MODE === 'lite' ? 'mode-lite' : 'mode-full';
          await js(win, `document.getElementById('${which}').click()`);
          chose = true;
          log('chose', which);
        }
        if (/Downloading/.test(st) && Date.now() - shotAt > 60000) { await shot(win, 'downloading'); shotAt = Date.now(); }
        if (st === 'GAME RUNNING') break;
        if (/Error|failed|no WebGPU|no usable/i.test(st)) { await shot(win, 'error'); fail('launcher: ' + st); break; }
        if (Date.now() > deadline) { await shot(win, 'timeout'); fail('game did not start in 25 minutes'); break; }
      }
      if (last === 'GAME RUNNING' || (await state(win)) === 'GAME RUNNING') {
        log('game started');
        const cfg = await js(win, 'JSON.stringify(window.c07Enhance)');
        log('enhancements', cfg);
        // 2. intro and title screens (software graphics are slow: give them time)
        for (let i = 1; i <= 6; i++) { await sleep(10000); await shot(win, `game-${i * 10}s`); }
        // 3. keys reach the game page (including Shift, the loft-shot key)
        await js(win, `window.__keys = []; window.addEventListener('keydown', (e) => window.__keys.push(e.code), true)`);
        await key(win, 'Shift'); await key(win, 'S'); await key(win, 'Up');
        const got = await js(win, 'JSON.stringify(window.__keys)');
        log('keys seen by the game page', got);
        if (!/Shift/.test(got)) fail('Shift did not reach the game page');
        if (!/KeyS/.test(got)) fail('S did not reach the game page');
        // 4. into the menus
        for (let i = 0; i < 3; i++) { await key(win, 'S'); await sleep(6000); await shot(win, `menu-${i + 1}`); }
        // 5. Settings window
        await key(win, ',', [MOD]);
        await sleep(3000);
        const sw = BrowserWindow.getAllWindows().find((w) => w.getParentWindow());
        if (!sw) fail('Settings window did not open with the keyboard shortcut');
        else {
          log('settings window opened');
          fs.writeFileSync(path.join(OUT, `${String(++shotN).padStart(2, '0')}-settings.png`), (await sw.webContents.capturePage()).toPNG());
          await sw.webContents.executeJavaScript(`document.querySelector('[data-action=close]').click()`).catch(() => {});
          await sleep(1500);
        }
        // 6. screenshot shortcut
        const pics = path.join(app.getPath('pictures'), `${app.getName()} Screenshots`);
        const before = fs.existsSync(pics) ? fs.readdirSync(pics).length : 0;
        await key(win, 'S', [MOD, 'shift']);
        await sleep(3000);
        const after = fs.existsSync(pics) ? fs.readdirSync(pics).length : 0;
        if (after > before) log('screenshot shortcut saved a file in', pics);
        else fail('screenshot shortcut saved nothing');
        // 7. save backups folder
        const backups = path.join(app.getPath('documents'), `${app.getName()} Saves`);
        log('save backups folder exists:', fs.existsSync(backups));
        // 8. Quit from the game's main menu (QUIT is the 7th item, then 'Yes'): the app should close itself.
        // If the engine already stopped during play (software graphics can starve its sound), the menu keys
        // below do nothing and the check falls through to the 'game has stopped' screen.
        if ((await js(win, `!!document.getElementById('c07-stopped')`)) === true)
          log('NOTE: the engine stopped during play, before the Quit step');
        for (let i = 0; i < 6; i++) await key(win, 'Down');
        await sleep(3000); await shot(win, 'quit-selected');
        await key(win, 'S'); await sleep(8000); await shot(win, 'quit-confirm');
        await key(win, 'Down'); await sleep(2000);
        const quitAt = Date.now();
        await key(win, 'S');
        // the app either closes, or (when the engine crashes on the way out) says the game has stopped
        const stoppedShown = () => js(win, `!!document.getElementById('c07-stopped')`);
        let stopped = false;
        while (!appExitAt && !(stopped = (await stoppedShown()) === true) && Date.now() - quitAt < 60000) await sleep(500);
        if (stopped) {
          log('"game has stopped" shown', ((Date.now() - quitAt) / 1000).toFixed(1), 's after Quit');
          await shot(win, 'quit-stopped');
          await key(win, 'Escape');
          for (let i = 0; i < 20 && !appExitAt; i++) await sleep(500);
          if (!appExitAt) fail('Esc on the "game has stopped" screen did not close the app');
        }
        if (appExitAt) log('app closed', ((appExitAt - quitAt) / 1000).toFixed(1), 's after Quit');
        else if (!stopped) { await shot(win, 'quit-stuck'); fail('the app did not respond to Quit in the game menu'); }
      }
    } catch (err) {
      fail('test crashed: ' + (err.stack || err));
    }
    const summary = failures ? `${failures} problem(s) found` : 'all checks passed';
    log('DONE:', summary);
    fs.writeFileSync(path.join(OUT, 'result.txt'), summary + '\n');
    realExit(failures ? 1 : 0);
  })();
});
