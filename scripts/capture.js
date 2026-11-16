// Dev helper: launch the app, optionally run a snippet in the page, and save a screenshot.
//   npx electron scripts/capture.js <out.png> [audio-file] [--js "<code>" | --js-file path] [--wait ms]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--inspect'));
const out = args[0];
const jsIdx = args.indexOf('--js');
const jsFileIdx = args.indexOf('--js-file');
const js = jsFileIdx >= 0 ? fs.readFileSync(args[jsFileIdx + 1], 'utf8') : jsIdx >= 0 ? args[jsIdx + 1] : null;
const waitIdx = args.indexOf('--wait');
const wait = waitIdx >= 0 ? Number(args[waitIdx + 1]) : 1500;

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (_ev, level, message) => {
    if (level >= 2) console.log('[renderer]', message);
  });
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        if (js) console.log('js result:', JSON.stringify(await win.webContents.executeJavaScript(js)));
        await new Promise((r) => setTimeout(r, 400));
        fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
        console.log('saved', out);
      } catch (e) {
        console.error('capture failed', e);
      }
      app.exit(0);
    }, wait);
  });
});

require('../src/main/main.js');
