// The trim strip: clips drawn as rounded waveform tiles, a yellow frame with drag
// handles around the selected clip, and a white playhead you can scrub.

import { peakAmplitude, keptToTile, tileOffset, trimTile } from './audio-ops.mjs';

const HW = 14; // handle width
const GAP = HW + 4; // space between clips – wide enough for a handle to sit in
const PAD_Y = 5; // room above/below tiles for the playhead
const RADIUS = 7;
const BORDER = 3;

const C = {
  tile: '#2c2c2e',
  bars: '#a1a1aa',
  dim: 'rgba(16, 16, 18, 0.66)',
  yellow: '#ffd60a',
  chevron: '#4a3b00',
  playhead: '#ffffff',
};

export function formatTime(sec, decimals = 2) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(decimals).padStart(decimals ? decimals + 3 : 2, '0')}`;
}

export class Strip {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} S app state: source, peaks, tiles, sel, playhead (in kept samples)
   * @param {object} cb { select(i), seek(kept), trimming(info|null), trimmed(tiles) }
   */
  constructor(canvas, S, cb) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.S = S;
    this.cb = cb;
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.rects = [];
    this.cache = null;
    this.drag = null;
    this.preview = null; // tiles while a handle is being dragged
    this.needsDraw = true;

    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', () => this.cancelDrag());

    const loop = () => {
      if (this.needsDraw) {
        this.needsDraw = false;
        this.draw();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  get tiles() {
    return this.preview || this.S.tiles;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (r.width === this.w && r.height === this.h && dpr === this.dpr) return;
    this.w = r.width;
    this.h = r.height;
    this.dpr = dpr;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.invalidate();
  }

  /** Call when the clip layout (split/delete/load) changes. */
  invalidate() {
    this.cache = null;
    if (this.S.tiles) this.layout(); // keep hit-testing correct before the next frame
    this.redraw();
  }

  redraw() {
    this.needsDraw = true;
  }

  // ---------- geometry ----------
  layout() {
    const tiles = this.S.tiles;
    const inner = this.w - 2 * HW - GAP * (tiles.length - 1);
    const total = tiles.reduce((n, t) => n + (t.hi - t.lo), 0) || 1;
    let x = HW;
    this.rects = tiles.map((t) => {
      const w = Math.max(4, (inner * (t.hi - t.lo)) / total);
      const r = { x, w };
      x += w + GAP;
      return r;
    });
  }

  srcToX(i, src) {
    const t = this.tiles[i];
    const r = this.rects[i];
    return r.x + ((src - t.lo) / (t.hi - t.lo)) * r.w;
  }

  xToSrc(i, x) {
    const t = this.tiles[i];
    const r = this.rects[i];
    return t.lo + ((x - r.x) / r.w) * (t.hi - t.lo);
  }

  tileAt(x) {
    let best = 0;
    let bestD = Infinity;
    this.rects.forEach((r, i) => {
      const d = x < r.x ? r.x - x : x > r.x + r.w ? x - r.x - r.w : 0;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  keptToX(k) {
    const { index, src } = keptToTile(this.tiles, k);
    return this.srcToX(index, src);
  }

  xToKept(x) {
    const i = this.tileAt(x);
    const t = this.tiles[i];
    const src = Math.max(t.s, Math.min(t.e, this.xToSrc(i, x)));
    return tileOffset(this.tiles, i) + (src - t.s);
  }

  // ---------- drawing ----------
  buildCache() {
    this.layout();
    const { source, peaks } = this.S;
    const d = this.dpr;
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext('2d');
    g.scale(d, d);
    const th = this.h - 2 * PAD_Y;
    const gain = peaks.overall > 0 ? Math.min(4, 0.92 / peaks.overall) : 1;
    this.S.tiles.forEach((t, i) => {
      const r = this.rects[i];
      g.save();
      g.beginPath();
      g.roundRect(r.x, PAD_Y, r.w, th, RADIUS);
      g.fillStyle = C.tile;
      g.fill();
      g.clip();
      g.fillStyle = C.bars;
      const mid = PAD_Y + th / 2;
      const spp = (t.hi - t.lo) / r.w;
      for (let x = 2; x < r.w - 2; x += 3) {
        const s0 = t.lo + x * spp;
        const a = Math.min(1, peakAmplitude(source, peaks, s0, s0 + 3 * spp) * gain);
        const bh = Math.max(2, a * (th - 14));
        g.beginPath();
        g.roundRect(r.x + x, mid - bh / 2, 2, bh, 1);
        g.fill();
      }
      g.restore();
    });
    this.cache = c;
  }

  draw() {
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.S.source || !this.w) return;
    if (!this.cache) this.buildCache();
    ctx.drawImage(this.cache, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const th = this.h - 2 * PAD_Y;
    const tiles = this.tiles;

    // dim trimmed-away parts
    ctx.fillStyle = C.dim;
    tiles.forEach((t, i) => {
      const r = this.rects[i];
      const xs = this.srcToX(i, t.s);
      const xe = this.srcToX(i, t.e);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(r.x, PAD_Y, r.w, th, RADIUS);
      ctx.clip();
      if (xs > r.x) ctx.fillRect(r.x, PAD_Y, xs - r.x, th);
      if (xe < r.x + r.w) ctx.fillRect(xe, PAD_Y, r.x + r.w - xe, th);
      ctx.restore();
    });

    // yellow frame + handles on the selected clip
    const i = this.S.sel;
    const t = tiles[i];
    if (t) {
      const xs = this.srcToX(i, t.s);
      const xe = this.srcToX(i, t.e);
      ctx.fillStyle = C.yellow;
      ctx.fillRect(xs, PAD_Y, xe - xs, BORDER);
      ctx.fillRect(xs, PAD_Y + th - BORDER, xe - xs, BORDER);
      ctx.beginPath();
      ctx.roundRect(xs - HW, PAD_Y, HW, th, [RADIUS, 0, 0, RADIUS]);
      ctx.roundRect(xe, PAD_Y, HW, th, [0, RADIUS, RADIUS, 0]);
      ctx.fill();
      this.chevron(xs - HW / 2, PAD_Y + th / 2, -1);
      this.chevron(xe + HW / 2, PAD_Y + th / 2, 1);
    }

    // playhead
    if (!this.drag || this.drag.type !== 'handle') {
      const x = Math.round(this.keptToX(this.S.playhead));
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 4;
      ctx.fillStyle = C.playhead;
      ctx.beginPath();
      ctx.roundRect(x - 1.5, 1, 3, this.h - 2, 1.5);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  chevron(cx, cy, dir) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = C.chevron;
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - 2 * dir, cy - 6);
    ctx.lineTo(cx + 2 * dir, cy);
    ctx.lineTo(cx - 2 * dir, cy + 6);
    ctx.stroke();
    ctx.restore();
  }

  // ---------- interaction ----------
  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  hitHandle(x) {
    const i = this.S.sel;
    const t = this.S.tiles[i];
    if (!t) return null;
    const xs = this.srcToX(i, t.s);
    const xe = this.srcToX(i, t.e);
    if (x >= xs - HW - 4 && x <= xs + 3) return 'start';
    if (x >= xe - 3 && x <= xe + HW + 4) return 'end';
    return null;
  }

  onDown(e) {
    if (!this.S.source || e.button !== 0) return;
    if (!this.cache) this.buildCache();
    const { x } = this.pos(e);
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    const edge = this.hitHandle(x);
    if (edge) {
      const t = this.S.tiles[this.S.sel];
      this.drag = { type: 'handle', edge, grab: x - this.srcToX(this.S.sel, edge === 'start' ? t.s : t.e) };
      this.preview = this.S.tiles;
      this.updateHandle(x);
      return;
    }
    const i = this.tileAt(x);
    if (i !== this.S.sel) this.cb.select(i);
    this.drag = { type: 'scrub' };
    this.cb.seek(this.xToKept(x));
  }

  updateHandle(x) {
    const i = this.S.sel;
    const minLen = Math.round(this.S.source.sampleRate * 0.05);
    const src = this.xToSrc(i, x - this.drag.grab);
    this.preview = trimTile(this.S.tiles, i, this.drag.edge, src, minLen);
    const t = this.preview[i];
    this.cb.trimming({ edge: this.drag.edge, src: this.drag.edge === 'start' ? t.s : t.e, tiles: this.preview });
    this.redraw();
  }

  onMove(e) {
    if (!this.S.source) return;
    const { x } = this.pos(e);
    if (!this.drag) {
      this.canvas.style.cursor = this.hitHandle(x) ? 'ew-resize' : 'pointer';
      return;
    }
    if (this.drag.type === 'handle') this.updateHandle(x);
    else this.cb.seek(this.xToKept(x));
  }

  onUp() {
    const d = this.drag;
    this.drag = null;
    if (d?.type === 'handle') {
      const tiles = this.preview;
      const edge = d.edge;
      this.preview = null;
      this.cb.trimming(null);
      if (tiles !== this.S.tiles) this.cb.trimmed(tiles, edge);
    }
    this.redraw();
  }

  cancelDrag() {
    this.drag = null;
    this.preview = null;
    this.cb.trimming(null);
    this.redraw();
  }
}
