---
name: dj-troubleshoot
description: Diagnose and recover the Claude DJ rig — engine not connected or stale, a deck that is silent, stuck loops, loads that time out, disk filling up, stem separation hogging the CPU, YouTube download walls, Playwright window as the engine. Use when something sounds wrong, a command errors, `dj status` shows warnings, or playback stops.
---

# When it breaks

Start with `node dj.mjs status` and `node dj.mjs log` (booth log). Then match the symptom.

| Symptom | Cause | Fix |
|---|---|---|
| `Engine state is stale` / `not connected` | The browser tab was closed, or Chrome throttled a hidden silent tab | Open http://localhost:4747 and click **Start engine**. Keep the tab in its own window and audio playing; for recordings use `produce/record-browser.mjs`, whose Chromium does not throttle. |
| Loads time out, "stale" during a set | Same throttling | Reload the tab, Start engine, re-`load`. |
| A deck plays but nothing is heard | Crossfader on the other side | `node dj.mjs xfassign <deck> thru` for every deck you want independent of the crossfader. |
| Track pinned at the same bar, "skipping" | A slip loop was never released | `node dj.mjs loop <deck> 0`, then once more a beat later. Rolls should end with two `loop 0`s. |
| Vocal/sample lands early or silent | A `perform` step with a negative beat offset is dropped | Schedule from the next bar (`b ≥ 0`) and seek into the window instead of before it. |
| Set crashed, disk full | `.dj/pcm` (decoded audio) and `.dj/stems` grow with every track | Delete `.dj/pcm/*` (cache, safe), old `.dj/sessions`, `.dj/produce/out/*`; keep ≥ 15 GB free. |
| Everything is sluggish while playing | Stem separation at full speed, or a video render | `dj stems status`; set `config.json → stems.auto: false` and restart (`node dj.mjs start`), kill `separate.py`; render videos after the set. |
| `node dj.mjs stems` queued every track | Bare `stems` means "all" | Use `dj stems <id>`; the queue clears on a server restart with `stems.auto: false`. |
| `dj get` fails: "confirm you're not a bot" | YouTube wants a login | Export cookies (Netscape format) to `.dj/youtube-cookies.txt`; `dj get` and `produce/get-sample.mjs` pick it up. Keep that file private. |
| `n challenge solving failed` | yt-dlp needs a JS runtime | Already passed as `--js-runtimes node`; make sure `node` is on PATH, update yt-dlp (`node dj.mjs doctor --fix`). |
| Short clip "analysis failed" | Too short for BPM analysis | Keep samples in `.dj/produce/samples/` (produce/get-sample.mjs), not `library/`. |
| Two "Start engine" tabs fight | Only one client is the sound system | Close the extra tab or click Start engine where you want the audio. |
| Server restarted mid-set | Decks keep playing in the browser; plan/queue state is lost | `dj plan clear`, re-`queue`, reload nothing. Config changes need a restart (`node dj.mjs start` after stopping the old process). |
| Set script keeps going after "stop" | Background scripts survive on Windows | Find and kill by PID (`Get-CimInstance Win32_Process` filtered on the script name), then `dj pause <deck>` and `dj loop <deck> 0`. |

## Quick health check
```bash
node dj.mjs doctor            # ffmpeg, node, yt-dlp
node dj.mjs status            # engine connected? stale? what is live
node dj.mjs stems status      # separation load and free disk
node dj.mjs record status     # recording?
```
Server log: `.dj/server.log`. Tests: `node --test test/*.test.mjs test/server-*.mjs` (never touch `.dj/`).
