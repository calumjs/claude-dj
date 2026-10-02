// Find where each reel window actually landed in a live recording by cross-correlating the reel audio against the mix.
// Writes a video meta JSON (same shape video.mjs reads) with real section start times.
//   node produce/align.mjs <reel.json> <mix.wav|mp3> <design.mjs> <out.json> [hints]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const [REELJ, MIX, DESIGN, OUT, HINT] = process.argv.slice(2); const hints = HINT ? HINT.split(',').map(Number) : null;
const reel = JSON.parse(fs.readFileSync(REELJ, 'utf8'));
const { SECTIONS, WINDOWS } = await import(pathToFileURL(path.resolve(DESIGN)).href);
const SR = 8000;
const dec = (f, from, dur) => { const b = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(from), '-t', String(dur), '-i', f, '-ac', '1', '-ar', String(SR), '-af', 'highpass=f=300,lowpass=f=3400', '-f', 'f32le', 'pipe:1'], { windowsHide: true, maxBuffer: 1 << 29 }); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const mixDur = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', MIX], { windowsHide: true }).toString().trim();
const mix = dec(MIX, 0, mixDur);
const env = (x) => { const o = new Float32Array(x.length); for (let i = 1; i < x.length; i++) o[i] = Math.abs(x[i] - x[i - 1]); return o; }; // onset-ish envelope
const E = env(mix);
let searchFrom = 0; const sections = [];
for (let i = 0; i < reel.windows.length; i++) {
  const w = reel.windows[i], sec = SECTIONS.find((s) => s.name === w.name);
  const probeDur = Math.min(12, w.length); const probe = env(dec(reel.file, w.offset, probeDur));
  // normalised cross-correlation over the search range [searchFrom, searchFrom + 120 s]
  const lo = hints ? hints[i] - 3 : searchFrom, hi = hints ? hints[i] + 3 : searchFrom + 150;
  const a = Math.max(0, Math.floor(lo * SR)), b = Math.min(E.length - probe.length, Math.floor(hi * SR));
  let best = -Infinity, bi = a; let pm = 0; for (let k = 0; k < probe.length; k++) pm += probe[k] * probe[k]; pm = Math.sqrt(pm) + 1e-9;
  for (let s = a; s < b; s += 2) { let acc = 0, em = 0; for (let k = 0; k < probe.length; k += 2) { acc += probe[k] * E[s + k]; em += E[s + k] * E[s + k]; } const c = acc / (pm * Math.sqrt(em) + 1e-9); if (c > best) { best = c; bi = s; } }
  const t = bi / SR; // time in the mix where the window's reel audio begins = the window anchor bar time
  const barSec = 240 / w.bpm;
  const dw = WINDOWS.find((x) => x.name === w.name);
  sections.push({ name: w.name, bpm: w.bpm, bars: sec.bars, start: +t.toFixed(3), bed: sec.id, corr: +best.toFixed(3),
    lines: (dw.lines || []).map(([end, id, from, dur, text]) => [end - w.anchor + 1, id, from, dur, text]),
    voices: (dw.slices || []).map(([sb, id, from, dur, rf, rd]) => [sb - w.anchor + 1, id, from, dur, rf, rd]) });
  console.log(`${w.name.padEnd(10)} reel ${w.offset.toFixed(1)}s → mix ${t.toFixed(2)}s  (corr ${best.toFixed(2)})`);
  searchFrom = t + 10;
}
fs.writeFileSync(OUT, JSON.stringify({ duration: mixDur, sections, reelAligned: true }, null, 1));
console.log(`→ ${OUT}`);
