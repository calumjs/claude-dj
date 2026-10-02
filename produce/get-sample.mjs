// Download a short sound/vocal sample from YouTube into .dj/produce/samples/<name>.mp3 and print its non-silent segments.
//   node produce/get-sample.mjs <youtube url> <name>          (name: kebab-case, e.g. hee-hee)
// Pick the URL with `node dj.mjs find "<query> sound effect"` first; prefer uploads under ~30 s.
// Uses bin/yt-dlp.exe (installed by `node dj.mjs doctor --fix`) and, if present, the login cookies at .dj/youtube-cookies.txt.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const [url, name] = process.argv.slice(2); if (!url || !name) { console.log('usage: get-sample <url> <name>'); process.exit(1); }
const DIR = '.dj/produce/samples'; fs.mkdirSync(DIR, { recursive: true });
const out = path.join(DIR, `${name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}.mp3`);
const ytdlp = fs.existsSync('bin/yt-dlp.exe') ? 'bin/yt-dlp.exe' : fs.existsSync('bin/yt-dlp') ? 'bin/yt-dlp' : 'yt-dlp';
if (!fs.existsSync(out)) {
  const cookies = '.dj/youtube-cookies.txt';
  const a = ['--no-warnings', '--no-colors', '--encoding', 'utf-8', '--js-runtimes', `node:${process.execPath}`, ...(fs.existsSync(cookies) ? ['--cookies', cookies] : []), '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', out.replace(/\.mp3$/, '.%(ext)s'), '--no-playlist', url];
  try { execFileSync(ytdlp, a, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 180000 }); } catch (e) { console.log('download failed:', (e.stderr || e.message).toString().split('\n').filter(Boolean).slice(-3).join(' | ')); process.exit(1); }
}
console.log('saved', out);
console.log(execFileSync(process.execPath, ['produce/measure-sample.mjs', out], { encoding: 'utf8', windowsHide: true }));
