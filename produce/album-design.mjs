// Album designer: beds + one plan per song → a live design (SECTIONS + WINDOWS) for build-reel.mjs / run-design.mjs.
//
//   node produce/album-design.mjs                 report per section (lines, hooks, coverage, duplicates, missing texts)
//   node produce/album-design.mjs --track N       full timeline of one track
//   ALBUM_BEDS=<beds.mjs> ALBUM_SONGS=<dir>       inputs (defaults .dj/produce/beds.mjs and .dj/produce/songs/)
//
// Every track has a TITLE HOOK (an exact spoken phrase from the caption word index) that returns as a chorus at the top of
// each phrase and leads every drop; drop builds roll the hook's last word as whole-word stabs (halves, then quarters);
// verses are lines that literally match the song's regex, unique across the whole album; scripted lines land at exact
// bars; samples are stabs from any audio file. Schema of a song plan: produce/songs/README.md. Beds: see dj-album skill.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bedRoll, bassKill } from './remix.mjs';
const BEDS = process.env.ALBUM_BEDS || '.dj/produce/beds.mjs';
const SONG_DIR = process.env.ALBUM_SONGS || '.dj/produce/songs';
const base = (await import(pathToFileURL(path.resolve(BEDS)).href)).default;
const SENT = JSON.parse(fs.readFileSync('.dj/voice/sentences.json', 'utf8'));
const CUR = fs.existsSync('.dj/voice/lines.json') ? JSON.parse(fs.readFileSync('.dj/voice/lines.json', 'utf8')) : [];
const WORDS = JSON.parse(fs.readFileSync('.dj/voice/words.json', 'utf8'));
const FEAT = fs.existsSync('.dj/voice/features.json') ? JSON.parse(fs.readFileSync('.dj/voice/features.json', 'utf8')) : {};
const LIB = JSON.parse(fs.readFileSync('.dj/library.json', 'utf8')).tracks;
const tr = (id) => Object.values(LIB).find((t) => t.id === id);
const norm = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, '');
export const MISSING = [], WARN = [];
/** exact phrase from the word index → {id, from, dur, text}; prefers clip `id`, `pick`-th occurrence */
export function phrase(q, { id = null, pick = 0, pre = 0.08, post = 0.12 } = {}) {
  const qs = q.toLowerCase().replace(/[^a-z0-9' ]/g, '').split(/\s+/); const hits = [];
  for (let i = 0; i + qs.length <= WORDS.length; i++) { let ok = true; for (let k = 0; k < qs.length; k++) if (WORDS[i + k].id !== WORDS[i].id || norm(WORDS[i + k].w) !== qs[k]) { ok = false; break; } if (ok) hits.push(i); }
  const cand = id ? hits.filter((i) => WORDS[i].id === id) : hits; const list = cand.length ? cand : hits; const i = list[pick] ?? list[0]; if (i == null) { MISSING.push(q); return null; }
  const a = WORDS[i], b = WORDS[i + qs.length - 1];
  return { id: a.id, from: +(a.t - pre).toFixed(3), dur: +(b.end - a.t + pre + post).toFixed(3), text: q, speaker: a.speaker };
}
const key = (l) => String(l.text || l).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
const BY_TEXT = new Map(); for (const l of [...CUR, ...SENT]) { const k = key(l); if (k && !BY_TEXT.has(k)) BY_TEXT.set(k, l); }
export function lineByText(text) { const l = BY_TEXT.get(key(text)); if (!l) MISSING.push(text); return l || null; }

// song plans
export const SONGS = {};
if (fs.existsSync(SONG_DIR)) for (const f of fs.readdirSync(SONG_DIR).filter((x) => /^track-\d+\.mjs$/.test(x))) { try { const m = (await import(pathToFileURL(path.resolve(SONG_DIR, f)).href)).default; if (m && m.track) SONGS[m.track] = m; } catch (e) { WARN.push(`${f}: ${e.message}`); } }
const bad = (t) => /[,:;]$/.test(t) || /^(and|uh|um|so|but|or|the|a|an|to|of|that|which|is|in|on|with|for|at|by|from|as|if|then|than|just|also|because|like)\b/i.test(t) || /\b(uh|um)\b/i.test(t) || /\[|\]/.test(t) || t.split(' ').length > 12;
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const shuffle = (a, r) => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
const feat = (l) => FEAT[`${l.id}|${l.from}`] || null;
const CAM_ROOT = { '1': 8, '2': 3, '3': 10, '4': 5, '5': 0, '6': 7, '7': 2, '8': 9, '9': 4, '10': 11, '11': 6, '12': 1 };
const scaleOf = (camelot, shift = 0) => { const m = /^(\d+)([AB])$/.exec(camelot || ''); if (!m) return null; let root = CAM_ROOT[m[1]]; if (m[2] === 'B') root = (root + 3) % 12; root = ((root + shift) % 12 + 12) % 12; const iv = m[2] === 'A' ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]; return { root, tones: new Set(iv.map((i) => (root + i) % 12)), chord: new Set([0, m[2] === 'A' ? 3 : 4, 7].map((i) => (root + i) % 12)) }; };
const keyFit = (l, sc) => { const f = feat(l); if (!f || f.pc == null || !sc) return 1; if (sc.chord.has(f.pc)) return 0; if (sc.tones.has(f.pc)) return 0.4; return 1.5; };
const USED = new Set(); const USED_POS = new Map();
const posHas = (l) => (USED_POS.get(l.id) || []).some((f) => Math.abs(f - (l.from || 0)) < 0.45);
const posAdd = (l) => { if (!USED_POS.has(l.id)) USED_POS.set(l.id, []); USED_POS.get(l.id).push(l.from || 0); };
const posDel = (l) => { const a = USED_POS.get(l.id) || []; const i = a.findIndex((f) => Math.abs(f - (l.from || 0)) < 0.45); if (i >= 0) a.splice(i, 1); };
const secKey = (sec) => (/-a$/.test(sec.name) ? 'a' : /-b$/.test(sec.name) ? 'b' : sec.name);
function pools(sec, song) {
  const r = rng(4000 + sec.track * 11 + sec.bars); const sc = scaleOf(tr(sec.bed.id)?.camelot, sec.key || 0);
  const okDur = (l) => l.dur >= 0.5 && l.dur <= 3.6;
  const featured = (song.featured || []).map((t) => lineByText(t)).filter(Boolean);
  const verse = song.verse || /$^/;
  const strict = [...CUR.filter((l) => okDur(l) && verse.test(l.text)), ...SENT.filter((l) => okDur(l) && !bad(l.text) && verse.test(l.text))];
  const punchy = SENT.filter((l) => l.dur >= 0.5 && l.dur <= 2.2 && (l.kind === 'exclaim' || l.kind === 'question') && !bad(l.text));
  const seen = new Set(); const uniq = (arr) => arr.filter((l) => { const k = key(l); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  const soft = (arr) => arr.map((l, i) => [Math.min(1, keyFit(l, sc)), i, l]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
  return { strict: uniq([...featured, ...soft(shuffle(strict, r))]), punchy: uniq(shuffle(punchy, r)) };
}
function plan(sec) {
  const song = SONGS[sec.track]; if (!song || sec.fixed) return { ...sec, _coverage: null, _hooks: 0 };
  const sk = secKey(sec); const bpm = sec.bpm, b2 = (s) => s * bpm / 240, beat = 0.25, barSec = 240 / bpm;
  const hook = song.hook ? phrase(song.hook.q, song.hook) : null; const word = song.word ? phrase(song.word.q, { pre: 0.06, post: 0, ...song.word }) : null;
  const hookLen = hook ? b2(hook.dur) : 0;
  const moves = [...(sec.moves || [])]; for (const d of (song.drops || []).filter((x) => x.sec === sk).flatMap((x) => x.bars)) if (!moves.some((m) => m.kind === 'roll' && m.bar === d)) moves.push({ kind: 'roll', bar: d });
  const drops = moves.filter((m) => m.kind === 'roll').map((m) => m.bar).sort((a, b) => a - b);
  const lines = [], voices = [], taken = [];
  const free = (a, b) => !taken.some(([x, y]) => a < y && b > x); const claim = (a, b) => taken.push([a, b]);
  claim(sec.bars - 2.5, sec.bars + 4); claim(0, 2);
  for (const s of (song.script || []).filter((x) => x.sec === sk)) {
    const l = s.q ? phrase(s.q, { id: s.id, pick: s.pick || 0, post: s.post ?? 0.15 }) : lineByText(s.text); if (!l) continue;
    const len = b2(l.dur); lines.push([+s.end.toFixed(3), l.id, l.from, l.dur, s.label || l.text]); claim(s.end - len - 0.25, s.end + 0.25); USED.add(key(l.text)); posAdd(l);
  }
  for (const smp of song.samples || []) for (const at of (smp.at || []).filter((x) => x.sec === sk)) { voices.push([+at.bar.toFixed(4), smp.id, smp.from, smp.dur, smp.from, smp.dur]); if (!at.under) claim(at.bar, at.bar + b2(smp.dur)); }
  for (const ar of (song.arrangement || []).filter((x) => x.sec === sk)) if (ar.mode === 'music') claim(ar.from, ar.to);
  const sparseAt = (b) => (song.arrangement || []).find((x) => x.sec === sk && x.mode === 'sparse' && b >= x.from && b < x.to);
  for (const d of drops) {
    if (!hook || d - 2 - hookLen - 0.5 < 2) continue;
    if (free(d - 2 - hookLen - 0.5, d - 2)) { lines.push([+(d - 2).toFixed(3), hook.id, hook.from, hook.dur, `♪ ${song.title}`]); claim(d - 2 - hookLen - 0.5, d - 2); }
    if (word && free(d - 2, d)) { const slot = (len) => +Math.min(word.dur, len * barSec - 0.03).toFixed(3);
      for (const bt of [0, 0.5]) voices.push([+(d - 2 + bt).toFixed(4), word.id, word.from, slot(0.5), word.from, word.dur]);
      for (const bt of [0, 0.25, 0.5, 0.75]) voices.push([+(d - 1 + bt).toFixed(4), word.id, word.from, slot(0.25), word.from, word.dur]); }
    claim(d - 2, d + 4);
  }
  const every = song.hookEvery || 16;
  if (hook) for (let b = 9; b < sec.bars - 2.5; b += every) { const a = b - hookLen; if (free(a - 0.5, b + 0.5)) { lines.push([b, hook.id, hook.from, hook.dur, `♪ ${song.title}`]); claim(a - 0.5, b + 0.5); } }
  const P = pools(sec, song); const src = { strict: 0, punchy: 0 }; const order = song.verseOnly === false ? ['strict', 'punchy'] : ['strict'];
  const poolOf = (l) => (P.strict.includes(l) ? 'strict' : 'punchy');
  const take = () => { for (const k of order) for (const l of P[k]) { const kk = key(l); if (USED.has(kk) || posHas(l)) continue; USED.add(kk); posAdd(l); src[k]++; return l; } return null; };
  const gaps = []; const sorted = [...taken].sort((a, b) => a[0] - b[0]); let cur = 0; for (const [a, b] of sorted) { if (a > cur + 0.75) gaps.push([cur, a]); cur = Math.max(cur, b); }
  const rest = song.rest ?? sec.rest ?? 0;
  for (const [ga, gb] of gaps) { let t = ga, misses = 0;
    while (t < gb - 0.5 && misses < 4) { const l = take(); if (!l) break; const f = feat(l); const len = b2(l.dur); const hitB = f ? b2(f.hit) : 0;
      let start = Math.ceil((t + hitB) / beat) * beat - hitB; if (start < t) start += beat; const end = start + len;
      if (end > gb) { USED.delete(key(l)); posDel(l); src[poolOf(l)]--; misses++; continue; }
      lines.push([+end.toFixed(3), l.id, l.from, l.dur, l.text]); const sp = sparseAt(end); t = end + (sp ? (sp.rest ?? 1.5) : rest); misses = 0; } }
  lines.sort((a, b) => a[0] - b[0]); voices.sort((a, b) => a[0] - b[0]);
  return { ...sec, moves, lines, voices, _coverage: +(lines.reduce((a, l) => a + b2(l[3]), 0) / sec.bars).toFixed(2), _hooks: lines.filter((l) => String(l[4]).startsWith('♪')).length, _src: src, _title: song.title, _word: word, _drops: drops };
}
// pre-pass: reserve every scripted line on the record before any verse fill
const SECS = base.sections;
for (const sec of SECS) { const song = SONGS[sec.track]; if (!song) continue; const sk = secKey(sec); for (const sc of (song.script || []).filter((x) => x.sec === sk)) { const l = sc.q ? phrase(sc.q, { id: sc.id, pick: sc.pick || 0 }) : lineByText(sc.text); if (l) { USED.add(key(l.text)); posAdd(l); } } }
MISSING.length = 0;
const sections = SECS.map(plan);
export const TITLES = Object.fromEntries(Object.values(SONGS).map((s) => [s.track, s.title]));
export const DUPES = (() => { const seen = new Map(), out = []; for (const s of sections) for (const l of s.lines || []) { if (String(l[4]).startsWith('♪')) continue; for (const kk of [`${l[1]}|${Math.round(l[2] * 2)}`, 't:' + key(l[4])]) { const p = seen.get(kk); if (p && p.track !== s.track) out.push({ text: l[4], tracks: [p.track, s.track] }); else if (!p) seen.set(kk, { track: s.track }); } } return out; })();
export default { voiceDb: base.voiceDb ?? -13, duck: base.duck ?? 0.8, sections };

// live design for build-reel.mjs / run-design.mjs
export const SECTIONS = [], WINDOWS = [];
for (const s of sections) {
  const fb = s.bed.fromBar;
  SECTIONS.push({ name: s.name, track: s.track, id: s.bed.id, bpm: s.bpm, key: s.key || 0, fromBar: fb, bars: s.bars, stems: s.bed.stems,
    layers: (s.layers || []).map((l) => ({ ...l, from: fb + (l.from ?? 1) - 1, to: l.to ? fb + l.to - 1 : fb + s.bars })),
    handoff: s.handoff ? { drumsIn: s.handoff.drumsIn ?? 8, sweep: !!s.handoff.sweep, carry: s.handoff.carry || null } : null });
  const moves = [];
  for (const m of s.moves || []) { if (m.kind === 'roll') moves.push(...bedRoll(fb + m.bar - 1)); if (m.kind === 'bass') moves.push(...bassKill(fb + m.bar - 1, fb + m.to - 1)); if (m.kind === 'stem') moves.push({ bar: fb + m.bar - 1, c: m.stem, v: m.v, o: m.o || 2 }); }
  WINDOWS.push({ name: s.name, bed: s.name, anchor: fb, bpm: s.bpm, mute: [fb, fb + s.bars],
    lines: (s.lines || []).map(([end, id, from, dur, text]) => [fb + end - 1, id, from, dur, text]),
    slices: [...(s.voices || []), ...((s.handoff && s.handoff.cutLines) || [])].map(([sb, ...rest]) => [fb + sb - 1, ...rest]),
    bedMoves: moves });
}

if (process.argv[1] && /album-design\.mjs$/.test(process.argv[1])) {
  const ti = process.argv.indexOf('--track'); const only = ti > 0 ? Number(process.argv[ti + 1]) : null;
  for (const s of sections) {
    if (only && s.track !== only) continue;
    console.log(String(s.track).padStart(2), s.name.padEnd(10), (s._title || '').padEnd(24), 'lines', String((s.lines || []).length).padStart(3), 'hooks', s._hooks, 'cov', s._coverage, s._src ? `strict ${s._src.strict} punchy ${s._src.punchy}` : '', s._word ? `word "${s._word.text}" ${s._word.dur}s` : '', s._drops ? `drops ${JSON.stringify(s._drops)}` : '');
    if (only) { const ev = [...(s.lines || []).map((l) => [l[0] - l[3] * s.bpm / 240, 'line', l[4], l[3]]), ...(s.voices || []).map((v) => [v[0], 'stab', `${tr(v[1])?.title?.slice(0, 30) || path.basename(String(v[1]))} @${v[2]}s`, v[3]])].sort((a, b) => a[0] - b[0]); for (const [b, k, t, d] of ev) console.log(`   bar ${b.toFixed(2).padStart(7)}  ${k}  ${String(t).slice(0, 80)}  (${(+d).toFixed(2)}s)`); }
  }
  if (MISSING.length) console.log('MISSING', [...new Set(MISSING)]);
  if (WARN.length) console.log('WARN', WARN);
  const dd = DUPES.filter((d, i) => DUPES.findIndex((x) => x.text === d.text) === i); if (dd.length) { console.log(`DUPES across tracks: ${dd.length}`); for (const d of dd) console.log(`   ${d.tracks.join('&')} | ${d.text}`); }
  console.log('song plans loaded:', Object.keys(SONGS).join(' ') || 'none', '| beds:', BEDS, '| windows:', WINDOWS.length);
}
