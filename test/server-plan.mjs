// Timeline sequencer: plan steps fire ~1 bar early through the normal command path and land on the right bar.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, startServer, FakeEngine, api, cli, waitUntil, sleep } from './server-harness.mjs';

const sc = scratch('plan', { port: 4851, config: { autoDJ: { enabled: false, leadSec: 45 } } });
const srv = await startServer(sc);
const eng = new FakeEngine(sc.base);
await eng.start();
after(async () => { await eng.stop(); srv.stop(); });

const T = sc.lib.tracks.find((t) => t.id === '34f249a1'); // 150 BPM, stable grid
const U = sc.lib.tracks.find((t) => t.id === 'e184ddfd');
const barT = (t, n) => t.firstBeat + (n - 1) * (240 / t.bpm);

test('plan step {deck, bar} fires one bar early and the mix lands on that bar', async () => {
  await eng.loadTrack('A', T, { playing: true, audible: 1, position: barT(T, 10) - 3.2 });
  await eng.loadTrack('B', U);
  const r = await cli(sc, ['plan', 'add', JSON.stringify([
    { when: { deck: 'A', bar: 10 }, cmd: 'mix', args: { to: 'B', style: 'bassswap', bars: 8 }, why: 'test mix on bar 10' },
    { when: { after: 'p1', sec: 1 }, cmd: 'eq', args: { deck: 'B', band: 'low', value: -1 } },
  ])]);
  assert.match(r.out, /planned p1, p2/);
  const show = await cli(sc, ['plan', 'show']);
  assert.match(show.out, /p1\s+pending\s+A bar 10/);
  const mix = await waitUntil(() => eng.sent('mix')[0], 8000);
  assert.ok(mix, 'mix was sent');
  const posAtSend = mix.state.decks.A.position;
  // sent during bar 9 (at most ~0.9 bar early, at least 0.2 s before bar 10)
  assert.ok(posAtSend >= barT(T, 9) && posAtSend <= barT(T, 10) - 0.15, `sent at ${posAtSend}, bar 10 at ${barT(T, 10)}`);
  assert.equal(mix.args.at, 'bar', 'bar-targeted step anchors on the bar');
  assert.equal(mix.args.from, 'A'); assert.equal(mix.args.to, 'B');
  assert.equal(mix.result.beat, 36, 'lands on beat 36 = bar 10');
  // the dependent knob step becomes an exactly-anchored one-step perform
  const perf = await waitUntil(() => eng.sent('perform')[0], 8000);
  assert.ok(perf, 'after-step fired');
  assert.deepEqual(perf.args.steps, [{ b: 0, d: 'B', c: 'low', v: -1, o: 0 }]);
  const plan = await api(sc.base, '/api/plan');
  assert.equal(plan.find((s) => s.id === 'p1').status, 'fired');
  assert.equal(plan.find((s) => s.id === 'p2').status, 'fired');
  const log = await api(sc.base, '/api/log?n=50');
  assert.ok(log.some((e) => /📋 Plan p1 fired: mix/.test(e.text)), 'booth log line');
  assert.ok(log.some((e) => e.kind === 'claude' && /📋 p1: test mix on bar 10/.test(e.text)), 'why shown in booth');
});

test('beforeMixout step defaults to phrase anchoring; fx resolves presets server-side; queue feeds track "next"', async () => {
  eng.transition = null;
  await eng.set('B', { playing: false, audible: 0 });
  await eng.loadTrack('A', T, { playing: true, audible: 1, position: T.mixOut - 20 - 2.5 });
  await api(sc.base, '/api/queue', { add: [U.id] });
  let r = await api(sc.base, '/api/plan', { add: { when: { deck: 'A', beforeMixout: 20 }, cmd: 'mix', args: { track: 'next', style: 'filter' } } });
  assert.ok(r.ok, r.error);
  r = await api(sc.base, '/api/plan', { add: { when: { at: Date.now() + 500 }, cmd: 'fx', args: { name: 'sweep', deck: 'A' } } });
  assert.ok(r.ok, r.error);
  const n0 = eng.sent('mix').length;
  const mix = await waitUntil(() => eng.sent('mix')[n0], 8000);
  assert.ok(mix, 'mix fired');
  assert.equal(mix.args.at, 'phrase');
  assert.equal(mix.args.track.id, U.id, 'queue track resolved at fire time');
  const q = await api(sc.base, '/api/queue');
  assert.equal(q.length, 0, 'queue consumed');
  const fx = eng.sent('perform').find((c) => c.args.steps.length === 2 && c.args.steps[0].c === 'filter');
  assert.ok(fx, 'fx sweep sent as perform');
  assert.equal(fx.args.at, 'phrase');
  const st = await api(sc.base, '/api/state');
  assert.equal(st.plan.pending, 0);
});

test('plan validation and clear', async () => {
  const bad = await api(sc.base, '/api/plan', { add: { when: { deck: 'A' }, cmd: 'mix' } });
  assert.equal(bad.ok, false);
  await api(sc.base, '/api/plan', { add: { when: { deck: 'A', bar: 999 }, cmd: 'mix' } });
  const r = await cli(sc, ['plan', 'clear']);
  assert.match(r.out, /removed 1 step/);
});
