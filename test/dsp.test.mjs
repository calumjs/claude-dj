// DSP unit tests for the deck player worklet core. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeckVoice, PlayheadModel, parseWav, wrapLoop, shiftCamelot, zoomFromInt16, CrusherCore } from '../public/worklets/deck-player.js';

const SR = 48000;

function makeSource(fn, seconds, sr = SR) {
  const frames = Math.round(seconds * sr);
  const a = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const [l, r = l] = [].concat(fn(i / sr, i));
    a[2 * i] = Math.max(-32768, Math.min(32767, Math.round(l * 32767)));
    a[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(r * 32767)));
  }
  return { buf: a.buffer, frames };
}
function voiceWith(sources, sr = SR) {
  const v = new DeckVoice(sr);
  const posts = [];
  v.post = (m) => posts.push(typeof m === 'object' ? { ...m } : m);
  const srcs = [].concat(sources);
  v.onMessage({ type: 'load', bufs: srcs.map((s) => s.buf), offsets: srcs.map(() => 0), frames: Math.min(...srcs.map((s) => s.frames)) });
  v.posts = posts;
  return v;
}
/** render `seconds` of audio in 128-frame quanta starting at global frame f0 */
function render(v, seconds, f0 = 0, gains = null, sr = SR) {
  const n = Math.round(seconds * sr), L = new Float32Array(n), R = new Float32Array(n);
  const bl = new Float32Array(128), br = new Float32Array(128);
  for (let o = 0; o < n; o += 128) {
    v.process(bl, br, 128, f0 + o, gains);
    L.set(bl.subarray(0, Math.min(128, n - o)), o); R.set(br.subarray(0, Math.min(128, n - o)), o);
  }
  return { L, R, end: f0 + Math.ceil(n / 128) * 128 };
}
/** frequency by interpolated zero crossings */
function freqOf(x, sr = SR) {
  const zc = [];
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) zc.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  assert.ok(zc.length > 10, 'signal has too few zero crossings');
  return ((zc.length - 1) * sr) / (zc[zc.length - 1] - zc[0]);
}
const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
const sine = (f, amp = 0.5) => (t) => amp * Math.sin(2 * Math.PI * f * t);
const within = (got, want, tol, msg) => assert.ok(Math.abs(got - want) / want <= tol, `${msg}: got ${got.toFixed(3)}, want ${want.toFixed(3)} (±${tol * 100}%)`);

function play(v, { rate = 1, keylock = true, semis = 0, pos = 0.5 } = {}) {
  v.onMessage({ type: 'keylock', on: keylock });
  v.onMessage({ type: 'semis', v: semis });
  v.onMessage({ type: 'events', events: [{ t: 0, type: 'rate', rate }, { t: 0, type: 'start', pos }] });
}

test('WSOLA key lock: tempo 1.25 keeps a 440 Hz tone within 1%', () => {
  const v = voiceWith(makeSource(sine(440), 4));
  play(v, { rate: 1.25 });
  const { L } = render(v, 1.0);
  within(freqOf(L.subarray(4800)), 440, 0.01, 'frequency');
  within(v.pos / SR, 0.5 + 1.25 * (Math.ceil(SR / 128) * 128) / SR, 0.001, 'playhead advanced at tempo 1.25');
  within(rms(L.subarray(4800)), 0.5 / Math.SQRT2, 0.1, 'level preserved');
});

test('WSOLA key lock: tempo 0.8 keeps a 440 Hz tone within 1%', () => {
  const v = voiceWith(makeSource(sine(440), 4));
  play(v, { rate: 0.8 });
  const { L } = render(v, 1.0);
  within(freqOf(L.subarray(4800)), 440, 0.01, 'frequency');
});

test('WSOLA key lock on a complex tone (two partials) keeps both pitches', () => {
  const v = voiceWith(makeSource((t) => 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 330 * t), 4));
  play(v, { rate: 1.12 });
  const { L } = render(v, 1.0);
  // fundamental period of 220+330 is 110 Hz; zero crossings of the 220 component dominate -> check via autocorrelation lag
  const seg = L.subarray(9600, 9600 + 4096);
  let best = 0, bestLag = 0;
  for (let lag = 100; lag < 600; lag++) { let c = 0; for (let i = 0; i < 3000; i++) c += seg[i] * seg[i + lag]; if (c > best) { best = c; bestLag = lag; } }
  within(SR / bestLag, 110, 0.01, 'periodicity (110 Hz)');
});

test('key shift +3 semitones at tempo 1 raises pitch by 2^(3/12)', () => {
  const v = voiceWith(makeSource(sine(440), 4));
  play(v, { rate: 1, semis: 3 });
  const { L } = render(v, 1.0);
  within(freqOf(L.subarray(4800)), 440 * Math.pow(2, 3 / 12), 0.01, 'frequency');
  within(v.pos / SR, 0.5 + (Math.ceil(SR / 128) * 128) / SR, 0.001, 'tempo unchanged by key shift');
});

test('key shift -5 semitones with tempo 1.1 (key lock on)', () => {
  const v = voiceWith(makeSource(sine(440), 4));
  play(v, { rate: 1.1, semis: -5 });
  const { L } = render(v, 1.0);
  within(freqOf(L.subarray(4800)), 440 * Math.pow(2, -5 / 12), 0.01, 'frequency');
});

test('key lock off: varispeed pitch follows tempo', () => {
  const v = voiceWith(makeSource(sine(440), 4));
  play(v, { rate: 1.1, keylock: false });
  const { L } = render(v, 1.0);
  within(freqOf(L.subarray(480)), 484, 0.005, 'frequency');
});

test('key lock off + key shift: pitch = rate * 2^(k/12)', () => {
  const v = voiceWith(makeSource(sine(440), 4));
  play(v, { rate: 1.1, keylock: false, semis: -2 });
  const { L } = render(v, 1.0);
  within(freqOf(L.subarray(4800)), 440 * 1.1 * Math.pow(2, -2 / 12), 0.01, 'frequency');
});

test('reverse playback (rate -1) plays the source backwards', () => {
  // ramp that rises 0 -> 0.9 over 4 s
  const v = voiceWith(makeSource((t) => 0.9 * (t / 4), 4));
  play(v, { rate: -1, keylock: false, pos: 3 });
  const { L } = render(v, 1.0);
  const a = L[1000], b = L[20000], c = L[40000];
  assert.ok(a > b && b > c, `output should fall: ${a} ${b} ${c}`);
  within(L[24000], 0.9 * ((3 - 24000 / SR) / 4), 0.01, 'sample value at 0.5 s in reverse');
  within(v.pos / SR, 3 - (Math.ceil(SR / 128) * 128) / SR, 0.001, 'playhead moved backwards');
});

test('reverse into the start of the track clamps at 0 without errors', () => {
  const v = voiceWith(makeSource(sine(200), 1));
  play(v, { rate: -2, keylock: false, pos: 0.2 });
  const { L } = render(v, 0.5);
  assert.equal(v.pos, 0);
  assert.ok(L.slice(-1000).every((x) => Math.abs(x) < 1e-6), 'silent at the start of the record');
});

test('loop wrap: worklet playhead matches the model and stays inside the loop', () => {
  const v = voiceWith(makeSource(sine(330), 4));
  const m = new PlayheadModel(4);
  const evs = [{ t: 0, type: 'rate', rate: 1.05 }, { t: 0, type: 'start', pos: 0.9 }, { t: 0.05, type: 'loop', loop: { start: 1.0, end: 1.5, beats: 1 } }];
  v.onMessage({ type: 'keylock', on: false });
  v.onMessage({ type: 'events', events: evs });
  for (const e of evs) m.add(e);
  const { end } = render(v, 2.0);
  const want = m.position(end / SR);
  assert.ok(want >= 1.0 && want < 1.5, `model inside loop (${want})`);
  assert.ok(Math.abs(v.pos / SR - want) < 0.0005, `worklet ${v.pos / SR} vs model ${want}`);
});

test('loop wrap with key lock (WSOLA) keeps the playhead in the loop and the pitch', () => {
  const v = voiceWith(makeSource(sine(440), 4));
  const m = new PlayheadModel(4);
  const evs = [{ t: 0, type: 'rate', rate: 1.2 }, { t: 0, type: 'start', pos: 0.9 }, { t: 0, type: 'loop', loop: { start: 1.0, end: 1.25, beats: 1 } }];
  v.onMessage({ type: 'events', events: evs });
  for (const e of evs) m.add(e);
  const { L, end } = render(v, 1.5);
  const want = m.position(end / SR);
  assert.ok(Math.abs(v.pos / SR - want) < 0.0005, `worklet ${v.pos / SR} vs model ${want}`);
  within(freqOf(L.subarray(4800)), 440, 0.01, 'frequency through loop wraps');
});

test('scheduled start is sample accurate', () => {
  const v = voiceWith(makeSource(() => 0.5, 2));
  v.onMessage({ type: 'events', events: [{ t: 0.1, type: 'start', pos: 0 }] });
  const { L } = render(v, 0.2);
  const first = L.findIndex((x) => x !== 0);
  assert.equal(first, 4800, 'first audible sample at frame 4800 (t = 0.1 s)');
  within(L[4800 + 400], 0.5, 0.002, 'full level after the 6 ms declick');
});

test('scheduled start at a non-block-aligned time + late start compensation', () => {
  const v = voiceWith(makeSource(() => 0.5, 2));
  v.onMessage({ type: 'events', events: [{ t: 12345 / SR, type: 'start', pos: 0 }] });
  const { L } = render(v, 0.5);
  assert.equal(L.findIndex((x) => x !== 0), 12345);
  // an event that arrives late is applied immediately but lands on the model's timeline
  const v2 = voiceWith(makeSource(() => 0.5, 2));
  render(v2, 0.1); // time passes: frames 0..4863
  v2.onMessage({ type: 'events', events: [{ t: 0.05, type: 'start', pos: 1.0 }] });
  const { end } = render(v2, 0.1, Math.ceil(4800 / 128) * 128);
  within(v2.pos / SR, 1.0 + (end / SR - 0.05), 0.0005, 'late start caught up with the timeline');
});

test('model and worklet agree through rate changes, a brake curve and a stop', () => {
  const v = voiceWith(makeSource(sine(250), 10));
  v.onMessage({ type: 'keylock', on: false });
  const m = new PlayheadModel(10);
  const pts = []; for (let k = 0; k <= 16; k++) pts.push({ t: 1.0 + k * 0.05, r: 1.03 * Math.pow(0.02 / 1.03, k / 16) });
  const evs = [
    { t: 0.0, type: 'rate', rate: 1.03 }, { t: 0.01, type: 'start', pos: 2 },
    { t: 0.4, type: 'rate', rate: 0.97 }, { t: 0.7, type: 'seek', pos: 5 }, { t: 0.8, type: 'rate', rate: 1.03 },
    { t: 1.0, type: 'curve', pts, after: 1.03 }, { t: 1.8, type: 'stop' },
  ];
  v.onMessage({ type: 'events', events: evs });
  for (const e of evs) m.add(e);
  for (const t of [0.3, 0.6, 0.9, 1.3, 1.7]) {
    const { end } = render(v, t - (v.frameNow / SR), v.frameNow);
    const want = m.position(end / SR);
    assert.ok(Math.abs(v.pos / SR - want) < 0.0006, `t=${t}: worklet ${(v.pos / SR).toFixed(5)} vs model ${want.toFixed(5)}`);
  }
  render(v, 0.3, v.frameNow);
  assert.equal(v.playing, false);
  assert.ok(Math.abs(v.pos / SR - m.position(2.1)) < 0.0006, 'stopped where the model says');
});

test('spinback: negative rate curve plays backwards then stops', () => {
  const v = voiceWith(makeSource((t) => 0.9 * (t / 4), 4));
  v.onMessage({ type: 'keylock', on: false });
  const pts = []; for (let k = 0; k <= 12; k++) pts.push({ t: 0.2 + k * 0.04, r: -2.6 * Math.pow(0.05 / 2.6, k / 12) });
  v.onMessage({ type: 'events', events: [{ t: 0, type: 'start', pos: 2 }, { t: 0.2, type: 'curve', pts, after: 1 }, { t: 0.68, type: 'stop' }] });
  const m = new PlayheadModel(4);
  m.add({ t: 0, type: 'start', pos: 2 }); m.add({ t: 0.2, type: 'curve', pts, after: 1 }); m.add({ t: 0.68, type: 'stop' });
  render(v, 1.0);
  assert.ok(v.pos / SR < 2.2 - 0.2, 'went backwards');
  assert.ok(Math.abs(v.pos / SR - m.position(1)) < 0.001, `worklet ${v.pos / SR} vs model ${m.position(1)}`);
});

test('track end: playback stops at the end and reports ended', () => {
  const v = voiceWith(makeSource(sine(300), 0.5));
  v.onMessage({ type: 'events', events: [{ t: 0, type: 'start', pos: 0.3 }] });
  v.onMessage({ type: 'keylock', on: false });
  render(v, 0.5);
  assert.equal(v.playing, false);
  assert.ok(v.posts.some((p) => p.type === 'ended'), 'ended posted');
  const m = new PlayheadModel(0.5); m.add({ t: 0, type: 'start', pos: 0.3 });
  assert.equal(m.stateAt(0.5).playing, false);
  assert.equal(m.position(0.5), 0.5);
});

test('stems play in lock-step with independent gains', () => {
  const a = makeSource(sine(200, 0.4), 2), b = makeSource(sine(300, 0.4), 2), c = makeSource(() => 0, 2), d = makeSource(() => 0, 2);
  const v = voiceWith([a, b, c, d]);
  v.onMessage({ type: 'events', events: [{ t: 0, type: 'start', pos: 0.1 }] });
  const g = [new Float32Array([0]), new Float32Array([1]), new Float32Array([1]), new Float32Array([1])];
  const { L } = render(v, 0.5, 0, g);
  within(freqOf(L.subarray(2000)), 300, 0.005, 'only the second stem is heard');
  // a-rate gains (per-sample arrays) are honoured
  const v2 = voiceWith([a, b, c, d]);
  v2.onMessage({ type: 'events', events: [{ t: 0, type: 'start', pos: 0.1 }] });
  const ga = [new Float32Array(128).fill(1), new Float32Array(128).fill(0), new Float32Array(128), new Float32Array(128)];
  const r2 = render(v2, 0.5, 0, ga);
  within(freqOf(r2.L.subarray(2000)), 200, 0.005, 'a-rate gains select the first stem');
});

test('stems + key lock: WSOLA runs on all stems in lock-step', () => {
  const a = makeSource(sine(440, 0.3), 3), z = makeSource(() => 0, 3);
  const v = voiceWith([z, a, z, z]);
  play(v, { rate: 1.15 });
  const g = [new Float32Array([1]), new Float32Array([1]), new Float32Array([1]), new Float32Array([1])];
  const { L } = render(v, 1.0, 0, g);
  within(freqOf(L.subarray(4800)), 440, 0.01, 'frequency');
});

test('hand scratch: playhead follows the hand, forwards and backwards, then hands off', () => {
  const v = voiceWith(makeSource(sine(300), 4));
  v.onMessage({ type: 'events', events: [{ t: 0, type: 'start', pos: 1 }] });
  render(v, 0.1);
  const p0 = v.pos / SR;
  v.onMessage({ type: 'hand', on: true });
  // move the record back 0.3 s over 150 ms in 10 steps
  for (let k = 0; k < 10; k++) { v.onMessage({ type: 'handMove', d: -0.03, vel: -2 }); render(v, 0.015, v.frameNow); }
  render(v, 0.1, v.frameNow);
  assert.ok(Math.abs(v.pos / SR - (p0 - 0.3)) < 0.01, `hand position ${v.pos / SR} vs ${p0 - 0.3}`);
  v.onMessage({ type: 'events', events: [{ t: v.frameNow / SR, type: 'handoff', resume: true }] });
  render(v, 0.3, v.frameNow);
  const ho = v.posts.find((p) => p.type === 'handoff');
  assert.ok(ho && ho.resume, 'handoff posted');
  assert.equal(v.hand, false); assert.equal(v.playing, true);
  assert.ok(Math.abs(v.rate - 1) < 1e-9 && v.cf === null, 'back at the deck rate after the motor spin-up');
});

test('model: loop wrap rules, rebase and compaction', () => {
  assert.ok(Math.abs(wrapLoop(1.49, 1.51, 1, 1.5) - 1.01) < 1e-12);
  assert.ok(Math.abs(wrapLoop(1.01, 0.99, 1, 1.5) - 1.49) < 1e-12);
  assert.equal(wrapLoop(0.5, 0.6, 1, 1.5), 0.6);
  const m = new PlayheadModel(100);
  m.add({ t: 1, type: 'start', pos: 10 });
  m.add({ t: 3, type: 'rate', rate: 2 });
  assert.equal(m.position(0.5), 0);
  assert.equal(m.position(2), 11);
  assert.equal(m.position(4), 14);
  m.compact(3.5);
  assert.equal(m.ev.length, 0);
  assert.equal(m.position(4), 14);
  m.rebase(5, 20, true);
  assert.equal(m.position(6), 22);
});

test('parseWav reads the PCM header ffmpeg writes (with a LIST chunk)', () => {
  const frames = 100, data = 4 * frames;
  const ab = new ArrayBuffer(12 + 8 + 16 + 8 + 26 + 8 + data);
  const dv = new DataView(ab); let p = 0;
  const str = (s) => { for (const ch of s) dv.setUint8(p++, ch.charCodeAt(0)); };
  str('RIFF'); dv.setUint32(p, ab.byteLength - 8, true); p += 4; str('WAVE');
  str('fmt '); dv.setUint32(p, 16, true); p += 4; dv.setUint16(p, 1, true); dv.setUint16(p + 2, 2, true); dv.setUint32(p + 4, 44100, true);
  dv.setUint32(p + 8, 44100 * 4, true); dv.setUint16(p + 12, 4, true); dv.setUint16(p + 14, 16, true); p += 16;
  str('LIST'); dv.setUint32(p, 26, true); p += 4 + 26;
  str('data'); dv.setUint32(p, data, true); p += 4;
  const w = parseWav(ab);
  assert.deepEqual({ ch: w.channels, sr: w.sampleRate, bits: w.bits, frames: w.frames, off: w.dataOffset }, { ch: 2, sr: 44100, bits: 16, frames, off: p });
  assert.equal(parseWav(new ArrayBuffer(64)), null);
});

test('camelot shift: +1 semitone = +7 steps, same letter', () => {
  assert.equal(shiftCamelot('8A', 1), '3A');
  assert.equal(shiftCamelot('8A', -1), '1A');
  assert.equal(shiftCamelot('12B', 2), '2B');
  assert.equal(shiftCamelot('5A', 12), '5A');
  assert.equal(shiftCamelot('5A', 0), '5A');
});

test('zoom peaks and crusher core', () => {
  const s = makeSource(sine(100, 0.5), 1);
  const z = zoomFromInt16([new Int16Array(s.buf)], s.frames, SR);
  assert.ok(z.full.length > 140 && Math.abs(Math.max(...z.full) - 0.5) < 0.01);
  const c = new CrusherCore(), inp = [Float32Array.from({ length: 16 }, (_, i) => i / 16)], out = [new Float32Array(16)];
  c.process(inp, out, 2, 4);
  assert.deepEqual([...out[0].subarray(0, 8)], [0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5]);
});

test('process() does not allocate in steady state (sampling heap profiler)', async () => {
  const { Session } = await import('node:inspector/promises');
  for (const keylock of [false, true]) {
    const v = voiceWith([makeSource(sine(440), 30), makeSource(sine(220), 30), makeSource(sine(110), 30), makeSource(sine(55), 30)]);
    play(v, { rate: 1.07, semis: keylock ? 1 : 0, keylock });
    const g = [new Float32Array([1]), new Float32Array([1]), new Float32Array([1]), new Float32Array([1])];
    const bl = new Float32Array(128), br = new Float32Array(128);
    let f = 0;
    for (let k = 0; k < 3000; k++, f += 128) v.process(bl, br, 128, f, g); // warm up / JIT
    v.post = null; // the 20 ms report post is a structured clone by design; exclude it here
    const s = new Session(); s.connect();
    await s.post('HeapProfiler.startSampling', { samplingInterval: 256 });
    for (let k = 0; k < 20000; k++, f += 128) v.process(bl, br, 128, f, g);
    const { profile } = await s.post('HeapProfiler.stopSampling');
    s.disconnect();
    let bytes = 0;
    (function walk(n, inVoice) {
      const here = inVoice || /^(process|rd|wGrain|wSearch|wReset|mono|curveRate|apply|wrapLoop|tap)$/.test(n.callFrame.functionName);
      if (here) bytes += n.selfSize;
      for (const c of n.children) walk(c, here);
    })(profile.head, false);
    // 20000 quanta = 53 s of audio; anything real would be megabytes
    assert.ok(bytes < 64 * 1024, `${keylock ? 'WSOLA' : 'varispeed'}: ~${bytes} bytes allocated in the render path over 20000 quanta`);
  }
});

test('sampler one-shots: finite, non-silent, normalised, click-free edges, sensible pitch', async () => {
  const { synth, PAD_KINDS } = await import('../public/samples.js');
  for (const kind of PAD_KINDS) {
    const o = synth(kind, SR);
    assert.ok(o.L.length > SR * 0.3 && o.L.length === o.R.length, `${kind} length`);
    let pk = 0, e = 0;
    for (const ch of [o.L, o.R]) for (const v of ch) { assert.ok(Number.isFinite(v), `${kind} finite`); pk = Math.max(pk, Math.abs(v)); e += v * v; }
    assert.ok(pk <= 0.9001 && pk > 0.85, `${kind} peak ${pk}`);
    assert.ok(Math.sqrt(e / (2 * o.L.length)) > 0.03, `${kind} not silent`);
    assert.ok(Math.abs(o.L[0]) < 1e-3 && Math.abs(o.L.at(-1)) < 1e-3, `${kind} starts/ends at zero`);
  }
  // the horn's fundamental sits at ~440 Hz: autocorrelation peak of the sustained last blast
  const h = synth('horn', SR).L.subarray(Math.round(0.6 * SR), Math.round(0.9 * SR));
  let best = 0, lag = 0;
  for (let l = 80; l < 140; l++) { let c = 0; for (let i = 0; i < 8000; i++) c += h[i] * h[i + l]; if (c > best) { best = c; lag = l; } }
  within(SR / lag, 440, 0.03, 'air horn pitch');
  // the riser follows the requested length (8 beats at 140 BPM)
  within(synth('riser', SR, { seconds: 8 * 60 / 140 }).L.length / SR, 8 * 60 / 140, 0.001, 'riser length');
});
