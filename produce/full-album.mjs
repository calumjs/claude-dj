// Full-album video + audio from the per-track cuts: one continuous master of the session slice (no per-track fades) under
// the track videos joined with their hand-off overlaps trimmed.
//   node produce/full-album.mjs --album "Album Name" [--artist "DJ Claude"]      (after cut-track.mjs … --video for every track)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2); const flag = (n, d = null) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const ALBUM = flag('--album'); if (!ALBUM) { console.log('usage: full-album.mjs --album "Album Name" [--artist name]'); process.exit(1); }
const ARTIST = flag('--artist', 'DJ Claude'); const DIR = '.dj/exports/album', OUT = `${DIR}/${ALBUM} - Full Album`;
const metas = fs.readdirSync('.dj/produce/out/album').filter((f) => /^t\d\d\.json$/.test(f)).sort().map((f) => ({ n: Number(f.slice(1, 3)), ...JSON.parse(fs.readFileSync(path.join('.dj/produce/out/album', f), 'utf8')) }));
if (!metas.length) { console.log('no .dj/produce/out/album/tNN.json yet (run cut-track first)'); process.exit(1); }
const vid = (m) => { const f = fs.readdirSync(DIR).find((x) => x.startsWith(`${ALBUM} - ${String(m.n).padStart(2, '0')} - `) && x.endsWith('.mp4') && !x.includes('(480p)')); return f ? path.join(DIR, f) : null; };
const dur = (f) => +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim();
const segs = []; let prevEnd = null;
for (const m of metas) { const f = vid(m); if (!f) { console.log(`missing video for track ${m.n}`); process.exit(1); } const d = dur(f); if (!d) { console.log(`unreadable video for track ${m.n}`); process.exit(1); } const ss = prevEnd == null ? 0 : Math.max(0, prevEnd - m.start); segs.push({ f, ss: +ss.toFixed(3), t: +(d - ss).toFixed(3) }); prevEnd = m.start + d; }
const total = segs.reduce((a, s) => a + s.t, 0); const session = metas[0].session, start0 = metas[0].start;
console.log(segs.map((s) => `${path.basename(s.f).slice(0, 40)} ss ${s.ss} t ${s.t}`).join('\n'), `\ntotal ${(total / 60).toFixed(1)} min`);
const ff = (a) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...a], { stdio: ['ignore', 'inherit', 'inherit'] });
ff(['-ss', String(start0), '-t', total.toFixed(3), '-i', session, '-af', `afade=t=in:d=0.4,afade=t=out:st=${(total - 4).toFixed(2)}:d=4,alimiter=limit=0.97:attack=3:release=60:level=false,loudnorm=I=-10:TP=-1.0:LRA=9`, '-ar', '48000', `${OUT}.wav`]);
ff(['-i', `${OUT}.wav`, '-codec:a', 'libmp3lame', '-b:a', '320k', '-metadata', `title=${ALBUM} (Full Album)`, '-metadata', `album=${ALBUM}`, '-metadata', `artist=${ARTIST}`, `${OUT}.mp3`]);
const inputs = segs.flatMap((s) => ['-ss', String(s.ss), '-t', String(s.t), '-i', s.f]);
const fc = segs.map((_, i) => `[${i}:v]setpts=PTS-STARTPTS,fps=30[v${i}]`).join(';') + ';' + segs.map((_, i) => `[v${i}]`).join('') + `concat=n=${segs.length}:v=1:a=0[v]`;
ff([...inputs, '-i', `${OUT}.wav`, '-filter_complex', fc, '-map', '[v]', '-map', `${segs.length}:a`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-shortest', `${OUT}.mp4`]);
fs.rmSync(`${OUT}.wav`, { force: true });
console.log(`🎬 ${OUT}.mp4\n♫ ${OUT}.mp3`);
