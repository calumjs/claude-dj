#!/usr/bin/env node
// Claude DJ server: serves the deck UI, the music library, and relays commands
// from the `dj` CLI (driven by Claude) to the browser audio engine.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Library } from './lib/library.mjs';
import { Downloader } from './lib/downloader.mjs';
import { StemQueue, STEMS } from './lib/stems.mjs';
import { Memory } from './lib/memory.mjs';
import { Cues } from './lib/cues.mjs';
import { Monitor } from './lib/monitor.mjs';
import { Sequencer } from './lib/sequencer.mjs';
import { healthReport, hasTool } from './lib/health.mjs';
import { timeOfBar, beatOfTime, timeOfBeat, deckEffectiveCamelot, effBpm } from './lib/music.mjs';
import os from 'node:os';
import { spawn } from 'node:child_process';

try { os.setPriority(process.pid, 10); } catch { /* keep the audio tab ahead of us for CPU */ }

// ---- PCM cache: tracks pre-converted to the engine's sample rate so browser decoding is trivial
const PCM_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.dj', 'pcm');
const pcmJobs = new Map();
let engineSampleRate = null;
function pcmFile(t, sr) {
  const out = path.join(PCM_DIR, `${t.id}-${sr}-${Math.round(t.mtimeMs)}.wav`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (pcmJobs.has(out)) return pcmJobs.get(out);
  fs.mkdirSync(PCM_DIR, { recursive: true });
  const p = new Promise((resolve, reject) => {
    const tmp = out + '.part';
    const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-threads', '1', '-i', t.file, '-ar', String(sr), '-ac', '2', '-c:a', 'pcm_s16le', '-f', 'wav', tmp], { windowsHide: true });
    try { os.setPriority(ff.pid, 19); } catch { /* best effort */ }
    ff.on('error', reject);
    ff.on('close', (code) => { if (code === 0) { fs.renameSync(tmp, out); resolve(out); } else reject(new Error('transcode failed')); });
  }).finally(() => pcmJobs.delete(out));
  pcmJobs.set(out, p);
  return p;
}
// stems are stored at 44.1 kHz; other engine rates get a cached resample (on demand only, no prewarm)
function stemPcmFile(src, id, stem, sr) {
  const st = fs.statSync(src);
  if (sr === 44100) return Promise.resolve(src);
  const out = path.join(PCM_DIR, `${id}-stem-${stem}-${sr}-${Math.round(st.mtimeMs)}.wav`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (pcmJobs.has(out)) return pcmJobs.get(out);
  fs.mkdirSync(PCM_DIR, { recursive: true });
  const p = new Promise((resolve, reject) => {
    const tmp = out + '.part';
    const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-threads', '1', '-i', src, '-ar', String(sr), '-ac', '2', '-c:a', 'pcm_s16le', '-f', 'wav', tmp], { windowsHide: true });
    try { os.setPriority(ff.pid, 19); } catch { /* best effort */ }
    ff.on('error', reject);
    ff.on('close', (code) => { if (code === 0) { fs.renameSync(tmp, out); resolve(out); } else reject(new Error('transcode failed')); });
  }).finally(() => pcmJobs.delete(out));
  pcmJobs.set(out, p);
  return p;
}
let prewarming = false;
async function prewarm() {
  if (prewarming || !engineSampleRate) return;
  prewarming = true;
  try { for (const t of library.tracks.values()) await pcmFile(t, engineSampleRate).catch(() => {}); } finally { prewarming = false; }
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const PORT = Number(process.env.DJ_PORT || config.port || 4747);
const resolveDir = (d) => (d.startsWith('~') || path.isAbsolute(d) ? d : path.join(ROOT, d));

// ---------------------------------------------------------------- state
const log = [];
function addLog(kind, text, extra = {}) {
  const entry = { ts: Date.now(), kind, text, ...extra };
  log.push(entry); if (log.length > 300) log.shift();
  broadcast('log', entry);
  return entry;
}
const inbox = [];          // crowd requests waiting for Claude
const history = [];        // tracks that have gone live
let engineState = null;    // last state pushed by the engine tab
let engineStateAt = 0;
let engineId = null;
const clients = new Map(); // clientId -> res
const pendingCmds = new Map();
let cmdSeq = 0;

const library = new Library({
  dirs: config.libraryDirs.map(resolveDir),
  cacheFile: path.join(ROOT, '.dj', 'library.json'),
  targetLoudnessDb: config.targetLoudnessDb,
  stemsDir: path.join(ROOT, '.dj', 'stems'),
  log: (t) => addLog('system', t),
});
const stemCfg = { enabled: true, auto: true, threads: 2, concurrency: 2, model: 'htdemucs', minFreeGB: 3, ...(config.stems || {}) };
const stems = new StemQueue({
  root: ROOT,
  library,
  stemsDir: path.join(ROOT, '.dj', 'stems'),
  python: stemCfg.python ? resolveDir(stemCfg.python) : undefined,
  threads: stemCfg.threads,
  concurrency: stemCfg.concurrency,
  model: stemCfg.model,
  minFreeGB: stemCfg.minFreeGB,
  enabled: stemCfg.enabled !== false,
  log: (t) => addLog('system', t),
  onEvent: (ev) => broadcast('stems', ev),
});
library.onChange((ev) => {
  broadcast('library', ev);
  if (ev.type === 'analyzed') { setTimeout(prewarm, 1000); if (stemCfg.auto !== false) stems.enqueue(ev.id); }
});

// ---- set memory, hot cues, monitor ("ears"), sequencer / auto-DJ
const memory = new Memory(path.join(ROOT, '.dj', 'memory.json'));
const cues = new Cues(path.join(ROOT, '.dj', 'cues.json'));
let sequencer = null;
let lastMix = null; // last mix command sent (anchors for set memory)
const monitor = new Monitor({
  library,
  onWarning: (w) => { if (session) sessionLog('monitor.jsonl', { ts: Date.now(), ...w }); },
  onCritique: (c) => {
    addLog('system', c.text);
    sessionLog('critiques.jsonl', c);
    const m = lastMix && lastMix.args.from === c.from && lastMix.args.to === c.to && lastMix.ts <= c.endAt ? lastMix : null;
    memory.record({ type: 'transition', from: c.fromTrack, to: c.toTrack, style: c.style, bars: c.bars, at: m?.args.at ?? null, in: m?.args.in ?? null, auto: m?.source === 'autodj', plan: m?.source === 'plan', warnings: c.warnings, phaseMaxMs: c.phase?.maxMs ?? null, verdict: c.verdict, critique: c.text });
  },
});

const downloadDir = path.resolve(resolveDir(config.downloadDir || './library/downloads'));
const downloader = new Downloader({
  root: ROOT,
  downloadDir,
  onEvent: (ev) => (ev.type === 'log' ? addLog('system', ev.text) : broadcast('job', ev.job)),
});

// ---------------------------------------------------------------- helpers
function broadcast(event, data, onlyId = null) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, res] of clients) if (!onlyId || id === onlyId) res.write(msg);
}
function send(res, code, body, headers = {}) {
  const isStr = typeof body === 'string';
  res.writeHead(code, { 'content-type': isStr ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}
async function readBody(req) {
  let s = ''; for await (const c of req) s += c;
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.webm': 'audio/webm', '.aiff': 'audio/aiff', '.aif': 'audio/aiff' };

function serveFile(req, res, file) {
  let st; try { st = fs.statSync(file); } catch { return send(res, 404, 'not found'); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0, end = range[2] ? Number(range[2]) : st.size - 1;
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${st.size}`, 'accept-ranges': 'bytes' });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  }
}

/** engine state with positions extrapolated to "now" and DJ-relevant derived numbers */
function liveState() {
  const connected = !!engineId && clients.has(engineId);
  if (!engineState) return withExtras({ engine: { connected, started: false }, decks: {}, inbox: inbox.length, history: history.slice(-10) });
  const now = Date.now();
  const dt = (now - engineStateAt) / 1000;
  const decks = {};
  for (const [name, d] of Object.entries(engineState.decks || {})) {
    const x = { ...d };
    if (d.playing && d.duration) {
      let pos = d.position + dt * (d.rate || 1);
      if (d.loop && pos > d.loop.end) pos = d.loop.start + ((pos - d.loop.start) % (d.loop.end - d.loop.start));
      x.position = Math.min(pos, d.duration);
    }
    if (d.duration) {
      const r = d.rate || 1;
      // measure against the last audible moment: many uploads end in seconds of silence
      const lt = d.trackId ? library.tracks.get(d.trackId) : null;
      const audioEnd = d.audioEnd ?? lt?.audioEnd;
      const end = audioEnd != null ? Math.min(d.duration, audioEnd) : d.duration;
      if (audioEnd != null) x.audioEnd = audioEnd;
      x.remaining = +((end - x.position) / r).toFixed(1);
      const mixOut = d.mixOut != null ? Math.min(d.mixOut, lt?.mixOut ?? d.mixOut, end) : lt?.mixOut;
      if (mixOut != null) x.untilMixOut = +((mixOut - x.position) / r).toFixed(1);
      if (d.bpm && d.firstBeat != null) {
        const beats = (x.position - d.firstBeat) / (60 / d.bpm);
        x.bar = Math.floor(beats / 4) + 1;
        x.beatInBar = (Math.floor(beats) % 4 + 4) % 4 + 1;
        x.phrase = Math.floor(beats / 32) + 1;
      }
      x.position = +x.position.toFixed(2);
    }
    decks[name] = x;
  }
  const audible = Object.entries(decks).filter(([, d]) => d.playing).sort((a, b) => (b[1].audible || 0) - (a[1].audible || 0));
  const out = {
    engine: { connected, started: !!engineState.started, stale: dt > 5 },
    live: audible[0]?.[0] || null,
    master: engineState.master,
    decks,
    transition: engineState.transition && engineState.transition.endAt > now ? engineState.transition : null,
    inbox: inbox.length,
    history: history.slice(-10),
  };
  return withExtras(out);
}
/** monitor warnings + plan / queue / auto-DJ summary, for dj status and machine readers */
function withExtras(out) {
  const m = monitor.last;
  if (m.ts && Date.now() - m.ts < 2000) out.monitor = { warnings: m.warnings, phase: m.checks.phase || null, audible: m.audible };
  if (sequencer) Object.assign(out, sequencer.summary(out));
  return out;
}

function trackHistory(state) {
  // only the single most-audible deck counts as "on air"
  const [name, d] = Object.entries(state.decks || {}).filter(([, x]) => x.playing && x.trackId).sort((a, b) => (b[1].audible || 0) - (a[1].audible || 0))[0] || [];
  if (!d || (d.audible || 0) < 0.5) return;
  if (history.slice(-3).some((h) => h.id === d.trackId)) return;
  history.push({ id: d.trackId, title: d.title, artist: d.artist, deck: name, at: Date.now() });
  sequencer?.onAir(d.trackId);
  addLog('system', `▶ Now playing on ${name}: ${d.artist ? d.artist + ' - ' : ''}${d.title}`);
}

function forward(cmd, args, timeoutMs = 20000) {
  if (!engineId || !clients.has(engineId)) {
    return Promise.resolve({ ok: false, error: `No audio engine connected. Open http://localhost:${PORT} in a browser and click "Start engine".` });
  }
  const id = ++cmdSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingCmds.delete(id); resolve({ ok: false, error: 'engine did not respond in time' }); }, timeoutMs);
    pendingCmds.set(id, (r) => { clearTimeout(timer); resolve(r); });
    broadcast('cmd', { id, cmd, args }, engineId);
  });
}

function describe(cmd, a) {
  switch (cmd) {
    case 'load': return `Load ${a.track?.artist ? a.track.artist + ' - ' : ''}${a.track?.title} → deck ${a.deck}`;
    case 'mix': return `Mix ${a.from}→${a.to}: ${a.style || 'blend'}${a.bars != null ? ', ' + a.bars + ' bars' : ''}${a.at ? ' @' + a.at : ''}`;
    default: return `${cmd} ${Object.entries(a || {}).filter(([k]) => k !== 'track').map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')}`;
  }
}

// ---------------------------------------------------------------- command handling
async function handleCmd({ cmd, args = {}, why, source = 'cli' }) {
  args = { ...args };
  if ((cmd === 'load' || cmd === 'mix') && (args.track === 'next' || args.track === 'queue')) {
    const q = sequencer.nextFromQueue();
    if (!q) return { ok: false, error: 'the track queue is empty (dj queue add …)', state: liveState() };
    args.track = q.id;
  }
  if (cmd === 'load' || (cmd === 'mix' && args.track)) {
    const t = library.get(args.track);
    if (!t) return { ok: false, error: `No track matches "${args.track}". Try: dj library "<search>"` };
    args.track = { ...library.summary(t), hotcues: cues.view(t).hotcues, waveform: t.waveform, url: `/audio/${t.id}` };
  }
  if (cmd === 'mix') lastMix = { ts: Date.now(), args: { ...args, track: args.track?.id }, source };
  if (why) addLog('claude', why);
  addLog('action', describe(cmd, args));
  const sentAt = Date.now();
  const r = await forward(cmd, args, cmd === 'load' || cmd === 'mix' ? 60000 : 15000);
  if (session) {
    const { track, steps, ...small } = args;
    sessionLog('actions.jsonl', { ts: sentAt, ackMs: Date.now() - sentAt, cmd, args: { ...small, ...(track ? { track: track.id + ' ' + track.title } : {}), ...(steps ? { steps: steps.length } : {}) }, why, ok: r.ok, error: r.error, result: r.result });
  }
  if (!r.ok) addLog('system', `⚠ ${cmd} failed: ${r.error}`);
  return { ...r, state: liveState() };
}

// ---------------------------------------------------------------- hot cues / saved loops
function deckTrack(deck) {
  const s = liveState();
  const D = String(deck || s.live || '').toUpperCase();
  const d = s.decks[D];
  if (!d?.trackId) return { error: `deck ${D || '?'} is empty` };
  const t = library.tracks.get(d.trackId);
  if (!t) return { error: 'track not in library' };
  return { D, d, t, s };
}
function parsePosition(t, v) {
  if (v == null || v === '') return null;
  const m = /^bar:(\d+)$/.exec(String(v));
  if (m) return timeOfBar(t, Number(m[1]));
  const n = Number(v);
  if (isNaN(n)) throw new Error(`bad position "${v}" (use seconds or bar:N)`);
  return n;
}
/** beats into its bar of a time (0..3), for phase-preserving quantised jumps */
const beatInBar = (t, sec) => ((Math.round(beatOfTime(t, sec)) % 4) + 4) % 4;
async function hotcue({ deck, action = 'jump', n, position, label, exact }, why) {
  const x = deckTrack(deck);
  if (x.error) return { ok: false, error: x.error };
  const { D, d, t } = x;
  n = Number(n);
  if (action === 'list') return { ok: true, result: { deck: D, trackId: t.id, title: t.title, ...cues.view(t) } };
  if (action === 'set') {
    const sec = position == null ? d.position : parsePosition(t, position);
    const c = cues.setCue(t, n, sec, { label, exact: !!exact });
    addLog('action', `Hot cue ${n} on ${D} = bar ${c.bar} (${c.sec}s)${c.label ? ' ' + c.label : ''}`);
    return { ok: true, result: { deck: D, n, ...c }, state: liveState() };
  }
  if (action === 'clear') { cues.clearCue(t, n); return { ok: true, result: { deck: D, n, cleared: true } }; }
  if (action === 'reset') { cues.resetCue(t, n); return { ok: true, result: { deck: D, n, cue: cues.cue(t, n) } }; }
  const c = cues.cue(t, n);
  if (!c) return { ok: false, error: `no hot cue ${n} on ${t.title}` };
  const w = why || `Hot cue ${n}${c.label ? ' (' + c.label + ')' : ''} → bar ${c.bar} on ${D}`;
  if (d.playing) {
    // jump on the grid: seek k beats after the next bar line, where k = the cue's beat in its bar
    const k = beatInBar(t, c.sec);
    return handleCmd({ cmd: 'perform', args: { steps: [{ b: k, d: D, seek: c.sec }], at: 'bar', ref: D }, why: w });
  }
  return handleCmd({ cmd: 'seek', args: { deck: D, position: c.sec }, why: w });
}
async function savedloop({ deck, action = 'jump', name, beats, position }, why) {
  const x = deckTrack(deck);
  if (x.error) return { ok: false, error: x.error };
  const { D, d, t } = x;
  if (action === 'list') return { ok: true, result: { deck: D, trackId: t.id, loops: cues.view(t).loops } };
  if (action === 'delete') return { ok: true, result: { deleted: cues.deleteLoop(t, name) } };
  if (action === 'set') {
    const start = position != null ? parsePosition(t, position) : d.loop ? d.loop.start : timeOfBeat(t, Math.floor(beatOfTime(t, d.position) + 1e-3));
    const l = cues.setLoop(t, name, start, beats ?? d.loop?.beats ?? 8);
    addLog('action', `Saved loop "${name}" on ${D}: ${l.beats} beats from bar ${l.bar}`);
    return { ok: true, result: { deck: D, name, ...l } };
  }
  const l = cues.loop(t, name);
  if (!l) return { ok: false, error: `no saved loop "${name}" on ${t.title}` };
  const w = why || `Saved loop "${name}" (${l.beats} beats @ bar ${l.bar}) on ${D}`;
  if (d.playing) {
    const k = beatInBar(t, l.start);
    return handleCmd({ cmd: 'perform', args: { steps: [{ b: k, d: D, seek: l.start }, { b: k + 0.001, d: D, loop: l.beats, slip: false }], at: 'bar', ref: D }, why: w });
  }
  const r = await handleCmd({ cmd: 'seek', args: { deck: D, position: l.start }, why: w });
  if (r.ok === false) return r;
  return handleCmd({ cmd: 'loop', args: { deck: D, beats: l.beats } });
}

function waitFor(q) {
  const timeout = Math.min(Number(q.timeout || 540), 590) * 1000;
  const started = Date.now();
  const inboxAtStart = inbox.length;
  return new Promise((resolve) => {
    const check = () => {
      const s = liveState();
      const deck = s.decks[q.deck || s.live || 'A'];
      const done = (reason) => { clearInterval(iv); resolve({ reason, waitedSec: Math.round((Date.now() - started) / 1000), state: s, inbox: inbox.slice() }); };
      if (q.inbox !== 'ignore' && inbox.length > inboxAtStart) return done('inbox');
      if (!s.engine.connected) return done('engine_disconnected');
      const secs = Number(q.seconds ?? 0);
      switch (q.for) {
        case 'mixout': if (deck && deck.untilMixOut != null && deck.untilMixOut <= secs) return done('mixout'); break;
        case 'remaining': if (deck && deck.remaining != null && deck.remaining <= secs) return done('remaining'); break;
        case 'transition': if (!s.transition) return done('transition_done'); break;
        case 'end': if (deck && !deck.playing) return done('deck_stopped'); break;
        case 'bar': if (deck && deck.bar >= Number(q.bar)) return done('bar'); break;
        case 'time': if (Date.now() - started >= secs * 1000) return done('time'); break;
        default: break;
      }
      if (deck && q.for !== 'end' && deck.playing === false && deck.trackId && q.for !== 'time' && q.for !== 'transition') return done('deck_stopped');
      if (Date.now() - started >= timeout) return done('timeout');
    };
    const iv = setInterval(check, 250);
    check();
  });
}

sequencer = new Sequencer({
  library, liveState, history, memory, config,
  runCmd: (c) => handleCmd(c),
  addLog, sessionLog: (f, o) => sessionLog(f, o),
  hotcue, savedloop,
  say: (text) => addLog('claude', text),
});

// ---------------------------------------------------------------- flight recorder
// A session = timestamped actions + engine telemetry + engine audio + screen/mic capture,
// all under .dj/sessions/<id>/ so silences can be reconciled against what the DJ did.
let session = null;
const SESS_ROOT = path.join(ROOT, '.dj', 'sessions');
function sessionLog(file, obj) { if (session) fs.appendFileSync(path.join(session.dir, file), JSON.stringify(obj) + '\n'); }
function startSession({ screen = true, mic = true } = {}) {
  if (session) return session.info;
  const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(SESS_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  session = { id, dir, ff: null, info: { id, dir, startedAt: Date.now() } };
  if (screen || mic) {
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    if (screen) args.push('-f', 'gdigrab', '-framerate', '5', '-draw_mouse', '1', '-i', 'desktop');
    if (mic) args.push('-f', 'dshow', '-i', 'audio=' + (config.recordMicDevice || 'Microphone Array (Qualcomm(R) Aqstic(TM) ACX Static Endpoints Audio Device)'));
    if (screen) args.push('-vf', 'scale=1280:-2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-pix_fmt', 'yuv420p');
    if (mic) args.push('-c:a', 'aac', '-b:a', '96k');
    args.push(path.join(dir, 'capture.mp4'));
    const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    try { os.setPriority(ff.pid, 19); } catch { /* best effort */ }
    let err = ''; ff.stderr.on('data', (c) => (err += c));
    ff.on('close', (code) => { if (code && session && session.ff === ff) addLog('system', '⚠ screen/mic capture stopped: ' + err.trim().slice(0, 160)); });
    session.ff = ff;
    session.info.captureStartedAt = Date.now();
  }
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(session.info, null, 2));
  broadcast('record', { on: true, id });
  addLog('system', '⏺ Recording session ' + id);
  return session.info;
}
async function stopSession() {
  if (!session) return null;
  const s = session;
  broadcast('record', { on: false, id: s.id });
  await new Promise((r) => setTimeout(r, 1500)); // let the engine flush its last audio chunk
  if (s.ff) { try { s.ff.stdin.write('q'); } catch { /* ignore */ } await new Promise((r) => { s.ff.on('close', r); setTimeout(r, 8000); }); }
  s.info.stoppedAt = Date.now();
  fs.writeFileSync(path.join(s.dir, 'session.json'), JSON.stringify(s.info, null, 2));
  session = null;
  addLog('system', '⏹ Recording saved: .dj/sessions/' + s.id);
  return s.info;
}

// ---------------------------------------------------------------- routes
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams);
  try {
    // --- engine link
    if (p === '/api/events') {
      const id = q.client || `c${Date.now()}`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${JSON.stringify({ id, engineId, recording: !!session, log: log.slice(-80), jobs: downloader.list(), library: library.status() })}\n\n`);
      clients.set(id, res);
      const ka = setInterval(() => res.write(': ka\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ka); clients.delete(id);
        if (id === engineId) { addLog('system', 'Audio engine tab disconnected'); }
      });
      return;
    }
    if (p === '/api/engine/claim' && req.method === 'POST') {
      const b = await readBody(req);
      engineId = b.client; broadcast('engine', { id: engineId });
      addLog('system', 'Audio engine online');
      return send(res, 200, { ok: true });
    }
    if (p === '/api/state' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.client === engineId) { engineState = b.state; engineStateAt = Date.now(); trackHistory(b.state); }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/ack' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.state && b.client === engineId) { engineState = b.state; engineStateAt = Date.now(); }
      pendingCmds.get(b.id)?.(b); pendingCmds.delete(b.id);
      return send(res, 200, { ok: true });
    }

    // --- control (CLI / Claude)
    if (p === '/api/state') return send(res, 200, liveState());
    if (p === '/api/record/start' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, startSession(b)); }
    if (p === '/api/record/stop' && req.method === 'POST') return send(res, 200, (await stopSession()) || { error: 'not recording' });
    if (p === '/api/record') return send(res, 200, session ? session.info : { recording: false });
    if (p === '/api/telemetry' && req.method === 'POST') { const b = await readBody(req); for (const x of b.samples || []) sessionLog('telemetry.jsonl', x); return send(res, 200, { ok: true }); }
    if (p === '/api/record/chunk' && req.method === 'POST') {
      if (!session) { req.resume(); return send(res, 200, { ok: false }); }
      const chunks = []; for await (const c of req) chunks.push(c);
      fs.appendFileSync(path.join(session.dir, 'engine-audio.webm'), Buffer.concat(chunks));
      sessionLog('audio-chunks.jsonl', { ts: Number(q.t), seq: Number(q.seq), bytes: chunks.reduce((a, c) => a + c.length, 0) });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/cmd' && req.method === 'POST') return send(res, 200, await handleCmd(await readBody(req)));
    if (p === '/api/wait') return send(res, 200, await waitFor(q));
    if (p === '/api/say' && req.method === 'POST') {
      const b = await readBody(req);
      addLog('claude', b.text, { speak: !!b.speak });
      if (b.speak) forward('speak', { text: b.text }, 3000);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/log') return send(res, 200, log.slice(-Number(q.n || 50)));
    if (p === '/api/history') return send(res, 200, history);

    // --- crowd inbox
    if (p === '/api/inbox' && req.method === 'POST') {
      const b = await readBody(req);
      const text = String(b.text || '').trim().slice(0, 500);
      if (!text) return send(res, 400, { ok: false });
      const m = { ts: Date.now(), from: String(b.from || 'crowd').slice(0, 40), text };
      inbox.push(m); addLog('crowd', `${m.from}: ${text}`);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/inbox') { const items = inbox.slice(); if (q.clear) inbox.length = 0; return send(res, 200, items); }

    // --- library
    if (p === '/api/library') return send(res, 200, { status: library.status(), dirs: library.dirs, tracks: library.search({ ...q, limit: q.limit || 500 }) });
    if (p === '/api/library/scan' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, library.scan({ force: !!b.force })); }
    if (p === '/api/suggest') {
      const s = liveState();
      const liveDeck = s.decks?.[s.live];
      const from = q.from || liveDeck?.trackId;
      const exclude = [...history.map((h) => h.id), ...Object.values(s.decks || {}).map((d) => d.trackId).filter(Boolean)];
      const fromLive = liveDeck && (!q.from || library.get(q.from)?.id === liveDeck.trackId);
      if (q.mashup) return send(res, 200, library.mashups({ from: q.from || liveDeck?.trackId, exclude: q.from ? [] : [], limit: Number(q.limit) || 10, memory }));
      // incoming deck: the idle one; its keylock decides whether tempo changes the key
      const idle = s.live ? sequencer.pickIdle(s, s.live) : null;
      const keylock = q.keylock != null ? q.keylock === '1' || q.keylock === 'true' : !!s.decks?.[idle?.name]?.keylock;
      return send(res, 200, library.suggest({
        from, direction: q.direction, exclude, limit: q.limit, memory, keylock,
        targetBpm: q.bpm ? Number(q.bpm) : fromLive ? effBpm(liveDeck) || undefined : undefined,
        refCamelot: fromLive ? deckEffectiveCamelot(liveDeck) || undefined : undefined,
      }));
    }
    // --- mix monitor / sequencer / queue / auto-DJ / memory / cues / grid
    if (p === '/api/monitor') return send(res, 200, { ...monitor.last, recent: monitor.recent.slice(-Number(q.n || 20)), transition: monitor.cur ? { id: monitor.cur.id, style: monitor.cur.style } : null });
    if (p === '/api/plan' && req.method === 'POST') {
      const b = await readBody(req);
      try {
        if (b.clear) return send(res, 200, { ok: true, removed: sequencer.clear(!!b.all), plan: sequencer.view(liveState()) });
        if (b.remove) return send(res, 200, { ok: sequencer.remove(b.remove), plan: sequencer.view(liveState()) });
        const added = sequencer.add(b.add ?? b.step ?? b);
        for (const st of added) addLog('claude', `📋 Planned ${st.id}: ${st.cmd} ${JSON.stringify(st.when)}${st.why ? ' — ' + st.why : ''}`);
        return send(res, 200, { ok: true, added: added.map((x) => x.id), plan: sequencer.view(liveState()) });
      } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    }
    if (p === '/api/plan') return send(res, 200, sequencer.view(liveState()));
    if (p === '/api/queue' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.clear) { sequencer.queue.length = 0; return send(res, 200, { ok: true, queue: [] }); }
      if (b.remove != null) { sequencer.queue.splice(Number(b.remove) - 1, 1); return send(res, 200, { ok: true, queue: sequencer.queue }); }
      const r = sequencer.enqueue([].concat(b.add || []));
      if (r.added.length) addLog('claude', `🗂 Queued: ${r.added.map((id) => library.tracks.get(id)?.title).join(' · ')}`);
      return send(res, 200, { ok: !r.missing.length, ...r, ...(r.missing.length ? { error: `no track matches: ${r.missing.join(', ')}` } : {}) });
    }
    if (p === '/api/queue') return send(res, 200, sequencer.queue);
    if (p === '/api/autodj' && req.method === 'POST') { const b = await readBody(req); sequencer.setAuto(b.enabled !== false, b.leadSec); return send(res, 200, sequencer.summary(liveState()).autoDJ); }
    if (p === '/api/autodj') return send(res, 200, sequencer.summary(liveState()).autoDJ);
    if (p === '/api/rate' && req.method === 'POST') {
      const b = await readBody(req);
      if (!['good', 'bad'].includes(b.rating)) return send(res, 400, { ok: false, error: 'rating must be good or bad' });
      const s = liveState();
      const aud = Object.entries(s.decks || {}).filter(([, d]) => d.playing && d.trackId && (d.audible || 0) > 0.3).sort((a, b2) => b2[1].audible - a[1].audible);
      const brief = (d) => ({ id: d.trackId, title: d.title, artist: d.artist, camelot: d.camelot, bpm: d.bpm });
      const mashup = !s.transition && aud.length >= 2 ? { from: brief(aud[0][1]), to: brief(aud[1][1]), decks: [aud[0][0], aud[1][0]], warnings: [...new Set(monitor.recent.filter((w) => Date.now() - w.ts < 120000).map((w) => w.type))] } : null;
      const e = memory.rate(b.rating, b.note, mashup);
      if (!e) return send(res, 200, { ok: false, error: 'nothing to rate yet (no transition recorded)' });
      addLog('claude', `${b.rating === 'good' ? '👍' : '👎'} ${e.type} ${e.from?.title} → ${e.to?.title}${b.note ? ': ' + b.note : ''}`);
      return send(res, 200, { ok: true, entry: e });
    }
    if (p === '/api/memory') return send(res, 200, { pairs: memory.pairs(), recent: memory.list.slice(-Number(q.n || 10)), total: memory.list.length });
    if (p === '/api/hotcue' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, await hotcue(b, b.why)); }
    if (p === '/api/savedloop' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, await savedloop(b, b.why)); }
    if (p === '/api/grid' && req.method === 'POST') {
      const b = await readBody(req);
      const t = library.get(String(b.id || ''));
      if (!t) return send(res, 404, { ok: false, error: `No track matches "${b.id}"` });
      try {
        const before = { bpm: t.bpm, firstBeat: t.firstBeat };
        await library.gridEdit(t.id, { shift: b.shift, nudge: b.nudge, bpm: b.bpm, reset: !!b.reset });
        addLog('action', `Grid ${t.title}: ${before.bpm} BPM @ ${before.firstBeat}s → ${t.bpm} BPM @ ${t.firstBeat}s`);
        const onDeck = Object.entries(liveState().decks || {}).filter(([, d]) => d.trackId === t.id).map(([n]) => n);
        return send(res, 200, { ok: true, before, track: library.summary(t), note: onDeck.length ? `deck ${onDeck.join(',')} still plays with the old grid until reloaded` : undefined });
      } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    }
    let m;
    if ((m = /^\/api\/track\/([\w-]+)\/chroma$/.exec(p))) { // per-8-bar-phrase chroma, for the chord HUD
      const t = library.get(decodeURIComponent(m[1]));
      if (!t) return send(res, 404, { error: 'no such track' });
      return send(res, 200, { id: t.id, bpm: t.bpm, firstBeat: t.firstBeat, phraseChroma: t.phraseChroma || null });
    }
    if ((m = /^\/api\/track\/([\w-]+)$/.exec(p))) {
      const t = library.get(decodeURIComponent(m[1]));
      if (!t) return send(res, 404, { error: 'no such track' });
      const { barEnergy, barBass, phraseChroma, ...rest } = t;
      return send(res, 200, { ...rest, cues: cues.view(t) });
    }
    if ((m = /^\/audio\/(\w+)$/.exec(p))) {
      const t = library.tracks.get(m[1]);
      if (!t) return send(res, 404, 'no such track');
      const sr = Number(q.sr);
      if (!sr) return serveFile(req, res, t.file);
      if (engineSampleRate !== sr) { engineSampleRate = sr; setTimeout(prewarm, 2000); }
      try { return serveFile(req, res, await pcmFile(t, sr)); } catch { return serveFile(req, res, t.file); }
    }

    // --- stems: .dj/stems/<id>/<stem>.wav, served like /audio/<id> (optionally resampled for the engine)
    if ((m = /^\/audio\/(\w+)\/stem\/(\w+)$/.exec(p))) {
      const [, id, stem] = m;
      if (!STEMS.includes(stem) || !library.tracks.has(id)) return send(res, 404, 'no such stem');
      if (!stems.isDone(id)) return send(res, 404, 'stems not ready');
      const src = stems.stemFile(id, stem);
      const sr = Number(q.sr);
      if (!sr) return serveFile(req, res, src);
      try { return serveFile(req, res, await stemPcmFile(src, id, stem, sr)); } catch { return serveFile(req, res, src); }
    }
    if (p === '/api/stems' && req.method === 'POST') {
      const b = await readBody(req);
      const target = b.id ?? b.track ?? 'all';
      if (target === 'all') return send(res, 200, { ok: true, ...stems.enqueueAll(), status: stems.status() });
      const t = library.get(String(target));
      if (!t) return send(res, 404, { ok: false, error: `No track matches "${target}"` });
      return send(res, 200, { ok: true, ...stems.enqueue(t.id, { front: true }), title: t.title, artist: t.artist });
    }
    if (p === '/api/stems') return send(res, 200, stems.status());

    // --- downloads
    if (p === '/api/download/search') return send(res, 200, await downloader.search(q.q, Number(q.n || 8)));
    if (p === '/api/download' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.input) return send(res, 400, { error: 'input required' });
      const job = downloader.start(b.input, { playlist: !!b.playlist, max: b.max || 25 });
      addLog('system', `⬇ Downloading: ${b.input}`);
      job.done.then(async (j) => {
        if (j.status !== 'downloaded') { addLog('system', `⚠ Download failed: ${j.error}`); return; }
        j.status = 'analyzing'; downloader.emitJob(j);
        const tracks = [];
        for (const f of j.files) { const t = await library.analyzeNow(f); if (t) tracks.push(library.summary(t)); }
        library.save();
        j.tracks = tracks; j.status = tracks.length ? 'ready' : 'error'; if (!tracks.length) j.error = 'analysis failed';
        downloader.emitJob(j);
        for (const t of tracks) addLog('system', `✓ Added ${t.artist ? t.artist + ' - ' : ''}${t.title} (${t.bpm} BPM, ${t.camelot})`);
      });
      if (b.wait) { await job.done; while (!['ready', 'error'].includes(job.status)) await new Promise((r) => setTimeout(r, 300)); }
      const { done, log: jl, ...pub } = job;
      return send(res, 200, pub);
    }
    if (p === '/api/jobs') return send(res, 200, downloader.list().map(({ done, log: l, ...j }) => j));
    if (p === '/api/health') {
      const [ffmpeg, ffprobe, ytdlp] = await Promise.all([hasTool('ffmpeg'), hasTool('ffprobe'), hasTool('yt-dlp', downloader.localBin)]);
      return send(res, 200, healthReport({
        uptimeSec: process.uptime(), port: PORT,
        engine: { connected: !!engineId && clients.has(engineId), started: !!engineState?.started, ageSec: engineState ? (Date.now() - engineStateAt) / 1000 : null },
        library: library.status(),
        stems: { enabled: stems.enabled, available: stems.available, queued: stems.queue.length, running: !!stems.running, failed: stems.failed.size },
        tools: { ffmpeg, ffprobe, ytdlp },
      }));
    }
    if (p === '/api/doctor') {
      return send(res, 200, { ytdlp: downloader.which(), library: library.status(), dirs: library.dirs, downloadDir, engine: liveState().engine, port: PORT });
    }
    if (p === '/api/ytdlp/install' && req.method === 'POST') return send(res, 200, { path: await downloader.ensure() });

    // --- static UI
    const file = path.join(ROOT, 'public', p === '/' ? 'index.html' : p === '/health' ? 'health.html' : p);
    if (file.startsWith(path.join(ROOT, 'public')) && fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(req, res, file);
    send(res, 404, 'not found');
  } catch (e) {
    console.error(e);
    send(res, 500, { ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------- dead-air guard
// If the on-air track is about to run out with nothing else playing and no mix
// scheduled, loop its last bars so the music never stops. Any mix takes over from the loop.
let guardBusy = false;
setInterval(async () => {
  if (guardBusy || config.deadAirGuard === false) return;
  const s = liveState();
  if (!s.engine.connected || s.engine.stale || s.transition || !s.live) return;
  const live = s.decks[s.live];
  const otherPlaying = Object.entries(s.decks).some(([n, d]) => n !== s.live && d.playing && (d.audible || 0) > 0.05);
  if (!live?.playing || live.loop || otherPlaying || live.remaining == null || live.remaining > 9) return;
  guardBusy = true;
  const r = await forward('loop', { deck: s.live, beats: 8 }, 3000);
  if (r.ok) addLog('system', `⛑ Dead-air guard: looping the last bars of deck ${s.live} until the next mix`);
  setTimeout(() => (guardBusy = false), 4000);
}, 1000);

// ---------------------------------------------------------------- monitor + sequencer + stem throttle
setInterval(() => {
  if (config.monitor?.enabled === false) return;
  try { const s = liveState(); if (s.engine.connected && !s.engine.stale) monitor.tick(s); } catch (e) { console.error('monitor', e); }
}, 250);
setInterval(() => sequencer.tick(), 250);
setInterval(() => {
  const s = liveState();
  const playing = s.engine.connected && Object.values(s.decks || {}).some((d) => d.playing && (d.audible || 0) > 0.05);
  stems.setMusicPlaying(playing);
}, 1000);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`Port ${PORT} is busy — is the DJ server already running? (http://localhost:${PORT})`); process.exit(1); }
  throw e;
});
server.listen(PORT, () => {
  const s = library.scan();
  console.log(`\n  🎧  Claude DJ  →  http://localhost:${PORT}\n`);
  console.log(`  library: ${library.dirs.join(', ')}`);
  console.log(`  ${s.total} tracks cached, ${s.queued} queued for analysis\n`);
  addLog('system', `Server started. ${s.total} tracks in library, ${s.queued} to analyse.`);
  if (stemCfg.auto !== false) {
    if (!stems.available) addLog('system', '⚠ Stem separation unavailable: no .venv python with demucs (see README)');
    else setTimeout(() => { const r = stems.enqueueAll(); if (r.queued) addLog('system', `🎚 Stem separation queued for ${r.queued} track(s) (background, idle priority)`); }, 15000);
  }
});
