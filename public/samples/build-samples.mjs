// Trim + level the downloaded one-shots in ./src into pad-ready WAVs + manifest.json.
// Run: node public/samples/build-samples.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SR = 48000;
// pad, kind, label, source, [start, end] seconds, fade-out ms, target RMS dBFS (active part)
const PADS = [
  { pad: 1, kind: 'horn', name: 'AIR HORN', src: 'horn.wav', cut: [0.35, 2.4], fadeOut: 120, rms: -15 },
  { pad: 2, kind: 'riser', name: 'RISER', src: 'riser.wav', cut: [26.0, 30.15], fadeOut: 8, rms: -16, fitBeats: 8 },
  { pad: 3, kind: 'boom', name: 'BOOM', src: 'boom.wav', cut: [0.08, 4.6], fadeOut: 300, rms: -16 },
  { pad: 4, kind: 'siren', name: 'SIREN', src: 'siren.wav', cut: [0.0, 5.6], fadeOut: 250, rms: -17 },
  { pad: 5, kind: 'zap', name: 'LASER', src: 'zap2.wav', cut: [0.38, 1.3], fadeOut: 60, rms: -16 },
  { pad: 6, kind: 'hey', name: 'HEY!', src: 'hey.wav', cut: [2.15, 2.75], fadeOut: 60, rms: -14 },
  { pad: 7, kind: 'subdrop', name: 'SUB DROP', src: 'subdrop.wav', cut: [0.3, 4.6], fadeOut: 250, rms: -15 },
];

function decode(file, start, end) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(start), '-to', String(end), '-i', file, '-ac', '2', '-ar', String(SR), '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 30, windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg failed on ${file}: ${r.stderr}`);
  const b = r.stdout, ab = new ArrayBuffer(b.length - (b.length % 8));
  new Uint8Array(ab).set(b.subarray(0, ab.byteLength));
  const x = new Float32Array(ab), n = x.length / 2, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = x[2 * i]; R[i] = x[2 * i + 1]; }
  return { L, R };
}

function writeWav(file, L, R) {
  const n = L.length, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

const manifest = [];
for (const p of PADS) {
  const { L, R } = decode(path.join(DIR, 'src', p.src), ...p.cut);
  const n = L.length;
  // RMS over the active part (samples within 30 dB of the peak), then gain to target, capped at -1 dBFS peak
  let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const gate = peak * 0.0316;
  let e = 0, c = 0; for (let i = 0; i < n; i++) { const m = (Math.abs(L[i]) + Math.abs(R[i])) / 2; if (m > gate) { e += L[i] * L[i] + R[i] * R[i]; c += 2; } }
  const rmsDb = 10 * Math.log10(e / Math.max(1, c) + 1e-12);
  let gain = Math.pow(10, (p.rms - rmsDb) / 20);
  gain = Math.min(gain, 0.891 / peak);
  const fin = Math.round(0.003 * SR), fout = Math.round((p.fadeOut / 1000) * SR);
  for (let i = 0; i < n; i++) {
    let g = gain;
    if (i < fin) g *= i / fin;
    if (i > n - fout) g *= Math.max(0, (n - i) / fout);
    L[i] *= g; R[i] *= g;
  }
  const out = `${p.kind}.wav`;
  writeWav(path.join(DIR, out), L, R);
  manifest.push({ pad: p.pad, kind: p.kind, name: p.name, file: `samples/${out}`, seconds: +(n / SR).toFixed(2), ...(p.fitBeats ? { fitBeats: p.fitBeats } : {}) });
  console.log(`pad ${p.pad} ${p.name.padEnd(9)} ${(n / SR).toFixed(2)}s  gain ${(20 * Math.log10(gain)).toFixed(1)} dB`);
}
fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify({ pads: manifest }, null, 2));
console.log('wrote manifest.json');
