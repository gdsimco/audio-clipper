// Minimal test runner (no dependencies): node test/run-tests.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as ops from '../src/renderer/audio-ops.mjs';
import { sniffSampleRate, encodeWav, encodeMp3, resampleLinear } from '../src/renderer/codecs.mjs';

// Load lamejs exactly as the app does (browser script defining a global), since
// the package's CommonJS entry is broken upstream.
const loadLame = () => {
  const ctx = {};
  ctx.window = ctx;
  vm.runInNewContext(fs.readFileSync(new URL('../node_modules/lamejs/lame.min.js', import.meta.url), 'utf8'), ctx);
  return ctx.lamejs;
};
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const ramp = (n, sr = 1000) => ops.makeClip(sr, [Float32Array.from({ length: n }, (_, i) => i)]);

test('a new file is one clip covering everything', () => {
  assert.deepEqual(ops.makeTiles(100), [{ lo: 0, hi: 100, s: 0, e: 100 }]);
});

test('split a clip at a point', () => {
  const t = ops.splitTile(ops.makeTiles(100), 0, 40);
  assert.deepEqual(t, [
    { lo: 0, hi: 40, s: 0, e: 40 },
    { lo: 40, hi: 100, s: 40, e: 100 },
  ]);
});

test('split outside the kept part is refused', () => {
  const t = ops.trimTile(ops.makeTiles(100), 0, 'start', 30);
  assert.equal(ops.splitTile(t, 0, 20), null);
  assert.equal(ops.splitTile(t, 0, 30), null);
});

test('removing a middle part = split twice + delete the middle clip', () => {
  let t = ops.makeTiles(100);
  t = ops.splitTile(t, 0, 30);
  t = ops.splitTile(t, 1, 60);
  t = ops.deleteTile(t, 1);
  assert.deepEqual(ops.keptRanges(t), [[0, 30], [60, 100]]);
});

test('the last clip cannot be deleted', () => {
  assert.equal(ops.deleteTile(ops.makeTiles(10), 0), null);
});

test('trim handles stay within the clip and keep a minimum length', () => {
  let t = ops.splitTile(ops.makeTiles(100), 0, 50);
  t = ops.trimTile(t, 1, 'start', 10); // can't go before the split point
  assert.equal(t[1].s, 50);
  t = ops.trimTile(t, 1, 'start', 95, 10); // must leave 10 samples
  assert.equal(t[1].s, 90);
  t = ops.trimTile(t, 1, 'start', 70); // dragging back recovers audio
  assert.equal(t[1].s, 70);
  t = ops.trimTile(t, 0, 'end', 500);
  assert.equal(t[0].e, 50);
});

test('kept position maps to the right clip', () => {
  let t = ops.splitTile(ops.makeTiles(100), 0, 50);
  t = ops.trimTile(t, 1, 'start', 60); // kept: [0,50) + [60,100)
  assert.deepEqual(ops.keptToTile(t, 10), { index: 0, src: 10, offset: 0 });
  assert.deepEqual(ops.keptToTile(t, 55), { index: 1, src: 65, offset: 50 });
  assert.deepEqual(ops.keptToTile(t, 90), { index: 1, src: 100, offset: 50 }); // end
  assert.equal(ops.tileOffset(t, 1), 50);
});

test('flatten reproduces the kept samples', () => {
  const src = ramp(100);
  const clip = ops.flatten(src, [[0, 3], [10, 12]]);
  assert.deepEqual([...clip.channels[0]], [0, 1, 2, 10, 11]);
  assert.equal(clip.length, 5);
});

test('flatten fades only at cuts', () => {
  const src = ops.makeClip(1000, [new Float32Array(100).fill(1)]);
  const clip = ops.flatten(src, [[0, 50], [60, 100]], 4);
  const ch = clip.channels[0];
  assert.equal(ch[0], 1); // untouched start
  assert.equal(ch[49], 0); // fade-out hits zero right before the cut
  assert.equal(ch[50], 0); // fade-in starts at zero
  assert.equal(ch[89], 1); // untouched end
  const joined = ops.flatten(src, [[0, 50], [50, 100]], 4);
  assert.equal(joined.channels[0][49], 1); // contiguous clips aren't faded
});

test('peaks summarize amplitude', () => {
  const clip = ops.makeClip(1000, [Float32Array.from({ length: 2048 }, (_, i) => (i === 1000 ? -0.8 : 0.1))]);
  const peaks = ops.computePeaks(clip);
  assert.ok(Math.abs(peaks.overall - 0.8) < 1e-6);
  assert.ok(Math.abs(ops.peakAmplitude(clip, peaks, 0, 2048) - 0.8) < 1e-6);
  assert.ok(Math.abs(ops.peakAmplitude(clip, peaks, 0, 10) - 0.1) < 1e-6);
});

test('WAV encode writes a valid header that sniffing reads back', () => {
  const clip = ops.makeClip(22050, [new Float32Array([0, 0.5, -1]), new Float32Array([1, -0.5, 0])]);
  const wav = encodeWav(clip);
  assert.equal(wav.length, 44 + 3 * 2 * 2);
  assert.equal(sniffSampleRate(wav), 22050);
  const v = new DataView(wav.buffer);
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getInt16(44, true), 0);
  assert.equal(v.getInt16(46, true), 32767);
  assert.equal(v.getInt16(48 + 2 * 2, true), -32768); // frame 2, left
});

test('sniff FLAC STREAMINFO rate', () => {
  const b = new Uint8Array(42);
  b.set([0x66, 0x4c, 0x61, 0x43]); // fLaC
  const rate = 96000;
  b[18] = (rate >> 12) & 0xff;
  b[19] = (rate >> 4) & 0xff;
  b[20] = (rate & 0x0f) << 4;
  assert.equal(sniffSampleRate(b), 96000);
});

test('MP3 encode produces frames whose rate sniffs correctly', async () => {
  const lame = loadLame();
  const n = 44100;
  const tone = Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / 44100));
  const mp3 = await encodeMp3(ops.makeClip(44100, [tone, tone]), 128, lame);
  assert.ok(mp3.length > 10000, `mp3 too small: ${mp3.length}`);
  assert.equal(sniffSampleRate(mp3), 44100);
});

test('MP3 encode resamples unsupported rates', async () => {
  const lame = loadLame();
  const mp3 = await encodeMp3(ops.makeClip(96000, [new Float32Array(9600)]), 128, lame);
  assert.equal(sniffSampleRate(mp3), 48000);
});

test('linear resample halves length', () => {
  const r = resampleLinear(ramp(100, 2000), 1000);
  assert.equal(r.length, 50);
  assert.equal(r.channels[0][10], 20);
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ok  ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${t.name}\n      ${e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
