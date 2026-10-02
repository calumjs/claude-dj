// dj export: renders a real flight-recorder session (copied into scratch) to a mix + tracklist + cue sheet,
// including sessions whose engine audio has a gap (lost chunks) or a restarted recorder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scratch, cli, REAL } from './server-harness.mjs';

const sessions = path.join(REAL, '.dj', 'sessions');
const SRC = fs.existsSync(sessions) ? fs.readdirSync(sessions).filter((d) => fs.existsSync(path.join(sessions, d, 'engine-audio.webm')) && fs.existsSync(path.join(sessions, d, 'audio-chunks.jsonl')))
  .sort((a, b) => fs.statSync(path.join(sessions, a, 'engine-audio.webm')).size - fs.statSync(path.join(sessions, b, 'engine-audio.webm')).size)[0] : null;
const sc = scratch('export', { port: 4855 });
const dst = path.join(sc.dir, '.dj', 'sessions');
const copy = (id, as = id) => {
  fs.mkdirSync(path.join(dst, as), { recursive: true });
  for (const f of ['session.json', 'actions.jsonl', 'audio-chunks.jsonl', 'telemetry.jsonl', 'engine-audio.webm']) {
    const p = path.join(sessions, id, f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dst, as, f));
  }
  const info = JSON.parse(fs.readFileSync(path.join(dst, as, 'session.json'), 'utf8'));
  fs.writeFileSync(path.join(dst, as, 'session.json'), JSON.stringify({ ...info, id: as, dir: path.join(dst, as) }));
  return path.join(dst, as);
};
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('export a real session → mp3 + .txt tracklist + .cue', { skip: !SRC && 'no recorded session with engine audio' }, async () => {
  copy(SRC);
  const r = await cli(sc, ['export', SRC]);
  assert.equal(r.code, 0, r.out);
  const out = path.join(sc.dir, '.dj', 'exports');
  const mp3 = path.join(out, SRC + '.mp3');
  assert.ok(fs.existsSync(mp3), r.out);
  const chunks = readJsonl(path.join(dst, SRC, 'audio-chunks.jsonl'));
  const wall = (chunks.at(-1).ts - chunks[0].ts) / 1000;
  assert.ok(Math.abs(dur(mp3) - wall) < 4, `mix ${dur(mp3)} s vs recorded ${wall} s`);
  const txt = fs.readFileSync(path.join(out, SRC + '.txt'), 'utf8');
  assert.match(txt, /^00:00\s+\S/m, txt);
  const cue = fs.readFileSync(path.join(out, SRC + '.cue'), 'utf8');
  assert.match(cue, /FILE ".*\.mp3" MP3/);
  assert.match(cue, /TRACK 01 AUDIO[\s\S]*INDEX 01 00:00:00/);
  // m4a too
  const r2 = await cli(sc, ['export', SRC, '--format', 'm4a']);
  assert.equal(r2.code, 0, r2.out);
  assert.ok(fs.existsSync(path.join(out, SRC + '.m4a')));
});

test('export handles a recorder gap (lost chunks) and a restarted recorder', { skip: !SRC && 'no session' }, async () => {
  // gap: drop 6 chunks from the middle, and the wall clock jumps 6 s there
  const gapId = 'gap-' + SRC;
  const d = copy(SRC, gapId);
  const chunks = readJsonl(path.join(d, 'audio-chunks.jsonl'));
  const buf = fs.readFileSync(path.join(d, 'engine-audio.webm'));
  const k0 = Math.floor(chunks.length / 2), k1 = k0 + 6;
  let off = 0; const starts = chunks.map((c) => { const s = off; off += c.bytes; return s; });
  const cut = Buffer.concat([buf.subarray(0, starts[k0]), buf.subarray(starts[k1])]);
  fs.writeFileSync(path.join(d, 'engine-audio.webm'), cut);
  fs.writeFileSync(path.join(d, 'audio-chunks.jsonl'), chunks.filter((_, i) => i < k0 || i >= k1).map((c) => JSON.stringify(c)).join('\n') + '\n');
  const r = await cli(sc, ['export', gapId]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 recorder gap/);
  const full = dur(path.join(sc.dir, '.dj', 'exports', SRC + '.mp3')), gapped = dur(path.join(sc.dir, '.dj', 'exports', gapId + '.mp3'));
  assert.ok(full - gapped > 3 && full - gapped < 9, `gap removed ${full - gapped} s`);
  assert.match(fs.readFileSync(path.join(sc.dir, '.dj', 'exports', gapId + '.txt'), 'utf8'), /Recorder gaps/);

  // restarted recorder: two WebM files back to back
  const twoId = 'two-' + SRC;
  const d2 = copy(SRC, twoId);
  const w = fs.readFileSync(path.join(d2, 'engine-audio.webm'));
  fs.writeFileSync(path.join(d2, 'engine-audio.webm'), Buffer.concat([w, w]));
  const last = chunks.at(-1).ts;
  fs.appendFileSync(path.join(d2, 'audio-chunks.jsonl'), chunks.map((c) => JSON.stringify({ ...c, ts: c.ts - chunks[0].ts + last + 3000, seq: c.seq + chunks.length })).join('\n') + '\n');
  const r2 = await cli(sc, ['export', twoId, '--json']);
  assert.equal(r2.code, 0, r2.out);
  const j = JSON.parse(r2.out.slice(r2.out.indexOf('{')));
  assert.equal(j.segments, 2);
  assert.ok(Math.abs(j.duration - 2 * full) < 4, `${j.duration} vs ${2 * full}`);
});
