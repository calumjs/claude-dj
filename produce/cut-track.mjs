// Cut one album track out of a live run-design.mjs session (works while it is still recording): export the session so far,
// find where the track's reel windows landed (cross-correlation), master to mp3, optionally render its video.
//   node produce/cut-track.mjs <design.mjs> <trackNo> [--video] [--album "Album Name"] [--artist "DJ Claude"] [--logo png]
// Outputs .dj/exports/album/<Album> - NN - <Title>.mp3 (+ .mp4 and (480p).mp4), meta in .dj/produce/out/album/tNN.json.
// Titles come from the design's TITLES export (album-design.mjs: each song plan's `title`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
try { os.setPriority(process.pid, 19); } catch { /* best effort */ }
const args = process.argv.slice(2); const flag = (n, d = null) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [DESIGN, tn] = pos; const TN = Number(tn); const VIDEO = args.includes('--video');
if (!DESIGN || !TN) { console.log('usage: cut-track.mjs <design.mjs> <trackNo> [--video] [--album name] [--artist name] [--logo png]'); process.exit(1); }
const design = await import(pathToFileURL(path.resolve(DESIGN)).href); const { SECTIONS } = design; const TITLES = design.TITLES || {};
const dname = path.basename(DESIGN, '.mjs');
const ALBUM = flag('--album', dname), ARTIST = flag('--artist', 'DJ Claude'), LOGO = flag('--logo');
const times = JSON.parse(fs.readFileSync('.dj/produce/out/run-design-times.json', 'utf8'));
const run = (cmd, a, opts = {}) => { try { return execFileSync(cmd, a, { windowsHide: true, encoding: 'utf8', timeout: 1800000, stdio: ['ignore', 'pipe', 'pipe'], ...opts }); } catch (e) { console.error(`✗ ${cmd} ${a.slice(0, 3).join(' ')}…\n${String(e.stderr || e.message).slice(0, 600)}`); process.exit(1); } };
const dj = (...a) => run(process.execPath, ['dj.mjs', ...a]);
const ff = (a) => run('ffmpeg', ['-y', '-v', 'error', '-threads', '2', ...a]);
// 1) export the session so far
const session = fs.readdirSync('.dj/sessions').sort().pop(); dj('export', session);
const mp3 = path.join('.dj/exports', `${session}.mp3`); if (!fs.existsSync(mp3)) { console.log('export not found:', mp3); process.exit(1); }
const total = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp3], { windowsHide: true }).toString().trim();
// 2) this track's windows (+ the next track's first window as the end boundary)
const mine = SECTIONS.filter((s) => s.track === TN); const names = mine.map((s) => s.name); if (!mine.length) { console.log(`no sections for track ${TN}`); process.exit(1); }
const nextFirst = SECTIONS.find((s) => s.track === TN + 1);
const hint = (name) => { const w = times.windows.find((x) => x.name === name); return w ? (w.epoch - times.recordStart) / 1000 : null; };
if (names.some((n) => hint(n) == null)) { console.log(`track ${TN} not fully recorded yet`); process.exit(2); }
const endHint = nextFirst && hint(nextFirst.name) != null ? hint(nextFirst.name) : null;
const last = mine[mine.length - 1]; const lastEnd = hint(last.name) + last.bars * 240 / last.bpm;
if (total < lastEnd + 1) { console.log(`recording not far enough yet (${total.toFixed(0)}s < ${lastEnd.toFixed(0)}s)`); process.exit(2); }
// 3) align these windows against the mix
const NN = String(TN).padStart(2, '0'); const base = `.dj/produce/out/album/t${NN}`; fs.mkdirSync('.dj/produce/out/album', { recursive: true });
const reel = JSON.parse(fs.readFileSync(`.dj/voices/${dname}-reel.json`, 'utf8'));
fs.writeFileSync(`${base}-reel.json`, JSON.stringify({ ...reel, windows: reel.windows.filter((w) => names.includes(w.name)) }));
run(process.execPath, ['produce/align.mjs', `${base}-reel.json`, mp3, DESIGN, `${base}-align.json`, names.map(hint).map((h) => h.toFixed(2)).join(',')]);
const al = JSON.parse(fs.readFileSync(`${base}-align.json`, 'utf8'));
const first = al.sections[0];
const start = Math.max(0, first.start - 240 / first.bpm), end = Math.min(total, endHint != null ? endHint - 0.05 : al.sections[al.sections.length - 1].start + last.bars * 240 / last.bpm + 2.5);
const title = TITLES[TN] || `Track ${TN}`;
const dur = end - start, name = `${ALBUM} - ${NN} - ${title}`.replace(/[<>:"/\\|?*]/g, '').replace(/\.+$/, '');
const meta = { duration: +dur.toFixed(3), title: `${ARTIST} - ${title}`, session: mp3, start: +start.toFixed(3), end: +end.toFixed(3), sections: al.sections.map((s) => ({ name: s.name, start: +(s.start - start).toFixed(3), end: +(s.start - start + s.bars * 240 / s.bpm).toFixed(3) })) };
fs.writeFileSync(`${base}.json`, JSON.stringify(meta, null, 1));
fs.mkdirSync('.dj/exports/album', { recursive: true });
const fadeOut = endHint != null ? 0.6 : 2.5;
ff(['-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', mp3, '-af', `afade=t=in:d=0.4,afade=t=out:st=${(dur - fadeOut).toFixed(2)}:d=${fadeOut},alimiter=limit=0.97:attack=3:release=60:level=false,loudnorm=I=-10:TP=-1.0:LRA=9`, '-ar', '48000', `${base}-master.wav`]);
ff(['-i', `${base}-master.wav`, '-codec:a', 'libmp3lame', '-b:a', '320k', '-metadata', `title=${title}`, '-metadata', `album=${ALBUM}`, '-metadata', `artist=${ARTIST}`, '-metadata', `track=${TN}`, `.dj/exports/album/${name}.mp3`]);
console.log(`✓ ${name}.mp3  ${start.toFixed(1)}–${end.toFixed(1)} s (${(dur / 60).toFixed(1)} min)`);
if (VIDEO) {
  const scr = times.screen && fs.existsSync(times.screen.file) ? ['--screen', times.screen.file, '--screen-offset', String(+(start - (times.screen.start - times.recordStart) / 1000).toFixed(3))] : [];
  run(process.execPath, ['produce/make-video.mjs', `${base}-master.wav`, '--title', meta.title, '--out', `.dj/exports/album/${name}.mp4`, ...scr, ...(LOGO ? ['--logo', LOGO] : [])], { stdio: 'inherit' });
}
