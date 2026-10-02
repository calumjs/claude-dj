// Live design runner: plays a design (SECTIONS from a design module, reel windows from .dj/voices/<name>-reel.json) on the
// DJ table — beds on A/B with their vocals muted, the voice reel on C, layers/carries on D, hand-offs between sections —
// melodic layers on D. Each section ends with a voice cut: outgoing bass out, highs away, slip roll, incoming lands on the
// downbeat at its first bar. Gentle ducks (0.8) under the voice. Records and exports.   node produce/run-design.mjs --design <design.mjs> [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { beatOfTime, timeOfBar } from '../lib/music.mjs';
// usage: node produce/run-design.mjs --design <design.mjs> [--dry] [--resume <sectionIndex> [--armed]]
const designPath = process.argv.includes('--design') ? process.argv[process.argv.indexOf('--design') + 1] : null;
if (!designPath) { console.log('usage: run-design.mjs --design <design.mjs> [--dry] [--resume i]'); process.exit(1); }
const DESIGN = path.basename(designPath, '.mjs');
const { SECTIONS } = await import(pathToFileURL(path.resolve(designPath)).href);

const DRY = process.argv.includes('--dry'); const RESUME = process.argv.includes('--resume') ? Number(process.argv[process.argv.indexOf('--resume') + 1]) : -1; const ARMED = process.argv.includes('--armed');
const post = async (cmd, args, why) => (await (await fetch('http://localhost:4747/api/cmd', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, args, why }) })).json());
const get = async () => (await fetch('http://localhost:4747/api/state')).json();
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
fs.mkdirSync('.dj/produce/out', { recursive: true });
const TIMES = { design: null, recordStart: null, windows: [], screen: null }; const saveTimes = () => fs.writeFileSync('.dj/produce/out/run-design-times.json', JSON.stringify(TIMES, null, 1));
// screen capture of the Claude DJ window (B-roll for the music video), started with the recording
import { spawn } from 'node:child_process';
let screenProc = null;
function startScreen() {
  // B-roll comes from the Playwright recorder (produce/record-browser.mjs), which must already be running and be the sound system.
  try {
    const info = JSON.parse(fs.readFileSync('.dj/produce/out/screen/browser.json', 'utf8'));
    if (!info.ready || info.done) throw new Error('recorder not ready');
    TIMES.screen = { file: info.file, start: info.start }; saveTimes(); log(`🎥 browser recording → ${info.file}`);
  } catch (e) { log('✗ no browser recording (' + e.message + ') — start node produce/record-browser.mjs first'); }
}
function stopScreen() { try { fs.writeFileSync('.dj/produce/out/screen/stop', ''); } catch { /* */ } }
const log = (...a) => { const s = `${new Date().toTimeString().slice(0, 8)} ${a.join(' ')}`; console.log(s); fs.appendFileSync('.dj/produce/out/run-design.log', s + '\n'); };
const dj = (...a) => { try { return execFileSync(process.execPath, ['dj.mjs', ...a.map(String)], { windowsHide: true, encoding: 'utf8', timeout: 90000 }); } catch { return ''; } };
const L = JSON.parse(fs.readFileSync('.dj/library.json', 'utf8')).tracks;
const tr = (id) => Object.values(L).find((t) => t.id === id);
const REEL = JSON.parse(fs.readFileSync(`.dj/voices/${DESIGN}-reel.json`, 'utf8'));
const REEL_ID = Object.values(L).find((t) => t.file === REEL.file)?.id; if (!REEL_ID) throw new Error(`${DESIGN} reel not scanned yet`);
const W = Object.fromEntries(REEL.windows.map((w) => [w.name, w]));
const barOf = (s, D, id) => (s.decks[D]?.trackId === id ? beatOfTime(tr(id), s.decks[D].position) / 4 + 1 : -1);
async function waitBar(D, id, n) { for (;;) { const s = await get(); const b = barOf(s, D, id); if (b >= n) return s; await sleep(50); } }
async function loadWait(D, id) { await post('load', { deck: D, track: id }); for (let i = 0; i < 120; i++) { const s = await get(); if (s.decks[D]?.trackId === id && s.decks[D]?.duration) return s; await sleep(300); } return get(); }
async function prep(D, sec) {
  let s = await loadWait(D, sec.id); for (let i = 0; i < 40 && !s.decks[D]?.stems?.loaded; i++) { await sleep(250); s = await get(); }
  await post('tempo', { deck: D, value: sec.bpm }); await post('key', { deck: D, semitones: sec.key || 0 }); await post('xfassign', { deck: D, side: 'thru' }); await post('loop', { deck: D, beats: 0 });
  for (const b of ['low', 'mid', 'high']) await post('eq', { deck: D, band: b, value: 0 }); await post('filter', { deck: D, value: 0 });
  for (const [st, v] of Object.entries(sec.stems)) await post('stem', { deck: D, stem: st, value: v });
  await post('vol', { deck: D, value: 1 }); await post('seek', { deck: D, position: `bar:${sec.fromBar}` });
  log(`cued ${tr(sec.id).title.slice(0, 28)} on ${D} @${sec.bpm} from bar ${sec.fromBar} (stems ${!!s.decks[D]?.stems?.loaded})`);
}
// voice window: reel seek + gate, gentle duck under each line, bed moves (rolls with double release)
async function voiceWindow(D, sec) {
  const w = W[sec.name];
  let s; for (;;) { s = await get(); if (s.decks[D]?.trackId === sec.id && s.decks[D].playing && barOf(s, D, sec.id) >= w.anchor - 1.6) break; await sleep(50); }
  const next = Math.floor(barOf(s, D, sec.id)) + 1, off = (w.anchor - next) * 4, bpb = w.bpm / 60; const B = (bar) => off + (bar - w.anchor) * 4;
  const lastEnd = w.anchor + w.length / (240 / w.bpm);
  // the reel: seek to the window (or into it, if the anchor has already passed) on the next bar and open the gate
  const late = Math.max(0, next - w.anchor); const reelSeek = w.offset + late * (240 / w.bpm);
  const curBar = barOf(s, D, sec.id); const anchorEpoch = Date.now() + ((next - curBar) + Math.max(0, off) / 4) * (240 / w.bpm) * 1000; TIMES.windows.push({ name: sec.name, track: sec.track, reelOffset: reelSeek, epoch: Math.round(anchorEpoch) }); saveTimes();
  const steps = [{ b: Math.max(0, off), d: 'C', seek: +reelSeek.toFixed(3) }, { b: Math.max(0, off) + 0.01, d: 'C', c: 'vol', v: 1, o: 0.05 }, { b: B(lastEnd) + 1, d: 'C', c: 'vol', v: 0, o: 0.25 }];
  if (late) log(`  reel joins ${sec.name} ${late} bar(s) in`);
  for (const l of w.lines) { const b0 = B(w.anchor) + l.start * bpb; steps.push({ b: b0 - 0.25, d: D, c: 'vol', v: 0.8, o: 0.25 }, { b: b0 + l.dur * bpb, d: D, c: 'vol', v: 1, o: 0.6 }); }
  for (const m of w.bedMoves || []) { steps.push({ ...m, d: D, b: B(m.bar) + (m.beat || 0), bar: undefined, beat: undefined }); if (m.loop === 0) steps.push({ b: B(m.bar) + 1, d: D, loop: 0 }); }
  const r = await post('perform', { at: 'bar', ref: D, steps: steps.filter((x) => x.b >= 0) }, `HERO: ${sec.name}`);
  log(`${r?.ok ? '🎤' : '✗'} ${sec.name.padEnd(10)} ${D} bars ${w.anchor}–${lastEnd.toFixed(0)} ${r?.error || ''}`);
}
// melodic layer on D: stem of another track, aligned so its bar `l.fromBar` lands on the bed's bar `l.from`
async function layer(D, sec, l) {
  await loadWait('D', l.id); const s0 = await get(); for (let i = 0; i < 30 && !(await get()).decks.D?.stems?.loaded; i++) await sleep(250);
  await post('tempo', { deck: 'D', value: sec.bpm }); await post('key', { deck: 'D', semitones: 0 }); await post('xfassign', { deck: 'D', side: 'thru' });
  for (const st of ['drums', 'bass', 'other', 'vocals']) await post('stem', { deck: 'D', stem: st, value: st === l.stem ? 1 : 0 });
  await post('vol', { deck: 'D', value: 0 }); await post('eq', { deck: 'D', band: 'low', value: -0.5 });
  await post('seek', { deck: 'D', position: `bar:${l.fromBar - 2}` });
  await waitBar(D, sec.id, l.from - 2 - 1.05); await post('play', { deck: 'D', at: 'bar' }, `layer: ${tr(l.id).title.slice(0, 20)} ${l.stem}`);
  await waitBar(D, sec.id, l.from - 2 + 0.6);
  for (let k = 0; k < 3; k++) { const s = await get(); const delta = (barOf(s, 'D', l.id) - (l.fromBar - 2)) - (barOf(s, D, sec.id) - (l.from - 2)); if (Math.abs(delta) < 0.08) break; const next = Math.floor(barOf(s, D, sec.id)) + 1; if (next >= l.from - 0.5) break; await post('perform', { at: 'bar', ref: D, steps: [{ b: 0, d: 'D', seek: +timeOfBar(tr(l.id), l.fromBar - 2 + (next - (l.from - 2))).toFixed(4) }] }); await waitBar(D, sec.id, next + 0.5); }
  const s = await waitBar(D, sec.id, l.from - 1.2); const next = Math.floor(barOf(s, D, sec.id)) + 1; const o = (x) => (x - next) * 4;
  await post('perform', { at: 'bar', ref: D, steps: [{ b: o(l.from), d: 'D', c: 'vol', v: l.gain ?? 0.6, o: 4 }, { b: o(l.to) - 2, d: 'D', c: 'vol', v: 0, o: 2 }].filter((x) => x.b >= 0) }, 'melodic layer in/out');
  log(`🎹 layer ${tr(l.id).title.slice(0, 20)} (${l.stem}) under ${sec.name} ${l.from}–${l.to}`);
}
// carry: a stem of the OUTGOING song rides over the incoming's first bars (deck D, at the incoming tempo, incoming key shift)
async function carryLayer(D, sec, c) {
  await loadWait('D', c.id); for (let i = 0; i < 30 && !(await get()).decks.D?.stems?.loaded; i++) await sleep(250);
  await post('tempo', { deck: 'D', value: sec.bpm }); await post('key', { deck: 'D', semitones: sec.key || 0 }); await post('xfassign', { deck: 'D', side: 'thru' });
  for (const st of ['drums', 'bass', 'other', 'vocals']) await post('stem', { deck: 'D', stem: st, value: st === c.stem ? 1 : 0 });
  await post('vol', { deck: 'D', value: 0 }); await post('eq', { deck: 'D', band: 'low', value: -0.5 }); await post('seek', { deck: 'D', position: `bar:${c.fromBar}` });
  await post('play', { deck: 'D', at: 'bar' }, `carry: ${tr(c.id).title.slice(0, 20)} ${c.stem} over ${sec.name}`);
  await sleep(300); const s = await get(); const next = Math.floor(barOf(s, D, sec.id)) + 1; const o = (x) => (x - next) * 4;
  await post('perform', { at: 'bar', ref: D, steps: [{ b: 0, d: 'D', c: 'vol', v: c.gain ?? 0.5, o: 1 }, { b: Math.max(1, o(sec.fromBar + c.bars) - 2), d: 'D', c: 'vol', v: 0, o: 2 }] }, 'carry fades out');
  log(`🎹 carry ${tr(c.id).title.slice(0, 20)} (${c.stem}) over ${sec.name} for ${c.bars} bars`);
}
// cut from the live deck into the next section on its downbeat `T` (bars of the outgoing bed)
async function cutInto(FROM, fromSec, TO, toSec, T) {
  const h = fromSec.handoff;
  if (h && h.drumsIn) { // incoming drums only, aligned so its bar fromBar lands on T, rolling in from T - drumsIn
    for (const st of ['bass', 'other', 'vocals']) await post('stem', { deck: TO, stem: st, value: 0 }); await post('stem', { deck: TO, stem: 'drums', value: 1 });
    await post('vol', { deck: TO, value: 0 }); await post('seek', { deck: TO, position: `bar:${toSec.fromBar - h.drumsIn - 2}`});
    await waitBar(FROM, fromSec.id, T - h.drumsIn - 2 - 1.05); await post('play', { deck: TO, at: 'bar' }, 'incoming drums roll in');
    await waitBar(FROM, fromSec.id, T - h.drumsIn - 2 + 0.6);
    for (let k = 0; k < 3; k++) { const s = await get(); const delta = (barOf(s, TO, toSec.id) - (toSec.fromBar - h.drumsIn - 2)) - (barOf(s, FROM, fromSec.id) - (T - h.drumsIn - 2)); if (Math.abs(delta) < 0.08) break; const next = Math.floor(barOf(s, FROM, fromSec.id)) + 1; if (next >= T - h.drumsIn - 0.5) break; await post('perform', { at: 'bar', ref: FROM, steps: [{ b: 0, d: TO, seek: +timeOfBar(tr(toSec.id), toSec.fromBar - h.drumsIn - 2 + (next - (T - h.drumsIn - 2))).toFixed(4) }] }); await waitBar(FROM, fromSec.id, next + 0.5); }
    const s1 = await waitBar(FROM, fromSec.id, T - h.drumsIn - 1.2); const n1 = Math.floor(barOf(s1, FROM, fromSec.id)) + 1; const o1 = (x) => (x - n1) * 4;
    await post('perform', { at: 'bar', ref: FROM, steps: [{ b: o1(T - h.drumsIn), d: TO, c: 'vol', v: 0.85, o: 8 }, ...(h.sweep ? [{ b: o1(T - h.drumsIn), d: FROM, c: 'filter', v: 0.7, o: h.drumsIn * 4 - 4 }] : [])].filter((x) => x.b >= 0) }, 'handoff: incoming drums under the outgoing');
    log(`⇄ handoff: ${toSec.name} drums under ${fromSec.name} from bar ${T - h.drumsIn}${h.sweep ? ' + sweep' : ''}`);
  }
  const s = await waitBar(FROM, fromSec.id, T - 1.6); const st = !!s.decks[FROM]?.stems?.loaded; const next = Math.floor(barOf(s, FROM, fromSec.id)) + 1; const o = (x) => (x - next) * 4;
  await post('perform', { at: 'bar', ref: FROM, steps: [
    { b: o(T - 2), d: FROM, c: st ? 'bass' : 'low', v: st ? 0 : -1, o: 0.25 }, { b: o(T - 2), d: FROM, c: 'high', v: -0.5, o: 8 },
    { b: o(T - 1), d: FROM, loop: 2 }, { b: o(T - 1) + 2, d: FROM, loop: 1 }, { b: o(T - 1) + 3, d: FROM, loop: 0.5 }, { b: o(T - 1) + 3.5, d: FROM, loop: 0.25 },
    { b: o(T) - 0.08, d: FROM, c: 'vol', v: 0, o: 0.05 }, { b: o(T), d: FROM, loop: 0 }, { b: o(T) + 1, d: FROM, loop: 0 },
  ].filter((x) => x.b >= 0) }, `cut → ${toSec.name}`);
  await waitBar(FROM, fromSec.id, T - 0.85);
  if (h && h.drumsIn) { const s2 = await get(); const n2 = Math.floor(barOf(s2, FROM, fromSec.id)) + 1; const o2 = (x) => (x - n2) * 4; await post('perform', { at: 'bar', ref: FROM, steps: [{ b: o2(T), d: TO, c: 'vol', v: 1 }, ...Object.entries(toSec.stems).map(([st, v]) => ({ b: o2(T), d: TO, c: st, v }))] }, 'incoming: full stems on the downbeat'); }
  else await post('play', { deck: TO, at: 'bar' }, `${toSec.name}: ${tr(toSec.id).title.slice(0, 24)}`);
  if (h && h.carry) carryLayer(TO, toSec, h.carry).catch((e) => log('✗ carry ' + e.message));
  await sleep(2200); await post('pause', { deck: FROM }); await post('filter', { deck: FROM, value: 0 }); await post('loop', { deck: FROM, beats: 0 }); await post('vol', { deck: FROM, value: 1 }); await post('stem', { deck: FROM, stem: 'all', value: 1 }); for (const b of ['low', 'high']) await post('eq', { deck: FROM, band: b, value: 0 });
  log(`⚡ ${fromSec.name} → ${toSec.name}`);
}

if (RESUME < 0) fs.writeFileSync('.dj/produce/out/run-design.log', '');
dj('autodj', 'off'); dj('plan', 'clear');
const decks = SECTIONS.map((_, i) => (i % 2 ? 'B' : 'A'));
if (RESUME >= 0) { dj('record', 'start', '--no-screen', '--no-mic'); TIMES.recordStart = Date.now(); TIMES.design = DESIGN; saveTimes(); }
if (RESUME < 0) {
for (const D of ['A', 'B', 'C', 'D']) { await post('pause', { deck: D }); await post('loop', { deck: D, beats: 0 }); await post('deckfx', { deck: D, type: 'none' }); await post('xfassign', { deck: D, side: 'thru' }); }
await post('master', { value: 1 });
await loadWait('C', REEL_ID); await post('vol', { deck: 'C', value: 0 }); await post('eq', { deck: 'C', band: 'mid', value: 0.3 }); await post('key', { deck: 'C', semitones: 0 }); await post('tempo', { deck: 'C', value: tr(REEL_ID).bpm });
await prep('A', SECTIONS[0]); await prep('B', SECTIONS[1]);
log(`ready: ${SECTIONS.map((s, i) => `${s.name}:${decks[i]}`).join(' ')}`);
if (DRY) { log('dry run: nothing played'); process.exit(0); }
dj('record', 'start', '--no-screen', '--no-mic'); TIMES.recordStart = Date.now(); TIMES.design = DESIGN; saveTimes(); startScreen();
await post('seek', { deck: 'C', position: 0 }); await post('play', { deck: 'C' });
await post('seek', { deck: decks[0], position: `bar:${SECTIONS[0].fromBar - 2}` }); // two bars of run-in so the first window arms cleanly
await post('play', { deck: decks[0] }, 'SSW: The Hero'); log(`▶ ${SECTIONS[0].name}`);
}
for (let i = Math.max(0, RESUME); i < SECTIONS.length; i++) {
  const sec = SECTIONS[i], D = decks[i];
  const layers = (i === RESUME && ARMED) ? [] : (sec.layers || []).map((l) => layer(D, sec, l));
  if (i === RESUME && ARMED) { /* window already armed by the previous run */ } else await voiceWindow(D, sec);
  await Promise.all(layers);
  if (i + 1 < SECTIONS.length) { if (!(await get()).decks[decks[i + 1]]?.trackId || (await get()).decks[decks[i + 1]].trackId !== SECTIONS[i + 1].id) await prep(decks[i + 1], SECTIONS[i + 1]); await cutInto(D, sec, decks[i + 1], SECTIONS[i + 1], sec.fromBar + sec.bars); if (i + 2 < SECTIONS.length) prep(decks[i + 2], SECTIONS[i + 2]).catch(() => {}); }
  else { const endBar = Math.min(sec.fromBar + sec.bars - 0.5, (tr(sec.id).bars || 9999) - 0.6); for (;;) { const s = await get(); if (!s.decks[D]?.playing || barOf(s, D, sec.id) >= endBar) break; await sleep(100); } await post('perform', { at: 'bar', ref: D, steps: [{ b: 0, d: D, c: 'vol', v: 0, o: 8 }] }, 'land'); await sleep(5000); await post('pause', { deck: D }); }
}
await post('pause', { deck: 'C' }); await post('pause', { deck: 'D' });
dj('record', 'stop'); stopScreen();
log('SET DONE', dj('export').trim().split(String.fromCharCode(10)).slice(-1)[0]);
