// Music library: scan folders, cache analysis, search, and score "what could come next".
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { analyzeFile, refineTrack, ANALYSIS_VERSION, STRUCT_VERSION } from './analyze.mjs';
import { labelSections } from './sections.mjs';
import { shiftCamelot, matchRate, rateSemis } from './music.mjs';

const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'];

export const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.aiff', '.aif', '.webm']);

export const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
export const trackId = (file) => crypto.createHash('sha1').update(path.resolve(file).toLowerCase()).digest('hex').slice(0, 8);

// ---------- Camelot / harmonic mixing ----------
export function parseCamelot(c) {
  const m = /^(\d{1,2})([AB])$/i.exec(String(c || '').trim());
  return m ? { n: Number(m[1]), l: m[2].toUpperCase() } : null;
}
/** 0 = same key, 1 = perfect neighbour (±1 or relative), 2 = energy boost (+2 / diagonal), 3 = clash */
export function keyDistance(a, b) {
  const x = parseCamelot(a), y = parseCamelot(b);
  if (!x || !y) return 2;
  const d = Math.min((x.n - y.n + 12) % 12, (y.n - x.n + 12) % 12);
  if (x.l === y.l) return d === 0 ? 0 : d === 1 ? 1 : d === 2 ? 2 : 3;
  if (d === 0) return 1;                  // relative major/minor
  if (d === 1) return 2;                  // diagonal
  return 3;
}
export function compatibleKeys(c) {
  const k = parseCamelot(c);
  if (!k) return [];
  const w = (n) => ((n - 1 + 12) % 12) + 1;
  const other = k.l === 'A' ? 'B' : 'A';
  return [`${k.n}${k.l}`, `${w(k.n - 1)}${k.l}`, `${w(k.n + 1)}${k.l}`, `${k.n}${other}`];
}
/** effective bpm distance, allowing half/double time */
export function bpmDistancePct(a, b) {
  if (!a || !b) return 99;
  const ratios = [b, b * 2, b / 2].map((x) => Math.abs(x - a) / a);
  return Math.min(...ratios) * 100;
}

function parseFilename(file) {
  const base = path.basename(file, path.extname(file)).replace(/\s*\[[^\]]+\]\s*$/, '');
  const m = /^(.+?)\s+-\s+(.+)$/.exec(base);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: null, title: base.trim() };
}

export class Library {
  constructor({ dirs, cacheFile, targetLoudnessDb = -10, stemsDir = null, log = () => {} }) {
    this.stemsDir = stemsDir;
    this.backfilling = false;
    this.dirs = dirs.map(expandHome).map((d) => path.resolve(d));
    this.cacheFile = cacheFile;
    this.targetLoudnessDb = targetLoudnessDb;
    this.log = log;
    this.tracks = new Map();   // id -> track
    this.pending = new Set();
    this.queue = [];
    this.active = 0;
    this.listeners = new Set();
    // manual beat-grid corrections (dj grid), kept outside the analysis cache so re-analysis re-applies them
    this.editsFile = path.join(path.dirname(cacheFile), 'grid-edits.json');
    try { this.gridEdits = JSON.parse(fs.readFileSync(this.editsFile, 'utf8')); } catch { this.gridEdits = {}; }
    try {
      const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      for (const t of saved.tracks || []) this.tracks.set(t.id, t);
    } catch { /* fresh */ }
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) { for (const fn of this.listeners) fn(ev); }

  save() {
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    fs.writeFileSync(this.cacheFile, JSON.stringify({ savedAt: new Date().toISOString(), tracks: [...this.tracks.values()] }));
  }

  walk(dir, out = []) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) this.walk(p, out);
      else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase()) && !e.name.endsWith('.part')) out.push(p);
    }
    return out;
  }

  /** find new/changed files and queue them for analysis; drop missing ones */
  scan({ force = false } = {}) {
    const seen = new Set();
    let queued = 0;
    for (const dir of this.dirs) {
      for (const file of this.walk(dir)) {
        const id = trackId(file);
        seen.add(id);
        let st; try { st = fs.statSync(file); } catch { continue; }
        const t = this.tracks.get(id);
        if (!force && t && t.size === st.size && t.mtimeMs === st.mtimeMs && t.bpm) continue;
        if (this.enqueue(file)) queued++;
      }
    }
    let removed = 0;
    for (const id of [...this.tracks.keys()]) if (!seen.has(id)) { this.tracks.delete(id); removed++; }
    if (removed) this.save();
    this.backfill();
    return { queued, removed, total: this.tracks.size };
  }

  enqueue(file) {
    const id = trackId(file);
    if (this.pending.has(id)) return false;
    this.pending.add(id);
    this.queue.push({ file, id });
    this.pump();
    return true;
  }

  analyzeNow(file) {
    const id = trackId(file);
    return new Promise((resolve) => { this.pending.add(id); this.queue.unshift({ file, id, resolve }); this.pump(); });
  }

  pump() {
    while (this.active < 2 && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      this.emit({ type: 'analyzing', id: job.id, file: job.file });
      this.analyzeOne(job.file)
        .then((t) => { job.resolve?.(t); this.emit({ type: 'analyzed', id: t.id, track: this.summary(t) }); })
        .catch((e) => { this.log(`analysis failed for ${job.file}: ${e.message}`); job.resolve?.(null); this.emit({ type: 'analysis_failed', id: job.id, error: e.message }); })
        .finally(() => { this.active--; this.pending.delete(job.id); if (!this.queue.length && !this.active) this.save(); this.pump(); });
    }
  }

  async analyzeOne(file) {
    const st = fs.statSync(file);
    const ed = this.gridEdits[trackId(file)];
    const grid = ed && ed.size === st.size && Math.round(ed.mtimeMs) === Math.round(st.mtimeMs) ? ed.edit : null;
    const a = await analyzeFile(file, { targetLoudnessDb: this.targetLoudnessDb, grid });
    const fromName = parseFilename(file);
    const prev = this.tracks.get(trackId(file));
    // the vocal map comes from the stems, which stay valid while the file is unchanged
    const keep = prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.vocalSections
      ? { vocalSections: prev.vocalSections, vocalPct: prev.vocalPct, vocalLoudDb: prev.vocalLoudDb, vocalMapVersion: prev.vocalMapVersion } : {};
    const t = {
      id: trackId(file),
      file: path.resolve(file),
      size: st.size,
      mtimeMs: st.mtimeMs,
      addedAt: this.tracks.get(trackId(file))?.addedAt || new Date().toISOString(),
      ...a,
      ...keep,
      title: a.title || fromName.title,
      artist: a.artist || fromName.artist,
    };
    this.relabel(t);
    this.tracks.set(t.id, t);
    return t;
  }

  /** derived structure: vocal-section bar numbers on the current grid, section labels */
  relabel(t) {
    if (t.bpm && Array.isArray(t.vocalSections)) {
      const bar = (60 / t.bpm) * 4, fb = t.firstBeat || 0;
      for (const s of t.vocalSections) {
        s.startBar = Math.max(1, Math.floor((s.start - fb) / bar + 0.25) + 1);
        s.endBar = Math.max(s.startBar, Math.ceil((s.end - fb) / bar - 0.25));
      }
    }
    const sec = labelSections(t);
    if (sec) t.sections = sec;
    return t;
  }
  /** called by the stem queue when a vocal map lands */
  onVocalMap(t) { this.relabel(t); this.emit({ type: 'analyzed', id: t.id, track: this.summary(t) }); }

  /**
   * Manual grid correction. op = { shift: beats, nudge: ms, bpm: x } (cumulative) or { reset: true }.
   * Re-derives intro/outro/breakdowns/phrase energy, beat map and sections on the corrected grid.
   */
  async gridEdit(id, op = {}) {
    const t = this.tracks.get(id);
    if (!t) throw new Error('no such track');
    const prev = this.gridEdits[id]?.edit || {};
    const edit = op.reset ? {} : {
      shiftBeats: (prev.shiftBeats || 0) + (Number(op.shift) || 0),
      nudgeMs: (prev.nudgeMs || 0) + (Number(op.nudge) || 0),
      ...(op.bpm ? { bpm: Number(op.bpm) } : prev.bpm ? { bpm: prev.bpm } : {}),
    };
    const upd = await refineTrack(t, { grid: edit });
    Object.assign(t, upd);
    if (op.reset) { delete t.gridEdit; delete this.gridEdits[id]; }
    else this.gridEdits[id] = { edit, size: t.size, mtimeMs: t.mtimeMs, at: new Date().toISOString() };
    this.relabel(t);
    fs.mkdirSync(path.dirname(this.editsFile), { recursive: true });
    fs.writeFileSync(this.editsFile, JSON.stringify(this.gridEdits, null, 2));
    this.save();
    this.emit({ type: 'analyzed', id: t.id, track: this.summary(t) });
    return t;
  }

  /**
   * Cheap upgrade for tracks analysed by an older version: audible bounds + mix-out cap (v2),
   * beat map / drift / per-bar features / section labels (STRUCT_VERSION). One decode per track,
   * no re-analysis. Runs in the background at idle priority. DJ_NO_BACKFILL=1 disables it (tests).
   */
  async backfill() {
    if (this.backfilling || process.env.DJ_NO_BACKFILL) return;
    this.backfilling = true;
    let n = 0;
    try {
      for (const t of [...this.tracks.values()]) {
        const old = (t.analysisVersion || 1) < ANALYSIS_VERSION || t.audioEnd == null;
        if (!old && t.structVersion === STRUCT_VERSION) continue;
        if (this.pending.has(t.id)) continue;
        try {
          const ed = this.gridEdits[t.id];
          const upd = await refineTrack(t, { grid: ed && ed.size === t.size ? ed.edit : null });
          const cur = this.tracks.get(t.id);
          if (!cur || cur !== t) continue; // re-analysed meanwhile
          Object.assign(t, upd);
          this.relabel(t);
          n++;
          this.emit({ type: 'analyzed', id: t.id, track: this.summary(t) });
          if (n % 5 === 0) this.save();
          await new Promise((r) => setTimeout(r, 400)); // gentle: never hog the server's event loop
        } catch (e) { this.log(`analysis backfill failed for ${t.file}: ${e.message}`); }
      }
    } finally {
      this.backfilling = false;
      if (n) { this.save(); this.log(`Backfilled beat maps + section labels for ${n} track(s)`); }
    }
  }

  hasStems(id) {
    return !!this.stemsDir && STEM_NAMES.every((s) => fs.existsSync(path.join(this.stemsDir, id, `${s}.wav`)));
  }

  status() { return { tracks: this.tracks.size, analyzing: this.active, queued: this.queue.length }; }

  get(idOrQuery) {
    if (!idOrQuery) return null;
    if (this.tracks.has(idOrQuery)) return this.tracks.get(idOrQuery);
    const hits = this.search({ q: idOrQuery, limit: 1 });
    return hits.length ? this.tracks.get(hits[0].id) : null;
  }

  /** compact view without waveform, for lists and for Claude */
  summary(t) {
    const { waveform, file, size, mtimeMs, phraseEnergy, vocalLoudDb, vocalMapVersion, barEnergy, barBass, phraseChroma, gridDetected, structVersion, ...rest } = t;
    const out = { ...rest, file: path.basename(file), phraseEnergy };
    if (this.hasStems(t.id)) out.stems = [...STEM_NAMES];
    return out;
  }

  search({ q, bpm, key, compatibleWith, energy, genre, limit = 50, sort } = {}) {
    let list = [...this.tracks.values()];
    if (q) {
      const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
      list = list.filter((t) => {
        const hay = `${t.artist || ''} ${t.title || ''} ${t.genre || ''} ${path.basename(t.file)} ${t.id}`.toLowerCase();
        return terms.every((w) => hay.includes(w));
      });
    }
    if (bpm) {
      const [lo, hi] = String(bpm).includes('-') ? String(bpm).split('-').map(Number) : [Number(bpm) - 3, Number(bpm) + 3];
      list = list.filter((t) => t.bpm >= lo && t.bpm <= hi);
    }
    if (key) {
      const keys = String(key).split(',').map((k) => k.trim().toUpperCase());
      list = list.filter((t) => keys.includes(String(t.camelot).toUpperCase()));
    }
    if (compatibleWith) {
      const ref = this.get(compatibleWith);
      if (ref) { const ks = compatibleKeys(ref.camelot); list = list.filter((t) => t.id !== ref.id && ks.includes(t.camelot)); }
    }
    if (energy) {
      const [lo, hi] = String(energy).includes('-') ? String(energy).split('-').map(Number) : [Number(energy), Number(energy)];
      list = list.filter((t) => t.energy >= lo && t.energy <= hi);
    }
    if (genre) list = list.filter((t) => (t.genre || '').toLowerCase().includes(String(genre).toLowerCase()));
    const sorters = {
      bpm: (a, b) => a.bpm - b.bpm,
      energy: (a, b) => b.energy - a.energy,
      key: (a, b) => (parseCamelot(a.camelot)?.n || 0) - (parseCamelot(b.camelot)?.n || 0),
      added: (a, b) => String(b.addedAt).localeCompare(String(a.addedAt)),
      title: (a, b) => String(a.artist || a.title).localeCompare(String(b.artist || b.title)),
    };
    list.sort(sorters[sort] || sorters.title);
    return list.slice(0, Number(limit) || 50).map((t) => this.summary(t));
  }

  /**
   * Rank candidates to follow `from`. direction: up | down | hold (energy). Lower score = better.
   * Key-aware: the incoming track's key is judged at the pitch it will actually play at (live tempo,
   * unless keylock), against the live deck's effective key; a ±1–2 semitone keyShift is recommended
   * when it turns a clash into a neighbour. memory (optional) adds bonuses/penalties from past mixes.
   */
  suggest({ from, direction = 'hold', exclude = [], limit = 10, targetBpm, refCamelot, keylock = false, memory } = {}) {
    const ref = this.get(from);
    if (!ref) return [];
    const bpmRef = targetBpm || ref.bpm;
    const refKey = refCamelot || ref.camelot;
    const out = [];
    for (const t of this.tracks.values()) {
      if (t.id === ref.id || exclude.includes(t.id) || !t.bpm) continue;
      const k = this.keyPlan(refKey, t, bpmRef, keylock);
      const bd = bpmDistancePct(bpmRef, t.bpm);
      const de = (t.energy || 5) - (ref.energy || 5);
      const want = direction === 'up' ? 1 : direction === 'down' ? -1 : 0;
      const energyPenalty = Math.abs(de - want) * 0.8;
      const mem = memory ? memory.adjust(ref, t) : { delta: 0, reasons: [] };
      const score = k.score + Math.max(0, bd - 1) * 0.9 + energyPenalty + mem.delta;
      const reasons = [
        k.reason,
        bd < 0.5 ? 'tempo match' : `${bd.toFixed(1)}% tempo change`,
        de === 0 ? 'same energy' : de > 0 ? `energy +${de}` : `energy ${de}`,
        ...mem.reasons,
      ];
      out.push({ score: +score.toFixed(2), reasons, effectiveKey: k.effectiveKey, recommendedKeyShift: k.shift, ...(k.shift ? { shiftedKey: k.shiftedKey } : {}), ...this.summary(t) });
    }
    return out.sort((a, b) => a.score - b.score).slice(0, limit);
  }

  /** incoming track t played at bpmRef: effective key, key distance to refKey, and the best ±2 st fix */
  keyPlan(refKey, t, bpmRef, keylock = false) {
    const semis = keylock ? 0 : Math.round(rateSemis(matchRate(t.bpm, bpmRef)));
    const eff = shiftCamelot(t.camelot, semis);
    const kd0 = keyDistance(refKey, eff);
    let shift = 0, kd = kd0, shiftedKey = eff;
    if (kd0 >= 2) {
      for (const s of [1, -1, 2, -2]) {
        const k2 = shiftCamelot(eff, s), d = keyDistance(refKey, k2);
        if (d <= 1 && d < kd) { shift = s; kd = d; shiftedKey = k2; break; }
      }
    }
    const names = ['same key', 'harmonic neighbour', 'energy-boost key move', 'key clash'];
    const at = semis ? ` at live tempo (${semis > 0 ? '+' : ''}${semis} st)` : '';
    const reason = shift
      ? `${names[kd0]} ${refKey}→${eff}${at}; keyShift ${shift > 0 ? '+' : ''}${shift} st → ${shiftedKey} (${names[kd]})`
      : `${names[kd0]} (${refKey}→${eff}${at})`;
    return { effectiveKey: eff, semis, kd0, kd, shift, shiftedKey, score: kd * 2 + Math.abs(shift) * 0.6, reason };
  }

  /**
   * Mashup mode: vocal-over-bed pairs. Needs vocal maps (stems): vocal track vocalPct ≥ 0.25,
   * bed vocalPct ≤ 0.08, bpm within 8%, compatible keys with the vocal played at the bed's tempo.
   * With `from`, pairs are built around that track.
   */
  mashups({ from, exclude = [], limit = 10, memory } = {}) {
    const all = [...this.tracks.values()].filter((t) => t.bpm && typeof t.vocalPct === 'number' && !exclude.includes(t.id));
    const ref = from ? this.get(from) : null;
    const vocals = all.filter((t) => t.vocalPct >= 0.25), beds = all.filter((t) => t.vocalPct <= 0.08);
    const brief = (t) => ({ id: t.id, title: t.title, artist: t.artist, bpm: t.bpm, camelot: t.camelot, vocalPct: t.vocalPct, energy: t.energy });
    const pairs = [];
    for (const v of vocals) for (const b of beds) {
      if (v.id === b.id) continue;
      if (ref && v.id !== ref.id && b.id !== ref.id) continue;
      const bd = bpmDistancePct(b.bpm, v.bpm);
      if (bd > 8) continue;
      const k = this.keyPlan(b.camelot, v, b.bpm, false);
      if (k.kd > 2) continue;
      const mem = memory ? memory.adjust(b, v) : { delta: 0, reasons: [] };
      const score = k.score + bd * 0.4 + (1 - v.vocalPct) * 2 + b.vocalPct * 10 + mem.delta;
      pairs.push({
        score: +score.toFixed(2), vocal: brief(v), bed: brief(b), effectiveKey: k.effectiveKey, recommendedKeyShift: k.shift,
        reasons: [`vocals ${Math.round(v.vocalPct * 100)}% over a ${Math.round(b.vocalPct * 100)}%-vocal bed`, k.reason.replace('live tempo', 'bed tempo'), bd < 0.5 ? 'tempo match' : `${bd.toFixed(1)}% tempo change`, ...mem.reasons],
      });
    }
    return pairs.sort((a, b) => a.score - b.score).slice(0, limit);
  }
}
