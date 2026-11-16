// Pure audio editing helpers. No DOM / Web Audio here so they can be unit-tested in Node.
//
// Editing is non-destructive: the original decoded audio ("source") never changes.
// A "clip" here is decoded audio: { sampleRate, channels: Float32Array[], length }.

export const PEAK_BIN = 256;

export function makeClip(sampleRate, channels) {
  return { sampleRate, channels, length: channels.length ? channels[0].length : 0 };
}

export function totalLength(ranges) {
  let n = 0;
  for (const [s, e] of ranges) n += e - s;
  return n;
}

// ---- clips ("tiles") ----
// The edit is a list of clips in play order. Each clip covers source samples [lo, hi)
// (its extent when it was split off) and keeps [s, e) of that – the part inside the
// yellow trim handles. Dragging a handle back out recovers trimmed audio.

export function makeTiles(length) {
  return [{ lo: 0, hi: length, s: 0, e: length }];
}

export function keptRanges(tiles) {
  return tiles.map((t) => [t.s, t.e]);
}

/** Split clip i at source sample p. Returns null if p isn't inside the kept part. */
export function splitTile(tiles, i, p, minLen = 1) {
  const t = tiles[i];
  p = Math.round(p);
  if (!t || p - t.s < minLen || t.e - p < minLen) return null;
  return [...tiles.slice(0, i), { lo: t.lo, hi: p, s: t.s, e: p }, { lo: p, hi: t.hi, s: p, e: t.e }, ...tiles.slice(i + 1)];
}

export function deleteTile(tiles, i) {
  if (tiles.length < 2 || !tiles[i]) return null;
  return tiles.filter((_, j) => j !== i);
}

/** Move one trim handle of clip i, keeping it inside [lo, hi] and at least minLen long. */
export function trimTile(tiles, i, edge, p, minLen = 1) {
  const t = tiles[i];
  p = Math.round(p);
  const next = { ...t };
  if (edge === 'start') next.s = Math.max(t.lo, Math.min(p, t.e - minLen));
  else next.e = Math.min(t.hi, Math.max(p, t.s + minLen));
  return tiles.map((x, j) => (j === i ? next : x));
}

/** Map a position in the kept (playable) audio to { index, src } within a clip. */
export function keptToTile(tiles, k) {
  let cum = 0;
  for (let i = 0; i < tiles.length; i++) {
    const len = tiles[i].e - tiles[i].s;
    if (k < cum + len || i === tiles.length - 1) return { index: i, src: tiles[i].s + Math.min(len, Math.max(0, k - cum)), offset: cum };
    cum += len;
  }
  return { index: 0, src: 0, offset: 0 };
}

export function tileOffset(tiles, i) {
  let cum = 0;
  for (let j = 0; j < i; j++) cum += tiles[j].e - tiles[j].s;
  return cum;
}

function fadeOut(ch, end, n) {
  n = Math.min(n, end);
  for (let i = 0; i < n; i++) ch[end - 1 - i] *= i / n;
}

function fadeIn(ch, start, n) {
  n = Math.min(n, ch.length - start);
  for (let i = 0; i < n; i++) ch[start + i] *= i / n;
}

/**
 * Render the edit into a new clip. A few-millisecond fade is applied on both
 * sides of every cut so joins don't click.
 */
export function flatten(source, ranges, fadeSamples = 0) {
  const len = totalLength(ranges);
  const channels = source.channels.map(() => new Float32Array(len));
  const joins = [];
  let pos = 0;
  ranges.forEach(([s, e], i) => {
    channels.forEach((ch, c) => ch.set(source.channels[c].subarray(s, e), pos));
    if (i > 0 && ranges[i - 1][1] !== s) joins.push(pos);
    pos += e - s;
  });
  if (fadeSamples > 0) {
    for (const j of joins) {
      for (const ch of channels) {
        fadeOut(ch, j, fadeSamples);
        fadeIn(ch, j, fadeSamples);
      }
    }
  }
  return makeClip(source.sampleRate, channels);
}

/** Short fade at a clip's start and/or end (for pieces cut out of the middle of a file). */
export function fadeEdges(clip, n, atStart = true, atEnd = true) {
  for (const ch of clip.channels) {
    if (atStart) fadeIn(ch, 0, n);
    if (atEnd) fadeOut(ch, ch.length, n);
  }
  return clip;
}

/** Min/max per PEAK_BIN samples across all channels, for fast waveform drawing. */
export function computePeaks(clip, bin = PEAK_BIN) {
  const n = Math.ceil(clip.length / bin);
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  let overall = 0;
  for (let b = 0; b < n; b++) {
    const s = b * bin;
    const e = Math.min(clip.length, s + bin);
    let mn = 0;
    let mx = 0;
    for (const ch of clip.channels) {
      for (let i = s; i < e; i++) {
        const v = ch[i];
        if (v < mn) mn = v;
        else if (v > mx) mx = v;
      }
    }
    min[b] = mn;
    max[b] = mx;
    const a = Math.max(-mn, mx);
    if (a > overall) overall = a;
  }
  return { bin, min, max, overall };
}

/** Peak amplitude (0..1) of timeline samples [s0, s1). */
export function peakAmplitude(clip, peaks, s0, s1) {
  s0 = Math.max(0, Math.floor(s0));
  s1 = Math.min(clip.length, Math.ceil(s1));
  if (s1 <= s0) s1 = Math.min(clip.length, s0 + 1);
  let a = 0;
  if (s1 - s0 >= peaks.bin * 2) {
    const b0 = Math.floor(s0 / peaks.bin);
    const b1 = Math.min(peaks.min.length, Math.ceil(s1 / peaks.bin));
    for (let b = b0; b < b1; b++) {
      const v = Math.max(-peaks.min[b], peaks.max[b]);
      if (v > a) a = v;
    }
  } else {
    for (const ch of clip.channels) {
      for (let i = s0; i < s1; i++) {
        const v = ch[i] < 0 ? -ch[i] : ch[i];
        if (v > a) a = v;
      }
    }
  }
  return a;
}
