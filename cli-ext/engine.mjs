// dj CLI extension: engine features (key lock / key shift, stems, 4-deck crossfader assign, sampler, deck FX, scratch).
// Loaded by the plugin hook at the bottom of dj.mjs. Every command goes through control() so it shows up
// in the booth log and the flight recorder like the built-in commands.
const STEMS = ['vocals', 'drums', 'bass', 'other'];
const FX = ['none', 'reverb', 'flanger', 'phaser', 'gate', 'crush'];
const PATTERNS = ['baby', 'chirp', 'transform', 'flare'];

const USAGE = {
  keylock: 'usage: dj keylock <A|B|C|D> [on|off|toggle]            key lock: tempo changes keep the key (default on)',
  key: 'usage: dj key <A|B|C|D> <-6..+6|reset>                    shift the key in semitones, independent of tempo',
  stem: 'usage: dj stem <A|B|C|D> <vocals|drums|bass|other|all> <0-1> [--ramp beats]   stem fader (tracks with stems only)',
  xfassign: 'usage: dj xfassign <A|B|C|D> <left|right|thru>            crossfader assignment (A,C left / B,D right by default)',
  sample: 'usage: dj sample <1-8> [--at now|beat|bar|phrase] [--vol 0-1.5]   fire a sampler pad, quantised (default: next beat)',
  sampler: 'usage: dj sampler [<1-8> --load <trackId> --from <sec|bar:N> --beats <n>]   list pads, or capture a slice of a track into a pad',
  deckfx: 'usage: dj deckfx <A|B|C|D> <none|reverb|flanger|phaser|gate|crush> [amount 0-1] [--ramp beats]   beat-synced deck FX',
  scratch: 'usage: dj scratch <A|B|C|D> <baby|chirp|transform|flare> [--beats 4] [--at bar|beat|now]   beat-synced scratch routine',
};

export default ({ control, flags, rest, deckArg, num, fail }) => {
  const need = (cond, cmd) => { if (!cond) fail(USAGE[cmd]); };
  return {
    async keylock() {
      need(rest[0], 'keylock');
      const v = String(rest[1] ?? flags.on ?? 'on').toLowerCase();
      need(['on', 'off', 'toggle', 'true', 'false', '1', '0'].includes(v), 'keylock');
      return control('keylock', { deck: deckArg(rest[0]), on: v === 'toggle' ? 'toggle' : ['on', 'true', '1'].includes(v) });
    },
    async key() {
      need(rest[0] && rest[1] !== undefined, 'key');
      const s = /^(reset|off)$/i.test(rest[1]) ? 0 : num(rest[1], 'semitones');
      need(Math.abs(s) <= 6, 'key');
      return control('key', { deck: deckArg(rest[0]), semitones: s });
    },
    async stem() {
      need(rest[0] && [...STEMS, 'all'].includes(rest[1]) && rest[2] !== undefined, 'stem');
      const value = num(rest[2], 'value');
      need(value >= 0 && value <= 1, 'stem');
      return control('stem', { deck: deckArg(rest[0]), stem: rest[1], value, ramp: flags.ramp });
    },
    async xfassign() {
      const side = String(rest[1] || '').toLowerCase();
      need(rest[0] && ['left', 'right', 'thru', 'l', 'r', 't'].includes(side), 'xfassign');
      return control('xfassign', { deck: deckArg(rest[0]), side });
    },
    async sample() {
      const pad = num(rest[0], 'pad');
      need(pad >= 1 && pad <= 8, 'sample');
      const at = flags.at || rest[1] || 'beat';
      need(['now', 'beat', 'bar', 'phrase'].includes(at), 'sample');
      return control('sample', { pad, at, vol: flags.vol != null ? num(flags.vol, 'vol') : undefined });
    },
    async sampler() {
      if (rest[0] === undefined) return control('sampler', {});
      const pad = num(rest[0], 'pad');
      need(pad >= 1 && pad <= 8 && flags.load && flags.load !== true, 'sampler');
      return control('sampler', { pad, load: flags.load, from: flags.from, beats: flags.beats != null ? num(flags.beats, 'beats') : 2 });
    },
    async deckfx() {
      need(rest[0] && FX.includes(rest[1]), 'deckfx');
      const amount = rest[2] ?? flags.amount;
      if (amount !== undefined) need(num(amount, 'amount') >= 0 && Number(amount) <= 1, 'deckfx');
      return control('deckfx', { deck: deckArg(rest[0]), type: rest[1], amount: amount !== undefined ? Number(amount) : undefined, ramp: flags.ramp });
    },
    async scratch() {
      need(rest[0] && PATTERNS.includes(rest[1] || 'baby'), 'scratch');
      const beats = flags.beats != null ? num(flags.beats, 'beats') : 4;
      const at = flags.at || 'bar';
      need(['now', 'beat', 'bar', 'phrase'].includes(at) && beats >= 1 && beats <= 32, 'scratch');
      return control('scratch', { deck: deckArg(rest[0]), pattern: rest[1] || 'baby', beats, at });
    },
    async 'help-engine'() {
      console.log(`ENGINE (4 decks, key lock, stems, sampler, deck FX, scratch) — every deck arg accepts A, B, C or D\n${Object.values(USAGE).map((u) => '  ' + u.replace(/^usage: /, '')).join('\n')}
  perform steps also take c: vocals|drums|bass|other|fx, plus {b, d, scratch: "baby", beats: 2} and {b, sample: 1}`);
    },
  };
};
