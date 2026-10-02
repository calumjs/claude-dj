// Parallel stem separation: N concurrent jobs at full speed; while music plays, 1 job × 2 threads
// (running jobs finish, nothing is killed); full speed again after the quiet period.
// Uses a fake separator (a node script standing in for .venv python + lib/separate.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StemQueue } from '../lib/stems.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('stem queue: concurrency, throttle while music plays, resume after quiet', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djstems-'));
  fs.mkdirSync(path.join(root, 'lib'));
  // fake separator: argv = [script, input, outDir, threads, model]; writes 4 stems after ~600 ms
  fs.writeFileSync(path.join(root, 'lib', 'separate.py'), `
const fs = require('fs'), path = require('path');
const [, , input, out, threads] = process.argv;
fs.appendFileSync(path.join(${JSON.stringify(root)}, 'runs.log'), JSON.stringify({ input, threads: Number(threads), start: Date.now() }) + '\\n');
let p = 0; const iv = setInterval(() => { p += 0.25; console.log('PROGRESS ' + p); if (p >= 1) { clearInterval(iv);
  for (const s of ['vocals', 'drums', 'bass', 'other']) fs.writeFileSync(path.join(out, s + '.wav'), 'x');
  fs.appendFileSync(path.join(${JSON.stringify(root)}, 'runs.log'), JSON.stringify({ input, end: Date.now() }) + '\\n'); } }, 150);
`);
  const tracks = new Map();
  for (let i = 0; i < 6; i++) tracks.set(`t${i}`, { id: `t${i}`, file: `in${i}.wav`, title: `T${i}`, bpm: 128, duration: 100 + i, size: 1, mtimeMs: 1 });
  const q = new StemQueue({ root, library: { tracks, save() {} }, stemsDir: path.join(root, 'stems'), python: process.execPath, threads: 4, concurrency: 3, minFreeGB: 0 });
  q.mapVocals = async () => ({});
  q.quietSec = 1;
  const peak = { full: 0, throttled: 0 }, threadsSeen = { full: new Set(), throttled: new Set() };
  const sample = setInterval(() => { const m = q.mode(); peak[m] = Math.max(peak[m], q.jobs.size); for (const j of q.jobs.values()) threadsSeen[m].add(j.threads); }, 20);
  // full speed: 3 at once, 4 threads each
  for (const id of ['t0', 't1', 't2']) q.enqueue(id);
  await sleep(250);
  assert.equal(q.jobs.size, 3);
  assert.equal(q.status().mode, 'full');
  // music starts: running jobs keep going (not killed), queued work drops to 1 × 2 threads
  q.setMusicPlaying(true);
  for (const id of ['t3', 't4']) q.enqueue(id);
  assert.equal(q.status().mode, 'throttled');
  assert.equal(q.status().maxJobs, 1);
  assert.equal(q.jobs.size, 3, 'running jobs were not killed');
  for (let i = 0; i < 60 && (q.jobs.size || q.queue.length) && q.isDone('t3') === false; i++) { q.setMusicPlaying(true); await sleep(100); }
  assert.ok(['t0', 't1', 't2'].every((id) => q.isDone(id)), 'the first three finished');
  // music stops: after quietSec, back to full concurrency
  q.enqueue('t5');
  await sleep(1300);
  q.setMusicPlaying(false);
  for (let i = 0; i < 60 && (q.jobs.size || q.queue.length); i++) await sleep(100);
  clearInterval(sample);
  assert.ok(['t3', 't4', 't5'].every((id) => q.isDone(id)), 'all done');
  const runs = fs.readFileSync(path.join(root, 'runs.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const started = Object.fromEntries(runs.filter((r) => r.threads).map((r) => [r.input, r.threads]));
  assert.equal(started['in0.wav'], 4); assert.equal(started['in3.wav'], 2, 'throttled job ran with 2 threads');
  assert.ok(threadsSeen.throttled.has(2));
  // while throttled, never more than 1 job was started on top of the ones already running
  const t3 = runs.find((r) => r.input === 'in3.wav' && r.start), t4 = runs.find((r) => r.input === 'in4.wav' && r.start), e3 = runs.find((r) => r.input === 'in3.wav' && r.end);
  assert.ok(t4.start >= e3.end - 5 || t4.start > t3.start + 400, 't3 and t4 did not overlap while throttled');
  assert.equal(q.status().mode, 'full');
  fs.rmSync(root, { recursive: true, force: true });
});
