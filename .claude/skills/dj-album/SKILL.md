---
name: dj-album
description: Produce a multi-track themed album on the DJ table — beds per track, one planning subagent per song (hook, featured lines, scripted jokes, arrangement, samples), one continuous live take, per-track masters and videos, a full-album video. Use when the user asks for an album, an EP, "a set of tracks", or several produced songs on a theme.
---

# A themed album, recorded as one live set

Each track = two beds (≈ 6 min) played back to back with a hand-off; the vocals are speech lines from the voice index
(dj-voice skill) planned per song; the whole album is one `run-design` take, then cut into tracks.

## 1. Beds
Write `.dj/produce/beds.mjs` (schema in `produce/songs/README.md`): per track two sections `tN-a` / `tN-b` with bed id,
`fromBar`, `bars`, stems (bed vocals 0), drops as `moves: [{kind:'roll', bar}]` at the bed's real drops, `handoff`.
Choose beds with clear intros/drops (`dj track <id>`), stems ready, tempo steps ≤ 3 BPM between consecutive sections,
keys compatible. One hour ≈ 10 tracks ≈ 20 beds.

## 2. Plan every song with its own subagent
Give each agent: the brief (`produce/songs/README.md` is the brief, read it first), its track number and working title,
its two beds (bpm, bars, drops), the file to write (`.dj/produce/songs/track-NN.mjs`), and the rules of engagement
(write only that file and sample downloads; never touch beds, servers, the engine; verify with
`node produce/album-design.mjs --track N`). Run all agents in parallel; they share the line pool first-come, so ask
them to prefer lines that literally match their title and to script the gags they must keep.

A good plan has: an exact spoken **title hook** (from `index-captions.mjs --find`), one **roll word** from the same
voice, a tight `verse` regex with `verseOnly: true`, 10–30 `featured` lines in listening order grouped by speaker,
3–8 `script` call-and-response moments at phrase bars, `arrangement` music-only air after drops and sparse bars before
hand-offs, ≤ 3 iconic vocal `samples`, coverage 0.40–0.55.

## 3. Compile and check
```bash
node produce/album-design.mjs            # per section: lines, hooks, coverage, strict/punchy counts, MISSING, WARN, DUPES
node produce/album-design.mjs --track 3  # one track's full timeline
```
Fix every MISSING text (exact `text` from `find-line.mjs`), keep `punchy 0`, and resolve DUPES across tracks by moving
or dropping the weaker copy (scripted gags win; a one-word catchphrase recurring once as a callback is fine).

## 4. Record
```bash
node produce/record-browser.mjs                                   # optional footage; makes its window the engine
node produce/build-reel.mjs produce/album-design.mjs && node dj.mjs scan
node produce/run-design.mjs --design produce/album-design.mjs --dry
node produce/run-design.mjs --design produce/album-design.mjs      # one take: records, plays, exports
```
Keep disk ≥ 15 GB free (`.dj/pcm` regrows; it is a cache). Disable automatic stem separation during the take
(`config.json → stems.auto: false`, restart the server) so demucs does not compete. Poll the run log and `dj status` at most
every 60 s; after each track finishes, cut it while the take continues:
```bash
node produce/cut-track.mjs produce/album-design.mjs 1 --album "Album Name" --artist "DJ Claude"        # master mp3 now
node produce/cut-track.mjs produce/album-design.mjs 1 --album "Album Name" --video --logo logo.png     # video after the take
node produce/cut-track.mjs produce/album-design.mjs 1 --album "Album Name" --footage                   # …or with the speakers' footage cut in (.dj/video/<videoId>.mp4)
node produce/full-album.mjs --album "Album Name"                                                        # one continuous video + mp3
```
Render videos **after** the take (they starve the audio engine) and one at a time.

## 5. Deliver
Masters: `.dj/exports/album/<Album> - NN - <Title>.mp3`; videos next to them (720p + 480p); full album as
`<Album> - Full Album.mp4/.mp3`. Send each track as it is cut. Say what was not auditioned by ear.
