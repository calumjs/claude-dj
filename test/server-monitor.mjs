// Mix monitor ("ears"): simulated vocal clash, key clash, 30 ms flam and clipping are flagged;
// a transition gets a machine critique (booth + memory); dj rate / memory / suggest use it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scratch, startServer, FakeEngine, api, cli, waitUntil, sleep } from './server-harness.mjs';

const VOX = ['34f249a1', 'e184ddfd'];
const sc = scratch('monitor', {
  port: 4853, config: { autoDJ: { enabled: false } },
  mutateLibrary: (lib) => { for (const t of lib.tracks) if (VOX.includes(t.id)) { t.vocalSections = [{ start: 20, end: 120, startBar: 13, endBar: 75 }]; t.vocalPct = 0.5; } },
});
const srv = await startServer(sc);
const eng = new FakeEngine(sc.base);
eng.noAutoFinish = true;
await eng.start();
after(async () => { await eng.stop(); srv.stop(); });

const T = sc.lib.tracks.find((t) => t.id === VOX[0]), U = sc.lib.tracks.find((t) => t.id === VOX[1]);
const posOfBeat = (t, b) => t.firstBeat + (b * 60) / t.bpm;
const warnings = async () => (await api(sc.base, '/api/monitor')).warnings.map((w) => w.type);

test('30 ms flam is measured and flagged', async () => {
  const p = posOfBeat(T, 100.25);
  await eng.setMany({ A: { ...eng.trackFields(T), playing: true, audible: 1, position: p }, B: { ...eng.trackFields(T), playing: true, audible: 1, position: p - 0.030 } });
  const m = await waitUntil(async () => { const x = await api(sc.base, '/api/monitor'); return x.checks?.phase ? x : null; }, 3000);
  assert.ok(m, 'phase checked');
  assert.ok(Math.abs(m.checks.phase.offsetMs - 30) < 3, `offset ${m.checks.phase.offsetMs}`);
  assert.ok(m.warnings.some((w) => w.type === 'flam' && /B is 30 ms behind A/.test(w.msg)));
  // in phase → no flam
  await eng.setMany({ A: { position: p }, B: { position: p } });
  await sleep(600);
  assert.ok(!(await warnings()).includes('flam'));
});

test('vocal clash respects stem gains and mid EQ', async () => {
  await eng.set('A', { position: 40 });
  await eng.set('B', { position: 40 + (((posOfBeat(T, 0) - 40) % (60 / T.bpm)) + 60 / T.bpm) % (60 / T.bpm) * 0 });
  await sleep(600);
  assert.ok((await warnings()).includes('vocal-clash'), 'both in vocal sections, vocals up');
  await eng.set('B', { stems: { loaded: true, vocals: 0, drums: 1, bass: 1, other: 1 } });
  await sleep(600);
  assert.ok(!(await warnings()).includes('vocal-clash'), 'vocals stem muted on B');
  await eng.set('B', { stems: { loaded: false, vocals: 1, drums: 1, bass: 1, other: 1 }, eq: { low: 0, mid: -0.8, high: 0 } });
  await sleep(600);
  assert.ok(!(await warnings()).includes('vocal-clash'), 'mid EQ ≤ −0.7 removes vocals');
  await eng.set('B', { eq: { low: 0, mid: 0, high: 0 } });
  await eng.set('A', { position: 150 }); // A out of its vocal section
  await sleep(600);
  assert.ok(!(await warnings()).includes('vocal-clash'));
});

test('key clash uses effective keys and needs harmonic content up on both', async () => {
  await eng.set('A', { position: 150, effectiveCamelot: '6A' });
  await eng.set('B', { position: 150, effectiveCamelot: '12B' });
  await sleep(600);
  assert.ok((await warnings()).includes('key-clash'));
  // no effectiveCamelot: camelot shifted by rate (keylock off): 6A at +12% ≈ +2 st → 8A, vs 7A neighbour
  await eng.set('A', { effectiveCamelot: null, camelot: '6A', keylock: false, rate: 1.122 });
  await eng.set('B', { effectiveCamelot: null, camelot: '7A', keylock: false, rate: 1 });
  await sleep(600);
  const m = await api(sc.base, '/api/monitor');
  assert.equal(m.checks.key.a, '8A');
  assert.ok(!m.warnings.some((w) => w.type === 'key-clash'), '8A/7A are neighbours');
  await eng.set('A', { rate: 1, keylock: true, effectiveCamelot: '6A' });
  await eng.set('B', { effectiveCamelot: '12B', eq: { low: -1, mid: -1, high: 0 } });
  await sleep(600);
  assert.ok(!(await warnings()).includes('key-clash'), 'B has bass + mids killed');
  await eng.set('B', { effectiveCamelot: T.camelot, eq: { low: 0, mid: 0, high: 0 } });
});

test('clipping + warnings in dj status', async () => {
  eng.extraMaster = { peakDb: -0.1 };
  await eng.setMany({ A: { position: posOfBeat(T, 400) }, B: { position: posOfBeat(T, 400) - 0.03 } });
  await sleep(700);
  const r = await cli(sc, ['status']);
  assert.match(r.out, /⚠ master clipping/);
  assert.match(r.out, /⚠ flamming: B is 30 ms behind A/);
  const mon = await cli(sc, ['monitor']);
  assert.match(mon.out, /phase A\/B: 30(\.\d)? ms/);
  eng.extraMaster = {};
});

test('transition critique → booth log, memory; dj rate + memory + suggest use it', async () => {
  // A (T) → B (U), 30 ms out during the transition
  const p = posOfBeat(T, 200);
  await eng.setMany({ A: { position: p }, B: { ...eng.trackFields(U), playing: true, audible: 1, position: posOfBeat(U, 40) - 0.03 } });
  const now = Date.now();
  eng.transition = { id: 'tr1', from: 'A', to: 'B', style: 'bassswap', bars: 8, startAt: now - 50, endAt: now + 1500 };
  await eng.push();
  await sleep(2200);
  eng.transition = null;
  await eng.set('A', { playing: false, audible: 0 });
  const log = await waitUntil(async () => (await api(sc.base, '/api/log?n=80')).find((e) => /^🧐 Critique A→B bassswap/.test(e.text)), 3000);
  assert.ok(log, 'critique in booth log');
  assert.match(log.text, /flam/);
  const mem = JSON.parse(fs.readFileSync(path.join(sc.dir, '.dj', 'memory.json'), 'utf8'));
  const e = mem.transitions.at(-1);
  assert.equal(e.from.id, T.id); assert.equal(e.to.id, U.id);
  assert.ok(e.warnings.includes('flam'));
  const r = await cli(sc, ['rate', 'good', 'drop landed']);
  assert.match(r.out, /rated transition .* good/);
  const m = await cli(sc, ['memory']);
  assert.match(m.out, /TOP pairings/);
  assert.match(m.out, /👍1/);
  await eng.set('B', { playing: false, trackId: null, loaded: false });
  // U has been on air, so suggest excludes it now; check the scorer the server passes to suggest
  const { Memory } = await import('../lib/memory.mjs');
  const adj = new Memory(path.join(sc.dir, '.dj', 'memory.json')).adjust(T, U);
  assert.ok(adj.delta < 0 && adj.reasons.some((x) => /rated good/.test(x)), JSON.stringify(adj));
  const { Library } = await import('../lib/library.mjs');
  const lib = new Library({ dirs: [], cacheFile: path.join(sc.dir, '.dj', 'library.json') });
  const u = lib.suggest({ from: T.id, limit: 50, memory: new Memory(path.join(sc.dir, '.dj', 'memory.json')) }).find((x) => x.id === U.id);
  assert.ok(u.reasons.some((x) => /memory: this pair rated good/.test(x)), u.reasons.join('; '));
  const sug = await api(sc.base, `/api/suggest?from=${T.id}&limit=5`);
  assert.ok(sug.length && sug.every((x) => 'effectiveKey' in x && 'recommendedKeyShift' in x));
});
