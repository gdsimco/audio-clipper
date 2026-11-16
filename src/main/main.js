const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs/promises');

const AUDIO_EXT = ['mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'webm', 'weba'];
const isMac = process.platform === 'darwin';
const BG = '#1c1c1e';

let win = null;
let pendingPath = null; // file to open once the window is ready
let dirty = false;
const approvedTargets = new Set(); // paths the user picked in a save dialog
const writtenFiles = new Set(); // paths we exported (allowed for "show in folder")

const isAudio = (p) => AUDIO_EXT.includes(path.extname(p).slice(1).toLowerCase());
const fileFromArgv = (argv) => argv.slice(1).find((a) => !a.startsWith('-') && isAudio(a));

function openPath(p) {
  if (win && !win.webContents.isLoading()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    win.webContents.send('open-path', p);
  } else {
    pendingPath = p;
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const p = fileFromArgv(argv);
    if (p) openPath(p);
    else if (win) win.focus();
  });
}

// macOS: files dropped on the dock icon / "Open With"
app.on('open-file', (e, p) => {
  e.preventDefault();
  openPath(p);
});

function createWindow() {
  win = new BrowserWindow({
    width: 600,
    height: 190,
    minWidth: 440,
    minHeight: 170,
    maxHeight: 320,
    show: false,
    title: 'Audio Clipper',
    backgroundColor: BG,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    ...(isMac
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 10 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: BG, symbolColor: '#8e8e93', height: 34 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.on('close', (e) => {
    if (!dirty) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Discard changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have edits that haven’t been exported.',
      detail: 'Close anyway and discard them?',
    });
    if (choice === 1) e.preventDefault();
  });
  win.on('closed', () => (win = null));
}

function buildMenu() {
  if (!isMac) {
    // Windows: no menu bar; the renderer handles all shortcuts.
    Menu.setApplicationMenu(null);
    return;
  }
  // macOS needs a menu for Cmd+Q etc. Our items show shortcuts but don't register them,
  // so the renderer's own key handling stays the single source of truth.
  const cmd = (label, accelerator, command) => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => win && win.webContents.send('menu', command),
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { label: 'File', submenu: [cmd('Open…', 'Cmd+O', 'open'), cmd('Export…', 'Cmd+S', 'export'), { type: 'separator' }, { role: 'close' }] },
      {
        label: 'Edit',
        submenu: [
          cmd('Undo', 'Cmd+Z', 'undo'),
          cmd('Redo', 'Shift+Cmd+Z', 'redo'),
          { type: 'separator' },
          cmd('Split Clip', 'S', 'split'),
          cmd('Delete Clip', 'Backspace', 'delete'),
        ],
      },
      { role: 'windowMenu' },
    ]),
  );
}

async function readAudio(p) {
  const data = await fs.readFile(p);
  return { path: p, name: path.basename(p), data };
}

ipcMain.handle('open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open audio',
    properties: ['openFile'],
    filters: [
      { name: 'Audio', extensions: AUDIO_EXT },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return readAudio(r.filePaths[0]);
});

ipcMain.handle('read-file', async (_e, p) => {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Invalid path');
  return readAudio(p);
});

ipcMain.handle('initial-file', () => {
  const p = pendingPath || fileFromArgv(process.argv);
  pendingPath = null;
  return p || null;
});

ipcMain.handle('save-dialog', async (_e, { defaultName, defaultDir, ext, multi }) => {
  const r = await dialog.showSaveDialog(win, {
    title: multi ? 'Export clips — files will be numbered automatically' : 'Export audio',
    message: multi ? 'Each clip is saved as “name 1”, “name 2”, …' : undefined,
    defaultPath: path.join(defaultDir || app.getPath('music'), defaultName),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (r.canceled || !r.filePath) return null;
  approvedTargets.add(r.filePath);
  return r.filePath;
});

ipcMain.handle('write-export', async (_e, { target, files }) => {
  if (!approvedTargets.has(target)) throw new Error('Target was not chosen by the user');
  approvedTargets.delete(target);
  const ext = path.extname(target);
  const base = target.slice(0, target.length - ext.length);
  const pad = String(files.length).length;
  const written = [];
  for (let i = 0; i < files.length; i++) {
    const out = files.length === 1 ? target : `${base} ${String(i + 1).padStart(pad, '0')}${ext}`;
    await fs.writeFile(out, Buffer.from(files[i]));
    writtenFiles.add(out);
    written.push(out);
  }
  return written;
});

// Export choices as a native popup menu – fits even a tiny window.
ipcMain.handle('export-menu', (_e, { multi, count }) => {
  return new Promise((resolve) => {
    let picked = null;
    const item = (label, value) => ({ label, click: () => (picked = value) });
    const template = multi
      ? [
          { label: `${count} separate files`, enabled: false },
          item('WAV…', 'wav:separate'),
          item('MP3…', 'mp3:separate'),
          { type: 'separator' },
          { label: 'Joined into one file', enabled: false },
          item('WAV…', 'wav:single'),
          item('MP3…', 'mp3:single'),
        ]
      : [item('Save as WAV…', 'wav:single'), item('Save as MP3…', 'mp3:single')];
    Menu.buildFromTemplate(template).popup({ window: win, callback: () => setImmediate(() => resolve(picked)) });
  });
});

ipcMain.handle('reveal', (_e, p) => {
  if (writtenFiles.has(p)) shell.showItemInFolder(p);
});

ipcMain.on('set-dirty', (_e, v) => {
  dirty = !!v;
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
