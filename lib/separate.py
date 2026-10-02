# Stem separation worker for Claude DJ (spawned by lib/stems.mjs).
#   python separate.py <input audio> <out dir> [threads] [model]
# Decodes with ffmpeg (no torchaudio needed -- there are no win-arm64 torchaudio wheels),
# runs demucs (htdemucs, 4 stems) on CPU, writes <out dir>/{vocals,drums,bass,other}.wav
# as 44.1 kHz 16-bit stereo. Prints "PROGRESS <0..1>" lines on stdout.
import os
import subprocess
import sys
import wave

threads = int(sys.argv[3]) if len(sys.argv) > 3 else 2
os.environ.setdefault("OMP_NUM_THREADS", str(threads))
os.environ.setdefault("MKL_NUM_THREADS", str(threads))

import numpy as np  # noqa: E402
import torch  # noqa: E402

torch.set_num_threads(threads)
try:
    torch.set_num_interop_threads(1)
except RuntimeError:
    pass

from demucs.apply import apply_model  # noqa: E402
from demucs.pretrained import get_model  # noqa: E402

SR = 44100


def say(msg):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def decode(path):
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-threads", "1", "-i", path, "-ac", "2", "-ar", str(SR), "-f", "f32le", "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if p.returncode != 0:
        raise RuntimeError("ffmpeg decode failed: " + p.stderr.decode(errors="replace")[-400:])
    a = np.frombuffer(p.stdout, dtype=np.float32)
    a = a[: len(a) - (len(a) % 2)].reshape(-1, 2).T.copy()  # (2, n)
    return torch.from_numpy(a)


def write_wav(path, x):
    pcm = (np.clip(x.T, -1.0, 1.0) * 32767.0).round().astype("<i2")  # (n, 2)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def main():
    src, out_dir = sys.argv[1], sys.argv[2]
    model_name = sys.argv[4] if len(sys.argv) > 4 else "htdemucs"
    os.makedirs(out_dir, exist_ok=True)
    model = get_model(model_name)
    model.eval()
    wav = decode(src)
    n = wav.shape[1]
    say("PROGRESS 0.01")
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    mix = (wav - mean) / std
    last = [0.0]

    def cb(d):
        if d.get("state") != "end":
            return
        models = max(1, d.get("models", 1))
        frac = (d.get("model_idx_in_bag", 0) + min(1.0, (d.get("segment_offset", 0) + 1) / n)) / models
        frac = min(0.98, 0.02 + 0.96 * frac)
        if frac - last[0] >= 0.01:
            last[0] = frac
            say("PROGRESS %.3f" % frac)

    with torch.no_grad():
        sources = apply_model(model, mix[None], shifts=1, split=True, overlap=0.25, progress=False, callback=cb)[0]
    sources = sources * std + mean
    for name, src_t in zip(model.sources, sources):
        write_wav(os.path.join(out_dir, name + ".wav"), src_t.numpy())
    say("PROGRESS 1")
    say("DONE " + ",".join(model.sources))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("ERROR %s\n" % e)
        sys.exit(1)
