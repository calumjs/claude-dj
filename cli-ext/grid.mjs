// Track structure + cue commands:
//   track <id>                         full analysis incl. grid drift, sections, hot cues, saved loops
//   sections <id>                      labelled structure (intro/verse/chorus/build/drop/breakdown/outro)
//   grid <id> [--shift beats] [--nudge ms] [--bpm x] [--reset]    beat-grid check / manual correction
//   hotcue <deck> [list] | set <n> [bar:N|sec] [--label x] [--exact] | <n> | clear <n> | reset <n>
//   savedloop <deck> [list] | set <name> [beats] [--at bar:N|sec] | <name> | delete <name>
export default ({ api, control, flags, rest, deckArg, fail, out, report, fmtTrack, mmss, JSON_OUT }) => {
  const getTrack = async (q) => {
    if (!q) fail('usage: dj track <id|search>');
    const t = await api('/api/track/' + encodeURIComponent(q));
    if (!t || t.error) fail(t?.error || `No track matches "${q}"`);
    return t;
  };
  const bars = (s) => `bar ${String(s.startBar).padStart(3)}–${String(s.endBar).padEnd(3)}`;
  const sectionLines = (t) => (t.sections || []).map((s) => `  ${s.label.padEnd(9)} ${bars(s)}  ${mmss(s.start)}–${mmss(s.end)}  (${s.endBar - s.startBar + 1} bars)`);
  const gridLine = (t) => `  grid ${t.gridStable == null ? 'not checked yet (backfill pending)' : t.gridStable ? `stable (drift ${t.drift} ms)` : `DRIFTS up to ${t.drift} ms — beatMap has ${t.beatMap?.length} tempo segments; long blends may flam`}${t.gridEdit ? `  · manual edit ${JSON.stringify(t.gridEdit)} (detected ${t.gridDetected?.bpm ?? '?'} BPM @ ${t.gridDetected?.firstBeat ?? '?'}s)` : ''}`;
  const cueLines = (c) => [
    ...Object.entries(c?.hotcues || {}).map(([n, x]) => `  hot cue ${n}  bar ${String(x.bar ?? '?').padStart(3)}  ${mmss(x.sec)}  ${x.label || ''}${x.auto ? ' (auto)' : ''}`),
    ...Object.entries(c?.loops || {}).map(([n, l]) => `  loop "${n}"  ${l.beats} beats from bar ${l.bar}  (${mmss(l.start)})`),
  ];

  return {
    async track() {
      const t = await getTrack(rest.join(' '));
      const { waveform, ...info } = t;
      if (JSON_OUT) return out(info);
      console.log(fmtTrack(t));
      console.log(`  key ${t.key} (${t.camelot}, confidence ${t.keyConfidence})  bpm confidence ${t.bpmConfidence}  loudness ${t.rmsDb} dB (gain ${t.gainDb})`);
      // all bar numbers 1-based, same as bar:N in seek/cue/--in
      console.log(`  bars ${t.bars}  bar 1 (downbeat) at ${t.firstBeat}s  groove from bar ${t.introEndBar + 1} (${mmss(t.introEnd)})  outro/mix-out bar ${t.outroStartBar + 1} (${mmss(t.mixOut)})`);
      console.log(gridLine(t));
      for (const b of t.breakdowns || []) console.log(`  breakdown bars ${b.startBar + 1}-${b.endBar}  (${mmss(b.start)} → drop at bar ${b.endBar + 1}, ${mmss(b.drop)})`);
      console.log(`  energy by 8-bar phrase: ${(t.phraseEnergy || []).map((e) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor(e * 8))]).join('')}`);
      if (t.sections?.length) { console.log('  sections:'); console.log(sectionLines(t).map((l) => '  ' + l).join('\n')); }
      if (t.vocalSections) console.log(`  vocals ${Math.round((t.vocalPct || 0) * 100)}%: ${t.vocalSections.slice(0, 6).map((s) => `bar ${s.startBar}–${s.endBar}`).join(', ')}${t.vocalSections.length > 6 ? ' …' : ''}  (dj vocals ${t.id})`);
      const cl = cueLines(t.cues);
      if (cl.length) console.log(cl.join('\n'));
      console.log(`  file ${t.file}`);
    },

    async sections() {
      const t = await getTrack(rest.join(' '));
      if (JSON_OUT) return out({ id: t.id, sections: t.sections, breakdowns: t.breakdowns, vocalSections: t.vocalSections, bars: t.bars });
      console.log(fmtTrack(t));
      if (!t.sections?.length) return console.log('  no section labels yet (analysis backfill runs in the background after a server restart)');
      console.log(sectionLines(t).join('\n'));
      if (!t.vocalSections) console.log('  (no vocal map yet: verse/chorus come from energy + repetition only; run dj stems ' + t.id + ')');
    },

    async grid() {
      const q = rest.join(' ');
      if (!q) fail('usage: dj grid <id> [--shift <beats>] [--nudge <ms>] [--bpm <x>] [--reset]');
      const edit = flags.shift != null || flags.nudge != null || flags.bpm != null || flags.reset;
      if (!edit) {
        const t = await getTrack(q);
        if (JSON_OUT) return out({ id: t.id, bpm: t.bpm, firstBeat: t.firstBeat, gridStable: t.gridStable, drift: t.drift, beatMap: t.beatMap, gridEdit: t.gridEdit, gridDetected: t.gridDetected });
        console.log(fmtTrack(t));
        console.log(`  ${t.bpm} BPM, downbeat (bar 1) at ${t.firstBeat}s`);
        console.log(gridLine(t));
        if (t.beatMap?.length > 1) for (const s of t.beatMap.slice(0, 12)) console.log(`    from bar ${s.startBeat / 4 + 1}: ${s.bpm} BPM @ ${mmss(s.time)}`);
        return;
      }
      const r = await api('/api/grid', { id: q, shift: flags.shift != null ? Number(flags.shift) : undefined, nudge: flags.nudge != null ? Number(flags.nudge) : undefined, bpm: flags.bpm != null ? Number(flags.bpm) : undefined, reset: !!flags.reset });
      if (JSON_OUT) return out(r);
      if (!r.ok) fail(r.error);
      const t = r.track;
      console.log(`✓ ${t.title}: ${r.before.bpm} BPM @ ${r.before.firstBeat}s → ${t.bpm} BPM @ ${t.firstBeat}s  (bars ${t.bars}, intro ends bar ${t.introEndBar}, mix-out ${mmss(t.mixOut)}, ${t.breakdowns?.length || 0} breakdowns, ${t.sections?.length || 0} sections)`);
      if (r.note) console.log('  ⚠ ' + r.note);
    },

    async hotcue() {
      const deck = deckArg(rest[0]);
      const a = rest[1] ?? 'list';
      let body;
      if (a === 'list') body = { deck, action: 'list' };
      else if (a === 'set') { if (!rest[2]) fail('usage: dj hotcue <deck> set <1-8> [bar:N|sec]'); body = { deck, action: 'set', n: Number(rest[2]), position: rest[3], label: flags.label, exact: !!flags.exact }; }
      else if (a === 'clear' || a === 'reset') body = { deck, action: a, n: Number(rest[2]) };
      else if (/^[1-8]$/.test(a)) body = { deck, action: 'jump', n: Number(a) };
      else fail('usage: dj hotcue <deck> [list] | set <1-8> [bar:N|sec] | <1-8> | clear <n> | reset <n>');
      const r = await api('/api/hotcue', { ...body, why: flags.why });
      if (body.action === 'list') {
        if (JSON_OUT) return out(r);
        if (r.ok === false) fail(r.error);
        console.log(`${r.result.deck}: ${r.result.title}`);
        const cl = cueLines(r.result);
        return console.log(cl.length ? cl.join('\n') : '  (no cues)');
      }
      return report(r);
    },

    async savedloop() {
      const deck = deckArg(rest[0]);
      const a = rest[1] ?? 'list';
      let body;
      if (a === 'list') body = { deck, action: 'list' };
      else if (a === 'set') { if (!rest[2]) fail('usage: dj savedloop <deck> set <name> [beats] [--at bar:N|sec]'); body = { deck, action: 'set', name: rest[2], beats: rest[3] != null ? Number(rest[3]) : undefined, position: flags.at }; }
      else if (a === 'delete' || a === 'rm') body = { deck, action: 'delete', name: rest[2] };
      else body = { deck, action: 'jump', name: a };
      const r = await api('/api/savedloop', { ...body, why: flags.why });
      if (body.action === 'list') {
        if (JSON_OUT) return out(r);
        if (r.ok === false) fail(r.error);
        const l = Object.entries(r.result.loops || {});
        return console.log(l.length ? l.map(([n, x]) => `  "${n}"  ${x.beats} beats from bar ${x.bar} (${mmss(x.start)})`).join('\n') : '  (no saved loops on this track)');
      }
      return report(r);
    },
  };
};
