// Screenshots of the game, saved as PNG files to Pictures/<app name> Screenshots.
// The game is drawn with WebGPU, which system screenshot tools can miss; capturing the page from inside
// the app always includes it.
const { app, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const DIR = () => path.join(app.getPath('pictures'), `${app.getName()} Screenshots`);

async function takeScreenshot(win) {
  if (!win) return;
  const image = await win.webContents.capturePage();
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const name = `Cricket 07 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}.png`;
  fs.mkdirSync(DIR(), { recursive: true });
  const file = path.join(DIR(), name);
  fs.writeFileSync(file, image.toPNG());
  if (Notification.isSupported()) {
    const n = new Notification({ title: 'Screenshot saved', body: name, silent: true });
    n.on('click', () => shell.showItemInFolder(file));
    n.show();
  }
  return file;
}

const showScreenshots = () => { fs.mkdirSync(DIR(), { recursive: true }); shell.openPath(DIR()); };

module.exports = { takeScreenshot, showScreenshots };
