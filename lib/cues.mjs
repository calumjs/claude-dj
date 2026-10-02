// Hot cues 1–8 and named saved loops per track, persisted in .dj/cues.json (outside the analysis
// cache, so re-analysis never loses them). Empty slots are auto-filled from the analysis:
// 1 start (mix-in) · 2 first vocal-in · 3 first chorus · 4 first drop · 5 first breakdown · 6 mix-out.
import fs from 'node:fs';
import path from 'node:path';
import { barOfTime, timeOfBar, snapTime } from './music.mjs';

const r2 = (v) => +Number(v).toFixed(3);

export function autoCues(t) {
  if (!t?.bpm) return {};
  const cues = {};
  const put = (n, sec, label, snapBar = true) => {
    if (sec == null || isNaN(sec)) return;
    const s = snapBar ? timeOfBar(t, barOfTime(t, sec + 0.05)) : sec;
    cues[n] = { sec: r2(Math.max(0, s)), bar: barOfTime(t, s + 0.01), label, auto: true };
  };
  put(1, t.mixIn ?? t.firstBeat ?? 0, 'start');
  const sec = t.sections || [];
  const first = (l) => sec.find((x) => x.label === l);
  if (t.vocalSections?.length) {
    // vocals often come in just before the bar line: snap to the nearest bar, not the one we're inside
    const v = t.vocalSections[0].start;
    const b = Math.round((v - timeOfBar(t, 1)) / ((240 / t.bpm))) + 1;
    cues[2] = { sec: r2(Math.max(0, timeOfBar(t, Math.max(1, b)))), bar: Math.max(1, b), label: 'vocal-in', auto: true };
  }
  if (first('chorus')) put(3, first('chorus').start, 'chorus');
  const drop = first('drop')?.start ?? t.breakdowns?.[0]?.drop;
  if (drop != null) put(4, drop, 'drop');
  const bd = first('breakdown')?.start ?? t.breakdowns?.[0]?.start;
  if (bd != null) put(5, bd, 'breakdown');
  if (t.mixOut != null) put(6, t.mixOut, 'mix-out');
  return cues;
}

export class Cues {
  constructor(file) {
    this.file = file;
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = {}; }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1));
  }
  entry(id) { return (this.data[id] ||= { hotcues: {}, loops: {} }); }

  /** merged view: user cues override auto cues slot by slot */
  view(t) {
    const user = this.data[t.id] || { hotcues: {}, loops: {} };
    const auto = autoCues(t);
    const hotcues = {};
    for (let n = 1; n <= 8; n++) {
      if (user.hotcues[n] === null) continue; // explicitly cleared
      const c = user.hotcues[n] || auto[n];
      if (c) hotcues[n] = c;
    }
    return { hotcues, loops: { ...user.loops } };
  }
  cue(t, n) { return this.view(t).hotcues[n] || null; }

  /** snap to the beat unless exact; bar for display */
  setCue(t, n, sec, { label, exact = false } = {}) {
    if (!(n >= 1 && n <= 8)) throw new Error('hot cue number must be 1–8');
    const s = exact || !t.bpm ? sec : snapTime(t, sec, 1);
    const c = { sec: r2(Math.max(0, s)), bar: t.bpm ? barOfTime(t, s + 0.01) : null, label: label || null, auto: false, at: Date.now() };
    this.entry(t.id).hotcues[n] = c;
    this.save();
    return c;
  }
  clearCue(t, n) { this.entry(t.id).hotcues[n] = null; this.save(); }
  resetCue(t, n) { delete this.entry(t.id).hotcues[n]; this.save(); }

  setLoop(t, name, start, beats) {
    if (!name || !/^[\w-]{1,24}$/.test(name)) throw new Error('loop name: letters, digits, - or _ (max 24)');
    const b = Number(beats);
    if (!(b > 0 && b <= 64)) throw new Error('beats must be between 1/32 and 64');
    const s = t.bpm ? snapTime(t, start, b < 1 ? b : 1) : start;
    const l = { start: r2(Math.max(0, s)), beats: b, bar: t.bpm ? barOfTime(t, s + 0.01) : null, at: Date.now() };
    this.entry(t.id).loops[name] = l;
    this.save();
    return l;
  }
  loop(t, name) { return this.data[t.id]?.loops?.[name] || null; }
  deleteLoop(t, name) { const e = this.entry(t.id); const had = !!e.loops[name]; delete e.loops[name]; this.save(); return had; }
}
