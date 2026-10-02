// Section labels (intro | verse | chorus | build | drop | breakdown | outro) from the per-bar
// features stored by analysis (barEnergy, barBass, phraseChroma), the structure fields
// (introEndBar, outroStartBar, breakdowns) and the vocal map when stems exist.
// Pure + cheap, so it re-runs whenever the vocal map or the grid changes.
import { timeOfBeat } from './music.mjs';

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
function cosine(a, b) {
  let n = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { n += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return n / Math.sqrt(x * y || 1e-12);
}

/** 0-based bar j -> 1-based bars in the output (bar N = CLI bar:N), endBar inclusive */
export function labelSections(t) {
  const E = t.barEnergy, B = t.barBass;
  if (!Array.isArray(E) || !E.length || !t.bpm) return null;
  const n = E.length;
  const barT = (j) => +timeOfBeat(t, j * 4).toFixed(2);
  const intro = Math.min(n, t.introEndBar ?? 0), outro = Math.min(n, t.outroStartBar ?? n);
  const lab = new Array(n).fill('body');
  for (let j = 0; j < intro; j++) lab[j] = 'intro';
  for (let j = outro; j < n; j++) lab[j] = 'outro';
  const bds = (t.breakdowns || []).filter((b) => b.endBar > b.startBar);
  for (const bd of bds) {
    for (let j = bd.startBar; j < Math.min(n, bd.endBar); j++) if (lab[j] === 'body') lab[j] = 'breakdown';
    // the tail of a breakdown that rises in energy is the build
    const len = bd.endBar - bd.startBar, half = Math.floor(len / 2);
    const rising = half >= 2 && mean(E.slice(bd.endBar - half, bd.endBar)) > 1.1 * mean(E.slice(bd.startBar, bd.startBar + half));
    const buildLen = len >= 16 ? 8 : len >= 8 && rising ? 4 : 0;
    if (buildLen && (rising || len >= 16)) for (let j = Math.max(bd.startBar, bd.endBar - buildLen); j < Math.min(n, bd.endBar); j++) if (lab[j] === 'breakdown') lab[j] = 'build';
  }

  // vocals per bar (only when the vocal map exists)
  const hasVox = Array.isArray(t.vocalSections);
  const vox = new Array(n).fill(false);
  if (hasVox) for (const s of t.vocalSections) for (let j = 0; j < n; j++) {
    const a = barT(j), b = barT(j + 1), ov = Math.min(b, s.end) - Math.max(a, s.start);
    if (ov > 0.5 * (b - a)) vox[j] = true;
  }
  const vocalTrack = hasVox && (t.vocalPct ?? 0) >= 0.15;

  const bodyE = E.filter((_, j) => lab[j] === 'body');
  const hiE = median(bodyE) || 1;

  // drops: from each breakdown's end while the energy stays up (max 32 bars)
  for (const bd of bds) {
    for (let j = bd.endBar; j < Math.min(n, bd.endBar + 32) && lab[j] === 'body'; j++) {
      if (E[j] < 0.8 * hiE || (B && B[j] < 0.5)) break;
      lab[j] = vocalTrack && vox[j] ? 'chorus' : 'drop';
    }
  }

  // the rest of the body, per 8-bar phrase: energy + repetition (chroma self-similarity)
  const C = t.phraseChroma || [];
  const centre = C.length ? C[0].map((_, i) => mean(C.map((c) => c[i]))) : [];
  const cen = C.map((c) => c.map((v, i) => v - centre[i]));
  const phE = (p) => mean(E.slice(p * 8, p * 8 + 8));
  const repeated = (p) => cen.some((c, q) => Math.abs(q - p) > 1 && cen[p] && cosine(cen[p], c) > 0.6 && Math.abs(phE(p) - phE(q)) < 0.15);
  for (let p = 0; p * 8 < n; p++) {
    const bars = []; for (let j = p * 8; j < Math.min(n, p * 8 + 8); j++) if (lab[j] === 'body') bars.push(j);
    if (!bars.length) continue;
    const e = mean(bars.map((j) => E[j])), high = e >= 0.95 * hiE;
    const vPh = bars.filter((j) => vox[j]).length >= bars.length / 2;
    let l;
    if (hasVox && vocalTrack) l = high && (vPh || repeated(p)) ? 'chorus' : 'verse';
    else if (hasVox) l = high ? (bds.length ? 'drop' : 'chorus') : 'verse';
    else l = high && repeated(p) ? (bds.length ? 'drop' : 'chorus') : 'verse';
    for (const j of bars) lab[j] = l;
  }

  // merge runs; fold slivers (< 2 bars) into their neighbour
  const out = [];
  for (let j = 0; j < n; j++) {
    const last = out[out.length - 1];
    if (last && last.label === lab[j]) last.e = j + 1; else out.push({ label: lab[j], s: j, e: j + 1 });
  }
  for (let i = out.length - 1; i > 0; i--) if (out[i].e - out[i].s < 2) { out[i - 1].e = out[i].e; out.splice(i, 1); }
  for (let i = out.length - 1; i > 0; i--) if (out[i].label === out[i - 1].label) { out[i - 1].e = out[i].e; out.splice(i, 1); }
  const endT = t.audioEnd ?? t.duration;
  return out.map((x) => ({ label: x.label, startBar: x.s + 1, endBar: x.e, start: barT(x.s), end: Math.min(barT(x.e), endT ?? Infinity) }));
}
