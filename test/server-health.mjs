// /api/health: per-system status, and the engine summary the header LED follows.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, startServer, FakeEngine, api, waitUntil } from './server-harness.mjs';

// no library folders: the library is empty whatever the real cache holds
const sc = scratch('health', { port: 4856, config: { autoDJ: { enabled: false }, libraryDirs: [] } });
const srv = await startServer(sc);
const eng = new FakeEngine(sc.base);
after(async () => { await eng.stop(); srv.stop(); });

const sys = (h, id) => h.systems.find((s) => s.id === id);

test('engine is red until a tab claims it', async () => {
  const h = await api(sc.base, '/api/health');
  assert.deepEqual(h.engine, { ok: false, text: 'engine offline' });
  assert.equal(h.ok, false);
  assert.equal(sys(h, 'server').ok, true);
  assert.equal(sys(h, 'engine-tab').ok, false);
  assert.equal(sys(h, 'library').ok, false);
  assert.equal(sys(h, 'library').detail, '0 tracks');
  assert.equal(sys(h, 'stems').detail, 'disabled in config');
  for (const s of h.systems) assert.equal(typeof s.ok, 'boolean', s.id);
});

test('engine goes green once it is connected and pushing state', async () => {
  await eng.start();
  const h = await api(sc.base, '/api/health');
  assert.deepEqual(h.engine, { ok: true, text: 'engine live' });
  for (const id of ['engine-tab', 'engine-audio', 'engine-heartbeat']) assert.equal(sys(h, id).ok, true, id);
});

test('engine goes red again when the tab disconnects', async () => {
  await eng.stop();
  const h = await waitUntil(async () => { const x = await api(sc.base, '/api/health'); return x.engine.ok ? null : x; });
  assert.equal(h.engine.text, 'engine offline');
});
