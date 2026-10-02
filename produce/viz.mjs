// Music-reactive background for a set video: a logo pulsing on the kick (optional), spectrum bars and a waveform,
// a title card at the start and a small credit top-left.
//   node produce/viz.mjs <meta.json> <audio> <out-bg.mp4> [--logo <png>]
// meta.json: { "title": "Credit - Song", "duration": 123.4, "sections": [{ "name": "intro", "start": 0, "end": 60 }] }
// Per-frame bass energy is measured in Node and fed to ffmpeg via sendcmd (logo scale + brightness flash).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2); const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const [META, AUDIO, OUT] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const LOGO = flag('--logo');
if (!META || !AUDIO || !OUT) { console.log('usage: viz.mjs <meta.json> <audio> <out-bg.mp4> [--logo png]'); process.exit(1); }
const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
const W = 1280, H = 720, FPS = 30;
const font = (names) => { for (const n of names) { const p = `C:/Windows/Fonts/${n}`; if (fs.existsSync(p)) return p.replace(/:/g, '\\:'); } return null; };
const FONTB = process.env.VIZ_FONT_BOLD?.replace(/:/g, '\\:') || font(['impact.ttf', 'arialbd.ttf', 'arial.ttf']);
const ff = (s) => (FONTB ? `fontfile='${FONTB}':` : '');
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, '\u2019').replace(/:/g, '\\:').replace(/%/g, '％').replace(/,/g, '\\,');
const dur = meta.duration;

// 1) bass + overall envelopes per frame
const SR = 8000;
const dec = (af) => { const b = execFileSync('ffmpeg', ['-v', 'error', '-i', AUDIO, '-ac', '1', '-ar', String(SR), '-af', af, '-f', 'f32le', 'pipe:1'], { windowsHide: true, maxBuffer: 1 << 29 }); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const bass = dec('lowpass=f=140,highpass=f=35'), full = dec('highpass=f=60');
const nF = Math.ceil(dur * FPS), hop = SR / FPS;
const env = (x) => { const e = new Float32Array(nF); for (let f = 0; f < nF; f++) { let s = 0; const a = Math.floor(f * hop); for (let i = a; i < a + hop && i < x.length; i++) s += x[i] * x[i]; e[f] = Math.sqrt(s / hop); } return e; };
const eb = env(bass), ef = env(full);
// kick pulse 0..1: positive bass difference over a running max, fast attack, ~180 ms decay
const pulse = new Float32Array(nF); let run = 1e-6, p = 0;
for (let f = 0; f < nF; f++) { run = Math.max(eb[f], run * 0.995); const d = Math.max(0, eb[f] - (eb[f - 1] || 0)) / run; p = Math.max(d * 2.2, p * 0.72); pulse[f] = Math.min(1, p); }
let fm = 1e-6; for (let f = 0; f < nF; f++) fm = Math.max(fm, ef[f]);
// 2) sendcmd: logo size + brightness flash per frame
const base = 420; const cmds = [];
for (let f = 0; f < nF; f++) { const t = (f / FPS).toFixed(3); const s = Math.round(base * (1 + 0.22 * pulse[f] + 0.06 * (ef[f] / fm))); if (LOGO) cmds.push(`${t} [enter] scale@logo w ${s};`); cmds.push(`${t} [enter] eq@flash brightness ${(0.10 * pulse[f]).toFixed(3)};`); }
const cmdFile = OUT.replace(/\.mp4$/, '') + '-viz-cmds.txt';
fs.writeFileSync(cmdFile, cmds.join('\n') + '\n');
// 3) filtergraph
const secs = (meta.sections || []).filter((s) => s.end > s.start);
const hueOf = (i) => (200 + i * 47) % 360; // each section gets its own tint
const [credit, ...songParts] = String(meta.title || '').split(' - '); const song = songParts.join(' - ');
const fc = [
  `color=c=0x0b0b12:s=${W}x${H}:r=${FPS}:d=${dur.toFixed(2)}[base]`,
  `[0:a]showcqt=s=${W}x${Math.round(H * 0.42)}:fps=${FPS}:bar_g=3:sono_g=4:bar_v=9:sono_v=bar_v*a_weighting(f):tc=0.33:count=3:axis=0,format=rgba,colorchannelmixer=aa=0.55[cqt]`,
  `[0:a]showwaves=s=${W}x120:mode=cline:rate=${FPS}:colors=white@0.35:scale=sqrt[wave]`,
  `[base][cqt]overlay=x=0:y=${H}-${Math.round(H * 0.42)}:format=auto[b1]`,
  `[b1][wave]overlay=x=0:y=${H - 150}:format=auto[b2]`,
  ...secs.map((s, i) => `[b${i + 2}]hue=h=${hueOf(i)}:s=1.2:enable='between(t,${s.start.toFixed(3)},${s.end.toFixed(3)})'[b${i + 3}]`),
  `[b${secs.length + 2}]sendcmd=f='${cmdFile.replace(/\\/g, '/').replace(/:/g, '\\:')}',eq@flash=brightness=0[b9]`,
  ...(LOGO ? [
    `[1:v]format=rgba,scale@logo=w=${base}:h=-1:eval=frame,split[l1][l2]`,
    `[l2]scale=iw*1.12:-1,pad=iw*1.5:ih*1.8:(ow-iw)/2:(oh-ih)/2:color=black@0,boxblur=24:3,colorchannelmixer=aa=0.5[glow]`,
    `[b9][glow]overlay=x=(W-w)/2:y=(H-h)/2-30:format=auto:eval=frame[b9g]`,
    `[b9g][l1]overlay=x=(W-w)/2:y=(H-h)/2-30:format=auto:eval=frame[b10]`,
  ] : [`[b9]null[b10]`]),
  // title card for the first 5.5 s, then a small credit top-left
  `[b10]drawtext=${ff()}text='${esc(credit)}':fontsize=64:fontcolor=white@0.95:borderw=4:bordercolor=black@0.6:x=(w-text_w)/2:y=70:enable='between(t,0.3,5.5)',drawtext=${ff()}text='${esc(song)}':fontsize=110:fontcolor=white@0.95:borderw=4:bordercolor=black@0.6:x=(w-text_w)/2:y=${H - 190}:enable='between(t,0.3,5.5)'[b11]`,
  `[b11]drawtext=${ff()}text='${esc(meta.title || '')}':fontsize=34:fontcolor=white@0.7:x=40:y=30[bg]`,
];
const inputs = ['-i', AUDIO, ...(LOGO ? ['-loop', '1', '-i', LOGO] : [])];
execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', fc.join(';'), '-map', '[bg]', '-t', dur.toFixed(2), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', OUT], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
fs.rmSync(cmdFile, { force: true });
console.log(`→ ${OUT} (${nF} frames${LOGO ? ', logo pulse from bass onsets' : ''})`);
