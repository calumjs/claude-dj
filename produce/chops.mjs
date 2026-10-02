// Chop bank: split a spoken line into syllable/word chunks by onset detection on the real audio (vocal stem if the clip
// has one, else the mix). Caption timings are only ±0.15 s; this finds the true first syllable and every syllable start.
//   import { chop } from './chops.mjs'; const c = await chop(clipId, from, dur)  →  { start, end, chunks: [{ from, dur }] }
//   node produce/chops.mjs <clipId> <from> <dur>     (prints the chunks)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const LIB = JSON.parse(fs.readFileSync(path.join(ROOT, '.dj/library.json'), 'utf8')).tracks;
const tr = (id) => LIB[id] || Object.values(LIB).find((t) => t.id === id);
const SR = 16000, HOP = 0.005;

function decode(file, from, dur) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, from)), '-t', String(dur), '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'], { windowsHide: true, maxBuffer: 1 << 26 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
export async function chop(id, from, dur) {
  const t = tr(id); if (!t) throw new Error(`clip ${id} not in library`);
  const stem = path.join(ROOT, '.dj/stems', id, 'vocals.wav');
  const file = fs.existsSync(stem) ? stem : t.file;
  const pre = 0.25, x = decode(file, from - pre, dur + pre + 0.25);
  const n = Math.floor(x.length / (HOP * SR)), env = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; const a = Math.floor(i * HOP * SR), b = a + Math.floor(0.02 * SR); for (let j = a; j < Math.min(b, x.length); j++) s += x[j] * x[j]; env[i] = 10 * Math.log10(s / (b - a) + 1e-10); }
  const peak = Math.max(...env), floor = peak - 32;
  // onsets: level above floor and a rise of ≥ 7 dB over the previous 40 ms minimum; ≥ 90 ms apart
  const on = [];
  for (let i = 8; i < n; i++) {
    let mn = Infinity; for (let k = i - 8; k < i; k++) mn = Math.min(mn, env[k]);
    if (env[i] > floor + 6 && env[i] - mn > 7 && (!on.length || i - on[on.length - 1] > 0.09 / HOP)) on.push(i);
  }
  // keep onsets inside the caption window (allow 0.2 s early)
  const t0 = (i) => from - pre + i * HOP;
  const kept = on.filter((i) => t0(i) >= from - 0.2 && t0(i) <= from + dur);
  if (!kept.length) return { start: from, end: from + dur, chunks: [{ from, dur }] };
  // end of speech: last frame above floor+3 after the last onset
  let last = n - 1; while (last > kept[kept.length - 1] && env[last] < floor + 3) last--;
  const start = t0(kept[0]) - 0.012, end = Math.min(from + dur + 0.15, t0(last) + 0.04);
  const chunks = kept.map((i, k) => { const a = t0(i) - 0.012, b = k + 1 < kept.length ? t0(kept[k + 1]) - 0.012 : end; return { from: +a.toFixed(3), dur: +(b - a).toFixed(3) }; });
  return { start: +start.toFixed(3), end: +end.toFixed(3), chunks };
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [id, from, dur] = process.argv.slice(2);
  const c = await chop(id, Number(from), Number(dur));
  console.log(`start ${c.start} end ${c.end} (${(c.end - c.start).toFixed(2)} s)  ${c.chunks.length} chunks:`, c.chunks.map((k) => `${k.from}+${k.dur}`).join('  '));
}
