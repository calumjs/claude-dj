// Integration tests: public/engine.js driven through a Web Audio mock whose worklet nodes run the real DeckVoice.
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SR, render, flush, wav, server, ctxLog, MockParam } from './webaudio-mock.mjs';
const { Mixer, Ctl, STEMS } = await import('../public/engine.js');

const BPM = 128, BEAT = 60 / BPM;
function addTrack(id, { seconds = 60, bpm = BPM, stems = false, camelot = '8A', freq = 220 } = {}) {
  const t = {
    id, title: `Track ${id}`, artist: 'Test', bpm, camelot, key: 'Am', energy: 7, firstBeat: 0.05, mixIn: 0.05, introEnd: 0.05 + 16 * 60 / bpm,
    mixOut: seconds - 20, duration: seconds, gainDb: 0, breakdowns: [{ start: 0.05 + 32 * 60 / bpm, drop: 0.05 + 48 * 60 / bpm, startBar: 9, endBar: 13 }],
    waveform: { peaks: [1], lows: [1] }, url: `/audio/${id}`, ...(stems ? { stems: [...STEMS] } : {}),
  };
  server.tracks.set(id, t);
  server.files.set(`/audio/${id}`, wav(seconds, (x) => 0.4 * Math.sin(2 * Math.PI * freq * x)));
  if (stems) STEMS.forEach((s, k) => server.files.set(`/audio/${id}/stem/${s}`, wav(seconds, (x) => 0.2 * Math.sin(2 * Math.PI * freq * (k + 1) * x))));
  return t;
}
async function rig() {
  const m = new Mixer();
  await m.ctx.resume();
  await m.init();
  return m;
}
const voiceOf = (d) => d.node.voice;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
/** the model (main thread) and the worklet (audio thread) must agree on the playhead */
function agree(d, tol = 0.002) {
  flush();
  const v = voiceOf(d), t = d.ctx.currentTime;
  const wpos = (v.stopPos >= 0 ? v.stopPos : v.pos) / SR;
  near(d.position(t), wpos, tol, `deck ${d.name} model vs worklet at t=${t.toFixed(3)}`);
}

test('load + play + pause: position tracks the audio clock exactly', async () => {
  const m = await rig(); const A = m.decks.A;
  await A.load(addTrack('t1'));
  assert.equal(A.loaded ?? !!A.buffer, true);
  assert.equal(A.keylock, true, 'key lock defaults ON for new loads');
  near(A.position(), 0.05, 1e-9, 'cued at mix-in');
  A.play(); render(2.0); agree(A);
  near(A.position(), 0.05 + 2.0 - 0.01, 0.003, 'played ~2 s');
  A.setRate(1.05); render(1.0); agree(A);
  A.pause(); render(0.2); agree(A);
  assert.equal(A.playing, false);
  const p = A.position(); render(0.5); near(A.position(), p, 1e-9, 'paused position holds');
});

test('every mix style schedules cleanly and hands over on the grid', async () => {
  for (const style of ['blend', 'bassswap', 'fade', 'filter', 'echo', 'cut', 'brake', 'spinback', 'double']) {
    const m = await rig(); const A = m.decks.A, B = m.decks.B;
    await A.load(addTrack('a1', { seconds: 120 })); await B.load(addTrack('b1', { seconds: 120, bpm: 126 }));
    A.play(); render(style === 'double' ? 1 : 10);
    // A's beat phase extrapolated at constant tempo (where the outgoing grid would be)
    const tA = A.ctx.currentTime, pA = A.position(tA), aBeat = (t) => A.beatAt(pA + (t - tA) * A.rate);
    const r = m.mix({ from: 'A', to: 'B', style, bars: style === 'blend' ? 4 : undefined, at: 'bar' });
    assert.ok(r.style === style, `${style} result`);
    const endIn = (m.transition.endAt - Date.now()) / 1000;
    render(Math.max(0.5, endIn + 0.3));
    agree(A); agree(B);
    assert.equal(B.playing, true, `${style}: B playing`);
    assert.equal(A.playing, false, `${style}: A stopped`);
    near(m.xfader.value(), 1, 0.01, `${style}: crossfader on B`);
    // B enters phase-locked to A's grid (same beat fraction), at A's tempo
    const t1 = B.ctx.currentTime, frac = (x) => ((x % 1) + 1) % 1;
    const dphase = frac(B.beatAt(B.position(t1)) - aBeat(t1) + 0.5) - 0.5;
    near(dphase, 0, 0.01, `${style}: incoming phase-locked to the outgoing grid`);
    if (!['echo', 'cut', 'brake', 'spinback'].includes(style)) near(B.effBpm, 128, 0.01, `${style}: incoming at the outgoing tempo`);
  }
});

test('brake and spinback use native rate curves (spinback plays backwards)', async () => {
  const m = await rig(); const A = m.decks.A, B = m.decks.B;
  await A.load(addTrack('a2', { seconds: 120 })); await B.load(addTrack('b2'));
  A.play(); render(8);
  m.mix({ from: 'A', to: 'B', style: 'spinback', at: 'bar' });
  const T0 = A.model.ev.find((e) => e.type === 'curve').t;
  const p0 = A.position(T0);
  render(T0 - A.ctx.currentTime + 0.3);
  assert.ok(A.position() < p0 - 0.2, 'went backwards');
  agree(A);
});

test('perform: loop-roll build (rollup preset) is audio-clock scheduled and slips back onto the grid', async () => {
  const m = await rig(); const A = m.decks.A;
  await A.load(addTrack('r1', { seconds: 180 }));
  A.play(); render(3);
  const steps = [
    { b: 0, d: 'A', c: 'filter', v: 0.65, o: 30, s: 'in' },
    { b: 16, d: 'A', loop: 4 }, { b: 20, d: 'A', loop: 2 }, { b: 24, d: 'A', loop: 1 },
    { b: 24, d: 'A', c: 'low', v: -1, o: 2 },
    { b: 26, d: 'A', loop: 0.5 }, { b: 29, d: 'A', loop: 0.25 },
    { b: 28, d: 'A', c: 'echo', v: 0.5, o: 2 },
    { b: 32, d: 'A', loop: 0 }, { b: 32, d: 'A', c: 'filter', v: 0 }, { b: 32, d: 'A', c: 'low', v: 0 }, { b: 32, d: 'A', c: 'echo', v: 0 },
  ];
  const t = A.ctx.currentTime, beat = 60 / A.effBpm;
  const before = A.position(t + 60); // where the track would be in 60 s without the routine
  const r = m.perform({ steps, at: 'bar', ref: 'A' });
  const t0 = t + r.startsInSec;
  // during the 4-beat loop the playhead stays inside a 4-beat window
  render(t0 + 18 * beat - A.ctx.currentTime); agree(A);
  const lp = A.loop; assert.ok(lp && lp.beats === 4, 'loop 4 active at beat 18');
  near(A.beatAt(lp.start) - Math.round(A.beatAt(lp.start)), 0, 1e-6, 'loop starts on a beat');
  render(t0 + 30 * beat - A.ctx.currentTime); agree(A);
  assert.equal(A.loop.beats, 0.25);
  render(t0 + 34 * beat - A.ctx.currentTime); agree(A);
  assert.equal(A.loop, null, 'loop released');
  near(A.position(t + 60), before, 0.002, 'slip: track is exactly where it would have been');
});

test('sync aligns tempo and bar phase to the most audible other deck (4-deck aware)', async () => {
  const m = await rig(); const A = m.decks.A, C = m.decks.C;
  await A.load(addTrack('s1', { bpm: 128 })); await C.load(addTrack('s2', { bpm: 124 }));
  A.play(); render(1.3);
  C.play(); render(0.7);
  const r = m.sync('C');
  assert.equal(r.master, 'A');
  render(0.5); agree(C);
  near(C.effBpm, 128, 1e-6, 'tempo matched');
  const pa = A.beatAt(A.position()) % 4, pc = C.beatAt(C.position()) % 4;
  near(((pa - pc) % 4 + 4) % 4 < 2 ? ((pa - pc) % 4 + 4) % 4 : ((pa - pc) % 4 + 4) % 4 - 4, 0, 0.005, 'bar phase aligned');
});

test('key lock + key shift + effective camelot', async () => {
  const m = await rig(); const A = m.decks.A;
  await A.load(addTrack('k1', { camelot: '8A' }));
  A.setRate(1.06);
  assert.equal(A.effectiveCamelot(), '8A', 'key lock on: tempo does not change key');
  A.setKeylock(false);
  // +6% = +1.0 semitone -> +7 steps
  assert.equal(A.effectiveCamelot(), '3A');
  A.setKeylock(true); A.setKeyShift(2);
  assert.equal(A.effectiveCamelot(), '10A');
  A.setKeyShift(-9); assert.equal(A.keyShift, -6, 'clamped to -6');
  const st = A.state();
  assert.deepEqual([st.keylock, st.keyShift, st.effectiveCamelot], [true, -6, '2A']);
  flush();
  assert.equal(voiceOf(A).keylock, true); near(voiceOf(A).pitch, Math.pow(2, -0.5), 1e-9, 'worklet got the key shift');
});

test('stems: 4 stems load in lock-step, stem Ctl drives the worklet params, fallback to the mix on failure', async () => {
  const m = await rig(); const A = m.decks.A, B = m.decks.B;
  const t = addTrack('st1', { stems: true });
  await A.load(t); flush();
  assert.equal(A.stemsLoaded, true); assert.equal(voiceOf(A).S, 4);
  assert.ok(server.requests.some((r) => r.startsWith('/audio/st1/stem/vocals?sr=48000')));
  A.stem.vocals.set(0);
  render(0.05);
  near(A.node.parameters.get('vocals').valueAt(A.ctx.currentTime), 0, 1e-6, 'vocals param ramped to 0');
  assert.ok(A.node.parameters.get('vocals').log.some((e) => e.type === 'lin' && e.t - e.t >= 0), 'ramped (no hard step)');
  assert.deepEqual(A.state().stems, { loaded: true, vocals: 0, drums: 1, bass: 1, other: 1 });
  // a failing stem falls back to the full mix
  const t2 = addTrack('st2', { stems: true });
  server.fail.add('/audio/st2/stem/bass');
  await B.load(t2); flush();
  assert.equal(B.stemsLoaded, false); assert.equal(voiceOf(B).S, 1);
  assert.match(B.state().warning, /stems unavailable/);
});

test('perform can automate stems and deck FX amounts (c: vocals / fx)', async () => {
  const m = await rig(); const A = m.decks.A;
  await A.load(addTrack('p1', { stems: true, seconds: 120 }));
  A.play(); render(1);
  assert.throws(() => m.perform({ steps: [{ b: 0, d: 'A', c: 'fx', v: 1 }], ref: 'A' }), /no deck FX/);
  A.fx.set('gate', 0);
  const r = m.perform({ steps: [{ b: 0, d: 'A', c: 'vocals', v: 0, o: 4 }, { b: 0, d: 'A', c: 'fx', v: 1, o: 2 }, { b: 8, d: 'A', c: 'vocals', v: 1 }], at: 'bar', ref: 'A' });
  render(r.startsInSec + 4 * BEAT + 0.1);
  near(A.stem.vocals.value(), 0, 1e-6, 'vocals down');
  near(A.fx.ctl.value(), 1, 1e-6, 'gate amount up');
});

test('crossfader assignment: A+C left, B+D right, thru ignores the fader; same-side mixes use channel faders', async () => {
  const m = await rig(); const { A, B, C, D } = m.decks;
  assert.deepEqual([A.xfSide, B.xfSide, C.xfSide, D.xfSide], ['left', 'right', 'left', 'right']);
  await A.load(addTrack('x1', { seconds: 120 })); await C.load(addTrack('x2', { seconds: 120 }));
  A.play(); render(2); C.play(); render(0.1);
  m.xfader.set(0); render(0.05);
  assert.ok(A.audible() > 0.9 && C.audible() > 0.9);
  m.xfader.set(1); render(0.05);
  assert.ok(A.audible() < 0.01 && C.audible() < 0.01, 'left side muted with fader right');
  C.setXfSide('thru'); render(0.05);
  near(C.xf.gain.valueAt(C.ctx.currentTime), 1, 1e-6, 'thru: full level regardless of fader');
  // mix A -> D would use the crossfader; A -> C (same side / thru) uses channel faders
  m.xfader.set(0); render(0.05);
  C.pause(); render(0.1);
  const r = m.mix({ from: 'A', to: 'C', style: 'fade', bars: 2 });
  assert.equal(r.via, 'channel faders');
  render((m.transition.endAt - Date.now()) / 1000 + 0.3);
  assert.equal(C.playing, true); assert.equal(A.playing, false);
  near(C.vol.value(), 1, 0.01, 'incoming channel fader up');
  // assignment change during a running crossfader automation must not throw (curve re-targeted)
  B.xfSide = 'right'; m.xfader.automate([{ t: m.ctx.currentTime + 0.05, v: 0 }, { t: m.ctx.currentTime + 2, v: 1 }]);
  render(0.2); D.setXfSide('left'); render(0.1);
});

test('deck FX: every type builds, switches click-free (routes crossfade) and ramps', async () => {
  const m = await rig(); const A = m.decks.A;
  await A.load(addTrack('f1'));
  A.play(); render(0.5);
  for (const type of ['reverb', 'flanger', 'phaser', 'gate', 'crush']) {
    A.fx.set(type, 0.7, 0);
    assert.equal(A.fx.type, type);
    const eng = A.fx.units[type].engage.gain.log.at(-1);
    assert.equal(eng.type, 'lin'); assert.ok(eng.t - A.ctx.currentTime >= 0.005, `${type}: engage ramp >= 5 ms`);
    render(0.1);
    near(A.fx.ctl.value(), 0.7, 1e-6, `${type} amount`);
  }
  A.fx.set('reverb', 0.4, 2);
  assert.ok(A.fx.ctl.automating(), 'ramped amount');
  A.fx.set('none'); render(0.1);
  assert.equal(A.fx.ctl, null);
  near(A.fx.bypass.gain.valueAt(A.ctx.currentTime), 1, 1e-6, 'bypass restored');
});

test('scratch pattern: beat-synced rate curve + fader cuts, then back on the grid (slip)', async () => {
  for (const pattern of ['baby', 'chirp', 'transform', 'flare']) {
    const m = await rig(); const A = m.decks.A;
    await A.load(addTrack('sc1', { seconds: 120 }));
    A.play(); render(2.1);
    const T0 = m.quantTime('bar', A);
    const ghost = A.position(T0 + 8 * BEAT + 1);
    const r = A.scratchPattern(pattern, 4, T0);
    near(r.endsAt - r.startsAt, 4 * BEAT, 1e-9, 'lasts 4 beats');
    render(T0 - A.ctx.currentTime + 2 * BEAT); agree(A, 0.003);
    render(r.endsAt - A.ctx.currentTime + 0.2); agree(A);
    near(A.position(T0 + 8 * BEAT + 1), ghost, 0.001, `${pattern}: track resumes exactly on the grid`);
    near(A.cut.gain.valueAt(A.ctx.currentTime), 1, 1e-6, `${pattern}: fader open again`);
  }
});

test('hand scratch: grab / move / release (slip and non-slip) keep model and worklet in agreement', async () => {
  const m = await rig(); const A = m.decks.A;
  await A.load(addTrack('h1', { seconds: 120 }));
  A.play(); render(1);
  const ghost = A.position(A.ctx.currentTime + 3);
  assert.equal(A.grab(), true);
  for (let i = 0; i < 20; i++) { A.handMove(-0.02, -1.2); render(0.016); }
  assert.ok(A.handActive && A.playing, 'scratching; still counts as playing');
  A.release(); render(0.3);
  agree(A);
  near(A.position(A.ctx.currentTime + 3 - 0.3 - 0.32), ghost, 0.01, 'slip: back where the track would have been');
  // non-slip: resumes from where the hand left it
  A.slip = false;
  A.grab();
  for (let i = 0; i < 10; i++) { A.handMove(-0.03, -2); render(0.016); }
  const handPos = A.position();
  A.release(); render(0.4);
  assert.equal(A.awaitHandoff, false, 'handoff received');
  assert.equal(A.playing, true);
  agree(A);
  assert.ok(A.position() < ghost, 'non-slip: continued from the scratched position');
  // hand lag (~vel*16 ms) + motor spin-up from -2x to 1x over 80 ms, then 1x
  near(A.position(), handPos + 0.4 - 0.015 - 0.032 - 0.04 - 0.08, 0.05, 'resumed from the hand position');
});

test('sampler: 6 synthesised pads + 2 empty, quantised triggers, capture a slice via HTTP range', async () => {
  const m = await rig(); const A = m.decks.A;
  assert.deepEqual(m.sampler.state().map((p) => p.name), ['AIR HORN', 'RISER', 'BOOM', 'SIREN', 'LASER', 'HEY!', '—', '—']);
  await A.load(addTrack('sm1', { seconds: 60 }));
  A.play(); render(1.03);
  const tBeat = m.quantTime('beat');
  const b = A.beatAt(A.position(tBeat));
  near(b - Math.round(b), 0, 1e-6, 'beat-quantised');
  const r = m.sampler.trigger(1, tBeat);
  assert.equal(r.name, 'AIR HORN');
  assert.equal(ctxLog.sources.at(-1).started, tBeat);
  m.sampler.trigger(2, m.quantTime('bar')); // riser regenerated for the live tempo (8 beats)
  near(m.sampler.pads[1].buffer.duration, 8 * 60 / A.effBpm, 0.01, 'riser = 8 beats');
  assert.throws(() => m.sampler.trigger(7, 0), /empty/);
  const before = server.requests.length;
  const cap = await m.sampler.capture(7, 'sm1', 'bar:3', 2);
  near(cap.seconds, 2 * 60 / 128, 0.006, '2 beats long');
  assert.ok(server.requests.slice(before).every((u) => u.startsWith('/api/track') || u.startsWith('/audio/sm1')), 'fetched the track');
  assert.equal(m.sampler.pads[6].buffer.length, Math.round(2 * 60 / 128 * SR));
  m.sampler.trigger(7, m.quantTime('now'));
});

test('state(): C/D only reported once loaded; deck state carries the new fields', async () => {
  const m = await rig();
  await m.decks.A.load(addTrack('z1'));
  let s = m.state();
  assert.deepEqual(Object.keys(s.decks), ['A', 'B']);
  await m.decks.D.load(addTrack('z2'));
  s = m.state();
  assert.deepEqual(Object.keys(s.decks), ['A', 'B', 'D']);
  for (const k of ['keylock', 'keyShift', 'effectiveCamelot', 'stems', 'xfAssign', 'fx']) assert.ok(k in s.decks.A, k);
  assert.equal(s.decks.D.xfAssign, 'right');
  assert.equal(s.sampler.length, 8);
  JSON.stringify(s); // serialisable for /api/state
});

test('Ctl invariants: value() is pure, automate() holds the CURRENT value until the automation starts', async () => {
  const p = new MockParam(0);
  const ctx = { currentTime: 0 };
  const c = new Ctl(ctx, 0.2, [{ param: p, fn: (v) => v }], [0, 1]);
  c.automate([{ t: 1, v: 0.2 }, { t: 2, v: 0.8, shape: 'linear' }]);
  const snap = JSON.stringify(c.path);
  for (const t of [0, 1.5, 3, 10]) c.value(t);
  assert.equal(JSON.stringify(c.path), snap, 'sampling never mutates');
  near(c.value(3), 0.8, 1e-12, 'holds end value after the path');
  // re-automate from a later point: the param is held at the current value (0.2) until the new start
  ctx.currentTime = 0.5;
  c.automate([{ t: 1.5, v: 0.2 }, { t: 2.5, v: 0.6 }]);
  const sets = p.log.filter((e) => e.type === 'set' && e.t === 0.5);
  assert.ok(sets.length && sets.every((e) => Math.abs(e.v - 0.2) < 1e-9), 'held current value');
  const curve = p.log.filter((e) => e.type === 'curve').at(-1);
  near(curve.t, 1.5, 1e-9, 'curve starts at the automation start');
});

test('perform: sample + scratch steps; --at drop end-aligns a riser so the boom lands on the drop', async () => {
  const m = await rig(); const A = m.decks.A;
  const t = await A.load(addTrack('pd1', { seconds: 120 })) ?? server.tracks.get('pd1');
  A.play(); render(1);
  const n0 = ctxLog.sources.length;
  m.perform({ steps: [{ b: 0, sample: 2 }, { b: 8, sample: 3 }], at: 'drop', ref: 'A' });
  const [riser, boom] = ctxLog.sources.slice(n0);
  const dropT = m.nextDropTime(A, 0);
  near(boom.started, dropT, 1e-6, 'boom on the drop');
  near(riser.started + riser.buffer.duration, dropT, 0.002, 'riser ends on the drop');
  const r = m.perform({ steps: [{ b: 0, d: 'A', scratch: 'chirp', beats: 2 }, { b: 2, sample: 1 }], at: 'bar', ref: 'A' });
  render(r.startsInSec + 3 * BEAT); agree(A);
});
