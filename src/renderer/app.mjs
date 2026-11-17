import * as ops from './audio-ops.mjs';
import { sniffSampleRate, encodeWav, encodeMp3 } from './codecs.mjs';
import { Strip, formatTime } from './strip.mjs';

const api = window.api;
const $ = (id) => document.getElementById(id);
const isMac = api.platform === 'darwin';
const FADE_MS = 3; // tiny fade at cut points so joins don't click

// ---------------- state ----------------
const S = {
  source: null, // original decoded audio – never modified
  peaks: null,
  file: null, // { name, base, dir }
  tiles: null, // clips, see audio-ops.mjs
  sel: 0, // selected clip index
  savedTiles: null, // tiles at last export (for the unsaved dot)
  history: [],
  future: [],
  clip: null, // kept audio, flattened, for playback
  playhead: 0, // position in kept audio (samples)
  playing: null,
  trimInfo: null, // set while a handle is being dragged
};

let audioCtx = null;
let audioBuffer = null;

const strip = new Strip($('strip'), S, {
  select: (i) => {
    S.sel = i;
    strip.redraw();
    updateUI();
  },
  seek: (k) => seek(k),
  trimming: (info) => {
    S.trimInfo = info;
    updateTime();
  },
  trimmed: (tiles, edge) => {
    commit(tiles);
    // park the playhead at the edge you just dragged, so you can hear it
    const off = ops.tileOffset(S.tiles, S.sel);
    const t = S.tiles[S.sel];
    seek(edge === 'start' ? off : Math.max(off, off + (t.e - t.s) - Math.round(S.clip.sampleRate * 0.5)));
  },
});

window.audioClipper = { S, strip }; // handy in DevTools

// ---------------- loading ----------------
async function loadFile({ data, name, path }) {
  if (isDirty() && !confirm(`Discard your edits to “${S.file.name}” and open “${name}”?`)) return;
  stop();
  busy(`Opening ${name}…`);
  try {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const rate = sniffSampleRate(bytes) || 44100;
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    // Decoding with an OfflineAudioContext at the file's own rate avoids resampling.
    const decoded = await new OfflineAudioContext(1, 1, rate).decodeAudioData(ab);
    if (!decoded.length) throw new Error('empty');
    const channels = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c).slice());
    S.source = ops.makeClip(decoded.sampleRate, channels);
    S.peaks = ops.computePeaks(S.source);
    const dot = name.lastIndexOf('.');
    const dir = path ? path.slice(0, Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))) : null;
    S.file = { name, base: dot > 0 ? name.slice(0, dot) : name, dir };
    S.tiles = ops.makeTiles(S.source.length);
    S.savedTiles = S.tiles;
    S.sel = 0;
    S.history = [];
    S.future = [];
    S.playhead = 0;
    rebuild();
    $('empty').hidden = true;
    $('editor').hidden = false;
    strip.resize();
    strip.invalidate();
    updateUI();
  } catch (err) {
    console.error(err);
    toast(`Couldn’t open “${name}”`, { error: true });
  } finally {
    busy(null);
  }
}

async function openViaDialog() {
  const f = await api.openDialog();
  if (f) loadFile(f);
}

async function openPath(p) {
  try {
    loadFile(await api.readFile(p));
  } catch {
    toast('Couldn’t read that file', { error: true });
  }
}

// ---------------- editing ----------------
const isDirty = () => !!S.tiles && S.tiles !== S.savedTiles;
const minLen = () => Math.round(S.source.sampleRate * 0.05);

function rebuild() {
  stop();
  const fade = Math.round((S.source.sampleRate * FADE_MS) / 1000);
  S.clip = ops.flatten(S.source, ops.keptRanges(S.tiles), fade);
  audioBuffer = null;
  S.sel = Math.min(S.sel, S.tiles.length - 1);
  S.playhead = Math.max(0, Math.min(S.playhead, S.clip.length));
}

function commit(tiles, sel = S.sel) {
  S.history.push({ tiles: S.tiles, sel: S.sel });
  if (S.history.length > 300) S.history.shift();
  S.future = [];
  S.tiles = tiles;
  S.sel = sel;
  rebuild();
  strip.invalidate();
  updateUI();
}

function undo() {
  if (!S.history.length) return;
  S.future.push({ tiles: S.tiles, sel: S.sel });
  ({ tiles: S.tiles, sel: S.sel } = S.history.pop());
  rebuild();
  strip.invalidate();
  updateUI();
}

function redo() {
  if (!S.future.length) return;
  S.history.push({ tiles: S.tiles, sel: S.sel });
  ({ tiles: S.tiles, sel: S.sel } = S.future.pop());
  rebuild();
  strip.invalidate();
  updateUI();
}

function splitTarget() {
  const { index, src } = ops.keptToTile(S.tiles, S.playhead);
  return ops.splitTile(S.tiles, index, src, minLen()) ? { index, src } : null;
}

function split() {
  const target = splitTarget();
  if (!target) {
    toast('Move the playhead inside a clip to split it');
    return;
  }
  const keep = S.playhead;
  commit(ops.splitTile(S.tiles, target.index, target.src, minLen()), target.index + 1);
  S.playhead = keep;
  updateUI();
}

function deleteClip() {
  if (S.tiles.length < 2) {
    toast('Drag the yellow handles to trim — split first to remove a middle part');
    return;
  }
  const i = S.sel;
  const at = ops.tileOffset(S.tiles, i);
  commit(ops.deleteTile(S.tiles, i), Math.min(i, S.tiles.length - 2));
  S.playhead = Math.min(at, S.clip.length);
  updateUI();
}

function selectClip(delta) {
  if (!S.tiles) return;
  S.sel = (S.sel + delta + S.tiles.length) % S.tiles.length;
  seek(ops.tileOffset(S.tiles, S.sel));
}

// ---------------- playback ----------------
function ensureAudio() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (!audioBuffer) {
    const c = S.clip;
    audioBuffer = audioCtx.createBuffer(c.channels.length, Math.max(1, c.length), c.sampleRate);
    c.channels.forEach((ch, i) => audioBuffer.copyToChannel(ch, i));
  }
}

function play() {
  if (!S.clip?.length) return;
  ensureAudio();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const from = S.playhead >= S.clip.length - 1 ? 0 : S.playhead;
  startNode(from);
}

function startNode(from) {
  stopNode();
  const sr = S.clip.sampleRate;
  const node = audioCtx.createBufferSource();
  node.buffer = audioBuffer;
  node.connect(audioCtx.destination);
  const playing = { node, from, t0: audioCtx.currentTime };
  node.onended = () => {
    if (S.playing !== playing) return;
    S.playing = null;
    S.playhead = 0; // back to the start, ready to play again
    strip.redraw();
    updateUI();
  };
  node.start(0, from / sr);
  S.playing = playing;
  updateUI();
  requestAnimationFrame(tick);
}

function stopNode() {
  const p = S.playing;
  if (!p) return;
  S.playing = null;
  try {
    p.node.stop();
  } catch {
    /* already stopped */
  }
}

function stop() {
  if (!S.playing) return;
  stopNode();
  updateUI();
}

const togglePlay = () => (S.playing ? stop() : play());

function tick() {
  const p = S.playing;
  if (!p) return;
  S.playhead = Math.min(S.clip.length, Math.round(p.from + (audioCtx.currentTime - p.t0) * S.clip.sampleRate));
  strip.redraw();
  updateTime();
  requestAnimationFrame(tick);
}

function seek(k) {
  S.playhead = Math.max(0, Math.min(S.clip.length, Math.round(k)));
  // keep the selection on the clip under the playhead
  const off = ops.tileOffset(S.tiles, S.sel);
  const t = S.tiles[S.sel];
  if (S.playhead < off || S.playhead > off + (t.e - t.s)) S.sel = ops.keptToTile(S.tiles, S.playhead).index;
  if (S.playing) {
    if (S.playhead < S.clip.length - 1) startNode(S.playhead);
    else stop();
  }
  strip.redraw();
  updateUI();
}

const nudge = (sec) => S.clip && seek(S.playhead + sec * S.clip.sampleRate);

// ---------------- export ----------------
async function exportAudio() {
  if (!S.clip) return;
  stop();
  const multi = S.tiles.length > 1;
  const choice = await api.exportMenu({ multi, count: S.tiles.length });
  if (!choice) return;
  const [format, mode] = choice.split(':');
  const separate = mode === 'separate';
  const target = await api.saveDialog({
    defaultName: `${S.file.base}${separate ? '' : ' (edited)'}.${format}`,
    defaultDir: S.file.dir,
    ext: format,
    multi: separate,
  });
  if (!target) return;
  const fade = Math.round((S.source.sampleRate * FADE_MS) / 1000);
  const pieces = separate
    ? S.tiles.map((t) => ops.fadeEdges(ops.flatten(S.source, [[t.s, t.e]]), fade, t.s > 0, t.e < S.source.length))
    : [S.clip];
  try {
    const files = [];
    for (let i = 0; i < pieces.length; i++) {
      busy(pieces.length > 1 ? `Exporting ${i + 1} of ${pieces.length}…` : 'Exporting…');
      await new Promise((r) => setTimeout(r, 30)); // let the overlay paint
      files.push(format === 'mp3' ? await encodeMp3(pieces[i]) : encodeWav(pieces[i]));
    }
    const written = await api.writeExport({ target, files });
    S.savedTiles = S.tiles;
    updateUI();
    toast(written.length > 1 ? `Saved ${written.length} clips` : 'Saved', {
      action: isMac ? 'Show in Finder' : 'Show in folder',
      onAction: () => api.reveal(written[0]),
    });
  } catch (err) {
    console.error(err);
    toast(`Export failed: ${err.message || err}`, { error: true });
  } finally {
    busy(null);
  }
}

// ---------------- UI ----------------
function updateTime() {
  if (!S.clip) return;
  const sr = S.clip.sampleRate;
  const el = $('time');
  const info = S.trimInfo;
  if (info) {
    const t = info.tiles[S.sel];
    const len = info.tiles.reduce((n, x) => n + (x.e - x.s), 0);
    el.innerHTML = `<span class="hl">${info.edge === 'start' ? 'Start' : 'End'} ${formatTime(info.src / sr)}</span> · ${formatTime((t.e - t.s) / sr)} clip · ${formatTime(len / sr)} total`;
    return;
  }
  el.innerHTML = `<b>${formatTime(S.playhead / sr)}</b> / ${formatTime(S.clip.length / sr)}`;
}

function updateUI() {
  if (!S.clip) return;
  updateTime();
  $('play-icon').setAttribute('href', S.playing ? '#i-pause' : '#i-play');
  $('btn-play').setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
  $('btn-undo').disabled = !S.history.length;
  $('btn-split').disabled = !splitTarget();
  $('btn-delete').disabled = S.tiles.length < 2;
  $('btn-export').textContent = S.tiles.length > 1 ? `Export ${S.tiles.length}` : 'Export';

  const t = $('file-title');
  t.replaceChildren();
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = S.file.name;
  t.append(name);
  if (isDirty()) {
    const dot = document.createElement('span');
    dot.className = 'dirty';
    dot.title = 'Edited — not exported yet';
    t.append(dot);
  }
  document.title = `${S.file.name} — Audio Clipper`;
  api.setDirty(isDirty());
}

let toastTimer = null;
function toast(text, { error = false, action, onAction } = {}) {
  const el = $('toast');
  $('toast-text').textContent = text;
  el.classList.toggle('error', error);
  const btn = $('toast-action');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action;
    btn.onclick = () => {
      onAction();
      el.classList.remove('show');
    };
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 6000 : 2800);
}

function busy(text) {
  $('busy').hidden = !text;
  if (text) $('busy-text').textContent = text;
}

// ---------------- wiring ----------------
const actions = { open: openViaDialog, export: exportAudio, undo, redo, split, delete: deleteClip };

$('empty').addEventListener('click', openViaDialog);
$('btn-play').addEventListener('click', togglePlay);
$('btn-undo').addEventListener('click', undo);
$('btn-split').addEventListener('click', split);
$('btn-delete').addEventListener('click', deleteClip);
$('btn-export').addEventListener('click', exportAudio);

// Buttons shouldn't hold focus after a click, so Space always means play/pause.
document.addEventListener('mouseup', () => {
  if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur();
});

api.onMenu((cmd) => actions[cmd]?.());
api.onOpenPath(openPath);

document.addEventListener('keydown', (e) => {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'o') return e.preventDefault(), openViaDialog();
  if (!S.clip) return;
  if (mod && (k === 's' || k === 'e')) return e.preventDefault(), exportAudio();
  if (mod && k === 'z') return e.preventDefault(), e.shiftKey ? redo() : undo();
  if (mod && k === 'y') return e.preventDefault(), redo();
  if (mod || e.altKey) return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      if (!e.repeat) togglePlay();
      break;
    case 's':
    case 'S':
      e.preventDefault(); // handled here; on macOS this stops the Split menu item firing too
      split();
      break;
    case 'Delete':
    case 'Backspace':
      e.preventDefault();
      deleteClip();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      nudge(e.shiftKey ? -1 : -0.1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      nudge(e.shiftKey ? 1 : 0.1);
      break;
    case 'Tab':
      e.preventDefault();
      selectClip(e.shiftKey ? -1 : 1);
      break;
    case 'Home':
      seek(0);
      break;
    case 'End':
      seek(S.clip.length);
      break;
  }
});

// drag & drop anywhere in the window
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  loadFile({ data: new Uint8Array(await file.arrayBuffer()), name: file.name, path: api.pathForFile(file) });
});

document.body.classList.add(`platform-${api.platform}`);
api.initialFile().then((p) => p && openPath(p));
