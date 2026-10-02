// Pure music helpers shared by the server features: Camelot shifting, effective keys,
// beat-grid maths (constant grid or a drift-corrected beatMap), stem/EQ "is it audible" tests.

export const rateSemis = (rate) => 12 * Math.log2(rate || 1);

/** +1 semitone = +7 Camelot steps (mod 12), letter unchanged */
export function shiftCamelot(code, semis) {
  const m = /^(\d{1,2})([AB])$/i.exec(String(code || '').trim());
  if (!m) return code ?? null;
  const s = Math.round(semis || 0);
  const n = ((((Number(m[1]) - 1 + 7 * s) % 12) + 12) % 12) + 1;
  return `${n}${m[2].toUpperCase()}`;
}

/** effective Camelot key of a deck (engine state): engine's own value, else camelot shifted by the pitch change of rate */
export function deckEffectiveCamelot(d) {
  if (!d) return null;
  if (d.effectiveCamelot) return d.effectiveCamelot;
  if (!d.camelot) return null;
  const semis = (Number(d.keyShift) || 0) + (d.keylock ? 0 : rateSemis(d.rate || 1));
  return shiftCamelot(d.camelot, Math.round(semis));
}

/** tempo ratio the engine would use to bring `ownBpm` to `targetBpm` (half/double time allowed) */
export function matchRate(ownBpm, targetBpm) {
  if (!ownBpm || !targetBpm) return 1;
  return [targetBpm / ownBpm, (targetBpm * 2) / ownBpm, targetBpm / 2 / ownBpm].sort((a, b) => Math.abs(a - 1) - Math.abs(b - 1))[0];
}

// ---------------------------------------------------------------- beat grid
// Beat 0 = firstBeat = the downbeat of bar 1. Bars are 1-based like the CLI's bar:N.
// beatMap (optional, from analysis) = [{startBeat, time, bpm}] segments; beats in a segment are evenly spaced.
function segs(t) { return Array.isArray(t?.beatMap) && t.beatMap.length ? t.beatMap : null; }

export function timeOfBeat(t, beat) {
  const m = segs(t);
  if (!m) return (t.firstBeat || 0) + (beat * 60) / t.bpm;
  let s = m[0];
  for (const x of m) { if (x.startBeat <= beat) s = x; else break; }
  return s.time + ((beat - s.startBeat) * 60) / s.bpm;
}
export function beatOfTime(t, sec) {
  const m = segs(t);
  if (!m) return ((sec - (t.firstBeat || 0)) * t.bpm) / 60;
  let s = m[0];
  for (const x of m) { if (x.time <= sec) s = x; else break; }
  return s.startBeat + ((sec - s.time) * s.bpm) / 60;
}
/** time at which 1-based bar N starts */
export const timeOfBar = (t, bar) => timeOfBeat(t, (bar - 1) * 4);
export const barOfTime = (t, sec) => Math.floor(beatOfTime(t, sec) / 4) + 1;
/** local beat length (s) around a time, native speed */
export function beatLenAt(t, sec) {
  const m = segs(t);
  if (!m) return 60 / t.bpm;
  let s = m[0];
  for (const x of m) { if (x.time <= sec) s = x; else break; }
  return 60 / s.bpm;
}
/** snap a time to the nearest beat (or bar, beats=4) */
export function snapTime(t, sec, beats = 1) {
  const b = Math.round(beatOfTime(t, sec) / beats) * beats;
  return timeOfBeat(t, b);
}

// ---------------------------------------------------------------- deck mixer state
/** gain of a stem on a deck (1 when stems aren't loaded: the full mix is playing) */
export function stemGain(d, name) {
  const s = d?.stems;
  if (!s || s.loaded === false || typeof s[name] !== 'number') return 1;
  return s[name];
}
/** vocals actually reaching the speakers from this deck (ignoring where we are in the track) */
export function vocalsUp(d) {
  return stemGain(d, 'vocals') > 0.3 && (d.eq?.mid ?? 0) > -0.7 && (d.filter ?? 0) > -0.6 && (d.filter ?? 0) < 0.8;
}
/** harmonic (key-carrying) content audible: bass up, or mids/melodic stems up */
export function harmonicUp(d) {
  const low = (d.eq?.low ?? 0) > -0.5 && stemGain(d, 'bass') > 0.3;
  const melodic = (d.eq?.mid ?? 0) > -0.7 && (stemGain(d, 'other') > 0.3 || stemGain(d, 'vocals') > 0.3);
  return low || melodic;
}
export const effBpm = (d) => (d?.bpm || 0) * (d?.rate || 1);
