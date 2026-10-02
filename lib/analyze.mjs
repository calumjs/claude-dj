// Track analysis: BPM + beat grid, musical key (Camelot), loudness, energy,
// phrase structure (intro / breakdowns / outro) and a waveform overview.
// Pure JS on top of ffmpeg-decoded PCM. No native deps.
import { spawn } from 'node:child_process';
import os from 'node:os';

const SR = 11025;          // analysis sample rate
const HOP = 128;           // onset hop (~11.6 ms)
const FPS = SR / HOP;

export function decodeMono(file, sr = SR) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-threads', '1', '-i', file, '-ac', '1', '-ar', String(sr), '-f', 'f32le', 'pipe:1'], { windowsHide: true });
    try { os.setPriority(ff.pid, 19); } catch { /* best effort */ }
    const chunks = []; let err = '';
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => (err += c));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg failed (${code}): ${err.trim()}`));
      const buf = Buffer.concat(chunks);
      const aligned = new ArrayBuffer(buf.length - (buf.length % 4));
      new Uint8Array(aligned).set(buf.subarray(0, aligned.byteLength));
      resolve(new Float32Array(aligned));
    });
  });
}

export function probeTags(file) {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', file], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.on('error', () => resolve({}));
    p.on('close', () => {
      try {
        const f = JSON.parse(out).format || {};
        const t = {};
        for (const [k, v] of Object.entries(f.tags || {})) t[k.toLowerCase()] = v;
        resolve({ tags: t, duration: Number(f.duration) || null });
      } catch { resolve({}); }
    });
  });
}

// ---------- helpers ----------
function lowpass(x, fc) {
  const a = Math.exp((-2 * Math.PI * fc) / SR);
  const y = new Float32Array(x.length);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) {
    s1 = (1 - a) * x[i] + a * s1;
    s2 = (1 - a) * s1 + a * s2;
    y[i] = s2;
  }
  return y;
}
function frameEnergy(x) {
  const n = Math.floor(x.length / HOP);
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * HOP, end = j + HOP; j < end; j++) s += x[j] * x[j];
    e[i] = s / HOP;
  }
  return e;
}
function onsetEnvelope(e) {
  const n = e.length, o = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const d = Math.log(1e-10 + e[i]) - Math.log(1e-10 + e[i - 1]);
    o[i] = d > 0 ? d : 0;
  }
  const w = Math.round(FPS * 0.5), out = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += o[i];
    if (i >= w) acc -= o[i - w];
    out[i] = Math.max(0, o[i] - acc / Math.min(i + 1, w));
  }
  return out;
}
const interp = (a, t) => {
  const i = Math.floor(t);
  if (i < 0 || i + 1 >= a.length) return 0;
  const f = t - i;
  return a[i] * (1 - f) + a[i + 1] * f;
};
function combScore(o, periodF, phaseF) {
  let s = 0, n = 0;
  for (let t = phaseF; t < o.length - 1; t += periodF) { s += interp(o, t); n++; }
  return n ? s / n : 0;
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };

// ---------- tempo ----------
function estimateTempo(o) {
  const minL = Math.floor((60 * FPS) / 200), maxL = Math.ceil((60 * FPS) / 60);
  const r = new Float64Array(maxL * 2 + 2);
  const N = o.length;
  for (let l = minL; l <= Math.min(maxL * 2, N - 1); l++) {
    let s = 0;
    for (let i = 0; i + l < N; i++) s += o[i] * o[i + l];
    r[l] = s / (N - l);
  }
  let best = -1, bestL = minL;
  for (let l = minL; l <= maxL; l++) {
    const bpm = (60 * FPS) / l;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 130) / 0.9, 2));
    const s = (r[l] + 0.5 * (r[2 * l] || 0)) * prior;
    if (s > best) { best = s; bestL = l; }
  }
  let bpm = (60 * FPS) / bestL;
  while (bpm < 78) bpm *= 2;
  while (bpm > 185) bpm /= 2;
  let top = { score: -1, bpm, phase: 0 };
  for (let b = bpm - 3; b <= bpm + 3; b += 0.01) {
    const P = (60 * FPS) / b;
    for (let k = 0; k < 48; k++) {
      const ph = (k / 48) * P;
      const s = combScore(o, P, ph);
      if (s > top.score) top = { score: s, bpm: b, phase: ph };
    }
  }
  // snap to integer / half-integer bpm if nearly as good (most dance music is on the grid)
  for (const snap of [Math.round(top.bpm), Math.round(top.bpm * 2) / 2]) {
    if (Math.abs(snap - top.bpm) > 0.15) continue;
    const P = (60 * FPS) / snap;
    let bs = -1, bp = 0;
    for (let k = 0; k < 96; k++) { const ph = (k / 96) * P; const s = combScore(o, P, ph); if (s > bs) { bs = s; bp = ph; } }
    if (bs >= top.score * 0.97) { top = { score: bs, bpm: snap, phase: bp }; break; }
  }
  const P = (60 * FPS) / top.bpm;
  let bs = -1, bp = top.phase;
  for (let k = -32; k <= 32; k++) {
    const ph = top.phase + (k / 64) * (P / 8);
    if (ph < 0) continue;
    const s = combScore(o, P, ph);
    if (s > bs) { bs = s; bp = ph; }
  }
  const mean = o.reduce((a, b) => a + b, 0) / o.length || 1e-9;
  return { bpm: Math.round(top.bpm * 100) / 100, phaseSec: bp / FPS, confidence: Math.min(1, bs / mean / 4) };
}

// ---------- key ----------
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
// EDMA key profiles (Faraldo et al.), tuned for electronic dance music
const MAJOR = [0.1652, 0.0475, 0.0829, 0.0669, 0.0999, 0.0927, 0.0529, 0.1316, 0.0522, 0.0744, 0.0694, 0.0643];
const MINOR = [0.1724, 0.04, 0.0761, 0.1204, 0.052, 0.0913, 0.055, 0.1269, 0.0809, 0.0546, 0.0822, 0.0557];
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]; // index = pitch class
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
function corr(a, b) {
  const ma = a.reduce((s, v) => s + v, 0) / 12, mb = b.reduce((s, v) => s + v, 0) / 12;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db || 1e-12);
}
function chroma(x, N, lo, hi) {
  const c = new Float64Array(12);
  const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const binPc = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = (k * SR) / N;
    if (f < lo || f > hi) continue;
    const p = 12 * Math.log2(f / 440) + 69;
    if (Math.abs(p - Math.round(p)) > 0.35) continue; // only bins near a semitone centre
    binPc[k] = ((Math.round(p) % 12) + 12) % 12;
  }
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let s = 0; s + N <= x.length; s += N) {
    for (let i = 0; i < N; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const fr = new Float64Array(12); let tot = 0;
    for (let k = 1; k < N / 2; k++) {
      if (binPc[k] < 0) continue;
      const m = Math.hypot(re[k], im[k]); fr[binPc[k]] += m; tot += m;
    }
    if (tot > 1e-6) for (let i = 0; i < 12; i++) c[i] += fr[i] / tot;
  }
  return c;
}
function estimateKey(x) {
  // mid-register harmony + bass-register roots (bass disambiguates relative/fifth confusions)
  const mid = chroma(x, 4096, 110, 2500), bass = chroma(x, 8192, 35, 220);
  const c = mid.map((v, i) => v + bass[i]);
  const cands = [];
  for (let t = 0; t < 12; t++) {
    const rot = (p) => Array.from({ length: 12 }, (_, i) => p[(i - t + 12) % 12]);
    cands.push({ score: corr(c, rot(MAJOR)), tonic: t, mode: 'major' });
    cands.push({ score: corr(c, rot(MINOR)), tonic: t, mode: 'minor' });
  }
  cands.sort((a, b) => b.score - a.score);
  const b = cands[0];
  const camelot = b.mode === 'major' ? `${CAMELOT_MAJOR[b.tonic]}B` : `${CAMELOT_MINOR[b.tonic]}A`;
  return {
    key: `${NOTES[b.tonic]}${b.mode === 'minor' ? 'm' : ''}`,
    camelot,
    keyConfidence: +Math.max(0, Math.min(1, (b.score - cands[1].score) * 4)).toFixed(2),
  };
}

// ---------- audible bounds ----------
export const ANALYSIS_VERSION = 2;
export const SILENCE_DB = -45;
/** first/last moment the signal is above SILENCE_DB (RMS over 50 ms windows). Seconds. */
export function audioBounds(x, sr = SR, thresholdDb = SILENCE_DB) {
  const w = Math.max(1, Math.round(sr * 0.05)), n = Math.floor(x.length / w);
  const thr = Math.pow(10, thresholdDb / 10) * w; // compare sum of squares against power threshold
  const loud = (k) => { let s = 0; for (let i = k * w, e = i + w; i < e; i++) s += x[i] * x[i]; return s >= thr; };
  let a = 0; while (a < n && !loud(a)) a++;
  if (a >= n) return { audioStart: 0, audioEnd: +(x.length / sr).toFixed(2) };
  let b = n - 1; while (b > a && !loud(b)) b--;
  return { audioStart: +((a * w) / sr).toFixed(2), audioEnd: +Math.min(x.length / sr, ((b + 1) * w) / sr).toFixed(2) };
}
/** Cap the outro / mix-out so at least 16 bars of audible music follow it (phrase-aligned). Mutates + returns st. */
export function capMixOut(st, { bpm, firstBeat, audioEnd }) {
  if (!bpm || audioEnd == null || st.outroStartBar == null) return st;
  const bar = (60 / bpm) * 4;
  const endBars = Math.floor((audioEnd - (firstBeat || 0)) / bar);
  if (endBars - st.outroStartBar >= 16) return st;
  const ob = Math.max(0, Math.floor((endBars - 16) / 8) * 8);
  const t = +((firstBeat || 0) + ob * bar).toFixed(2);
  st.outroStartBar = ob; st.outroStart = t; st.mixOut = t;
  return st;
}

// ---------- structure ----------
export function structure(x, xl, bpm, firstBeat, duration, audioEnd = duration) {
  const bar = (60 / bpm) * 4;
  const nBars = Math.floor((duration - firstBeat) / bar);
  const rms = [], low = [];
  for (let j = 0; j < nBars; j++) {
    const a = Math.floor((firstBeat + j * bar) * SR), b = Math.min(x.length, Math.floor((firstBeat + (j + 1) * bar) * SR));
    let s = 0, sl = 0;
    for (let i = a; i < b; i++) { s += x[i] * x[i]; sl += xl[i] * xl[i]; }
    rms.push(Math.sqrt(s / Math.max(1, b - a)));
    low.push(Math.sqrt(sl / Math.max(1, b - a)));
  }
  const loudLow = pct(low, 0.75) || 1e-9, loud = pct(rms, 0.75) || 1e-9;
  const isFull = (j) => low[j] >= 0.55 * loudLow && rms[j] >= 0.6 * loud;
  let introEnd = 0; while (introEnd < nBars && !isFull(introEnd)) introEnd++;
  const audBars = Math.min(nBars, Math.floor((audioEnd - firstBeat) / bar));
  let lastFull = audBars - 1; while (lastFull > 0 && !isFull(lastFull)) lastFull--;
  let outroStart = Math.floor((lastFull + 1) / 8) * 8;
  if (audBars - outroStart < 16) outroStart = Math.max(0, Math.floor((audBars - 16) / 8) * 8);
  const breakdowns = [];
  for (let j = introEnd; j < lastFull; ) {
    if (low[j] < 0.35 * loudLow) {
      let k = j; while (k < lastFull && low[k] < 0.35 * loudLow) k++;
      if (k - j >= 4) breakdowns.push({ startBar: j, endBar: k, start: +(firstBeat + j * bar).toFixed(2), drop: +(firstBeat + k * bar).toFixed(2) });
      j = k;
    } else j++;
  }
  const phrases = [];
  for (let j = 0; j < nBars; j += 8) {
    const seg = rms.slice(j, j + 8);
    phrases.push(+Math.min(1, seg.reduce((a, b) => a + b, 0) / seg.length / loud).toFixed(2));
  }
  const t = (b) => +(firstBeat + b * bar).toFixed(2);
  return {
    bars: nBars,
    introEndBar: introEnd, introEnd: t(introEnd),
    outroStartBar: outroStart, outroStart: t(outroStart),
    mixIn: t(0), mixOut: t(outroStart),
    breakdowns, phraseEnergy: phrases,
  };
}

function overview(x, xl, points = 800) {
  const step = Math.max(1, Math.floor(x.length / points));
  const peaks = [], lows = [];
  for (let p = 0; p < points; p++) {
    let m = 0, ml = 0;
    for (let i = p * step, e = Math.min(x.length, i + step); i < e; i++) {
      const a = Math.abs(x[i]); if (a > m) m = a;
      const b = Math.abs(xl[i]); if (b > ml) ml = b;
    }
    peaks.push(+m.toFixed(3)); lows.push(+ml.toFixed(3));
  }
  return { peaks, lows };
}

export async function analyzeFile(file, { targetLoudnessDb = -10, grid = null } = {}) {
  const [x, probe] = await Promise.all([decodeMono(file), probeTags(file)]);
  const duration = x.length / SR;
  if (duration < 5) throw new Error('track too short');
  const xl = lowpass(x, 150);
  const eLow = frameEnergy(xl), eFull = frameEnergy(x);
  const oLow = onsetEnvelope(eLow), oFull = onsetEnvelope(eFull);
  const o = new Float32Array(oLow.length);
  for (let i = 0; i < o.length; i++) o[i] = oLow[i] + 0.5 * oFull[i];
  const tempo = estimateTempo(o);
  const beat = 60 / tempo.bpm;

  // downbeat heuristic: assume the first beat with real low end starts a bar
  const beatLowRms = (t) => {
    const a = Math.floor(t * SR), b = Math.min(xl.length, Math.floor((t + beat) * SR));
    let s = 0; for (let i = a; i < b; i++) s += xl[i] * xl[i];
    return Math.sqrt(s / Math.max(1, b - a));
  };
  const beatTimes = []; for (let t = tempo.phaseSec; t < duration - beat; t += beat) beatTimes.push(t);
  const lowLevels = beatTimes.map(beatLowRms);
  const ref = pct(lowLevels, 0.8);
  let firstKickIdx = lowLevels.findIndex((v) => v >= 0.4 * ref);
  if (firstKickIdx < 0) firstKickIdx = 0;
  const detected = { bpm: tempo.bpm, firstBeat: +beatTimes[firstKickIdx % 4].toFixed(4) };
  // manual grid corrections (dj grid) survive re-analysis
  const g = grid ? applyGridEdit(detected, grid) : detected;
  const firstBeat = g.firstBeat;
  tempo.bpm = g.bpm;

  let sum = 0; for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  const rmsDb = 10 * Math.log10(sum / x.length + 1e-12);
  const gainDb = Math.max(-12, Math.min(9, targetLoudnessDb - rmsDb));

  const bounds = audioBounds(x);
  const st = structure(x, xl, tempo.bpm, firstBeat, duration, bounds.audioEnd);
  const key = estimateKey(x);

  const onsetDensity = o.reduce((a, b) => a + b, 0) / o.length;
  const eRaw = ((rmsDb + 24) / 14) * 0.45 + Math.min(1, onsetDensity * 6) * 0.25 + Math.min(1, (tempo.bpm - 80) / 90) * 0.3;
  const energy = Math.max(1, Math.min(10, Math.round(1 + eRaw * 9)));

  const tags = probe.tags || {};
  return {
    duration: +duration.toFixed(2),
    title: tags.title || null,
    artist: tags.artist || tags.album_artist || null,
    genre: tags.genre || null,
    bpm: tempo.bpm,
    bpmConfidence: +tempo.confidence.toFixed(2),
    firstBeat,
    firstKick: +beatTimes[firstKickIdx].toFixed(2),
    ...key,
    rmsDb: +rmsDb.toFixed(1),
    gainDb: +gainDb.toFixed(1),
    energy,
    ...st,
    ...bounds,
    waveform: overview(x, xl),
    ...(grid ? { gridDetected: detected, gridEdit: grid } : {}),
    ...deepAnalysis(x, xl, o, { bpm: tempo.bpm, firstBeat, duration }),
    analyzedAt: new Date().toISOString(),
    analysisVersion: ANALYSIS_VERSION,
  };
}

// ================================================================ grid refinement + structure features
// STRUCT_VERSION bumps trigger a cheap background backfill (one decode per track, no re-analysis).
export const STRUCT_VERSION = 1;
const round = (v, d = 2) => +v.toFixed(d);

/** combined low + full-band onset envelope (same recipe as the tempo estimator) */
export function onsetsOf(x, xl) {
  const oLow = onsetEnvelope(frameEnergy(xl)), oFull = onsetEnvelope(frameEnergy(x));
  const o = new Float32Array(oLow.length);
  for (let i = 0; i < o.length; i++) o[i] = oLow[i] + 0.5 * oFull[i];
  return o;
}

/**
 * Manual grid correction on top of the detected grid.
 * edit = { shiftBeats, nudgeMs, bpm } (cumulative). The downbeat stays inside the first bar.
 */
export function applyGridEdit(detected, edit = {}) {
  const bpm = Number(edit.bpm) || detected.bpm;
  const beat = 60 / bpm, bar = 4 * beat;
  let fb = detected.firstBeat + (Number(edit.shiftBeats) || 0) * beat + (Number(edit.nudgeMs) || 0) / 1000;
  while (fb < 0) fb += bar;
  while (fb >= bar + 0.001 && fb - bar >= 0) fb -= bar;
  return { bpm: round(bpm, 3), firstBeat: round(fb, 4) };
}

/**
 * Local tempo tracker around the constant grid. For every bar, find the offset (±45 ms around the
 * previous bar's) that best lines 8 beats up with onsets; bars without clear beats hold the last value.
 * Returns the per-bar offsets, `drift` (max |offset| in ms), gridStable, and a compact beatMap:
 * [{startBeat, time, bpm}] piecewise-constant segments (one segment when the grid is stable).
 */
export function trackBeats(o, bpm, firstBeat, duration) {
  const P = 60 / bpm, nBars = Math.max(0, Math.floor((duration - firstBeat) / (4 * P)));
  const single = [{ startBeat: 0, time: round(firstBeat, 4), bpm }];
  if (nBars < 8) return { beatMap: single, gridStable: true, drift: 0 };
  const os = new Float32Array(o.length);
  for (let i = 1; i < o.length - 1; i++) os[i] = (o[i - 1] + 2 * o[i] + o[i + 1]) / 4;
  let mean = 0; for (const v of os) mean += v; mean = mean / os.length || 1e-9;
  // Per bar: comb score of a 16-beat window vs offset (±150 ms). Then a Viterbi path through the offsets
  // with a continuity penalty and a prior toward the global grid, so dense masters with strong off-beat
  // onsets don't fake drift; only sustained, clear evidence (live drums, unquantised edits) moves it.
  const R = 0.15, STEP = 0.002, W = 8, NS = Math.round((2 * R) / STEP) + 1;
  const LAMBDA = 0.05, MU = 0.012; // per ms
  const em = [], confident = [];
  for (let b = 0; b < nBars; b++) {
    const sc = new Float64Array(NS);
    let best = 0, sum = 0;
    for (let k = 0; k < NS; k++) {
      const d = -R + k * STEP;
      let s = 0;
      for (let j = 4 * b + 2 - W; j < 4 * b + 2 + W; j++) if (j >= 0) s += interp(os, (firstBeat + j * P + d) * FPS);
      sc[k] = s; sum += s; if (s > best) best = s;
    }
    const peaky = best / (sum / NS + 1e-12), strength = best / (2 * W * mean);
    const c = strength > 1.2 ? Math.min(2, Math.max(0, peaky - 1)) : 0;
    confident.push(c > 0.4);
    for (let k = 0; k < NS; k++) sc[k] = best > 0 ? (c * sc[k]) / best : 0;
    em.push(sc);
  }
  const ms = (k) => Math.abs(-R + k * STEP) * 1000;
  let V = Float64Array.from(em[0], (e, k) => e - MU * ms(k));
  const back = [];
  for (let b = 1; b < nBars; b++) {
    const nv = new Float64Array(NS), bk = new Int16Array(NS);
    for (let k = 0; k < NS; k++) {
      let bv = -Infinity, bi = 0;
      for (let p = Math.max(0, k - 25); p <= Math.min(NS - 1, k + 25); p++) { // ≤50 ms jump per bar
        const v = V[p] - LAMBDA * Math.abs(k - p) * STEP * 1000;
        if (v > bv) { bv = v; bi = p; }
      }
      nv[k] = bv + em[b][k] - MU * ms(k); bk[k] = bi;
    }
    back.push(bk); V = nv;
  }
  let k = V.indexOf(Math.max(...V));
  const path = new Array(nBars);
  for (let b = nBars - 1; b >= 0; b--) { path[b] = -R + k * STEP; if (b > 0) k = back[b - 1][k]; }
  const known = path.map((v, i) => [i, v]).filter(([i]) => confident[i]);
  if (known.length < 4) return { beatMap: single, gridStable: true, drift: 0, gridConfidence: 0 };
  const sm = path;
  const absd = known.map(([i]) => Math.abs(sm[i])).sort((x, y) => x - y);
  const drift = absd[Math.floor(0.9 * (absd.length - 1))] * 1000; // 90th pct: one odd bar is not drift
  const gridStable = drift <= 20;
  const out = { gridStable, drift: round(drift, 1), gridConfidence: round(known.length / nBars) };
  if (gridStable) return { ...out, beatMap: single };
  // piecewise-linear fit of downbeat times, 4 ms tolerance
  const T = sm.map((d, k) => firstBeat + 4 * k * P + d);
  const fits = (s, e) => { for (let k = s + 1; k < e; k++) { const lin = T[s] + ((T[e] - T[s]) * (k - s)) / (e - s); if (Math.abs(T[k] - lin) > 0.004) return false; } return true; };
  const map = [];
  for (let s = 0; s < nBars - 1; ) {
    let e = s + 1;
    while (e + 1 < nBars && fits(s, e + 1)) e++;
    map.push({ startBeat: 4 * s, time: round(T[s], 4), bpm: round((240 * (e - s)) / (T[e] - T[s]), 3) });
    s = e;
  }
  return { ...out, beatMap: map };
}

/** per-bar loudness + bass (relative to the track's 75th percentile) and per-8-bar-phrase chroma */
export function barFeatures(x, xl, bpm, firstBeat, duration) {
  const bar = (60 / bpm) * 4, nBars = Math.max(0, Math.floor((duration - firstBeat) / bar));
  const rms = [], low = [];
  for (let j = 0; j < nBars; j++) {
    const a = Math.max(0, Math.floor((firstBeat + j * bar) * SR)), b = Math.min(x.length, Math.floor((firstBeat + (j + 1) * bar) * SR));
    let s = 0, sl = 0;
    for (let i = a; i < b; i++) { s += x[i] * x[i]; sl += xl[i] * xl[i]; }
    rms.push(Math.sqrt(s / Math.max(1, b - a))); low.push(Math.sqrt(sl / Math.max(1, b - a)));
  }
  const loud = pct(rms, 0.75) || 1e-9, loudLow = pct(low, 0.75) || 1e-9;
  const phraseChroma = [];
  for (let j = 0; j < nBars; j += 8) {
    const a = Math.max(0, Math.floor((firstBeat + j * bar) * SR)), b = Math.min(x.length, Math.floor((firstBeat + Math.min(nBars, j + 8) * bar) * SR));
    const c = b - a >= 4096 ? chroma(x.subarray(a, b), 4096, 110, 2500) : new Float64Array(12);
    const tot = c.reduce((p, v) => p + v, 0) || 1;
    phraseChroma.push(Array.from(c, (v) => round(v / tot, 3)));
  }
  return {
    barEnergy: rms.map((v) => round(Math.min(2, v / loud))),
    barBass: low.map((v) => round(Math.min(2, v / loudLow))),
    phraseChroma,
  };
}

export function deepAnalysis(x, xl, o, { bpm, firstBeat, duration }) {
  return { ...trackBeats(o, bpm, firstBeat, duration), ...barFeatures(x, xl, bpm, firstBeat, duration), structVersion: STRUCT_VERSION };
}

/**
 * Cheap refinement of an already-analysed track: one decode, then
 *  - audible bounds / mix-out cap (analysis v1 → v2),
 *  - optional grid correction (recomputes intro/outro/breakdowns/phrase energy on the new grid),
 *  - beat map + drift + per-bar features for section labels.
 * Returns only the fields to merge into the track.
 */
export async function refineTrack(t, { grid = null } = {}) {
  const x = await decodeMono(t.file);
  const duration = x.length / SR;
  const out = {};
  if ((t.analysisVersion || 1) < ANALYSIS_VERSION || t.audioEnd == null) {
    Object.assign(out, audioBounds(x), { analysisVersion: ANALYSIS_VERSION });
    Object.assign(out, capMixOut({ outroStartBar: t.outroStartBar, outroStart: t.outroStart, mixOut: t.mixOut }, { ...t, ...out }));
  }
  const xl = lowpass(x, 150);
  let bpm = t.bpm, firstBeat = t.firstBeat;
  if (grid) {
    const detected = t.gridDetected || { bpm: t.bpm, firstBeat: t.firstBeat };
    ({ bpm, firstBeat } = applyGridEdit(detected, grid));
    const audioEnd = out.audioEnd ?? t.audioEnd ?? duration;
    Object.assign(out, { bpm, firstBeat, gridDetected: detected, gridEdit: grid }, structure(x, xl, bpm, firstBeat, duration, audioEnd));
  }
  Object.assign(out, deepAnalysis(x, xl, onsetsOf(x, xl), { bpm, firstBeat, duration }));
  return out;
}
