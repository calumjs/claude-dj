// Remix toolkit for spoken lines (natural pitch only). Everything returns "slices": [startBar, clip, from, dur, refFrom, refDur]
// placed START-aligned on the bar grid; refFrom/refDur is the whole line (used to level every chop of a line the same).
//   full · head · chunk · stutter · gate · cutup · rollIn  — plus bed moves: bedRoll (slip loop roll) · bassKill · drumKill · cutBeat
import { chop } from './chops.mjs';

export async function bank(lines) { // { key: [clip, from, dur] } → { key: { clip, start, end, chunks, ref } }
  const out = {};
  for (const [k, [clip, from, dur]] of Object.entries(lines)) { const c = await chop(clip, from, dur); out[k] = { clip, ...c, ref: [from, dur] }; }
  return out;
}
export function kit(B, bpm) {
  const barSec = 240 / bpm, s16 = barSec / 16;
  const L = (k) => { const l = B[k]; if (!l) throw new Error(`no line ${k}`); return l; };
  const sl = (bar, l, from, dur) => [+bar.toFixed(4), l.clip, +from.toFixed(3), +Math.max(0.03, dur).toFixed(3), l.ref[0], l.ref[1]];
  const len = (k) => L(k).end - L(k).start;
  const k = {
    barSec, s16, len,
    /** the whole line from its true first syllable */
    full: (key, bar) => [sl(bar, L(key), L(key).start, len(key))],
    /** the first n16 sixteenths of the line */
    head: (key, bar, n16 = 1) => [sl(bar, L(key), L(key).start, Math.min(len(key), n16 * s16 - 0.008))],
    /** one syllable/word chunk (index from the chop bank), optionally cut to n16 */
    chunk: (key, i, bar, n16 = null) => { const c = L(key).chunks[Math.min(i, L(key).chunks.length - 1)]; return [sl(bar, L(key), c.from, n16 ? Math.min(c.dur, n16 * s16 - 0.008) : c.dur)]; },
    /** "l-l-l-let's get into it": reps heads every len16, then the full line */
    stutter: (key, bar, reps = 4, len16 = 1) => [...Array(reps)].flatMap((_, i) => k.head(key, bar + (i * len16) / 16, len16)).concat(k.full(key, bar + (reps * len16) / 16)),
    /** trance-gate a sentence: the line plays in place, only the 16ths marked 1 sound ("1011 0110 ...", spaces ignored) */
    gate: (key, bar, pattern) => { const p = pattern.replace(/\s/g, ''); const out = []; for (let i = 0; i < p.length; i++) { const f = L(key).start + i * s16; if (f >= L(key).end) break; if (p[i] === '1') out.push(sl(bar + i / 16, L(key), f, Math.min(s16 - 0.006, L(key).end - f))); } return out; },
    /** rearrange chunks on the grid: slots = [[chunkIndex, at16], ...] relative to bar */
    cutup: (key, bar, slots, n16 = null) => slots.flatMap(([i, at]) => k.chunk(key, i, bar + at / 16, n16)),
    /** accelerating roll into `drop`: last `bars` bars go 1/2 → 1/4 → 1/8 → 1/16 of the head (or of chunk `ci`) */
    rollIn: (key, drop, bars = 4, ci = null) => {
      const divs = [2, 4, 8, 16].slice(-bars), out = [];
      divs.forEach((d, b) => { for (let i = 0; i < d; i++) { const at = drop - bars + b + i / d, n16 = 16 / d; out.push(...(ci == null ? k.head(key, at, n16) : k.chunk(key, ci, at, n16))); } });
      return out;
    },
    /** presenters trading: [[key, bar], ...] full lines */
    trade: (pairs) => pairs.flatMap(([key, bar]) => k.full(key, bar)),
  };
  return k;
}
// bed moves for the runner (d is filled in with the window's bed deck)
export const bedRoll = (drop) => [ // slip loop roll in the bar before the drop: 2 → 1 → 1/2 → 1/4 beat, released on the drop
  { bar: drop - 1, loop: 2 }, { bar: drop - 1, beat: 2, loop: 1 }, { bar: drop - 1, beat: 3, loop: 0.5 }, { bar: drop - 1, beat: 3.5, loop: 0.25 }, { bar: drop, loop: 0 },
];
export const bassKill = (from, to) => [{ bar: from, c: 'bass', v: 0, o: 0.25 }, { bar: to, c: 'bass', v: 1 }];
export const drumKill = (from, to) => [{ bar: from, c: 'drums', v: 0, o: 0.1 }, { bar: to, c: 'drums', v: 1 }];
export const cutBeat = (bar, beat = 3, beats = 1) => [{ bar, beat, c: 'vol', v: 0, o: 0.02 }, { bar, beat: beat + beats, c: 'vol', v: 1, o: 0.02 }];
