# Song plans (`produce/album-design.mjs`)

One file per track in your songs folder (default `.dj/produce/songs/track-NN.mjs`, `export default { … }`). The album
designer merges each plan with the beds file, the reel builder cuts every line from the speech clips (vocal stems when
separated), and `produce/run-design.mjs` plays the beds live on the DJ table while the reel plays on deck C.

## Beds file (`.dj/produce/beds.mjs`)
```js
export default { voiceDb: -13, duck: 0.8, sections: [
  // two sections per track, names end in -a / -b; bars count from 1 inside a section; moves are section-relative bars
  { track: 1, name: 't1-a', bpm: 125, key: 0, bars: 80, bed: { id: '<libraryId>', fromBar: 25, stems: { drums: 1, bass: 1, other: 0.85, vocals: 0 } },
    moves: [{ kind: 'roll', bar: 17 }],                                   // roll = loop-roll into a drop at that bar; also {kind:'bass',bar,to}, {kind:'stem',bar,stem,v,o}
    layers: [{ id: '<libraryId>', stem: 'other', fromBar: 57, from: 41, to: 57, gain: 0.5 }],   // optional melodic layer on deck D
    handoff: { drumsIn: 8, sweep: false, carry: 'other' } },             // how this section hands off to the next
  { track: 1, name: 't1-b', bpm: 125, key: 0, bars: 96, bed: { id: '<libraryId>', fromBar: 57, stems: { drums: 1, bass: 1, other: 1, vocals: 0 } }, moves: [{ kind: 'roll', bar: 49 }], handoff: { drumsIn: 8 } },
  // a section with `fixed: true` keeps its own `lines` and is not planned (e.g. a closing song with scripted sign-offs)
] };
```
Beds need stems (`dj stems <id>`) so their vocals can be muted. Pick `fromBar`/`bars` from `dj track <id>` sections.

## What the designer does by default
- **Chorus:** the title hook ends on the downbeat of bar 9, 25, 41 … (`hookEvery: 16`), half a bar of air each side.
- **Drops:** the hook ends 2 bars before each drop, then the hook's last word is rolled as whole-word stabs (2 halves,
  4 quarters) into the drop; 4 bars after the drop stay clean.
- **Verses:** remaining bars are filled with lines matching the plan's `verse` regex (featured lines first, in order),
  unique across the whole album, each line's strongest consonant snapped to the beat. `verseOnly: false` lets short
  generic exclamations fill when the pool runs out (off by default: random filler is what listeners notice).
- Bars 1–2 and the last 2.5 bars of a section are always clear (run-in / hand-off).

## What "good" means
1. A song, not a podcast over a beat: spoken coverage 0.40–0.55; music-only air after each drop and before hand-offs (`arrangement`).
2. The title is the hook; hook and drop-roll word are the same voice.
3. Every verse line is about the title: tight regex plus 10–30 hand-picked `featured` lines, ≤ 3 s, clear, complete thoughts, grouped by speaker per 8-bar phrase.
4. In on the joke: `script` call-and-response at phrase boundaries (bars 9, 17, 25 …) or right after a drop's clean bars.
5. Extra sounds are iconic vocal stabs only, ≤ 3 per track, ≤ 1.5 s, on musical moments. No risers, sweeps or air horns.
6. Drops come from the bed's real structure; add one only on a phrase boundary ((bar−1) % 8 == 0), ≥ 12 bars from others.

## Schema
```js
export default {
  track: 3, title: 'As Per Our Conversation',          // title = a phrase that exists in the speech
  hook: { q: 'as per our conversation', id: '<clipId>', pick: 0, pre: 0.08, post: 0.2 },  // exact words (index-captions --find); id = clip; pick = nth occurrence
  word: { q: 'conversation', id: '<clipId>' },           // ONE word for the drop rolls (same clip/voice as the hook)
  hookEvery: 16,
  verse: /\b(conversation|checked by|confirm|phone|call)\b/i,
  verseOnly: true, rest: 0,                               // rest = bars of air between verse lines
  featured: ['Remember sending this email', 'I do not remember sending this email'],   // exact `text` values (find-line prints them)
  script: [{ sec: 'a', end: 11, text: 'I do not remember sending this email' }, { sec: 'b', end: 17, q: 'what is this email', id: '<clipId>', label: 'what is this email' }],
  arrangement: [{ sec: 'a', from: 33, to: 41, mode: 'music' }, { sec: 'a', from: 80, to: 96, mode: 'sparse', rest: 2 }],
  drops: [{ sec: 'b', bars: [81] }],
  samples: [{ name: 'hee-hee', id: '.dj/produce/samples/hee-hee.mp3', from: 1.25, dur: 1.14, at: [{ sec: 'a', bar: 33 }, { sec: 'b', bar: 57, under: true }] }],
  notes: 'one paragraph: the joke, the arc, why these lines',
};
```
`sec` is `'a'` or `'b'`; bars are section-relative; `end` is the downbeat a line finishes on; a sample `bar` is where the
stab starts; `under: true` lets verse lines continue over a stab. Captions never show the `label` prefix "Name:".

## Tools
- `node produce/find-line.mjs "<regex>" [--dur 0.5-3] [--speaker Name]` — search indexed sentences; `text` must match exactly.
- `node produce/index-captions.mjs --find <words…>` — exact phrase occurrences with word timing (for `hook`, `word`, `script[].q`).
- `node produce/album-design.mjs --track N` — compile and print the track's timeline, coverage, MISSING texts, WARN, DUPES.
- `node dj.mjs find "<query> sound effect"` → `node produce/get-sample.mjs <url> <name>` → `samples[]` entry.
Verify with `node --check` and `album-design.mjs --track N` (no MISSING, coverage in range) before finishing a plan.
