// Export a flight-recorder session as a mix file + tracklist (.txt with mm:ss and a .cue sheet).
// The engine audio is a MediaRecorder WebM/Opus stream posted in ~1 s chunks. Chunk wall-clock
// timestamps + byte counts map wall time → audio time, so track changes (from telemetry, or the
// action log as a fallback) land at the right place even when the recorder has gaps (lost or
// late chunks, or a restarted recorder = several WebM headers in one file).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const cueTime = (s) => { const f = Math.round(s * 75); return `${String(Math.floor(f / 4500)).padStart(2, '0')}:${String(Math.floor((f / 75) % 60)).padStart(2, '0')}:${String(f % 75).padStart(2, '0')}`; };
const q = (s) => String(s ?? '').replace(/"/g, "'");

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (c) => { err = (err + c).slice(-20000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`${cmd} failed (${code}): ${err.trim().split(/\r?\n/).slice(-3).join(' | ')}`))));
  });
}
/** decoded duration (s) of an audio file: ffmpeg's last time= progress */
async function decodedDuration(file) {
  const err = await run('ffmpeg', ['-hide_banner', '-nostats', '-v', 'info', '-stats', '-i', file, '-vn', '-f', 'null', '-']).catch((e) => e.message);
  const m = [...String(err).matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

/** split a WebM byte stream at EBML headers (a restarted MediaRecorder starts a new file) */
function splitSegments(buf) {
  const magic = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  const at = [];
  for (let i = buf.indexOf(magic); i >= 0; i = buf.indexOf(magic, i + 1)) at.push(i);
  if (!at.length || at[0] !== 0) at.unshift(0);
  return at.map((a, k) => ({ start: a, end: k + 1 < at.length ? at[k + 1] : buf.length }));
}

/**
 * wall → audio mapping from chunks. Each chunk's audio duration is estimated from its bytes
 * (calibrated per segment against the decoded length); audio doesn't advance across wall gaps.
 */
export function buildTimeline(chunks, segments) {
  const pts = [];
  const gaps = [];
  let audio = 0, byteOff = 0, k = 0;
  for (const seg of segments) {
    const segChunks = [];
    let b = 0;
    while (k < chunks.length && byteOff + b < seg.end) { b += chunks[k].bytes; segChunks.push(chunks[k]); k++; }
    byteOff += b;
    const bps = seg.duration > 0 ? b / seg.duration : 16000;
    for (const c of segChunks) {
      const dur = c.bytes / bps;
      const wallStart = c.ts - dur * 1000;
      if (pts.length) {
        const prev = pts[pts.length - 1];
        const gap = (wallStart - prev.wall) / 1000;
        if (gap > 1.5) gaps.push({ wall: prev.wall, audio: prev.audio, sec: +gap.toFixed(1) });
      }
      pts.push({ wall: Math.max(wallStart, pts.length ? pts[pts.length - 1].wall : wallStart), audio });
      audio += dur;
      pts.push({ wall: c.ts, audio });
    }
  }
  const toAudio = (wall) => {
    if (!pts.length) return 0;
    if (wall <= pts[0].wall) return 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (wall <= b.wall) {
        if (b.audio === a.audio || b.wall === a.wall) return a.audio; // gap: audio holds
        return a.audio + ((wall - a.wall) / (b.wall - a.wall)) * (b.audio - a.audio);
      }
    }
    return pts[pts.length - 1].audio;
  };
  return { toAudio, gaps, audioLen: audio, t0: pts[0]?.wall ?? 0 };
}

/** on-air tracks from telemetry: a track counts from when it became audible, once it dominates */
export function tracksFromTelemetry(tel) {
  const out = [];
  const firstAudible = new Map(); // id -> wall ts it became audible (reset when it goes silent)
  for (const s of tel) {
    const decks = ['A', 'B', 'C', 'D'].map((k) => s[k]).filter((d) => d && typeof d === 'object' && d.id);
    for (const d of decks) {
      if (d.on && d.a > 0.05) { if (!firstAudible.has(d.id)) firstAudible.set(d.id, s.t); }
      else if (!decks.some((x) => x.id === d.id && x.on && x.a > 0.05)) firstAudible.delete(d.id);
    }
    const dom = decks.filter((d) => d.on && d.a >= 0.5).sort((a, b) => b.a - a.a)[0];
    if (!dom || (out.length && out[out.length - 1].id === dom.id)) continue;
    if (out.slice(-3).some((x) => x.id === dom.id)) continue;
    const prev = out[out.length - 1];
    const start = Math.max(firstAudible.get(dom.id) ?? s.t, prev ? prev.wall + 1000 : 0);
    out.push({ id: dom.id, wall: start });
  }
  return out;
}

function tracksFromActions(actions) {
  const out = [];
  const idOf = (a) => String(a.args?.track || '').split(' ')[0] || null;
  const deckTrack = {};
  for (const a of actions) {
    if (!a.ok) continue;
    if (a.cmd === 'load') deckTrack[a.args.deck] = idOf(a);
    if (a.cmd === 'mix') {
      if (a.args.track) deckTrack[a.args.to] = idOf(a);
      const id = deckTrack[a.args.to];
      if (id) out.push({ id, wall: a.ts + (Number(a.result?.startsInSec) || 0) * 1000 });
    }
    if (a.cmd === 'play' && !out.length && deckTrack[a.args.deck]) out.push({ id: deckTrack[a.args.deck], wall: a.ts + (Number(a.result?.startsInSec) || 0) * 1000 });
  }
  return out;
}

export async function exportSession(dir, { format = 'mp3', outDir, libraryFile, log = () => {} } = {}) {
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  const webm = path.join(dir, 'engine-audio.webm');
  if (!fs.existsSync(webm) || fs.statSync(webm).size < 1000) throw new Error('this session has no engine audio (engine-audio.webm)');
  const chunks = readJsonl(path.join(dir, 'audio-chunks.jsonl')).sort((a, b) => a.seq - b.seq);
  const tel = readJsonl(path.join(dir, 'telemetry.jsonl')).sort((a, b) => a.t - b.t);
  const actions = readJsonl(path.join(dir, 'actions.jsonl'));
  const lib = new Map();
  try { for (const t of JSON.parse(fs.readFileSync(libraryFile, 'utf8')).tracks || []) lib.set(t.id, t); } catch { /* titles from actions only */ }
  const titleFromActions = new Map();
  for (const a of actions) { const m = /^(\w{8}) (.+)$/.exec(String(a.args?.track || '')); if (m) titleFromActions.set(m[1], m[2]); }

  fs.mkdirSync(outDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'djexport-'));
  try {
    // 1) segments (one per recorder start), decoded lengths
    const buf = fs.readFileSync(webm);
    const segments = splitSegments(buf);
    for (const [i, seg] of segments.entries()) {
      seg.file = segments.length === 1 ? webm : path.join(tmp, `seg${i}.webm`);
      if (segments.length > 1) fs.writeFileSync(seg.file, buf.subarray(seg.start, seg.end));
      seg.duration = await decodedDuration(seg.file);
    }
    const good = segments.filter((s) => s.duration > 0.5);
    if (!good.length) throw new Error('engine audio could not be decoded');
    log(`decoded ${good.length} segment(s), ${good.reduce((a, s) => a + s.duration, 0).toFixed(1)} s of audio`);

    // 2) render
    const ext = format === 'm4a' ? 'm4a' : 'mp3';
    const out = path.join(outDir, `${info.id}.${ext}`);
    const codec = ext === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '320k'] : ['-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart'];
    const inputs = good.flatMap((s) => ['-i', s.file]);
    const filter = good.length > 1 ? ['-filter_complex', `${good.map((_, i) => `[${i}:a]`).join('')}concat=n=${good.length}:v=0:a=1[a]`, '-map', '[a]'] : ['-map', '0:a'];
    await run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...inputs, ...filter, '-ar', '48000', '-ac', '2', ...codec,
      '-metadata', `title=Claude DJ — ${info.id}`, '-metadata', 'artist=Claude DJ', out]);

    // 3) tracklist
    const tl = buildTimeline(chunks, segments);
    let entries = tel.length ? tracksFromTelemetry(tel) : [];
    let source = 'telemetry';
    if (!entries.length) { entries = tracksFromActions(actions); source = 'actions'; }
    const total = good.reduce((a, s) => a + s.duration, 0);
    const list = entries.map((e) => {
      const t = lib.get(e.id);
      const at = Math.max(0, Math.min(total, tl.toAudio(e.wall)));
      return { id: e.id, at: +at.toFixed(2), wall: e.wall, artist: t?.artist || null, title: t?.title || titleFromActions.get(e.id) || e.id };
    }).filter((e, i, a) => i === 0 || e.at > a[i - 1].at + 1);
    if (list.length) list[0].at = Math.min(list[0].at, 0.0) || 0;

    const name = (e) => `${e.artist ? e.artist + ' - ' : ''}${e.title}`;
    const txt = [
      `Claude DJ — session ${info.id}  (${new Date(info.startedAt).toLocaleString()})`,
      `Mix: ${path.basename(out)}  length ${mmss(total)}  · tracklist from ${source}`,
      '',
      ...list.map((e) => `${mmss(e.at)}  ${name(e)}  [${e.id}]`),
      ...(tl.gaps.length ? ['', `Recorder gaps (cut out of the mix, so later timestamps are shifted to match the audio): ${tl.gaps.map((g) => `${g.sec}s at ${mmss(g.audio)}`).join(', ')}`] : []),
      ...(segments.length > 1 ? [`Recorder restarted ${segments.length - 1}× — segments joined back to back.`] : []),
    ].join('\n') + '\n';
    const cue = [
      'PERFORMER "Claude DJ"',
      `TITLE "Claude DJ session ${info.id}"`,
      `FILE "${path.basename(out)}" ${ext === 'mp3' ? 'MP3' : 'WAVE'}`,
      ...list.flatMap((e, i) => [
        `  TRACK ${String(i + 1).padStart(2, '0')} AUDIO`,
        `    TITLE "${q(e.title)}"`,
        `    PERFORMER "${q(e.artist || 'Unknown')}"`,
        `    INDEX 01 ${cueTime(e.at)}`,
      ]),
    ].join('\n') + '\n';
    const txtFile = path.join(outDir, `${info.id}.txt`), cueFile = path.join(outDir, `${info.id}.cue`);
    fs.writeFileSync(txtFile, txt);
    fs.writeFileSync(cueFile, cue);
    return { audio: out, txt: txtFile, cue: cueFile, duration: +total.toFixed(1), tracks: list, gaps: tl.gaps, segments: segments.length, source };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
