// Set automation + ears:
//   plan add '<json>' | plan show | plan clear [--all] | plan rm <id>     timeline sequencer
//   queue add <id|search>… | queue show | queue clear | queue rm <n>      track queue
//   autodj [on|off] [--lead 45]                                          auto-DJ safety net
//   monitor [--watch N]                                                   mix monitor ("ears")
//   rate good|bad [note]    memory [--n 10]                              set memory
//   suggest … [--mashup] [--keylock on|off]                              key-aware suggestions
//   export [sessionId] [--format mp3|m4a]                                mix file + tracklist
import fs from 'node:fs';
import path from 'node:path';

export default ({ api, flags, rest, fail, out, fmtTrack, mmss, ROOT, JSON_OUT }) => {
  const nm = (t) => `${t?.artist ? t.artist + ' - ' : ''}${t?.title ?? '?'}`;
  const whenStr = (w) => w.at != null ? `at ${new Date(Number(w.at)).toLocaleTimeString()}`
    : w.after ? `${w.sec || 0}s after ${w.after}`
    : `${w.deck} ${w.bar != null ? 'bar ' + w.bar : w.beforeMixout != null ? w.beforeMixout + 's before mix-out' : w.beforeEnd + 's before end'}${w.track ? ' (track ' + w.track + ')' : ''}`;
  const warnLines = (m) => (m?.warnings || []).map((w) => `⚠ ${w.msg}${w.forSec ? ` (${w.forSec}s)` : ''}`);

  async function showPlan() {
    const list = await api('/api/plan');
    if (JSON_OUT) return out(list);
    if (!list.length) return console.log('(plan is empty)  add: dj plan add \'{"when":{"deck":"A","bar":65},"cmd":"mix","args":{"style":"bassswap","bars":8}}\'');
    for (const st of list) {
      const eta = st.etaSec != null ? `in ${mmss(Math.max(0, st.etaSec))}` : st.status === 'pending' ? 'waiting' : '';
      const args = Object.entries(st.args || {}).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
      console.log(`${st.id.padEnd(5)} ${st.status.padEnd(8)} ${whenStr(st.when).padEnd(28)} ${eta.padEnd(9)} ${st.cmd} ${args}${st.why ? '  — ' + st.why : ''}${st.error ? '  ✗ ' + st.error : ''}${st.late ? '  (late)' : ''}`);
    }
  }

  return {
    async plan() {
      const sub = rest[0] || 'show';
      if (sub === 'add') {
        const raw = flags.steps || rest.slice(1).join(' ');
        let steps;
        try { steps = JSON.parse(fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8') : raw); }
        catch { fail(`usage: dj plan add '{"when":{"deck":"A","bar":65},"cmd":"mix","args":{"to":"B","style":"bassswap","bars":8,"in":"drop"},"why":"…"}'  (or a JSON array / file)`); }
        const r = await api('/api/plan', { add: steps });
        if (JSON_OUT) return out(r);
        if (!r.ok) fail(r.error);
        console.log(`✓ planned ${r.added.join(', ')}`);
        return showPlan();
      }
      if (sub === 'clear') { const r = await api('/api/plan', { clear: true, all: !!flags.all }); return JSON_OUT ? out(r) : console.log(`✓ removed ${r.removed} step(s)`); }
      if (sub === 'rm' || sub === 'remove') { const r = await api('/api/plan', { remove: rest[1] }); return JSON_OUT ? out(r) : console.log(r.ok ? `✓ removed ${rest[1]}` : `✗ no step ${rest[1]}`); }
      return showPlan();
    },

    async queue() {
      const sub = rest[0] || 'show';
      if (sub === 'add') {
        const items = rest.slice(1);
        if (!items.length) fail('usage: dj queue add <id|"search">…');
        const r = await api('/api/queue', { add: items });
        if (JSON_OUT) return out(r);
        if (r.missing?.length) console.log(`✗ no match: ${r.missing.join(', ')}`);
        if (r.added?.length) console.log(`✓ queued ${r.added.length}`);
      } else if (sub === 'clear') { await api('/api/queue', { clear: true }); console.log('✓ queue cleared'); return; }
      else if (sub === 'rm' || sub === 'remove') { await api('/api/queue', { remove: Number(rest[1]) }); }
      const q = await api('/api/queue');
      if (JSON_OUT && sub === 'show') return out(q);
      if (!q.length) return console.log('(queue is empty)');
      q.forEach((t, i) => console.log(`${String(i + 1).padStart(2)}. ${t.id}  ${String(t.bpm ?? '?').padStart(6)} BPM  ${String(t.camelot || '?').padEnd(3)}  ${nm(t)}`));
    },

    async autodj() {
      const v = rest[0];
      const r = v === 'on' || v === 'off' || flags.lead ? await api('/api/autodj', { enabled: v ? v === 'on' : true, leadSec: flags.lead ? Number(flags.lead) : undefined }) : await api('/api/autodj');
      if (JSON_OUT) return out(r);
      console.log(`🤖 Auto-DJ ${r.enabled ? 'ON' : 'OFF'} — mixes the next queued/suggested track when ${r.leadSec}s of audible music are left and no mix is planned`);
      if (r.prepared) console.log(`   ready: ${r.prepared.track} on deck ${r.prepared.deck} (${r.prepared.why})`);
      if (r.last) console.log(`   last: ${new Date(r.last.ts).toLocaleTimeString()} ${r.last.from}→${r.last.to} ${r.last.style} ${r.last.bars} bars${r.last.ok ? '' : ' FAILED ' + r.last.error}`);
    },

    async monitor() {
      const show = async () => {
        const m = await api('/api/monitor');
        if (JSON_OUT) return out(m);
        if (!m.ts) return console.log('monitor: no engine state yet');
        console.log(`MONITOR  audible: ${m.audible.join(', ') || '—'}${m.transition ? `  (critiquing transition ${m.transition.style})` : ''}`);
        for (const [n, d] of Object.entries(m.decks || {})) console.log(`  ${n}  key ${d.effectiveKey ?? '?'}  section ${d.section ?? '?'}  vocals ${d.inVocal == null ? 'n/a (no vocal map)' : d.inVocal ? (d.vocalsUp ? 'SINGING' : 'in section, muted') : 'none'}  harmonic ${d.harmonic ? 'up' : 'down'}${d.lowEnergy ? '  low-energy' : ''}  audible ${d.audible}`);
        const c = m.checks || {};
        if (c.phase) console.log(`  phase ${c.phase.decks.join('/')}: ${c.phase.offsetMs == null ? 'n/a' : c.phase.offsetMs + ' ms'}  tempo diff ${c.phase.bpmDiffPct}%`);
        if (c.key) console.log(`  keys ${c.key.a} / ${c.key.b}: ${['same', 'neighbour', 'energy boost', 'CLASH'][c.key.distance] ?? '?'}`);
        if (c.peakDb != null) console.log(`  master peak ${c.peakDb} dBFS`);
        if (c.dipBars) console.log(`  low energy for ${c.dipBars} bars`);
        const w = warnLines(m);
        console.log(w.length ? w.join('\n') : '✓ no warnings');
        if (m.recent?.length) console.log(`  recent: ${m.recent.slice(-5).map((x) => `${new Date(x.ts).toLocaleTimeString()} ${x.type}`).join(' · ')}`);
      };
      const n = Number(flags.watch || 0);
      await show();
      for (let i = 1; i < n; i++) { await new Promise((r) => setTimeout(r, 1000)); console.log('—'); await show(); }
    },

    async rate() {
      const rating = rest[0];
      if (!['good', 'bad'].includes(rating)) fail('usage: dj rate good|bad [note]');
      const r = await api('/api/rate', { rating, note: rest.slice(1).join(' ') || undefined });
      if (JSON_OUT) return out(r);
      if (!r.ok) fail(r.error);
      console.log(`✓ rated ${r.entry.type} ${nm(r.entry.from)} → ${nm(r.entry.to)} ${rating}${r.entry.style ? ` (${r.entry.style} ${r.entry.bars ?? ''} bars)` : ''}`);
    },

    async memory() {
      const r = await api('/api/memory?n=' + (flags.n || 10));
      if (JSON_OUT) return out(r);
      console.log(`Set memory: ${r.total} transition(s)/mashup(s) recorded`);
      const line = (p) => `  ${p.score >= 0 ? '+' : ''}${p.score}  ${nm(p.from)} → ${nm(p.to)}  (${p.n}×${p.good ? ` 👍${p.good}` : ''}${p.bad ? ` 👎${p.bad}` : ''}${p.warnings ? ` ⚠${p.warnings}` : ''}; ${p.styles.join('/') || p.type})${p.notes.length ? ' “' + p.notes.slice(-1)[0] + '”' : ''}`;
      const top = r.pairs.filter((p) => p.score > 0).slice(0, 8), bottom = r.pairs.filter((p) => p.score < 0).slice(-8).reverse();
      console.log('TOP pairings'); console.log(top.length ? top.map(line).join('\n') : '  (none rated good yet)');
      console.log('BOTTOM pairings'); console.log(bottom.length ? bottom.map(line).join('\n') : '  (none rated bad / warned yet)');
      if (r.recent.length) {
        console.log('RECENT');
        for (const e of r.recent) console.log(`  ${new Date(e.ts).toLocaleTimeString()}  ${e.type === 'mashup' ? 'mashup' : e.style}${e.auto ? ' 🤖' : ''}  ${nm(e.from)} → ${nm(e.to)}  ${e.verdict || ''}${e.warnings?.length ? ' ⚠ ' + e.warnings.join(',') : ''}${e.rating ? ' ' + (e.rating === 'good' ? '👍' : '👎') : ''}`);
      }
    },

    // key-aware + memory-aware suggestions (replaces the core `suggest`, same flags plus --mashup / --keylock)
    async suggest() {
      const q = new URLSearchParams();
      if (flags.from || rest[0]) q.set('from', flags.from || rest[0]);
      for (const k of ['direction', 'limit', 'bpm']) if (flags[k]) q.set(k, flags[k]);
      if (flags.keylock) q.set('keylock', flags.keylock === 'off' ? '0' : '1');
      if (flags.mashup) q.set('mashup', '1');
      const r = await api('/api/suggest?' + q);
      if (JSON_OUT) return out(r);
      if (!Array.isArray(r) || !r.length) return console.log(flags.mashup ? 'No mashup pairs (needs vocal maps: dj stems status)' : 'No suggestions (is anything playing? pass --from <trackId>)');
      if (flags.mashup) {
        for (const p of r) console.log(`score ${p.score}  VOCAL ${p.vocal.id} ${nm(p.vocal)} (${p.vocal.bpm}, ${p.vocal.camelot})  over  BED ${p.bed.id} ${nm(p.bed)} (${p.bed.bpm}, ${p.bed.camelot})\n          vocal plays as ${p.effectiveKey}${p.recommendedKeyShift ? `, keyShift ${p.recommendedKeyShift > 0 ? '+' : ''}${p.recommendedKeyShift} (dj key <deck> ${p.recommendedKeyShift})` : ''}: ${p.reasons.join(', ')}`);
        return;
      }
      for (const t of r) {
        const ks = t.recommendedKeyShift ? `  → keyShift ${t.recommendedKeyShift > 0 ? '+' : ''}${t.recommendedKeyShift} (${t.shiftedKey}): dj key <deck> ${t.recommendedKeyShift}` : '';
        console.log(fmtTrack(t, `${t.effectiveKey ? `\n          plays as ${t.effectiveKey}${ks}` : ''}\n          score ${t.score}: ${t.reasons.join(', ')}`));
      }
    },

    async export() {
      const { exportSession } = await import('../lib/export.mjs');
      const root = path.join(ROOT, '.dj', 'sessions');
      if (!fs.existsSync(root)) fail('no sessions recorded yet (dj record start)');
      const id = rest[0] || fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'session.json'))).sort().pop();
      if (!id || !fs.existsSync(path.join(root, id))) fail(`no session "${id}"`);
      const format = flags.format === 'm4a' ? 'm4a' : 'mp3';
      console.log(`⏳ exporting ${id} → ${format} …`);
      let r;
      try { r = await exportSession(path.join(root, id), { format, outDir: path.join(ROOT, '.dj', 'exports'), libraryFile: path.join(ROOT, '.dj', 'library.json'), log: (s) => console.log('  ' + s) }); }
      catch (e) { fail(e.message); }
      if (JSON_OUT) return out(r);
      console.log(`✓ ${r.audio}  (${mmss(r.duration)}, ${r.tracks.length} tracks from ${r.source}${r.gaps.length ? `, ${r.gaps.length} recorder gap(s)` : ''})`);
      console.log(`  tracklist ${r.txt}\n  cue sheet ${r.cue}`);
      for (const t of r.tracks) console.log(`  ${mmss(t.at)}  ${nm(t)}`);
    },
  };
};
