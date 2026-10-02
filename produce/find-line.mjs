// Search the indexed speech sentences by regex: node produce/find-line.mjs "<regex>" [--max 40] [--dur 0.5-3] [--speaker Name]
// Prints `dur kind speaker clipId from | text`. The exact `text` is what song plans (featured[], script[].text) must match.
import fs from 'node:fs';
const SENT = JSON.parse(fs.readFileSync('.dj/voice/sentences.json', 'utf8'));
const CUR = fs.existsSync('.dj/voice/lines.json') ? JSON.parse(fs.readFileSync('.dj/voice/lines.json', 'utf8')) : [];
const args = process.argv.slice(2); const re = new RegExp(args.find((a) => !a.startsWith('--')) || '.', 'i');
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const max = Number(opt('--max', 40)); const [dmin, dmax] = String(opt('--dur', '0-99')).split('-').map(Number); const sp = opt('--speaker', null);
const seen = new Set(); let n = 0;
for (const l of [...CUR.map((l) => ({ ...l, kind: l.kind || 'cur' })), ...SENT]) {
  if (!re.test(l.text) || l.dur < dmin || l.dur > dmax || (sp && !String(l.speaker || '').toLowerCase().includes(sp.toLowerCase()))) continue;
  const k = l.text.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim(); if (seen.has(k)) continue; seen.add(k);
  console.log(`${l.dur.toFixed(1)}s ${String(l.kind || '').padEnd(9)} ${String(l.speaker || '').slice(0, 14).padEnd(14)} ${l.id} ${String(l.from).padStart(7)} | ${l.text}`);
  if (++n >= max) break;
}
console.log(`(${n} shown)`);
