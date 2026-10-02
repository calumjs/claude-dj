---
name: dj-video
description: Produce a video of a Claude DJ set — record the DJ-table page with Playwright while the set plays, export the set audio, then render a music video (reactive visualiser, title card, DJ-table footage as B-roll, 720p + 480p). Use when the user asks for a video, a recording of the decks, footage of the set, or a clip to share.
---

# Set video

Three steps: **record the page** (before the set), **export the audio** (after), **render** (any time after). Everything
lands in `.dj/exports/` and `.dj/produce/out/`. Needs ffmpeg/ffprobe on PATH and Playwright for the footage
(`npm i -g playwright && npx playwright install chromium`; the render works without footage).

## 1. Record the DJ table (optional footage)
```bash
node produce/record-browser.mjs          # opens its own maximised Chromium, clicks Start engine, records the page
```
- Start it **before loading decks**: the new window takes over as the sound system and the old tab's decks are dropped.
  `dj status` must show the engine connected afterwards.
- It writes `.dj/produce/out/screen/browser.json` (`start` = epoch ms the video began) and a `.webm` next to it.
- Keep audio playing: Chromium throttles a silent hidden page. Don't minimise the window.
- Stop after `dj record stop`: `node produce/record-browser.mjs --stop` (finalises the .webm). The growing file is
  readable by ffmpeg before that, so partial renders mid-set work.

## 2. Record and export the set audio
```bash
node dj.mjs record start --no-screen --no-mic      # at the start of the set (the dj-set skill does this)
node dj.mjs record stop && node dj.mjs export      # → .dj/exports/<session>.mp3 + .txt tracklist + .cue
```

## 3. Render
```bash
node produce/make-video.mjs .dj/exports/<session>.mp3 --title "DJ Claude - Friday Lunch Set" --screen auto
```
- `--title "Credit - Song"`: the part before ` - ` is the small credit, the rest is the big title on the opening card.
- `--screen auto` picks the latest page recording and lines it up with the export from the session id (UTC) and
  `browser.json`; `--screen <file.webm> --screen-offset <sec>` to do it by hand; omit for visualiser only.
- `--logo <png>` puts a logo in the centre pulsing on the kick (white/transparent PNG works best).
- Sections: the export's `.txt` tracklist next to the mp3 is picked up automatically (one colour tint per track);
  `--sections <file>` to point at another one.
- Output: `<audio name>.mp4` (1280×720) and `<audio name> (480p).mp4` beside the audio, or `--out <file>`.
- Speed: roughly 1.5–3× faster than real time on a laptop. Render **after** the set: a render during a live set
  starves the audio engine. Several renders at once share the CPU; run them one after another.

## Screenshots of the deck (docs, thumbnails)
```bash
node produce/snap-deck.mjs <trackA> <trackB> [trackC] [trackD] --scale 2     # plays a 1-minute demo, 3840×2160 PNGs in .dj/produce/out/shots
```
It opens its own Chromium (which becomes the engine and plays audio), loads, plays, mutes stems, rolls a loop, blends
A→B, brings up four decks and sweeps a filter, snapping at each step. Set `PLAYWRIGHT_CHROMIUM` if Playwright's default
browser is not installed.

## Samples for the sampler (optional)
```bash
node dj.mjs find "michael jackson hee hee sound effect"        # pick a short upload
node produce/get-sample.mjs <url> hee-hee                      # → .dj/produce/samples/hee-hee.mp3 + non-silent segments
node produce/measure-sample.mjs .dj/produce/samples/hee-hee.mp3 --thresh -45
```
Short clips are too brief for the library's BPM analysis, so they live in `.dj/produce/samples/`, not `library/`.

## Gotchas
- Chrome window capture (gdigrab) returns black frames for GPU-rendered pages; that is why the recorder uses Playwright.
- Text in `--title` is drawn with ffmpeg drawtext: `%`, `:` and `,` are escaped for you.
- If the Playwright window closes, the engine is gone: open http://localhost:4747 in a browser and click **Start engine**.
- Windows fonts are used when present (Impact, Arial); set `VIZ_FONT_BOLD=<path.ttf>` on other systems.
