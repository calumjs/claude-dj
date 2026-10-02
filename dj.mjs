#!/usr/bin/env node
// `dj` — the control surface Claude uses to DJ. Talks to server.mjs over HTTP.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FX as FX_PRESETS } from './lib/fx.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const PORT = Number(process.env.DJ_PORT || config.port || 4747);
const BASE = `http://localhost:${PORT}`;

// ---------- args
const argv = process.argv.slice(2);
const pos = [], flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[k] = argv[++i]; else flags[k] = true;
  } else pos.push(a);
}
const [cmd = 'help', ...rest] = pos;
const JSON_OUT = !!flags.json;

// ---------- http
async function api(p, body, method) {
  let res;
  try {
    res = await fetch(BASE + p, body !== undefined ? { method: method || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  } catch {
    fail(`DJ server is not running. Start it with:  node dj.mjs start`);
  }
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}
function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));

// ---------- formatting
const mmss = (s) => (s == null || isNaN(s) ? '--:--' : `${s < 0 ? '-' : ''}${Math.floor(Math.abs(s) / 60)}:${String(Math.floor(Math.abs(s) % 60)).padStart(2, '0')}`);
const name = (t) => `${t.artist ? t.artist + ' - ' : ''}${t.title || '?'}`;
function fmtTrack(t, extra = '') {
  return `${t.id}  ${String(t.bpm?.toFixed?.(1) ?? '?').padStart(5)} BPM  ${String(t.camelot || '?').padEnd(3)}  E${t.energy ?? '?'}  ${mmss(t.duration)}  ${name(t)}${extra}`;
}
function fmtState(s) {
  const lines = [];
  if (!s.engine?.connected) lines.push(`⚠ Audio engine not connected — open ${BASE} and click "Start engine".`);
  else if (s.engine.stale) lines.push('⚠ Engine state is stale (tab asleep?)');
  if (s.master) lines.push(`MASTER  xfade ${s.master.xfader?.toFixed(2)} (0=A 1=B)  vol ${s.master.volume}  live: ${s.live || '—'}`);
  for (const [n, d] of Object.entries(s.decks || {})) {
    if (!d.trackId) { lines.push(`DECK ${n}  (empty)`); continue; }
    const pct = d.rate ? ((d.rate - 1) * 100).toFixed(1) : '0.0';
    lines.push(`DECK ${n}  ${d.playing ? '▶' : '⏸'} ${name(d)}  [${d.trackId}]`);
    lines.push(`        ${(d.bpm * (d.rate || 1)).toFixed(1)} BPM (${pct >= 0 ? '+' : ''}${pct}%)  ${d.camelot}  E${d.energy}  ${mmss(d.position)} / ${mmss(d.duration)}  remaining ${mmss(d.remaining)}  bar ${d.bar ?? '-'}.${d.beatInBar ?? '-'}` +
      (d.untilMixOut != null ? `  mix-out ${d.untilMixOut > 0 ? 'in ' + mmss(d.untilMixOut) : 'PASSED'}` : ''));
    lines.push(`        vol ${d.vol}  eq L${d.eq?.low} M${d.eq?.mid} H${d.eq?.high}  filter ${d.filter}  echo ${d.echo}${d.loop ? `  LOOP ${d.loop.beats} beats` : ''}${d.loading ? '  (loading…)' : ''}  audible ${d.audible}`);
  }
  if (s.transition) lines.push(`TRANSITION ${s.transition.from}→${s.transition.to} ${s.transition.style}, ends in ${mmss((s.transition.endAt - Date.now()) / 1000)}`);
  if (s.inbox) lines.push(`📨 ${s.inbox} crowd request(s) waiting — run: dj inbox --clear`);
  if (s.history?.length) lines.push(`Recently played: ${s.history.slice(-5).map((h) => h.title).join(' · ')}`);
  if (s.autoDJ || s.plan || s.queue?.length) lines.push(`AUTO    auto-DJ ${s.autoDJ?.enabled ? 'on' : 'off'}${s.autoDJ?.prepared ? ` (next ready on ${s.autoDJ.prepared.deck})` : ''}  plan ${s.plan?.pending || 0} pending${s.plan?.next ? ` (next ${s.plan.next.id} ${s.plan.next.cmd} in ${mmss(Math.max(0, s.plan.next.eta))})` : ''}  queue ${s.queue?.length || 0}`);
  if (s.monitor?.phase?.offsetMs != null) lines.push(`EARS    phase ${s.monitor.phase.decks.join('/')} ${s.monitor.phase.offsetMs} ms`);
  for (const w of s.monitor?.warnings || []) lines.push(`⚠ ${w.msg}`);
  return lines.join('\n');
}
function report(r) {
  if (JSON_OUT) return out(r);
  if (r.ok === false) fail(r.error);
  if (r.result && typeof r.result === 'object' && Object.keys(r.result).length) console.log('✓', JSON.stringify(r.result));
  else console.log('✓ done');
  if (r.state) console.log(fmtState(r.state));
}
const deckArg = (d) => { const D = String(d || '').toUpperCase(); if (!['A', 'B', 'C', 'D'].includes(D)) fail(`deck must be A, B, C or D (got "${d ?? ''}")`); return D; };
const num = (v, label) => { const n = Number(v); if (v === undefined || isNaN(n)) fail(`${label} must be a number`); return n; };
const control = (c, args) => api('/api/cmd', { cmd: c, args, why: flags.why }).then(report);

// ---------- commands
const commands = {
  async start() {
    try { await fetch(BASE + '/api/state'); console.log(`✓ Already running at ${BASE}`); }
    catch {
      const logFile = path.join(ROOT, '.dj', 'server.log');
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const fd = fs.openSync(logFile, 'a');
      const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { detached: true, stdio: ['ignore', fd, fd], cwd: ROOT, windowsHide: true });
      child.unref();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        try { await fetch(BASE + '/api/state'); break; } catch { /* waiting */ }
      }
      console.log(`✓ DJ server started at ${BASE}  (log: .dj/server.log)`);
    }
    if (!flags['no-open']) await commands.open();
    const s = await api('/api/state');
    if (!s.engine?.connected) console.log('→ In the browser, click "Start engine" so audio can play (browsers require one click).');
  },
  async open() {
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', BASE]] : process.platform === 'darwin' ? ['open', [BASE]] : ['xdg-open', [BASE]];
    spawn(opener[0], opener[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    console.log(`✓ Opened ${BASE}`);
  },
  async stop() {
    fail('Stop the server by closing its process (Ctrl+C if started with npm start).');
  },
  async doctor() {
    const d = await api('/api/doctor');
    if (flags.fix && !d.ytdlp) { const r = await api('/api/ytdlp/install', {}); d.ytdlp = r.path; }
    if (JSON_OUT) return out(d);
    console.log(`server     ✓ ${BASE}`);
    console.log(`engine     ${d.engine.connected ? '✓ connected' : '✗ not connected (open the UI and click Start engine)'}`);
    console.log(`yt-dlp     ${d.ytdlp ? '✓ ' + d.ytdlp : '✗ not installed yet (auto-installs on first download, or run: dj doctor --fix)'}`);
    console.log(`library    ${d.library.tracks} tracks  (${d.library.analyzing} analysing, ${d.library.queued} queued)`);
    console.log(`folders    ${d.dirs.join(' | ')}`);
    console.log(`downloads  ${d.downloadDir}`);
  },
  async status() {
    const s = await api('/api/state');
    JSON_OUT ? out(s) : console.log(fmtState(s));
  },
  async library() {
    const q = new URLSearchParams();
    if (rest.length) q.set('q', rest.join(' '));
    for (const k of ['bpm', 'key', 'energy', 'genre', 'sort', 'limit']) if (flags[k]) q.set(k, flags[k]);
    if (flags.compatible) q.set('compatibleWith', flags.compatible);
    if (!flags.limit) q.set('limit', '60');
    const r = await api('/api/library?' + q);
    if (JSON_OUT) return out(r);
    const st = r.status;
    console.log(`${r.tracks.length} shown of ${st.tracks} tracks${st.analyzing || st.queued ? `  (analysing ${st.analyzing}, queued ${st.queued})` : ''}`);
    console.log('id        BPM       key  E   len   track');
    for (const t of r.tracks) console.log(fmtTrack(t));
  },
  async track() {
    const t = await api('/api/track/' + encodeURIComponent(rest.join(' ')));
    if (t.error) fail(t.error);
    const { waveform, ...info } = t;
    if (JSON_OUT) return out(info);
    console.log(fmtTrack(t));
    console.log(`  key ${t.key} (${t.camelot}, confidence ${t.keyConfidence})  bpm confidence ${t.bpmConfidence}  loudness ${t.rmsDb} dB (gain ${t.gainDb})`);
    console.log(`  bars ${t.bars}  first beat ${t.firstBeat}s  intro ends bar ${t.introEndBar} (${mmss(t.introEnd)})  outro/mix-out bar ${t.outroStartBar} (${mmss(t.mixOut)})`);
    for (const b of t.breakdowns || []) console.log(`  breakdown bars ${b.startBar}-${b.endBar}  (${mmss(b.start)} → drop at ${mmss(b.drop)})`);
    console.log(`  energy by 8-bar phrase: ${(t.phraseEnergy || []).map((e) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor(e * 8))]).join('')}`);
    console.log(`  file ${t.file}`);
  },
  async suggest() {
    const q = new URLSearchParams();
    if (flags.from || rest[0]) q.set('from', flags.from || rest[0]);
    for (const k of ['direction', 'limit', 'bpm']) if (flags[k]) q.set(k, flags[k]);
    const r = await api('/api/suggest?' + q);
    if (JSON_OUT) return out(r);
    if (!r.length) return console.log('No suggestions (is anything playing? pass --from <trackId>)');
    for (const t of r) console.log(fmtTrack(t, `\n          score ${t.score}: ${t.reasons.join(', ')}`));
  },
  async find() {
    const q = rest.join(' '); if (!q) fail('usage: dj find "<artist - title>"');
    const r = await api(`/api/download/search?q=${encodeURIComponent(q)}&n=${flags.n || 8}`);
    if (JSON_OUT || !Array.isArray(r)) return out(r);
    for (const v of r) console.log(`${mmss(v.duration)}  ${v.title}  — ${v.channel}\n       ${v.url}`);
  },
  async get() {
    const input = rest.join(' '); if (!input) fail('usage: dj get <url | "artist - title"> [--playlist] [--max N]');
    console.log(`⬇ ${input} …`);
    const j = await api('/api/download', { input, playlist: !!flags.playlist, max: flags.max ? Number(flags.max) : 25, wait: true });
    if (JSON_OUT) return out(j);
    if (j.status !== 'ready') fail(j.error || `download ${j.status}`);
    for (const t of j.tracks) console.log('✓ ' + fmtTrack(t));
  },
  async scan() { out(await api('/api/library/scan', { force: !!flags.force })); },
  async load() { const deck = deckArg(rest[0]); const track = rest.slice(1).join(' '); if (!track) fail('usage: dj load <A|B> <trackId | search>'); return control('load', { deck, track, cue: flags.cue }); },
  async play() { return control('play', { deck: deckArg(rest[0]), at: flags.at }); },
  async pause() { return control('pause', { deck: deckArg(rest[0]) }); },
  async cue() { return control('cue', { deck: deckArg(rest[0]), position: rest[1] }); },
  async seek() { return control('seek', { deck: deckArg(rest[0]), position: rest[1] }); },
  async sync() { return control('sync', { deck: deckArg(rest[0]) }); },
  async tempo() { return control('tempo', { deck: deckArg(rest[0]), value: rest[1] }); },
  async eq() {
    const band = rest[1]; if (!['low', 'mid', 'high'].includes(band)) fail('usage: dj eq <A|B> <low|mid|high> <-1..1> [--ramp beats]');
    return control('eq', { deck: deckArg(rest[0]), band, value: num(rest[2], 'value'), ramp: flags.ramp });
  },
  async filter() { return control('filter', { deck: deckArg(rest[0]), value: num(rest[1], 'value'), ramp: flags.ramp }); },
  async vol() { return control('vol', { deck: deckArg(rest[0]), value: num(rest[1], 'value'), ramp: flags.ramp }); },
  async echo() { return control('echo', { deck: deckArg(rest[0]), value: num(rest[1], 'value'), ramp: flags.ramp }); },
  async xfade() { return control('xfade', { value: num(rest[0], 'value'), ramp: flags.ramp }); },
  async master() { return control('master', { value: num(rest[0], 'value') }); },
  async loop() { return control('loop', { deck: deckArg(rest[0]), beats: rest[1] === 'off' ? 0 : num(rest[1] ?? 8, 'beats') }); },
  async perform() {
    const raw = flags.steps || rest.join(' ');
    let steps;
    try { steps = JSON.parse(fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8') : raw); } catch { fail('usage: dj perform \'[{"b":0,"d":"A","c":"filter","v":0.6,"o":8}, {"b":8,"d":"A","loop":1}]\' [--at bar|phrase|now]'); }
    return control('perform', { steps, at: flags.at || 'bar', ref: flags.ref });
  },
  async fx() {
    const name = rest[0], D = deckArg(rest[1] || (await api('/api/state')).live), O = D === 'A' ? 'B' : 'A';
    const presets = FX(D, O);
    if (!presets[name]) fail(`unknown fx "${name}". Available: ${Object.keys(presets).join(', ')}`);
    const defaultAt = { rollup: 'drop', roll: 'drop', throw: 'phrase-end', chop: 'phrase-end', scratchcut: 'phrase-end', kills: 'phrase', sweep: 'phrase', wobble: 'phrase' }[name] || 'bar';
    return control('perform', { steps: presets[name], at: flags.at || defaultAt, ref: D });
  },
  async record() {
    const sub = rest[0] || 'status';
    if (sub === 'start') { const r = await api('/api/record/start', { screen: !flags['no-screen'], mic: !flags['no-mic'] }); console.log('⏺ recording →', r.dir); return; }
    if (sub === 'stop') { const r = await api('/api/record/stop', {}); if (r.error) fail(r.error); console.log('⏹ saved →', r.dir); console.log('  run: node dj.mjs report'); return; }
    out(await api('/api/record'));
  },
  async report() {
    const { buildReport } = await import('./lib/report.mjs');
    const root = path.join(ROOT, '.dj', 'sessions');
    const id = rest[0] || fs.readdirSync(root).sort().pop();
    if (!id) fail('no sessions recorded yet');
    console.log(await buildReport(path.join(root, id)));
  },
  async mix() {
    const from = deckArg(rest[0]), to = deckArg(rest[1]);
    return control('mix', { from, to, track: flags.track, style: flags.style || 'blend', bars: flags.bars != null ? Number(flags.bars) : undefined, at: flags.at || 'bar', in: flags.in, glide: !flags['no-glide'] });
  },
  async wait() {
    const kind = rest[0] || 'mixout';
    const q = new URLSearchParams({ for: kind, timeout: flags.timeout || 540 });
    if (flags.deck) q.set('deck', deckArg(flags.deck));
    if (kind === 'mixout') q.set('seconds', flags.seconds ?? rest[1] ?? 20);
    if (kind === 'remaining' || kind === 'time') q.set('seconds', rest[1] ?? flags.seconds ?? 60);
    if (kind === 'bar') q.set('bar', rest[1]);
    if (flags['ignore-inbox']) q.set('inbox', 'ignore');
    const r = await api('/api/wait?' + q);
    if (JSON_OUT) return out(r);
    console.log(`⏱ ${r.reason} (waited ${r.waitedSec}s)`);
    if (r.reason === 'inbox') for (const m of r.inbox) console.log(`📨 ${m.from}: ${m.text}`);
    console.log(fmtState(r.state));
  },
  async inbox() {
    const r = await api('/api/inbox' + (flags.clear ? '?clear=1' : ''));
    if (JSON_OUT) return out(r);
    if (!r.length) return console.log('(no requests)');
    for (const m of r) console.log(`${new Date(m.ts).toLocaleTimeString()}  ${m.from}: ${m.text}`);
  },
  async say() { const text = rest.join(' '); if (!text) fail('usage: dj say "message" [--speak]'); await api('/api/say', { text, speak: !!flags.speak }); console.log('✓ posted'); },
  async log() { const r = await api('/api/log?n=' + (flags.n || 30)); for (const e of r) console.log(`${new Date(e.ts).toLocaleTimeString()} [${e.kind}] ${e.text}`); },
  async history() { const r = await api('/api/history'); if (JSON_OUT) return out(r); for (const h of r) console.log(`${new Date(h.at).toLocaleTimeString()}  ${h.deck}  ${h.artist ? h.artist + ' - ' : ''}${h.title}  [${h.id}]`); },
  async help() {
    console.log(`dj — Claude DJ control surface  (server: ${BASE})

SETUP     start | open | doctor [--fix] | status [--json]
CRATE     library [search] [--bpm 140-150] [--key 8A,9A] [--energy 6-9] [--compatible <id>] [--sort bpm|energy|key|added]
          track <id>                       full analysis: grid, key, intro/outro, breakdowns
          suggest [--from <id>] [--direction up|down|hold]   best next tracks (harmonic + tempo + energy)
          find "<query>"                   search YouTube without downloading
          get <url | "artist - title"> [--playlist --max N]   download + analyse
          scan [--force]                   rescan library folders
DECKS     load <A|B> <id|search>   play <deck> [--at bar]   pause <deck>   cue <deck> [sec]   seek <deck> <sec|bar:N>
          sync <deck>   tempo <deck> <bpm|+2%>   loop <deck> <beats|off>
MIXER     vol <deck> <0-1>   eq <deck> <low|mid|high> <-1..1>   filter <deck> <-1..1>   echo <deck> <0-1>
          xfade <0-1>   master <0-1>          (add --ramp <beats> to any of these to automate)
MIX       mix <from> <to> [--track <id>] [--style blend|bassswap|double|fade|filter|echo|cut|brake|spinback]
              [--bars 16] [--at now|bar|phrase] [--in mixin|intro|drop|<sec>|bar:N] [--no-glide]
TIMING    wait mixout [--seconds 20] | wait remaining <sec> | wait transition | wait end | wait bar <n> | wait time <sec>
          (waits return early when the crowd sends a request)
REC       record start|stop|status [--no-screen --no-mic]   report [sessionId]
CROWD     inbox [--clear]   say "text" [--speak]   log   history
FX        fx <rollup|roll|chop|scratchcut|wobble|kills|throw|sweep> [deck] [--at drop|phrase-end|phrase|bar|now]
          perform '<json steps>'   beat-scheduled knob choreography (see dj-mix skill)
SET       plan add '<json>'|show|clear   queue add <id…>|show|clear   autodj on|off   monitor   rate good|bad [note]   memory
          suggest --mashup   export [session] [--format mp3|m4a]
TRACK     sections <id>   grid <id> [--shift beats --nudge ms --bpm x --reset]
          hotcue <deck> [set <n> [bar:N]] | <n>     savedloop <deck> [set <name> <beats>] | <name>
ENGINE    keylock, key, stem, xfassign, sample(r), deckfx, scratch: see  dj help-engine
GLOBAL    --why "reason"   shows your reasoning in the booth feed      --json   raw output`);
  },
};

// CLI extensions: every cli-ext/*.mjs default-exports (helpers) => ({ commandName: async fn })
const extDir = path.join(ROOT, 'cli-ext');
if (fs.existsSync(extDir)) {
  for (const f of fs.readdirSync(extDir).filter((x) => x.endsWith('.mjs')).sort()) {
    const mod = await import(pathToFileURL(path.join(extDir, f)).href);
    Object.assign(commands, mod.default({ api, control, flags, rest, pos, cmd, deckArg, num, fail, out, report, fmtState, fmtTrack, mmss, name, ROOT, BASE, JSON_OUT }));
  }
}
const fn = commands[cmd];
if (!fn) fail(`unknown command "${cmd}". Run: dj help`);
await fn();

// ---------- performance presets: lib/fx.mjs
function FX(D, O) { return FX_PRESETS(D, O); }
