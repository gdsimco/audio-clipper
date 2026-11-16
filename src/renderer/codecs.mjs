// File-format helpers: sample-rate sniffing (so decoding keeps the original rate),
// and WAV / MP3 encoding for export.

import { makeClip } from './audio-ops.mjs';

/** Best-effort read of a file's native sample rate (WAV, FLAC, MP3). Returns null if unknown. */
export function sniffSampleRate(bytes) {
  const b = bytes;
  const str = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
  const u32le = (o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const ok = (r) => (r >= 3000 && r <= 768000 ? r : null);

  if (b.length >= 12 && str(0, 4) === 'RIFF' && str(8, 4) === 'WAVE') {
    let o = 12;
    while (o + 8 <= b.length) {
      const id = str(o, 4);
      const size = u32le(o + 4);
      if (id === 'fmt ' && o + 16 <= b.length) return ok(u32le(o + 12));
      o += 8 + size + (size & 1);
    }
    return null;
  }

  if (b.length >= 21 && str(0, 4) === 'fLaC') {
    return ok((b[18] << 12) | (b[19] << 4) | (b[20] >> 4));
  }

  // MP3: skip ID3v2 tag, then look for a valid frame header.
  let o = 0;
  if (b.length >= 10 && str(0, 3) === 'ID3') {
    const size = (b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9];
    o = 10 + size + (b[5] & 0x10 ? 10 : 0);
  }
  const limit = Math.min(b.length - 4, o + 64 * 1024);
  for (; o < limit; o++) {
    if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) continue;
    const version = (b[o + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (b[o + 1] >> 1) & 3;
    const rateIdx = (b[o + 2] >> 2) & 3;
    const bitrateIdx = b[o + 2] >> 4;
    if (version === 1 || layer === 0 || rateIdx === 3 || bitrateIdx === 15 || bitrateIdx === 0) continue;
    const base = [44100, 48000, 32000][rateIdx];
    return base / (version === 3 ? 1 : version === 2 ? 2 : 4);
  }
  return null;
}

/** 16-bit PCM WAV. */
export function encodeWav(clip) {
  const nc = clip.channels.length;
  const len = clip.length;
  const dataSize = len * nc * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const ascii = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nc, true);
  v.setUint32(24, clip.sampleRate, true);
  v.setUint32(28, clip.sampleRate * nc * 2, true);
  v.setUint16(32, nc * 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nc; c++) {
      v.setInt16(o, toInt16(clip.channels[c][i]), true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
}

function toInt16(s) {
  if (s >= 1) return 32767;
  if (s <= -1) return -32768;
  return s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
}

function floatToInt16(src, start, end) {
  const out = new Int16Array(end - start);
  for (let i = start; i < end; i++) out[i - start] = toInt16(src[i]);
  return out;
}

const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

/** Simple linear resampler – only used when MP3 can't take the source rate (e.g. 96 kHz). */
export function resampleLinear(clip, rate) {
  const ratio = clip.sampleRate / rate;
  const len = Math.floor(clip.length / ratio);
  const channels = clip.channels.map((src) => {
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const x = i * ratio;
      const j = Math.floor(x);
      const f = x - j;
      out[i] = src[j] * (1 - f) + (src[j + 1] ?? src[j]) * f;
    }
    return out;
  });
  return makeClip(rate, channels);
}

/**
 * MP3 via lamejs (loaded as a global by index.html). Encodes in chunks and yields
 * to the event loop so the UI stays responsive.
 */
export async function encodeMp3(clip, kbps = 192, lame = globalThis.lamejs) {
  if (!lame) throw new Error('MP3 encoder not available');
  let src = clip;
  if (!MP3_RATES.includes(src.sampleRate)) {
    const target = src.sampleRate % 44100 === 0 ? 44100 : 48000;
    src = resampleLinear(src, Math.min(target, 48000));
  }
  const nc = Math.min(2, src.channels.length);
  const enc = new lame.Mp3Encoder(nc, src.sampleRate, kbps);
  const parts = [];
  const block = 1152 * 128;
  for (let s = 0; s < src.length; s += block) {
    const e = Math.min(src.length, s + block);
    const l = floatToInt16(src.channels[0], s, e);
    const out = nc === 2 ? enc.encodeBuffer(l, floatToInt16(src.channels[1], s, e)) : enc.encodeBuffer(l);
    if (out.length) parts.push(new Uint8Array(out.buffer, out.byteOffset, out.length).slice());
    await new Promise((r) => setTimeout(r, 0));
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail.buffer, tail.byteOffset, tail.length).slice());
  const total = parts.reduce((n, p) => n + p.length, 0);
  const result = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    result.set(p, o);
    o += p.length;
  }
  return result;
}
