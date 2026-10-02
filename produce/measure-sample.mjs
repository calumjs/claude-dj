// Find the usable bits of a short sample: node produce/measure-sample.mjs <file|libraryId> [--thresh -35] [--min 0.15]
// Prints non-silent segments as `from dur` seconds, ready for `dj keys` grabs or a sampler pad.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const a = process.argv.slice(2); const q = a[0]; if (!q) { console.log('usage: measure-sample <file|libraryId>'); process.exit(1); }
const ti = a.indexOf('--thresh'); const thresh = ti > 0 ? a[ti + 1] : '-35'; const mi = a.indexOf('--min'); const min = mi > 0 ? Number(a[mi + 1]) : 0.15;
let file = q;
if (!fs.existsSync(q)) {
  const LIB = JSON.parse(fs.readFileSync('.dj/library.json', 'utf8')).tracks;
  const t = Object.values(LIB).find((t) => t.id === q || String(t.file).includes(q) || String(t.title).toLowerCase().includes(q.toLowerCase()));
  if (!t) { console.log('not found:', q); process.exit(1); }
  file = t.file; console.log(`${t.id}  ${t.artist || ''} - ${t.title}  ${t.duration?.toFixed(2)}s`);
}
const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', `silencedetect=noise=${thresh}dB:d=${min}`, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
const log = (r.stderr || '') + (r.stdout || '');
const dur = +(log.match(/Duration: (\d+):(\d+):(\d+\.\d+)/) || []).slice(1).reduce((acc, v, i) => acc + Number(v) * [3600, 60, 1][i], 0);
const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]); const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
const segs = []; let cur = 0;
for (let i = 0; i < Math.max(starts.length, ends.length); i++) { const s = starts[i], e = ends[i]; if (s != null && s > cur + 0.05) segs.push([cur, s]); cur = e ?? cur; }
if (dur && dur > cur + 0.05) segs.push([cur, dur]);
console.log(`duration ${dur.toFixed(2)}s; non-silent segments (threshold ${thresh} dB):`);
for (const [s, e] of segs) console.log(`  from ${s.toFixed(2)}  dur ${(e - s).toFixed(2)}`);
if (!segs.length) console.log('  (none found; try --thresh -45)');
