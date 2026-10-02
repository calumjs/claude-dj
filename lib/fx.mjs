// Performance FX presets (beats from the anchor; see `perform` in public/app.js).
// Shared by the CLI (dj fx) and the server sequencer (plan steps with cmd "fx").
// ---------- performance presets (beats from the anchor; see `perform` in public/app.js)
export function FX(D, O) {
  const chop = (from, beats, pattern, c = 'vol', on = 1, off = 0, deck = D) => {
    const out = [];
    for (let i = 0; i < beats * 2; i++) out.push({ b: from + i / 2, d: deck, c, v: pattern[i % pattern.length] ? on : off, o: 0.015, s: 'linear' });
    return out;
  };
  return {
    // 8-bar loop-roll build: 4→2→1→½→¼→⅛ with a rising high-pass, bass kill, echo, release on bar 9 (slip keeps the drop on time)
    rollup: [
      { b: 0, d: D, c: 'filter', v: 0.65, o: 30, s: 'in' },
      { b: 16, d: D, loop: 4 }, { b: 20, d: D, loop: 2 }, { b: 24, d: D, loop: 1 },
      { b: 24, d: D, c: 'low', v: -1, o: 2 },
      { b: 26, d: D, loop: 0.5 }, { b: 29, d: D, loop: 0.25 },
      { b: 28, d: D, c: 'echo', v: 0.5, o: 2 },
      { b: 32, d: D, loop: 0 }, { b: 32, d: D, c: 'filter', v: 0 }, { b: 32, d: D, c: 'low', v: 0 }, { b: 32, d: D, c: 'echo', v: 0 },
    ],
    // 4-bar roll (shorter build)
    roll: [
      { b: 0, d: D, c: 'filter', v: 0.5, o: 14, s: 'in' },
      { b: 8, d: D, loop: 1 }, { b: 12, d: D, loop: 0.5 }, { b: 14, d: D, loop: 0.25 },
      { b: 12, d: D, c: 'low', v: -1, o: 1 },
      { b: 16, d: D, loop: 0 }, { b: 16, d: D, c: 'filter', v: 0 }, { b: 16, d: D, c: 'low', v: 0 },
    ],
    // transformer-style volume chops on 8ths for 2 bars, then a stutter
    chop: [...chop(0, 6, [1, 0, 1, 1, 0, 1, 1, 0]), ...chop(6, 2, [1, 0]), { b: 8, d: D, c: 'vol', v: 1 }],
    // crossfader cuts between both decks (needs both playing)
    scratchcut: [...chop(0, 8, [1, 0, 0, 1, 0, 0, 1, 0], 'xfade', D === 'A' ? 1 : 0, D === 'A' ? 0 : 1, null).map((s) => ({ ...s, d: undefined })), { b: 8, c: 'xfade', v: D === 'A' ? 0 : 1 }],
    // filter wobble: low-pass pumping on half beats for 4 bars
    wobble: [...Array.from({ length: 16 }, (_, i) => ({ b: i, d: D, c: 'filter', v: i % 2 ? -0.1 : -0.45, o: 0.9, s: 'smooth' })), { b: 16, d: D, c: 'filter', v: 0, o: 0.5 }],
    // EQ kill dance: bass, mids, highs one by one, then everything back on the bar
    kills: [
      { b: 0, d: D, c: 'low', v: -1 }, { b: 4, d: D, c: 'low', v: 0 }, { b: 4, d: D, c: 'mid', v: -1 },
      { b: 8, d: D, c: 'mid', v: 0 }, { b: 8, d: D, c: 'high', v: -1 }, { b: 10, d: D, c: 'low', v: -1 },
      { b: 12, d: D, c: 'mid', v: -1 }, { b: 12, d: D, c: 'high', v: 0 }, { b: 12, d: D, c: 'filter', v: 0.5, o: 4, s: 'in' },
      { b: 16, d: D, c: 'low', v: 0 }, { b: 16, d: D, c: 'mid', v: 0 }, { b: 16, d: D, c: 'filter', v: 0 },
    ],
    // echo throw: send the last beat into the delay, drop out for a bar, slam back in
    throw: [
      { b: 0, d: D, c: 'echo', v: 1, o: 1, s: 'in' }, { b: 1, d: D, c: 'vol', v: 0 },
      { b: 1, d: D, c: 'filter', v: 0.4 },
      { b: 4, d: D, c: 'vol', v: 1 }, { b: 4, d: D, c: 'echo', v: 0 }, { b: 4, d: D, c: 'filter', v: 0 },
    ],
    // dark sweep down and back up over 4 bars
    sweep: [{ b: 0, d: D, c: 'filter', v: -0.75, o: 8, s: 'smooth' }, { b: 8, d: D, c: 'filter', v: 0, o: 8, s: 'in' }],
  };
}

export const FX_DEFAULT_AT = { rollup: 'drop', roll: 'drop', throw: 'phrase-end', chop: 'phrase-end', scratchcut: 'phrase-end', kills: 'phrase', sweep: 'phrase', wobble: 'phrase' };
