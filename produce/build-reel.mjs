// Render a voice reel from a design module (exports WINDOWS; see .claude/skills/dj-voice): every line cut from its clip (vocal stem when separated), high-passed,
// compressed, levelled to the same speech loudness, and placed so it ENDS on its bar. Windows are laid end to end in one WAV;
// .dj/voices/<name>-reel.json records each window's offset so the runner can seek the reel deck to it on the anchor bar.
//   node produce/build-reel.mjs <design.mjs>      → library/voice-reels/<name> voice reel.wav + .dj/voices/<name>-reel.json
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) { console.log('usage: build-reel.mjs <design.mjs>'); process.exit(1); }
const designPath = path.resolve(process.argv[2]);
const name = path.basename(designPath, '.mjs');
const { WINDOWS } = await import(pathToFileURL(designPath).href);
const LIB = JSON.parse(fs.readFileSync('.dj/library.json', 'utf8')).tracks;
const tr = (id) => LIB[id] || Object.values(LIB).find((t) => t.id === id) || (fs.existsSync(String(id)) ? { id: String(id), file: String(id), title: path.basename(String(id)) } : undefined); // a plain file path works as a sample source
const SR = 48000, TARGET_DB = -18, PEAK_CAP_DB = -6, GAP = 2.0, TAIL = 1.0;
const db = (x) => 20 * Math.log10(x + 1e-12);

// prefer the separated vocal stem (no bed music under the speech) when it exists
const srcOf = (t) => (fs.existsSync(`.dj/stems/${t.id}/vocals.wav`) ? `.dj/stems/${t.id}/vocals.wav` : t.file);
function cut(file, from, dur) {
  const af = ['highpass=f=90', 'acompressor=threshold=-26dB:ratio=3:attack=5:release=90:makeup=1', 'afade=t=in:d=0.004', `afade=t=out:st=${Math.max(0, dur - Math.min(0.04, dur / 4)).toFixed(3)}:d=${Math.min(0.04, dur / 4).toFixed(3)}`].join(',');
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(from), '-t', String(dur), '-i', file, '-ac', '2', '-ar', String(SR), '-af', af, '-f', 'f32le', 'pipe:1'], { windowsHide: true, maxBuffer: 1 << 28 });
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const n = f.length / 2, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = f[2 * i]; R[i] = f[2 * i + 1]; }
  return { L, R };
}
function level({ L, R }) { // speech-active RMS (loudest half of 20 ms frames) → gain to TARGET, capped by peak
  const fr = Math.round(0.02 * SR), rms = [];
  let peak = 0;
  for (let i = 0; i < L.length; i += fr) { let s = 0, k = 0; for (let j = i; j < Math.min(L.length, i + fr); j++) { const m = (L[j] + R[j]) / 2; s += m * m; k++; peak = Math.max(peak, Math.abs(L[j]), Math.abs(R[j])); } rms.push(s / Math.max(1, k)); }
  rms.sort((a, b) => b - a); const top = rms.slice(0, Math.max(1, Math.floor(rms.length / 2)));
  const act = db(Math.sqrt(top.reduce((a, b) => a + b, 0) / top.length)) / 1; // 20log10(sqrt(mean))
  const g = Math.min(TARGET_DB - act, PEAK_CAP_DB - db(peak));
  return { gainDb: g, actDb: act, peakDb: db(peak) };
}

const meta = { name, sampleRate: SR, windows: [] };
const parts = []; let offset = 0.5, warn = 0;
for (const w of WINDOWS) {
  const barSec = 240 / w.bpm;
  const lines = [...(w.lines || [])].sort((a, b) => a[0] - b[0]);
  const rolls = [...(w.roll || [])].sort((a, b) => a[0] - b[0]);
  const slices = w.slices || [];
  const lastEnd = Math.max(...lines.map((l) => l[0]), ...slices.map((x) => x[0] + x[3] / barSec), ...rolls.map((r, i) => (rolls[i + 1]?.[0] ?? r[0] + (r[0] - (rolls[i - 1]?.[0] ?? r[0] - 1))) ));
  const len = (lastEnd - w.anchor) * barSec + TAIL;
  const L = new Float32Array(Math.ceil(len * SR)), R = new Float32Array(L.length);
  let prevEnd = -Infinity;
  const placed = [];
  for (const [end, id, from, dur, text] of lines) {
    const t = tr(id); if (!t) throw new Error(`clip ${id} not in library`);
    const start = (end - w.anchor) * barSec - dur;
    if (start < 0) { console.log(`⚠ ${w.name}: "${text}" starts before the anchor (${start.toFixed(2)} s)`); warn++; }
    if (start < prevEnd - 0.05) { console.log(`⚠ ${w.name}: "${text}" overlaps the previous line by ${(prevEnd - start).toFixed(2)} s`); warn++; }
    prevEnd = start + dur;
    const c = cut(srcOf(t), from, dur), lv = level(c), g = Math.pow(10, lv.gainDb / 20);
    const s0 = Math.max(0, Math.round(start * SR));
    for (let i = 0; i < c.L.length && s0 + i < L.length; i++) { L[s0 + i] += c.L[i] * g; R[s0 + i] += c.R[i] * g; }
    placed.push({ end, start: +start.toFixed(3), dur, text, gainDb: +lv.gainDb.toFixed(1) });
  }
  for (let i = 0; i < rolls.length; i++) { // roll reps START on their bar; each is cut to the gap before the next
    const [sb, id, from, dur] = rolls[i]; const t = tr(id);
    const nb = rolls[i + 1]?.[0] ?? sb + (sb - (rolls[i - 1]?.[0] ?? sb - 1));
    const start = (sb - w.anchor) * barSec, d = Math.min(dur, (nb - sb) * barSec - 0.02);
    const c = cut(srcOf(t), from, d), lv = level(c), g = Math.pow(10, lv.gainDb / 20);
    const s0 = Math.round(start * SR);
    for (let k = 0; k < c.L.length && s0 + k < L.length; k++) { L[s0 + k] += c.L[k] * g; R[s0 + k] += c.R[k] * g; }
    placed.push({ end: +(sb + d / barSec).toFixed(3), start: +start.toFixed(3), dur: +d.toFixed(3), text: `roll@${sb}`, gainDb: +lv.gainDb.toFixed(1) });
  }
  const refGain = new Map();
  for (const [sb, id, from, dur, rf, rd] of slices) {
    const t = tr(id), key = `${id}@${rf}`;
    if (!refGain.has(key)) refGain.set(key, level(cut(srcOf(t), rf, rd)).gainDb);
    const g = Math.pow(10, refGain.get(key) / 20), c = cut(srcOf(t), from, dur), s0 = Math.round((sb - w.anchor) * barSec * SR);
    if (s0 < 0) { console.log(`⚠ ${w.name}: slice at bar ${sb} is before the anchor`); warn++; continue; }
    for (let k = 0; k < c.L.length && s0 + k < L.length; k++) { L[s0 + k] += c.L[k] * g; R[s0 + k] += c.R[k] * g; }
  }
  if (slices.length) placed.push(...[...new Set(slices.map((x) => x[0]))].length ? [{ end: lastEnd, start: 0, dur: 0, text: `${slices.length} chops`, gainDb: 0 }] : []);
  meta.windows.push({ name: w.name, bed: w.bed, anchor: w.anchor, bpm: w.bpm, mute: w.mute || null, bedMoves: w.bedMoves || null, duck: slices.length ? 'window' : 'line', offset: +offset.toFixed(4), length: +len.toFixed(3), lines: placed });
  parts.push({ offset, L, R });
  console.log(`✓ ${w.name.padEnd(12)} anchor ${String(w.anchor).padStart(3)} @${w.bpm}  ${lines.length} lines  ${len.toFixed(1)} s  at reel ${offset.toFixed(1)} s`);
  offset += len + GAP;
}
const total = Math.ceil((offset + 1) * SR);
const out = Buffer.alloc(44 + total * 4);
const wr = (o, s) => out.write(s, o, 'ascii');
wr(0, 'RIFF'); out.writeUInt32LE(36 + total * 4, 4); wr(8, 'WAVE'); wr(12, 'fmt '); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22);
out.writeUInt32LE(SR, 24); out.writeUInt32LE(SR * 4, 28); out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34); wr(36, 'data'); out.writeUInt32LE(total * 4, 40);
let clip = 0;
for (const p of parts) { const s0 = Math.round(p.offset * SR); for (let i = 0; i < p.L.length; i++) { for (const [ch, v] of [[0, p.L[i]], [1, p.R[i]]]) { let x = Math.round(v * 32767); if (x > 32767 || x < -32768) { clip++; x = Math.max(-32768, Math.min(32767, x)); } out.writeInt16LE(x, 44 + (s0 + i) * 4 + ch * 2); } } }
fs.mkdirSync('library/voice-reels', { recursive: true });
const wav = path.resolve(`library/voice-reels/Voice Reel - ${name}.wav`); // scanned into the crate as artist "Voice Reel"
fs.writeFileSync(wav, out);
meta.file = wav; meta.duration = +(total / SR).toFixed(2);
fs.writeFileSync(`.dj/voices/${name}-reel.json`, JSON.stringify(meta, null, 1));
console.log(`→ ${wav}  ${meta.duration} s, ${meta.windows.length} windows, ${warn} warnings, ${clip} clipped samples`);
