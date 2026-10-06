# -*- coding: utf-8 -*-
"""
Chart quality check.

Measures a generated chart against the audio it was derived from:

  1. global time alignment  — cross-correlate note times with the onset
                              envelope.  A peak away from 0 means the whole
                              chart is shifted, which is exactly what "the notes
                              do not land on the music" looks like.
  2. hit precision          — how many notes sit on a real onset
  3. onset recall           — how many strong onsets a note covers
  4. metrical placement     — where notes fall within the beat / bar

Usage:  python tools/chart-check.py [chart.json] [--difficulty expert]
"""

import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "an", os.path.join(os.path.dirname(os.path.abspath(__file__)), "analyze.py"))
an = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(an)


def onset_envelope(path):
    """The same tight percussive envelope the chart generator uses."""
    x, sr = an.read_wav_mono(path)
    mag = an.stft_mag(x, an.N_FFT_B, an.HOP_B)
    e = np.concatenate([np.zeros(1, np.float32),
                        np.maximum(np.diff(mag, axis=0), 0.0).sum(axis=1)])
    e = np.convolve(e, np.ones(an.PERC["smooth"], np.float32) / an.PERC["smooth"], mode="same")
    return e, an.FPS_B, len(x) / sr


def beat_phase_check(env, fps, bpm, off):
    """
    Where does the *audio* put its energy inside the bar?

    The chart's `offset` is also used to draw the scrolling beat lines, so if it
    is a sixteenth out the grid looks wrong even when the notes are on time.
    This prints the energy histogram over the 16 sixteenths of a bar and the
    phase that would put the most energy on the beat.
    """
    beat = 60.0 / bpm
    t = np.arange(len(env)) / fps
    pos = ((t - off) / beat) % 4.0
    # +epsilon before flooring: a note sitting exactly on a slot boundary lands
    # on 3.9999999 in float and would otherwise be counted one slot low
    slot = np.floor(pos * 4 + 1e-6).astype(int) % 16
    hist = np.bincount(slot, weights=env, minlength=16)
    hist = hist / (hist.sum() + 1e-9)

    print("  audio energy by 1/16 slot within the bar:")
    print("    " + " ".join("%4.1f" % (h * 100) for h in hist))
    print("    " + " ".join(("  ^" if i % 4 == 0 else "   ") for i in range(16)))

    # which rotation of the 16-slot ring puts the most energy on beats?
    best = None
    for rot in range(16):
        rolled = np.roll(hist, -rot)
        onbeat = rolled[0::4].sum()
        if best is None or onbeat > best[1]:
            best = (rot, onbeat)
    print("    current offset puts %.1f%% of the energy on a beat" % (hist[0::4].sum() * 100))
    print("    rotating by %d/16 (%.0f ms) would give %.1f%%"
          % (best[0], best[0] * beat / 4 * 1000, best[1] * 100))
    return best[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("chart", nargs="?", default=os.path.join(an.ROOT, "src", "chart", "雨爱.json"))
    ap.add_argument("--difficulty", default="hard")
    ap.add_argument("--wav", default=os.path.join(an.ROOT, "tools", "_analysis.wav"))
    args = ap.parse_args()

    if not os.path.exists(args.wav):
        an.decode(os.path.join(an.ROOT, "src", "雨爱.mp3"), args.wav)

    data = json.load(open(args.chart, encoding="utf-8"))
    meta = data["meta"]
    bpm = meta["bpm"]
    beat = 60.0 / bpm
    off = meta["offset"]
    tick = meta["tick"]

    env, fps, dur = onset_envelope(args.wav)
    # normalise for readability
    env = env / (env.max() + 1e-9)
    env_t = np.arange(len(env)) / fps

    def envelope_at(t):
        i = np.round(np.asarray(t) * fps).astype(int)
        ok = (i >= 0) & (i < len(env))
        return np.where(ok, env[np.clip(i, 0, len(env) - 1)], 0.0)

    print("chart      : %s" % os.path.basename(args.chart))
    print("difficulty : %s" % args.difficulty)
    print("audio      : %.2f s   bpm %.4f   beat %.4f s   offset %.4f s"
          % (dur, bpm, beat, off))
    print()
    beat_phase_check(env, fps, bpm, off)

    for name in [args.difficulty] + [d for d in ("easy", "hard", "expert", "extra")
                                     if d != args.difficulty]:
        notes = data["charts"].get(name)
        if not notes:
            continue
        t = off + np.array([n["t"] for n in notes], dtype=float) * tick
        print("\n=== %s : %d notes (%.2f/s) ===" % (name, len(t), len(t) / dur))

        # ---- 1. global alignment ---------------------------------------
        shifts = np.arange(-0.20, 0.2001, 0.002)
        scores = np.array([envelope_at(t + s).mean() for s in shifts])
        # baseline = what a random time would score
        base = env.mean()
        best = shifts[int(np.argmax(scores))]
        at0 = scores[int(np.argmin(np.abs(shifts)))]
        top = scores.max()
        print("  alignment   : best shift %+.0f ms   (score %.4f vs %.4f at 0 ms;"
              " random %.4f)" % (best * 1000, top, at0, base))
        # how much better is the chart than the same count of random times?
        rng = np.random.default_rng(0)
        rand = np.mean([envelope_at(rng.uniform(0, dur, len(t))).mean() for _ in range(40)])
        print("  lift vs random : %.2fx" % (at0 / max(rand, 1e-9)))

        # ---- 2. precision ----------------------------------------------
        # a note counts as precise when a real onset sits inside +-25 ms
        peaks = an.pick_peaks(env * (env.max() / max(env.max(), 1e-9)), fps, 0.07,
                              an.PERC["win"], an.PERC["mad_k"], an.PERC["floor"])
        pt = peaks / fps
        if len(pt):
            d = np.abs(t[:, None] - pt[None, :]).min(axis=1)
            for w in (0.025, 0.050, 0.0926):
                print("  notes within +-%4.1f ms of an onset : %5.1f%%"
                      % (w * 1000, 100 * (d < w).mean()))
        else:
            print("  (no onsets detected)")

        # ---- 3. recall --------------------------------------------------
        if len(t):
            d2 = np.abs(pt[:, None] - t[None, :]).min(axis=1)
            strong = env[peaks] > np.percentile(env[peaks], 60)
            print("  strong onsets covered by a note     : %5.1f%%"
                  % (100 * (d2[strong] < 0.0926).mean()))

        # ---- 4. metrical placement --------------------------------------
        # where inside the bar do the notes fall?  (in 1/16 of a beat)
        pos = ((t - off) / beat) % 4.0
        slots = np.floor(pos * 4 + 1e-6).astype(int) % 16
        hist = np.bincount(slots, minlength=16) / max(len(t), 1)
        print("  bar placement (1/16 grid, 4/4):")
        print("    " + " ".join("%4.1f" % (h * 100) for h in hist))
        print("    " + " ".join(("  ^" if i % 4 == 0 else "   ") for i in range(16)))
        # how close to *any* 1/16 position, i.e. how well quantised the chart is
        near = lambda mult: (np.abs((pos * mult) - np.round(pos * mult)) < 0.125).mean()
        print("    quantisation: beat %.1f%%   1/8 %.1f%%   1/16 %.1f%%"
              % (100 * near(1), 100 * near(2), 100 * near(4)))


if __name__ == "__main__":
    main()
