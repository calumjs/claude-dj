---
name: dj-crate
description: Build and search the Claude DJ music library — download tracks, albums or playlists from YouTube / SoundCloud / Bandcamp with yt-dlp, pick the DJ-friendly version (extended / original mix), and query tracks by BPM, Camelot key and energy. Use when the user asks to get, download, find or add music, build a crate for a genre or era, or asks what's in the library.
---

# The crate

Everything in `library/` and `~/Music` (see `config.json → libraryDirs`) is scanned and analysed automatically. Analysis covers BPM and beat grid, key (Camelot), loudness, energy 1–10, intro, breakdowns/drops and outro. Downloads land in `library/downloads/` and are analysed as soon as they finish.

## Getting music

```bash
node dj.mjs find "Headhunterz Dragonborn"            # list candidates, no download
node dj.mjs get "Headhunterz - Dragonborn"           # first search hit → mp3 → analysed
node dj.mjs get https://www.youtube.com/watch?v=…    # exact URL
node dj.mjs get "<playlist url>" --playlist --max 20 # a playlist, capped
```
- yt-dlp installs itself into `bin/` on first use. `node dj.mjs doctor --fix` installs it up front.
- **Prefer DJ-friendly versions.** For a club set, `find` first and pick the *Extended Mix* / *Original Mix* (long intros and outros make blends possible). Avoid *Radio Edit*, *(Lyrics)*, *slowed + reverb*, *sped up*, *nightcore*, live recordings and mashup channels unless asked. Prefer official artist, label or "Topic" channel uploads.
- Only pass a specific URL with `get` once you've checked the `find` list. A bare search takes the first hit, which is usually fine for well-known tracks.
- Building a crate for a brief ("2008 hardstyle classics", "deep house warm-up")? Use your own knowledge to list 10–20 specific, well-known tracks as `"Artist - Title"`, then `get` them one after another. Each takes ~10–40 s. During a live set, fetch them between waits rather than all at once.
- Downloads can fail (region lock, removed video). Try `find` and pick another upload.

## Searching what you have

```bash
node dj.mjs library                                   # everything, by artist
node dj.mjs library hardstyle --sort bpm              # text search
node dj.mjs library --bpm 145-152 --key 8A,9A,8B      # tempo window + keys
node dj.mjs library --compatible <trackId>            # harmonic neighbours of a track
node dj.mjs library --energy 8-10 --sort energy
node dj.mjs suggest --from <trackId> --direction up   # ranked next-track candidates, with reasons
node dj.mjs track <trackId>                            # full analysis for one track
```

## Trusting the analysis
- **BPM** is solid for four-on-the-floor music. For breakbeat, drum & bass, hip-hop or trap it may report half or double time. The mixer treats half/double as compatible, but sanity-check with what you know.
- **Key** is right or a neighbour most of the time. If you know the real key of a famous track, trust that.
- **Energy** is a heuristic: loudness + rhythmic density + tempo. Your own sense of a track ("anthem", "deep", "peak-time") beats it.
- **Structure** (intro/outro/drops) comes from bass energy per bar. Breakdowns are the bass-less stretches, and the `drop` is where the bass returns.
- Changed files are re-analysed automatically. Force a full redo with `node dj.mjs scan --force`.

## Housekeeping
- Add local files by copying them into `library/`, then run `node dj.mjs scan`.
- Point the DJ at other folders by editing `libraryDirs` in `config.json` and restarting the server.

## Deeper analysis (automatic)
- After a server (re)start, a background pass adds more analysis to every track (one decode per track, idle priority). New downloads get it at analysis time:
  - a **beat map**, plus `gridStable` and `drift` (how many ms the constant grid is off by)
  - **section labels** (`dj sections <id>`)
  - **auto hot cues**: start, vocal-in, chorus, drop, breakdown, mix-out
- Section labels are re-derived when stems finish. The vocal map turns verse/chorus from guesses into facts.
- **Fixing a grid**: `dj grid <id>` shows it.
  - `--shift <beats>` moves the downbeat.
  - `--nudge <ms>` slides the grid.
  - `--bpm <x>` sets the tempo.
  - `--reset` goes back to the detected grid.
  - Corrections persist in `.dj/grid-edits.json` and survive re-analysis. Intro/outro/breakdowns/sections are re-derived on the new grid.
- `suggest --mashup` pairs vocal-heavy tracks with instrumental beds: bpm within 8 %, keys compatible at the bed's tempo. It needs vocal maps (`dj stems status`).
