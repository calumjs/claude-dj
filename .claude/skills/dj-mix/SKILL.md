---
name: dj-mix
description: The craft of a single transition in Claude DJ — choosing the mix style (blend, bass swap, filter, echo out, cut, brake, spinback), its length, when to start it (bar / phrase / mix-out point) and where the incoming track enters (intro, drop). Use whenever you are about to run `dj mix`, the user asks for a specific kind of transition, or a transition sounded wrong.
---

# Mixing like a DJ

One transition = **which track, which style, how long, when it starts, where the new track enters.** The engine handles beat-matching, phase alignment and sample-accurate scheduling. Your job is the musical decisions.

## 1. Read both tracks first
```bash
node dj.mjs status              # live deck, position, bar, time to mix-out
node dj.mjs track <incomingId>  # grid, key, intro end, breakdowns/drops, phrase energy
```
Key numbers: `bpm`, `camelot`, `energy`, `mixIn` (first downbeat), `introEnd`, `breakdowns[].drop`, `mixOut` (start of the outro). The phrase-energy sparkline shows where the track is quiet (▁▂) or full (▇█).

## 2. Pick the style

Compute the tempo gap: `|incoming.bpm − live effective bpm| / live bpm` (half/double time counts as a match).

| Situation | Style | Bars |
|---|---|---|
| Tempo gap ≤ 4%, compatible key, groove-to-groove | `blend` (EQ blend with a bass swap in the middle) | 16–32 |
| Same as above but you want it punchier or faster | `bassswap` | 8 |
| Gap ≤ 6%, keys clash, or vocals would collide | `filter` (outgoing high-passes away, incoming opens from a low-pass) | 8–16 |
| Gap > 6–8%, genre change, or ending on a big moment | `echo` (echo out on the downbeat, new track drops after 1 bar) | 1–2 |
| Crowd wants it NOW / drop-on-drop / hard genre switch | `cut` on `--at bar` | 0 |
| Theatrical reset (big tempo change, set-piece moment) | `spinback` or `brake` | — |
| Ambient / no beats / ending the night | `fade` | 16–32 |

The engine warns `tempo gap is N%` when a beat-matched style would pitch the incoming track more than 8%. Heed it: switch to `echo`, `cut` or `spinback`.

### Harmonic compatibility (Camelot)
- **Safe:** same code (8A→8A), ±1 same letter (8A→7A, 8A→9A), letter swap (8A→8B).
- **Energy boost:** +2 same letter (8A→10A), or the diagonal +1 with a letter swap (8A→9B). Use it sparingly, at peaks.
- **Clash:** anything else. Use a `filter`, `echo` or `cut` so the two keys barely overlap. Or ignore it on a hard drop-swap; drums-only overlaps don't clash.
- Detected keys can be off by a fifth or relative. If your own knowledge of the track disagrees, trust yourself.

## 3. Timing: phrases, not seconds

Dance music moves in 8-bar phrases (32 beats), and big changes land on 16/32-bar boundaries.
- `--at phrase` starts on the next 8-bar boundary of the live track (it falls back to 4 bars if that's more than 30 s away). **Default for planned mixes.**
- `--at bar` means the next downbeat. Use it for reactive moves.
- `--at now` means immediately, phase-matched but not bar-aligned. Only for emergencies.

**Start early enough.** Get close to the live track's outro before mixing:
```bash
node dj.mjs wait mixout --seconds <lead>
```
Here `<lead>` = transition length in seconds + ~5 s. A blend of 16 bars at 128 BPM takes 16×4×60/128 = 30 s, so use `--seconds 35`. A long blend should *finish* around the end of the outgoing track's outro, not after it runs out.

## 4. Where the new track enters (`--in`)
- `mixin` (default): the first downbeat. Its intro plays under the outgoing track. Best for `blend` and `bassswap`.
- `intro`: the incoming track reaches its full groove exactly as the transition ends.
- `drop`: the incoming's first drop (the end of its first breakdown) lands exactly as the transition completes. **The crowd-pleaser.** Use it with `bassswap` or `filter` at 8 bars.
- `bar:N` / `<seconds>`: a manual entry point, e.g. skip a long DJ-unfriendly intro.

## 5. After the mix
- The engine glides the new track's tempo back to its native BPM over ~30 s (pitch drifts subtly). Pass `--no-glide` to hold the current tempo, e.g. when mixing several same-genre tracks at a steady club tempo.
- `node dj.mjs wait transition` blocks until the transition is finished. Then `status` to confirm the new `live` deck.
- Load the *next* track onto the now-idle deck early, since loading takes a few seconds.

## 6. Recipes
```bash
# Classic long EQ blend on the phrase, same genre
node dj.mjs mix A B --style blend --bars 32 --at phrase --why "8A→9A, same 128 BPM, long intro — ride it"
# Drop-to-drop: new track's drop lands as the mix completes
node dj.mjs mix A B --style bassswap --bars 8 --in drop --at phrase --why "Timing Dragonborn's drop to land on the phrase"
# Genre / tempo jump (128 → 150)
node dj.mjs mix A B --style echo --at phrase --why "22-BPM jump — echo out and slam into hardstyle"
# Build tension on the live deck, then release into a cut
node dj.mjs filter A 0.6 --ramp 16 && node dj.mjs wait bar <n>
node dj.mjs mix A B --style cut --at bar --in drop
```

## 7. Manual moves (for when a direction doesn't fit a preset)
- **Tease the incoming:** `dj vol B 0` → `dj play B --at bar` (it starts beat-synced and silent) → `dj xfade 0.5` → `dj vol B 0.5 --ramp 8` → … then finish with `dj mix A B --style fade --bars 4`.
- **Loop to extend a short outro:** `dj loop A 8` while you set up, then `dj mix A B …` (the loop ends when A stops).
- **Riding EQs:** `dj eq B low -1` before bringing B in; swap on a downbeat with `dj eq A low -1 && dj eq B low 0`.

## 8. Performance FX: when they actually sound good

You can't hear the audio. Your only ears are the analysis (`dj track <id>`: bars, 8-bar phrases, breakdowns, drops, phrase energy) plus your knowledge of the genre and the songs. FX sound good **only when they're tied to that structure**. Fired "on the next bar" at a random point, they sound like mistakes. Presets are anchored musically by default:

| FX | What it is | Use it | Default anchor |
|---|---|---|---|
| `fx rollup <deck>` | 8-bar loop roll 4→2→1→½→¼ + rising high-pass, slip release | The last 8 bars before a **drop**, ideally over a build or breakdown | ends ON the next drop (`--at drop`) |
| `fx roll <deck>` | 4-bar version | Shorter builds, or as a fill before a phrase | ends ON the next drop |
| `fx throw <deck>` | Echo the last beat, cut for a bar, slam back in | The final beat of a phrase, as a "breath" before a new section | ends on the phrase boundary |
| `fx chop <deck>` | Transformer volume chops (8ths) | A 2-bar fill at the end of a phrase, drums-only sections. Never over vocals | ends on the phrase boundary |
| `fx scratchcut <deck>` | Crossfader cuts between both decks | Only when both decks are playing, in phase and harmonically compatible (after a `double`) | ends on the phrase boundary |
| `fx kills <deck>` | Bass→mid→high kills, all back on the bar | Inside a full-energy section, starting on a phrase | starts on the phrase |
| `fx sweep <deck>` | Low-pass down and back up over 4 bars | Taking energy out and back in, e.g. before a breakdown | starts on the phrase |
| `fx wobble <deck>` | Low-pass pump on the beat | In a breakdown or intro only. It muddies a drop | starts on the phrase |

Rules of thumb:
- **Less is more.** One FX per 16 bars at most. The track's own drop is the loudest effect you have.
- Rolls and builds **resolve into drops**. Never roll into the middle of a phrase.
- Don't chop or wobble over a drop's first 8 bars. Let the drop breathe.
- Always check `dj status` (bar number) and `dj track` (next drop) before firing, so you know what the music is doing.
- Custom routines: `dj perform '<json>' --at drop|phrase-end|phrase|bar`. Steps are `{b: beat, d: deck, c: low|mid|high|filter|echo|vol|xfade|master|vocals|drums|bass|other|fx, v: value, o: over-beats}`, `{b, d, loop: beats|0}` (slip-mode loop), `{b, d, rate: "+2%"}`, `{b, d, seek}`, `{b, d, scratch: "baby", beats: 2}` and `{b, sample: 1-8}`. Everything is scheduled on the audio clock up front.

### Double drop (`--style double`)
`dj mix A B --style double --bars 16` starts the incoming track so **its first drop lands exactly on the outgoing track's next drop**, computed on the audio clock. The incoming track rises filtered and bass-less under the build. On the drop both melodies hit with one bassline (the incoming's). Both play for `--bars`, then the outgoing fades. It works best with same or neighbouring keys and matched energy.

## 9. Engine tools: key lock, stems, 4 decks, sampler, deck FX, scratch

Every deck argument accepts **A, B, C or D**. `node dj.mjs help-engine` prints the syntax. All of these log to the booth and the recorder.

| Tool | Command | Sounds good when | Avoid |
|---|---|---|---|
| **Key lock** (on by default for every load) | `dj keylock <deck> on\|off` | Tempo jumps over ~3%: a 124 track pushed to 132 keeps its key. | Brakes, spinbacks and scratches bypass it by design. Above ~8% stretch, prefer `echo`/`cut` anyway, because stretch artefacts creep in. |
| **Key shift** | `dj key <deck> <-6..+6>` | Fixing a clash so two tracks blend: shift the incoming track to the live `effectiveCamelot` or a neighbour of it. +1 semitone = +7 Camelot steps. `dj status --json` shows `effectiveCamelot` per deck. | Shifts beyond ±2 on vocals sound chipmunky/demonic. Reset with `dj key <deck> reset` before the track goes solo for long. |
| **Stems** (only tracks with `stems`) | `dj stem <deck> vocals\|drums\|bass\|other\|all <0-1> [--ramp beats]`; perform `c: vocals…` | **Acapella over instrumental**: incoming `vocals 1, drums 0, bass 0, other 0` over the live deck with its `vocals 0`. **Stem swap blend**: bring the incoming drums in first, swap bass on the downbeat, vocals last. Drum-only loops from `other 0, vocals 0, bass 0`. | **Never two vocal stems up at once.** Never two basslines: stems obey the same bass-swap rule as EQs. Keep keys compatible (use `key`) when layering vocals over other music. |
| **4 decks + crossfader assign** | `dj xfassign <deck> left\|right\|thru` | C/D for a loop layer, an acapella or a tool track under the main deck. `thru` keeps a layer up while you crossfade A↔B. A mix between decks on the same side (or thru) automatically uses channel faders. | More than 3 decks audible is mud. Load C/D only for a purpose, and pause them afterwards. |
| **Sampler** (1 air horn, 2 riser, 3 boom, 4 siren, 5 laser, 6 "hey!", 7–8 captured) | `dj sample <pad> --at beat\|bar`; `dj sampler 7 --load <id> --from bar:17 --beats 2` | Riser (always 8 beats long) must **end on the drop**: use the end-aligned perform recipe below. Boom **on the drop's downbeat**. Air horn/siren once at the top of a big drop (dancehall, hardstyle, D&B). A captured vocal hit as a call-and-response in a breakdown. | Samplers are seasoning. At most one hit per drop, never over a vocal line, never every phrase. |
| **Deck FX** (beat-synced) | `dj deckfx <deck> reverb\|flanger\|phaser\|gate\|crush\|none [0-1] [--ramp beats]`; perform `c: fx` | Reverb washout on the last bar of a track (with the echo out). Flanger/phaser over a breakdown or a long intro. **Gate** (1/16 trance gate) on pads/breakdowns in trance/hardstyle. Crush briefly as a build-up texture. | Any FX over a drop's first 8 bars. Gate on vocals. Leaving FX on: `deckfx <deck> none` when done. |
| **Scratch** | `dj scratch <deck> baby\|chirp\|transform\|flare --beats 4 --at bar`; perform `{b, d, scratch: "chirp", beats: 2}` | A 1–2 bar fill at a phrase end in hip-hop, breaks, D&B or old-school house. The track resumes on the grid afterwards (slip). | Over sustained melodic sections, or more than once per 32 bars. |

Recipes:
```bash
# Acapella remix: vocals of C over the instrumental on A (compatible keys, synced)
node dj.mjs load C <acapellaTrackId> && node dj.mjs xfassign C thru && node dj.mjs stem C drums 0 && node dj.mjs stem C bass 0 && node dj.mjs stem C other 0
node dj.mjs stem A vocals 0 --ramp 4 && node dj.mjs vol C 0 && node dj.mjs play C --at bar && node dj.mjs vol C 0.9 --ramp 8
# Big tempo jump that keeps its key: key lock is already on, so just blend
node dj.mjs mix A B --style bassswap --bars 8 --why "126→134 with key lock on, no pitch change"
# Riser ends exactly on the next drop and the boom hits the drop (end-aligned perform: 8-beat riser, boom at beat 8)
node dj.mjs perform '[{"b":0,"sample":2},{"b":8,"sample":3}]' --at drop --ref A
```

## 9. Your ears: the mix monitor
`dj status` prints ⚠ lines, and `dj monitor` shows the full picture: per-deck effective key, section, vocals, and phase in ms. It checks every 250 ms while two or more decks are audible (> 0.3):

| ⚠ | Meaning | Fix now |
|---|---|---|
| `vocal clash` | two decks are inside vocal sections with vocals up (stem gain > 0.3, mid EQ > −0.7) | `dj stem <deck> vocals 0 --ramp 2` or `dj eq <deck> mid -1`, or finish the mix sooner |
| `key clash` | effective keys (after tempo/key shift) clash while both decks have bass or melody up | kill one deck's `low` + `mid`, shorten the overlap, or `dj key <deck> ±1` |
| `flamming: B is 30 ms behind A` | beat-phase offset > 20 ms (the kicks double up) | `dj sync <deck>`. If a track keeps drifting, check `dj grid <id>` |
| `tempo mismatch` | decks are at different effective BPMs, so the phase will drift | `dj sync` / `dj tempo` |
| `master clipping` | master peak ≥ −0.3 dBFS | `dj master 0.8`, or pull back a deck's vol or low EQ |
| `energy dip` | everything audible has been in a breakdown/low section for > 16 bars | bring the next drop in (`fx rollup`, mix `--in drop`) |

After each transition you get a `🧐 Critique` line: what was checked, the maximum phase offset, and any warnings. It's recorded in `.dj/memory.json` and in `dj report`.

## 10. Structure, cues, grids, keys
- **Sections**: `dj sections <id>` (also shown in `dj track`) labels intro / verse / chorus / build / drop / breakdown / outro with 1-based bars, the same as `bar:N`. Time mixes to them: e.g. `--in bar:<first chorus>`, or `plan` a mix for the end of a chorus.
- **Hot cues**: every track gets auto cues where the analysis finds them: 1 start · 2 first vocal-in · 3 first chorus · 4 first drop · 5 first breakdown · 6 mix-out.
  - `dj hotcue <deck> <n>` jumps on the next bar line, keeping the phase.
  - `dj hotcue <deck> set <n> [bar:N|sec]` saves your own cue (persistent, in `.dj/cues.json`).
  - `dj savedloop <deck> set <name> <beats> [--at bar:N]` stores a loop; `dj savedloop <deck> <name>` recalls it.
- **Beat grids**: `dj track` shows `grid stable (drift N ms)` or `DRIFTS up to N ms`. Drifting tracks carry a `beatMap`; keep blends with them short (8 bars) and watch for `flamming`.
  - Wrong downbeat: `dj grid <id> --shift 1` moves bar 1 by one beat.
  - Grid early or late: `--nudge <ms>`.
  - Wrong tempo: `--bpm <x>`.
  - Undo with `--reset`. A deck picks up the new grid when the track is loaded again.
- **Key-aware suggestions**: `suggest` scores the incoming track at the pitch it will actually play (the live tempo, unless that deck has key lock), and the result says `plays as 3A`.
  - When a small shift fixes a clash it adds `→ keyShift -1 (8A): dj key <deck> -1`. Apply that to the incoming deck before the mix.
  - `suggest --mashup` lists vocal-over-bed pairs (stems needed). Layer the vocal deck's `vocals` stem over the bed's instrumental.
