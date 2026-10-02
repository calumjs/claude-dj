// Shared harness for the server feature tests (no tests in here).
//  - scratch(): copies the project code + a copy of .dj/library.json into a scratch dir, with its own
//    config (port, stems off). The real .dj is never written.
//  - startServer(): runs that copy with DJ_PORT, DJ_NO_BACKFILL=1.
//  - FakeEngine: an engine client that claims the engine, pushes plausible deck state and acks
//    commands (load/play/pause/seek/cue/loop/perform/mix/…), recording everything it was sent.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH_BASE = process.env.DJ_SCRATCH || path.join(os.tmpdir(), 'claude-dj-srvtest');

export function scratch(name, { port, config = {}, mutateLibrary } = {}) {
  const dir = path.join(SCRATCH_BASE, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.dj'), { recursive: true });
  for (const f of ['server.mjs', 'dj.mjs', 'package.json']) fs.copyFileSync(path.join(REAL, f), path.join(dir, f));
  for (const d of ['lib', 'cli-ext']) fs.cpSync(path.join(REAL, d), path.join(dir, d), { recursive: true });
  const real = JSON.parse(fs.readFileSync(path.join(REAL, 'config.json'), 'utf8'));
  const cfg = {
    ...real, port,
    // absolute real library folders (read-only walk) so scan doesn't drop tracks from the copy
    libraryDirs: real.libraryDirs.map((d) => (d.startsWith('~') || path.isAbsolute(d) ? d : path.join(REAL, d))),
    downloadDir: path.join(dir, 'downloads'),
    stems: { ...(real.stems || {}), enabled: false, auto: false },
    deadAirGuard: false,
    ...config,
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  const lib = JSON.parse(fs.readFileSync(path.join(REAL, '.dj', 'library.json'), 'utf8'));
  if (mutateLibrary) mutateLibrary(lib);
  fs.writeFileSync(path.join(dir, '.dj', 'library.json'), JSON.stringify(lib));
  return { dir, port, base: `http://localhost:${port}`, lib };
}

export async function startServer(sc) {
  const logFile = path.join(sc.dir, '.dj', 'server.log');
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(sc.dir, 'server.mjs')], { cwd: sc.dir, env: { ...process.env, DJ_PORT: String(sc.port), DJ_NO_BACKFILL: '1' }, stdio: ['ignore', fd, fd], windowsHide: true });
  for (let i = 0; i < 80; i++) {
    await sleep(150);
    try { await fetch(sc.base + '/api/state'); return { child, stop: () => { try { child.kill(); } catch { /* gone */ } } }; } catch { /* starting */ }
  }
  child.kill();
  throw new Error('server did not start: ' + fs.readFileSync(logFile, 'utf8').slice(-2000));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function api(base, p, body) {
  const res = await fetch(base + p, body !== undefined ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return res.json();
}
/** run the CLI of the scratch copy */
export function cli(sc, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(sc.dir, 'dj.mjs'), ...args], { cwd: sc.dir, env: { ...process.env, DJ_PORT: String(sc.port) }, timeout: 120000 }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr }));
  });
}
export async function waitUntil(fn, ms = 10000, step = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

// ---------------------------------------------------------------- fake engine
const blankDeck = () => ({ trackId: null, duration: null, loaded: false, loading: false, playing: false, position: 0, rate: 1, cue: 0, loop: null, vol: 1, filter: 0, echo: 0, eq: { low: 0, mid: 0, high: 0 }, audible: 0, keylock: true, keyShift: 0, effectiveCamelot: null, stems: { loaded: false, vocals: 1, drums: 1, bass: 1, other: 1 } });

export class FakeEngine {
  constructor(base, client = 'fake-engine') {
    this.base = base; this.client = client;
    this.decks = { A: blankDeck(), B: blankDeck() };
    for (const [n, d] of Object.entries(this.decks)) d.xfAssign = n === 'A' ? 'left' : 'right';
    this.anchor = {}; // deck -> wall ms when position was set
    this.master = { volume: 0.9, xfader: 0 };
    this.transition = null;
    this.cmds = [];
    this.extraMaster = {};
  }
  async start() {
    this.ctrl = new AbortController();
    const res = await fetch(`${this.base}/api/events?client=${this.client}`, { signal: this.ctrl.signal });
    this.reading = this.read(res.body.getReader()).catch(() => {});
    await api(this.base, '/api/engine/claim', { client: this.client });
    this.timer = setInterval(() => this.push().catch(() => {}), 200);
    await this.push();
  }
  async stop() { this.stopped = true; clearInterval(this.timer); this.ctrl?.abort(); }
  async read(reader) {
    const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev === 'cmd' && data) this.onCmd(JSON.parse(data));
      }
    }
  }
  pos(n, now = Date.now()) {
    const d = this.decks[n];
    if (!d.playing) return d.position;
    let p = d.position + ((now - this.anchor[n]) / 1000) * d.rate;
    if (d.loop && p > d.loop.end) p = d.loop.start + ((p - d.loop.start) % (d.loop.end - d.loop.start));
    return p;
  }
  /** set deck fields; position is re-anchored to now */
  set(n, patch) {
    this.decks[n] ||= blankDeck();
    const d = this.decks[n];
    if (!('position' in patch)) d.position = this.pos(n);
    Object.assign(d, patch);
    this.anchor[n] = Date.now();
    return this.push();
  }
  /** set several decks with one shared time anchor (keeps relative phase exact) */
  setMany(patches) {
    const now = Date.now();
    for (const [n, patch] of Object.entries(patches)) {
      this.decks[n] ||= blankDeck();
      const d = this.decks[n];
      if (!('position' in patch)) d.position = this.pos(n, now);
      Object.assign(d, patch);
      this.anchor[n] = now;
    }
    return this.push();
  }
  trackFields(t) { return { trackId: t.id, title: t.title, artist: t.artist, bpm: t.bpm, camelot: t.camelot, key: t.key, energy: t.energy, firstBeat: t.firstBeat, mixOut: t.mixOut, duration: t.duration, loaded: true, effectiveCamelot: t.camelot }; }
  loadTrack(n, t, extra = {}) {
    return this.set(n, { trackId: t.id, title: t.title, artist: t.artist, bpm: t.bpm, camelot: t.camelot, key: t.key, energy: t.energy, firstBeat: t.firstBeat, mixOut: t.mixOut, duration: t.duration, loaded: true, effectiveCamelot: t.camelot, position: 0, ...extra });
  }
  state() {
    const now = Date.now();
    const decks = {};
    for (const [n, d] of Object.entries(this.decks)) decks[n] = { ...d, position: +this.pos(n, now).toFixed(3) };
    return { started: true, master: { ...this.master, ...this.extraMaster }, decks, transition: this.transition };
  }
  push() { if (this.stopped) return Promise.resolve(); return api(this.base, '/api/state', { client: this.client, state: this.state() }).catch(() => {}); }
  /** seconds until deck n's next boundary of `beats` (like the engine's nextBoundary) + that beat */
  nextBoundary(n, beats = 4, minAhead = 0.15) {
    const d = this.decks[n], beat = 60 / d.bpm;
    const b = (this.pos(n) + minAhead * d.rate - d.firstBeat) / beat;
    const target = Math.ceil(b / beats - 1e-6) * beats;
    return { sec: minAhead + ((target - b) * beat) / d.rate, beat: target };
  }
  async onCmd({ id, cmd, args }) {
    const rec = { ts: Date.now(), cmd, args, state: this.state() };
    this.cmds.push(rec);
    let result = null, ok = true, error;
    try {
      const d = args?.deck ? (this.decks[args.deck] ||= blankDeck()) : null;
      switch (cmd) {
        case 'load': await this.loadTrack(args.deck, args.track); result = { deck: args.deck, title: args.track.title }; break;
        case 'play': await this.set(args.deck, { playing: true, audible: 1 }); result = { playing: true }; break;
        case 'pause': await this.set(args.deck, { playing: false }); break;
        case 'seek': await this.set(args.deck, { position: Number(args.position) }); result = { position: Number(args.position) }; break;
        case 'loop': await this.set(args.deck, { loop: Number(args.beats) ? { beats: Number(args.beats), start: this.pos(args.deck), end: this.pos(args.deck) + (Number(args.beats) * 60) / d.bpm } : null }); break;
        case 'perform': {
          const ref = args.ref || 'A';
          const nb = this.nextBoundary(ref, args.at === 'phrase' ? 32 : 4);
          result = { startsInSec: +nb.sec.toFixed(2), beat: nb.beat, steps: args.steps.length };
          break;
        }
        case 'mix': {
          if (args.track) await this.loadTrack(args.to, args.track);
          const A = this.decks[args.from];
          if (!A.playing) { await this.set(args.to, { playing: true, audible: 1 }); result = { style: 'start' }; break; }
          let nb = this.nextBoundary(args.from, args.at === 'phrase' ? 32 : args.at === 'now' ? 0.001 : 4);
          if (args.at === 'phrase' && nb.sec > 30) nb = this.nextBoundary(args.from, 16);
          const bars = args.bars ?? { blend: 16, bassswap: 8, filter: 8, echo: 1, cut: 0 }[args.style] ?? 8;
          const dur = (bars * 240) / (A.bpm * A.rate);
          const now = Date.now();
          this.transition = { id: Math.random().toString(36).slice(2, 8), from: args.from, to: args.to, style: args.style, bars, startAt: now + nb.sec * 1000, endAt: now + (nb.sec + dur) * 1000 };
          result = { style: args.style, bars, startsInSec: +nb.sec.toFixed(2), durationSec: +dur.toFixed(1), beat: nb.beat, warnings: [] };
          if (!this.noAutoFinish) {
            const T = this.transition;
            setTimeout(() => this.set(args.to, { playing: true, audible: 0.5, position: this.decks[args.to].position }), nb.sec * 1000);
            setTimeout(async () => { if (this.transition === T) this.transition = null; await this.set(args.from, { playing: false, audible: 0 }); await this.set(args.to, { audible: 1 }); }, (nb.sec + dur) * 1000);
          }
          break;
        }
        default: break;
      }
    } catch (e) { ok = false; error = e.message; }
    rec.result = result;
    if (!this.stopped) await api(this.base, '/api/ack', { id, ok, result, error, client: this.client, state: this.state() }).catch(() => {});
  }
  sent(cmd) { return this.cmds.filter((c) => c.cmd === cmd); }
}
