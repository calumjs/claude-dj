// dj CLI extension: the chop keyboard.
//   dj keys                                   state
//   dj keys grab <deck> [--beats 1] [--stem vocals|mix|drums|bass|other] [--pad 7] [--from bar:N.5|<sec>]
//   dj keys note <semis> [--at now|beat|bar] [--pad 7] [--gain 1]
//   dj keys loop rec|play|stop|clear [--bars 4]
//   dj keys set [--pad n] [--quant off|16|beat] [--octave -2..2] [--hold on|off]
export default ({ api, flags, rest, fail, out, JSON_OUT }) => {
  const send = async (args) => { const r = await api('/api/cmd', { cmd: 'keys', args, why: flags.why }); if (JSON_OUT) return out(r); if (!r.ok) return fail(r.error || 'keys failed'); const k = r.result?.keys; console.log(`🎹 pad ${k?.pad} · oct ${k?.octave} · quant ${k?.quant} · loop ${k?.loop?.on ? (k.loop.rec ? 'REC' : 'playing') : 'off'} (${k?.loop?.bars} bars, ${k?.loop?.events} notes)${r.result?.name ? ` · grabbed ${r.result.name}` : ''}${r.result?.note != null ? ` · note ${r.result.note} in ${r.result.startsInSec}s` : ''}`); return r; };
  const common = () => ({ ...(flags.pad != null ? { pad: Number(flags.pad) } : {}), ...(flags.quant ? { quant: String(flags.quant) } : {}), ...(flags.octave != null ? { octave: Number(flags.octave) } : {}), ...(flags.hold != null ? { hold: flags.hold } : {}) });
  return {
    async keys() {
      const sub = rest[0];
      if (!sub) return send(common());
      if (sub === 'grab') { if (!rest[1]) return fail('usage: dj keys grab <deck> [--beats 1] [--stem vocals|mix]'); return send({ ...common(), grab: String(rest[1]).toUpperCase(), beats: flags.beats != null ? Number(flags.beats) : 1, stem: flags.stem && flags.stem !== 'mix' ? String(flags.stem) : null, from: flags.from != null ? String(flags.from) : null }); }
      if (sub === 'note') { if (rest[1] == null) return fail('usage: dj keys note <semis> [--at beat]'); return send({ ...common(), note: Number(rest[1]), at: flags.at || undefined, gain: flags.gain != null ? Number(flags.gain) : undefined }); }
      if (sub === 'loop') { if (!['rec', 'play', 'stop', 'clear'].includes(rest[1])) return fail('usage: dj keys loop rec|play|stop|clear [--bars 4]'); return send({ ...common(), loop: rest[1], bars: flags.bars != null ? Number(flags.bars) : undefined }); }
      if (sub === 'set') return send(common());
      return fail(`unknown: dj keys ${sub}`);
    },
  };
};
