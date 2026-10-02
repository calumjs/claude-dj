// Stems + vocal map commands.
//   dj stems [id|search|all]   queue separation (default: all)      dj stems status
//   dj vocals <id|search>      where the vocals are, in bars and times
export default ({ api, flags, rest, fail, out, fmtTrack, mmss, JSON_OUT }) => ({
  async stems() {
    const target = rest.join(' ').trim() || 'all';
    if (target === 'status') {
      const s = await api('/api/stems');
      if (JSON_OUT) return out(s);
      if (!s.available) console.log('⚠ separator unavailable (no .venv python / demucs)');
      console.log(`Stems: ${s.done}/${s.total} tracks done  (${s.model}, ${s.threads} threads${s.enabled ? '' : ', DISABLED'})  free disk ${s.freeGB ?? '?'} GB`);
      if (s.mode) console.log(`  mode ${s.mode === 'throttled' ? 'THROTTLED (music playing: 1 job × 2 threads)' : 'full speed'}  — up to ${s.maxJobs} job(s) × ${s.jobThreads} threads now (config: ${s.concurrency} × ${s.threads})`);
      for (const j of s.jobs || (s.running ? [s.running] : [])) console.log(`  ▶ separating ${j.id} ${j.title}  ${Math.round(j.progress * 100)}%  (${mmss(j.elapsedSec)} elapsed${j.threads ? ', ' + j.threads + ' threads' : ''})`);
      if (s.queued.length) console.log(`  ${s.queued.length} queued: ${s.queued.slice(0, 8).join(' ')}${s.queued.length > 8 ? ' …' : ''}`);
      if (s.secsPerTrackSec) console.log(`  speed ≈ ${s.secsPerTrackSec}× real time (${mmss(s.secsPerTrackSec * 240)} for a 4 min track)`);
      for (const [id, e] of Object.entries(s.failed || {})) console.log(`  ✗ ${id}: ${e}`);
      return;
    }
    const r = await api('/api/stems', { id: target });
    if (JSON_OUT) return out(r);
    if (r.ok === false) fail(r.error);
    if (target === 'all') console.log(`✓ ${r.queued} queued, ${r.ready} already done (of ${r.total})`);
    else console.log(`✓ ${r.id} ${r.artist ? r.artist + ' - ' : ''}${r.title}: ${r.status}${r.progress != null ? ' ' + Math.round(r.progress * 100) + '%' : ''}`);
  },

  async vocals() {
    const q = rest.join(' ').trim();
    if (!q) fail('usage: dj vocals <id|search>');
    const t = await api(`/api/track/${encodeURIComponent(q)}`);
    if (!t || t.error) {
      const lib = await api(`/api/library?q=${encodeURIComponent(q)}&limit=1`);
      if (!lib.tracks?.length) fail(`No track matches "${q}"`);
      return commandsVocals(await api(`/api/track/${lib.tracks[0].id}`));
    }
    return commandsVocals(t);

    function commandsVocals(tr) {
      const { waveform, ...slim } = tr;
      if (JSON_OUT) return out({ id: tr.id, vocalPct: tr.vocalPct, vocalSections: tr.vocalSections, audioStart: tr.audioStart, audioEnd: tr.audioEnd });
      console.log(fmtTrack(slim));
      if (!tr.vocalSections) return console.log('  no vocal map yet (stems not separated). Run: dj stems ' + tr.id);
      console.log(`  vocals ${Math.round((tr.vocalPct || 0) * 100)}% of the track, ${tr.vocalSections.length} section(s)${tr.audioEnd != null ? `; audible ${mmss(tr.audioStart)}–${mmss(tr.audioEnd)}` : ''}`);
      if (!tr.vocalSections.length) console.log('  instrumental: no vocals detected');
      for (const s of tr.vocalSections) {
        console.log(`  bar ${String(s.startBar ?? '?').padStart(3)}–${String(s.endBar ?? '?').padEnd(3)}  ${mmss(s.start)}–${mmss(s.end)}  (${(s.end - s.start).toFixed(0)}s)`);
      }
      // instrumental gaps are the safe places to lay another track's vocals
      const gaps = [];
      let prev = tr.audioStart ?? 0, prevBar = 1;
      for (const s of tr.vocalSections) { if (s.start - prev >= 8) gaps.push([prev, s.start, prevBar, (s.startBar ?? 1) - 1]); prev = s.end; prevBar = (s.endBar ?? 0) + 1; }
      const end = tr.audioEnd ?? tr.duration;
      if (end - prev >= 8) gaps.push([prev, end, prevBar, null]);
      if (gaps.length && tr.vocalSections.length) console.log(`  instrumental: ${gaps.map(([a, b, ba, bb]) => `bar ${ba}${bb ? '–' + bb : '+'} (${mmss(a)}–${mmss(b)})`).join(', ')}`);
      if (flags.verbose) out(slim);
    }
  },
});
