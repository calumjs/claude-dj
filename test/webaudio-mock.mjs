// Minimal Web Audio mock for Node integration tests of public/engine.js.
// - AudioParam keeps an automation timeline and throws like the spec does for overlapping curves.
// - AudioWorkletNode('deck-player') runs the REAL DeckVoice; messages go through structuredClone (with transfer),
//   so anything that isn't cloneable fails exactly as it would in the browser.
// - render(seconds) advances the audio clock in 128-frame quanta.
import { DeckVoice, STEMS } from '../public/worklets/deck-player.js';

export const SR = 48000;
const clock = { frame: 0 };
const nodes = [];

// keep engine timers from holding the test process open
const _si = globalThis.setInterval, _st = globalThis.setTimeout;
globalThis.setInterval = (...a) => { const h = _si(...a); h.unref?.(); return h; };
globalThis.setTimeout = (...a) => { const h = _st(...a); h.unref?.(); return h; };

class NotSupportedError extends Error {}
export class MockParam {
  constructor(v = 0) { this.v0 = v; this.ev = []; this.log = []; }
  get value() { return this.valueAt(clock.frame / SR); }
  set value(v) { this.v0 = v; this.ev = this.ev.filter((e) => e.t > clock.frame / SR); }
  check(t) {
    for (const e of this.ev) if (e.type === 'curve' && t >= e.t && t < e.t + e.d) throw new NotSupportedError(`event at ${t} overlaps curve [${e.t}, ${e.t + e.d})`);
  }
  add(e) { this.check(e.t); this.ev.push(e); this.ev.sort((a, b) => a.t - b.t); this.log.push(e); return this; }
  setValueAtTime(v, t) { return this.add({ type: 'set', v, t }); }
  linearRampToValueAtTime(v, t) { return this.add({ type: 'lin', v, t }); }
  exponentialRampToValueAtTime(v, t) { return this.add({ type: 'lin', v, t }); }
  setTargetAtTime(v, t) { return this.add({ type: 'set', v, t }); }
  setValueCurveAtTime(values, t, d) {
    for (const e of this.ev) if (e.t >= t && e.t < t + d) throw new NotSupportedError(`curve [${t}, ${t + d}) overlaps ${e.type} at ${e.t}`);
    return this.add({ type: 'curve', v: values[values.length - 1], values: Float32Array.from(values), t, d });
  }
  cancelScheduledValues(t) { this.v0 = this.valueAt(t); this.ev = this.ev.filter((e) => e.t < t && !(e.type === 'curve' && e.t + e.d > t)); return this; }
  valueAt(t) {
    let v = this.v0, tPrev = 0;
    for (const e of this.ev) {
      if (e.type === 'curve') {
        if (t < e.t) return v;
        if (t < e.t + e.d) { const x = ((t - e.t) / e.d) * (e.values.length - 1), i = Math.floor(x); return e.values[i] + (e.values[Math.min(i + 1, e.values.length - 1)] - e.values[i]) * (x - i); }
        v = e.v; tPrev = e.t + e.d; continue;
      }
      if (t < e.t) { if (e.type === 'lin') return v + (e.v - v) * ((t - tPrev) / (e.t - tPrev || 1)); return v; }
      v = e.v; tPrev = e.t;
    }
    return v;
  }
}
class MockNode {
  constructor(ctx, params = {}) { this.context = ctx; this.outs = new Set(); for (const [k, v] of Object.entries(params)) this[k] = new MockParam(v); }
  connect(d) { this.outs.add(d); return d; }
  disconnect(d) { if (d && !this.outs.has(d)) throw new Error('not connected'); if (d) this.outs.delete(d); else this.outs.clear(); }
}
class MockPort {
  constructor() { this.onmessage = null; this.toProc = []; }
  postMessage(m, transfer = []) { this.toProc.push(structuredClone(m, { transfer })); }
}
export class MockWorkletNode extends MockNode {
  constructor(ctx, name, opts = {}) {
    super(ctx);
    this.name = name; this.opts = opts;
    this.port = new MockPort();
    this.parameters = new Map();
    if (name === 'deck-player') {
      for (const s of STEMS) this.parameters.set(s, new MockParam(1));
      this.voice = new DeckVoice(SR);
      this.fromProc = [];
      this.voice.post = (m, tr) => this.fromProc.push(structuredClone(m, { transfer: tr || [] }));
    } else if (name === 'crusher') {
      this.parameters.set('bits', new MockParam(16)); this.parameters.set('down', new MockParam(1));
    } else throw new Error(`unknown processor ${name}`);
    nodes.push(this);
  }
}
class MockBufferSource extends MockNode {
  constructor(ctx) { super(ctx, { playbackRate: 1 }); this.buffer = null; this.started = null; }
  start(t) { this.started = t; ctxLog.sources.push(this); }
  stop() {}
}
export const ctxLog = { sources: [] };
class MockAudioBuffer {
  constructor(ch, n, sr) { this.numberOfChannels = ch; this.length = n; this.sampleRate = sr; this.duration = n / sr; this.data = Array.from({ length: ch }, () => new Float32Array(n)); }
  getChannelData(c) { return this.data[c]; }
  copyToChannel(src, c) { this.data[c].set(src); }
}
export class MockAudioContext {
  constructor() {
    this.sampleRate = SR; this.state = 'suspended'; this.destination = new MockNode(this);
    this.audioWorklet = { addModule: async () => {} };
    clock.frame = 0; nodes.length = 0; ctxLog.sources.length = 0;
  }
  get currentTime() { return clock.frame / SR; }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  createGain() { return new MockNode(this, { gain: 1 }); }
  createBiquadFilter() { return new MockNode(this, { frequency: 350, Q: 1, gain: 0 }); }
  createAnalyser() { const n = new MockNode(this); n.fftSize = 2048; n.getFloatTimeDomainData = (b) => b.fill(0); return n; }
  createDynamicsCompressor() { return new MockNode(this, { threshold: 0, knee: 0, ratio: 1, attack: 0, release: 0 }); }
  createDelay() { return new MockNode(this, { delayTime: 0 }); }
  createConvolver() { const n = new MockNode(this); n.buffer = null; return n; }
  createOscillator() { const n = new MockNode(this, { frequency: 440, detune: 0 }); n.start = () => {}; n.stop = () => {}; n.setPeriodicWave = () => {}; return n; }
  createPeriodicWave() { return {}; }
  createBuffer(ch, n, sr) { return new MockAudioBuffer(ch, n, sr); }
  createBufferSource() { return new MockBufferSource(this); }
  createMediaStreamDestination() { return new MockNode(this); }
  decodeAudioData() { throw new Error('decodeAudioData not mocked'); }
}

/** advance the audio clock, running every deck worklet exactly like the audio thread would */
export function render(seconds) {
  const quanta = Math.round((seconds * SR) / 128);
  const L = new Float32Array(128), R = new Float32Array(128);
  const peaks = new Map();
  for (let q = 0; q < quanta; q++) {
    for (const n of nodes) {
      if (!n.voice) continue;
      while (n.port.toProc.length) n.voice.onMessage(n.port.toProc.shift());
      const t = clock.frame / SR;
      const g = STEMS.map((s) => new Float32Array([n.parameters.get(s).valueAt(t)]));
      n.voice.process(L, R, 128, clock.frame, g);
      let pk = peaks.get(n) || 0; for (let i = 0; i < 128; i++) pk = Math.max(pk, Math.abs(L[i])); peaks.set(n, pk);
      while (n.fromProc.length) n.port.onmessage?.({ data: n.fromProc.shift() });
    }
    clock.frame += 128;
  }
  return peaks;
}
/** deliver queued main->worklet messages without advancing time */
export function flush() { for (const n of nodes) if (n.voice) while (n.port.toProc.length) n.voice.onMessage(n.port.toProc.shift()); }

// ---- server mock: WAV audio (+ HTTP ranges), stems, track info
export function wav(seconds, fn, sr = SR) {
  const frames = Math.round(seconds * sr), ab = new ArrayBuffer(44 + frames * 4), dv = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + frames * 4, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) { const v = Math.round(fn(i / sr) * 32767); dv.setInt16(44 + i * 4, v, true); dv.setInt16(46 + i * 4, v, true); }
  return ab;
}
export const server = { files: new Map(), tracks: new Map(), fail: new Set(), requests: [] };
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url, 'http://localhost:4747');
  server.requests.push(u.pathname + u.search);
  const res = (status, body) => ({ ok: status < 400, status, arrayBuffer: async () => body, json: async () => body });
  if (server.fail.has(u.pathname)) return res(404, null);
  let m;
  if ((m = /^\/api\/track\/(.+)$/.exec(u.pathname))) { const t = server.tracks.get(decodeURIComponent(m[1])); return t ? res(200, t) : res(404, { error: 'no such track' }); }
  const file = server.files.get(u.pathname);
  if (!file) return res(404, null);
  const range = /bytes=(\d+)-(\d+)/.exec(opts.headers?.Range || '');
  if (range) { const a = Number(range[1]), b = Math.min(file.byteLength - 1, Number(range[2])); return res(206, file.slice(a, b + 1)); }
  return res(200, file.slice(0));
};
globalThis.AudioContext = MockAudioContext;
globalThis.AudioWorkletNode = MockWorkletNode;
globalThis.Worker = class { constructor() { this.onmessage = null; } postMessage(m) { _st(() => this.onmessage?.({ data: { id: m.id, error: 'no worker in tests' } }), 0); } };
