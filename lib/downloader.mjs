// Grab audio from YouTube / SoundCloud / Bandcamp / anything yt-dlp supports.
// yt-dlp is used from PATH if present, otherwise auto-installed into ./bin.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const IS_WIN = process.platform === 'win32';
const RELEASE = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${IS_WIN ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp'}`;

export class Downloader {
  constructor({ root, downloadDir, onEvent = () => {} }) {
    this.root = root;
    this.downloadDir = downloadDir;
    this.localBin = path.join(root, 'bin', IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');
    this.onEvent = onEvent;
    this.jobs = new Map();
    this.seq = 0;
    this.installing = null;
  }

  which() {
    if (fs.existsSync(this.localBin)) return this.localBin;
    const r = spawnSync(IS_WIN ? 'where' : 'which', ['yt-dlp'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
    return null;
  }

  async ensure() {
    const found = this.which();
    if (found) return found;
    if (!this.installing) {
      this.installing = (async () => {
        this.onEvent({ type: 'log', text: 'Installing yt-dlp (first run)…' });
        const res = await fetch(RELEASE, { redirect: 'follow' });
        if (!res.ok) throw new Error(`could not download yt-dlp: HTTP ${res.status}`);
        fs.mkdirSync(path.dirname(this.localBin), { recursive: true });
        fs.writeFileSync(this.localBin, Buffer.from(await res.arrayBuffer()));
        if (!IS_WIN) fs.chmodSync(this.localBin, 0o755);
        return this.localBin;
      })().finally(() => { this.installing = null; });
    }
    return this.installing;
  }

  async update() {
    const bin = await this.ensure();
    return new Promise((resolve) => {
      const p = spawn(bin, ['-U'], { windowsHide: true }); let out = '';
      p.stdout.on('data', (c) => (out += c)); p.stderr.on('data', (c) => (out += c));
      p.on('close', () => resolve(out.trim()));
    });
  }

  baseArgs() {
    // optional YouTube login cookies (Netscape format) at .dj/youtube-cookies.txt get past the "confirm you're not a bot" wall
    const cookies = path.join(this.root || process.cwd(), '.dj', 'youtube-cookies.txt');
    return ['--no-warnings', '--no-colors', '--encoding', 'utf-8', '--js-runtimes', 'node', ...(fs.existsSync(cookies) ? ['--cookies', cookies] : [])];
  }

  /** search without downloading: returns candidates so Claude can pick the right version */
  async search(query, n = 8) {
    const bin = await this.ensure();
    const src = /^https?:\/\//.test(query) ? query : `ytsearch${n}:${query}`;
    const args = [...this.baseArgs(), '--flat-playlist', '--print', '%(id)s\t%(title)s\t%(duration)s\t%(channel,uploader)s\t%(webpage_url,url)s', src];
    return new Promise((resolve, reject) => {
      const p = spawn(bin, args, { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } }); let out = '', err = '';
      p.stdout.on('data', (c) => (out += c)); p.stderr.on('data', (c) => (err += c));
      p.on('error', reject);
      p.on('close', (code) => {
        if (code !== 0 && !out) return reject(new Error(err.trim() || `yt-dlp exited ${code}`));
        resolve(out.trim().split(/\r?\n/).filter(Boolean).map((l) => {
          const [id, title, duration, channel, url] = l.split('\t');
          return { id, title, duration: Number(duration) || null, channel, url: url && url !== 'NA' ? url : `https://www.youtube.com/watch?v=${id}` };
        }));
      });
    });
  }

  list() { return [...this.jobs.values()].filter((j) => !(j.status === 'error' && Date.now() - j.startedAt > 30000)).sort((a, b) => b.n - a.n).slice(0, 30); }

  /** start a download job; input is a URL or a free-text search (first hit is taken) */
  start(input, { playlist = false, max = 25 } = {}) {
    const n = ++this.seq;
    const job = { id: `dl${n}`, n, input, status: 'starting', progress: 0, files: [], error: null, startedAt: Date.now(), log: [] };
    this.jobs.set(job.id, job);
    job.done = (async () => {
      let last;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { return await this.run(job, { playlist, max, attempt }); }
        catch (e) { last = e; if (!/403|Forbidden|unavailable|Unable to|HTTP Error/i.test(e.message)) break; job.status = 'retrying'; this.emitJob(job); }
      }
      throw last;
    })().catch((e) => { job.status = 'error'; job.error = e.message; this.emitJob(job); return job; });
    this.emitJob(job);
    return job;
  }

  emitJob(job) { const { done, log, ...pub } = job; this.onEvent({ type: 'job', job: pub }); }

  async run(job, { playlist, max, attempt = 0 }) {
    const bin = await this.ensure();
    fs.mkdirSync(this.downloadDir, { recursive: true });
    const isUrl = /^https?:\/\//.test(job.input);
    // retries: same URL again, or the next search result
    const src = isUrl ? job.input : `ytsearch${attempt + 1}:${job.input}`;
    const args = [
      ...(!isUrl && attempt ? ['--playlist-items', String(attempt + 1)] : []),
      ...this.baseArgs(),
      playlist ? '--yes-playlist' : '--no-playlist',
      ...(playlist ? ['--playlist-end', String(max)] : []),
      '-x', '--audio-format', 'mp3', '--audio-quality', '0',
      // "Artist - Title | Genre | Channel stuff (Official Video)" -> artist + clean title
      '--parse-metadata', 'title:(?P<artist>.+?)\\s+[-–]\\s+(?P<title>.+)',
      '--replace-in-metadata', 'title', '\\s*[|｜].*$', '',
      '--replace-in-metadata', 'title', '\\s*[\\(\\[](Official|Lyric|Audio|HD|HQ|Music Video|Video|Visuali[sz]er)[^\\)\\]]*[\\)\\]]', '',
      '--embed-metadata',
      '--windows-filenames',
      '--newline', '--progress',
      '-o', path.join(this.downloadDir, '%(artist,uploader)s - %(title)s [%(id)s].%(ext)s'),
      '--print', 'after_move:filepath',
      src,
    ];
    job.status = 'downloading'; this.emitJob(job);
    await new Promise((resolve, reject) => {
      const p = spawn(bin, args, { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
      let buf = '', err = '';
      p.stdout.on('data', (c) => {
        buf += c;
        const lines = buf.split(/\r?\n/); buf = lines.pop();
        for (const l of lines) this.line(job, l);
      });
      p.stderr.on('data', (c) => { err += c; for (const l of String(c).split(/\r?\n/)) if (l.includes('[download]')) this.line(job, l); });
      p.on('error', reject);
      p.on('close', (code) => {
        if (buf) this.line(job, buf);
        if (code !== 0 && !job.files.length) reject(new Error(err.trim().split(/\r?\n/).slice(-2).join(' ') || `yt-dlp exited ${code}`));
        else resolve();
      });
    });
    if (!job.files.length) {
      // fallback: anything new in the download folder since the job started
      for (const f of fs.readdirSync(this.downloadDir)) {
        const p = path.join(this.downloadDir, f);
        if (/\.(mp3|m4a|opus|webm|wav|flac)$/i.test(f) && fs.statSync(p).mtimeMs >= job.startedAt - 2000) job.files.push(p);
      }
    }
    if (!job.files.length) throw new Error('download finished but no audio file was found');
    job.status = 'downloaded'; job.progress = 1; this.emitJob(job);
    return job;
  }

  line(job, l) {
    job.log.push(l); if (job.log.length > 50) job.log.shift();
    const m = /\[download\]\s+([\d.]+)%/.exec(l);
    if (m) { const p = Number(m[1]) / 100; if (p - job.progress > 0.05 || p === 1) { job.progress = p; this.emitJob(job); } return; }
    const t = l.trim();
    if (t && !t.startsWith('[') && fs.existsSync(t)) { job.files.push(t); this.emitJob(job); }
  }
}
