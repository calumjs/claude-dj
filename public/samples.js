// Claude DJ — sampler one-shots, synthesised in code (no files, no speech synthesis).
// Pure functions: synth(kind, sr, opts) -> { L: Float32Array, R: Float32Array, name }.
// Runs on the main thread when the engine starts and in the Node tests.

export const PAD_KINDS = ['horn', 'riser', 'boom', 'siren', 'zap', 'hey'];
export const PAD_NAMES = { horn: 'AIR HORN', riser: 'RISER', boom: 'BOOM', siren: 'SIREN', zap: 'LASER', hey: 'HEY!' };

const TAU = Math.PI * 2;
function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** band-limited saw via polyBLEP */
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
class Saw {
  constructor(phase = 0) { this.p = phase; }
  next(freq, sr) { const dt = freq / sr; this.p += dt; if (this.p >= 1) this.p -= 1; return 2 * this.p - 1 - blep(this.p, dt); }
}
/** RBJ biquad (bandpass constant 0 dB peak, lowpass, highpass) with per-call coefficient updates */
class Biquad {
  constructor() { this.x1 = this.x2 = this.y1 = this.y2 = 0; this.set('lp', 1000, 0.7, 48000); }
  set(type, f, q, sr) {
    const w = (TAU * Math.min(f, sr * 0.45)) / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
    let b0, b1, b2;
    if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; }
    else if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
    else { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; }
    const a0 = 1 + al;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = (-2 * cs) / a0; this.a2 = (1 - al) / a0;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}
const buf = (sr, sec) => ({ L: new Float32Array(Math.round(sr * sec)), R: new Float32Array(Math.round(sr * sec)) });
function normalize(o, peak = 0.9) {
  let m = 0;
  for (const ch of [o.L, o.R]) for (const v of ch) { const a = Math.abs(v); if (a > m) m = a; }
  if (m > 0) { const k = peak / m; for (const ch of [o.L, o.R]) for (let i = 0; i < ch.length; i++) ch[i] *= k; }
  // 3 ms fade in/out so pads never click
  const n = Math.min(o.L.length >> 1, Math.round(o.L.length > 0 ? 0.003 * (o.sr || 48000) : 0));
  for (let i = 0; i < n; i++) { const g = i / n; for (const ch of [o.L, o.R]) { ch[i] *= g; ch[ch.length - 1 - i] *= g; } }
  return o;
}

// ------------------------------------------------------------------ the one-shots
/** reggae/dancehall air horn: three blasts of a detuned brassy cluster */
function horn(sr) {
  const o = buf(sr, 1.45); o.sr = sr;
  const blasts = [[0, 0.17], [0.22, 0.17], [0.44, 0.9]];
  const voices = [[440, 0], [443.5, 0.3], [659, 0.6], [880.8, 0.15], [587, 0.45]];
  const lvl = [1, 0.9, 0.55, 0.3, 0.35];
  const oscL = voices.map(([, ph]) => new Saw(ph)), oscR = voices.map(([, ph]) => new Saw((ph + 0.37) % 1));
  const lpL = new Biquad(), lpR = new Biquad(); lpL.set('lp', 3800, 0.9, sr); lpR.set('lp', 3600, 0.9, sr);
  for (let i = 0; i < o.L.length; i++) {
    const t = i / sr;
    let env = 0, bend = 1;
    for (let b = 0; b < blasts.length; b++) {
      const [s, d] = blasts[b], x = t - s;
      if (x >= 0 && x < d + 0.04) {
        env = Math.min(1, x / 0.008) * (x > d ? Math.max(0, 1 - (x - d) / 0.04) : 1);
        bend = 0.93 + 0.07 * Math.min(1, x / 0.03); // lip-up at the attack
        if (b === 2 && x > d - 0.25) bend *= 1 - 0.035 * ((x - (d - 0.25)) / 0.25); // droop at the end
      }
    }
    let l = 0, r = 0;
    for (let v = 0; v < voices.length; v++) { l += lvl[v] * oscL[v].next(voices[v][0] * bend, sr); r += lvl[v] * oscR[v].next(voices[v][0] * bend * 1.002, sr); }
    o.L[i] = Math.tanh(1.8 * lpL.run(l * env * 0.35));
    o.R[i] = Math.tanh(1.8 * lpR.run(r * env * 0.35));
  }
  return normalize(o);
}

/** white-noise riser: resonant band sweep + rising tone, `seconds` long (defaults to 8 beats at 128) */
function riser(sr, { seconds = 3.75 } = {}) {
  const o = buf(sr, seconds); o.sr = sr;
  const rl = rng(7), rr = rng(11);
  const bl = new Biquad(), br = new Biquad();
  const tone = new Saw(0);
  let ph = 0;
  for (let i = 0; i < o.L.length; i++) {
    const x = i / o.L.length;
    const fc = 150 * Math.pow(9000 / 150, x * x * 0.4 + x * 0.6);
    if ((i & 31) === 0) { bl.set('bp', fc, 2.2, sr); br.set('bp', fc * 1.03, 2.2, sr); }
    const amp = x * x * (x > 0.985 ? (1 - x) / 0.015 : 1);
    const ft = 180 * Math.pow(8, x);
    ph += ft / sr;
    const t = 0.12 * tone.next(ft, sr) + 0.18 * Math.sin(TAU * ph);
    o.L[i] = amp * (bl.run(rl() * 2 - 1) * 1.6 + t);
    o.R[i] = amp * (br.run(rr() * 2 - 1) * 1.6 + t);
  }
  return normalize(o);
}

/** impact / boom: pitched-down sub sine with a noise transient */
function boom(sr) {
  const o = buf(sr, 2.0); o.sr = sr;
  const r = rng(3), lp = new Biquad(); lp.set('lp', 2400, 0.7, sr);
  let ph = 0;
  for (let i = 0; i < o.L.length; i++) {
    const t = i / sr;
    const f = 38 + 95 * Math.exp(-t / 0.09);
    ph += f / sr;
    const body = Math.sin(TAU * ph) * Math.exp(-t / 0.55);
    const click = t < 0.03 ? lp.run(r() * 2 - 1) * (1 - t / 0.03) * 0.9 : lp.run(0);
    const tail = Math.sin(TAU * ph * 0.5) * 0.25 * Math.exp(-t / 0.9);
    const v = Math.tanh(2.2 * (body + tail) + click);
    o.L[i] = v; o.R[i] = v;
  }
  return normalize(o);
}

/** dub siren: rising sweeps with a feedback echo */
function siren(sr) {
  const o = buf(sr, 2.6); o.sr = sr;
  const dl = Math.round(0.19 * sr), echoL = new Float32Array(dl), echoR = new Float32Array(Math.round(0.23 * sr));
  let ph = 0, eiL = 0, eiR = 0;
  for (let i = 0; i < o.L.length; i++) {
    const t = i / sr;
    const lfo = (t * 4.5) % 1; // rising saw sweeps
    const f = 620 * Math.pow(2, lfo * 0.9);
    ph += f / sr;
    const env = t < 1.6 ? Math.min(1, t / 0.01) : Math.max(0, 1 - (t - 1.6) / 0.05);
    const dry = env * (Math.sin(TAU * ph) + 0.25 * Math.sin(3 * TAU * ph)) * 0.6;
    const el = echoL[eiL], er = echoR[eiR];
    echoL[eiL] = dry + el * 0.45; echoR[eiR] = dry + er * 0.42;
    eiL = (eiL + 1) % echoL.length; eiR = (eiR + 1) % echoR.length;
    o.L[i] = dry + 0.55 * el; o.R[i] = dry + 0.55 * er;
  }
  return normalize(o);
}

/** laser zap: fast exponential pitch dive, twice */
function zap(sr) {
  const o = buf(sr, 0.62); o.sr = sr;
  const shots = [[0, 1], [0.27, 0.8]];
  const phs = [0, 0];
  for (let i = 0; i < o.L.length; i++) {
    const t = i / sr;
    let l = 0, r = 0;
    shots.forEach(([s, g], k) => {
      const x = t - s;
      if (x < 0 || x > 0.26) return;
      const f = 90 + 2900 * Math.exp(-x / 0.045) * (k ? 0.85 : 1);
      phs[k] += f / sr;
      const v = g * Math.tanh(3 * Math.sin(TAU * phs[k])) * Math.exp(-x / 0.09) * Math.min(1, x / 0.002);
      l += v * (k ? 0.7 : 1); r += v * (k ? 1 : 0.7);
    });
    o.L[i] = l; o.R[i] = r;
  }
  return normalize(o);
}

/** crowd "HEY!": formant-synthesised shout (h-aspiration into an "eh-ee" diphthong), 4 voices */
function hey(sr) {
  const o = buf(sr, 0.5); o.sr = sr;
  const voices = [[172, 0.000, -0.6], [196, 0.012, 0.5], [224, 0.020, -0.2], [148, 0.006, 0.8]];
  for (const [f0, delay, pan] of voices) {
    const r = rng(Math.round(f0));
    const saw = new Saw(r());
    const fm = [new Biquad(), new Biquad(), new Biquad()];
    const gl = Math.cos(((pan + 1) * Math.PI) / 4), gr = Math.sin(((pan + 1) * Math.PI) / 4);
    let lp = 0;
    for (let i = 0; i < o.L.length; i++) {
      const t = i / sr - delay;
      if (t < 0) continue;
      const vx = Math.min(1, Math.max(0, (t - 0.06) / 0.28)); // vowel glide e -> i
      if ((i & 15) === 0) {
        fm[0].set('bp', 560 - 190 * vx, 6, sr);
        fm[1].set('bp', 1800 + 450 * vx, 10, sr);
        fm[2].set('bp', 2600 + 200 * vx, 12, sr);
      }
      const asp = t < 0.07 ? 1 - t / 0.07 : 0; // "h"
      const voiced = t < 0.05 ? 0 : Math.min(1, (t - 0.05) / 0.02) * (t > 0.34 ? Math.max(0, 1 - (t - 0.34) / 0.07) : 1);
      const f = f0 * (1.08 - 0.14 * Math.min(1, t / 0.4)) * (1 + 0.012 * Math.sin(TAU * 5.5 * t));
      lp += 0.35 * (saw.next(f, sr) - lp); // soften the glottal source
      const src = voiced * lp + asp * 0.35 * (r() * 2 - 1) + voiced * 0.04 * (r() * 2 - 1);
      const v = fm[0].run(src) * 1.0 + fm[1].run(src) * 0.7 + fm[2].run(src) * 0.35;
      o.L[i] += v * gl; o.R[i] += v * gr;
    }
  }
  for (let i = 0; i < o.L.length; i++) { o.L[i] = Math.tanh(o.L[i] * 3); o.R[i] = Math.tanh(o.R[i] * 3); }
  return normalize(o);
}

const SYNTHS = { horn, riser, boom, siren, zap, hey };
export function synth(kind, sr, opts = {}) {
  const fn = SYNTHS[kind];
  if (!fn) throw new Error(`unknown sample "${kind}" (${PAD_KINDS.join(', ')})`);
  const o = fn(sr, opts);
  return { L: o.L, R: o.R, name: PAD_NAMES[kind] };
}
