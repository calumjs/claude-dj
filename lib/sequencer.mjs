// Timeline sequencer + track queue + auto-DJ safety net (server side, ticks every 250 ms).
//
// Plan step: { id, when, cmd, args, why }
//   when: {deck, bar}            fire when that deck reaches bar N (1-based, like bar:N)
//         {deck, beforeMixout: s} s seconds before that deck's mix-out point
//         {deck, beforeEnd: s}   s seconds before that deck's audible end
//         {after: stepId, sec}   sec seconds after that step's command took effect
//         {at: epochMs}          wall clock
//   optional when.track: only fire while that track is on the deck.
// Anchored commands (mix / perform / fx / hotcue / savedloop / play, and knob moves which are turned
// into a one-step perform) are sent ~1 bar early and land exactly via the command's own --at anchoring
// (default 'phrase' for mix/perform/fx, 'bar' when the step targets a specific bar).
import { timeOfBar, deckEffectiveCamelot, effBpm } from './music.mjs';
import { keyDistance, bpmDistancePct } from './library.mjs';
import { FX, FX_DEFAULT_AT } from './fx.mjs';

const KNOBS = { eq: 1, filter: 1, vol: 1, echo: 1, xfade: 1, loop: 1 };
const ANCHORED = new Set(['mix', 'perform', 'fx', 'hotcue', 'savedloop', 'play', 'scratch']);
const PSEUDO = new Set(['fx', 'hotcue', 'savedloop', 'say', 'autodj', 'queue']);

export class Sequencer {
  /**
   * ctx: { library, liveState, runCmd({cmd,args,why,source}), addLog, sessionLog, history (array),
   *        hotcue(args), savedloop(args), say(text), memory, config }
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.steps = [];
    this.seq = 0;
    this.queue = [];               // [{id, title, artist, addedAt}]
    const a = ctx.config?.autoDJ || {};
    this.auto = { enabled: a.enabled !== false, leadSec: Number(a.leadSec) || 45, busy: false, cooldownUntil: 0, prepared: null, last: null };
  }

  // ---------------------------------------------------------------- plan
  validate(st) {
    const w = st.when;
    if (!w || typeof w !== 'object') throw new Error('step needs "when"');
    const ok = (w.deck && (w.bar != null || w.beforeMixout != null || w.beforeEnd != null)) || w.after || w.at != null;
    if (!ok) throw new Error('when must be {deck, bar} | {deck, beforeMixout} | {deck, beforeEnd} | {after, sec} | {at}');
    if (w.deck) w.deck = String(w.deck).toUpperCase();
    if (w.after && !this.steps.some((s) => s.id === w.after)) throw new Error(`no plan step "${w.after}"`);
    if (!st.cmd || typeof st.cmd !== 'string') throw new Error('step needs "cmd"');
  }
  add(input) {
    const list = Array.isArray(input) ? input : [input];
    const added = [];
    for (const raw of list) {
      const st = { id: raw.id || `p${++this.seq}`, when: { ...raw.when }, cmd: raw.cmd, args: { ...(raw.args || {}) }, why: raw.why || null, status: 'pending', addedAt: Date.now() };
      if (this.steps.some((s) => s.id === st.id)) throw new Error(`duplicate step id ${st.id}`);
      this.validate(st);
      this.steps.push(st); added.push(st);
    }
    return added;
  }
  remove(id) { const i = this.steps.findIndex((s) => s.id === id); if (i < 0) return false; this.steps.splice(i, 1); return true; }
  clear(all = false) { const n = this.steps.length; this.steps = all ? [] : this.steps.filter((s) => s.status !== 'pending'); return n - this.steps.length; }
  pending() { return this.steps.filter((s) => s.status === 'pending' || s.status === 'firing'); }

  /** seconds until the step's target moment (null = unknown / waiting) */
  eta(st, s) {
    const w = st.when, now = Date.now();
    if (w.at != null) return (Number(w.at) - now) / 1000;
    if (w.after) {
      const ref = this.steps.find((x) => x.id === w.after);
      if (!ref || ref.status !== 'fired') return null;
      return (ref.effectiveAt + (Number(w.sec) || 0) * 1000 - now) / 1000;
    }
    const d = s.decks?.[w.deck];
    if (!d?.trackId || !d.playing) return null;
    if (w.track) { const t = this.ctx.library.get(w.track); if (!t || t.id !== d.trackId) return null; }
    if (w.bar != null) {
      const lt = this.ctx.library.tracks.get(d.trackId);
      const grid = { bpm: d.bpm || lt?.bpm, firstBeat: d.firstBeat ?? lt?.firstBeat ?? 0 };
      if (!grid.bpm) return null;
      return (timeOfBar(grid, Number(w.bar)) - d.position) / (d.rate || 1);
    }
    if (w.beforeMixout != null) return d.untilMixOut != null ? d.untilMixOut - Number(w.beforeMixout) : null;
    if (w.beforeEnd != null) return d.remaining != null ? d.remaining - Number(w.beforeEnd) : null;
    return null;
  }
  barSec(s, st) {
    const d = s.decks?.[st.when.deck] || s.decks?.[s.live];
    return d?.bpm ? 240 / effBpm(d) : 2;
  }
  anchored(st) { return ANCHORED.has(st.cmd) || KNOBS[st.cmd]; }

  async tickPlan(s) {
    for (const st of this.steps) {
      if (st.status !== 'pending') continue;
      if (st.when.after) {
        const ref = this.steps.find((x) => x.id === st.when.after);
        if (ref && (ref.status === 'failed' || ref.status === 'skipped')) { st.status = 'skipped'; st.error = `step ${ref.id} ${ref.status}`; this.ctx.addLog('system', `📋 Plan ${st.id} skipped (${st.error})`); continue; }
      }
      const eta = this.eta(st, s);
      if (eta == null) continue;
      const bar = this.barSec(s, st);
      const lead = this.anchored(st) ? 0.9 * bar : 0.05;
      // anchored commands need the boundary at least ~0.2 s ahead; closer than that we'd land a bar late
      const late = this.anchored(st) ? eta < 0.2 : eta < -0.3;
      if (eta > lead && !late) continue;
      // past the target (e.g. added after the bar): still fire on the next anchor, but say so
      if (late) st.late = true;
      await this.fire(st, s);
    }
  }

  /** turn a step into the concrete command, resolving decks/tracks at fire time */
  resolve(st, s) {
    const a = { ...st.args };
    let cmd = st.cmd;
    const live = s.live;
    const defAt = st.when.bar != null ? 'bar' : 'phrase';
    if (cmd === 'mix') {
      a.from = (a.from || live || 'A').toUpperCase();
      a.to = (a.to || this.pickIdle(s, a.from)?.name || (a.from === 'A' ? 'B' : 'A')).toUpperCase();
      a.at ??= defAt;
      if (a.track === 'next' || a.track === 'queue') { const q = this.nextFromQueue(); if (!q) throw new Error('queue is empty'); a.track = q.id; }
    }
    if (cmd === 'load' && (a.track === 'next' || a.track === 'queue')) { const q = this.nextFromQueue(); if (!q) throw new Error('queue is empty'); a.track = q.id; }
    if (cmd === 'load' && !a.deck) a.deck = this.pickIdle(s, live)?.name;
    if (cmd === 'perform') a.at ??= defAt;
    if (cmd === 'play' && a.at == null && s.live) a.at = 'bar';
    if (KNOBS[cmd]) {
      // exact timing: a one-step perform anchored to the bar
      const D = (a.deck || live || 'A').toUpperCase();
      const step = cmd === 'loop' ? { b: 0, d: D, loop: a.beats === 'off' ? 0 : Number(a.beats ?? 8), slip: false }
        : { b: 0, d: D, c: cmd === 'eq' ? a.band : cmd, v: Number(a.value), o: Number(a.ramp) || 0 };
      if (cmd === 'xfade') delete step.d;
      return { cmd: 'perform', args: { steps: [step], at: a.at || 'bar', ref: live || D } };
    }
    if (cmd === 'fx') {
      const D = (a.deck || live || 'A').toUpperCase(), O = this.pickIdle(s, D)?.name || (D === 'A' ? 'B' : 'A');
      const presets = FX(D, O);
      if (!presets[a.name]) throw new Error(`unknown fx "${a.name}"`);
      return { cmd: 'perform', args: { steps: presets[a.name], at: a.at || (FX_DEFAULT_AT[a.name] === 'bar' ? defAt : FX_DEFAULT_AT[a.name] || defAt), ref: D } };
    }
    return { cmd, args: a };
  }

  async fire(st, s) {
    st.status = 'firing';
    let r;
    try {
      const { cmd, args } = this.resolve(st, s);
      st.sent = { cmd, args: cmd === 'perform' ? { ...args, steps: args.steps.length } : args };
      const why = `📋 ${st.id}${st.why ? ': ' + st.why : ''}${st.late ? ' (late)' : ''}`;
      if (cmd === 'hotcue') r = await this.ctx.hotcue({ ...args, action: 'jump' }, why);
      else if (cmd === 'savedloop') r = await this.ctx.savedloop({ ...args, action: 'jump' }, why);
      else if (cmd === 'say') { this.ctx.say(args.text); r = { ok: true }; }
      else if (cmd === 'autodj') { this.setAuto(args.on !== false && args.on !== 'off'); r = { ok: true }; }
      else if (cmd === 'queue') { this.enqueue([].concat(args.add || args.track || [])); r = { ok: true }; }
      else r = await this.ctx.runCmd({ cmd, args, why, source: 'plan' });
    } catch (e) { r = { ok: false, error: e.message }; }
    st.firedAt = Date.now();
    st.status = r.ok === false ? 'failed' : 'fired';
    st.result = r.result ?? null; st.error = r.error || null;
    st.effectiveAt = st.firedAt + (Number(r.result?.startsInSec) || 0) * 1000;
    const line = `📋 Plan ${st.id} ${st.status}: ${st.cmd}${st.late ? ' (late)' : ''}${st.error ? ' — ' + st.error : ''}${r.result?.startsInSec != null ? ` (lands in ${r.result.startsInSec}s)` : ''}`;
    this.ctx.addLog('system', line);
    this.ctx.sessionLog('plan.jsonl', { ts: st.firedAt, id: st.id, when: st.when, cmd: st.cmd, sent: st.sent, why: st.why, status: st.status, late: !!st.late, error: st.error, result: st.result });
  }

  view(s) {
    return this.steps.map((st) => {
      const e = st.status === 'pending' ? this.eta(st, s) : null;
      return { ...st, etaSec: e != null ? +e.toFixed(1) : null };
    });
  }

  // ---------------------------------------------------------------- queue
  enqueue(items) {
    const added = [], missing = [];
    for (const q of items) {
      const t = this.ctx.library.get(String(q));
      if (!t) { missing.push(q); continue; }
      this.queue.push({ id: t.id, title: t.title, artist: t.artist, bpm: t.bpm, camelot: t.camelot, addedAt: Date.now() });
      added.push(t.id);
    }
    return { added, missing, queue: this.queue };
  }
  nextFromQueue() { return this.queue.shift() || null; }
  onAir(id) { const i = this.queue.findIndex((q) => q.id === id); if (i >= 0) this.queue.splice(i, 1); }

  // ---------------------------------------------------------------- auto-DJ
  setAuto(on, leadSec) {
    this.auto.enabled = !!on;
    if (leadSec) this.auto.leadSec = Number(leadSec);
    this.ctx.addLog('system', `🤖 Auto-DJ ${on ? 'ON' : 'OFF'}${on ? ` (takes over when ${this.auto.leadSec}s of audible music are left and nothing is planned)` : ''}`);
  }

  /** a deck to bring the next track in on: not playing, opposite crossfader side preferred */
  pickIdle(s, live) {
    const decks = s.decks || {};
    const liveSide = decks[live]?.xfAssign || (live === 'A' || live === 'C' ? 'left' : 'right');
    const recent = new Set(this.ctx.history.slice(-30).map((h) => h.id));
    const names = new Set(['A', 'B', ...Object.keys(decks)]);
    const cands = [...names].filter((n) => n !== live && !decks[n]?.playing).map((n) => {
      const d = decks[n] || {};
      const side = d.xfAssign || (n === 'A' || n === 'C' ? 'left' : 'right');
      let score = 0;
      if (side !== liveSide && side !== 'thru') score += 2;
      if (d.trackId && !recent.has(d.trackId) && !d.loading) score += 1;
      if (n === 'A' || n === 'B') score += 0.5;
      return { name: n, score, track: d.trackId && !recent.has(d.trackId) ? d.trackId : null };
    });
    return cands.sort((a, b) => b.score - a.score)[0] || null;
  }

  pickNext(s, live, idle) {
    const ld = s.decks[live];
    // a track Claude already loaded (and hasn't played) wins
    if (idle?.track && idle.track !== ld.trackId) { const t = this.ctx.library.tracks.get(idle.track); if (t) return { t, why: 'already loaded' }; }
    while (this.queue.length) {
      const q = this.queue[0];
      const t = this.ctx.library.tracks.get(q.id);
      if (t) return { t, why: 'from the queue', fromQueue: true };
      this.queue.shift();
    }
    const exclude = [...this.ctx.history.map((h) => h.id), ...Object.values(s.decks || {}).map((d) => d.trackId).filter(Boolean)];
    const idleDeck = s.decks[idle?.name] || {};
    const list = this.ctx.library.suggest({ from: ld.trackId, exclude, limit: 1, targetBpm: effBpm(ld) || undefined, refCamelot: deckEffectiveCamelot(ld), keylock: !!idleDeck.keylock, memory: this.ctx.memory });
    if (!list.length) return null;
    return { t: this.ctx.library.tracks.get(list[0].id), why: `best suggestion (${list[0].reasons.slice(0, 2).join(', ')})` };
  }

  /** the safe mix for a pair */
  chooseStyle(s, live, t, idleName) {
    const ld = s.decks[live];
    const bpmLive = effBpm(ld) || t.bpm;
    const gap = bpmDistancePct(bpmLive, t.bpm);
    const keylock = !!s.decks[idleName]?.keylock;
    const kp = this.ctx.library.keyPlan(deckEffectiveCamelot(ld) || ld.camelot, t, bpmLive, keylock);
    const compatible = keyDistance(deckEffectiveCamelot(ld) || ld.camelot, kp.effectiveKey) <= 2;
    const hasDrop = !!t.breakdowns?.length;
    if (gap <= 6 && compatible) return { style: 'bassswap', bars: 8, in: hasDrop ? 'drop' : 'mixin', gap, keys: `${deckEffectiveCamelot(ld)}→${kp.effectiveKey}` };
    if (gap <= 6) return { style: 'filter', bars: 8, in: 'mixin', gap, keys: `${deckEffectiveCamelot(ld)}→${kp.effectiveKey} clash` };
    return { style: 'echo', bars: 1, in: hasDrop ? 'drop' : 'mixin', gap, keys: `${deckEffectiveCamelot(ld)}→${kp.effectiveKey}` };
  }

  async tickAuto(s) {
    const A = this.auto;
    if (!A.enabled || A.busy || Date.now() < A.cooldownUntil) return;
    if (!s.engine?.connected || s.engine.stale || s.transition || !s.live) return;
    const live = s.live, ld = s.decks[live];
    if (!ld?.playing || ld.remaining == null) return;
    // someone (Claude) is layering decks by hand, or a mix is planned: stay out of it
    if (Object.entries(s.decks).some(([n, d]) => n !== live && d.playing && (d.audible || 0) > 0.3)) return;
    if (this.pending().some((st) => st.cmd === 'mix' || (st.cmd === 'play' && st.args?.deck !== live))) return;
    const rem = ld.remaining, need = A.leadSec;
    if (rem > need + 25) { A.prepared = null; return; }
    A.busy = true;
    try {
      let idle = this.pickIdle(s, live);
      if (!idle) return;
      // stage 1 (≤ lead+25 s): make sure the next track is on the idle deck
      if (!A.prepared || A.prepared.live !== ld.trackId) {
        const pick = this.pickNext(s, live, idle);
        if (!pick?.t) { if (!A.warnedEmpty) { A.warnedEmpty = true; this.ctx.addLog('system', '🤖 Auto-DJ: nothing left to play (queue empty, no suggestions)'); } return; }
        A.warnedEmpty = false;
        if (pick.t.id !== idle.track) {
          if (pick.fromQueue) this.queue.shift();
          const r = await this.ctx.runCmd({ cmd: 'load', args: { deck: idle.name, track: pick.t.id }, why: `🤖 Auto-DJ: cueing ${pick.t.artist ? pick.t.artist + ' - ' : ''}${pick.t.title} (${pick.why})`, source: 'autodj' });
          if (r.ok === false) { A.cooldownUntil = Date.now() + 5000; return; }
        } else if (pick.fromQueue) this.queue.shift();
        A.prepared = { live: ld.trackId, deck: idle.name, track: pick.t.id, why: pick.why };
        this.ctx.addLog('system', `🤖 Auto-DJ: ${pick.t.title} is ready on ${idle.name}; I'll mix at ${need}s left unless you do (dj autodj off to stop me)`);
        return;
      }
      if (rem > need) return;
      // stage 2: mix
      const s2 = this.ctx.liveState();
      if (s2.transition) return;
      const deck = A.prepared.deck, t = this.ctx.library.tracks.get(A.prepared.track);
      if (!t || s2.decks[deck]?.trackId !== t.id) { A.prepared = null; return; }
      const c = this.chooseStyle(s2, live, t, deck);
      const barSec = 240 / (effBpm(ld) || 128);
      const mixSec = c.bars * barSec;
      const at = rem > mixSec + 8 * barSec + 3 ? 'phrase' : 'bar';
      const why = `🤖 Auto-DJ: ${ld.title} → ${t.title}: ${c.style} ${c.bars} bar${c.bars > 1 ? 's' : ''}${c.in !== 'mixin' ? ' --in ' + c.in : ''} @${at} (tempo gap ${c.gap.toFixed(1)}%, keys ${c.keys}, ${Math.round(rem)}s left, nothing planned)`;
      this.ctx.addLog('system', why);
      const r = await this.ctx.runCmd({ cmd: 'mix', args: { from: live, to: deck, style: c.style, bars: c.bars, at, in: c.in, glide: true }, why, source: 'autodj' });
      A.last = { ts: Date.now(), from: live, to: deck, track: t.id, ...c, at, ok: r.ok !== false, error: r.error };
      A.prepared = null;
      A.cooldownUntil = Date.now() + (r.ok === false ? 5000 : 6000); // the transition shows up in state within a push
    } finally { A.busy = false; }
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickPlan(this.ctx.liveState());
      await this.tickAuto(this.ctx.liveState());
    } catch (e) { this.ctx.addLog('system', `⚠ sequencer: ${e.message}`); }
    finally { this.ticking = false; }
  }

  summary(s) {
    const p = this.pending();
    const next = p.map((st) => ({ id: st.id, cmd: st.cmd, eta: this.eta(st, s) })).filter((x) => x.eta != null).sort((a, b) => a.eta - b.eta)[0];
    return {
      autoDJ: { enabled: this.auto.enabled, leadSec: this.auto.leadSec, prepared: this.auto.prepared, last: this.auto.last },
      plan: { pending: p.length, next: next ? { ...next, eta: +next.eta.toFixed(1) } : null },
      queue: this.queue.map((q) => q.id),
    };
  }
}
