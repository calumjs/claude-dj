// Reconcile a recorded session: find silences / audio-clock stalls / telemetry gaps and
// line them up against the DJ's timestamped actions.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const hms = (t) => new Date(t).toLocaleTimeString([], { hour12: false }) + '.' + String(t % 1000).padStart(3, '0').slice(0, 1);

function micLevels(file, fps = 10) {
  return new Promise((resolve) => {
    if (!fs.existsSync(file)) return resolve(null);
    const sr = 8000, hop = sr / fps;
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(sr), '-f', 'f32le', 'pipe:1'], { windowsHide: true });
    const chunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('error', () => resolve(null));
    ff.on('close', () => {
      const b = Buffer.concat(chunks);
      if (b.length < 4) return resolve(null);
      const ab = new ArrayBuffer(b.length - (b.length % 4)); new Uint8Array(ab).set(b.subarray(0, ab.byteLength));
      const x = new Float32Array(ab), out = [];
      for (let i = 0; i + hop <= x.length; i += hop) { let e = 0; for (let j = i; j < i + hop; j++) e += x[j] * x[j]; out.push(10 * Math.log10(e / hop + 1e-12)); }
      resolve(out);
    });
  });
}

/** merge consecutive flagged samples into [start,end] ranges */
function ranges(samples, flag, minMs, gapMs = 450) {
  const out = []; let cur = null;
  for (const s of samples) {
    if (flag(s)) { if (cur && s.t - cur.end <= gapMs) cur.end = s.t; else { if (cur) out.push(cur); cur = { start: s.t, end: s.t }; } }
  }
  if (cur) out.push(cur);
  return out.filter((r) => r.end - r.start >= minMs);
}

export async function buildReport(dir) {
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  const tel = readJsonl(path.join(dir, 'telemetry.jsonl')).sort((a, b) => a.t - b.t);
  const actions = readJsonl(path.join(dir, 'actions.jsonl'));
  const chunks = readJsonl(path.join(dir, 'audio-chunks.jsonl'));
  const critiques = readJsonl(path.join(dir, 'critiques.jsonl'));
  const plan = readJsonl(path.join(dir, 'plan.jsonl'));
  const events = [];

  // 1) audio clock stalls: ctx time advanced less than wall time
  for (let i = 1; i < tel.length; i++) {
    const a = tel[i - 1], b = tel[i];
    const wall = (b.t - a.t) / 1000, ctx = b.ct - a.ct;
    if (wall - ctx > 0.25) events.push({ kind: 'AUDIO-CLOCK STALL', start: a.t, end: b.t, detail: `audio clock advanced ${ctx.toFixed(2)}s in ${wall.toFixed(2)}s of wall time (tab hidden=${b.hid}, state=${b.st})` });
    else if (wall > 1.2) events.push({ kind: 'ENGINE UNRESPONSIVE', start: a.t, end: b.t, detail: `no telemetry for ${wall.toFixed(1)}s (main thread blocked or throttled, hidden=${b.hid})` });
  }
  // 2) engine output silent while something should be audible
  // every deck present in the sample (A–D; C/D only appear once loaded)
  const deckSamples = (s) => ['A', 'B', 'C', 'D'].map((k) => s[k]).filter((d) => d && typeof d === 'object');
  const expectSound = (s) => deckSamples(s).some((d) => d.on && d.a > 0.3);
  for (const r of ranges(tel, (s) => s.lvl < -40 && expectSound(s), 400)) events.push({ kind: 'ENGINE OUTPUT SILENT', ...r, detail: 'master output below -40 dBFS while a deck was playing and audible' });
  for (const r of ranges(tel, (s) => !deckSamples(s).some((d) => d.on), 300)) events.push({ kind: 'NOTHING PLAYING', ...r, detail: 'all decks stopped' });
  // 3) mic (what actually came out of the speakers)
  const mic = await micLevels(path.join(dir, 'capture.mp4'));
  let micInfo = 'no mic capture';
  if (mic && mic.length) {
    const sorted = [...mic].sort((a, b) => a - b), floor = sorted[Math.floor(sorted.length * 0.05)], loud = sorted[Math.floor(sorted.length * 0.6)];
    const thr = floor + (loud - floor) * 0.25;
    micInfo = `mic floor ${floor.toFixed(1)} dB, typical ${loud.toFixed(1)} dB, silence threshold ${thr.toFixed(1)} dB`;
    const t0 = info.captureStartedAt || info.startedAt;
    const ms = mic.map((v, i) => ({ t: t0 + i * 100, v }));
    for (const r of ranges(ms, (s) => s.v < thr, 600, 250)) events.push({ kind: 'SPEAKERS QUIET (mic)', ...r, detail: `room audio dropped to the noise floor (${micInfo.split(',')[0]})` });
  }
  // 4) gaps in the engine audio stream
  for (let i = 1; i < chunks.length; i++) if (chunks[i].ts - chunks[i - 1].ts > 1800) events.push({ kind: 'RECORDER GAP', start: chunks[i - 1].ts, end: chunks[i].ts, detail: `no audio chunk for ${((chunks[i].ts - chunks[i - 1].ts) / 1000).toFixed(1)}s` });

  events.sort((a, b) => a.start - b.start);
  const near = (e) => actions.filter((a) => a.ts >= e.start - 4000 && a.ts <= e.end + 1000);
  const lines = [];
  lines.push(`# Session ${info.id}`);
  lines.push(`Duration ${(((info.stoppedAt || Date.now()) - info.startedAt) / 1000).toFixed(0)}s · ${actions.length} actions · ${tel.length} telemetry samples · ${chunks.length} audio chunks · ${micInfo}`);
  lines.push('');
  const kinds = {}; for (const e of events) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  lines.push('## Summary');
  lines.push(Object.keys(kinds).length ? Object.entries(kinds).map(([k, n]) => `- ${k}: ${n}`).join('\n') : '- No silences or stalls detected.');
  const slow = actions.filter((a) => a.ackMs > 1500);
  if (slow.length) lines.push(`- Slow engine acks (>1.5 s): ${slow.map((a) => `${a.cmd} ${a.ackMs}ms @ ${hms(a.ts)}`).join(', ')}`);
  lines.push('');
  lines.push('## Events (with actions in the 4 s before)');
  for (const e of events) {
    lines.push(`- **${e.kind}** ${hms(e.start)} → ${hms(e.end)} (${((e.end - e.start) / 1000).toFixed(1)}s): ${e.detail}`);
    for (const a of near(e)) lines.push(`    - ${hms(a.ts)} \`${a.cmd}\` ${JSON.stringify(a.args)} ack ${a.ackMs}ms${a.ok ? '' : ' FAILED ' + a.error}`);
  }
  lines.push('');
  lines.push('## Transition critiques (mix monitor)');
  if (!critiques.length) lines.push('- none recorded (no transitions finished while recording, or monitor off)');
  for (const c of critiques) lines.push(`- ${hms(c.ts)} ${c.verdict === 'clean' ? '✓' : '⚠'} ${c.text.replace(/^🧐 /, '')}${c.checked ? ` [checked: ${c.checked.join(', ')}]` : ''}`);
  if (plan.length) {
    lines.push('');
    lines.push('## Plan steps fired');
    for (const p of plan) lines.push(`- ${hms(p.ts)} ${p.id} ${p.status}${p.late ? ' (late)' : ''}: ${p.cmd} when ${JSON.stringify(p.when)}${p.why ? ' — ' + p.why : ''}${p.error ? ' — ' + p.error : ''}`);
  }
  lines.push('');
  lines.push('## Action timeline');
  for (const a of actions) lines.push(`- ${hms(a.ts)} \`${a.cmd}\` ${JSON.stringify(a.args)} (ack ${a.ackMs}ms)${a.why ? ' — ' + a.why : ''}`);
  const md = lines.join('\n');
  fs.writeFileSync(path.join(dir, 'report.md'), md);
  return md;
}
