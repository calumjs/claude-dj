// Turn an exported set (or any audio file) into a music video: reactive visualiser background, optional DJ-table footage
// from produce/record-browser.mjs cut in as B-roll, title card, 720p master + 480p copy.
//
//   node produce/make-video.mjs <audio.mp3|wav> --title "DJ Claude - Friday Lunch Set" [--out <file.mp4>]
//                               [--screen auto|<capture.webm>] [--screen-offset <sec>] [--logo <png>] [--sections <tracklist.txt>]
//
// --screen auto   uses the latest recording in .dj/produce/out/screen and lines it up from browser.json `start` and the
//                 session id in the audio file name (.dj/exports/<ISO time>.mp3 → the recording start in UTC).
// --sections      a `dj export` tracklist (.txt next to the mp3: "m:ss  Artist - Title" lines) → one tinted section per track.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2); const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const AUDIO = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!AUDIO || !fs.existsSync(AUDIO)) { console.log('usage: make-video.mjs <audio> --title "Credit - Song" [--out x.mp4] [--screen auto|file] [--logo png]'); process.exit(1); }
const TITLE = flag('--title') || path.basename(AUDIO).replace(/\.[^.]+$/, '');
const OUT = flag('--out') || path.join(path.dirname(AUDIO), `${path.basename(AUDIO).replace(/\.[^.]+$/, '')}.mp4`);
const LOGO = flag('--logo'); let SCREEN = flag('--screen'); let SCREEN_OFF = Number(flag('--screen-offset') || 0);
const SECTIONS = flag('--sections') || (fs.existsSync(AUDIO.replace(/\.[^.]+$/, '.txt')) ? AUDIO.replace(/\.[^.]+$/, '.txt') : null);
const TMP = path.join('.dj/produce/out/vtmp', path.basename(OUT).replace(/\.mp4$/, '')); fs.mkdirSync(TMP, { recursive: true });
const ff = (a) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...a], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
const probe = (f) => +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim();
const dur = probe(AUDIO);

// sections from a dj export tracklist ("m:ss  title" or "h:mm:ss  title")
let sections = [];
if (SECTIONS && fs.existsSync(SECTIONS)) {
  const rows = fs.readFileSync(SECTIONS, 'utf8').split(/\r?\n/).map((l) => l.match(/^\s*(\d+:)?(\d+):(\d\d)\s+(.+)$/)).filter(Boolean)
    .map((m) => ({ start: (m[1] ? +m[1].slice(0, -1) * 3600 : 0) + +m[2] * 60 + +m[3], name: m[4].trim() }));
  sections = rows.map((r, i) => ({ ...r, end: rows[i + 1] ? rows[i + 1].start : dur })).filter((s) => s.end > s.start);
}
const meta = { title: TITLE, duration: +dur.toFixed(3), sections };
fs.writeFileSync(path.join(TMP, 'meta.json'), JSON.stringify(meta, null, 1));

// screen capture alignment
if (SCREEN === 'auto') {
  const info = JSON.parse(fs.readFileSync('.dj/produce/out/screen/browser.json', 'utf8'));
  SCREEN = info.file;
  const m = path.basename(AUDIO).match(/(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)/); // .dj/exports/<session id>.mp3, UTC
  if (m && !flag('--screen-offset')) { const recStart = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`); SCREEN_OFF = (recStart - info.start) / 1000; }
  console.log(`screen: ${path.basename(SCREEN)} offset ${SCREEN_OFF.toFixed(1)} s`);
}

// 1) background
const bg = path.join(TMP, 'bg.mp4');
execFileSync(process.execPath, ['produce/viz.mjs', path.join(TMP, 'meta.json'), AUDIO, bg, ...(LOGO ? ['--logo', LOGO] : [])], { stdio: 'inherit' });
let cur = bg;
// 2) DJ-table B-roll: the whole set after the title card, letterboxed to fit, slightly darkened, title bug kept on top
if (SCREEN && fs.existsSync(SCREEN)) {
  const scr = path.join(TMP, 'screen.mp4');
  ff(['-ss', Math.max(0, SCREEN_OFF).toFixed(3), '-i', SCREEN, '-t', dur.toFixed(2), '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,eq=brightness=-0.06:saturation=1.1', '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-an', scr]);
  const mixed = path.join(TMP, 'bg-screen.mp4');
  // fade the footage in after the title card and give the visualiser the last 15 s
  ff(['-i', cur, '-i', scr, '-filter_complex', `[1:v]format=yuva420p,fade=t=in:st=6:d=1.5:alpha=1,fade=t=out:st=${Math.max(7, dur - 15).toFixed(2)}:d=2:alpha=1[s];[0:v][s]overlay=eof_action=pass[o]`, '-map', '[o]', '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', mixed]);
  cur = mixed;
}
// 3) mux + 480p
ff(['-i', cur, '-i', AUDIO, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-shortest', OUT]);
ff(['-i', OUT, '-vf', 'scale=854:480', '-c:v', 'libx264', '-preset', 'medium', '-crf', '27', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', OUT.replace(/\.mp4$/, ' (480p).mp4')]);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows may still hold a handle; leave the temp dir */ }
console.log(`🎬 ${OUT}\n   ${OUT.replace(/\.mp4$/, ' (480p).mp4')}`);
