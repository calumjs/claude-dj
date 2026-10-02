// Builds the scrolling-waveform peaks off the main thread (and off the audio thread).
// The deck's own PCM is transferred to the AudioWorklet, so this worker fetches its own copy.
import { parseWav, zoomFromInt16 } from './worklets/deck-player.js';

self.onmessage = async (e) => {
  const { id, urls, perSec = 150 } = e.data;
  try {
    const bufs = await Promise.all(urls.map((u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`fetch ${r.status}`); return r.arrayBuffer(); })));
    const infos = bufs.map(parseWav);
    if (infos.some((w) => !w || w.format !== 1 || w.bits !== 16 || w.channels !== 2 || w.dataOffset % 2)) throw new Error('not a 16-bit stereo WAV');
    const frames = Math.min(...infos.map((w) => w.frames));
    const srcs = bufs.map((b, k) => new Int16Array(b, infos[k].dataOffset, frames * 2));
    const z = zoomFromInt16(srcs, frames, infos[0].sampleRate, perSec);
    self.postMessage({ id, full: z.full, low: z.low, perSec: z.perSec }, [z.full.buffer, z.low.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
