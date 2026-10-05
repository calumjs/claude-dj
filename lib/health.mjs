// Health report for /api/health and the /health page.
// Built from state the server already holds in memory, so polling it costs nothing during a set.
// The only I/O is looking for the external tools on PATH: async, no child process, cached.
import fs from 'node:fs';
import path from 'node:path';

const EXTS = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
const TOOL_TTL_MS = 60000;
const STALE_SEC = 5; // same threshold as liveState().engine.stale

async function onPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of EXTS) {
      try { await fs.promises.access(path.join(dir, name + ext)); return true; } catch { /* not here */ }
    }
  }
  return false;
}

const toolCache = new Map(); // name -> { at, found: Promise<boolean> }
/** is `name` runnable? `extra` = a known install path outside PATH (the auto-installed yt-dlp) */
export function hasTool(name, extra = null) {
  const hit = toolCache.get(name);
  if (hit && Date.now() - hit.at < TOOL_TTL_MS) return hit.found;
  const found = (extra ? fs.promises.access(extra).then(() => true, () => false) : Promise.resolve(false)).then((ok) => ok || onPath(name));
  toolCache.set(name, { at: Date.now(), found });
  return found;
}

const dur = (s) => (s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

/**
 * engine: { connected, started, ageSec }   (ageSec = seconds since the last engine state, null if none yet)
 * library: library.status()
 * stems: { enabled, available, queued, running, failed }
 * tools: { ffmpeg, ffprobe, ytdlp } booleans
 */
export function healthReport({ uptimeSec, port, engine, library, stems, tools }) {
  const fresh = engine.ageSec != null && engine.ageSec <= STALE_SEC;
  const systems = [
    { id: 'server', group: 'Server', name: 'DJ server', ok: true, detail: `up ${dur(uptimeSec)} on port ${port}` },
    { id: 'engine-tab', group: 'Audio engine', name: 'Engine tab', ok: engine.connected, detail: engine.connected ? 'browser tab connected' : 'no browser tab is the sound system' },
    { id: 'engine-audio', group: 'Audio engine', name: 'Audio context', ok: engine.connected && engine.started, detail: !engine.connected ? 'no engine' : engine.started ? 'running' : 'suspended (click "Start engine")' },
    { id: 'engine-heartbeat', group: 'Audio engine', name: 'State heartbeat', ok: engine.connected && fresh, detail: engine.ageSec == null ? 'no state received yet' : `last state ${engine.ageSec.toFixed(1)}s ago` },
    { id: 'library', group: 'Library', name: 'Track library', ok: library.tracks > 0, detail: `${library.tracks} tracks` + (library.analyzing || library.queued ? `, ${library.analyzing + library.queued} to analyse` : '') },
    { id: 'stems', group: 'Library', name: 'Stem separation', ok: !stems.enabled || (stems.available && !stems.failed),
      detail: !stems.enabled ? 'disabled in config' : !stems.available ? 'no .venv python with demucs' : stems.failed ? `${stems.failed} track(s) failed` : stems.running ? `separating, ${stems.queued} queued` : 'idle' },
    { id: 'ffmpeg', group: 'Tools', name: 'ffmpeg', ok: tools.ffmpeg, detail: tools.ffmpeg ? 'on PATH' : 'not found on PATH' },
    { id: 'ffprobe', group: 'Tools', name: 'ffprobe', ok: tools.ffprobe, detail: tools.ffprobe ? 'on PATH' : 'not found on PATH' },
    { id: 'ytdlp', group: 'Tools', name: 'yt-dlp', ok: tools.ytdlp, detail: tools.ytdlp ? 'installed' : 'not installed (auto-installs on first download)' },
  ];
  const engineOk = engine.connected && engine.started && fresh;
  const text = engineOk ? 'engine live' : !engine.connected ? 'engine offline' : !engine.started ? 'engine suspended' : 'engine stale';
  return { ok: systems.every((s) => s.ok), ts: Date.now(), engine: { ok: engineOk, text }, systems };
}
