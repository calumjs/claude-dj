// Claude DJ — deck player AudioWorklet and the pure DSP it runs on.
//
// This one file is loaded three ways:
//   1. as the AudioWorklet module (registers 'deck-player' and 'crusher' at the bottom),
//   2. by engine.js on the main thread (PlayheadModel, parseWav, helpers),
//   3. by the Node unit tests in test/.
// Nothing at top level may touch browser/worklet globals.
//
// Timeline contract: the main thread schedules transport events ({t: ctx seconds, type, ...})
// and mirrors them in a PlayheadModel; the worklet applies the very same events sample-accurately
// (DeckVoice). Both use identical rules (loop wrap, end of track, rate curves), so the main-thread
// position() is exact against the audio clock. The worklet also reports its real playhead every
// ~20 ms, which the main thread uses for scratching and as a drift safety net.

export const STEMS = ['vocals', 'drums', 'bass', 'other'];
/** event types dropped by a transport restart (start/pause): rate and loop changes survive */
export const TRANSPORT = ['start', 'stop', 'seek', 'curve', 'handoff'];
/** does a `clear` spec ('all' | type | [types] | 'transport') cover this event type? */
export const clears = (spec, type) => spec === 'all' || spec === type || (spec === 'transport' && TRANSPORT.includes(type)) || (Array.isArray(spec) && spec.includes(type));
const I16 = 1 / 32768;
const tap = (d, n, k, c) => (k >= 0 && k < n ? d[2 * k + c] : 0);

// ------------------------------------------------------------------ WAV parsing
/** Parse a RIFF/WAVE header. Returns {format, channels, sampleRate, bits, dataOffset, frames, declaredFrames} or null. */
export function parseWav(ab) {
  if (!ab || ab.byteLength < 12) return null;
  const dv = new DataView(ab);
  if (dv.getUint32(0, false) !== 0x52494646 || dv.getUint32(8, false) !== 0x57415645) return null;
  let p = 12, fmt = null;
  while (p + 8 <= ab.byteLength) {
    const id = dv.getUint32(p, false), size = dv.getUint32(p + 4, true), body = p + 8;
    if (id === 0x666d7420) { // 'fmt '
      if (body + 16 > ab.byteLength) return null;
      let format = dv.getUint16(body, true);
      const channels = dv.getUint16(body + 2, true), sampleRate = dv.getUint32(body + 4, true), bits = dv.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26 && body + 26 <= ab.byteLength) format = dv.getUint16(body + 24, true);
      fmt = { format, channels, sampleRate, bits };
    } else if (id === 0x64617461) { // 'data'
      if (!fmt) return null;
      const frameBytes = (fmt.channels * fmt.bits) / 8;
      const avail = ab.byteLength - body;
      const declared = size === 0xffffffff || size === 0 ? avail : size;
      return { ...fmt, dataOffset: body, frames: Math.floor(Math.min(declared, avail) / frameBytes), declaredFrames: Math.floor(declared / frameBytes) };
    }
    p = body + size + (size & 1);
  }
  return null;
}

// ------------------------------------------------------------------ small pure helpers
/** Loop wrap rule shared by the model and the worklet (positions in any unit). */
export function wrapLoop(prev, pos, ls, le) {
  if (!(le > ls)) return pos;
  const len = le - ls;
  if (pos >= le && prev < le) return ls + ((pos - ls) % len);
  if (pos < ls && prev >= ls && prev < le) { const m = (ls - pos) % len; return m === 0 ? ls : le - m; }
  return pos;
}

/** Shift a Camelot code by semitones: +1 semitone = +7 steps (mod 12), same letter. */
export function shiftCamelot(code, semis) {
  const m = /^(\d{1,2})([AB])$/.exec(code || '');
  if (!m) return code ?? null;
  const s = Math.round(semis || 0);
  const n = ((((Number(m[1]) - 1 + 7 * s) % 12) + 12) % 12) + 1;
  return `${n}${m[2]}`;
}

/** Scrolling-waveform peaks (full band + bass) from interleaved-stereo Int16 sources (summed). */
export function zoomFromInt16(srcs, frames, sr, perSec = 150) {
  const step = Math.max(1, Math.floor(sr / perSec)), n = Math.floor(frames / step);
  const full = new Float32Array(n), low = new Float32Array(n);
  const a = Math.exp((-2 * Math.PI * 180) / sr), S = srcs.length, k = I16 * 0.5;
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    let m = 0, ml = 0;
    for (let j = i * step, e = j + step; j < e; j++) {
      let x = 0;
      for (let s = 0; s < S; s++) x += srcs[s][2 * j] + srcs[s][2 * j + 1];
      x *= k;
      s1 = (1 - a) * x + a * s1; s2 = (1 - a) * s1 + a * s2;
      const ax = x < 0 ? -x : x; if (ax > m) m = ax;
      const al = s2 < 0 ? -s2 : s2; if (al > ml) ml = al;
    }
    full[i] = m; low[i] = ml;
  }
  return { full, low, perSec: sr / step };
}

// ------------------------------------------------------------------ playhead model (main thread mirror)
/**
 * Deterministic model of a deck's playhead. Events (seconds): start{pos}, stop, seek{pos}, rate{rate},
 * curve{pts:[{t,r}], after}, loop{loop:{start,end}|null}. Rate curves are piecewise linear.
 */
export class PlayheadModel {
  constructor(duration = Infinity) { this.dur = duration; this.reset(0); }
  reset(pos = 0, t = 0) { this.a = { t, pos, playing: false, rate: 1, loop: null, curve: null }; this.ev = []; }
  add(e) {
    let i = this.ev.length;
    while (i > 0 && this.ev[i - 1].t > e.t) i--;
    this.ev.splice(i, 0, e);
  }
  /** drop events after time t (optionally only of one type) */
  clear(t, spec = 'all') { this.ev = this.ev.filter((e) => !(e.t > t && clears(spec, e.type))); }
  static apply(s, e) {
    switch (e.type) {
      case 'start': s.playing = true; s.pos = e.pos; s.curve = null; break;
      case 'stop': s.playing = false; s.curve = null; break;
      case 'seek': s.pos = e.pos; break;
      case 'rate': s.rate = e.rate; s.curve = null; break;
      case 'curve': s.curve = { pts: e.pts, after: e.after ?? e.pts[e.pts.length - 1].r }; break;
      case 'loop': s.loop = e.loop ? { ...e.loop } : null; break;
      default: break;
    }
  }
  advance(s, t1) {
    if (!(t1 > s.t)) return;
    if (!s.playing) { s.t = t1; return; }
    let t = s.t;
    while (t < t1) {
      let r0, r1, tEnd;
      if (s.curve) {
        const P = s.curve.pts;
        if (t < P[0].t) { tEnd = Math.min(t1, P[0].t); r0 = r1 = s.rate; }
        else {
          let k = 0;
          while (k < P.length - 1 && t >= P[k + 1].t) k++;
          if (k >= P.length - 1) { s.rate = s.curve.after; s.curve = null; continue; }
          const A = P[k], B = P[k + 1], lerp = (x) => A.r + ((B.r - A.r) * (x - A.t)) / (B.t - A.t);
          tEnd = Math.min(t1, B.t); r0 = lerp(t); r1 = lerp(tEnd);
        }
      } else { tEnd = t1; r0 = r1 = s.rate; }
      const prev = s.pos;
      let p = prev + ((tEnd - t) * (r0 + r1)) / 2;
      if (s.loop) p = wrapLoop(prev, p, s.loop.start, s.loop.end);
      if (p >= this.dur) { s.pos = this.dur; s.playing = false; s.curve = null; s.t = t1; return; }
      s.pos = p < 0 ? 0 : p;
      t = tEnd;
    }
    s.t = t1;
  }
  stateAt(t) {
    const s = { ...this.a };
    for (const e of this.ev) {
      if (e.t > t) break;
      this.advance(s, e.t);
      PlayheadModel.apply(s, e);
    }
    this.advance(s, t);
    return s;
  }
  position(t) { return this.stateAt(t).pos; }
  /** fold events at or before t into the anchor (keeps the event list short) */
  compact(t) {
    while (this.ev.length && this.ev[0].t <= t) {
      const e = this.ev.shift();
      this.advance(this.a, e.t);
      PlayheadModel.apply(this.a, e);
    }
  }
  /** re-anchor to an observed playhead (drift correction / scratch hand-off) */
  rebase(t, pos, playing) {
    const s = this.stateAt(t);
    s.pos = pos; s.playing = playing; s.curve = null; s.t = t;
    this.a = s;
    this.ev = this.ev.filter((e) => e.t > t);
  }
}

// ------------------------------------------------------------------ the deck voice (runs in the worklet)
/**
 * Plays 1 (full mix) or 4 (stems) interleaved-stereo Int16 sources in lock-step.
 *  - varispeed mode: cubic-Hermite resampling at any rate, including negative (reverse / scratch)
 *  - WSOLA mode (key lock / key shift): 40 ms Hann grains at 50 % overlap, grains resampled by the
 *    pitch ratio and placed by waveform-similarity search, so tempo and pitch are independent.
 * All buffers are preallocated; process() does not allocate (except the periodic report post).
 */
export class DeckVoice {
  constructor(sr) {
    this.sr = sr;
    this.src = []; this.bufs = []; this.S = 0; this.len = 0;
    this.evq = [];
    this.playing = false; this.pos = 0; this.rate = 1; this.stopPos = -1; this.lastR = 0;
    this.cf = null; this.cr = null; this.ci = 0; this.cAfter = 1;
    this.ls = 0; this.le = 0;
    this.env = 0; this.envStep = 1 / Math.max(1, Math.round(0.006 * sr));
    this.keylock = true; this.semis = 0; this.pitch = 1;
    // hand (scratch) follower
    this.hand = false; this.hPos = 0; this.hVel = 0; this.hFrame = 0; this.hv = 0;
    this.hcf = new Float64Array(2); this.hcr = new Float64Array(2);
    this.hTau = 0.016 * sr; this.hAlpha = 1 - Math.exp(-1 / (0.005 * sr)); this.hMaxEx = 0.035 * sr;
    // jump crossfade ("ghost" keeps reading the old place while it fades out)
    this.gLen = Math.max(1, Math.round(0.004 * sr)); this.gN = 0; this.gPos = 0; this.gRate = 0;
    // WSOLA
    const N = 2 * Math.round(0.02 * sr);
    this.N = N; this.Hs = N / 2;
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    this.fin = []; this.tail = [];
    for (let k = 0; k < 8; k++) { this.fin.push(new Float32Array(this.Hs)); this.tail.push(new Float32Array(this.Hs)); }
    this.ri = this.Hs; this.prevStart = 0;
    this.tol = Math.round(0.0125 * sr); this.dec = Math.max(1, Math.round(sr / 12000));
    this.nRef = Math.floor(this.Hs / this.dec);
    this.ref = new Float32Array(this.nRef); this.refIdx = new Int32Array(this.nRef);
    this.maxP = 4;
    this.reg = new Float32Array(2 * this.tol + Math.ceil(this.Hs * this.maxP) + 16);
    this.wmix = 0; this.wStep = 1 / Math.max(1, Math.round(0.01 * sr));
    // reporting
    this.frameNow = 0;
    this.repEvery = Math.round(0.02 * sr); this.repCount = 0;
    this.rep = { type: 'pos', t: 0, pos: 0, playing: false, rate: 0, hand: false };
    this.post = null;
    this._l = 0; this._r = 0;
  }

  // ---- messages from the main thread (may allocate; not in the render loop)
  onMessage(m) {
    const sr = this.sr;
    switch (m.type) {
      case 'load': {
        if (this.bufs.length && this.post) this.post({ type: 'free', bufs: this.bufs }, this.bufs);
        this.bufs = m.bufs;
        this.src = m.bufs.map((b, k) => new Int16Array(b, m.offsets[k], m.frames * 2));
        this.S = this.src.length; this.len = m.frames;
        this.resetTransport();
        break;
      }
      case 'unload':
        if (this.bufs.length && this.post) this.post({ type: 'free', bufs: this.bufs }, this.bufs);
        this.bufs = []; this.src = []; this.S = 0; this.len = 0; this.resetTransport();
        break;
      case 'events': {
        // events already due are applied first: `clear` only drops FUTURE events (same as PlayheadModel.clear(now))
        if (m.clear) while (this.evq.length && this.evq[0].f <= this.frameNow) this.apply(this.evq.shift(), this.frameNow);
        if (m.clear === 'all') this.evq.length = 0;
        else if (m.clear) this.evq = this.evq.filter((e) => !clears(m.clear, e.type));
        for (const e of m.events) {
          const x = { type: e.type, f: Math.round(e.t * sr) };
          if (e.pos != null) x.pos = e.pos * sr;
          if (e.rate != null) x.rate = e.rate;
          if (e.type === 'loop') x.loop = e.loop ? { start: e.loop.start * sr, end: e.loop.end * sr } : null;
          if (e.type === 'curve') {
            x.cf = Float64Array.from(e.pts, (p) => p.t * sr); x.cr = Float64Array.from(e.pts, (p) => p.r);
            x.after = e.after ?? e.pts[e.pts.length - 1].r;
          }
          if (e.type === 'handoff') { x.resume = !!e.resume; x.slip = !!e.slip; }
          let i = this.evq.length;
          while (i > 0 && this.evq[i - 1].f > x.f) i--;
          this.evq.splice(i, 0, x);
        }
        break;
      }
      case 'keylock': this.keylock = !!m.on; break;
      case 'semis': this.semis = m.v; this.pitch = Math.pow(2, m.v / 12); break;
      case 'hand':
        if (m.on) {
          this.hand = true; this.hPos = this.pos; this.hVel = 0; this.hFrame = this.frameNow;
          this.hv = this.playing ? this.lastR : 0;
        }
        break;
      case 'handMove':
        if (this.hand) { this.hPos += m.d * sr; this.hVel = m.vel || 0; this.hFrame = this.frameNow; }
        break;
      default: break;
    }
  }

  resetTransport() {
    this.evq.length = 0; this.playing = false; this.pos = 0; this.rate = 1; this.stopPos = -1;
    this.cf = null; this.ls = this.le = 0; this.env = 0; this.hand = false; this.gN = 0; this.wmix = 0; this.ri = this.Hs;
  }

  // ---- source reading
  /** cubic-Hermite stereo read of stem s at fractional frame x -> this._l / this._r */
  rd(s, x) {
    const d = this.src[s], n = this.len;
    const i = Math.floor(x), f = x - i;
    let l0, l1, l2, l3, r0, r1, r2, r3;
    if (i >= 1 && i + 2 < n) {
      const j = 2 * i;
      l0 = d[j - 2]; r0 = d[j - 1]; l1 = d[j]; r1 = d[j + 1]; l2 = d[j + 2]; r2 = d[j + 3]; l3 = d[j + 4]; r3 = d[j + 5];
    } else {
      if (i < -2 || i > n) { this._l = 0; this._r = 0; return; }
      l0 = tap(d, n, i - 1, 0); r0 = tap(d, n, i - 1, 1); l1 = tap(d, n, i, 0); r1 = tap(d, n, i, 1);
      l2 = tap(d, n, i + 1, 0); r2 = tap(d, n, i + 1, 1); l3 = tap(d, n, i + 2, 0); r3 = tap(d, n, i + 2, 1);
    }
    this._l = ((((0.5 * (l3 - l0) + 1.5 * (l1 - l2)) * f + (l0 - 2.5 * l1 + 2 * l2 - 0.5 * l3)) * f + 0.5 * (l2 - l0)) * f + l1) * I16;
    this._r = ((((0.5 * (r3 - r0) + 1.5 * (r1 - r2)) * f + (r0 - 2.5 * r1 + 2 * r2 - 0.5 * r3)) * f + 0.5 * (r2 - r0)) * f + r1) * I16;
  }
  mono(j) {
    if (j < 0 || j >= this.len) return 0;
    let x = 0;
    for (let s = 0; s < this.S; s++) x += this.src[s][2 * j] + this.src[s][2 * j + 1];
    return x;
  }

  // ---- WSOLA
  wReset(p) {
    const Hs = this.Hs, start = this.pos - p * Hs;
    for (let s = 0; s < this.S; s++) {
      const tl = this.tail[2 * s], tr = this.tail[2 * s + 1];
      for (let i = 0; i < Hs; i++) { this.rd(s, start + (Hs + i) * p); const w = this.win[Hs + i]; tl[i] = w * this._l; tr[i] = w * this._r; }
    }
    this.prevStart = start; this.ri = Hs;
  }
  wSearch(natural, nominal, p) {
    const tol = this.tol, dec = this.dec, nRef = this.nRef, ref = this.ref, reg = this.reg, idx = this.refIdx;
    let eRef = 0;
    for (let k = 0; k < nRef; k++) { const v = this.mono(Math.round(natural + k * dec * p)); ref[k] = v; eRef += v * v; }
    if (eRef < 1) return nominal; // silence: nothing to align
    const base = Math.round(nominal) - tol;
    const span = Math.min(reg.length, 2 * tol + Math.ceil(nRef * dec * p) + 2);
    for (let j = 0; j < span; j++) reg[j] = this.mono(base + j);
    for (let k = 0; k < nRef; k++) { const q = Math.round(k * dec * p); idx[k] = q; }
    const maxO = Math.min(2 * tol, span - 1 - idx[nRef - 1]);
    let best = tol, bestS = -Infinity;
    for (let o = 0; o <= maxO; o += dec) {
      let c = 0, e = 0;
      for (let k = 0; k < nRef; k++) { const v = reg[o + idx[k]]; c += ref[k] * v; e += v * v; }
      const sc = c / Math.sqrt(e + 1);
      if (sc > bestS) { bestS = sc; best = o; }
    }
    const lo = Math.max(0, best - dec + 1), hi = Math.min(maxO, best + dec - 1);
    for (let o = lo; o <= hi; o++) {
      if ((o - best) % dec === 0) continue;
      let c = 0, e = 0;
      for (let k = 0; k < nRef; k++) { const v = reg[o + idx[k]]; c += ref[k] * v; e += v * v; }
      const sc = c / Math.sqrt(e + 1);
      if (sc > bestS) { bestS = sc; best = o; }
    }
    return base + best;
  }
  wGrain(r, p) {
    const Hs = this.Hs, N = this.N, win = this.win;
    let center = this.pos + r * Hs;
    center = wrapLoop(this.pos, center, this.ls, this.le);
    const nominal = center - p * Hs;
    const start = this.wSearch(this.prevStart + p * Hs, nominal, p);
    for (let s = 0; s < this.S; s++) {
      const fl = this.fin[2 * s], fr = this.fin[2 * s + 1], tl = this.tail[2 * s], tr = this.tail[2 * s + 1];
      for (let i = 0; i < Hs; i++) { this.rd(s, start + i * p); const w = win[i]; fl[i] = tl[i] + w * this._l; fr[i] = tr[i] + w * this._r; }
      for (let i = Hs; i < N; i++) { this.rd(s, start + i * p); const w = win[i]; tl[i - Hs] = w * this._l; tr[i - Hs] = w * this._r; }
    }
    this.prevStart = start; this.ri = 0;
  }

  curveRate(f) {
    const cf = this.cf;
    if (f < cf[0]) return this.rate;
    while (this.ci < cf.length - 1 && f >= cf[this.ci + 1]) this.ci++;
    if (this.ci >= cf.length - 1) { this.rate = this.cAfter; this.cf = null; return this.rate; }
    const k = this.ci;
    return this.cr[k] + ((this.cr[k + 1] - this.cr[k]) * (f - cf[k])) / (cf[k + 1] - cf[k]);
  }
  ghost() { this.gPos = this.pos; this.gRate = this.lastR; this.gN = this.gLen; }
  curP(r) { return this.keylock ? this.pitch : r * this.pitch; }

  apply(e, f) {
    const late = f > e.f ? f - e.f : 0;
    switch (e.type) {
      case 'start': {
        if (this.env > 0) this.ghost(); else this.env = 0;
        this.cf = null; this.playing = true; this.stopPos = -1;
        this.pos = e.pos + late * this.rate;
        if (this.wmix > 0) this.wReset(this.curP(this.rate));
        break;
      }
      case 'stop':
        if (this.playing) { this.playing = false; this.stopPos = Math.max(0, this.pos - late * this.rate); }
        this.cf = null;
        break;
      case 'seek':
        if (this.playing || this.hand) {
          if (this.env > 0) this.ghost();
          this.pos = e.pos + (this.playing && !this.hand ? late * this.rate : 0);
          if (this.hand) this.hPos = this.pos;
          if (this.wmix > 0) this.wReset(this.curP(this.rate));
        } else if (this.stopPos >= 0) this.stopPos = e.pos;
        else this.pos = e.pos;
        break;
      case 'rate':
        if (this.playing && !this.cf) this.pos += late * (e.rate - this.rate);
        this.rate = e.rate; this.cf = null;
        break;
      case 'curve': this.cf = e.cf; this.cr = e.cr; this.ci = 0; this.cAfter = e.after; break;
      case 'loop':
        if (e.loop) { this.ls = e.loop.start; this.le = e.loop.end; } else { this.ls = 0; this.le = 0; }
        break;
      case 'handoff': {
        const vel = this.hv;
        this.hand = false;
        if (e.resume) {
          this.playing = true; this.stopPos = -1;
          if (!e.slip) {
            // motor spin-up from the hand's speed back to the deck's rate (preallocated curve)
            this.hcf[0] = f; this.hcf[1] = f + 0.08 * this.sr; this.hcr[0] = vel; this.hcr[1] = this.rate;
            this.cf = this.hcf; this.cr = this.hcr; this.ci = 0; this.cAfter = this.rate;
          }
        } else { this.playing = false; this.stopPos = this.pos; }
        if (this.post) this.post({ type: 'handoff', t: f / this.sr, pos: this.pos / this.sr, vel, resume: e.resume, slip: e.slip });
        break;
      }
      default: break;
    }
  }

  /**
   * Render n frames. gains: array of per-stem Float32Arrays (length n or 1) or null.
   * frame0: global frame index of the first sample (AudioWorkletGlobalScope.currentFrame).
   */
  process(L, R, n, frame0, gains) {
    if (this.S === 0) { L.fill(0); if (R !== L) R.fill(0); this.frameNow = frame0 + n; return; }
    const S = this.S, Hs = this.Hs;
    for (let i = 0; i < n; i++) {
      const f = frame0 + i;
      while (this.evq.length && this.evq[0].f <= f) this.apply(this.evq.shift(), f);
      if (!this.playing && !this.hand && this.env <= 0) { L[i] = 0; R[i] = 0; continue; }
      // ---- rate for this sample
      let r;
      if (this.hand) {
        // predict the hand between pointer events; the prediction decays back to the last real
        // hand position if no new event arrives (hand stopped), so it never overshoots for long
        let ex = f - this.hFrame, mx = this.hMaxEx;
        if (ex < 0) ex = 0;
        else if (ex > mx) { ex = mx * (2 - ex / mx); if (ex < 0) ex = 0; }
        let want = (this.hPos + this.hVel * ex - this.pos) / this.hTau;
        if (want > 12) want = 12; else if (want < -12) want = -12;
        this.hv += (want - this.hv) * this.hAlpha;
        r = this.hv;
      } else if (this.cf) r = this.curveRate(f);
      else r = this.rate;
      this.lastR = r;
      // ---- declick envelope (updated before output so a start lands exactly on its frame)
      if (this.playing || this.hand) { if (this.env < 1) { this.env += this.envStep; if (this.env > 1) this.env = 1; } }
      else { this.env -= this.envStep; if (this.env < 0) this.env = 0; }
      // ---- mode: varispeed or WSOLA (crossfaded over 10 ms)
      let p = this.keylock ? this.pitch : r * this.pitch;
      const wantW = !this.hand && !this.cf && r > 0.25 && r < 4 && p < this.maxP && (p - r > 1e-4 || r - p > 1e-4);
      if (wantW) { if (this.wmix === 0) this.wReset(p); this.wmix += this.wStep; if (this.wmix > 1) this.wmix = 1; }
      else if (this.wmix > 0) { this.wmix -= this.wStep; if (this.wmix < 0) this.wmix = 0; }
      if (p >= this.maxP) p = this.maxP - 0.01;
      let ol = 0, or = 0;
      if (this.wmix < 1) {
        for (let s = 0; s < S; s++) {
          this.rd(s, this.pos);
          const g = S === 1 || !gains ? 1 : gains[s].length > 1 ? gains[s][i] : gains[s][0];
          ol += g * this._l; or += g * this._r;
        }
      }
      if (this.wmix > 0) {
        if (this.ri >= Hs) this.wGrain(r, p);
        let wl = 0, wr = 0;
        const ri = this.ri++;
        for (let s = 0; s < S; s++) {
          const g = S === 1 || !gains ? 1 : gains[s].length > 1 ? gains[s][i] : gains[s][0];
          wl += g * this.fin[2 * s][ri]; wr += g * this.fin[2 * s + 1][ri];
        }
        const w = this.wmix;
        ol = ol * (1 - w) + wl * w; or = or * (1 - w) + wr * w;
      }
      if (this.gN > 0) {
        const gg = this.gN / this.gLen;
        let gl = 0, gr = 0;
        for (let s = 0; s < S; s++) {
          this.rd(s, this.gPos);
          const g = S === 1 || !gains ? 1 : gains[s].length > 1 ? gains[s][i] : gains[s][0];
          gl += g * this._l; gr += g * this._r;
        }
        ol = ol * (1 - gg) + gl * gg; or = or * (1 - gg) + gr * gg;
        this.gPos += this.gRate; this.gN--;
      }
      L[i] = ol * this.env; R[i] = or * this.env;
      // ---- advance the playhead
      const prev = this.pos;
      let np = wrapLoop(prev, prev + r, this.ls, this.le);
      if (np >= this.len) {
        np = this.len;
        if (this.playing && !this.hand) {
          this.playing = false; this.stopPos = this.len; this.cf = null;
          if (this.post) this.post({ type: 'ended', t: f / this.sr, pos: this.len / this.sr });
        }
      } else if (np < 0) np = 0;
      this.pos = np;
      if (!this.playing && !this.hand && this.env <= 0 && this.stopPos >= 0) { this.pos = this.stopPos; this.stopPos = -1; }
    }
    this.frameNow = frame0 + n;
    this.repCount += n;
    if (this.repCount >= this.repEvery && this.post) {
      this.repCount = 0;
      const m = this.rep;
      m.t = (frame0 + n) / this.sr; m.pos = (this.stopPos >= 0 ? this.stopPos : this.pos) / this.sr;
      m.playing = this.playing; m.rate = this.playing || this.hand ? this.lastR : 0; m.hand = this.hand;
      this.post(m);
    }
  }
}

// ------------------------------------------------------------------ bit crusher core
export class CrusherCore {
  constructor() { this.hold = [0, 0]; this.cnt = 0; }
  process(inp, out, bits, down) {
    const q = Math.pow(2, Math.max(1, bits) - 1), dn = Math.max(1, Math.floor(down));
    const chs = out.length, n = out[0].length;
    for (let i = 0; i < n; i++) {
      if (this.cnt <= 0) {
        for (let c = 0; c < chs; c++) { const x = inp[c] ? inp[c][i] : inp[0] ? inp[0][i] : 0; this.hold[c & 1] = Math.round(x * q) / q; }
        this.cnt = dn;
      }
      this.cnt--;
      for (let c = 0; c < chs; c++) out[c][i] = this.hold[c & 1];
    }
  }
}

// ------------------------------------------------------------------ worklet registration
if (typeof AudioWorkletProcessor !== 'undefined' && typeof registerProcessor === 'function') {
  class DeckPlayer extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return STEMS.map((name) => ({ name, defaultValue: 1, minValue: 0, maxValue: 2, automationRate: 'a-rate' }));
    }
    constructor() {
      super();
      // eslint-disable-next-line no-undef
      this.v = new DeckVoice(sampleRate);
      this.v.post = (m, tr) => this.port.postMessage(m, tr || []);
      this.port.onmessage = (e) => this.v.onMessage(e.data);
      this.g = [null, null, null, null];
    }
    process(inputs, outputs, params) {
      const out = outputs[0];
      const L = out[0], R = out[1] || out[0];
      for (let s = 0; s < 4; s++) this.g[s] = params[STEMS[s]];
      // eslint-disable-next-line no-undef
      this.v.process(L, R, L.length, currentFrame, this.g);
      return true;
    }
  }
  registerProcessor('deck-player', DeckPlayer);

  class Crusher extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        { name: 'bits', defaultValue: 16, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
        { name: 'down', defaultValue: 1, minValue: 1, maxValue: 64, automationRate: 'k-rate' },
      ];
    }
    constructor() { super(); this.c = new CrusherCore(); }
    process(inputs, outputs, params) {
      const inp = inputs[0], out = outputs[0];
      if (!inp || !inp.length) { for (const ch of out) ch.fill(0); return true; }
      this.c.process(inp, out, params.bits[0], params.down[0]);
      return true;
    }
  }
  registerProcessor('crusher', Crusher);
}
