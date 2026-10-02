// Claude DJ audio engine — Web Audio, four decks played by an AudioWorklet (public/worklets/deck-player.js):
// variable/reverse rate, key lock (WSOLA) + key shift, 4-stem playback, EQ/filter/echo/deck FX,
// beat-grid sync, a synthesised sampler, and sample-accurate scheduled transitions
// (so mixes land on the beat even in a background tab).

import { PlayheadModel, parseWav, zoomFromInt16, shiftCamelot, STEMS } from './worklets/deck-player.js';
import { synth, PAD_KINDS, PAD_NAMES } from './samples.js';

export { STEMS };
export const DECKS = ['A', 'B', 'C', 'D'];
export const DECK_COLORS = { A: '#ff7a45', B: '#36d6e7', C: '#c792ea', D: '#9be564' };
export const FX_TYPES = ['none', 'reverb', 'flanger', 'phaser', 'gate', 'crush'];
export const SCRATCH_PATTERNS = ['baby', 'chirp', 'transform', 'flare'];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const EASE = {
  linear: (x) => x,
  smooth: (x) => 0.5 - 0.5 * Math.cos(Math.PI * x),
  in: (x) => x * x,
  out: (x) => 1 - (1 - x) * (1 - x),
};

/** A control value (UI units) driving one or more AudioParams through mapping functions. */
export class Ctl {
  constructor(ctx, value, targets, range = [-1, 1]) {
    this.ctx = ctx; this.v = value; this.targets = targets; this.range = range; this.path = null;
    for (const { param, fn } of targets) param.value = fn(value);
  }
  value(t = this.ctx.currentTime) {
    const p = this.path;
    if (!p) return this.v;
    const pts = p.points;
    if (t <= pts[0].t) return pts[0].v;
    const last = pts[pts.length - 1];
    if (t >= last.t) return last.v; // pure: never mutate state while sampling (see automate)
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i].t) {
        const a = pts[i - 1], b = pts[i];
        const x = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
        return a.v + (b.v - a.v) * EASE[b.shape || 'smooth'](x);
      }
    }
    return last.v;
  }
  automating(t = this.ctx.currentTime) { return !!this.path && t < this.path.points[this.path.points.length - 1].t; }
  hold() {
    const now = this.ctx.currentTime;
    const cur = this.value(now);
    this.path = null; this.v = cur;
    for (const { param, fn } of this.targets) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(fn(cur), now);
    }
    return cur;
  }
  set(v) {
    v = clamp(v, ...this.range);
    this.hold();
    const now = this.ctx.currentTime;
    for (const { param, fn } of this.targets) param.linearRampToValueAtTime(fn(v), now + 0.012);
    this.v = v;
  }
  /** points: [{t (ctx time), v, shape}] — first point is where the automation begins */
  automate(points) {
    const now = this.ctx.currentTime;
    this.hold();
    points = points.map((p) => ({ ...p, v: clamp(p.v, ...this.range) })).filter((p, i, a) => i === 0 || p.t > a[i - 1].t);
    if (points[0].t < now + 0.01) points[0].t = now + 0.01;
    if (points.length < 2) return this.set(points[0].v);
    const held = this.v;
    const t0 = points[0].t, t1 = points[points.length - 1].t, dur = t1 - t0;
    this.path = { points };
    const n = Math.max(32, Math.min(2048, Math.round(dur * 120)));
    for (const { param, fn } of this.targets) {
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) curve[i] = fn(this.value(t0 + (dur * i) / (n - 1)));
      param.setValueAtTime(fn(held), now); // hold the CURRENT value until the automation starts
      param.setValueCurveAtTime(curve, t0, dur);
    }
    this.path = { points };
  }
  ramp(to, t0, dur, shape = 'smooth') {
    if (dur <= 0.02) {
      if (t0 <= this.ctx.currentTime + 0.02) return this.set(to);
      return this.automate([{ t: t0, v: this.value(t0) }, { t: t0 + 0.01, v: to, shape: 'linear' }]);
    }
    this.automate([{ t: t0, v: this.value(t0) }, { t: t0 + dur, v: to, shape }]);
  }
  /** a target's mapping fn changed (e.g. crossfader assignment): glide that one param onto the new mapping
   *  without disturbing the others, re-scheduling any automation still running */
  refreshTarget(tg, fade = 0.02) {
    const now = this.ctx.currentTime, t1 = now + fade;
    const p = tg.param;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(tg.fn(this.value(t1)), t1);
    if (this.path) {
      const end = this.path.points[this.path.points.length - 1].t, ts = t1 + 0.002;
      if (end > ts + 0.02) {
        const n = Math.max(16, Math.min(2048, Math.round((end - ts) * 120))), curve = new Float32Array(n);
        for (let i = 0; i < n; i++) curve[i] = tg.fn(this.value(ts + ((end - ts) * i) / (n - 1)));
        p.setValueCurveAtTime(curve, ts, end - ts);
      }
    }
  }
}

const dbToGain = (db) => Math.pow(10, db / 20);
const eqDb = (v) => (v < 0 ? v * 45 : v * 6);
const volGain = (v) => Math.pow(clamp(v, 0, 1), 1.6);
// "dipless" crossfader: each side stays at full until the fader crosses the centre
const xfGainA = (x) => (x <= 0.5 ? 1 : Math.cos((x - 0.5) * Math.PI));
const xfGainB = (x) => (x >= 0.5 ? 1 : Math.cos((0.5 - x) * Math.PI));
const lpFreq = (v) => (v < 0 ? 20000 * Math.pow(180 / 20000, -v) : 22000);
const hpFreq = (v) => (v > 0 ? 20 * Math.pow(6000 / 20, v) : 10);
const fadeParam = (param, v, now, dur) => { param.cancelScheduledValues(now); param.setValueAtTime(param.value, now); param.linearRampToValueAtTime(v, now + dur); };

// ------------------------------------------------------------------ per-deck FX slot
/**
 * One FX slot per deck (post-filter, pre-fader). Each type is its own lazily-built sub-graph with its own
 * amount Ctl; switching type crossfades the routes over 25 ms, so changes never click.
 * Modulation is beat-synced to the deck: flanger = 2 bars, phaser = 1 bar, gate = 1/16ths (phase-locked).
 */
class DeckFx {
  constructor(deck) {
    const ctx = (this.ctx = deck.ctx);
    this.deck = deck;
    this.input = ctx.createGain(); this.output = ctx.createGain();
    this.bypass = ctx.createGain();
    this.input.connect(this.bypass).connect(this.output);
    this.units = {}; this.type = 'none'; this.ctl = null; this.offTimers = {};
  }
  build(type) {
    const ctx = this.ctx, mixer = this.deck.mixer;
    const G = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const u = { type, in: G(), engage: G(0), connected: false };
    u.engage.connect(this.output);
    switch (type) {
      case 'reverb': {
        const dry = G(), wet = G(0), hp = Object.assign(ctx.createBiquadFilter(), { type: 'highpass' }), conv = ctx.createConvolver();
        hp.frequency.value = 220; conv.buffer = mixer.reverbIR;
        u.in.connect(dry).connect(u.engage); u.in.connect(hp).connect(conv).connect(wet).connect(u.engage);
        u.ctl = new Ctl(ctx, 0, [{ param: dry.gain, fn: (a) => 1 - 0.3 * a }, { param: wet.gain, fn: (a) => 1.1 * a }], [0, 1]);
        break;
      }
      case 'flanger': {
        const dry = G(), wet = G(0), fb = G(0.2), depth = G(0.0032), dl = ctx.createDelay(0.05), lfo = ctx.createOscillator();
        dl.delayTime.value = 0.0042; lfo.frequency.value = 0.25;
        lfo.connect(depth).connect(dl.delayTime); lfo.start();
        u.in.connect(dry).connect(u.engage); u.in.connect(dl).connect(wet).connect(u.engage); dl.connect(fb).connect(dl);
        u.lfo = lfo; u.cycleBeats = 8;
        u.ctl = new Ctl(ctx, 0, [{ param: dry.gain, fn: (a) => 1 - 0.35 * a }, { param: wet.gain, fn: (a) => 0.8 * a }, { param: fb.gain, fn: (a) => 0.2 + 0.5 * a }], [0, 1]);
        break;
      }
      case 'phaser': {
        const dry = G(), wet = G(0), depth = G(650), lfo = ctx.createOscillator();
        lfo.frequency.value = 0.5; lfo.connect(depth); lfo.start();
        let node = u.in;
        for (let i = 0; i < 4; i++) {
          const ap = Object.assign(ctx.createBiquadFilter(), { type: 'allpass' });
          ap.frequency.value = 800; ap.Q.value = 0.5; depth.connect(ap.frequency);
          node.connect(ap); node = ap;
        }
        node.connect(wet).connect(u.engage); u.in.connect(dry).connect(u.engage);
        u.lfo = lfo; u.cycleBeats = 4;
        u.ctl = new Ctl(ctx, 0, [{ param: dry.gain, fn: (a) => 1 - 0.5 * a }, { param: wet.gain, fn: (a) => 0.55 * a }], [0, 1]);
        break;
      }
      case 'gate': {
        // gain = 1 - a + a*pulse(t); pulse = band-limited 50% square locked to the deck's 1/16ths
        const vca = G(1), depth = G(0);
        depth.connect(vca.gain);
        u.in.connect(vca).connect(u.engage);
        u.depth = depth; u.lfo = null;
        u.ctl = new Ctl(ctx, 0, [{ param: vca.gain, fn: (a) => 1 - 0.5 * a }, { param: depth.gain, fn: (a) => a }], [0, 1]);
        break;
      }
      case 'crush': {
        const dry = G(), wet = G(0);
        const cr = new AudioWorkletNode(ctx, 'crusher', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        u.in.connect(dry).connect(u.engage); u.in.connect(cr).connect(wet).connect(u.engage);
        u.ctl = new Ctl(ctx, 0, [
          { param: dry.gain, fn: (a) => 1 - a }, { param: wet.gain, fn: (a) => a },
          { param: cr.parameters.get('bits'), fn: (a) => 16 - 11 * a }, { param: cr.parameters.get('down'), fn: (a) => 1 + 15 * a },
        ], [0, 1]);
        break;
      }
      default: throw new Error(`unknown fx "${type}"`);
    }
    this.units[type] = u;
    return u;
  }
  /** switch type and/or amount. rampSec > 0 fades the amount in from 0 (or from the current amount). */
  set(type, amount, rampSec = 0) {
    if (!FX_TYPES.includes(type)) throw new Error(`fx type must be one of ${FX_TYPES.join(', ')}`);
    const now = this.ctx.currentTime, X = 0.025;
    if (type === this.type) {
      if (this.ctl && amount != null) { if (rampSec > 0) this.ctl.ramp(amount, now + 0.01, rampSec); else this.ctl.set(amount); }
      return;
    }
    const old = this.type === 'none' ? null : this.units[this.type];
    let nu = null;
    if (type !== 'none') {
      nu = this.units[type] || this.build(type);
      clearTimeout(this.offTimers[type]);
      if (!nu.connected) { this.input.connect(nu.in); nu.connected = true; }
      nu.ctl.set(rampSec > 0 ? 0 : amount ?? 0.5); // unit is silent (disengaged) while this settles
      this.resyncUnit(nu);
    }
    fadeParam(old ? old.engage.gain : this.bypass.gain, 0, now, X);
    fadeParam(nu ? nu.engage.gain : this.bypass.gain, 1, now, X);
    if (old) {
      old.ctl.hold();
      const ot = old.type;
      clearTimeout(this.offTimers[ot]);
      this.offTimers[ot] = setTimeout(() => {
        if (this.type === ot || !old.connected) return;
        try { this.input.disconnect(old.in); } catch { /* already */ }
        old.connected = false;
        if (ot === 'gate' && old.lfo) { try { old.lfo.stop(); } catch { /* ignore */ } old.lfo = null; }
      }, 250);
    }
    this.type = type; this.ctl = nu ? nu.ctl : null;
    if (nu && rampSec > 0) nu.ctl.ramp(amount ?? 0.5, now + X, rampSec);
  }
  resync() { for (const u of Object.values(this.units)) if (u.connected) this.resyncUnit(u); }
  resyncUnit(u) {
    const d = this.deck, ctx = this.ctx, now = ctx.currentTime;
    const bps = Math.max(0.5, (d.effBpm || 120) / 60);
    if (u.type === 'flanger' || u.type === 'phaser') u.lfo.frequency.setTargetAtTime(bps / u.cycleBeats, now, 0.05);
    if (u.type === 'gate') {
      let t0 = now + 0.03;
      if (d.playing && d.track && d.rate > 0.05) {
        const b = d.beatAt(d.position(t0)) * 4;
        t0 += ((Math.ceil(b - 1e-6) - b) / 4) * (d.beatLen / d.rate);
      }
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(d.mixer.gateWave);
      osc.frequency.value = bps * 4;
      osc.connect(u.depth);
      osc.start(t0);
      if (u.lfo) { try { u.lfo.stop(t0); } catch { /* ignore */ } }
      u.lfo = osc;
    }
  }
}

// ------------------------------------------------------------------ scratch patterns
// strokes: dur (beats of real time), d (record travel in source beats), open: fader-open windows (fractions of the stroke)
const SCRATCH = {
  baby: [{ dur: 0.25, d: 0.35, open: [[0, 1]] }, { dur: 0.25, d: -0.35, open: [[0, 1]] }],
  chirp: [{ dur: 0.25, d: 0.35, open: [[0, 0.5]] }, { dur: 0.25, d: -0.35, open: [[0, 0.5]] }],
  transform: [
    { dur: 0.5, d: 0.45, open: [[0, 0.125], [0.25, 0.375], [0.5, 0.625], [0.75, 0.875]] },
    { dur: 0.5, d: -0.45, open: [[0, 0.125], [0.25, 0.375], [0.5, 0.625], [0.75, 0.875]] },
  ],
  flare: [{ dur: 0.5, d: 0.45, open: [[0, 0.42], [0.58, 1]] }, { dur: 0.5, d: -0.45, open: [[0, 0.42], [0.58, 1]] }],
};
const RPS = 100 / 3 / 60; // 33⅓ rpm: one platter revolution = 1.8 s of audio

// ------------------------------------------------------------------ deck
class Deck {
  constructor(mixer, name) {
    const ctx = (this.ctx = mixer.ctx);
    this.mixer = mixer; this.name = name;
    this.node = new AudioWorkletNode(ctx, 'deck-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node.port.onmessage = (e) => this.onWorklet(e.data);
    this.cut = ctx.createGain(); // scratch-pattern fader cuts
    this.trim = ctx.createGain();
    this.low = Object.assign(ctx.createBiquadFilter(), { type: 'lowshelf' }); this.low.frequency.value = 220;
    this.mid = Object.assign(ctx.createBiquadFilter(), { type: 'peaking' }); this.mid.frequency.value = 1000; this.mid.Q.value = 0.7;
    this.high = Object.assign(ctx.createBiquadFilter(), { type: 'highshelf' }); this.high.frequency.value = 3500;
    this.hp = Object.assign(ctx.createBiquadFilter(), { type: 'highpass' }); this.hp.Q.value = 1.1;
    this.lp = Object.assign(ctx.createBiquadFilter(), { type: 'lowpass' }); this.lp.Q.value = 1.1;
    this.fx = new DeckFx(this);
    this.fader = ctx.createGain();
    this.xf = ctx.createGain();
    this.send = ctx.createGain();
    this.analyser = Object.assign(ctx.createAnalyser(), { fftSize: 1024 });
    this.node.connect(this.cut).connect(this.trim).connect(this.low).connect(this.mid).connect(this.high).connect(this.hp).connect(this.lp).connect(this.fx.input);
    this.fx.output.connect(this.fader).connect(this.xf);
    this.xf.connect(mixer.bus); this.xf.connect(this.send).connect(mixer.echoIn); this.xf.connect(this.analyser);

    this.vol = new Ctl(ctx, 1, [{ param: this.fader.gain, fn: volGain }], [0, 1]);
    this.eq = {
      low: new Ctl(ctx, 0, [{ param: this.low.gain, fn: eqDb }]),
      mid: new Ctl(ctx, 0, [{ param: this.mid.gain, fn: eqDb }]),
      high: new Ctl(ctx, 0, [{ param: this.high.gain, fn: eqDb }]),
    };
    this.filter = new Ctl(ctx, 0, [{ param: this.lp.frequency, fn: lpFreq }, { param: this.hp.frequency, fn: hpFreq }]);
    this.echo = new Ctl(ctx, 0, [{ param: this.send.gain, fn: (v) => v }], [0, 1]);
    this.stem = Object.fromEntries(STEMS.map((s) => [s, new Ctl(ctx, 1, [{ param: this.node.parameters.get(s), fn: (v) => v }], [0, 1])]));

    this.xfSide = name === 'A' || name === 'C' ? 'left' : 'right';
    this.track = null; this.buffer = null; this.zoom = null; this.rate = 1;
    this.cuePoint = 0; this.loading = false; this.glideTimer = null; this.loadSeq = 0;
    this.model = new PlayheadModel(Infinity);
    this.keylock = true; this.keyShift = 0; this.stemsLoaded = false; this.slip = true;
    this.hand = null; this.handActive = false; this.awaitHandoff = false; this.rep = null; this.warning = null;
    this.post({ type: 'keylock', on: true });
  }

  post(m, transfer) { this.node.port.postMessage(m, transfer || []); }
  /** schedule transport events on both the model and the worklet.
   *  clear: 'transport' drops pending start/stop/seek/curve (a restart), 'stop' pending stops, 'all' everything */
  _ev(events, clear) {
    const now = this.ctx.currentTime;
    if (clear) this.model.clear(now, clear);
    for (const e of events) this.model.add(e);
    this.post({ type: 'events', clear, events });
    this.model.compact(now - 2);
  }
  onWorklet(m) {
    switch (m.type) {
      case 'pos': this.rep = m; this.checkDrift(m); break;
      case 'handoff':
        if (this.awaitHandoff) {
          this.awaitHandoff = false;
          this.model.rebase(m.t, m.pos, !!m.resume);
          if (m.resume && !m.slip) this.model.add({ t: m.t, type: 'curve', pts: [{ t: m.t, r: m.vel }, { t: m.t + 0.08, r: this.rate }], after: this.rate });
        }
        break;
      default: break; // 'ended' is mirrored by the model itself; 'free' just drops old buffers here
    }
  }
  /** safety net: if the worklet's real playhead disagrees with the model (e.g. the audio thread applied a
   *  command late), re-anchor the model to what is actually playing */
  checkDrift(m) {
    if (this.handActive || this.awaitHandoff || m.hand || !m.playing || !this.buffer) return;
    if (this.model.ev.some((e) => Math.abs(e.t - m.t) < 0.06)) return;
    const s = this.model.stateAt(m.t);
    if (!s.playing || s.curve || s.loop) return;
    if (Math.abs(s.pos - m.pos) > 0.012) {
      console.warn(`deck ${this.name}: playhead drift ${((m.pos - s.pos) * 1000).toFixed(1)} ms — re-anchored`);
      this.model.rebase(m.t, m.pos, true);
    }
  }

  // ---- grid
  get beatLen() { return 60 / (this.track?.bpm || 120); }
  beatAt(pos) { return (pos - (this.track?.firstBeat || 0)) / this.beatLen; }
  posOfBeat(b) { return (this.track?.firstBeat || 0) + b * this.beatLen; }
  get effBpm() { return (this.track?.bpm || 0) * this.rate; }
  get duration() { return this.buffer?.duration ?? Infinity; }

  position(t = this.ctx.currentTime) {
    if ((this.handActive || this.awaitHandoff) && this.rep) {
      const r = this.rep;
      return clamp(r.pos + Math.max(0, t - r.t) * (r.rate || 0), 0, this.duration);
    }
    return Math.min(this.model.position(t), this.duration);
  }
  /** playing now, or scheduled to start (matches the old AudioBufferSource semantics) */
  get playing() {
    if (this.handActive || this.awaitHandoff) return !!this.hand?.wasPlaying;
    const now = this.ctx.currentTime;
    if (this.model.stateAt(now).playing) return true;
    return this.model.ev.some((e) => e.type === 'start' && e.t > now);
  }
  get startPos() { return this.position(); }
  set startPos(p) {
    if (!this.buffer) return;
    const now = this.ctx.currentTime;
    this._ev([{ t: now + (this.playing ? 0.004 : 0), type: 'seek', pos: clamp(p, 0, this.duration) }]);
  }
  get loop() { const l = this.model.stateAt(this.ctx.currentTime).loop; return l ? { start: l.start, end: l.end, beats: l.beats } : null; }
  set loop(v) { if (!v) this.setLoop(0); }

  async load(track) {
    if (this.isLive()) throw new Error(`deck ${this.name} is live on air — mix away from it first`);
    this.stop();
    const seq = ++this.loadSeq;
    this.loading = true; this.track = track; this.buffer = null; this.zoom = null; this.stemsLoaded = false; this.warning = null;
    let srcs;
    try {
      srcs = await this.mixer.fetchSources(track);
      if (seq !== this.loadSeq || this.track !== track) return; // replaced while loading
      const sr = this.ctx.sampleRate, now = this.ctx.currentTime;
      // transfer (not copy) the PCM to the audio thread: O(1), so loading never glitches the live deck
      this.post({ type: 'load', bufs: srcs.bufs, offsets: srcs.offsets, frames: srcs.frames }, srcs.bufs);
      this.buffer = { duration: srcs.frames / sr, length: srcs.frames, sampleRate: sr, numberOfChannels: 2 };
      this.stemsLoaded = srcs.stems; this.warning = srcs.warning || null;
      this.model = new PlayheadModel(this.buffer.duration);
      this.trim.gain.value = dbToGain(track.gainDb || 0);
      this.cuePoint = Math.max(0, track.mixIn ?? track.firstBeat ?? 0);
      this.rate = 1;
      this._ev([{ t: now, type: 'rate', rate: 1 }, { t: now, type: 'seek', pos: this.cuePoint }]);
      for (const c of [this.eq.low, this.eq.mid, this.eq.high, this.filter]) c.set(0);
      this.echo.set(0);
      for (const s of STEMS) this.stem[s].set(1);
      this.setKeylock(true); this.setKeyShift(0);
      this.fx.set('none');
      this.cut.gain.cancelScheduledValues(now); this.cut.gain.setValueAtTime(1, now);
    } finally { if (seq === this.loadSeq) this.loading = false; }
    // waveform detail is cosmetic: built off-thread after the deck is ready
    if (srcs.zoom) this.zoom = srcs.zoom;
    else this.mixer.requestZoom(srcs.zoomUrls).then((z) => { if (this.track === track) this.zoom = z; }).catch(() => {});
  }

  isLive() { return this.playing && this.audible() > 0.1; }
  xfGain(x) { return this.xfSide === 'left' ? xfGainA(x) : this.xfSide === 'right' ? xfGainB(x) : 1; }
  audible() {
    if (!this.playing) return 0;
    const x = this.mixer.xfader.value();
    return +(volGain(this.vol.value()) * this.xfGain(x)).toFixed(2);
  }
  setXfSide(side) {
    if (!['left', 'right', 'thru'].includes(side)) throw new Error('side must be left, right or thru');
    this.xfSide = side;
    const tg = this.mixer.xfader.targets.find((x) => x.deck === this.name);
    if (tg) this.mixer.xfader.refreshTarget(tg);
  }

  startSource(pos, when = this.ctx.currentTime) {
    if (!this.buffer) throw new Error(`deck ${this.name} is empty`);
    const now = this.ctx.currentTime;
    when = Math.max(when, now);
    const p = clamp(pos, 0, this.buffer.duration - 0.01);
    const evs = [];
    if (!this.model.stateAt(now).playing) evs.push({ t: now, type: 'seek', pos: p }); // show the cue while waiting to start
    evs.push({ t: when, type: 'start', pos: p });
    this._ev(evs, 'transport');
    this.fx.resync();
  }
  play(when) {
    if (this.playing) return;
    this.startSource(this.startPos, when ?? this.ctx.currentTime + 0.01);
  }
  pause() {
    if (!this.playing) return;
    this._ev([{ t: this.ctx.currentTime + 0.003, type: 'stop' }], 'transport');
  }
  stop() { this.pause(); clearInterval(this.glideTimer); }
  /** stop at a future ctx time (end of a transition) */
  stopAt(t) {
    if (!this.playing) return;
    this._ev([{ t: Math.max(t, this.ctx.currentTime), type: 'stop' }], 'stop');
  }
  seek(pos) {
    pos = clamp(pos, 0, (this.buffer?.duration || 1) - 0.05);
    const now = this.ctx.currentTime;
    this._ev([{ t: this.playing ? now + 0.01 : now, type: 'seek', pos }]);
    this.fx.resync();
  }
  /** jump at an exact future ctx time (perform steps, slip releases) */
  seekAt(pos, t) {
    pos = clamp(pos, 0, (this.buffer?.duration || 1) - 0.05);
    this._ev([{ t: Math.max(t, this.ctx.currentTime), type: 'seek', pos }]);
  }
  setRate(r, when) {
    r = clamp(r, 0.5, 1.6);
    const now = this.ctx.currentTime;
    if (this.buffer) this._ev([{ t: Math.max(when ?? now + 0.01, now), type: 'rate', rate: r }]);
    this.rate = r;
    this.fx.resync();
  }
  /** rate automation on the audio clock: points [{t, r}] (r may be negative), then `after` */
  rateCurve(points, after = this.rate) {
    const pts = points.filter((p, i, a) => i === 0 || p.t > a[i - 1].t + 1e-6);
    if (pts.length < 2) return;
    this._ev([{ t: pts[0].t, type: 'curve', pts, after }]);
  }
  /** glide tempo to `rate` over `seconds`, in small steps (keeps position maths exact) */
  glideTo(rate, seconds) {
    clearInterval(this.glideTimer);
    const start = this.rate, steps = Math.max(1, Math.round(seconds / 0.5));
    let i = 0;
    this.glideTimer = setInterval(() => {
      i++; this.setRate(start + ((rate - start) * i) / steps);
      if (i >= steps) clearInterval(this.glideTimer);
    }, (seconds * 1000) / steps);
  }
  /**
   * Loop `beats` from the beat-grid point at ctx time `when` (default: now). Loops shorter than a beat
   * snap to their own subdivision. snap 'floor' (manual: the beat we're in) | 'round' (scheduled: the beat we're on).
   */
  setLoop(beats, when, snap = 'floor') {
    const now = this.ctx.currentTime, t = Math.max(when ?? now, now);
    if (!beats) { this._ev([{ t, type: 'loop', loop: null }]); return; }
    const pos = this.position(t);
    // snap: 'floor' = the beat we are in · 'round' = nearest beat · 'block' = the start of the current loop-length block
    // (a 16-beat loop clicked anywhere in a 4-bar block loops that block — forgiving timing, phrase-true loops)
    const q = beats < 1 ? beats : snap === 'block' ? beats : 1;
    const b = this.beatAt(pos) / q;
    const startBeat = (snap === 'round' ? Math.round(b) : Math.floor(b + 1e-3)) * q;
    const start = this.posOfBeat(startBeat), end = start + beats * this.beatLen;
    this._ev([{ t, type: 'loop', loop: { start, end, beats } }]);
  }
  resetFx() {
    for (const c of [this.eq.low, this.eq.mid, this.eq.high, this.filter]) c.set(0);
  }

  // ---- key
  setKeylock(on) { this.keylock = !!on; this.post({ type: 'keylock', on: this.keylock }); }
  setKeyShift(semis) { this.keyShift = clamp(Math.round(Number(semis) || 0), -6, 6); this.post({ type: 'semis', v: this.keyShift }); }
  effectiveSemis() { return this.keyShift + (this.keylock ? 0 : 12 * Math.log2(this.rate)); }
  effectiveCamelot() { return this.track?.camelot ? shiftCamelot(this.track.camelot, Math.round(this.effectiveSemis())) : null; }

  // ---- scratching by hand (turntable drag). The model keeps running underneath = slip mode's ghost playhead.
  grab() {
    if (!this.buffer || this.handActive || this.awaitHandoff) return false;
    const now = this.ctx.currentTime;
    this.hand = { wasPlaying: this.playing, slip: this.slip, lastMove: performance.now(), vel: 0 };
    this.rep = { t: now, pos: this.position(now), rate: 0, playing: this.hand.wasPlaying };
    this.handActive = true;
    this.post({ type: 'hand', on: true });
    clearInterval(this.handIdle);
    // the hand stopped moving: tell the worklet so it stops predicting motion
    this.handIdle = setInterval(() => {
      if (this.hand && performance.now() - this.hand.lastMove > 30 && this.hand.vel !== 0) { this.hand.vel = 0; this.post({ type: 'handMove', d: 0, vel: 0 }); }
    }, 25);
    return true;
  }
  /** dSec: record travel in seconds of audio since the last move; vel: seconds of audio per second */
  handMove(dSec, vel) {
    if (!this.handActive) return;
    this.hand.lastMove = performance.now(); this.hand.vel = vel;
    this.post({ type: 'handMove', d: dSec, vel });
  }
  release() {
    if (!this.handActive) return;
    clearInterval(this.handIdle);
    const h = this.hand, t = this.ctx.currentTime + 0.015;
    if (h.wasPlaying && h.slip) {
      // slip: the track carried on underneath — drop back in exactly where it would have been
      this.post({ type: 'events', events: [{ t, type: 'handoff', resume: true, slip: true }, { t, type: 'seek', pos: this.model.position(t) }] });
      this.handActive = false;
    } else {
      this.post({ type: 'events', events: [{ t, type: 'handoff', resume: h.wasPlaying }] });
      this.handActive = false; this.awaitHandoff = true;
      setTimeout(() => { // worklet never answered (shouldn't happen): fall back to its last report
        if (!this.awaitHandoff) return;
        this.awaitHandoff = false;
        if (this.rep) this.model.rebase(this.rep.t, this.rep.pos, h.wasPlaying);
      }, 600);
    }
  }

  /** beat-synced scratch routine on the audio clock (slip: the track comes back on the grid afterwards) */
  scratchPattern(pattern = 'baby', beats = 4, T0) {
    const P = SCRATCH[pattern];
    if (!P) throw new Error(`pattern must be one of ${SCRATCH_PATTERNS.join(', ')}`);
    if (!this.playing) throw new Error(`deck ${this.name} is not playing`);
    const beat = 60 / this.effBpm, srcBeat = this.beatLen;
    const Tend = T0 + beats * beat;
    const slipPos = this.model.position(Tend);
    const pts = [], opens = [];
    let t = T0;
    outer: for (;;) {
      for (const s of P) {
        const T = s.dur * beat;
        if (t + T > Tend + 1e-6) break outer;
        const D = s.d * srcBeat, N = Math.max(6, Math.ceil(T / 0.006));
        for (let k = 0; k <= N; k++) {
          const tt = t + (k / N) * T;
          if (pts.length && tt <= pts[pts.length - 1].t + 1e-6) continue;
          pts.push({ t: tt, r: (Math.PI / 2) * (D / T) * Math.sin((Math.PI * k) / N) });
        }
        for (const [a, b] of s.open) opens.push([t + a * T, t + b * T]);
        t += T;
      }
    }
    if (pts.length < 2) throw new Error('pattern needs at least 1 beat');
    this.rateCurve(pts, this.rate);
    this.seekAt(slipPos, Tend);
    // fader cuts (3 ms ramps)
    const g = this.cut.gain, X = 0.003;
    g.cancelScheduledValues(this.ctx.currentTime); g.setValueAtTime(1, this.ctx.currentTime);
    let cur = 1, tc = T0;
    const setAt = (time, v) => { if (v === cur) return; time = Math.max(time, tc + X); g.setValueAtTime(cur, time); g.linearRampToValueAtTime(v, time + X); cur = v; tc = time + X; };
    for (const [a, b] of opens) { setAt(a, 1); setAt(b - X, 0); }
    setAt(Tend - X, 1);
    return { pattern, beats, startsAt: T0, endsAt: Tend };
  }

  state() {
    const t = this.track, now = this.ctx.currentTime, st = this.model.stateAt(now);
    return {
      trackId: t?.id || null, title: t?.title, artist: t?.artist, bpm: t?.bpm, camelot: t?.camelot, key: t?.key, energy: t?.energy,
      firstBeat: t?.firstBeat, mixOut: t?.mixOut, duration: this.buffer?.duration ?? t?.duration ?? null,
      loaded: !!this.buffer, loading: this.loading, playing: this.playing,
      position: +this.position().toFixed(3), rate: +this.rate.toFixed(4), cue: +this.cuePoint.toFixed(2),
      loop: st.loop ? { start: st.loop.start, end: st.loop.end, beats: st.loop.beats } : null,
      vol: +this.vol.value().toFixed(2), filter: +this.filter.value().toFixed(2), echo: +this.echo.value().toFixed(2),
      eq: { low: +this.eq.low.value().toFixed(2), mid: +this.eq.mid.value().toFixed(2), high: +this.eq.high.value().toFixed(2) },
      audible: this.audible(),
      keylock: this.keylock, keyShift: this.keyShift, effectiveCamelot: this.effectiveCamelot(),
      stems: { loaded: this.stemsLoaded, ...Object.fromEntries(STEMS.map((s) => [s, +this.stem[s].value().toFixed(2)])) },
      xfAssign: this.xfSide,
      fx: { type: this.fx.type, amount: this.fx.ctl ? +this.fx.ctl.value().toFixed(2) : 0 },
      scratching: this.handActive,
      ...(this.warning ? { warning: this.warning } : {}),
    };
  }
}
export { RPS };

// ------------------------------------------------------------------ sampler
class Sampler {
  constructor(mixer) {
    const ctx = (this.ctx = mixer.ctx);
    this.mixer = mixer;
    this.bus = ctx.createGain();
    this.bus.connect(mixer.bus);
    this.vol = new Ctl(ctx, 0.85, [{ param: this.bus.gain, fn: volGain }], [0, 1]);
    this.pads = PAD_KINDS.map((kind, i) => ({ pad: i + 1, kind, name: PAD_NAMES[kind], buffer: this.toBuffer(synth(kind, ctx.sampleRate)) }));
    this.pads.push({ pad: 7, kind: 'empty', name: '—', buffer: null }, { pad: 8, kind: 'empty', name: '—', buffer: null });
    this.riserBpm = 128;
    this.lastHit = new Array(8).fill(0);
    this.loadManifest(); // real recorded one-shots override the synth fallbacks when present
  }
  async loadManifest(url = 'samples/manifest.json') {
    try {
      const m = await fetch(url, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null));
      if (!m?.pads) return;
      await Promise.all(m.pads.map(async (d) => {
        try {
          const ab = await fetch(d.file).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); });
          const buffer = await this.ctx.decodeAudioData(ab);
          const cur = this.pads[d.pad - 1];
          if (cur && cur.kind === 'slice') return; // never clobber a pad the DJ captured
          this.pads[d.pad - 1] = { pad: d.pad, kind: d.kind, name: d.name, buffer, file: d.file, fitBeats: d.fitBeats || null };
        } catch (e) { console.warn('[sampler] could not load', d.file, e); }
      }));
    } catch (e) { console.warn('[sampler] no sample manifest, using synth pads', e); }
  }
  toBuffer({ L, R }) {
    const b = this.ctx.createBuffer(2, L.length, this.ctx.sampleRate);
    b.copyToChannel(L, 0); b.copyToChannel(R, 1);
    return b;
  }
  trigger(pad, when, gain = 1) {
    const p = this.pads[pad - 1];
    if (!p) throw new Error('pad must be 1-8');
    if (!p.buffer) throw new Error(`pad ${pad} is empty — fill it with: dj sampler ${pad} --load <trackId> --from <sec> --beats 2`);
    let rate = 1;
    if (p.fitBeats) { // recorded riser: stretch (varispeed) so it lasts fitBeats at the live tempo
      const bpm = this.mixer.liveDeck()?.effBpm;
      if (bpm) rate = clamp(p.buffer.duration / ((p.fitBeats * 60) / bpm), 0.6, 1.8);
    } else if (p.kind === 'riser') { // synth riser always lasts 8 beats at the live tempo
      const bpm = this.mixer.liveDeck()?.effBpm;
      if (bpm && Math.abs(bpm - this.riserBpm) > 0.5) { p.buffer = this.toBuffer(synth('riser', this.ctx.sampleRate, { seconds: (8 * 60) / bpm })); this.riserBpm = bpm; }
    }
    const src = this.ctx.createBufferSource(), g = this.ctx.createGain();
    src.buffer = p.buffer; src.playbackRate.value = rate; g.gain.value = clamp(gain, 0, 1.5);
    src.connect(g).connect(this.bus);
    src.start(when);
    src.onended = () => g.disconnect();
    this.lastHit[pad - 1] = this.mixer.epoch(when);
    return { pad, name: p.name, durationSec: +(p.buffer.duration / rate).toFixed(2), ...(p.file ? { sample: p.file } : { synth: true }) };
  }
  /** capture `beats` of a library track (from `from` seconds or bar:N) into a pad */
  async capture(pad, trackId, from, beats = 2) {
    if (!(pad >= 1 && pad <= 8)) throw new Error('pad must be 1-8');
    const info = await fetch(`/api/track/${encodeURIComponent(trackId)}`).then((r) => r.json());
    if (!info || info.error || !info.id) throw new Error(`no track "${trackId}"`);
    const bpm = info.bpm || 120, fb = info.firstBeat || 0;
    let start;
    if (from == null || from === '') start = info.mixIn ?? fb;
    else if (/^bar:\d+$/.test(String(from))) start = fb + (Number(String(from).slice(4)) - 1) * 4 * (60 / bpm);
    else start = Number(from);
    if (!isFinite(start) || start < 0) throw new Error(`bad --from "${from}"`);
    const len = clamp(Number(beats) || 2, 0.25, 64) * (60 / bpm);
    const { L, R } = await fetchSlice(this.ctx, `/audio/${info.id}?sr=${this.ctx.sampleRate}`, start, len);
    const n = Math.min(L.length, Math.round(0.004 * this.ctx.sampleRate));
    for (let i = 0; i < n; i++) { const g = i / n; L[i] *= g; R[i] *= g; L[L.length - 1 - i] *= g; R[R.length - 1 - i] *= g; }
    const name = (info.title || 'slice').slice(0, 12);
    this.pads[pad - 1] = { pad, kind: 'slice', name, buffer: this.toBuffer({ L, R }), source: { trackId: info.id, from: +start.toFixed(3), beats: Number(beats) || 2 } };
    return { pad, name, from: +start.toFixed(2), seconds: +len.toFixed(2) };
  }
  /** chop keyboard: capture `beats` of a deck at its playhead (the mix, or one stem) into a pad. The grab snaps to
   *  the start of the beat the playhead is in, so a re-pitched chop keeps its groove. */
  async grab(pad, deckName, beats = 1, stem = null, from = null) {
    if (!(pad >= 1 && pad <= 8)) throw new Error('pad must be 1-8');
    const d = this.mixer.decks[String(deckName || '').toUpperCase()];
    if (!d?.track) throw new Error(`deck ${deckName} is empty`);
    if (stem && !d.stemsLoaded) throw new Error(`deck ${d.name} has no stems loaded`);
    // from: omitted = the playhead (snapped to its beat); "bar:N" or "bar:N.5" = that bar/beat (snapped); a number = exact seconds
    let start;
    if (from != null && from !== '') {
      const m = /^bar:([\d.]+)$/.exec(String(from));
      start = m ? d.posOfBeat(Math.floor((Number(m[1]) - 1) * 4 + 1e-3)) : Number(from);
      if (!Number.isFinite(start)) throw new Error(`bad from "${from}"`);
      start = Math.max(0, start);
    } else start = Math.max(0, d.posOfBeat(Math.floor(d.beatAt(d.position()) + 1e-3)));
    const len = clamp(Number(beats) || 1, 0.25, 16) * d.beatLen;
    const url = stem ? `/audio/${d.track.id}/stem/${stem}?sr=${this.ctx.sampleRate}` : `/audio/${d.track.id}?sr=${this.ctx.sampleRate}`;
    const { L, R } = await fetchSlice(this.ctx, url, start, len);
    const n = Math.min(L.length, Math.round(0.004 * this.ctx.sampleRate));
    for (let i = 0; i < n; i++) { const g = i / n; L[i] *= g; R[i] *= g; L[L.length - 1 - i] *= g; R[R.length - 1 - i] *= g; }
    const name = `${stem ? stem.slice(0, 3) + '·' : ''}${(d.track.title || 'chop').slice(0, 10)}`;
    const rootMidi = estimateMidi(L, R, this.ctx.sampleRate); // what note the chop sings, for scale lock
    this.pads[pad - 1] = { pad, kind: 'slice', name, buffer: this.toBuffer({ L, R }), rootMidi, source: { trackId: d.track.id, from: +start.toFixed(3), beats: Number(beats) || 1, stem: stem || null, bpm: d.track.bpm } };
    return { pad, name, deck: d.name, from: +start.toFixed(2), beats: Number(beats) || 1, stem: stem || null, rootMidi };
  }
  /** chop keyboard: play a pad re-pitched by `semis` (varispeed, the classic chop sound). Returns a handle to release it. */
  note(pad, semis = 0, when = this.ctx.currentTime + 0.005, gain = 1) {
    const p = this.pads[pad - 1];
    if (!p?.buffer) throw new Error(`pad ${pad} is empty — grab something into it first`);
    const src = this.ctx.createBufferSource(), g = this.ctx.createGain();
    src.buffer = p.buffer; src.playbackRate.value = Math.pow(2, clamp(Number(semis) || 0, -36, 36) / 12);
    g.gain.value = clamp(gain, 0, 1.5);
    src.connect(g).connect(this.bus);
    src.start(when);
    src.onended = () => g.disconnect();
    this.lastHit[pad - 1] = this.mixer.epoch(when);
    return { pad, semis, stop: (t = this.ctx.currentTime) => { const tt = Math.max(t, when); g.gain.setTargetAtTime(0, tt, 0.012); try { src.stop(tt + 0.1); } catch { /* already ended */ } } };
  }
  state() { return this.pads.map((p) => ({ pad: p.pad, name: p.name, kind: p.kind, ...(p.source ? { source: p.source } : {}) })); }
}

/** rough fundamental of a chop (MIDI note) by normalised autocorrelation on its loudest 4096 samples; null if unsure */
function estimateMidi(L, R, sr) {
  const n = L.length, win = Math.min(4096, n);
  if (win < 1024) return null;
  let best = 0, bestE = -1; // loudest window
  for (let s = 0; s + win <= n; s += 512) { let e = 0; for (let i = s; i < s + win; i += 4) { const v = (L[i] + R[i]) * 0.5; e += v * v; } if (e > bestE) { bestE = e; best = s; } }
  const x = new Float32Array(win); let mean = 0;
  for (let i = 0; i < win; i++) { x[i] = (L[best + i] + R[best + i]) * 0.5; mean += x[i]; }
  mean /= win; for (let i = 0; i < win; i++) x[i] -= mean;
  const minLag = Math.floor(sr / 1000), maxLag = Math.floor(sr / 60);
  let e0 = 0; for (let i = 0; i < win; i++) e0 += x[i] * x[i];
  if (e0 < 1e-6) return null;
  let bestLag = 0, bestR = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0, e1 = 0; for (let i = 0; i + lag < win; i++) { s += x[i] * x[i + lag]; e1 += x[i + lag] * x[i + lag]; }
    const r = s / Math.sqrt(e0 * e1 + 1e-9);
    if (r > bestR) { bestR = r; bestLag = lag; }
  }
  if (bestR < 0.5 || !bestLag) return null;
  // prefer the fundamental over an octave-low detection: if half the lag correlates nearly as well, take it
  const half = Math.round(bestLag / 2);
  if (half >= minLag) { let s = 0, e1 = 0; for (let i = 0; i + half < win; i++) { s += x[i] * x[i + half]; e1 += x[i + half] * x[i + half]; } if (s / Math.sqrt(e0 * e1 + 1e-9) > bestR * 0.9) bestLag = half; }
  return Math.round(69 + 12 * Math.log2(sr / bestLag / 440));
}

/** fetch [start, start+len) seconds of a track as float L/R, using HTTP ranges on the server's PCM WAV when possible */
async function fetchSlice(ctx, url, start, len) {
  const sr = ctx.sampleRate;
  const toLR = (i16, ch, n) => {
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = i16[i * ch] / 32768; R[i] = i16[i * ch + (ch > 1 ? 1 : 0)] / 32768; }
    return { L, R };
  };
  const head = await fetch(url, { headers: { Range: 'bytes=0-65535' } });
  if (!head.ok) throw new Error(`audio fetch failed (${head.status})`);
  const hab = await head.arrayBuffer();
  const w = parseWav(hab);
  if (w && w.format === 1 && w.bits === 16 && w.sampleRate === sr) {
    const ch = w.channels, f0 = Math.floor(start * sr);
    const n = Math.min(Math.round(len * sr), (head.status === 200 ? w.frames : w.declaredFrames) - f0);
    if (n <= 0) throw new Error('slice starts after the end of the track');
    if (head.status === 200) { // server ignored the range: we already have the whole file
      const dv = new DataView(hab, w.dataOffset + f0 * ch * 2), L = new Float32Array(n), R = new Float32Array(n);
      for (let i = 0; i < n; i++) { L[i] = dv.getInt16(i * ch * 2, true) / 32768; R[i] = dv.getInt16((i * ch + (ch > 1 ? 1 : 0)) * 2, true) / 32768; }
      return { L, R };
    }
    const b0 = w.dataOffset + f0 * ch * 2;
    const r = await fetch(url, { headers: { Range: `bytes=${b0}-${b0 + n * ch * 2 - 1}` } });
    const ab = await r.arrayBuffer();
    if (r.status === 206) return toLR(new Int16Array(ab, 0, Math.floor(ab.byteLength / 2)), ch, Math.floor(ab.byteLength / 2 / ch));
  }
  // fallback: whole file through the browser decoder
  const ab = await fetch(url).then((r) => r.arrayBuffer());
  const buf = await ctx.decodeAudioData(ab);
  const f0 = Math.floor(start * buf.sampleRate), n = Math.min(Math.round(len * buf.sampleRate), buf.length - f0);
  if (n <= 0) throw new Error('slice starts after the end of the track');
  return { L: buf.getChannelData(0).slice(f0, f0 + n), R: buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0).slice(f0, f0 + n) };
}

function makeIR(ctx, seconds = 2.2) {
  const sr = ctx.sampleRate, n = Math.round(sr * seconds), pre = Math.round(0.012 * sr);
  const b = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const x = (i - pre) / (n - pre);
      const k = 0.15 + 0.8 * x; // darker as it decays
      lp += (1 - k) * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.exp(-6.9 * x) * (1 + x);
    }
  }
  return b;
}
function makeGateWave(ctx, duty = 0.5, H = 24) {
  const real = new Float32Array(H + 1), imag = new Float32Array(H + 1);
  for (let n = 1; n <= H; n++) {
    const s = Math.PI * n / (H + 1), sigma = Math.sin(s) / s; // Lanczos: soft edges, no ringing
    real[n] = (sigma * Math.sin(2 * Math.PI * n * duty)) / (Math.PI * n);
    imag[n] = (sigma * (1 - Math.cos(2 * Math.PI * n * duty))) / (Math.PI * n);
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: true });
}

// ------------------------------------------------------------------ mixer
export class Mixer {
  constructor() {
    const ctx = (this.ctx = new AudioContext({ latencyHint: 'playback' }));
    this.bus = ctx.createGain();
    this.masterGain = ctx.createGain();
    // Master limiter. DynamicsCompressor adds automatic makeup gain and lets 1-2 ms of transient through, so on its
    // own two full-level decks still hard-clip at the DAC / recorder on every kick. Grab early, then a fixed 6 dB of
    // headroom after it (this.out feeds the speakers, the analyser and the recorder).
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -10; this.limiter.knee.value = 4; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001; this.limiter.release.value = 0.1;
    this.out = ctx.createGain(); this.out.gain.value = 0.5;
    this.analyser = Object.assign(ctx.createAnalyser(), { fftSize: 2048 });
    // echo bus
    this.echoIn = ctx.createGain();
    this.delay = ctx.createDelay(4); this.delay.delayTime.value = 0.375;
    this.feedback = ctx.createGain(); this.feedback.gain.value = 0.55;
    this.echoTone = Object.assign(ctx.createBiquadFilter(), { type: 'bandpass' }); this.echoTone.frequency.value = 1400; this.echoTone.Q.value = 0.5;
    this.echoIn.connect(this.delay); this.delay.connect(this.echoTone).connect(this.feedback).connect(this.delay);
    this.echoTone.connect(this.bus);

    this.bus.connect(this.masterGain).connect(this.limiter).connect(this.out).connect(ctx.destination);
    this.out.connect(this.analyser);
    this.master = new Ctl(ctx, 0.9, [{ param: this.masterGain.gain, fn: (v) => v }], [0, 1]);
    this.decks = {};
    this.transition = null;
    this.zoomJobs = new Map(); this.zoomSeq = 0;
  }

  /** load the worklet module and build the decks (call once, after the user gesture) */
  async init() {
    if (this.xfader) return;
    await this.ctx.audioWorklet.addModule(new URL('./worklets/deck-player.js', import.meta.url));
    this.reverbIR = makeIR(this.ctx);
    this.gateWave = makeGateWave(this.ctx);
    for (const n of DECKS) this.decks[n] = new Deck(this, n);
    this.xfader = new Ctl(this.ctx, 0, Object.values(this.decks).map((d) => ({ param: d.xf.gain, fn: (x) => d.xfGain(x), deck: d.name })), [0, 1]);
    this.sampler = new Sampler(this);
    try {
      this.zoomWorker = new Worker(new URL('./zoom-worker.js', import.meta.url), { type: 'module' });
      this.zoomWorker.onmessage = (e) => {
        const j = this.zoomJobs.get(e.data.id); this.zoomJobs.delete(e.data.id);
        if (j) (e.data.error ? j.rej(new Error(e.data.error)) : j.res(e.data));
      };
    } catch { this.zoomWorker = null; }
    setInterval(() => { const t = this.ctx.currentTime - 2; for (const d of Object.values(this.decks)) d.model.compact(t); }, 1000);
  }

  requestZoom(urls) {
    if (!this.zoomWorker || !urls?.length) return Promise.reject(new Error('no zoom worker'));
    const id = ++this.zoomSeq;
    return new Promise((res, rej) => { this.zoomJobs.set(id, { res, rej }); this.zoomWorker.postMessage({ id, urls, perSec: 150 }); });
  }

  /** fetch one PCM source as interleaved-stereo Int16 (zero-copy for the server's 16-bit WAVs) */
  async fetchPcm(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`audio fetch failed (${r.status})`);
    const ab = await r.arrayBuffer();
    const sr = this.ctx.sampleRate;
    const w = parseWav(ab);
    if (w && w.format === 1 && w.bits === 16 && w.sampleRate === sr && (w.channels === 1 || w.channels === 2) && w.frames > 0) {
      if (w.channels === 2 && w.dataOffset % 2 === 0) return { buf: ab, offset: w.dataOffset, frames: w.frames };
      const out = new Int16Array(w.frames * 2), dv = new DataView(ab, w.dataOffset);
      for (let i = 0; i < w.frames; i++) {
        const l = dv.getInt16(i * 2 * w.channels, true), rr = w.channels === 2 ? dv.getInt16(i * 4 + 2, true) : l;
        out[2 * i] = l; out[2 * i + 1] = rr;
      }
      return { buf: out.buffer, offset: 0, frames: w.frames, decoded: true };
    }
    const audio = await this.ctx.decodeAudioData(ab);
    const n = audio.length, L = audio.getChannelData(0), R = audio.numberOfChannels > 1 ? audio.getChannelData(1) : L;
    const out = new Int16Array(n * 2);
    for (let i = 0; i < n; i++) { out[2 * i] = clamp(Math.round(L[i] * 32767), -32768, 32767); out[2 * i + 1] = clamp(Math.round(R[i] * 32767), -32768, 32767); }
    return { buf: out.buffer, offset: 0, frames: n, decoded: true };
  }

  /** the 4 stems when the track has them (falling back to the full mix), else the full mix */
  async fetchSources(track) {
    const sr = this.ctx.sampleRate, mixUrl = `${track.url}?sr=${sr}`;
    const zoomOf = (parts, frames) => (parts.some((p) => p.decoded) ? zoomFromInt16(parts.map((p) => new Int16Array(p.buf, p.offset, frames * 2)), frames, sr) : null);
    let warning;
    if (Array.isArray(track.stems) && STEMS.every((s) => track.stems.includes(s))) {
      try {
        const parts = await Promise.all(STEMS.map((s) => this.fetchPcm(`${track.url}/stem/${s}?sr=${sr}`)));
        const frames = Math.min(...parts.map((p) => p.frames));
        return { bufs: parts.map((p) => p.buf), offsets: parts.map((p) => p.offset), frames, stems: true, zoomUrls: [mixUrl], zoom: zoomOf(parts, frames) };
      } catch (e) { warning = `stems unavailable (${e.message}) — playing the full mix`; console.warn(warning); }
    }
    const p = await this.fetchPcm(mixUrl);
    return { bufs: [p.buf], offsets: [p.offset], frames: p.frames, stems: false, zoomUrls: [mixUrl], zoom: zoomOf([p], p.frames), warning };
  }

  liveDeck() { return Object.values(this.decks).filter((d) => d.playing).sort((a, b) => b.audible() - a.audible())[0] || null; }
  /** the deck `name` should follow: the most audible other playing deck (else its A/B partner) */
  other(name) {
    const partner = { A: 'B', B: 'A', C: 'A', D: 'B' }[name] || 'A';
    const cands = Object.values(this.decks).filter((d) => d.name !== name && d.playing).sort((a, b) => b.audible() - a.audible());
    return cands[0] || this.decks[partner];
  }
  epoch(t) { return Date.now() + (t - this.ctx.currentTime) * 1000; }

  /** rate for `deck` so its tempo matches `bpm` (handles half/double time) */
  matchRate(deck, bpm) {
    const own = deck.track.bpm;
    const cands = [bpm / own, (bpm * 2) / own, bpm / 2 / own];
    return cands.sort((a, b) => Math.abs(a - 1) - Math.abs(b - 1))[0];
  }

  /** ctx time of the deck's next drop (bar-snapped) at least minAhead seconds away, or null */
  nextDropTime(deck, minAhead = 0) {
    const now = this.ctx.currentTime, pos = deck.position(now);
    const drops = (deck.track?.breakdowns || []).map((b) => deck.posOfBeat(Math.round(deck.beatAt(b.drop) / 4) * 4));
    for (const d of drops) { const t = now + (d - pos) / deck.rate; if (t - now >= minAhead) return t; }
    return null;
  }

  /** next bar (or phrase) boundary of `deck` after `minAhead` seconds, in ctx time */
  nextBoundary(deck, beats = 4, minAhead = 0.15) {
    const now = this.ctx.currentTime;
    const b = deck.beatAt(deck.position(now + minAhead));
    const target = Math.ceil(b / beats - 1e-6) * beats;
    return { t: now + minAhead + ((target - b) * deck.beatLen) / deck.rate, beat: target };
  }

  /** quantised trigger time: now | beat | bar of the live deck */
  quantTime(at = 'beat', ref) {
    const now = this.ctx.currentTime, live = ref || this.liveDeck();
    if (at === 'now' || !live || !live.track) return now + 0.01;
    if (at === 'beat') return this.nextBoundary(live, 1, 0.03).t;
    if (at === 'bar') return this.nextBoundary(live, 4, 0.03).t;
    if (at === 'phrase') return this.nextBoundary(live, 32, 0.03).t;
    throw new Error(`bad --at "${at}" (now|beat|bar|phrase)`);
  }

  sync(name) {
    const d = this.decks[name], m = this.other(name);
    if (!d.track || !m?.track) throw new Error('both decks need a track to sync');
    if (!m.playing) throw new Error(`deck ${m.name} is not playing — nothing to sync to`);
    d.setRate(this.matchRate(d, m.effBpm));
    if (d.playing) {
      // align beat phase (and bar position) to the master deck
      const T = this.ctx.currentTime + 0.05;
      const mb = m.beatAt(m.position(T));
      const db = d.beatAt(d.position(T));
      const barPhase = ((mb % 4) + 4) % 4;
      let target = Math.floor(db / 4) * 4 + barPhase;
      if (target - db > 2) target -= 4; else if (db - target > 2) target += 4;
      d.startSource(d.posOfBeat(target), T);
    }
    return { rate: d.rate, bpm: +d.effBpm.toFixed(2), master: m.name };
  }

  /**
   * The mix. Schedules everything on the audio clock.
   * style: blend | bassswap | double | fade | filter | echo | cut | brake | spinback
   * Decks on opposite crossfader sides mix with the crossfader; otherwise (same side / thru) with the channel faders.
   */
  mix({ from, to, style = 'blend', bars, at = 'bar', in: inArg, glide = true }) {
    const A = this.decks[from], B = this.decks[to];
    if (!A || !B) throw new Error('decks must be A, B, C or D');
    if (from === to) throw new Error('from and to must be different decks');
    if (!B.buffer) throw new Error(`deck ${to} has no track loaded`);
    const ctx = this.ctx, now = ctx.currentTime;
    const warnings = [];
    const sideOf = (d) => (d.xfSide === 'left' ? 0 : d.xfSide === 'right' ? 1 : null);
    const xfFrom = sideOf(A), xfTo = sideOf(B);
    const useXf = xfFrom != null && xfTo != null && xfFrom !== xfTo;

    // nothing playing: just start the incoming deck
    if (!A.playing) {
      B.setRate(1); B.vol.set(Math.max(B.vol.value(), 0.85));
      if (xfTo != null) this.xfader.set(xfTo);
      B.startSource(B.cuePoint, now + 0.05);
      return { style: 'start', note: `deck ${from} was not playing; started ${to}` };
    }

    const masterBpm = A.effBpm;
    const syncRate = this.matchRate(B, masterBpm);
    const bigJump = Math.abs(syncRate - 1) > 0.08;
    const beatSwitch = ['echo', 'cut', 'brake', 'spinback'].includes(style);
    if (bigJump && !beatSwitch) warnings.push(`tempo gap is ${((syncRate - 1) * 100).toFixed(1)}% — incoming will be stretched a lot${B.keylock ? ' (key lock holds its key, but expect stretch artefacts)' : ' and pitched'}; consider --style echo or cut`);
    const incomingRate = beatSwitch && Math.abs(syncRate - 1) > 0.06 ? 1 : syncRate;
    B.setRate(incomingRate);
    B.setLoop(0);

    const beat = 60 / masterBpm, bar = beat * 4;
    const defaultBars = { double: 16, blend: 16, bassswap: 8, fade: 8, filter: 8, echo: 1, cut: 0, brake: 0, spinback: 0 }[style];
    if (defaultBars === undefined) throw new Error(`unknown style "${style}"`);
    const nBars = bars ?? defaultBars;
    const D = nBars * bar;

    // --- when: aligned to the outgoing deck's grid
    let T0;
    if (at === 'now') T0 = now + 0.12;
    else {
      const q = at === 'phrase' ? 32 : 4;
      let nb = this.nextBoundary(A, q);
      if (at === 'phrase' && nb.t - now > 30) nb = this.nextBoundary(A, 16);
      T0 = nb.t;
    }
    // outgoing bar phase at T0 (0 when aligned on a bar)
    const aBeat = A.beatAt(A.position(T0));
    const barPhaseBeats = ((aBeat % 4) + 4) % 4;

    // --- where the incoming track starts
    const tb = B.track;
    const barsIn = beatSwitch ? 0 : nBars;
    let inBeat;
    const snapBar = (sec) => Math.round(B.beatAt(sec) / 4) * 4;
    if (inArg == null || inArg === 'mixin') inBeat = snapBar(tb.mixIn ?? tb.firstBeat ?? 0);
    else if (inArg === 'cue') inBeat = snapBar(B.cuePoint);
    else if (inArg === 'intro') inBeat = snapBar(tb.introEnd ?? 0) - barsIn * 4;
    else if (inArg === 'drop') {
      const bd = (tb.breakdowns || [])[0];
      if (!bd) { warnings.push('no breakdown/drop detected; starting from mix-in'); inBeat = snapBar(tb.mixIn ?? 0); }
      else inBeat = snapBar(bd.drop) - barsIn * 4;
    } else if (/^bar:\d+$/.test(inArg)) inBeat = (Number(inArg.slice(4)) - 1) * 4;
    else if (!isNaN(Number(inArg))) inBeat = snapBar(Number(inArg));
    else throw new Error(`bad --in "${inArg}"`);
    const echoGap = style === 'echo' ? Math.max(1, nBars) * bar : 0;
    const brakeGap = style === 'brake' ? beat * 2 : style === 'spinback' ? beat * 2 : 0;
    let inPos = B.posOfBeat(inBeat + barPhaseBeats);
    let startAt = T0 + echoGap + brakeGap;
    if (inPos < 0) { startAt += -inPos / B.rate; inPos = 0; }

    // double drop: start the incoming so ITS drop lands exactly on the outgoing's next drop
    let dropT = null;
    if (style === 'double') {
      const bd = (tb.breakdowns || [])[0];
      if (!bd) throw new Error(`deck ${to} has no detected drop to double-drop with`);
      const bDropPos = B.posOfBeat(snapBar(bd.drop));
      const lead = Math.min(8, Math.floor(bDropPos / B.rate / bar));
      if (lead < 1) throw new Error('incoming drop is too close to the start of its track');
      dropT = this.nextDropTime(A, lead * bar + 0.25);
      if (dropT == null) throw new Error(`no upcoming drop on deck ${from} — pick another style`);
      T0 = startAt = dropT - lead * bar;
      inPos = bDropPos - lead * bar * B.rate;
    }

    // --- prep incoming channel
    if (B.vol.value() < 0.2) B.vol.set(A.vol.value() || 1);
    const A0 = A.vol.value() || 1, B1 = B.vol.value();
    B.echo.set(0); B.filter.set(0); B.eq.mid.set(0); B.eq.high.set(0); B.eq.low.set(0);
    if (useXf) {
      this.xfader.hold();
      if (Math.abs(this.xfader.value() - xfFrom) > 0.02 && !B.isLive()) this.xfader.set(xfFrom);
    } else {
      B.vol.set(0);
      if (xfTo != null && Math.abs(this.xfader.value() - xfTo) > 0.5) warnings.push(`deck ${to} is on the ${B.xfSide} side but the crossfader is away from it — it may stay quiet`);
    }
    B.startSource(inPos, startAt);

    const P = (t, v, shape) => ({ t, v, shape });
    /** u: 0 = outgoing fully in, 1 = incoming fully in */
    const fade = (pts, { onlyTo = false } = {}) => {
      if (useXf) return this.xfader.automate(pts.map((p) => ({ ...p, v: xfFrom + (xfTo - xfFrom) * p.v })));
      if (!onlyTo) A.vol.automate(pts.map((p) => ({ ...p, v: A0 * Math.pow(xfGainA(p.v), 1 / 1.6) })));
      B.vol.automate(pts.map((p) => ({ ...p, v: B1 * Math.pow(xfGainB(p.v), 1 / 1.6) })));
    };
    let end = T0 + D;
    const half = T0 + Math.round(nBars / 2) * bar;
    const setEchoTime = () => { this.delay.delayTime.setValueAtTime(clamp(beat * 0.75, 0.05, 3.9), now); };

    switch (style) {
      case 'blend': {
        B.eq.low.set(-1);
        B.eq.high.set(-0.35);
        fade([P(T0, 0), P(half, 0.5, 'smooth'), P(end, 1, 'smooth')]);
        B.eq.high.automate([P(T0, -0.35), P(half, 0, 'smooth')]);
        // bass swap on the middle downbeat, over one beat
        A.eq.low.automate([P(half - beat * 0.25, A.eq.low.value()), P(half + beat * 0.25, -1, 'smooth')]);
        B.eq.low.automate([P(half - beat * 0.25, -1), P(half + beat * 0.25, 0, 'smooth')]);
        A.eq.high.automate([P(half, A.eq.high.value()), P(end, -0.6, 'smooth')]);
        break;
      }
      case 'bassswap': {
        B.eq.low.set(-1);
        const q1 = T0 + Math.max(1, Math.round(nBars / 4)) * bar, q3 = T0 + Math.max(1, Math.round((nBars * 3) / 4)) * bar;
        fade([P(T0, 0), P(q1, 0.5, 'smooth'), P(q3, 0.5, 'linear'), P(end, 1, 'smooth')]);
        A.eq.low.automate([P(half - 0.01, A.eq.low.value()), P(half + 0.01, -1, 'linear')]);
        B.eq.low.automate([P(half - 0.01, -1), P(half + 0.01, 0, 'linear')]);
        break;
      }
      case 'double': {
        // incoming rises filtered + bass-less under the build; on the drop both melodies hit with ONE bassline
        B.eq.low.set(-1); B.filter.set(-0.45);
        end = dropT + nBars * bar;
        fade([P(T0, 0), P(dropT - bar, 0.5, 'smooth'), P(end - 4 * bar, 0.5, 'linear'), P(end, 1, 'smooth')]);
        B.filter.automate([P(T0, -0.45), P(dropT, 0, 'in')]);
        A.eq.low.automate([P(dropT - 0.01, A.eq.low.value()), P(dropT + 0.01, -1, 'linear')]);
        B.eq.low.automate([P(dropT - 0.01, -1), P(dropT + 0.01, 0, 'linear')]);
        break;
      }
      case 'fade':
        fade([P(T0, 0), P(end, 1, 'smooth')]);
        break;
      case 'filter':
        B.filter.set(-0.8);
        A.filter.automate([P(T0, A.filter.value()), P(end, 0.85, 'in')]);
        B.filter.automate([P(T0, -0.8), P(end, 0, 'out')]);
        fade([P(T0, 0), P(half, 0.5, 'smooth'), P(end, 1, 'smooth')]);
        break;
      case 'echo': {
        setEchoTime();
        this.feedback.gain.setValueAtTime(0.6, now);
        A.echo.automate([P(T0 - beat, 0), P(T0, 1, 'in')]);
        // cut the dry signal on the downbeat; the delay tail rings through the gap
        A.vol.automate([P(T0, A.vol.value()), P(T0 + 0.03, 0, 'linear')]);
        fade([P(startAt - 0.02, 0), P(startAt, 1, 'linear')], { onlyTo: true });
        end = startAt + 0.05;
        break;
      }
      case 'cut':
        fade([P(T0 - 0.005, 0), P(T0 + 0.005, 1, 'linear')]);
        end = T0 + 0.05;
        break;
      case 'brake': {
        // turntable stop: rate decays exponentially to ~0 over 2 beats (pitch drops with it)
        const r0 = Math.max(0.05, A.rate), pts = [];
        for (let k = 0; k <= 24; k++) pts.push({ t: T0 + (brakeGap * k) / 24, r: r0 * Math.pow(0.02 / r0, k / 24) });
        A.rateCurve(pts, A.rate);
        fade([P(startAt - 0.01, 0), P(startAt, 1, 'linear')]);
        end = startAt;
        break;
      }
      case 'spinback': {
        // the record is spun backwards: fast reverse, slowing to a stop (native reverse playback)
        const pts = [];
        for (let k = 0; k <= 24; k++) pts.push({ t: T0 + (brakeGap * k) / 24, r: -2.6 * Math.pow(0.05 / 2.6, k / 24) });
        A.rateCurve(pts, A.rate);
        fade([P(startAt - 0.01, 0), P(startAt, 1, 'linear')]);
        end = startAt;
        break;
      }
    }

    A.stopAt(end + (style === 'blend' || style === 'bassswap' ? 0.05 : 0));
    const id = Math.random().toString(36).slice(2, 8);
    this.transition = { id, from, to, style, bars: nBars, startAt: this.epoch(T0), endAt: this.epoch(end) };
    setTimeout(() => {
      if (this.transition?.id !== id) return;
      this.transition = null;
      A.resetFx();
      if (style === 'echo') { A.vol.set(A.vol.value() || 1); setTimeout(() => A.echo.set(0), 4000); A.vol.set(1); } else A.echo.set(0);
      if (!useXf && style !== 'echo') A.vol.set(A0); // restore the (now stopped) outgoing channel fader
      if (glide && Math.abs(B.rate - 1) > 0.003 && Math.abs(B.rate - 1) < 0.1) B.glideTo(1, Math.min(90, 32 * (60 / B.effBpm) * 4 / 2));
    }, Math.max(0, (end - now) * 1000 + 60));

    return {
      style, bars: nBars, startsInSec: +(T0 - now).toFixed(2), durationSec: +(end - T0).toFixed(1),
      incoming: { deck: to, startPosition: +inPos.toFixed(2), rate: +B.rate.toFixed(4), bpm: +B.effBpm.toFixed(2) },
      ...(useXf ? {} : { via: 'channel faders' }),
      warnings,
    };
  }

  /**
   * Beat-accurate routine. steps: [{b, d, c, v, o, s} | {b, d, loop, slip} | {b, d, rate} | {b, d, seek} | {b, d, scratch, beats} | {b, sample, vol}]
   *   b = start beat (from the anchor), o = duration in beats,
   *   c = low|mid|high|filter|echo|vol|xfade|master|vocals|drums|bass|other|fx
   * Anchored to the next bar/phrase of the reference deck. EVERYTHING (knobs, loops, jumps, rates, scratches,
   * samples) is scheduled on the audio clock up front — no timers, so it stays tight in a background tab.
   */
  perform({ steps, at = 'bar', ref }) {
    const mixer = this, deckOf = (n) => { const d = this.decks[String(n).toUpperCase()]; if (!d) throw new Error(`no deck "${n}"`); return d; };
    const parsePos = (d, v) => { const mm = /^bar:(\d+)$/.exec(String(v)); if (mm) return d.posOfBeat((Number(mm[1]) - 1) * 4); const n = Number(v); if (isNaN(n)) throw new Error(`bad position "${v}"`); return n; };
    if (!Array.isArray(steps) || !steps.length) throw new Error('perform needs steps');
    const refDeck = ref ? deckOf(ref) : this.liveDeck();
    if (!refDeck) throw new Error('nothing is playing to perform over');
    const now = mixer.ctx.currentTime;
    const beat = 60 / refDeck.effBpm;
    const len = Math.max(...steps.map((s) => s.b + (s.o || 0))) * beat;
    let t0;
    if (at === 'now') t0 = now + 0.08;
    else if (at === 'bar' || at === 'phrase') t0 = mixer.nextBoundary(refDeck, at === 'phrase' ? 32 : 4).t;
    else if (at === 'drop' || at === 'phrase-end') {
      // END-aligned: the routine finishes exactly on the next drop (or phrase boundary)
      let end = at === 'drop' ? mixer.nextDropTime(refDeck, len + 0.3) : null;
      if (end == null) {
        const tMin = now + len + 0.3, b = refDeck.beatAt(refDeck.position(tMin));
        end = tMin + ((Math.ceil(b / 32) * 32 - b) * refDeck.beatLen) / refDeck.rate;
      }
      t0 = end - len;
    } else throw new Error(`bad --at "${at}"`);
    const T = (b) => t0 + b * beat;
    const ctlOf = (s) => {
      if (s.c === 'xfade') return mixer.xfader;
      if (s.c === 'master') return mixer.master;
      const d = deckOf(s.d || refDeck.name);
      if (STEMS.includes(s.c)) {
        if (!d.stemsLoaded) throw new Error(`deck ${d.name} has no stems loaded (step c: ${s.c})`);
        return d.stem[s.c];
      }
      if (s.c === 'fx') {
        if (!d.fx.ctl) throw new Error(`deck ${d.name} has no deck FX — run: dj deckfx ${d.name} <reverb|flanger|phaser|gate|crush> 0 first`);
        return d.fx.ctl;
      }
      return { low: d.eq.low, mid: d.eq.mid, high: d.eq.high, filter: d.filter, echo: d.echo, vol: d.vol }[s.c];
    };
    // group knob moves per control into one continuous automation path
    const paths = new Map();
    for (const s of steps.filter((x) => x.c).sort((a, b) => a.b - b.b)) {
      const ctl = ctlOf(s);
      if (!ctl) throw new Error(`unknown control ${s.c}`);
      if (!paths.has(ctl)) paths.set(ctl, { cur: ctl.value(T(s.b)), pts: [] });
      const p = paths.get(ctl);
      const start = T(s.b), end = start + Math.max(0.006, (s.o || 0) * beat);
      p.pts.push({ t: start, v: p.cur, shape: 'linear' }, { t: end, v: Number(s.v), shape: s.s || (s.o ? 'smooth' : 'linear') });
      p.cur = Number(s.v);
    }
    for (const [ctl, p] of paths) ctl.automate(p.pts);
    if (steps.some((s) => s.c === 'echo')) mixer.delay.delayTime.setValueAtTime(Math.min(3.9, beat * 0.75), now);
    // loop rolls / tempo / jumps / scratches / samples: scheduled as audio-clock events, in beat order
    const slip = new Map(); // deck -> {pos, t, rate} shadow playhead for slip-mode loops
    for (const s of steps.filter((x) => !x.c).sort((a, b) => a.b - b.b)) {
      const tt = T(s.b);
      if (s.sample !== undefined) { mixer.sampler.trigger(Number(s.sample), Math.max(tt, now), s.vol != null ? Number(s.vol) : 1); continue; }
      if (s.pad !== undefined && s.note !== undefined) { // chop keyboard note: {b, pad, note: semis, gain, len(beats)}
        const t1 = Math.max(tt, now), h = mixer.sampler.note(Number(s.pad), Number(s.note), t1, s.gain != null ? Number(s.gain) : 1);
        if (s.len) h.stop(t1 + Number(s.len) * beat);
        continue;
      }
      const d = deckOf(s.d || refDeck.name);
      if (s.loop !== undefined) {
        if (s.loop > 0) {
          if (!slip.has(d) && s.slip !== false) slip.set(d, { pos: d.position(tt), t: tt, rate: d.rate });
          d.setLoop(s.loop, tt, 'round');
        } else {
          d.setLoop(0, tt);
          const sh = slip.get(d);
          if (sh) { slip.delete(d); d.seekAt(sh.pos + (tt - sh.t) * sh.rate, tt); }
        }
      }
      if (s.rate !== undefined) d.setRate(String(s.rate).endsWith('%') ? 1 + Number(String(s.rate).slice(0, -1)) / 100 : Number(s.rate), tt);
      if (s.seek !== undefined) d.seekAt(parsePos(d, s.seek), tt);
      if (s.scratch !== undefined) d.scratchPattern(s.scratch, Number(s.beats) || 1, tt);
    }
    const lastBeat = Math.max(...steps.map((s) => s.b + (s.o || 0)));
    return { startsInSec: +(t0 - now).toFixed(2), durationSec: +(lastBeat * beat).toFixed(1), steps: steps.length };
  }

  speak(text) {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02; u.pitch = 0.9;
    const before = this.master.value();
    this.master.ramp(before * 0.35, this.ctx.currentTime, 0.3);
    u.onend = u.onerror = () => this.master.ramp(before, this.ctx.currentTime, 0.8);
    speechSynthesis.speak(u);
  }

  state() {
    const decks = {};
    for (const [n, d] of Object.entries(this.decks)) if (n === 'A' || n === 'B' || d.track) decks[n] = d.state();
    return {
      started: this.ctx.state === 'running',
      master: { volume: +this.master.value().toFixed(2), xfader: +this.xfader.value().toFixed(2) },
      decks,
      sampler: this.sampler?.state(),
      transition: this.transition,
    };
  }
}
