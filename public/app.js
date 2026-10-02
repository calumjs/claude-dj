import { Mixer, DECKS, DECK_COLORS, STEMS, FX_TYPES, SCRATCH_PATTERNS, RPS } from './engine.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const mmss = (s) => (s == null || isNaN(s) ? '0:00' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);
const camelotColor = (c) => {
  const m = /^(\d+)([AB])$/.exec(c || '');
  if (!m) return '#666';
  return `hsl(${((Number(m[1]) - 1) * 30 + 90) % 360} ${m[2] === 'B' ? 75 : 65}% ${m[2] === 'B' ? 68 : 58}%)`;
};
const compatible = (a, b) => {
  const x = /^(\d+)([AB])$/.exec(a || ''), y = /^(\d+)([AB])$/.exec(b || '');
  if (!x || !y) return false;
  const d = Math.min((x[1] - y[1] + 12) % 12, (y[1] - x[1] + 12) % 12);
  return (x[2] === y[2] && d <= 1) || (x[2] !== y[2] && d === 0);
};

const clientId = sessionStorage.getItem('djClient') || `c${Math.random().toString(36).slice(2, 10)}`;
sessionStorage.setItem('djClient', clientId);

let mixer = null;
let isEngine = false;
let library = [];
let historyIds = new Set();
const tracks = new Map(); // id -> full track (with waveform)

// ------------------------------------------------------------------ decks C + D: cloned from A/B, hidden until loaded
(function buildExtraDecks() {
  for (const [n, tpl] of [['C', 'A'], ['D', 'B']]) {
    const el = $(`.deck[data-deck="${tpl}"]`).cloneNode(true);
    el.dataset.deck = n; el.classList.add('compact');
    $('.deck-letter', el).textContent = n;
    const tt = $('.tt', el); tt.width = tt.height = 240;
    $('#rig2').append(el);
    const st = $(`.strip[data-deck="${tpl}"]`).cloneNode(true);
    st.dataset.deck = n; st.classList.add('extra');
    $('.sname', st).textContent = n;
    if (n === 'C') $('.strips').prepend(st); else $('.strips').append(st);
  }
  for (const el of $$('.deck')) $('.xfa', el).value = el.dataset.deck === 'A' || el.dataset.deck === 'C' ? 'left' : 'right';
})();

// ------------------------------------------------------------------ server link
const post = (p, body) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

const es = new EventSource(`/api/events?client=${clientId}`);
es.addEventListener('hello', (e) => {
  const h = JSON.parse(e.data);
  $('#feed').innerHTML = '';
  h.log.forEach(addFeed);
  h.jobs.forEach(renderJob);
  if (h.recording && isEngine) startRecording();
  // server restarted while we were the engine: quietly re-claim
  if (isEngine && h.engineId !== clientId) { post('/api/engine/claim', { client: clientId }); setStatus('on', 'engine live'); return; }
  if (h.engineId && h.engineId !== clientId) $('#overlayMsg').innerHTML = 'Another tab is currently the sound system.<br>Start here to take over.';
});
es.addEventListener('log', (e) => {
  const entry = JSON.parse(e.data);
  addFeed(entry);
  if (entry.kind === 'system' && entry.text.startsWith('▶')) refreshHistory();
});
es.addEventListener('job', (e) => renderJob(JSON.parse(e.data)));
let libTimer;
es.addEventListener('library', () => { clearTimeout(libTimer); libTimer = setTimeout(loadLibrary, 400); });
es.addEventListener('engine', (e) => {
  const { id } = JSON.parse(e.data);
  if (id !== clientId && isEngine) {
    isEngine = false;
    for (const d of Object.values(mixer.decks)) d.stop();
    mixer.ctx.suspend();
    $('#overlayMsg').innerHTML = 'The engine moved to another tab.<br>Start here to take it back.';
    $('#startOverlay').classList.remove('hide');
  }
});
es.addEventListener('cmd', async (e) => {
  const { id, cmd, args } = JSON.parse(e.data);
  if (!isEngine) return;
  try {
    const h = handlers[cmd];
    if (!h) throw new Error(`unknown command ${cmd}`);
    const result = await h(args || {});
    await post('/api/ack', { id, ok: true, result: result ?? null, client: clientId, state: mixer.state() });
  } catch (err) {
    await post('/api/ack', { id, ok: false, error: err.message, client: clientId, state: mixer.state() });
  }
  pushState();
});
es.onerror = () => setStatus('warn', 'server unreachable');
es.addEventListener('record', (e) => { const { on } = JSON.parse(e.data); if (isEngine) { if (on) startRecording(); else stopRecording(); } });

// ---- flight recorder (engine side): telemetry every 200 ms + the master output as audio
let rec = null, telem = [], telemTimer = null, recSeq = 0;
function sampleTelemetry() {
  const buf = new Float32Array(mixer.analyser.fftSize);
  mixer.analyser.getFloatTimeDomainData(buf);
  let pk = 0; for (const v of buf) pk = Math.max(pk, Math.abs(v));
  const d = (x) => ({ p: +x.position().toFixed(3), on: x.playing ? 1 : 0, a: x.audible(), r: +x.rate.toFixed(4), id: x.track ? x.track.id : null, loop: x.loop ? x.loop.beats : 0 });
  const s = { t: Date.now(), pn: +performance.now().toFixed(1), ct: +mixer.ctx.currentTime.toFixed(4), lvl: +(20 * Math.log10(pk + 1e-6)).toFixed(1),
    xf: +mixer.xfader.value().toFixed(3), mv: +mixer.master.value().toFixed(2), st: mixer.ctx.state, hid: document.hidden ? 1 : 0,
    tr: mixer.transition ? mixer.transition.style : null, A: d(mixer.decks.A), B: d(mixer.decks.B) };
  for (const n of ['C', 'D']) if (mixer.decks[n].track) s[n] = d(mixer.decks[n]);
  telem.push(s);
}
function startRecording() {
  if (!mixer || rec) return;
  const dest = mixer.ctx.createMediaStreamDestination();
  mixer.out.connect(dest);
  const mr = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128000 });
  mr.ondataavailable = (ev) => { if (ev.data.size) fetch('/api/record/chunk?seq=' + (recSeq++) + '&t=' + Date.now(), { method: 'POST', body: ev.data }).catch(() => {}); };
  mr.start(1000);
  rec = { mr, dest };
  telemTimer = setInterval(() => {
    sampleTelemetry();
    if (telem.length >= 5) { const samples = telem; telem = []; post('/api/telemetry', { samples }).catch(() => {}); }
  }, 200);
}
function stopRecording() {
  if (!rec) return;
  clearInterval(telemTimer);
  if (telem.length) { post('/api/telemetry', { samples: telem }).catch(() => {}); telem = []; }
  rec.mr.stop();
  try { mixer.out.disconnect(rec.dest); } catch { /* ignore */ }
  rec = null;
}

function pushState() {
  if (!isEngine || !mixer?.xfader) return;
  post('/api/state', { client: clientId, state: mixer.state() }).catch(() => {});
}
setInterval(pushState, 400);

// audio-clock watchdog: if the AudioContext stops advancing, the OS/browser starved the audio thread
let wdLast = null;
setInterval(() => {
  if (!mixer || !isEngine) return;
  const now = { wall: performance.now(), ct: mixer.ctx.currentTime };
  if (wdLast) {
    const wallDt = (now.wall - wdLast.wall) / 1000, ctDt = now.ct - wdLast.ct;
    if (wallDt - ctDt > 0.3) post('/api/say', { text: `⚠ Audio engine stalled for ${(wallDt - ctDt).toFixed(1)}s (browser/OS starved the audio thread). state=${mixer.ctx.state}, hidden=${document.hidden}` }).catch(() => {});
  }
  wdLast = now;
}, 250);

// ------------------------------------------------------------------ commands from Claude
const deckOf = (name) => {
  const d = mixer.decks[String(name).toUpperCase()];
  if (!d) throw new Error(`no deck "${name}" (A, B, C or D)`);
  return d;
};
const parsePos = (d, v) => {
  if (v == null || v === '') return null;
  const m = /^bar:(\d+)$/.exec(String(v));
  if (m) return d.posOfBeat((Number(m[1]) - 1) * 4);
  const n = Number(v);
  if (isNaN(n)) throw new Error(`bad position "${v}" (use seconds or bar:N)`);
  return n;
};
const rampSecs = (beats, d) => (beats ? (Number(beats) * 60) / (d?.effBpm || liveBpm() || 120) : 0);
const liveBpm = () => { const l = liveDeck(); return l ? l.effBpm : null; };
const liveDeck = () => Object.values(mixer.decks).filter((d) => d.playing).sort((a, b) => b.audible() - a.audible())[0];
function setCtl(ctl, value, ramp, d) {
  const secs = rampSecs(ramp, d);
  if (secs) ctl.ramp(Number(value), mixer.ctx.currentTime + 0.02, secs); else ctl.set(Number(value));
}
const onOff = (v) => !(v === false || v === 0 || /^(off|false|0|no)$/i.test(String(v)));
async function loadTrack(deck, track) {
  const d = deckOf(deck);
  tracks.set(track.id, track);
  renderDeckMeta(d);
  await d.load(track);
  renderDeckMeta(d);
  renderLibrary();
  return d;
}

const handlers = {
  async load({ deck, track, cue }) {
    const d = await loadTrack(deck, track);
    if (cue != null) { d.cuePoint = parsePos(d, cue); d.startPos = d.cuePoint; }
    return { deck: d.name, title: track.title, bpm: track.bpm, camelot: track.camelot, cue: +d.cuePoint.toFixed(2), stems: d.stemsLoaded, keylock: d.keylock, ...(d.warning ? { warning: d.warning } : {}) };
  },
  play({ deck, at }) {
    const d = deckOf(deck);
    if (!d.buffer) throw new Error(`deck ${d.name} is empty`);
    const o = mixer.other(d.name);
    if (at === 'bar' && o?.playing && o.track) {
      d.setRate(mixer.matchRate(d, o.effBpm));
      const nb = mixer.nextBoundary(o, 4);
      const phase = ((o.beatAt(o.position(nb.t)) % 4) + 4) % 4;
      const b = Math.round(d.beatAt(d.startPos) / 4) * 4 + phase;
      d.startSource(Math.max(0, d.posOfBeat(b)), nb.t);
      return { startsInSec: +(nb.t - mixer.ctx.currentTime).toFixed(2), synced: true, to: o.name };
    }
    d.play();
    return { playing: true };
  },
  pause({ deck }) { deckOf(deck).pause(); },
  cue({ deck, position }) {
    const d = deckOf(deck);
    const p = parsePos(d, position);
    if (p != null) { d.cuePoint = p; if (!d.playing) d.startPos = p; return { cue: p }; }
    d.pause(); d.startPos = d.cuePoint; return { cue: d.cuePoint };
  },
  seek({ deck, position }) { const d = deckOf(deck); d.seek(parsePos(d, position)); return { position: +d.position().toFixed(2) }; },
  sync({ deck }) { return mixer.sync(deckOf(deck).name); },
  tempo({ deck, value }) {
    const d = deckOf(deck);
    if (!d.track) throw new Error('deck is empty');
    const s = String(value);
    const rate = s.endsWith('%') ? 1 + Number(s.slice(0, -1)) / 100 : Number(s) / d.track.bpm;
    if (!isFinite(rate)) throw new Error('tempo must be a BPM like 128 or a pitch like +2%');
    d.setRate(rate);
    return { rate: +d.rate.toFixed(4), bpm: +d.effBpm.toFixed(2), keylock: d.keylock, effectiveCamelot: d.effectiveCamelot() };
  },
  eq({ deck, band, value, ramp }) { const d = deckOf(deck); setCtl(d.eq[band], value, ramp, d); },
  filter({ deck, value, ramp }) { const d = deckOf(deck); setCtl(d.filter, value, ramp, d); },
  vol({ deck, value, ramp }) { const d = deckOf(deck); setCtl(d.vol, value, ramp, d); },
  echo({ deck, value, ramp }) {
    const d = deckOf(deck);
    mixer.delay.delayTime.setValueAtTime(Math.min(3.9, (60 / (d.effBpm || 120)) * 0.75), mixer.ctx.currentTime);
    setCtl(d.echo, value, ramp, d);
  },
  xfade({ value, ramp }) { setCtl(mixer.xfader, value, ramp, liveDeck()); },
  master({ value }) { mixer.master.set(Number(value)); },
  loop({ deck, beats }) { const d = deckOf(deck); d.setLoop(Number(beats) || 0); return { loop: d.loop }; },
  async mix(args) {
    if (args.track) await loadTrack(args.to, args.track);
    return mixer.mix(args);
  },
  speak({ text }) { if ($('#ttsToggle').checked) mixer.speak(text); },

  // ---- key lock / key shift
  keylock({ deck, on = true }) {
    const d = deckOf(deck);
    d.setKeylock(on === 'toggle' ? !d.keylock : onOff(on));
    return { deck: d.name, keylock: d.keylock, camelot: d.track?.camelot, effectiveCamelot: d.effectiveCamelot() };
  },
  key({ deck, semitones }) {
    const d = deckOf(deck);
    const s = /^(reset|off)$/i.test(String(semitones)) ? 0 : Number(semitones);
    if (!isFinite(s) || Math.abs(s) > 6) throw new Error('semitones must be a number from -6 to +6');
    d.setKeyShift(s);
    return { deck: d.name, keyShift: d.keyShift, camelot: d.track?.camelot, effectiveCamelot: d.effectiveCamelot() };
  },
  // ---- stems
  stem({ deck, stem, value, ramp }) {
    const d = deckOf(deck);
    if (!d.stemsLoaded) throw new Error(`deck ${d.name} has no stems loaded${d.track?.stems ? ' (stem fetch failed — the full mix is playing)' : ' — this track has not been separated'}`);
    const names = stem === 'all' ? STEMS : [stem];
    if (!names.every((n) => STEMS.includes(n))) throw new Error(`stem must be ${STEMS.join('|')}|all`);
    const v = Number(value);
    if (!isFinite(v)) throw new Error('value must be 0..1');
    for (const n of names) setCtl(d.stem[n], v, ramp, d);
    return { deck: d.name, stems: d.state().stems };
  },
  // ---- mixer routing
  xfassign({ deck, side }) {
    const d = deckOf(deck);
    const s = { l: 'left', left: 'left', a: 'left', r: 'right', right: 'right', b: 'right', t: 'thru', thru: 'thru', through: 'thru', off: 'thru' }[String(side).toLowerCase()];
    if (!s) throw new Error('side must be left, right or thru');
    d.setXfSide(s);
    return { deck: d.name, side: d.xfSide };
  },
  // ---- sampler
  sample({ pad, at = 'beat', vol }) {
    const t = mixer.quantTime(at);
    const r = mixer.sampler.trigger(Number(pad), t, vol != null ? Number(vol) : 1);
    return { ...r, startsInSec: +(t - mixer.ctx.currentTime).toFixed(2) };
  },
  async sampler({ pad, load, from, beats }) {
    if (pad == null) return { pads: mixer.sampler.state() };
    if (!load) throw new Error('usage: sampler {pad: 1-8, load: trackId, from: sec|bar:N, beats}');
    const r = await mixer.sampler.capture(Number(pad), load, from, beats);
    renderPads();
    return r;
  },
  // ---- chop keyboard (the KEYS panel): grab a chop from a deck, play it at a pitch, record a loop
  async keys({ pad, grab, beats, stem, from, note, at, gain, loop, bars, quant, octave, hold }) {
    if (pad != null) KB.pad = Number(pad);
    if (quant) KB.quant = quant;
    if (octave != null) KB.octave = Number(octave);
    if (bars) KB.loop.bars = Number(bars);
    if (hold != null) KB.hold = onOff(hold);
    let r = {};
    if (grab) r = await mixer.sampler.grab(KB.pad, grab, beats ?? 1, stem || null, from ?? null);
    if (note != null) {
      const t = at ? mixer.quantTime(at) : kbTime();
      mixer.sampler.note(KB.pad, Number(note), t, gain != null ? Number(gain) : KB.gain);
      r = { ...r, note: Number(note), startsInSec: +(t - mixer.ctx.currentTime).toFixed(3) };
    }
    if (loop) loopSet(loop);
    renderPads(); renderKeys();
    return { ...r, keys: kbState() };
  },
  // ---- deck FX
  deckfx({ deck, type, amount, ramp }) {
    const d = deckOf(deck);
    const t = type ?? d.fx.type;
    if (!FX_TYPES.includes(t)) throw new Error(`type must be ${FX_TYPES.join('|')}`);
    d.fx.set(t, amount != null ? Number(amount) : undefined, rampSecs(ramp, d));
    return { deck: d.name, fx: { type: d.fx.type, target: amount != null ? Number(amount) : d.fx.ctl ? +d.fx.ctl.value().toFixed(2) : 0 } };
  },
  // ---- scratch
  scratch({ deck, pattern = 'baby', beats = 4, at = 'bar' }) {
    const d = deckOf(deck);
    if (!SCRATCH_PATTERNS.includes(pattern)) throw new Error(`pattern must be ${SCRATCH_PATTERNS.join('|')}`);
    const T = mixer.quantTime(at, d);
    const r = d.scratchPattern(pattern, Number(beats) || 4, T);
    return { deck: d.name, pattern, beats: Number(beats) || 4, startsInSec: +(T - mixer.ctx.currentTime).toFixed(2), durationSec: +(r.endsAt - T).toFixed(2) };
  },

  /** beat-accurate routine — see Mixer.perform in engine.js */
  perform({ steps, at = 'bar', ref }) { return mixer.perform({ steps, at, ref }); },
};

// ------------------------------------------------------------------ engine start
$('#startBtn').onclick = async () => {
  try {
    if (!mixer) { mixer = new Mixer(); await mixer.ctx.resume(); await mixer.init(); }
    else await mixer.ctx.resume();
  } catch (err) {
    $('#overlayMsg').textContent = `Audio engine failed to start: ${err.message}`;
    mixer = null;
    return;
  }
  isEngine = true;
  await post('/api/engine/claim', { client: clientId });
  $('#startOverlay').classList.add('hide');
  setStatus('on', 'engine live');
  pushState();
  wireControls();
  requestAnimationFrame(frame);
};
function setStatus(cls, txt) {
  const el = $('#engineStatus');
  el.className = `status ${cls}`;
  $('.txt', el).textContent = txt;
}

// ------------------------------------------------------------------ knobs
function makeKnob(el, { min, max, center, get, set }) {
  const size = 38, r = 14, cx = size / 2, cy = size / 2;
  el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="#0c0c11" stroke="#2a2a36" stroke-width="2"/>
    <path class="arc" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
    <line class="ptr" x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - r + 3}" stroke="#eee" stroke-width="2" stroke-linecap="round"/>
  </svg><span>${el.dataset.label}</span>`;
  el.style.color = 'var(--c)';
  const arc = $('.arc', el), ptr = $('.ptr', el);
  const toAng = (v) => -135 + ((v - min) / (max - min)) * 270;
  const pt = (a) => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)];
  let last = null;
  el.render = () => {
    const v = get();
    if (v === last) return; last = v;
    const a0 = toAng(center), a1 = toAng(v);
    const [x0, y0] = pt(Math.min(a0, a1)), [x1, y1] = pt(Math.max(a0, a1));
    arc.setAttribute('d', Math.abs(a1 - a0) < 0.5 ? '' : `M${x0} ${y0} A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} 1 ${x1} ${y1}`);
    ptr.setAttribute('transform', `rotate(${a1} ${cx} ${cy})`);
  };
  let drag = null;
  el.addEventListener('pointerdown', (e) => { drag = { y: e.clientY, v: get() }; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const v = Math.max(min, Math.min(max, drag.v + ((drag.y - e.clientY) / 150) * (max - min)));
    set(Math.abs(v - center) < (max - min) * 0.02 ? center : v);
  });
  el.addEventListener('pointerup', () => (drag = null));
  el.addEventListener('dblclick', () => set(center));
}

let wired = false;
function wireControls() {
  if (wired) return; wired = true;
  for (const strip of $$('.strip')) {
    const d = mixer.decks[strip.dataset.deck];
    for (const k of $$('.k', strip)) {
      const name = k.dataset.ctl;
      if (name === 'fx') {
        makeKnob(k, { min: 0, max: 1, center: 0, get: () => +(d.fx.ctl ? d.fx.ctl.value() : 0).toFixed(3), set: (v) => d.fx.ctl?.set(v) });
        k.ctlOf = () => d.fx.ctl;
        continue;
      }
      const ctl = name === 'filter' ? d.filter : name === 'echo' ? d.echo : d.eq[name];
      makeKnob(k, {
        min: name === 'echo' ? 0 : -1, max: 1, center: 0,
        get: () => +ctl.value().toFixed(3),
        set: (v) => {
          if (name === 'echo') mixer.delay.delayTime.setValueAtTime(Math.min(3.9, (60 / (d.effBpm || 120)) * 0.75), mixer.ctx.currentTime);
          ctl.set(v);
        },
      });
      k.ctlOf = () => ctl;
    }
    $('.fader', strip).oninput = (e) => d.vol.set(Number(e.target.value));
    $('.fxsel', strip).onchange = (e) => d.fx.set(e.target.value, 0.5);
  }
  $('#xfader').oninput = (e) => mixer.xfader.set(Number(e.target.value));
  $('#masterVol').oninput = (e) => mixer.master.set(Number(e.target.value));
  for (const el of $$('.deck')) {
    const d = mixer.decks[el.dataset.deck];
    $('.play', el).onclick = () => (d.playing ? d.pause() : d.buffer && d.play());
    $('.cue', el).onclick = () => { if (d.playing) { d.pause(); d.startPos = d.cuePoint; } else { d.cuePoint = d.startPos; } };
    $('.sync', el).onclick = () => { try { mixer.sync(d.name); } catch (e) { addFeed({ ts: Date.now(), kind: 'system', text: e.message }); } };
    $('.rate', el).oninput = (e) => d.setRate(Number(e.target.value));
    // loops: click = loop the block you are in (snapped to the loop length) · hold = momentary · shift+click = from the next bar
    for (const b of $$('.loops button', el)) {
      let downAt = 0, armed = false;
      b.onclick = null;
      b.onpointerdown = (e) => {
        e.preventDefault(); downAt = performance.now();
        const beats = Number(b.dataset.loop);
        if (d.loop?.beats === beats && !e.shiftKey) { d.setLoop(0); armed = false; return; }
        armed = true;
        if (e.shiftKey) d.setLoop(beats, mixer.nextBoundary(d, 4, 0.03).t, 'floor'); else d.setLoop(beats, undefined, 'block');
      };
      b.onpointerup = b.onpointerleave = () => { if (armed && performance.now() - downAt > 350) d.setLoop(0); armed = false; };
    }
    for (const b of $$('.jumps button', el)) b.onclick = () => { try { jumpTo(d, b.dataset.jump); } catch (e) { addFeed({ ts: Date.now(), kind: 'system', text: `⚠ ${e.message}` }); } };
    $('.keylock', el).onclick = () => d.setKeylock(!d.keylock);
    for (const b of $$('.ks', el)) b.onclick = () => d.setKeyShift(d.keyShift + Number(b.dataset.d));
    $('.ksv', el).ondblclick = () => d.setKeyShift(0);
    $('.slip', el).onclick = () => (d.slip = !d.slip);
    $('.xfa', el).onchange = (e) => d.setXfSide(e.target.value);
    for (const s of $$('.stems input', el)) s.oninput = (e) => d.stemsLoaded && d.stem[s.dataset.stem].set(Number(e.target.value));
    wireTurntable($('.tt', el), d);
    $('.overview', el).onclick = (e) => {
      if (!d.buffer) return;
      const r = e.currentTarget.getBoundingClientRect();
      d.seek(((e.clientX - r.left) / r.width) * d.buffer.duration);
    };
  }
  renderPads();
  renderKeys();
}

// ------------------------------------------------------------------ chop keyboard
// A pad becomes an instrument: grab a beat of whatever is playing (or just its vocal), play it from the computer
// keyboard at any pitch (A-K white keys, W-U black keys, Z/X octave), quantised or free, and record a loop of it.
const KB = { pad: 7, octave: 0, quant: 'off', hold: true, gain: 1, grabBeats: 1, grabStem: 'vocals', scale: 'on', active: new Map(),
  loop: { bars: 4, events: [], rec: false, on: false, t0: 0, secPerBeat: 60 / 128, timer: null, done: new Set() } };
const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17 };
const KEY_OF = Object.fromEntries(Object.entries(KEYMAP).map(([k, s]) => [s, k]));
const WHITES = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17], NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const kbState = () => ({ pad: KB.pad, octave: KB.octave, quant: KB.quant, hold: KB.hold, loop: { on: KB.loop.on, rec: KB.loop.rec, bars: KB.loop.bars, events: KB.loop.events.length } });
function kbTime() {
  const now = mixer.ctx.currentTime;
  const live = mixer.liveDeck();
  if (KB.quant === 'off' || !live?.track) return now + 0.005;
  if (KB.quant === 'beat') return mixer.quantTime('beat');
  const nb = mixer.quantTime('beat'), step = live.beatLen / live.rate / 4; // 1/16 grid
  let t = nb; while (t - step > now + 0.005) t -= step;
  return t;
}
const loopBeats = () => KB.loop.bars * 4;
function kbLoopBeat(t) { const L = KB.loop, lb = loopBeats(); return ((((t - L.t0) / L.secPerBeat) % lb) + lb) % lb; }
// ---- scale lock + chord HUD: the chop's detected root + the live track's key → notes snap to the scale
const CAM_MAJOR = { 1: 11, 2: 6, 3: 1, 4: 8, 5: 3, 6: 10, 7: 5, 8: 0, 9: 7, 10: 2, 11: 9, 12: 4 }; // Camelot nB → tonic pitch class
function keyInfo(cam) {
  const m = /^(\d{1,2})([AB])$/.exec(String(cam || '')); if (!m) return null;
  const major = m[2] === 'B', tonic = major ? CAM_MAJOR[m[1]] : (CAM_MAJOR[m[1]] + 9) % 12;
  const steps = major ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  return { cam, major, tonic, pcs: new Set(steps.map((s) => (tonic + s) % 12)), name: `${NOTE_NAMES[tonic]}${major ? '' : 'm'}` };
}
function liveKey() { const d = mixer.liveDeck(); return d?.track ? keyInfo(d.effectiveCamelot?.() || d.track.camelot) : null; }
function snapSemis(semis) {
  const p = mixer.sampler.pads[KB.pad - 1], key = liveKey();
  if (KB.scale !== 'on' || !key || p?.rootMidi == null) return semis;
  const pc = ((p.rootMidi + semis) % 12 + 12) % 12;
  if (key.pcs.has(pc)) return semis;
  for (const dlt of [-1, 1, -2, 2]) if (key.pcs.has((pc + dlt + 12) % 12)) return semis + dlt;
  return semis;
}
const chromaCache = new Map();
async function phraseChromaFor(id) {
  if (!chromaCache.has(id)) chromaCache.set(id, fetch(`/api/track/${encodeURIComponent(id)}/chroma`).then((r) => (r.ok ? r.json() : null)).then((j) => j?.phraseChroma || null).catch(() => null));
  return chromaCache.get(id);
}
function chordOf(vec) { // best major/minor triad template against a 12-bin chroma
  if (!vec) return null;
  let best = null;
  for (let r = 0; r < 12; r++) for (const [name, tri] of [['', [0, 4, 7]], ['m', [0, 3, 7]]]) {
    const s = tri.reduce((a, i) => a + vec[(r + i) % 12], 0) - 0.5 * vec.reduce((a, v) => a + v, 0) / 12 * 3;
    if (!best || s > best.s) best = { s, name: NOTE_NAMES[r] + name, pcs: new Set(tri.map((i) => (r + i) % 12)) };
  }
  return best;
}
async function hudTick() {
  const hud = $('#kbHud'); if (!hud || !mixer) return;
  const d = mixer.liveDeck(), key = liveKey(), p = mixer.sampler.pads[KB.pad - 1];
  let chord = null;
  if (d?.track) { const pc = await phraseChromaFor(d.track.id); const i = Math.floor((d.beatAt(d.position()) / 4) / 8); chord = chordOf(pc?.[i]); }
  const root = p?.rootMidi != null ? `${NOTE_NAMES[p.rootMidi % 12]}${Math.floor(p.rootMidi / 12) - 1}` : '?';
  hud.textContent = `chop ${root} · key ${key ? `${key.cam} ${key.name}` : '—'} · chord ${chord?.name || '—'}`;
  for (const k of $$('#keys .pk')) {
    const pcls = p?.rootMidi != null ? ((p.rootMidi + Number(k.dataset.semis) + 12 * KB.octave) % 12 + 12) % 12 : null;
    k.classList.toggle('scale', pcls != null && !!key?.pcs.has(pcls));
    k.classList.toggle('chord', pcls != null && !!chord?.pcs.has(pcls));
  }
}
setInterval(() => hudTick().catch(() => {}), 400);
function kbNoteOn(semis, when = kbTime(), key = null) {
  semis = snapSemis(semis);
  const h = mixer.sampler.note(KB.pad, semis, when, KB.gain);
  if (key) KB.active.set(key, h);
  if (KB.loop.rec) KB.loop.events.push({ b: +kbLoopBeat(when).toFixed(3), semis, dur: null, h, live: Math.floor((when - KB.loop.t0) / (loopBeats() * KB.loop.secPerBeat)) });
  markKey(semis, true);
  return h;
}
function kbNoteOff(key, semis) {
  const h = KB.active.get(key); if (!h) return;
  KB.active.delete(key);
  if (KB.hold) h.stop();
  if (KB.loop.rec) { const ev = KB.loop.events.find((e) => e.h === h); if (ev) { const lb = loopBeats(); ev.dur = +(((kbLoopBeat(mixer.ctx.currentTime) - ev.b + lb) % lb) || 0.25).toFixed(3); } }
  markKey(semis, false);
}
function markKey(semis, on) { const el = $(`#keys .pk[data-semis="${semis - 12 * KB.octave}"]`); if (el) el.classList.toggle('on', on); }
function loopSet(mode) {
  const L = KB.loop;
  if (mode === 'clear') { L.events = []; L.rec = false; L.on = false; }
  else if (mode === 'stop') { L.rec = false; L.on = false; }
  else if (mode === 'rec' || mode === 'play') {
    if (!L.on) { const live = mixer.liveDeck(); L.secPerBeat = live?.track ? live.beatLen / live.rate : 60 / 128; L.t0 = live?.track ? mixer.quantTime('bar') : mixer.ctx.currentTime + 0.05; L.done.clear(); }
    L.rec = mode === 'rec'; L.on = true;
  }
  if (L.on && !L.timer) L.timer = setInterval(loopTick, 40);
  if (!L.on && L.timer) { clearInterval(L.timer); L.timer = null; }
  renderKeys();
}
function loopTick() {
  const L = KB.loop; if (!L.on || !mixer) return;
  const now = mixer.ctx.currentTime, loopSec = loopBeats() * L.secPerBeat, ahead = 0.15;
  const cyc = Math.floor((now - L.t0) / loopSec);
  for (const c of [cyc, cyc + 1]) for (const [i, ev] of L.events.entries()) {
    if (ev.live === c) continue; // played live while being recorded this cycle
    const t = L.t0 + c * loopSec + ev.b * L.secPerBeat, key = `${c}:${i}`;
    if (t < now - 0.02 || t > now + ahead || L.done.has(key)) continue;
    L.done.add(key);
    try { const h = mixer.sampler.note(KB.pad, ev.semis, t, KB.gain); if (ev.dur) h.stop(t + ev.dur * L.secPerBeat); } catch { /* pad emptied */ }
  }
  if (L.done.size > 5000) L.done.clear();
}
// ---- section jumps: next break / drop / outro of a deck, landing on the next bar
function jumpTo(d, what) {
  const t = d.track; if (!t) throw new Error(`deck ${d.name} is empty`);
  const cur = d.beatAt(d.position()) / 4 + 1;
  const secs = (t.sections || []).filter((s) => s.startBar > cur + 0.5);
  let bar = null;
  if (what === 'breakdown') bar = secs.find((s) => s.label === 'breakdown')?.startBar ?? (t.breakdowns || []).map((b) => b.startBar).find((b) => b > cur + 0.5) ?? null;
  if (what === 'drop') bar = secs.find((s) => s.label === 'drop')?.startBar ?? (t.breakdowns || []).map((b) => b.endBar + 1).find((b) => b > cur + 0.5) ?? (t.hotcues?.[4]?.bar > cur + 0.5 ? t.hotcues[4].bar : null);
  if (what === 'outro') bar = t.outroStartBar > cur + 0.5 ? t.outroStartBar : null;
  if (!bar) throw new Error(`no ${what} ahead on ${d.name}`);
  const when = d.playing ? mixer.nextBoundary(d, 4, 0.03).t : mixer.ctx.currentTime;
  d.seekAt(d.posOfBeat((bar - 1) * 4), when);
  addFeed({ ts: Date.now(), kind: 'action', text: `⏭ ${d.name} → ${what} at bar ${bar}` });
}
const LOOP_KEYS = { 1: ['A', 4], 2: ['A', 8], 3: ['A', 16], 4: ['A', 32], 7: ['B', 4], 8: ['B', 8], 9: ['B', 16], 0: ['B', 32] };
window.addEventListener('keydown', (e) => {
  if (!mixer?.sampler || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (k in LOOP_KEYS) { const [deck, beats] = LOOP_KEYS[k], d = mixer.decks[deck]; if (d?.track) d.setLoop(d.loop?.beats === beats ? 0 : beats, undefined, 'block'); return; }
  if (k === '[' || k === ']') { const d = Object.values(mixer.decks).find((x) => x.loop) || mixer.liveDeck(); if (d?.loop) d.setLoop(Math.max(0.25, Math.min(64, d.loop.beats * (k === '[' ? 0.5 : 2))), undefined, 'block'); return; }
  if (k === 'z') { KB.octave = Math.max(-2, KB.octave - 1); renderKeys(); return; }
  if (k === 'x') { KB.octave = Math.min(2, KB.octave + 1); renderKeys(); return; }
  if (!(k in KEYMAP)) return;
  e.preventDefault();
  try { kbNoteOn(KEYMAP[k] + 12 * KB.octave, kbTime(), k); } catch (err) { addFeed({ ts: Date.now(), kind: 'system', text: `⚠ ${err.message}` }); }
});
window.addEventListener('keyup', (e) => { const k = e.key.toLowerCase(); if (k in KEYMAP) kbNoteOff(k, KEYMAP[k] + 12 * KB.octave); });
function renderKeys() {
  const wrap = $('#keys'); if (!wrap || !mixer?.sampler) return;
  const L = KB.loop, p = mixer.sampler.pads[KB.pad - 1];
  const opt = (vals, cur, fmt = (v) => v) => vals.map((v) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${fmt(v)}</option>`).join('');
  wrap.innerHTML = `
    <div class="krow">
      <span class="klabel">KEYS</span>
      <label>pad <select id="kbPad">${opt([1, 2, 3, 4, 5, 6, 7, 8], KB.pad)}</select></label>
      <span class="kchop" title="what is on the pad">${p?.buffer ? esc(p.name) : 'empty'}</span>
      <span class="ksep"></span>
      <label>grab <select id="kbBeats">${opt([0.5, 1, 2, 4], KB.grabBeats, (v) => `${v} beat${v === 1 ? '' : 's'}`)}</select></label>
      <label><select id="kbStem">${opt(['vocals', 'mix', 'drums', 'bass', 'other'], KB.grabStem)}</select></label>
      ${['A', 'B', 'C', 'D'].map((d) => `<button class="btn sm kgrab" data-deck="${d}" title="grab from deck ${d} at its playhead">↓ ${d}</button>`).join('')}
      <span class="ksep"></span>
      <label>quant <select id="kbQuant">${opt(['off', '16', 'beat'], KB.quant, (v) => (v === '16' ? '1/16' : v))}</select></label>
      <button class="btn sm ${KB.hold ? 'on' : ''}" id="kbHold" title="hold: the chop stops when you release the key">HOLD</button>
      <button class="btn sm ${KB.scale === 'on' ? 'on' : ''}" id="kbScale" title="scale lock: notes snap to the live track's key (needs the chop's root, detected on grab)">SCALE</button>
      <span class="khud" id="kbHud">—</span>
      <span class="koct" title="Z / X">oct ${KB.octave >= 0 ? '+' : ''}${KB.octave}</span>
      <label>vol <input type="range" id="kbGain" min="0" max="1.5" step="0.01" value="${KB.gain}"></label>
      <span class="ksep"></span>
      <label>loop <select id="kbBars">${opt([1, 2, 4, 8], L.bars, (v) => `${v} bar${v === 1 ? '' : 's'}`)}</select></label>
      <button class="btn sm ${L.rec ? 'rec' : ''}" id="kbRec">● REC</button>
      <button class="btn sm ${L.on && !L.rec ? 'on' : ''}" id="kbPlay">▶ LOOP</button>
      <button class="btn sm" id="kbStop">■</button>
      <button class="btn sm" id="kbClear">CLR</button>
      <span class="kevents">${L.events.length ? `${L.events.length} notes` : ''}</span>
    </div>
    <div class="piano">${[...Array(18).keys()].map((s) => {
      const white = WHITES.includes(s);
      const wi = WHITES.filter((w) => w < s).length; // whites before this key
      const style = white ? `left:${(wi * 100) / WHITES.length}%;width:${100 / WHITES.length}%` : `left:${(wi * 100) / WHITES.length - 100 / WHITES.length / 3.4}%;width:${100 / WHITES.length / 1.7}%`;
      return `<button class="pk ${white ? 'w' : 'b'}" data-semis="${s}" style="${style}" title="${NOTE_NAMES[s % 12]}"><i>${KEY_OF[s].toUpperCase()}</i>${white ? `<small>${NOTE_NAMES[s % 12]}</small>` : ''}</button>`;
    }).join('')}</div>`;
  $('#kbPad').onchange = (e) => { KB.pad = Number(e.target.value); renderKeys(); };
  $('#kbBeats').onchange = (e) => (KB.grabBeats = Number(e.target.value));
  $('#kbStem').onchange = (e) => (KB.grabStem = e.target.value);
  $('#kbQuant').onchange = (e) => (KB.quant = e.target.value);
  $('#kbBars').onchange = (e) => (KB.loop.bars = Number(e.target.value));
  $('#kbGain').oninput = (e) => (KB.gain = Number(e.target.value));
  $('#kbHold').onclick = () => { KB.hold = !KB.hold; renderKeys(); };
  $('#kbScale').onclick = () => { KB.scale = KB.scale === 'on' ? 'off' : 'on'; renderKeys(); };
  $('#kbRec').onclick = () => loopSet(KB.loop.rec ? 'play' : 'rec');
  $('#kbPlay').onclick = () => loopSet('play');
  $('#kbStop').onclick = () => loopSet('stop');
  $('#kbClear').onclick = () => loopSet('clear');
  for (const b of $$('.kgrab', wrap)) b.onclick = async () => {
    try { const r = await mixer.sampler.grab(KB.pad, b.dataset.deck, KB.grabBeats, KB.grabStem === 'mix' ? null : KB.grabStem); addFeed({ ts: Date.now(), kind: 'action', text: `🎹 grabbed ${r.beats} beat(s) of ${r.name} from ${r.deck} into pad ${r.pad}` }); renderPads(); renderKeys(); }
    catch (err) { addFeed({ ts: Date.now(), kind: 'system', text: `⚠ ${err.message}` }); }
  };
  for (const k of $$('.pk', wrap)) {
    const semis = () => Number(k.dataset.semis) + 12 * KB.octave;
    k.onmousedown = (e) => { e.preventDefault(); try { kbNoteOn(semis(), kbTime(), `m${k.dataset.semis}`); } catch (err) { addFeed({ ts: Date.now(), kind: 'system', text: `⚠ ${err.message}` }); } };
    k.onmouseup = k.onmouseleave = () => kbNoteOff(`m${k.dataset.semis}`, semis());
  }
}

function renderPads() {
  const wrap = $('#pads');
  if (!mixer?.sampler) return;
  wrap.innerHTML = mixer.sampler.pads.map((p) => `<button class="pad${p.buffer ? '' : ' empty'}" data-pad="${p.pad}" title="${p.buffer ? `pad ${p.pad}: ${esc(p.name)} (click = now, shift+click = next beat)` : `pad ${p.pad} is empty — dj sampler ${p.pad} --load <trackId> --from <sec> --beats 2`}"><i>${p.pad}</i>${esc(p.name)}</button>`).join('');
  for (const b of $$('.pad', wrap)) {
    b.onclick = (e) => {
      try { const t = mixer.quantTime(e.shiftKey ? 'beat' : 'now'); mixer.sampler.trigger(Number(b.dataset.pad), t); }
      catch (err) { addFeed({ ts: Date.now(), kind: 'system', text: err.message }); }
    };
  }
}

// ------------------------------------------------------------------ rendering
function renderDeckMeta(d) {
  const el = $(`.deck[data-deck="${d.name}"]`);
  const t = d.track;
  $('.title', el).textContent = t ? (d.loading ? `Loading… ${t.title}` : t.title) : 'No track';
  $('.artist', el).textContent = t ? t.artist || '' : 'Load something from the crate';
  $('.energy', el).textContent = t ? `E ${t.energy}` : 'E —';
  renderKeyChip(d, el);
  renderHotcues(d, el);
}

// ------------------------------------------------------------------ hot cue buttons (8 per deck)
// layout: 1 start · 2 first vocal · 3 chorus 1 · 4 main drop / chorus 2 · 5 breakdown · 6 mix-out · 7 chant/hook · 8 teaser
const CUE_COLORS = ['#e8e8f0', '#7ec3e7', '#7ee787', '#f2cc60', '#b392f0', '#f59e8b', '#ff7ab6', '#4fd1c5'];
const hotcuesOf = (t) => (t ? t.hotcues || t.cues?.hotcues || {} : {});
function renderHotcues(d, el) {
  const wrap = $('.hotcues', el); if (!wrap) return;
  const hc = hotcuesOf(d.track);
  const key = (d.track?.id || '') + JSON.stringify(hc);
  if (wrap.dataset.key === key) return;
  wrap.dataset.key = key;
  wrap.innerHTML = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
    const c = hc[n];
    const label = c ? String(c.label || 'cue').replace(/\s*\(auto\)$/, '') : '—';
    const tip = c ? `hot cue ${n}: ${label} · bar ${c.bar} · click = jump on the beat · shift+click = set here` : `hot cue ${n} is empty · shift+click = set it here`;
    return `<button class="hc${c ? '' : ' empty'}" data-n="${n}" style="--hc:${CUE_COLORS[n - 1]}" title="${esc(tip)}"><i>${n}</i><span>${esc(label)}</span>${c ? `<small>${c.bar}</small>` : ''}</button>`;
  }).join('');
  for (const b of $$('.hc', wrap)) b.onclick = async (e) => {
    if (!d.track) return;
    const n = Number(b.dataset.n);
    try {
      const r = await post('/api/hotcue', { deck: d.name, n, action: e.shiftKey ? 'set' : 'jump' });
      if (!r.ok) throw new Error(r.error || 'hot cue failed');
      if (e.shiftKey) { // show the new cue straight away
        const cur = hotcuesOf(d.track);
        d.track.hotcues = { ...cur, [n]: { sec: r.result.sec, bar: r.result.bar, label: r.result.label || null } };
        renderHotcues(d, el);
      }
    } catch (err) { addFeed({ ts: Date.now(), kind: 'system', text: `⚠ ${err.message}` }); }
  };
}
function renderKeyChip(d, el) {
  const t = d.track, key = $('.key', el);
  const eff = t ? d.effectiveCamelot() || t.camelot : null;
  const txt = t ? (eff && eff !== t.camelot ? `${eff} ← ${t.camelot}` : `${t.camelot} · ${t.key}`) : '—';
  if (key.textContent !== txt) { key.textContent = txt; key.style.background = t ? camelotColor(eff) : ''; }
}

function drawOverview(canvas, d, color) {
  const w = (canvas.width = canvas.clientWidth * devicePixelRatio), h = (canvas.height = canvas.clientHeight * devicePixelRatio);
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  const t = d.track;
  if (!t?.waveform || !w) return;
  const { peaks, lows } = t.waveform;
  const dur = d.buffer?.duration || t.duration;
  const X = (sec) => (sec / dur) * w;
  // breakdowns + outro shading
  g.fillStyle = '#ffffff08';
  for (const b of t.breakdowns || []) g.fillRect(X(b.start), 0, X(b.drop) - X(b.start), h);
  g.fillStyle = '#f2cc6012';
  g.fillRect(X(t.mixOut), 0, w - X(t.mixOut), h);
  const pos = d.position();
  const n = peaks.length, bw = w / n;
  const mx = Math.max(...peaks) || 1;
  for (let i = 0; i < n; i++) {
    const x = i * bw, played = (i / n) * dur < pos;
    const ph = (peaks[i] / mx) * h * 0.46, lh = (lows[i] / mx) * h * 0.46;
    g.fillStyle = played ? '#3a3a48' : '#5b5b70';
    g.fillRect(x, h / 2 - ph, Math.max(1, bw), ph * 2);
    g.fillStyle = played ? '#55555f' : color;
    g.fillRect(x, h / 2 - lh, Math.max(1, bw), lh * 2);
  }
  g.fillStyle = '#f2cc60';
  g.fillRect(X(t.mixOut), 0, 2 * devicePixelRatio, h);
  g.fillStyle = '#fff';
  g.beginPath(); const cx = X(d.cuePoint); g.moveTo(cx - 5, 0); g.lineTo(cx + 5, 0); g.lineTo(cx, 7); g.fill();
  // hot cue markers along the bottom edge
  g.font = `${9 * devicePixelRatio}px JetBrains Mono, monospace`;
  for (const [n, c] of Object.entries(hotcuesOf(t))) {
    if (!c || c.sec == null) continue;
    const x = X(c.sec);
    g.fillStyle = CUE_COLORS[n - 1] || '#fff';
    g.fillRect(x, h - 10 * devicePixelRatio, 2 * devicePixelRatio, 10 * devicePixelRatio);
    g.fillText(String(n), x + 3 * devicePixelRatio, h - 2 * devicePixelRatio);
  }
  g.fillStyle = '#fff';
  g.fillRect(X(pos) - 1, 0, 2 * devicePixelRatio, h);
  const lp = d.loop;
  if (lp) { g.fillStyle = '#7ee78733'; g.fillRect(X(lp.start), 0, X(lp.end) - X(lp.start), h); }
}

function drawScroll(canvas) {
  const w = (canvas.width = canvas.clientWidth * devicePixelRatio), H = (canvas.height = canvas.clientHeight * devicePixelRatio);
  const g = canvas.getContext('2d');
  g.fillStyle = '#060608'; g.fillRect(0, 0, w, H);
  const lanes = DECKS.filter((n) => mixer.decks[n].track);
  const pps = 110 * devicePixelRatio; // pixels per real second
  const cx = w / 2;
  if (!lanes.length) {
    g.fillStyle = '#333'; g.font = `${11 * devicePixelRatio}px JetBrains Mono`;
    g.fillText('load a track to see it here', 12, H / 2);
  }
  lanes.forEach((name, li) => {
    const d = mixer.decks[name], color = DECK_COLORS[name];
    const top = (li * H) / lanes.length, h = H / lanes.length, mid = top + h / 2;
    g.fillStyle = li % 2 ? '#0a0a0e' : '#08080b'; g.fillRect(0, top, w, h);
    g.fillStyle = '#ffffff99'; g.font = `600 ${10 * devicePixelRatio}px JetBrains Mono`;
    if (!d.zoom) { g.fillStyle = '#444'; g.fillText(`${name}  ${d.loading ? 'loading…' : 'building waveform…'}`, 8 * devicePixelRatio, mid); return; }
    const pos = d.position(), rate = Math.abs(d.rate) || 1, z = d.zoom;
    const gain = 1 / (Math.max(...(d.track?.waveform?.peaks || [1])) || 1);
    const audible = d.playing ? Math.max(0.35, d.audible()) : 0.35;
    // beat grid
    const tLeft = pos - (cx / pps) * rate, tRight = pos + ((w - cx) / pps) * rate;
    for (let b = Math.ceil(d.beatAt(tLeft)); d.posOfBeat(b) < tRight; b++) {
      const x = cx + ((d.posOfBeat(b) - pos) / rate) * pps;
      g.fillStyle = b % 16 === 0 ? '#ffffff55' : b % 4 === 0 ? '#ffffff26' : '#ffffff0d';
      g.fillRect(x, top, b % 4 === 0 ? 2 : 1, h);
    }
    g.globalAlpha = audible;
    for (let x = 0; x < w; x += 2) {
      const t = pos + ((x - cx) / pps) * rate;
      const i = Math.floor(t * z.perSec);
      if (i < 0 || i >= z.full.length) continue;
      const fh = Math.min(1, z.full[i] * gain) * h * 0.45, lh = Math.min(1, z.low[i] * gain * 1.2) * h * 0.45;
      g.fillStyle = '#9a9ab0'; g.fillRect(x, mid - fh, 2, fh * 2);
      g.fillStyle = color; g.fillRect(x, mid - lh, 2, lh * 2);
    }
    g.globalAlpha = 1;
    const lp = d.loop;
    if (lp) {
      const x0 = cx + ((lp.start - pos) / rate) * pps, x1 = cx + ((lp.end - pos) / rate) * pps;
      g.fillStyle = '#7ee78722'; g.fillRect(x0, top, x1 - x0, h);
    }
    g.fillStyle = '#ffffff99'; g.font = `600 ${10 * devicePixelRatio}px JetBrains Mono`;
    g.fillText(name, 8 * devicePixelRatio, top + 14 * devicePixelRatio);
  });
  g.fillStyle = '#fff'; g.fillRect(cx - 1, 0, 2, H);
}

// ---- turntables: platter rotation is locked to the playback position (33⅓ rpm at 1x),
// so loops, rolls, spinbacks and scratches visibly move the record like the real thing.
function drawTurntable(canvas, d, color) {
  const g = canvas.getContext('2d'), W = canvas.width, c = W / 2, k = W / 340;
  g.clearRect(0, 0, W, W);
  // plinth
  g.fillStyle = '#16161d'; g.beginPath(); g.roundRect(4, 4, W - 8, W - 8, 22 * k); g.fill();
  g.strokeStyle = '#26263a'; g.lineWidth = 2; g.stroke();
  const R = W * 0.42;
  // platter with strobe dots
  g.fillStyle = d.handActive ? '#34343f' : '#2a2a33'; g.beginPath(); g.arc(c, c, R + 10 * k, 0, Math.PI * 2); g.fill();
  const pos = d.position(), ang = pos * RPS * Math.PI * 2;
  g.save(); g.translate(c, c); g.rotate(ang);
  g.fillStyle = '#8a8a99';
  for (let i = 0; i < 72; i++) { const a = (i / 72) * Math.PI * 2; g.fillRect(Math.cos(a) * (R + 6 * k) - 1.2, Math.sin(a) * (R + 6 * k) - 1.2, 2.4, 2.4); }
  // vinyl
  g.fillStyle = '#0b0b0e'; g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.fill();
  for (let r = R * 0.42; r < R - 2; r += 3.2 * k) { g.strokeStyle = `rgba(255,255,255,${0.025 + (r % 9 < 3 ? 0.02 : 0)})`; g.lineWidth = 1; g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke(); }
  // light sheen that rotates with the record
  const sheen = g.createLinearGradient(-R, -R, R, R);
  sheen.addColorStop(0.35, 'rgba(255,255,255,0)'); sheen.addColorStop(0.5, 'rgba(255,255,255,0.07)'); sheen.addColorStop(0.65, 'rgba(255,255,255,0)');
  g.fillStyle = sheen; g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.fill();
  // label
  const L = R * 0.36;
  g.fillStyle = d.track ? color : '#333'; g.beginPath(); g.arc(0, 0, L, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(0,0,0,0.75)'; g.fillRect(-L * 0.08, -L * 0.95, L * 0.16, L * 0.5); // cue marker
  g.fillStyle = '#000'; g.textAlign = 'center';
  g.font = `700 ${Math.round(L * 0.22)}px Space Grotesk, sans-serif`;
  const title = (d.track?.title || 'CLAUDE DJ').slice(0, 14);
  g.fillText(title, 0, L * 0.18);
  g.font = `500 ${Math.round(L * 0.15)}px Space Grotesk, sans-serif`;
  g.fillText((d.track?.artist || '').slice(0, 18), 0, L * 0.46);
  g.restore();
  // spindle
  g.fillStyle = '#ccc'; g.beginPath(); g.arc(c, c, 4 * k, 0, Math.PI * 2); g.fill();
  // tonearm: rests off the record when stopped/empty, tracks inward with progress
  const dur = d.buffer?.duration || 1, prog = d.track ? Math.min(1, pos / dur) : 0;
  const px = W - 26 * k, py = 30 * k;
  const armAng = d.track && (d.playing || pos > 0.5) ? 0.1 + prog * 0.35 : -0.06; // outer groove → label; rest is off the platter
  const len = W * 0.62;
  g.strokeStyle = '#b8b8c6'; g.lineWidth = 5 * k; g.lineCap = 'round';
  g.beginPath(); g.moveTo(px, py); g.lineTo(px - Math.sin(armAng) * len, py + Math.cos(armAng) * len * 0.92); g.stroke();
  const tx = px - Math.sin(armAng) * len, ty = py + Math.cos(armAng) * len * 0.92;
  g.fillStyle = '#e8e8f0'; g.save(); g.translate(tx, ty); g.rotate(armAng + 0.5); g.fillRect(-6 * k, -10 * k, 12 * k, 20 * k); g.restore();
  g.fillStyle = '#444'; g.beginPath(); g.arc(px, py, 14 * k, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#999'; g.beginPath(); g.arc(px, py, 5 * k, 0, Math.PI * 2); g.fill();
  // pitch readout + playing LED
  g.fillStyle = d.playing ? color : '#444'; g.beginPath(); g.arc(22 * k, W - 22 * k, 5 * k, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#8a8998'; g.font = `600 ${Math.round(15 * k)}px JetBrains Mono, monospace`; g.textAlign = 'right';
  const pct = (d.rate - 1) * 100; g.fillText(`${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%${d.keylock ? ' KL' : ''}`, W - 14 * k, W - 14 * k);
}

// drag the vinyl = scratch (the playhead follows your hand, backwards too; SLIP keeps the track on the grid);
// drag the platter rim = nudge (pitch bend, settles back on release)
function wireTurntable(canvas, d) {
  let drag = null;
  const geo = (e) => {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left - r.width / 2, y = e.clientY - r.top - r.height / 2;
    return { a: Math.atan2(y, x), rr: Math.hypot(x, y) / (r.width / 2) };
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!d.buffer) return;
    const g = geo(e), mode = g.rr > 0.84 ? 'nudge' : 'scratch';
    if (mode === 'scratch' && !d.grab()) return;
    drag = { mode, a: g.a, t: performance.now(), base: d.rate };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const g = geo(e), now = performance.now();
    let da = g.a - drag.a; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
    const dt = Math.max(4, now - drag.t) / 1000;
    if (drag.mode === 'scratch') {
      const dSec = da / (2 * Math.PI * RPS);
      d.handMove(dSec, Math.max(-12, Math.min(12, dSec / dt)));
    } else if (d.playing) {
      const bend = Math.max(-0.12, Math.min(0.12, (da / dt) * 0.02));
      d.setRate(drag.base * (1 + bend));
    }
    drag.a = g.a; drag.t = now;
  });
  const end = () => {
    if (!drag) return;
    if (drag.mode === 'scratch') d.release(); else d.setRate(drag.base);
    drag = null;
  };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
}

function drawMeter(canvas, analyser) {
  const g = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const db = 20 * Math.log10(peak + 1e-6), lvl = Math.max(0, Math.min(1, (db + 40) / 40));
  g.clearRect(0, 0, w, h);
  const grd = g.createLinearGradient(0, h, 0, 0);
  grd.addColorStop(0, '#3fb66b'); grd.addColorStop(0.75, '#f2cc60'); grd.addColorStop(1, '#ff5050');
  g.fillStyle = grd; g.fillRect(0, h * (1 - lvl), w, h * lvl);
}

let lastLive = null, lastSlow = 0;
function frame() {
  if (!mixer) return;
  const now = performance.now();
  drawScroll($('#scroll'));
  let anyPlaying = false;
  const shown = { C: !!mixer.decks.C.track, D: !!mixer.decks.D.track };
  $('#rig2').classList.toggle('shown', shown.C || shown.D);
  $('.rig').classList.toggle('four', shown.C || shown.D);
  for (const el of $$('.deck')) {
    const d = mixer.decks[el.dataset.deck], color = DECK_COLORS[d.name];
    if (d.name === 'C' || d.name === 'D') { el.classList.toggle('shown', shown[d.name]); if (!shown[d.name]) continue; }
    drawOverview($('.overview', el), d, color);
    drawTurntable($('.tt', el), d, color);
    anyPlaying ||= d.playing;
    const t = d.track, pos = d.position();
    $('.play', el).classList.toggle('on', d.playing);
    $('.play', el).textContent = d.playing ? '❚❚' : '▶';
    $('.bpm', el).textContent = t ? d.effBpm.toFixed(1) : '—';
    const pct = (d.rate - 1) * 100;
    $('.pitch', el).textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    $('.time', el).textContent = mmss(pos);
    const dur = d.buffer?.duration;
    $('.remain', el).textContent = dur ? `-${mmss((dur - pos) / d.rate)}` : '-0:00';
    if (t) {
      const beats = d.beatAt(pos);
      $('.bar', el).textContent = `bar ${Math.floor(beats / 4) + 1}.${(((Math.floor(beats) % 4) + 4) % 4) + 1}`;
      const toOut = (t.mixOut - pos) / d.rate;
      const mo = $('.mixout', el);
      mo.textContent = d.playing ? (toOut > 0 ? `mix-out ${mmss(toOut)}` : 'in outro') : '';
      mo.classList.toggle('soon', d.playing && toOut < 30);
      renderKeyChip(d, el);
    }
    const lp = d.loop;
    for (const b of $$('.loops button', el)) b.classList.toggle('on', lp?.beats === Number(b.dataset.loop));
    const rate = $('.rate', el); if (document.activeElement !== rate) rate.value = d.rate;
    $('.keylock', el).classList.toggle('on', d.keylock);
    $('.ksv', el).textContent = d.keyShift > 0 ? `+${d.keyShift}` : String(d.keyShift);
    $('.slip', el).classList.toggle('on', d.slip);
    const xfa = $('.xfa', el); if (document.activeElement !== xfa) xfa.value = d.xfSide;
    $('.stems', el).classList.toggle('off', !d.stemsLoaded);
    for (const s of $$('.stems input', el)) {
      s.disabled = !d.stemsLoaded;
      if (document.activeElement !== s) s.value = d.stem[s.dataset.stem].value();
    }
  }
  const live = liveDeck();
  for (const el of $$('.deck')) el.classList.toggle('live', live?.name === el.dataset.deck);
  document.body.classList.toggle('playing', anyPlaying);
  $('#masterBpm').textContent = live ? live.effBpm.toFixed(1) : '—';
  for (const strip of $$('.strip')) {
    const d = mixer.decks[strip.dataset.deck];
    if (strip.classList.contains('extra')) { strip.classList.toggle('shown', !!d.track); if (!d.track) continue; }
    for (const k of $$('.k', strip)) { k.render?.(); k.classList.toggle('auto', !!k.ctlOf?.()?.automating?.()); }
    const f = $('.fader', strip); if (document.activeElement !== f) f.value = d.vol.value();
    const sel = $('.fxsel', strip); if (document.activeElement !== sel) sel.value = d.fx.type;
    drawMeter($('.meter', strip), d.analyser);
  }
  const xf = $('#xfader'); if (document.activeElement !== xf) xf.value = mixer.xfader.value();
  const tr = mixer.transition;
  $('#transitionInfo').textContent = tr ? `⟶ ${tr.style.toUpperCase()} ${tr.from}→${tr.to} · ${Math.max(0, (tr.endAt - Date.now()) / 1000).toFixed(0)}s` : '';
  const nowMs = Date.now();
  for (const b of $$('#pads .pad')) { const h = mixer.sampler.lastHit[b.dataset.pad - 1]; b.classList.toggle('hit', nowMs >= h && nowMs - h < 160); }
  if (now - lastSlow > 1000 || live?.name !== lastLive) { lastSlow = now; lastLive = live?.name; renderLibrary(); }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ crate
async function loadLibrary() {
  const r = await fetch('/api/library').then((x) => x.json());
  library = r.tracks;
  const st = r.status;
  $('#libCount').textContent = `${library.length} tracks${st.analyzing || st.queued ? ` · analysing ${st.analyzing + st.queued}` : ''}`;
  renderLibrary(true);
}
async function refreshHistory() {
  const h = await fetch('/api/history').then((x) => x.json());
  historyIds = new Set(h.map((x) => x.id));
}
let lastLibKey = '';
function renderLibrary(force) {
  const q = $('#search').value.trim().toLowerCase();
  const live = mixer?.xfader ? liveDeck() : null;
  const ref = live?.track;
  const loaded = mixer ? Object.values(mixer.decks).map((d) => d.track?.id) : [];
  const key = [q, ref?.id, loaded.join(), library.length, historyIds.size].join('|');
  if (!force && key === lastLibKey) return;
  lastLibKey = key;
  const terms = q.split(/\s+/).filter(Boolean);
  const rows = library.filter((t) => {
    const hay = `${t.artist} ${t.title} ${t.camelot} ${Math.round(t.bpm)} ${t.genre || ''}`.toLowerCase();
    return terms.every((w) => hay.includes(w));
  });
  $('#libEmpty').classList.toggle('hide', library.length > 0);
  $('#lib tbody').innerHTML = rows.map((t) => {
    const fitKey = ref && compatible(ref.camelot, t.camelot);
    const bpmOk = ref && Math.min(...[t.bpm, t.bpm * 2, t.bpm / 2].map((b) => Math.abs(b - live.effBpm) / live.effBpm)) < 0.06;
    const cls = [ref && t.id !== ref.id && fitKey && bpmOk ? 'match' : ref && (fitKey || bpmOk) ? 'near' : '', historyIds.has(t.id) ? 'played' : '', loaded.includes(t.id) ? 'loaded' : ''].join(' ');
    return `<tr class="${cls}" data-id="${t.id}">
      <td class="fit"></td>
      <td class="name">${esc(t.title)}${t.stems ? ' <span class="stemtag" title="stems available">STEMS</span>' : ''}<small>${esc(t.artist || '')}</small></td>
      <td>${t.bpm.toFixed(1)}</td>
      <td><span class="keychip" style="background:${camelotColor(t.camelot)}">${t.camelot}</span></td>
      <td><span class="ebar"><i style="width:${t.energy * 10}%"></i></span> ${t.energy}</td>
      <td>${mmss(t.duration)}</td>
      <td>${DECKS.map((n) => `<button class="ld ${n.toLowerCase()}" data-deck="${n}">${n}</button>`).join('')}</td></tr>`;
  }).join('');
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
$('#search').oninput = () => renderLibrary(true);
$('#lib').addEventListener('click', async (e) => {
  const b = e.target.closest('.ld'); if (!b || !mixer?.xfader) return;
  const id = b.closest('tr').dataset.id;
  try {
    const full = tracks.get(id) || (await fetch(`/api/track/${id}`).then((r) => r.json()));
    await loadTrack(b.dataset.deck, { ...full, url: `/audio/${id}` });
  } catch (err) { addFeed({ ts: Date.now(), kind: 'system', text: `⚠ ${err.message}` }); }
});

// ------------------------------------------------------------------ downloads
async function grab() {
  const input = $('#grabInput').value.trim(); if (!input) return;
  $('#grabInput').value = '';
  const r = await post('/api/download', { input, playlist: $('#grabPlaylist').checked });
  if (r.error) addFeed({ ts: Date.now(), kind: 'system', text: `⚠ ${r.error}` });
}
$('#grabBtn').onclick = grab;
$('#grabInput').onkeydown = (e) => e.key === 'Enter' && grab();
function renderJob(j) {
  let el = $(`#job-${j.id}`);
  if (!el) { el = document.createElement('div'); el.id = `job-${j.id}`; $('#jobs').prepend(el); }
  el.className = `job ${j.status}`;
  const label = j.tracks?.length ? j.tracks.map((t) => t.title).join(', ') : j.input;
  el.innerHTML = `<span>${esc(label)}</span><span class="bar"><i style="width:${Math.round((j.progress || 0) * 100)}%"></i></span><span>${j.status}${j.error ? ': ' + esc(j.error).slice(0, 60) : ''}</span>`;
  if (j.status === 'ready') setTimeout(() => el.remove(), 8000);
  if (j.status === 'error') setTimeout(() => el.remove(), 20000);
}

// ------------------------------------------------------------------ booth
function addFeed(e) {
  const el = document.createElement('div');
  el.className = `msg ${e.kind}`;
  el.innerHTML = `<time>${new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>${esc(e.text)}`;
  const feed = $('#feed');
  const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  feed.append(el);
  while (feed.children.length > 200) feed.firstChild.remove();
  if (stick) feed.scrollTop = feed.scrollHeight;
}
$('#ask').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#askInput').value.trim(); if (!text) return;
  $('#askInput').value = '';
  await post('/api/inbox', { text, from: 'you' });
};

loadLibrary();
refreshHistory();
