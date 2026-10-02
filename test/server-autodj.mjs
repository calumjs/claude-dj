// Auto-DJ safety net: when the live deck runs low and nothing is planned, the server cues the next
// queued track on the idle deck and runs a safe mix itself. A pending planned mix keeps it out.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, startServer, FakeEngine, api, cli, waitUntil, sleep } from './server-harness.mjs';

const sc = scratch('autodj', { port: 4852, config: { autoDJ: { enabled: true, leadSec: 45 } } });
const srv = await startServer(sc);
const eng = new FakeEngine(sc.base);
eng.noAutoFinish = true;
await eng.start();
after(async () => { await eng.stop(); srv.stop(); });

const byId = (id) => sc.lib.tracks.find((t) => t.id === id);
const A = byId('34f249a1');                 // 150 BPM, 6A
const end = (t) => Math.min(t.duration, t.audioEnd ?? t.duration);

test('auto-DJ cues the queued track, then mixes when untilMixOut/remaining runs low', async () => {
  // a queued track at the same tempo with a compatible key → bassswap 8 bars --in drop (if it has a drop)
  const next = sc.lib.tracks.find((t) => t.id !== A.id && Math.abs(t.bpm - 150) < 1 && ['6A', '5A', '7A', '6B'].includes(t.camelot));
  assert.ok(next, 'library has a compatible 150 BPM track');
  await api(sc.base, '/api/queue', { add: [next.id] });
  await eng.loadTrack('A', A, { playing: true, audible: 1, position: end(A) - 120 });
  await sleep(800);
  assert.equal(eng.sent('load').length, 0, 'nothing happens with plenty of time left');
  // time passes: 60 s of audible music left → stage 1 (cue the next track)
  await eng.set('A', { position: end(A) - 60 });
  const load = await waitUntil(() => eng.sent('load')[0], 5000);
  assert.ok(load, 'auto-DJ loaded the next track');
  assert.equal(load.args.deck, 'B');
  assert.equal(load.args.track.id, next.id);
  assert.equal(eng.sent('mix').length, 0, 'no mix yet');
  // 44 s left → stage 2 (mix)
  await eng.set('A', { position: end(A) - 44 });
  const mix = await waitUntil(() => eng.sent('mix')[0], 5000);
  assert.ok(mix, 'auto-DJ fired a mix');
  assert.equal(mix.args.from, 'A'); assert.equal(mix.args.to, 'B');
  assert.equal(mix.args.style, 'bassswap');
  assert.equal(mix.args.bars, 8);
  assert.equal(mix.args.in, next.breakdowns?.length ? 'drop' : 'mixin');
  const log = await api(sc.base, '/api/log?n=60');
  assert.ok(log.some((e) => /^🤖 Auto-DJ: .*bassswap 8 bars/.test(e.text)), 'booth line');
  const st = await cli(sc, ['status']);
  assert.match(st.out, /AUTO\s+auto-DJ on/);
});

test('a pending planned mix keeps the auto-DJ out; key clash → filter; big tempo gap → echo', async () => {
  eng.transition = null;
  await eng.set('B', { playing: false, audible: 0, trackId: null, loaded: false });
  eng.cmds.length = 0;
  await api(sc.base, '/api/plan', { add: { when: { deck: 'A', beforeEnd: 5 }, cmd: 'mix', args: { style: 'echo' } } });
  await eng.loadTrack('A', A, { playing: true, audible: 1, position: end(A) - 40 });
  await sleep(1500);
  assert.equal(eng.sent('mix').length, 0, 'planned mix pending → no auto-DJ');
  await api(sc.base, '/api/plan', { clear: true });

  // unit-level: style choice for clash / tempo gap, through the running server's decision
  const clash = sc.lib.tracks.find((t) => Math.abs(t.bpm - 150) < 3 && t.id !== A.id && !['6A', '5A', '7A', '6B', '4A', '8A', '5B', '7B'].includes(t.camelot));
  const far = sc.lib.tracks.find((t) => t.bpm < 125 && t.bpm > 90);
  assert.ok(clash && far);
  const { Sequencer } = await import('../lib/sequencer.mjs');
  const { Library } = await import('../lib/library.mjs');
  const lib = new Library({ dirs: [], cacheFile: sc.dir + '/.dj/library.json' });
  const seq = new Sequencer({ library: lib, liveState: () => ({}), history: [], addLog() {}, sessionLog() {}, config: {} });
  const s = { decks: { A: { ...A, trackId: A.id, playing: true, rate: 1, effectiveCamelot: A.camelot }, B: { keylock: true } } };
  assert.equal(seq.chooseStyle(s, 'A', clash, 'B').style, 'filter');
  assert.equal(seq.chooseStyle(s, 'A', far, 'B').style, 'echo');

  // with the queue empty the auto-DJ picks the best suggestion itself (excluding played tracks)
  eng.cmds.length = 0;
  await eng.set('A', { position: end(A) - 50 });
  const load = await waitUntil(() => eng.sent('load')[0], 5000);
  assert.ok(load, 'suggestion loaded');
  assert.notEqual(load.args.track.id, A.id);
  const mix = await waitUntil(() => eng.sent('mix')[0], 8000);
  assert.ok(mix, 'mixed into the suggestion');
});

test('dj autodj off stops it', async () => {
  const r = await cli(sc, ['autodj', 'off']);
  assert.match(r.out, /Auto-DJ OFF/);
  const s = await api(sc.base, '/api/state');
  assert.equal(s.autoDJ.enabled, false);
});
