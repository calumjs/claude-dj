// Index speech clips from their YouTube caption files: every sentence and every word with timings.
//   node produce/index-captions.mjs [captionsDir]        (default .dj/voice/captions)
//   node produce/index-captions.mjs --find <words…>      exact phrase occurrences from the word index
//
// Captions: `yt-dlp --write-auto-sub --sub-lang en --skip-download -o "<dir>/sub-%(id)s" <url>` gives sub-<videoId>.en.vtt.
// Clips: the audio must be in the crate with the YouTube id in its file name, e.g. "Title [dQw4w9WgXcQ].mp3" (that is how
// `dj get` names downloads), so the index can point at a library track id. Speaker = "| Name |" in the title when present,
// or .dj/voice/clips.json { "<videoId>": { "speaker": "…" } }.
// Output: .dj/voice/sentences.json [{id, videoId, speaker, from, dur, text, kind}] and .dj/voice/words.json [{id, videoId, speaker, t, end, w}].
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const fi = args.indexOf('--find');
const DIR = (args[0] && !args[0].startsWith('--')) ? args[0] : '.dj/voice/captions';
const OUT = '.dj/voice'; fs.mkdirSync(OUT, { recursive: true });
const LIB = JSON.parse(fs.readFileSync('.dj/library.json', 'utf8')).tracks;
const extra = fs.existsSync(path.join(OUT, 'clips.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'clips.json'), 'utf8')) : {};
const byVideo = {};
for (const t of Object.values(LIB)) { const m = String(t.file || '').match(/\[([A-Za-z0-9_-]{11})\]\.[a-z0-9]+$/); if (!m) continue; const sp = String(t.title || '').match(/\|\s*([A-Z][a-z]+ [A-Z][a-zA-Z'-]+)\s*\|/); byVideo[m[1]] = { id: t.id, speaker: extra[m[1]]?.speaker || (sp ? sp[1] : '') }; }
const ts = (s) => { const m = s.match(/(\d+):(\d+):(\d+)\.(\d+)/); return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000; };
const KIND = (t) => (/\?$/.test(t) ? 'question' : /^(hey|hi|good (day|morning|afternoon)|g'day|howzit|hello)\b/i.test(t) ? 'signon' : /(signing off|see you (in|at|next)|catch you|thanks for watching|cheers)/i.test(t) ? 'signoff' : /^[^ ]+( [^ ]+){0,3}[.!]?$/.test(t) ? 'exclaim' : 'sentence');

if (fi >= 0) { // phrase finder over the existing word index
  const WORDS = JSON.parse(fs.readFileSync(path.join(OUT, 'words.json'), 'utf8'));
  const norm = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, '');
  const q = args.slice(fi + 1).join(' ').toLowerCase().replace(/[^a-z0-9' ]/g, '').split(/\s+/);
  let n = 0;
  for (let i = 0; i + q.length <= WORDS.length; i++) { let ok = true; for (let k = 0; k < q.length; k++) if (WORDS[i + k].id !== WORDS[i].id || norm(WORDS[i + k].w) !== q[k]) { ok = false; break; } if (!ok) continue; const a = WORDS[i], b = WORDS[i + q.length - 1]; n++; console.log(`${a.id} ${a.t.toFixed(2)} ${(b.end - a.t).toFixed(2)} ${(a.speaker || '').padEnd(14)} …${WORDS.slice(Math.max(0, i - 4), i + q.length + 4).map((x) => x.w).join(' ')}…`); }
  console.log(`(${n} occurrences; columns: clipId start dur speaker context)`); process.exit(0);
}

const sentences = [], words = []; let clips = 0;
for (const f of fs.readdirSync(DIR).filter((x) => /\.vtt$/.test(x))) {
  const vid = (f.match(/([A-Za-z0-9_-]{11})\.[a-z-]+\.vtt$/) || f.match(/^sub-([A-Za-z0-9_-]{11})/) || [])[1]; const meta = vid && byVideo[vid]; if (!meta) { console.log(`skip ${f}: no crate track with [${vid || '?'}] in its file name`); continue; }
  clips++;
  const txt = fs.readFileSync(path.join(DIR, f), 'utf8'); const raw = []; let cueStart = null, cueEnd = null;
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^(\d+:\d+:\d+\.\d+) --> (\d+:\d+:\d+\.\d+)/); if (m) { cueStart = ts(m[1]); cueEnd = ts(m[2]); continue; }
    if (cueStart == null || !line.includes('<c>')) continue;
    const re = /(?:<(\d+:\d+:\d+\.\d+)>)?(?:<c>)?([^<]+?)(?:<\/c>)?(?=<|$)/g; let t = cueStart, mm;
    while ((mm = re.exec(line)) !== null) { if (mm[1]) t = ts(mm[1]); const w = mm[2].trim(); if (w) raw.push({ t, w, cueEnd }); }
    cueStart = null;
  }
  const ded = []; for (const x of raw) { const p = ded[ded.length - 1]; if (p && p.t === x.t && p.w === x.w) continue; ded.push(x); }
  for (let i = 0; i < ded.length; i++) { const x = ded[i], n = ded[i + 1]; const end = n ? Math.min(n.t, x.t + 1.2) : Math.min(x.cueEnd, x.t + 0.6); words.push({ id: meta.id, videoId: vid, speaker: meta.speaker, t: +x.t.toFixed(3), end: +Math.max(x.t + 0.12, end).toFixed(3), w: x.w }); }
  // sentences: break on a gap > 0.6 s, sentence punctuation, or 14 words
  let cur = [];
  const flush = () => { if (!cur.length) return; const text = cur.map((x) => x.w).join(' ').replace(/\s+([,.!?])/g, '$1'); const from = +(cur[0].t - 0.12).toFixed(2); const last = cur[cur.length - 1]; const end = Math.min(last.cueEnd, last.t + 0.9); sentences.push({ id: meta.id, videoId: vid, speaker: meta.speaker, from, dur: +Math.max(0.4, end - from).toFixed(2), text, kind: KIND(text) }); cur = []; };
  for (let i = 0; i < ded.length; i++) { const x = ded[i]; if (cur.length && (x.t - cur[cur.length - 1].t > 0.6 || cur.length >= 14)) flush(); cur.push(x); if (/[.!?]$/.test(x.w)) flush(); }
  flush();
}
const seen = new Set(); const uniq = sentences.filter((l) => { const k = l.id + '|' + l.text.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
fs.writeFileSync(path.join(OUT, 'sentences.json'), JSON.stringify(uniq));
fs.writeFileSync(path.join(OUT, 'words.json'), JSON.stringify(words));
console.log(`${uniq.length} sentences, ${words.length} words from ${clips} clips → ${OUT}/sentences.json, words.json`);
console.log('kinds', JSON.stringify(uniq.reduce((a, l) => ((a[l.kind] = (a[l.kind] || 0) + 1), a), {})));
