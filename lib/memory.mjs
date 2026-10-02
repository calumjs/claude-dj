// Set memory: every transition (from/to, style, bars, anchors, monitor warnings) and every rating,
// persisted to .dj/memory.json. Feeds small bonuses/penalties into `suggest`.
import fs from 'node:fs';
import path from 'node:path';

export class Memory {
  constructor(file) {
    this.file = file;
    this.data = { transitions: [] };
    try { this.data = { transitions: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* fresh */ }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }
  get list() { return this.data.transitions; }

  /** entry: {type: 'transition'|'mashup', from:{id,title,artist}, to:{…}, style, bars, at, in, auto, warnings:[types], critique} */
  record(entry) {
    const e = { id: `m${Date.now().toString(36)}`, ts: Date.now(), type: 'transition', rating: null, ...entry };
    this.list.push(e);
    if (this.list.length > 2000) this.list.splice(0, this.list.length - 2000);
    this.save();
    return e;
  }

  /** rate the most recent transition, or the current mashup pair if given */
  rate(rating, note, mashup = null) {
    let e;
    if (mashup) {
      e = [...this.list].reverse().find((x) => x.type === 'mashup' && x.from?.id === mashup.from.id && x.to?.id === mashup.to.id && Date.now() - x.ts < 15 * 60 * 1000);
      if (!e) e = this.record({ type: 'mashup', ...mashup });
    } else e = [...this.list].reverse().find((x) => x.type === 'transition');
    if (!e) return null;
    e.rating = rating; e.note = note || e.note || null; e.ratedAt = Date.now();
    this.save();
    return e;
  }

  /** score delta for playing `to` after `from` (negative = better) + reasons */
  adjust(from, to) {
    let delta = 0;
    const reasons = [];
    const pair = this.list.filter((x) => x.from?.id === from.id && x.to?.id === to.id);
    const good = pair.filter((x) => x.rating === 'good').length, bad = pair.filter((x) => x.rating === 'bad').length;
    if (good) { delta -= Math.min(3, 1.5 * good); reasons.push(`memory: this pair rated good ×${good}`); }
    if (bad) { delta += Math.min(4, 2 * bad); reasons.push(`memory: this pair rated bad ×${bad}`); }
    const warnTypes = new Set(pair.flatMap((x) => x.warnings || []));
    if (warnTypes.size) { delta += Math.min(1.5, 0.5 * warnTypes.size); reasons.push(`memory: past warnings (${[...warnTypes].join(', ')})`); }
    if (from.artist && to.artist) {
      const art = this.list.filter((x) => x.from?.id !== from.id && x.to?.id !== to.id && x.from?.artist === from.artist && x.to?.artist === to.artist && x.rating);
      const g = art.filter((x) => x.rating === 'good').length, b = art.filter((x) => x.rating === 'bad').length;
      if (g > b) { delta -= 0.5; reasons.push(`memory: ${from.artist} → ${to.artist} worked before`); }
      if (b > g) { delta += 0.75; reasons.push(`memory: ${from.artist} → ${to.artist} went badly before`); }
    }
    return { delta: +delta.toFixed(2), reasons };
  }

  /** aggregate per pair: score = goods − bads − 0.3 × warnings */
  pairs() {
    const m = new Map();
    for (const x of this.list) {
      if (!x.from?.id || !x.to?.id) continue;
      const k = `${x.from.id}>${x.to.id}`;
      const p = m.get(k) || { from: x.from, to: x.to, type: x.type, n: 0, good: 0, bad: 0, warnings: 0, styles: new Set(), notes: [] };
      p.n++; if (x.rating === 'good') p.good++; if (x.rating === 'bad') p.bad++;
      p.warnings += (x.warnings || []).length; if (x.style) p.styles.add(x.style); if (x.note) p.notes.push(x.note);
      m.set(k, p);
    }
    return [...m.values()].map((p) => ({ ...p, styles: [...p.styles], score: +(p.good - p.bad - 0.3 * p.warnings).toFixed(2) })).sort((a, b) => b.score - a.score);
  }
}
