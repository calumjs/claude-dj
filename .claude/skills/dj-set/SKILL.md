---
name: dj-set
description: Play a whole live DJ set on autopilot with Claude DJ while staying steerable by text — plan an energy arc, pick each next track harmonically, time every mix to the phrase, react to typed directions from the user and to crowd requests from the booth. Use when the user says "play a set", "DJ for me", "take over", "30 minutes of hardstyle", "warm-up set", or invokes /dj-set. Accepts an optional length, genre or vibe.
---

# Autopilot set: you DJ, the user steers

You run the set continuously. The user steers by typing in this Claude Code session at any time, e.g. "harder", "play Sandstorm", "no vocals", "wrap it up in 10". Crowd requests also arrive in the booth inbox from the browser. **Keep the music going and stay interruptible.**

Load the `dj` skill for the command reference, and `dj-mix` for transition craft.

## 0. Setup
1. `node dj.mjs status`. Boot the server or engine if needed (see the `dj` skill).
2. Read the brief: length, genre, vibe, start and end energy. If none was given, do a ~30 min set that builds to a peak and lands gently. **Don't ask. Start playing.**
3. `node dj.mjs library --sort bpm`. If the crate can't support the brief (fewer than about length/3.5 tracks that fit), fetch more first. See `dj-crate`: `dj get "artist - title"`, **extended/original mixes preferred**. Do this in batches while the first track plays, not before.

## 1. Plan the arc (keep it in your head; revise freely)
- **Warm-up** (first ~20%): energy 4–6, longer blends (16–32 bars).
- **Build** (~40%): energy climbs one step every 1–2 tracks. Harmonic neighbours, tempo creeping up at most 2–3 BPM per track.
- **Peak** (~25%): energy 8–10, drop-to-drop `bassswap --in drop`, the occasional energy-boost key (+2) and bigger moments (`echo`, `cut`).
- **Land** (last ~15%): step energy down, finish with a long `fade` or a big closing anthem.

Announce the plan in **two lines max**, then start.

## 2. The loop

```
start:  load first track on A → play A → dj say "<short intro>" (optionally --speak)
repeat:
  1. next = choose(dj suggest --direction <up|hold|down per arc>)  + your own musical judgement
  2. dj load <idle> <next.id>
  3. dj track <next.id>                      # decide style, bars, --in (dj-mix)
  4. wait for the mix point in SHORT chunks:
        dj wait mixout --seconds <lead> --timeout 60
     → reason = timeout?  loop step 4 again (the user may have typed something; check!)
     → reason = inbox?    handle the crowd request (section 3), then continue
     → reason = mixout?   go to 5
  5. dj mix <live> <idle> --style … --bars … --at phrase --in … --why "<one-line musical reason>"
  6. dj wait transition --timeout 60
  7. (optional, ~1 in 3 tracks) dj say "<crowd-facing line>"
  8. brief one-line update to the user in chat: "→ Dragonborn (150, 9B), bass-swapped to the drop."
```

`<lead>` = transition seconds + 5 s. Compute it from `bars × 4 × 60 / bpm`.

**Every wait is ≤ 60 s.** The user's chat messages only reach you between tool calls, so long waits make you deaf. After each tool result, look for new user text first.

### Choosing the next track
Run `dj suggest --direction up|hold|down` (it excludes played and loaded tracks, scoring by key distance, tempo gap and energy step). Then apply judgement the scorer can't:
- Don't play two tracks by the same artist back to back. Vary vocals and instrumentals.
- Honour the brief's genre. Use your knowledge of the actual songs (anthems, classics, what the crowd knows).
- Save the biggest tunes for the peak.
- If nothing suitable is left, `dj get` something (downloads run while the current track plays; a track is typically ready in 15–40 s).

## 3. Steering: user text and crowd requests
Handle these **immediately**, even mid-wait.
- **Specific track** ("play X"): `dj library X`. If it's missing, `dj get "X"` (while the current track keeps playing). Make it the next track. If they say "now", mix at the next bar with a style appropriate to the gap (`dj-mix`).
- **Energy** ("harder", "chill", "slow it down"): shift the arc. The very next pick changes direction; add a live filter or EQ move now if it helps (`dj filter <live> -0.5 --ramp 8` for "chill").
- **Time** ("wrap it up in 10 min"): re-plan so the landing fits. Consider shortening tracks by mixing earlier (`--at phrase` before the outro).
- **Veto** ("not this", "skip"): mix out at the next bar (`echo` or `cut`) into the best ready option.
- **Crowd inbox** (`wait` returns `reason: inbox`, messages are printed): treat them as requests from the dancefloor. Honour them when they fit the vibe; acknowledge with `dj say` either way. Then `dj inbox --clear`.
- **Stop** ("stop", "that's it"): finish with a `brake` or a short `fade`, then `dj say` a sign-off.

## 4. Chat etiquette during a set
- One line per event. No essays and no command dumps unless asked.
- Your `--why` text is the running commentary. The user sees it in the browser booth, so make it read like a DJ's thought: *"Keeping 9B→10B, stepping energy up for the build."*
- When the set ends: `dj history`, then give the user the tracklist and one sentence on the arc.

## 5. Safety rails
- Never `load` onto the live deck. Always load the idle one.
- If `status` shows `Engine state is stale` or `not connected`, the tab may be closed or asleep. Tell the user and pause the loop.
- If the live track's `remaining` drops under the transition length and nothing is ready, do an `echo` mix to whatever is loaded, or `loop <live> 8` to buy time.

## 6. Let the server hold the timeline
- **Auto-DJ safety net** (`dj autodj`, on by default): if the live track gets down to **45 s of audible music** with no transition running and no planned mix, the server takes over. About 25 s earlier it cues the next track on the idle deck: first from `dj queue`, else the best `suggest`, never a recently played one. At 45 s it runs a safe mix itself: `bassswap 8 --in drop` (tempo gap ≤ 6 %, keys compatible), `filter 8` (keys clash) or `echo`. The booth shows `🤖 Auto-DJ: …`. It stays out of a set you are driving: any `dj mix` before then, a pending `plan` mix, or two audible decks keep it off. A track you already loaded on the idle deck is the one it uses. The dead-air guard (loop the last bars at 9 s left) is still the last resort.
- **Queue ahead**: when you pick the next 2–3 tracks, `dj queue add <id> <id> …`. The auto-DJ and plan steps with `"track": "next"` take from it; a track leaves the queue when it goes on air.
- **Plan the mix instead of waiting for it.** Rather than a chain of `wait` calls, schedule the move once and stay responsive:
  ```bash
  node dj.mjs plan add '{"when":{"deck":"A","beforeMixout":30},"cmd":"mix","args":{"to":"B","style":"bassswap","bars":8,"in":"drop"},"why":"9A→9A drop-to-drop"}'
  node dj.mjs plan add '[{"when":{"deck":"A","bar":97},"cmd":"fx","args":{"name":"rollup","deck":"A"}},{"when":{"after":"p2","sec":20},"cmd":"say","args":{"text":"Make some noise!"}}]'
  ```
  - `when` is one of: `{deck, bar}` · `{deck, beforeMixout: s}` · `{deck, beforeEnd: s}` · `{after: stepId, sec}` · `{at: epochMs}`. Add an optional `"track"` guard to fire only while that track is on the deck.
  - `cmd` is any deck/mixer command (`mix`, `load`, `play`, `perform`, `eq`, `filter`, `vol`, `echo`, `xfade`, `loop`, `stem`, `key`, …), or `fx`, `hotcue`, `savedloop`, `say`, `queue`, `autodj`.
  - The server fires each step about 1 bar early; the command's own `--at` anchoring lands it on time. Defaults: `phrase` for mix/perform/fx, `bar` when you target a bar. Knob moves become a one-step perform on the bar.
  - `mix` fills in `from` = live and `to` = the idle deck. `"track":"next"` takes the next track from the queue.
  - `dj plan show` lists steps with ETAs. Every firing shows in the booth and the flight recorder.
- **The loop becomes:** pick next → `dj queue add` → `dj plan add` the mix (or let the auto-DJ do it) → `dj wait transition --timeout 60` / `dj status` for ⚠ lines → react.
- After a mix, read the `🧐 Critique` line (`dj log`). Rate it when the user comments (`dj rate good|bad "<note>"`). `dj memory` shows the pairings that worked, and `suggest` already favours them.
- **End of the set:** `dj record stop` → `dj report` → `dj export`. This gives the user an mp3 plus a timestamped tracklist and a `.cue` in `.dj/exports/`.
