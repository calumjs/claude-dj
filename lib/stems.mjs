// Stem separation queue + vocal map.
// Splits library tracks into .dj/stems/<trackId>/{vocals,drums,bass,other}.wav with demucs
// (htdemucs, CPU, idle priority, few threads) via lib/separate.py in the project .venv,
// one job at a time. Output goes to a temp dir first and is moved into place only when
// all four stems exist, so a partial stem is never served. After separation the vocals
// stem is scanned to build `vocalSections` / `vocalPct` on the library track.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { decodeMono } from './analyze.mjs';

export const STEMS = ['vocals', 'drums', 'bass', 'other'];
export const VOCAL_MAP_VERSION = 1;

export const stemDir = (stemsDir, id) => path.join(stemsDir, id);
export const stemPath = (stemsDir, id, stem) => path.join(stemsDir, id, `${stem}.wav`);
export const hasAllStems = (stemsDir, id) => STEMS.every((s) => fs.existsSync(stemPath(stemsDir, id, s)));

export function findPython(root, override) {
  const cands = [override, path.join(root, '.venv', 'Scripts', 'python.exe'), path.join(root, '.venv', 'bin', 'python')].filter(Boolean);
  return cands.find((p) => fs.existsSync(p)) || null;
}

// ---------------------------------------------------------------- vocal map
/**
 * Vocal sections from a vocals stem: RMS over 0.5 s windows, threshold relative to the
 * stem's own loud level, gaps < 2 s merged, sections < 1.5 s dropped, bars 1-based
 * (bar N starts at firstBeat + (N-1) bars, same as the CLI's bar:N). endBar is inclusive.
 */
export async function vocalMap(file, { bpm, firstBeat = 0, audioStart, audioEnd, duration } = {}) {
  const SR = 11025, W = 0.5;
  const x = await decodeMono(file, SR);
  const w = Math.round(SR * W), n = Math.floor(x.length / w);
  const db = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0; for (let i = k * w, e = i + w; i < e; i++) s += x[i] * x[i];
    db[k] = 10 * Math.log10(s / w + 1e-12);
  }
  const sorted = [...db].sort((a, b) => a - b);
  const loud = sorted[Math.min(n - 1, Math.floor(0.95 * n))] ?? -120;
  // a stem that never gets loud is an instrumental: separation residue only
  const thr = Math.max(loud - 20, -48);
  let raw = [];
  if (loud > -38) {
    for (let k = 0; k < n; ) {
      if (db[k] < thr) { k++; continue; }
      let j = k; while (j < n && db[j] >= thr) j++;
      raw.push([k * W, j * W]); k = j;
    }
  }
  const merged = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < 2) last[1] = r[1]; else merged.push([...r]);
  }
  const bar = bpm ? (60 / bpm) * 4 : null;
  const sections = merged.filter(([a, b]) => b - a >= 1.5).map(([a, b]) => {
    const s = { start: +a.toFixed(2), end: +b.toFixed(2) };
    if (bar) {
      s.startBar = Math.max(1, Math.floor((a - firstBeat) / bar + 0.25) + 1);
      s.endBar = Math.max(s.startBar, Math.ceil((b - firstBeat) / bar - 0.25));
    }
    return s;
  });
  const total = sections.reduce((acc, s) => acc + (s.end - s.start), 0);
  const span = (audioEnd ?? duration ?? x.length / SR) - (audioStart ?? 0);
  return { vocalSections: sections, vocalPct: +Math.min(1, total / Math.max(1, span)).toFixed(3), vocalLoudDb: +loud.toFixed(1) };
}

// ---------------------------------------------------------------- queue
export class StemQueue {
  constructor({ root, library, stemsDir, python, threads = 2, concurrency = 2, model = 'htdemucs', minFreeGB = 3, enabled = true, modelsDir, log = () => {}, onEvent = () => {} }) {
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    // while music plays: 1 job at 2 threads (running jobs finish; nothing is killed). Full speed after 30 s of quiet.
    this.lastMusicAt = 0;
    this.quietSec = 30;
    this.root = root;
    this.library = library;
    this.stemsDir = stemsDir;
    this.python = python === undefined ? findPython(root) : python;
    this.threads = threads;
    this.model = model;
    this.minFreeGB = minFreeGB;
    this.enabled = enabled;
    this.modelsDir = modelsDir || path.join(root, '.dj', 'models');
    this.log = log;
    this.onEvent = onEvent;
    this.queue = [];            // track ids
    this.jobs = new Map();      // id -> { id, title, progress, startedAt, child, threads }
    this.failed = new Map();    // id -> error
    this.times = [];            // recent { id, secs, duration }
    fs.mkdirSync(stemsDir, { recursive: true });
    // clear temp dirs left by a crash
    for (const e of fs.readdirSync(stemsDir)) if (e.startsWith('.tmp-')) fs.rmSync(path.join(stemsDir, e), { recursive: true, force: true });
  }

  get available() { return !!this.python && fs.existsSync(path.join(this.root, 'lib', 'separate.py')); }
  isDone(id) { return hasAllStems(this.stemsDir, id); }
  stemFile(id, stem) { return stemPath(this.stemsDir, id, stem); }

  emit(id, status, extra = {}) { this.onEvent({ id, status, ...extra }); }

  /** stale = stems exist but the source file changed since separation */
  stale(t) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(stemDir(this.stemsDir, t.id), 'meta.json'), 'utf8'));
      return meta.size !== t.size || Math.round(meta.mtimeMs) !== Math.round(t.mtimeMs);
    } catch { return false; } // no meta: trust what's there
  }

  enqueue(id, { front = false } = {}) {
    const t = this.library.tracks.get(id);
    if (!t) return { id, status: 'unknown' };
    if (this.isDone(id) && !this.stale(t)) {
      if (t.vocalMapVersion !== VOCAL_MAP_VERSION) this.mapVocals(t).catch((e) => this.log(`vocal map failed for ${id}: ${e.message}`));
      return { id, status: 'ready' };
    }
    if (this.jobs.has(id)) return { id, status: 'separating', progress: this.jobs.get(id).progress };
    const i = this.queue.indexOf(id);
    if (i >= 0) { if (front && i > 0) { this.queue.splice(i, 1); this.queue.unshift(id); } return { id, status: 'queued' }; }
    this.failed.delete(id);
    if (front) this.queue.unshift(id); else this.queue.push(id);
    this.emit(id, 'queued', { progress: 0 });
    setImmediate(() => this.pump());
    return { id, status: 'queued' };
  }

  enqueueAll() {
    // shortest first so stems start showing up quickly
    const ids = [...this.library.tracks.values()].filter((t) => t.bpm).sort((a, b) => (a.duration || 0) - (b.duration || 0)).map((t) => t.id);
    let queued = 0, ready = 0;
    for (const id of ids) { const r = this.enqueue(id); if (r.status === 'queued') queued++; if (r.status === 'ready') ready++; }
    return { queued, ready, total: ids.length };
  }

  status() {
    const all = [...this.library.tracks.keys()];
    const done = all.filter((id) => this.isDone(id)).length;
    const avg = this.times.length ? this.times.reduce((a, x) => a + x.secs / Math.max(1, x.duration), 0) / this.times.length : null;
    return {
      enabled: this.enabled, available: this.available, python: this.python, model: this.model, threads: this.threads,
      done, total: all.length,
      running: this.running ? this.jobView(this.running) : null,
      jobs: [...this.jobs.values()].map((j) => this.jobView(j)),
      mode: this.mode(), concurrency: this.concurrency, maxJobs: this.limits().jobs, jobThreads: this.limits().threads,
      queued: this.queue.slice(),
      failed: Object.fromEntries(this.failed),
      secsPerTrackSec: avg != null ? +avg.toFixed(2) : null,
      recent: this.times.slice(-5),
      freeGB: this.freeGB(),
    };
  }

  freeGB() {
    try { const s = fs.statfsSync(this.stemsDir); return +((s.bavail * s.bsize) / 1e9).toFixed(1); } catch { return null; }
  }

  /** first running job (back-compat for callers that expect a single job) */
  get running() { return this.jobs.values().next().value || null; }
  jobView(j) { return { id: j.id, title: j.title, progress: +j.progress.toFixed(3), elapsedSec: Math.round((Date.now() - j.startedAt) / 1000), threads: j.threads }; }
  /** call regularly with whether any deck is playing + audible */
  setMusicPlaying(on) {
    const was = this.mode();
    if (on) this.lastMusicAt = Date.now();
    const now = this.mode();
    if (was !== now) { this.log(now === 'throttled' ? '🎚 Stem separation throttled while music plays (1 job, 2 threads)' : `🎚 Stem separation back to full speed (${this.concurrency} jobs × ${this.threads} threads)`); }
    if (now === 'full') this.pump();
  }
  mode() { return this.lastMusicAt && Date.now() - this.lastMusicAt < this.quietSec * 1000 ? 'throttled' : 'full'; }
  limits() { return this.mode() === 'throttled' ? { jobs: 1, threads: Math.min(2, this.threads) } : { jobs: this.concurrency, threads: this.threads }; }

  pump() {
    while (this.enabled && this.available && this.queue.length && this.jobs.size < this.limits().jobs) {
      if (this.pumpOne() === false) break;
    }
  }
  pumpOne() {
    const free = this.freeGB();
    if (free != null && free < this.minFreeGB) {
      if (!this.lowDiskWarned) { this.lowDiskWarned = true; this.log(`⚠ Stem separation paused: only ${free} GB free (need ${this.minFreeGB} GB)`); }
      setTimeout(() => { this.lowDiskWarned = false; this.pump(); }, 10 * 60 * 1000).unref?.();
      return false;
    }
    const id = this.queue.shift();
    const t = this.library.tracks.get(id);
    if (!t) return true;
    this.run(t, this.limits().threads)
      .then(() => this.mapVocals(t))
      .then(() => {
        const cur = this.library.tracks.get(id) || t;
        this.emit(id, 'ready', { progress: 1, stems: STEMS, vocalPct: cur.vocalPct, vocalSections: cur.vocalSections });
        const secs = [...this.times].reverse().find((x) => x.id === id)?.secs;
        this.log(`🎚 Stems ready: ${t.artist ? t.artist + ' - ' : ''}${t.title} (vocals ${Math.round((cur.vocalPct || 0) * 100)}%, ${cur.vocalSections?.length || 0} sections${secs ? `, ${Math.round(secs)}s` : ''})`);
      })
      .catch((e) => {
        this.failed.set(id, e.message);
        this.emit(id, 'failed', { error: e.message });
        this.log(`⚠ Stem separation failed for ${t.title}: ${e.message}`);
      })
      .finally(() => { this.jobs.delete(id); setTimeout(() => this.pump(), 500); });
    return true;
  }

  run(t, threads = this.threads) {
    const tmp = path.join(this.stemsDir, `.tmp-${t.id}-${process.pid}`);
    const final = stemDir(this.stemsDir, t.id);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const started = Date.now();
    return new Promise((resolve, reject) => {
      fs.mkdirSync(this.modelsDir, { recursive: true });
      const child = spawn(this.python, [path.join(this.root, 'lib', 'separate.py'), t.file, tmp, String(threads), this.model], {
        cwd: this.root, windowsHide: true,
        env: { ...process.env, TORCH_HOME: this.modelsDir, OMP_NUM_THREADS: String(threads), MKL_NUM_THREADS: String(threads), PYTHONUNBUFFERED: '1' },
      });
      try { os.setPriority(child.pid, 19); } catch { /* best effort */ }
      const job = { id: t.id, title: t.title, progress: 0, startedAt: started, child, threads };
      this.jobs.set(t.id, job);
      this.emit(t.id, 'separating', { progress: 0 });
      let err = '', buf = '', lastEmit = 0;
      child.stdout.on('data', (c) => {
        buf += c;
        let nl; while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          const m = /^PROGRESS ([\d.]+)/.exec(line);
          if (m) {
            job.progress = Number(m[1]);
            if (job.progress - lastEmit >= 0.02 || job.progress >= 1) { lastEmit = job.progress; this.emit(t.id, 'separating', { progress: +job.progress.toFixed(3) }); }
          }
        }
      });
      child.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
      child.on('error', (e) => { fs.rmSync(tmp, { recursive: true, force: true }); reject(e); });
      child.on('close', (code) => {
        const ok = code === 0 && STEMS.every((s) => fs.existsSync(path.join(tmp, `${s}.wav`)));
        if (!ok) {
          fs.rmSync(tmp, { recursive: true, force: true });
          const msg = (/ERROR (.*)/.exec(err)?.[1] || err.trim().split(/\r?\n/).pop() || `exit ${code}`).slice(0, 300);
          return reject(new Error(msg));
        }
        const secs = (Date.now() - started) / 1000;
        fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify({ id: t.id, source: t.file, size: t.size, mtimeMs: t.mtimeMs, model: this.model, threads, seconds: +secs.toFixed(1), separatedAt: new Date().toISOString() }, null, 2));
        try {
          fs.rmSync(final, { recursive: true, force: true });
          fs.renameSync(tmp, final);
        } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); return reject(e); }
        this.times.push({ id: t.id, secs: +secs.toFixed(1), duration: t.duration }); if (this.times.length > 50) this.times.shift();
        resolve();
      });
    });
  }

  async mapVocals(t) {
    const vm = await vocalMap(this.stemFile(t.id, 'vocals'), t);
    const cur = this.library.tracks.get(t.id);
    if (!cur) return vm;
    Object.assign(cur, vm, { vocalMapVersion: VOCAL_MAP_VERSION });
    this.library.onVocalMap?.(cur);
    this.library.save();
    return vm;
  }

  stop() { for (const j of this.jobs.values()) { try { j.child?.kill(); } catch { /* ignore */ } } }
}
