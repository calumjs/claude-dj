// Beat-grid drift detection on synthetic tracks with known beat times, grid edits, section labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { analyzeFile, refineTrack, applyGridEdit } from '../lib/analyze.mjs';
import { labelSections } from '../lib/sections.mjs';
import { timeOfBeat, beatOfTime, shiftCamelot, deckEffectiveCamelot } from '../lib/music.mjs';

const SR = 22050;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djgrid-'));

/** kick + hat on every beat time given; returns wav path */
function synth(name, beats, seconds) {
  const n = Math.round(seconds * SR), x = new Float32Array(n);
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (const [i, t] of beats.entries()) {
    const s0 = Math.round(t * SR);
    for (let k = 0; k < SR * 0.25 && s0 + k < n; k++) {
      const tt = k / SR;
      x[s0 + k] += 0.8 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-tt * 30)) * tt) * Math.exp(-tt * 12);
      if (k < SR * 0.01) x[s0 + k] += 0.2 * rnd() * (1 - k / (SR * 0.01));
    }
    // off-beat hat
    const h0 = Math.round((t + (beats[i + 1] - t || 0.23) / 2) * SR);
    for (let k = 0; k < SR * 0.02 && h0 + k < n; k++) x[h0 + k] += 0.15 * rnd() * Math.exp(-k / (SR * 0.004));
  }
  // a bass-less "breakdown" in the middle (pad only) to exercise the hold-through
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 20000))), 44 + i * 2);
  const f = path.join(dir, name + '.wav');
  fs.writeFileSync(f, buf);
  return f;
}
const lsq = (beats) => { // best constant grid through the beat times
  const n = beats.length, xs = beats.map((_, i) => i), mx = (n - 1) / 2, my = beats.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (beats[i] - my); sxx += (xs[i] - mx) ** 2; }
  const P = sxy / sxx; return { bpm: 60 / P, firstBeat: my - P * mx };
};

test('stable synthetic 128 BPM track: gridStable, one-segment beat map', async () => {
  const beats = []; for (let t = 0.5; t < 150; t += 60 / 128) beats.push(t);
  const f = synth('stable', beats, 152);
  const a = await analyzeFile(f);
  assert.ok(Math.abs(a.bpm - 128) < 0.05, `bpm ${a.bpm}`);
  assert.equal(a.gridStable, true, `drift ${a.drift}`);
  assert.equal(a.beatMap.length, 1);
  assert.ok(a.drift <= 10);
  assert.ok(Array.isArray(a.barEnergy) && a.barEnergy.length === a.bars);
});

test('drifting synthetic track (128 → 128.8 BPM): drift detected, beat map follows the real beats', async () => {
  const beats = []; let t = 0.5, bpm = 128;
  while (t < 170) { beats.push(t); bpm = 128 + (0.8 * t) / 170; t += 60 / bpm; }
  const f = synth('drift', beats, 172);
  const g = lsq(beats);
  const tr = { file: f, bpm: +g.bpm.toFixed(3), firstBeat: +g.firstBeat.toFixed(4), duration: 172, audioStart: 0, audioEnd: 171, analysisVersion: 2 };
  const constErr = Math.max(...beats.map((b, i) => Math.abs(b - (tr.firstBeat + (i * 60) / tr.bpm)))) * 1000;
  assert.ok(constErr > 40, `test setup: constant grid is off by ${constErr.toFixed(0)} ms`);
  const r = await refineTrack(tr);
  assert.equal(r.gridStable, false, `drift ${r.drift}`);
  assert.ok(r.drift > 25, `drift ${r.drift}`);
  assert.ok(r.beatMap.length > 1);
  // the map predicts real beats far better than the constant grid
  const t2 = { ...tr, beatMap: r.beatMap };
  const errs = beats.slice(8, -8).map((b, i) => Math.abs(b - timeOfBeat(t2, i + 8)) * 1000);
  const worst = Math.max(...errs);
  assert.ok(worst < constErr / 2 && worst < 25, `beatMap worst error ${worst.toFixed(1)} ms (constant grid ${constErr.toFixed(0)} ms)`);
  assert.ok(Math.abs(beatOfTime(t2, timeOfBeat(t2, 123.5)) - 123.5) < 1e-6, 'beatOfTime inverts timeOfBeat');
});

test('grid edit maths: shift/nudge/bpm, downbeat kept inside the first bar', () => {
  const d = { bpm: 150, firstBeat: 0.1 };
  assert.deepEqual(applyGridEdit(d, { shiftBeats: 1 }), { bpm: 150, firstBeat: 0.5 });
  assert.deepEqual(applyGridEdit(d, { shiftBeats: -1 }), { bpm: 150, firstBeat: 1.3 });   // wraps forward one bar
  assert.deepEqual(applyGridEdit(d, { nudgeMs: 20 }), { bpm: 150, firstBeat: 0.12 });
  assert.deepEqual(applyGridEdit(d, { bpm: 151 }), { bpm: 151, firstBeat: 0.1 });
});

test('section labels: intro / breakdown / build / drop / outro from features, chorus with vocals', () => {
  const E = [], B = [];
  for (let j = 0; j < 96; j++) {
    const bd = j >= 32 && j < 48;
    E.push(j < 8 ? 0.5 : bd ? 0.3 + (j - 32) * 0.03 : 1); B.push(j < 8 ? 0.2 : bd ? 0.1 : 1);
  }
  const t = { bpm: 128, firstBeat: 0, duration: 190, barEnergy: E, barBass: B, introEndBar: 8, outroStartBar: 80, breakdowns: [{ startBar: 32, endBar: 48, start: 60, drop: 90 }], phraseEnergy: [], phraseChroma: [] };
  const s = labelSections(t);
  const at = (bar) => s.find((x) => bar >= x.startBar && bar <= x.endBar).label;
  assert.equal(at(1), 'intro'); assert.equal(at(35), 'breakdown'); assert.equal(at(45), 'build');
  assert.equal(at(49), 'drop'); assert.equal(at(90), 'outro');
  assert.equal(s[0].start, 0); assert.equal(s[1].startBar, 9);
  const v = labelSections({ ...t, breakdowns: [], vocalPct: 0.5, vocalSections: [{ start: 15, end: 60 }] });
  assert.ok(v.some((x) => x.label === 'chorus'), JSON.stringify(v.map((x) => x.label)));
});

test('effective keys: camelot shift by rate, keylock, engine value wins', () => {
  assert.equal(shiftCamelot('8A', 1), '3A'); assert.equal(shiftCamelot('8A', -1), '1A'); assert.equal(shiftCamelot('12B', 2), '2B');
  assert.equal(deckEffectiveCamelot({ camelot: '8A', rate: 1.06, keylock: false }), '3A');
  assert.equal(deckEffectiveCamelot({ camelot: '8A', rate: 1.06, keylock: true }), '8A');
  assert.equal(deckEffectiveCamelot({ camelot: '8A', rate: 1.06, keylock: true, keyShift: -1 }), '1A');
  assert.equal(deckEffectiveCamelot({ camelot: '8A', effectiveCamelot: '9B' }), '9B');
});
