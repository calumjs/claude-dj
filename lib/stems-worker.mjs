#!/usr/bin/env node
// Standalone stem separation for the whole library, without the server:
//   node lib/stems-worker.mjs
// Reads .dj/library.json READ-ONLY (never writes it) and fills .dj/stems/<id>/.
// Vocal maps are computed by the server when it next starts (cheap, from the vocals stem).
// Exits by itself when a server with stem support is up (it takes over the queue).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { StemQueue } from './stems.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const cfg = { threads: 2, concurrency: 2, model: 'htdemucs', minFreeGB: 3, ...(config.stems || {}) };
const PORT = Number(process.env.DJ_PORT || config.port || 4747);
try { os.setPriority(process.pid, 19); } catch { /* best effort */ }

const saved = JSON.parse(fs.readFileSync(path.join(ROOT, '.dj', 'library.json'), 'utf8'));
const library = { tracks: new Map(saved.tracks.map((t) => [t.id, t])), save() {} };
const logLine = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const q = new StemQueue({
  root: ROOT, library, stemsDir: path.join(ROOT, '.dj', 'stems'),
  python: cfg.python ? path.resolve(ROOT, cfg.python) : undefined,
  threads: cfg.threads, concurrency: cfg.concurrency, model: cfg.model, minFreeGB: cfg.minFreeGB,
  log: logLine,
  onEvent: (ev) => { if (ev.status !== 'separating') logLine(`${ev.id} ${ev.status}${ev.error ? ': ' + ev.error : ''}`); },
});
q.mapVocals = async () => {}; // server does this; we must not touch library.json
if (!q.available) { logLine('no separator available (.venv python + lib/separate.py)'); process.exit(1); }
const r = q.enqueueAll();
logLine(`queued ${r.queued}, already done ${r.ready}, total ${r.total}`);

const iv = setInterval(async () => {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/stems`);
    if (res.ok && (await res.json()).available !== undefined) {
      logLine('server with stem support is up: handing over and exiting');
      q.queue.length = 0; q.stop();
      setTimeout(() => process.exit(0), 3000);
    }
  } catch { /* server down or old version */ }
  if (!q.running && !q.queue.length) { logLine('all done'); clearInterval(iv); process.exit(0); }
}, 10000);
