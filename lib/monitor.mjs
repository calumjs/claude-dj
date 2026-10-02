// Mix monitor: machine "ears" for a DJ that can't hear. Every 250 ms, from engine state + analysis:
//   vocal clash · key clash (effective keys) · beat-phase offset (flamming) · tempo mismatch ·
//   clipping (master.peakDb) · energy dip (everything audible in a breakdown / low phrase for > 16 bars)
// and a short critique after every transition.
import { keyDistance } from './library.mjs';
import { deckEffectiveCamelot, beatOfTime, beatLenAt, vocalsUp, harmonicUp, effBpm } from './music.mjs';

const AUDIBLE = 0.3;
const FLAM_MS = 20;

export class Monitor {
  constructor({ library, onCritique = () => {}, onWarning = () => {} }) {
    this.library = library;
    this.onCritique = onCritique;
    this.onWarning = onWarning;
    this.since = new Map();  // warning type -> first seen ts (continuous)
    this.last = { ts: 0, audible: [], warnings: [], checks: {} };
    this.dipSince = null;
    this.cur = null;         // transition being critiqued
    this.recent = [];        // recent warning events
  }

  trackOf(d) {
    const lt = d.trackId ? this.library.tracks.get(d.trackId) : null;
    // the engine's copy (bpm/firstBeat) is what it plays with; the library adds beatMap / sections / vocals
    return lt ? { ...lt, bpm: d.bpm || lt.bpm, firstBeat: d.firstBeat ?? lt.firstBeat, ...(d.bpm && lt.bpm && Math.abs(d.bpm - lt.bpm) > 0.01 ? { beatMap: null } : {}) } : (d.bpm ? { bpm: d.bpm, firstBeat: d.firstBeat || 0 } : null);
  }

  deckInfo(name, d) {
    const t = this.trackOf(d);
    const pos = d.position ?? 0;
    const info = { deck: name, audible: d.audible || 0, effectiveKey: deckEffectiveCamelot(d), harmonic: harmonicUp(d), vocalsUp: vocalsUp(d) };
    if (!t) return info;
    info.track = t;
    if (Array.isArray(t.vocalSections)) info.inVocal = t.vocalSections.some((s) => pos >= s.start && pos < s.end);
    const sec = (t.sections || []).find((s) => pos >= s.start && pos < s.end);
    if (sec) info.section = sec.label;
    const inBreakdown = (t.breakdowns || []).some((b) => pos >= b.start && pos < b.drop);
    const bar = t.bpm ? Math.floor(beatOfTime(t, pos) / 4) : null;
    const pe = bar != null && t.phraseEnergy ? t.phraseEnergy[Math.floor(bar / 8)] : null;
    info.lowEnergy = inBreakdown || sec?.label === 'breakdown' || (pe != null && pe < 0.3);
    if (t.bpm) {
      info.beat = beatOfTime(t, pos);
      info.beatSec = beatLenAt(t, pos) / (d.rate || 1);
      info.effBpm = effBpm(d);
    }
    return info;
  }

  /** phase offset (ms) of b against a, handling half/double time */
  static phase(a, b) {
    if (a.beat == null || b.beat == null || !a.effBpm || !b.effBpm) return null;
    const ratio = a.effBpm / b.effBpm;
    let fa = a.beat, fb = b.beat, period = a.beatSec;
    if (Math.abs(ratio - 2) < 0.1) fb = b.beat * 2;           // a is double time: compare on a's grid
    else if (Math.abs(ratio - 0.5) < 0.05) { fa = a.beat * 2; period = b.beatSec; }
    else if (Math.abs(ratio - 1) > 0.08) return { offsetMs: null, bpmDiffPct: +((ratio - 1) * 100).toFixed(2) };
    let d = (fa - fb) % 1; if (d < -0.5) d += 1; if (d >= 0.5) d -= 1;
    const r = Math.abs(ratio - 2) < 0.1 ? ratio / 2 : Math.abs(ratio - 0.5) < 0.05 ? ratio * 2 : ratio;
    return { offsetMs: +(d * period * 1000).toFixed(1), bpmDiffPct: +((r - 1) * 100).toFixed(2) };
  }

  tick(s) {
    const now = Date.now();
    const warnings = [];
    const checks = {};
    const decks = Object.entries(s.decks || {}).filter(([, d]) => d.playing && d.trackId);
    const infos = decks.map(([n, d]) => this.deckInfo(n, d));
    const aud = infos.filter((i) => i.audible > AUDIBLE).sort((x, y) => y.audible - x.audible);
    const warn = (type, msg, extra = {}) => warnings.push({ type, msg, ...extra });

    if (aud.length >= 2) {
      const [a, b] = aud;
      // vocals
      const vox = aud.filter((i) => i.inVocal && i.vocalsUp);
      checks.vocals = { known: aud.filter((i) => i.inVocal != null).map((i) => i.deck), singing: vox.map((i) => i.deck) };
      if (vox.length >= 2) warn('vocal-clash', `vocal clash: decks ${vox.map((i) => i.deck).join('+')} both have vocals up — kill one (dj stem <deck> vocals 0, or eq mid -1)`, { decks: vox.map((i) => i.deck) });
      // keys
      const kd = a.effectiveKey && b.effectiveKey ? keyDistance(a.effectiveKey, b.effectiveKey) : null;
      checks.key = { a: a.effectiveKey, b: b.effectiveKey, distance: kd, harmonic: [a.harmonic, b.harmonic] };
      if (kd === 3 && a.harmonic && b.harmonic) warn('key-clash', `key clash: ${a.deck} ${a.effectiveKey} vs ${b.deck} ${b.effectiveKey} with bass/melody up on both — cut one deck's low+mid or finish the mix`, { decks: [a.deck, b.deck] });
      // phase
      const ph = Monitor.phase(a, b);
      if (ph) {
        checks.phase = { decks: [a.deck, b.deck], ...ph };
        if (ph.offsetMs != null && Math.abs(ph.offsetMs) > FLAM_MS) warn('flam', `flamming: ${b.deck} is ${Math.abs(ph.offsetMs).toFixed(0)} ms ${ph.offsetMs > 0 ? 'behind' : 'ahead of'} ${a.deck} — re-sync (dj sync ${b.deck}) or check the grid (dj grid)`, { decks: [a.deck, b.deck], offsetMs: ph.offsetMs });
        if (ph.offsetMs != null && Math.abs(ph.bpmDiffPct) > 0.15) warn('tempo-drift', `tempo mismatch ${ph.bpmDiffPct}% between ${a.deck} and ${b.deck}: phase will drift`, { decks: [a.deck, b.deck] });
      }
    }
    // clipping
    const pk = s.master?.peakDb;
    if (typeof pk === 'number') { checks.peakDb = pk; if (pk >= -0.3) warn('clipping', `master clipping (peak ${pk.toFixed(1)} dBFS) — lower gain: dj master 0.8`); }
    // energy dip
    if (aud.length && aud.every((i) => i.lowEnergy)) {
      this.dipSince ??= now;
      const barSec = 240 / (aud[0].effBpm || 128);
      const bars = (now - this.dipSince) / 1000 / barSec;
      checks.dipBars = +bars.toFixed(1);
      if (bars > 16) warn('energy-dip', `energy dip: everything audible has been in a breakdown/low section for ${Math.round(bars)} bars`);
    } else this.dipSince = null;

    // continuity (since) + events
    const types = new Set(warnings.map((w) => w.type));
    for (const t of [...this.since.keys()]) if (!types.has(t)) this.since.delete(t);
    for (const w of warnings) {
      if (!this.since.has(w.type)) { this.since.set(w.type, now); this.recent.push({ ts: now, ...w }); if (this.recent.length > 100) this.recent.shift(); this.onWarning(w); }
      w.since = this.since.get(w.type);
      w.forSec = +((now - w.since) / 1000).toFixed(1);
    }
    this.last = {
      ts: now, audible: aud.map((i) => i.deck),
      decks: Object.fromEntries(infos.map((i) => [i.deck, { audible: i.audible, effectiveKey: i.effectiveKey, section: i.section ?? null, inVocal: i.inVocal ?? null, vocalsUp: i.vocalsUp, harmonic: i.harmonic, lowEnergy: !!i.lowEnergy }])),
      checks, warnings,
    };
    this.critique(s, now);
    return this.last;
  }

  // ---------------------------------------------------------------- transition critiques
  critique(s, now) {
    const tr = s.transition;
    if (this.cur && (!tr || tr.id !== this.cur.id)) { this.finish(now); }
    if (tr && (!this.cur || this.cur.id !== tr.id)) {
      const d = (n) => s.decks?.[n] || {};
      const brief = (x) => ({ id: x.trackId, title: x.title, artist: x.artist, camelot: x.camelot, bpm: x.bpm });
      this.cur = { id: tr.id, from: tr.from, to: tr.to, style: tr.style, bars: tr.bars, startAt: tr.startAt, endAt: tr.endAt, fromTrack: brief(d(tr.from)), toTrack: brief(d(tr.to)), n: 0, warn: {}, msgs: new Set(), phase: [], keys: new Set(), checked: new Set() };
    }
    const c = this.cur;
    if (!c || now < c.startAt) return;
    c.n++;
    if (!c.toTrack.id && s.decks?.[c.to]?.trackId) { const x = s.decks[c.to]; c.toTrack = { id: x.trackId, title: x.title, artist: x.artist, camelot: x.camelot, bpm: x.bpm }; }
    const ch = this.last.checks;
    if (ch.phase?.offsetMs != null) { c.phase.push(Math.abs(ch.phase.offsetMs)); c.checked.add('phase'); }
    if (ch.key?.distance != null) { c.keys.add(`${ch.key.a}/${ch.key.b}`); c.checked.add('key'); }
    if (ch.vocals?.known?.length >= 2) c.checked.add('vocals');
    if (ch.peakDb != null) c.checked.add('clipping');
    c.checked.add('energy');
    for (const w of this.last.warnings) { c.warn[w.type] = (c.warn[w.type] || 0) + 0.25; c.msgs.add(w.type); }
  }

  finish(now) {
    const c = this.cur; this.cur = null;
    if (!c || c.n < 2) return; // cancelled before it started
    const ph = c.phase.length ? { maxMs: Math.max(...c.phase), meanMs: +(c.phase.reduce((a, b) => a + b, 0) / c.phase.length).toFixed(1) } : null;
    const issues = Object.entries(c.warn).map(([t, secs]) => ({ type: t, seconds: +secs.toFixed(1) }));
    const verdict = issues.length ? 'issues' : 'clean';
    const label = (t) => `${t.artist ? t.artist + ' - ' : ''}${t.title || '?'}`;
    const parts = [];
    if (ph) parts.push(`phase max ${ph.maxMs.toFixed(0)} ms (avg ${ph.meanMs})`);
    if (c.keys.size) parts.push(`keys ${[...c.keys][0]}`);
    if (!c.checked.has('vocals')) parts.push('vocals not checked (no vocal map)');
    const text = `🧐 Critique ${c.from}→${c.to} ${c.style} ${c.bars ?? ''} bars (${label(c.fromTrack)} → ${label(c.toTrack)}): ${verdict === 'clean' ? 'clean' : '⚠ ' + issues.map((i) => `${i.type} ${i.seconds}s`).join(', ')}${parts.length ? ' — ' + parts.join(', ') : ''}`;
    this.onCritique({ ts: now, transitionId: c.id, from: c.from, to: c.to, style: c.style, bars: c.bars, startAt: c.startAt, endAt: c.endAt, fromTrack: c.fromTrack, toTrack: c.toTrack, checked: [...c.checked], phase: ph, keys: [...c.keys], issues, warnings: [...c.msgs], verdict, text });
  }
}
