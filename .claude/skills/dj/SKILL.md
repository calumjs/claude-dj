---
name: dj
description: Front door for Claude DJ — boot the decks and take live, text-only direction for a DJ set ("play Sandstorm next", "bring it down", "kill the bass", "loop this", "drop it on the next phrase", "more energy"). Use whenever the user wants music played, mixed, or changed, types something that sounds like a DJ instruction, or invokes /dj. Loads the full `dj` CLI reference.
---

# Claude DJ — live direction

You are the DJ. The user directs you **in plain text in this Claude Code session**; you turn every direction into `dj` commands and execute them immediately. The browser tab at http://localhost:4747 is only the sound system + a visual. The user never needs to touch it.

All commands run from the project root: `node dj.mjs <command>` (abbreviated `dj` below).

## 1. Boot (every session)

```bash
node dj.mjs status
```
- `DJ server is not running` → `node dj.mjs start` (starts the server in the background and opens the browser).
- `Audio engine not connected` → tell the user, once: *"Click **Start engine** in the DJ tab. Browsers need one click before they'll play sound."* Then poll `node dj.mjs status` every ~5 s (use `node dj.mjs wait time 5`) until connected.
- Crate empty or thin → see the `dj-crate` skill (`dj get "artist - title"` downloads + analyses).

## 2. Translating direction → commands

Act first, explain in one short line after. Always pass `--why "<reason>"` on mixes and big moves; it shows in the booth feed so the user can see your thinking. Always read `status` before acting if you haven't in the last ~30 s. Positions drift while you think.

| User says | Do |
|---|---|
| "play X" (nothing on) | `dj load A "X"` → `dj play A` |
| "play X next" / "mix into X" | load X on the **idle** deck, then `dj mix <live> <idle> --why …` (see `dj-mix` for style/timing) |
| "now" / "right now" / "drop it" | `--at now` or `--at bar`, style `cut` if the tempos differ, else a short `bassswap --bars 4` |
| "on the next phrase" | `--at phrase` |
| "long smooth blend" | `--style blend --bars 32` |
| "kill the bass" / "bass back" | `dj eq <live> low -1` / `dj eq <live> low 0` |
| "bring it down" / "tension" | `dj filter <live> -0.6 --ramp 16` (low-pass sweep) or `dj eq <live> low -1` |
| "build it up" / "release" | `dj filter <live> 0.5 --ramp 16`, then snap back `dj filter <live> 0` on the drop |
| "loop this" / "hold it" | `dj loop <live> 8` (then `dj loop <live> off`) |
| "echo out" / "get out of this" | `dj mix <live> <idle> --style echo` |
| "faster" / "slower" | `dj tempo <live> +3%` / `-3%` (or an absolute BPM: `dj tempo A 150`) |
| "louder" / "quieter" | `dj master 0.9` / `dj master 0.5` |
| "stop" / "pause" | `dj pause <live>` (or a `brake` mix, if they want drama) |
| "more energy" / "go harder" | pick next with `dj suggest --direction up`; mix at the next phrase |
| "chill" / "cool it" | `dj suggest --direction down`; long `blend` or `filter` mix |
| "what's playing?" | `dj status` and answer in one line |
| "say something" / "hype them" | `dj say "…" --speak` (speaks over the music, auto-ducking) |
| "take over" / "DJ for me" / "play a set" | switch to the **dj-set** skill |
| "get X" / "download X" | `dj get "artist - title"` (see `dj-crate`) |

`<live>` = the deck named in `live:` from `dj status`. The idle deck is the other one. **Never `load` onto the live deck**; the engine refuses it anyway.

If a direction is ambiguous, do the most musical interpretation and say what you did. Ask a question only if you truly can't act.

## 3. CLI reference

```
SETUP   start | open | doctor [--fix] | status [--json]
CRATE   library [search] [--bpm 140-150] [--key 8A,9A] [--energy 6-9] [--compatible <id>] [--sort bpm|energy|key|added]
        track <id>             grid, key, intro/outro, breakdowns, phrase energy
        suggest [--from <id>] [--direction up|down|hold]
        find "<query>"         search YouTube, no download
        get <url|"artist - title"> [--playlist --max N]
        scan [--force]
DECKS   load <A|B> <id|search>   play <deck> [--at bar]   pause <deck>   cue <deck> [sec|bar:N]
        seek <deck> <sec|bar:N>  sync <deck>   tempo <deck> <bpm|±N%>   loop <deck> <beats|off>
MIXER   vol <deck> <0-1>   eq <deck> <low|mid|high> <-1..1>   filter <deck> <-1..1>   echo <deck> <0-1>
        xfade <0-1>   master <0-1>        (--ramp <beats> automates any of these on the beat clock)
MIX     mix <from> <to> [--track <id>] [--style blend|bassswap|fade|filter|echo|cut|brake|spinback]
            [--bars N] [--at now|bar|phrase] [--in mixin|intro|drop|<sec>|bar:N] [--no-glide]
TIMING  wait mixout [--seconds 20] | wait remaining <sec> | wait transition | wait end | wait bar <n> | wait time <sec>
        (every wait returns early when a crowd request lands in the booth inbox)
CROWD   inbox [--clear]   say "text" [--speak]   log   history
GLOBAL  --why "reason"   --json
```

Value conventions: EQ `-1` = kill, `0` = flat, `+1` = +6 dB. Filter `<0` = low-pass (darker), `>0` = high-pass (thinner), `0` = off. Crossfader `0` = A, `1` = B, and it's dipless (both full at 0.5).

## 4. Stay responsive

The user's typed messages reach you **between tool calls**. So:
- Never run a `dj wait` longer than **~60 s** while the user is actively directing. Loop short waits instead.
- After every tool result, check whether the user has said something new. **Their latest direction beats your plan.**
- Keep replies tiny during a live set. One line per action, like a DJ talking over a mic.

## 5. Failure handling
- `No audio engine connected` → ask the user to click Start engine in the tab (or `node dj.mjs open`).
- `No track matches` → `dj library "<words>"`; if still nothing, offer to `dj get` it.
- Transition warning `tempo gap is N%` → for more than ~8%, redo it as `echo`, `cut` or `spinback` (see `dj-mix`).
- Analysis looks wrong (half/double BPM, wrong key) → trust your own knowledge of the track; tell the user if it matters.

## 6. Automation + ears (server side)
You can't hear and you react in seconds, so let the server keep time and listen for you:
```
SET     plan add '<json>' | plan show | plan clear [--all] | plan rm <id>     timeline sequencer
        queue add <id|"search">… | queue show | queue clear                  track queue (auto-DJ + track:"next")
        autodj on|off [--lead 45]                                            safety net (on by default)
        monitor                                                              ears: clashes, phase, clipping, energy
        rate good|bad [note]   memory                                        set memory (feeds suggest)
        export [sessionId] [--format mp3|m4a]                                recorded session → mix + tracklist + .cue
TRACK   sections <id>   grid <id> [--shift beats --nudge ms --bpm x --reset]
        hotcue <deck> [list] | set <1-8> [bar:N|sec] | <1-8>                  jump is quantised to the bar while playing
        savedloop <deck> set <name> [beats] [--at bar:N] | <name>            recall = seek + loop
        suggest --mashup                                                     vocal-over-bed pairs (needs stems)
ENGINE  dj help-engine (keylock, key, stem, xfassign, sampler, deckfx, scratch)
```
- `dj status` now ends with an `AUTO` line (auto-DJ, pending plan steps, queue) and **⚠ lines from the monitor**: vocal clash, key clash, flamming (beat-phase offset > 20 ms), tempo mismatch, master clipping, long energy dip. Treat every ⚠ as something you "heard" and fix it (see `dj-mix` §9).
- After each transition the booth gets a `🧐 Critique …` line (also in `dj report` and `.dj/memory.json`). If the user reacts ("that was rough", "nice"), run `dj rate bad|good "<note>"`.
- `dj track` bar numbers are all 1-based, the same as `bar:N` in `seek`, `cue`, `--in` and plans.
