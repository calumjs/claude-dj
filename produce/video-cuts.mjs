// Music video with the speakers' footage cut in at the exact moments their lines play (from .dj/video/<videoId>.mp4),
// a reactive background between lines (produce/viz.mjs output or its own), DJ-table B-roll in the gaps, burnt-in captions.
//   node produce/video-cuts.mjs <meta.json> <audio> <out.mp4> [--bg <viz.mp4>] [--screen <capture.webm> --screen-offset <sec>]
// meta.json (what produce/cut-track.mjs and align.mjs write): { title, duration, sections: [{ name, start, bpm, bars,
//   lines: [[endBar, clipId, from, dur, text]…], voices: [[startBar, clipId, from, dur, refFrom, refDur]…] }] }
// Footage: download the clip's video to .dj/video/<videoId>.mp4; the clipId → videoId mapping comes from the crate file
// name "[videoId].mp3" (how `dj get` names downloads). Lines without footage keep the background.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2); const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const [META, AUDIO, OUT] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!META || !AUDIO || !OUT) { console.log('usage: video-cuts.mjs <meta.json> <audio> <out.mp4> [--bg viz.mp4] [--screen file --screen-offset sec]'); process.exit(1); }
const BG = flag('--bg'), SCREEN = flag('--screen'), SCREEN_OFF = Number(flag('--screen-offset') || 0);
const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
const LIB = JSON.parse(fs.readFileSync('.dj/library.json', 'utf8')).tracks;
const vidOf = {}; for (const t of Object.values(LIB)) { const m = String(t.file || '').match(/\[([A-Za-z0-9_-]{11})\]\.[a-z0-9]+$/); if (m) vidOf[t.id] = m[1]; }
const W = 1280, H = 720, FPS = 30;
const font = (names) => { for (const n of names) { const p = `C:/Windows/Fonts/${n}`; if (fs.existsSync(p)) return p.replace(/:/g, '\\:'); } return null; };
const FONT = process.env.VIZ_FONT?.replace(/:/g, '\\:') || font(['bahnschrift.ttf', 'segoeui.ttf', 'arial.ttf']);
const ffont = FONT ? `fontfile='${FONT}':` : '';
const TMP = process.env.VTMP || path.join('.dj/produce/out/vtmp', path.basename(OUT).replace(/\.mp4$/, '')); fs.mkdirSync(TMP, { recursive: true });
const ff = (a) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...a], { windowsHide: true, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, '\u2019').replace(/:/g, '\\:').replace(/%/g, '％').replace(/,/g, '\\,');
const dur = meta.duration;

// 1) segments: every line and every contiguous stab group → { t, dur, id, from, text, cuts? }
const segs = [];
for (const s of meta.sections) {
  const barSec = 240 / s.bpm;
  for (const [end, id, from, d, text] of s.lines || []) segs.push({ t: s.start + (end - 1) * barSec - d, dur: d, id, from, text });
  const chops = (s.voices || []).map(([sb, id, from, d, rf, rd]) => ({ t: s.start + (sb - 1) * barSec, dur: d, id, from, rf, rd })).sort((a, b) => a.t - b.t);
  let g = null;
  for (const c of chops) {
    if (g && c.id === g.id && c.rf === g.rf && c.t - (g.t + g.dur) < 0.35) { g.dur = c.t + c.dur - g.t; g.cuts.push(c); continue; }
    if (g) segs.push(g); g = { t: c.t, dur: c.dur, id: c.id, from: c.from, rf: c.rf, rd: c.rd, cuts: [c], text: null };
  }
  if (g) segs.push(g);
}
segs.sort((a, b) => a.t - b.t);
for (let i = 1; i < segs.length; i++) if (segs[i].t < segs[i - 1].t + segs[i - 1].dur) segs[i - 1].dur = Math.max(0.2, segs[i].t - segs[i - 1].t);
console.log(`${segs.length} footage segments over ${dur.toFixed(1)} s`);

// 2) background: the visualiser's render if given, else a plain reactive spectrum with the title bug
let cur = BG && fs.existsSync(BG) ? BG : path.join(TMP, 'bg.mp4');
if (cur !== BG) {
  const secs = (meta.sections || []).filter((s) => s.bars && s.bpm);
  const fc = [
    `[0:a]showspectrum=s=${W}x${H}:mode=combined:color=intensity:scale=cbrt:slide=scroll:fscale=log:saturation=0.6[spec]`,
    `color=c=0x0b0b12:s=${W}x${H}:r=${FPS}:d=${dur.toFixed(2)}[base]`,
    `[base][spec]blend=all_mode=screen:all_opacity=0.5[b0]`,
    ...secs.map((s, i) => `[b${i}]hue=h=${(200 + i * 47) % 360}:s=1.1:enable='between(t,${s.start.toFixed(2)},${(s.start + s.bars * 240 / s.bpm).toFixed(2)})'[b${i + 1}]`),
    `[b${secs.length}]drawtext=${ffont}text='${esc(meta.title || '')}':fontsize=34:fontcolor=white@0.7:x=40:y=30[bg]`,
  ];
  ff(['-i', AUDIO, '-filter_complex', fc.join(';'), '-map', '[bg]', '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', cur]);
}

// 3) footage clips with captions (stab groups re-trigger the footage at every hit)
const clips = [];
segs.forEach((g, i) => {
  const vid = vidOf[g.id]; const src = vid ? `.dj/video/${vid}.mp4` : null;
  if (!src || !fs.existsSync(src)) return;
  const out = path.join(TMP, `seg${String(i).padStart(3, '0')}.mp4`);
  const capText = String(g.text || '').replace(/^♪\s*/, '').replace(/^[A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+)?\s*:\s*/, '');
  const cap = capText ? `,drawtext=${ffont}text='${esc(capText)}':fontsize=44:fontcolor=white:borderw=3:bordercolor=black@0.8:x=(w-text_w)/2:y=h-120` : '';
  if (g.cuts && g.cuts.length > 1) {
    const parts = g.cuts.map((c, k) => `[0:v]trim=start=${c.from.toFixed(3)}:duration=${Math.max(0.08, c.dur).toFixed(3)},setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[p${k}]`);
    const fc = parts.join(';') + ';' + g.cuts.map((_, k) => `[p${k}]`).join('') + `concat=n=${g.cuts.length}:v=1:a=0,eq=saturation=1.3:contrast=1.1[v]`;
    ff(['-i', src, '-filter_complex', fc, '-map', '[v]', '-t', g.dur.toFixed(3), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', out]);
  } else {
    ff(['-ss', Math.max(0, g.from - 0.05).toFixed(3), '-t', (g.dur + 0.1).toFixed(3), '-i', src, '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}${cap}`, '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', out]);
  }
  clips.push({ ...g, file: out });
});
console.log(`${clips.length} footage clips ready (${segs.length - clips.length} without footage)`);

// 3b) DJ-table B-roll in every gap longer than 3 s, letterboxed to fit
if (SCREEN && fs.existsSync(SCREEN)) {
  const gaps = []; let t0 = 2.5; for (const c of clips) { if (c.t - t0 > 3) gaps.push([t0, c.t]); t0 = Math.max(t0, c.t + c.dur); } if (dur - t0 > 3) gaps.push([t0, dur - 0.5]);
  const scr = path.join(TMP, 'screen.mp4');
  ff(['-ss', Math.max(0, SCREEN_OFF).toFixed(3), '-i', SCREEN, '-t', dur.toFixed(2), '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,eq=brightness=-0.06:saturation=1.1`, '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-an', scr]);
  const en = gaps.map(([a, b]) => `between(t,${a.toFixed(2)},${b.toFixed(2)})`).join('+') || '0';
  const withScreen = path.join(TMP, 'bg-screen.mp4');
  ff(['-i', cur, '-i', scr, '-filter_complex', `[1:v]format=yuva420p,colorchannelmixer=aa=0.92[s];[0:v][s]overlay=eof_action=pass:enable='${en}'[o]`, '-map', '[o]', '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', withScreen]);
  cur = withScreen; console.log(`DJ-table B-roll in ${gaps.length} gaps`);
}
// 4) assemble: overlay footage in passes of 12
for (let p = 0; p < clips.length; p += 12) {
  const batch = clips.slice(p, p + 12), next = path.join(TMP, `pass${p / 12}.mp4`);
  const inputs = ['-i', cur]; batch.forEach((c) => inputs.push('-i', c.file));
  const fc = [];
  batch.forEach((c, k) => fc.push(`[${k + 1}:v]setpts=PTS-STARTPTS+${c.t.toFixed(3)}/TB[f${k}]`));
  batch.forEach((c, k) => fc.push(`[${k === 0 ? '0:v' : 'o' + (k - 1)}][f${k}]overlay=eof_action=pass:enable='between(t,${c.t.toFixed(3)},${(c.t + c.dur).toFixed(3)})'[o${k}]`));
  ff([...inputs, '-filter_complex', fc.join(';'), '-map', `[o${batch.length - 1}]`, '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', next]);
  cur = next; console.log(`  pass ${p / 12 + 1}/${Math.ceil(clips.length / 12)}`);
}
ff(['-i', cur, '-i', AUDIO, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-shortest', OUT]);
ff(['-i', OUT, '-vf', 'scale=854:480', '-c:v', 'libx264', '-preset', 'medium', '-crf', '27', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', OUT.replace(/\.mp4$/, ' (480p).mp4')]);
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`🎬 ${OUT} (+480p)`);
