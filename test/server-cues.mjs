// Hot cues / saved loops (set, quantised jump = the right seek), grid correction via the server,
// key-aware + mashup suggestions.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scratch, startServer, FakeEngine, api, cli, waitUntil, sleep } from './server-harness.mjs';

const sc = scratch('cues', {
  port: 4854, config: { autoDJ: { enabled: false } },
  mutateLibrary: (lib) => {
    // pretend stems ran: vocal maps for a few tracks (mashup mode needs vocalPct)
    const set = (id, pct) => { const t = lib.tracks.find((x) => x.id === id); if (t) { t.vocalPct = pct; t.vocalSections = pct ? [{ start: 30, end: 90 }] : []; } };
    set('34f249a1', 0.02); set('e184ddfd', 0.45); set('24e0acc1', 0.05); set('ae1c9e45', 0.6);
  },
});
const srv = await startServer(sc);
const eng = new FakeEngine(sc.base);
eng.noAutoFinish = true;
await eng.start();
after(async () => { await eng.stop(); srv.stop(); });

const T = sc.lib.tracks.find((t) => t.id === '34f249a1');
const bar = 240 / T.bpm, beat = 60 / T.bpm;
const barT = (n) => T.firstBeat + (n - 1) * bar;
const close = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

test('auto hot cues from the analysis', async () => {
  await eng.loadTrack('A', T, { playing: true, audible: 1, position: 10 });
  const r = await api(sc.base, '/api/hotcue', { deck: 'A', action: 'list' });
  const hc = r.result.hotcues;
  assert.equal(hc[1].label, 'start');
  assert.equal(hc[4].label, 'drop');
  assert.ok(close(hc[4].sec, barT(T.breakdowns[0].endBar + 1), 0.02), 'first drop on its bar');
  assert.equal(hc[6].label, 'mix-out');
  const out = await cli(sc, ['hotcue', 'A']);
  assert.match(out.out, /hot cue 4\s+bar\s+\d+\s+[\d:]+\s+drop \(auto\)/);
});

test('hotcue set + jump issues the right quantised seek', async () => {
  let r = await cli(sc, ['hotcue', 'A', 'set', '3', 'bar:17']);
  assert.match(r.out, /✓/);
  const cue = JSON.parse(fs.readFileSync(path.join(sc.dir, '.dj', 'cues.json'), 'utf8'))[T.id].hotcues[3];
  assert.ok(close(cue.sec, barT(17)), `${cue.sec} vs ${barT(17)}`);
  assert.equal(cue.bar, 17);
  // playing: a perform anchored on A's next bar with a seek step
  r = await cli(sc, ['hotcue', 'A', '3']);
  const p = eng.sent('perform').at(-1);
  assert.equal(p.args.at, 'bar'); assert.equal(p.args.ref, 'A');
  assert.equal(p.args.steps.length, 1);
  assert.equal(p.args.steps[0].d, 'A'); assert.equal(p.args.steps[0].b, 0);
  assert.ok(close(p.args.steps[0].seek, barT(17)));
  // a cue on beat 3 of its bar jumps 2 beats after the bar line (keeps the bar phase)
  const sec = barT(20) + 2 * beat + 0.012; // slightly off: gets snapped to the beat
  await cli(sc, ['hotcue', 'A', 'set', '7', String(sec)]);
  await cli(sc, ['hotcue', 'A', '7']);
  const p2 = eng.sent('perform').at(-1);
  assert.equal(p2.args.steps[0].b, 2);
  assert.ok(close(p2.args.steps[0].seek, barT(20) + 2 * beat, 0.002));
  // paused: a plain seek
  await eng.set('A', { playing: false });
  await cli(sc, ['hotcue', 'A', '3']);
  const s = eng.sent('seek').at(-1);
  assert.equal(s.args.deck, 'A');
  assert.ok(close(Number(s.args.position), barT(17)));
});

test('saved loop set + recall = seek + loop', async () => {
  await eng.set('A', { playing: true });
  let r = await cli(sc, ['savedloop', 'A', 'set', 'build', '4', '--at', 'bar:33']);
  assert.match(r.out, /✓/);
  r = await cli(sc, ['savedloop', 'A']);
  assert.match(r.out, /"build"\s+4 beats from bar 33/);
  await cli(sc, ['savedloop', 'A', 'build']);
  const p = eng.sent('perform').at(-1);
  assert.deepEqual(p.args.steps.map((x) => Object.keys(x).sort().join(',')), ['b,d,seek', 'b,d,loop,slip']);
  assert.ok(close(p.args.steps[0].seek, barT(33)));
  assert.equal(p.args.steps[1].loop, 4);
  // paused: seek then loop
  await eng.set('A', { playing: false });
  await cli(sc, ['savedloop', 'A', 'build']);
  assert.ok(close(Number(eng.sent('seek').at(-1).args.position), barT(33)));
  assert.equal(Number(eng.sent('loop').at(-1).args.beats), 4);
});

test('load sends hot cues with the track', async () => {
  await cli(sc, ['load', 'B', 'e184ddfd']);
  const l = eng.sent('load').at(-1);
  assert.ok(l.args.track.hotcues && l.args.track.hotcues[1], 'hotcues in the load payload');
});

test('grid correction via the server: shift/nudge/bpm persist and re-derive structure; reset restores', async () => {
  const id = '34f249a1';
  const before = await api(sc.base, '/api/track/' + id);
  let r = await cli(sc, ['grid', id, '--shift', '1']);
  assert.match(r.out, /✓/);
  let t = await api(sc.base, '/api/track/' + id);
  assert.ok(close(t.firstBeat, before.firstBeat + 60 / before.bpm, 0.002), `${before.firstBeat} → ${t.firstBeat}`);
  assert.ok(t.beatMap && typeof t.gridStable === 'boolean' && Array.isArray(t.sections), 'beat map + sections recomputed');
  assert.ok(close(t.mixIn, t.firstBeat, 0.01));
  for (const b of t.breakdowns) assert.ok(close((b.start - t.firstBeat) / (240 / t.bpm), b.startBar, 0.01), 'breakdowns on the new grid');
  r = await cli(sc, ['grid', id, '--nudge', '-10', '--bpm', '150.2']);
  t = await api(sc.base, '/api/track/' + id);
  assert.equal(t.bpm, 150.2);
  assert.deepEqual(t.gridEdit, { shiftBeats: 1, nudgeMs: -10, bpm: 150.2 });
  const edits = JSON.parse(fs.readFileSync(path.join(sc.dir, '.dj', 'grid-edits.json'), 'utf8'));
  assert.deepEqual(edits[id].edit, { shiftBeats: 1, nudgeMs: -10, bpm: 150.2 });
  const lib = JSON.parse(fs.readFileSync(path.join(sc.dir, '.dj', 'library.json'), 'utf8'));
  assert.equal(lib.tracks.find((x) => x.id === id).bpm, 150.2, 'saved to the (scratch) library cache');
  await cli(sc, ['grid', id, '--reset']);
  t = await api(sc.base, '/api/track/' + id);
  assert.equal(t.bpm, before.bpm);
  assert.ok(close(t.firstBeat, before.firstBeat, 0.0002));
  r = await cli(sc, ['sections', id]);
  assert.match(r.out, /(drop|breakdown|verse)\s+bar/);
});

test('key-aware suggest recommends a key shift; mashup mode pairs vocals over beds', async () => {
  const { Library } = await import('../lib/library.mjs');
  const lib = new Library({ dirs: [], cacheFile: path.join(sc.dir, '.dj', 'library.json') });
  // 8A at 140 BPM played at 150: +1.19 st → +1 st → 3A: clash with 8A; a −1 st key shift fixes it
  const k = lib.keyPlan('8A', { bpm: 140, camelot: '8A' }, 150, false);
  assert.equal(k.effectiveKey, '3A'); assert.equal(k.kd0, 3); assert.equal(k.shift, -1); assert.equal(k.shiftedKey, '8A');
  // with keylock the tempo doesn't move the key
  assert.equal(lib.keyPlan('8A', { bpm: 140, camelot: '8A' }, 150, true).effectiveKey, '8A');
  const r = await cli(sc, ['suggest', '--from', '34f249a1', '--limit', '3']);
  assert.match(r.out, /plays as \d+[AB]/);
  const m = await api(sc.base, '/api/suggest?mashup=1');
  assert.ok(m.length > 0, 'mashup pairs');
  for (const p of m) { assert.ok(p.vocal.vocalPct >= 0.25 && p.bed.vocalPct <= 0.08); assert.ok('effectiveKey' in p && 'recommendedKeyShift' in p); }
  const mc = await cli(sc, ['suggest', '--mashup']);
  assert.match(mc.out, /VOCAL .* over\s+BED/);
});
