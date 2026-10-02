---
name: dj-voice
description: Mix spoken-word clips (talks, podcasts, office videos) as the vocals of a set — index clips from captions, find exact lines and phrases, build a voice reel that lands every line on the beat, and play it live over stem-muted beds. Use when the user wants speech/voice clips, "cameos", soundbites or quotes in the music, or a voice-over mashup.
---

# Speech as the vocal

The pipeline: **clips in the crate → caption index → design (which line, which bar) → voice reel (one WAV) → live run.**
The reel is a normal library track on deck C; the runner seeks it to each window's offset on the anchor bar and gates its
volume, so lines land sample-accurately while the beds play live with their own vocals muted.

## 1. Get clips and captions
```bash
node dj.mjs get "<youtube url>"                       # audio into the crate; file name keeps the [videoId]
bin/yt-dlp.exe --write-auto-sub --sub-lang en --skip-download -o ".dj/voice/captions/sub-%(id)s" "<youtube url>"
node dj.mjs stems <clipId>                            # vocal stem = speech without the clip's bed music (worth the wait)
node produce/index-captions.mjs                        # → .dj/voice/sentences.json (+kind, speaker) and words.json
node produce/analyze-speech.mjs                        # optional: pitch class, contour, strongest-consonant offset per line
```
Speaker names come from "| Name |" in the title, or `.dj/voice/clips.json` `{ "<videoId>": { "speaker": "Name" } }`.
Optional curated lines: `.dj/voice/lines.json` `[{ id, from, dur, text, speaker, kind }]`.

## 2. Find material
```bash
node produce/find-line.mjs "agree|rules" --dur 0.6-3 --speaker Adam     # sentences: dur kind speaker clipId from | text
node produce/index-captions.mjs --find daily scrum                      # exact phrase occurrences with word timing
```
Good lines: 0.6–3 s, complete thoughts, no "uh/um", no trailing commas, one speaker per 8-bar phrase. A **hook** is a
short phrase everyone can repeat; a **stab** is one word for rolls.

## 3. Write the design
A design module exports `SECTIONS` (beds) and `WINDOWS` (what the reel plays over each bed). For an album, write song
plans and let `produce/album-design.mjs` generate both (dj-album skill). For a one-off, write it by hand:
```js
export const SECTIONS = [{ name: 'intro', id: '<bedId>', bpm: 125, key: 0, fromBar: 17, bars: 64,
  stems: { drums: 1, bass: 1, other: 0.85, vocals: 0 }, handoff: { drumsIn: 8 } }];
export const WINDOWS = [{ name: 'intro', bed: 'intro', anchor: 17, bpm: 125, mute: [17, 81],
  lines: [[25, '<clipId>', 12.4, 1.8, 'We call them rules.']],        // [endBar(absolute), clipId, fromSec, durSec, text] — ends ON the bar
  slices: [[31, '<clipId>', 61.2, 0.34, 61.2, 0.34]],                 // [startBar, clipId, from, dur, refFrom, refDur] — starts on the bar (stabs, rolls)
  bedMoves: [] }];                                                     // bed loop rolls / stem moves (see produce/remix.mjs bedRoll, bassKill)
```
Rules that make it musical: lines end on downbeats; drops and breakdowns stay clean (4–8 bars); hooks every 16 bars with
half a bar of air; drop builds roll a whole word (halves then quarters), never sub-100 ms slices; natural pitch only.

## 4. Build the reel and play it
```bash
node produce/build-reel.mjs <design.mjs>        # → library/voice-reels/Voice Reel - <name>.wav + .dj/voices/<name>-reel.json
node dj.mjs scan                                 # the reel becomes a track (artist "Voice Reel")
node produce/run-design.mjs --design <design.mjs> --dry    # cues beds and the reel, checks everything resolves
node produce/run-design.mjs --design <design.mjs>          # records, plays every section with hand-offs, exports at the end
```
During a live run poll `.dj/produce/out/run-design.log` and `dj status` at most every 60 s; the user's words beat the plan.
Start `produce/record-browser.mjs` first if you want DJ-table footage (dj-video skill); the runner reads its timing.

## 5. Volume and feel
Reel lines are levelled to the same speech loudness and the bed ducks to 0.8 under each line (design `duck`). Voice too
quiet? Raise `voiceDb` in the design (−13 dB default) rather than the deck fader. Lines cut from vocal stems sound dry
and clear; lines from the raw clip carry its background music.
