// Speech features for every indexed sentence/line: pitch (median f0 → MIDI + pitch class, contour slope), and percussion
// (strongest transient offset, percussiveness). → .dj/voice/features.json keyed "id|from".
//   node produce/analyze-speech.mjs [--limit N]        (after produce/index-captions.mjs)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const SR = 16000;
const LIB = JSON.parse(fs.readFileSync('.dj/library.json', 'utf8')).tracks;
const tr = (id) => Object.values(LIB).find((t) => t.id === id);
const items = [...JSON.parse(fs.readFileSync('.dj/voice/sentences.json', 'utf8')), ...(fs.existsSync('.dj/voice/lines.json') ? JSON.parse(fs.readFileSync('.dj/voice/lines.json', 'utf8')) : [])];
const LIMIT = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : Infinity;
const outPath = '.dj/voice/features.json';
const feats = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : {};
const dec = (file, from, dur) => { const b = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, from)), '-t', String(dur), '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'], { windowsHide: true, maxBuffer: 1 << 26 }); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
// f0 by normalised autocorrelation on 40 ms frames (hop 10 ms), voiced if r > 0.6 and energy above floor
function pitchTrack(x) {
  const N = Math.round(0.04 * SR), H = Math.round(0.01 * SR), lo = Math.round(SR / 400), hi = Math.round(SR / 70), out = [];
  let peak = 0; for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  for (let s = 0; s + N < x.length; s += H) {
    let e = 0; for (let i = 0; i < N; i++) e += x[s + i] * x[s + i]; if (Math.sqrt(e / N) < peak * 0.08) { out.push(null); continue; }
    let best = 0, bl = 0; for (let lag = lo; lag <= hi; lag++) { let r = 0, a = 0, b = 0; for (let i = 0; i < N - lag; i++) { r += x[s + i] * x[s + i + lag]; a += x[s + i] * x[s + i]; b += x[s + i + lag] * x[s + i + lag]; } const c = r / (Math.sqrt(a * b) + 1e-9); if (c > best) { best = c; bl = lag; } }
    out.push(best > 0.6 ? SR / bl : null);
  }
  return out;
}
// onset strength: energy flux in 5 ms hops over a 20 ms window
function onsets(x) {
  const W = Math.round(0.02 * SR), H = Math.round(0.005 * SR), env = [];
  for (let s = 0; s + W < x.length; s += H) { let e = 0; for (let i = 0; i < W; i++) e += x[s + i] * x[s + i]; env.push(Math.sqrt(e / W)); }
  const flux = env.map((v, i) => Math.max(0, v - (env[i - 1] ?? 0)));
  const mean = env.reduce((a, b) => a + b, 0) / Math.max(1, env.length) + 1e-9;
  let bi = 0; for (let i = 1; i < flux.length; i++) if (flux[i] > flux[bi]) bi = i;
  // percussiveness: strongest flux relative to mean level, and how quickly it decays (ratio of energy 60 ms later)
  const after = env[Math.min(env.length - 1, bi + 12)] ?? 0;
  return { hit: +(bi * H / SR).toFixed(3), perc: +Math.min(10, flux[bi] / mean).toFixed(2), decay: +((after + 1e-9) / (env[bi] + 1e-9)).toFixed(2), first: +((flux.findIndex((f) => f > 0.4 * flux[bi]) * H) / SR).toFixed(3) };
}
let n = 0, done = 0;
for (const it of items) {
  if (n >= LIMIT) break; const key = `${it.id}|${it.from}`; if (feats[key]) continue; const t = tr(it.id); if (!t) continue; n++;
  try {
    const x = dec(t.file, it.from, it.dur); const pt = pitchTrack(x); const v = pt.filter(Boolean);
    let f = null; if (v.length >= 4) { const sorted = [...v].sort((a, b) => a - b); const med = sorted[Math.floor(sorted.length / 2)]; const midi = 69 + 12 * Math.log2(med / 440); const first = v.slice(0, Math.max(1, Math.floor(v.length / 3))), last = v.slice(-Math.max(1, Math.floor(v.length / 3))); const slope = 12 * Math.log2((last.reduce((a, b) => a + b, 0) / last.length) / (first.reduce((a, b) => a + b, 0) / first.length)); f = { f0: +med.toFixed(1), midi: +midi.toFixed(2), pc: ((Math.round(midi) % 12) + 12) % 12, voiced: +(v.length / pt.length).toFixed(2), slope: +slope.toFixed(2) }; }
    feats[key] = { ...(f || { f0: null, midi: null, pc: null, voiced: 0, slope: 0 }), ...onsets(x) }; done++;
  } catch (e) { feats[key] = { error: String(e.message).slice(0, 80) }; }
  if (done % 100 === 0) fs.writeFileSync(outPath, JSON.stringify(feats));
}
fs.writeFileSync(outPath, JSON.stringify(feats));
console.log(`analysed ${done} items (${Object.keys(feats).length} total in ${outPath})`);
