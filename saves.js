// Save backups: the game keeps its profile and settings in the app's private storage (OPFS folder
// "userdata"). These helpers copy that folder to and from ~/Documents/<app name> Saves as plain files.
// An automatic backup is taken at each launch (that holds what the last session saved); the newest 10 are kept.
const { app, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = () => path.join(app.getPath('documents'), `${app.getName()} Saves`);
const AUTO = () => path.join(ROOT(), 'Automatic');
const MANUAL = () => path.join(ROOT(), 'Manual');
const KEEP_AUTO = 10;

const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`; };

// [relative path, base64] for every file in the game's userdata folder
const READ_JS = `(async () => {
  const root = await navigator.storage.getDirectory();
  let ud; try { ud = await root.getDirectoryHandle('userdata'); } catch { return []; }
  const out = [];
  async function walk(d, p) {
    for await (const [n, h] of d.entries()) {
      if (h.kind === 'directory') { await walk(h, p + n + '/'); continue; }
      const b = new Uint8Array(await (await h.getFile()).arrayBuffer());
      let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      out.push([p + n, btoa(s)]);
    }
  }
  await walk(ud, '');
  return out;
})()`;

const writeJs = (files) => `(async (files) => {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('userdata', { recursive: true }); } catch {}
  const ud = await root.getDirectoryHandle('userdata', { create: true });
  for (const [p, b64] of files) {
    const parts = p.split('/'); let d = ud;
    for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x, { create: true });
    const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
    const bin = atob(b64); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    await w.write(u); await w.close();
  }
  return files.length;
})(${JSON.stringify(files)})`;

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else if (e.isFile() && e.name !== '.DS_Store') out.push([path.relative(base, full).split(path.sep).join('/'), full]);
  }
  return out;
}

function writeBackup(files, dest) {
  for (const [rel, b64] of files) {
    const file = path.join(dest, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  }
}

const sameAs = (files, dir) => {
  try {
    const old = listFiles(dir);
    if (old.length !== files.length) return false;
    const m = new Map(old);
    return files.every(([rel, b64]) => m.has(rel) && fs.readFileSync(m.get(rel)).equals(Buffer.from(b64, 'base64')));
  } catch { return false; }
};

// Called once the page has loaded, before the game starts. Skips if nothing changed since the last one.
async function autoBackup(win) {
  try {
    const files = await win.webContents.executeJavaScript(READ_JS);
    if (!files.length) return;
    fs.mkdirSync(AUTO(), { recursive: true });
    const old = fs.readdirSync(AUTO()).filter((n) => !n.startsWith('.')).sort();
    if (old.length && sameAs(files, path.join(AUTO(), old[old.length - 1]))) return;
    writeBackup(files, path.join(AUTO(), stamp()));
    old.push('new');
    for (const n of old.slice(0, Math.max(0, old.length - KEEP_AUTO))) fs.rmSync(path.join(AUTO(), n), { recursive: true, force: true });
  } catch (err) { console.error('auto backup failed', err); }
}

async function backupNow(win) {
  try {
    const files = await win.webContents.executeJavaScript(READ_JS);
    if (!files.length) {
      await dialog.showMessageBox(win, { message: 'There are no saves yet.', detail: 'Save your profile in the game first (My Cricket → Load / Save → Save).' });
      return;
    }
    const dest = path.join(MANUAL(), stamp());
    writeBackup(files, dest);
    const { response } = await dialog.showMessageBox(win, {
      message: 'Saves backed up.', detail: dest, buttons: ['OK', process.platform === 'darwin' ? 'Show in Finder' : 'Show Folder'], defaultId: 0,
    });
    if (response === 1) shell.showItemInFolder(dest);
  } catch (err) { dialog.showErrorBox('Backup failed', String(err)); }
}

// restartGame(task) restarts the game and runs task before it starts (see main.js)
async function restore(win, restartGame) {
  fs.mkdirSync(ROOT(), { recursive: true });
  const pick = await dialog.showOpenDialog(win, {
    title: 'Choose a backup to restore', defaultPath: ROOT(), properties: ['openDirectory'],
    message: 'Pick one dated backup folder (inside Automatic or Manual).',
  });
  if (pick.canceled || !pick.filePaths[0]) return;
  const dir = pick.filePaths[0];
  const files = listFiles(dir);
  if (!files.length || !files.some(([rel]) => rel.startsWith('Documents and Settings/'))) {
    dialog.showErrorBox('Not a save backup', 'That folder does not look like a Cricket 07 save backup. Pick a dated folder inside Automatic or Manual.');
    return;
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Cancel', 'Restore'], defaultId: 1, cancelId: 0,
    message: 'Replace your current saves with this backup?',
    detail: `${path.basename(dir)}\n\nThe game restarts. Your current saves are backed up first.`,
  });
  if (response !== 1) return;
  try {
    const current = await win.webContents.executeJavaScript(READ_JS);
    if (current.length) writeBackup(current, path.join(MANUAL(), stamp() + ' (before restore)'));
    const payload = files.map(([rel, full]) => [rel, fs.readFileSync(full).toString('base64')]);
    await restartGame(() => win.webContents.executeJavaScript(writeJs(payload)));
  } catch (err) { dialog.showErrorBox('Restore failed', String(err)); }
}

const showBackups = () => { fs.mkdirSync(ROOT(), { recursive: true }); shell.openPath(ROOT()); };

module.exports = { autoBackup, backupNow, restore, showBackups };
