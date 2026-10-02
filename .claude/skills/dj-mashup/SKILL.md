---
name: dj-mashup
description: Build live mashups on the DJ table — a vocal (or spoken-word) track over an instrumental bed using stems, key/tempo fitting, vocal placement over sparse sections, loop-rolls into the drop. Use when the user asks for a mashup, "X over Y", an acapella over a beat, a remix of two tracks, or vocals from one song on another.
---

# Live mashups

A mashup here is two tracks on two decks: the **bed** (drums/bass/other stems, its own vocals muted) and the **top**
(vocals stem, or a spoken-word clip). Both play from the engine with tempo and key matched, so the result is live and
re-cuttable. Needs stems for both tracks (`dj stems <id>`, check `dj stems status`).

## 1. Pick the pair (curation beats engineering)
- `dj suggest --mashup` ranks vocal-heavy tracks over instrumental beds by tempo (within 8 %) and key compatibility at
  the bed's tempo. `dj library --compatible <bedId>` lists harmonic neighbours; `dj track <id>` shows vocal sections.
- Only put **dance-style vocals over dance beds**. A pop ballad vocal over hardstyle is a novelty for 8 bars and then
  tiring; the fix is a different pairing, not more effects.
- Tempo: stretch the top, not the bed, and keep the stretch under ~8 % with key lock on (`dj keylock B on`). Key: shift
  the top to the bed's key (`dj key B <semitones>`); `suggest` prints `recommendedKeyShift`.
- Audition first: play the pairing on a quiet deck for 16 bars before committing it to the set.

## 2. Place the vocal
- Vocals belong over the bed's **sparse** sections (intro, breakdown, the 8 bars before a drop). Read `dj sections <bedId>`
  and the top's `vocalSections`; line a vocal phrase up so it ENDS on a phrase downbeat.
- When the vocal is in, take the bed's lead out (`dj stem A other 0.3`) so two melodies never fight; bring it back when the
  vocal stops. Drops play clean: no vocal over the first 4–8 bars of a drop.
- Sparse use per set: one or two mashup moments land harder than a whole set of them.

## 3. Mechanics
```bash
node dj.mjs load A <bedId> && node dj.mjs stem A vocals 0                 # bed, own vocals muted
node dj.mjs load B <topId> && node dj.mjs stem B drums 0 && node dj.mjs stem B bass 0 && node dj.mjs stem B other 0
node dj.mjs keylock B on && node dj.mjs tempo B <bedBpm> && node dj.mjs key B <shift>
node dj.mjs xfassign A thru && node dj.mjs xfassign B thru                # both decks audible regardless of the crossfader
node dj.mjs hotcue B 2                                                    # vocal-in cue; seek B so the phrase ends on the bar
node dj.mjs play B --at bar
```
- Scheduled moves use `dj perform '<steps>'` (beat-accurate): e.g. bed lead down over 2 beats as the vocal enters.
- **Loop-roll into the drop**: `loop B 2 → 1 → 0.5 → 0.25` over the last bar (slip loop), release with `loop B 0` on the
  downbeat and send `loop 0` once more a beat later (a stuck slip loop pins the track). The dj-mix skill has the recipe.
- Blend transitions only (bass swap / filter). No echo-outs to silence, no riser or sweep samples: the material is the show.

## 4. Spoken word as the top
Speech clips work the same way with the dj-voice skill's reel: cut lines that end on downbeats, keep their natural pitch
(no pitch shifting of speech), duck the bed slightly (0.8) under each line, and give drops and breakdowns clean air.

## 5. Judge it
`dj log` prints the mix monitor's critique after each transition (vocal clash, key clash, beat offset). Rate pairings
with `dj rate good|bad "<note>"`; `suggest --mashup` learns from it.
