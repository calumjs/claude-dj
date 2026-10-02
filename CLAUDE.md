# Claude DJ

This folder is a DJ rig that **you** (Claude) play. The user directs the set by typing here in Claude Code. The browser tab at http://localhost:4747 is just the sound system and visuals.

- Any message that sounds like a DJ instruction ("play X", "harder", "kill the bass", "mix into something darker", "get me some trance") is live direction: load the **dj** skill and act on it immediately with `node dj.mjs …`.
- "Play a set" / "DJ for me" / "take over" means the **dj-set** skill (autopilot you can steer).
- Before any `dj mix`, the **dj-mix** skill has the transition craft. Downloading and searching music is **dj-crate**. Recording the decks and rendering a video of a set is **dj-video**. Mashups are **dj-mashup**, speech clips as vocals **dj-voice**, a produced album **dj-album**, and anything broken **dj-troubleshoot**.
- During a live set, keep every `dj wait` at 60 s or less and check for new user text after each tool call. The user's latest words beat your plan. Keep chat replies to one line per event.

## Layout
- `server.mjs`: HTTP server. Holds the library, relays commands to the browser engine, long-poll `wait`, crowd inbox, booth log.
- `dj.mjs`: CLI control surface (`node dj.mjs help`).
- `public/engine.js` + `public/worklets/deck-player.js`: Web Audio engine. Four decks (C/D appear when loaded; A,C left / B,D right of the crossfader), key lock + key shift (WSOLA), per-stem playback (vocals/drums/bass/other), EQ/filter/echo, deck FX (reverb/flanger/phaser/gate/crush), 8-pad sampler, scratching, sample-accurate transitions. Engine CLI: `node dj.mjs help-engine`.
- `public/app.js`: UI + command handlers. `public/index.html`, `public/style.css`.
- `lib/analyze.mjs`: BPM/beat grid, key (Camelot), energy, structure. `lib/library.mjs`: cache, search, suggestions. `lib/downloader.mjs`: yt-dlp wrapper.
- `lib/sequencer.mjs`: plan steps, track queue, auto-DJ. `lib/monitor.mjs`: mix monitor + transition critiques. `lib/memory.mjs` (.dj/memory.json), `lib/cues.mjs` (.dj/cues.json), `lib/sections.mjs`, `lib/music.mjs`, `lib/fx.mjs`, `lib/export.mjs`. Grid corrections: .dj/grid-edits.json.
- Tests: `node --test test/*.test.mjs test/server-*.mjs` (server tests run scratch copies on ports 4851-4855 with a fake engine; they never touch .dj/).
- `.dj/library.json`: analysis cache. `.dj/server.log`: server log. `bin/`: auto-installed yt-dlp.
- Stems: `lib/stems.mjs` + `lib/separate.py` (htdemucs in the project `.venv`) split every track into `.dj/stems/<id>/` in the background; vocal maps via `node dj.mjs vocals <id>`.
- CLI extensions live in `cli-ext/*.mjs` (engine, stems, …).
- `produce/`: video production. `record-browser.mjs` (Playwright page recording that becomes the sound system), `make-video.mjs` (set audio → 720p/480p video with visualiser + DJ-table footage), `viz.mjs`, `get-sample.mjs` / `measure-sample.mjs` (short samples into `.dj/produce/samples/`), `index-captions.mjs` + `find-line.mjs` + `analyze-speech.mjs` (speech index in `.dj/voice/`), `build-reel.mjs` + `remix.mjs`/`chops.mjs` (voice reels), `run-design.mjs` (live design runner, times in `.dj/produce/out/run-design-times.json`), `album-design.mjs` + `songs/README.md` (album plans from `.dj/produce/beds.mjs` + `.dj/produce/songs/`), `cut-track.mjs`, `full-album.mjs`, `align.mjs`.
- Needs Node 20+ and ffmpeg/ffprobe on PATH. No npm dependencies.
