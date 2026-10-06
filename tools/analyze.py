# -*- coding: utf-8 -*-
"""
Offline chart generator for the "TongTou" 4K falling rhythm game.

Why two layers
--------------
A single onset detector cannot be both *periodicity-locked* and *dense*: on
dense, reverberant material the extra onsets a low threshold admits are mostly
off-grid (vocals, bow noise, reverb tails).  Measurements on 雨爱 with a
complex phase-concentration metric

    |z| = |mean(exp(2*pi*i*t/P))|     (1.0 = onsets perfectly on the grid,
                                       0.0 = onsets uniformly spread)

showed:

    detector                                  n     |z|    median |off|
    ------------------------------------------ ----  -----  -----------
    log-flux + HPSS + z-score whitening         745  0.49      62.6 ms
    log-flux, fine hop, median/MAD threshold    671  0.27      66.6 ms
    linear power flux, fine hop, strict         403  0.66      13.3 ms   <-- percussive
    linear power flux, strictest                221  0.87       7.8 ms

so the chart is built from two sources and quantized onto the fitted grid:

    percussive layer  linear power flux, strict   -> tight, definite notes
    melodic layer     log flux 400-3500 Hz        -> fills the chart out

Everything is then snapped to the 1/16-note grid of the fitted tempo, which is
safe precisely because the percussive layer's timing error (~13 ms) is far below
half a grid step (~46 ms at 162 BPM).

Output: src/chart/<title>.json
Requires numpy only; ffmpeg is taken from imageio_ffmpeg when present so the
source media never needs a manual pre-decode step.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import wave

import numpy as np

# --------------------------------------------------------------------------- #
# config
# --------------------------------------------------------------------------- #
SR = 22050
N_FFT = 2048
HOP = 256                      # coarse hop, ~11.6 ms   (spectral analysis)
FPS = SR / HOP
N_FFT_B = 1024
HOP_B = 64                     # fine hop, ~2.9 ms      (onset timing)
FPS_B = SR / HOP_B
TICK = 1.0 / 96.0              # 96 ticks per beat
JACK_S = 0.100                 # minimum same-lane spacing

# Nothing is charted before this many seconds.
#
# Two reasons.  First, a note inside the lead-in is already past its judgement
# window the moment playback starts, so it is an unavoidable miss the player can
# do nothing about.  Second, a fade-in produces a spurious onset near t=0 (see
# the energy gate on the melodic flux).
LEAD_IN = 1.0

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTDIR = os.path.join(ROOT, "src", "chart")

# The supplied BGA is a cover-version lyric video, so the original-artist credit
# would be misleading. Edit these lines to label a different track.
TRACK = {
    "title": "雨爱",
    "artist": "翻唱版",
    "audio": "../雨爱.mp3",
    "bga": "../雨爱.mp4",
}

# --------------------------------------------------------------------------- #
# show cues
# --------------------------------------------------------------------------- #
# Concert pyro ("爆火") bursts.  Two ways to address them, because note numbers
# are brittle: regenerating the chart changes every index downstream of an edit,
# which silently re-points the cue at different music.  Times are stable.
#
# FIRE_CUE_TIMES, when a difficulty has entries, wins over FIRE_CUES.
#
# A cue is snapped to the nearest note of the difficulty it is applied to, so
# the burst always coincides with a note reaching the judgement line.
FIRE_CUES = {
    "hard": [133, 168, 240, 318, 350, 422],
}
FIRE_CUE_TIMES = {
    # e.g. "hard": [38.26, 48.63, 68.63, 91.22, 100.11, 121.22]
    "hard": [],
}

# Auto mode: ignore the hand-written lists above and place the bursts on the
# song's real climaxes instead (loudest sustained sections with the most note
# activity), applied to every difficulty.
FIRE_AUTO = True
FIRE_AUTO_COUNT = 10
# Pick one climax per equal slice of the song instead of the global top-N.
# Global top-N always lands in the loudest section and leaves the first half
# with nothing; slicing guarantees the bursts are spread across the whole track
# while still choosing each section's own peak.
FIRE_AUTO_SPREAD = True
FIRE_AUTO_MIN_GAP = 11.0     # seconds between bursts (used when spread is off)
FIRE_AUTO_SKIP = 8.0         # never in the intro

# How far a cue may slide to land on a real note.  A climax is a multi-second
# section, so a second still reads as "the same moment"; a hand-written note
# number is exact and uses 0 for its own difficulty.
FIRE_CUE_SNAP_TOL = 0.45
FIRE_AUTO_SNAP_TOL = 1.20

FIRE_TYPE = "fire"

# A cue copied onto another difficulty is snapped to that difficulty's nearest
# note, but only if one is this close.  Without it a shared cue list fires the
# effect at moments where nothing is crossing the judgement line at all.
FIRE_MIRROR_TOL = 0.12

# How long a window the difficulty tiers threshold locally.  A single global
# threshold starves whichever part of the song happens to be quieter; ~8 s is
# about five bars here, short enough to follow the arrangement.
TIER_WINDOW_S = 8.0

# Share of expert's strongest notes that gain a second lane in `extra`.
# Expert already uses every detected slot, so the top tier buys its difficulty
# with chords rather than with more onsets.
EXTRA_CHORD_RATIO = 0.34

# percussive layer: linear power flux, full band
PERC = dict(smooth=5, win=0.45, mad_k=3.0, floor=1.0)
# melodic layer: log flux 400-3500 Hz
MEL = dict(smooth=3, win=0.45, mad_k=3.0, floor=1.5, lo=400.0, hi=3500.0,
           max_residual=0.026, energy_gate=0.05)


# --------------------------------------------------------------------------- #
# media
# --------------------------------------------------------------------------- #
def ffmpeg_exe():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


def decode(media, wav):
    exe = ffmpeg_exe()
    if not exe:
        sys.exit("ffmpeg not found (pip install imageio-ffmpeg)")
    subprocess.run([exe, "-hide_banner", "-loglevel", "error", "-y",
                    "-i", media, "-ac", "1", "-ar", str(SR),
                    "-c:a", "pcm_s16le", wav], check=True)
    return wav


def read_wav_mono(path):
    with wave.open(path, "rb") as w:
        raw = w.readframes(w.getnframes())
        ch, sr = w.getnchannels(), w.getframerate()
    x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    return (x.reshape(-1, ch).mean(axis=1) if ch > 1 else x), sr


# --------------------------------------------------------------------------- #
# dsp helpers
# --------------------------------------------------------------------------- #
def stft_mag(x, n_fft, hop):
    win = np.hanning(n_fft).astype(np.float32)
    n = 1 + (len(x) - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(n)[:, None]
    return np.abs(np.fft.rfft(x[idx] * win, n=n_fft, axis=1)).astype(np.float32)


def _slide_median(a, k, axis):
    pad = k // 2
    padw = [(0, 0), (0, 0)]
    padw[axis] = (pad, pad)
    p = np.pad(a, padw, mode="edge")
    st = (p.strides[0], p.strides[1], p.strides[0] if axis == 0 else p.strides[1])
    v = np.lib.stride_tricks.as_strided(p, shape=(a.shape[0], a.shape[1], k), strides=st)
    return np.median(v, axis=-1)


def hpss(mag, k=17):
    return _slide_median(mag, k, 1), _slide_median(mag, k, 0)


def _win_view(env, k):
    k |= 1
    p = np.pad(env, k // 2, mode="edge")
    return np.lib.stride_tricks.as_strided(p, shape=(len(env), k),
                                           strides=(p.strides[0], p.strides[0]))


def pick_peaks(env, fps, gap_s, win_s, mad_k, floor=1.0):
    """adaptive median/MAD threshold, local maxima, min spacing."""
    v = _win_view(env, int(win_s * fps))
    med = np.median(v, axis=1)
    mad = np.median(np.abs(v - med[:, None]), axis=1) * 1.4826 + 1e-9
    thr = np.maximum(med + mad_k * mad, env.mean() * floor)
    cand = np.where((env[1:-1] >= thr[1:-1]) & (env[1:-1] > env[:-2]) &
                    (env[1:-1] >= env[2:]))[0] + 1
    gap = max(1, int(gap_s * fps))
    out = []
    for i in cand:
        if out and i - out[-1] < gap:
            if env[i] > env[out[-1]]:
                out[-1] = int(i)
            continue
        out.append(int(i))
    return np.array(out, dtype=int)


# --------------------------------------------------------------------------- #
# grid
# --------------------------------------------------------------------------- #
def grid_fit(times, bpm_lo=60.0, bpm_hi=200.0, step=0.05):
    out = []
    for bpm in np.arange(bpm_lo, bpm_hi, step):
        P = 60.0 / bpm
        z = np.exp(2j * np.pi * times / P).mean()
        out.append((float(abs(z)), float(bpm), float(np.angle(z) / (2 * np.pi) * P) % P))
    out.sort(key=lambda r: -r[0])
    return out


def pick_grid(times):
    cands = grid_fit(times)
    best = cands[0][0]
    clusters = []
    for q, b, p in sorted((c for c in cands if c[0] >= best * 0.97), key=lambda r: r[1]):
        for c in clusters:
            if abs(np.log2(b / c[1])) < 0.06:
                break
        else:
            clusters.append((q, b, p))
    clusters.sort(key=lambda c: (-c[0], abs(np.log2(c[1] / 120.0))))
    q, bpm, phase = clusters[0]
    return bpm, phase, q, cands


def detect_climaxes(x, sr, onset_env, fps, count, min_gap, skip, spread=True):
    """
    Find the song's climactic moments for the concert pyro.

    A climax is a *sustained* loud section with a lot of note activity, not a
    single loud sample — so the loudness is smoothed into a ~1.5 s "section
    energy" curve and blended with how many onsets surround it.  Picks are then
    taken greedily with a suppression window, which spreads them across the
    whole track instead of stacking them in the loudest chorus.
    """
    hop = max(1, int(round(sr / fps)))
    n = 1 + (len(x) - hop) // hop
    if n < 4:
        return []

    idx = np.arange(hop)[None, :] + hop * np.arange(n)[:, None]
    rms = np.sqrt((np.asarray(x)[idx] ** 2).mean(axis=1) + 1e-12)
    db = 20.0 * np.log10(rms + 1e-9)

    k = int(round(1.5 * fps)) | 1
    kern = np.hanning(k)
    kern /= kern.sum()
    energy = np.convolve(db, kern, mode="same")
    lo, hi = np.percentile(energy, 5), np.percentile(energy, 99)
    energy = np.clip((energy - lo) / max(hi - lo, 1e-6), 0.0, 1.0)

    t = np.arange(n) / fps
    if onset_env is not None and len(onset_env) > 8:
        oe = np.interp(t, np.arange(len(onset_env)) / fps, onset_env)
        act = np.convolve(oe, np.ones(int(round(2 * fps))) / (2 * fps), mode="same")
        act = _rank01(act)
    else:
        act = np.zeros(n)

    score = energy * (0.65 + 0.35 * act)
    score[t < skip] = -1.0

    span = int(round(min_gap * fps))
    picked = []

    if spread and count > 0:
        # one pick per equal slice of the remaining song
        edges = np.linspace(skip, float(t[-1]), count + 1)
        for a, b in zip(edges[:-1], edges[1:]):
            m = (t >= a) & (t < b)
            if not m.any():
                continue
            seg = np.where(m, score, -1.0)
            i = int(np.argmax(seg))
            if seg[i] >= 0:
                picked.append(i)
    else:
        work = score.copy()
        for _ in range(count):
            i = int(np.argmax(work))
            if work[i] < 0:
                break
            picked.append(i)
            work[max(0, i - span): min(n, i + span + 1)] = -1.0

    # drop anything that ended up too close to a louder neighbour
    picked.sort(key=lambda i: -score[i])
    kept = []
    for i in picked:
        if all(abs(i - j) >= span for j in kept):
            kept.append(i)

    picks = [(float(t[i]), float(energy[i]), float(act[i])) for i in kept]
    picks.sort(key=lambda p: p[0])
    return picks


def refine_phase(env, fps, bpm, phase, span=0.055, steps=111):
    """
    Nudge the beat phase so the most onset energy sits on the grid.

    `pick_grid` maximises |z|, i.e. the circular *mean* of the onset times.  A
    real attack is asymmetric (sharp rise, slow decay), so that mean sits a few
    milliseconds away from the perceptual hit.  Searching +-55 ms — less than a
    16th at this tempo, so it can never jump to the wrong grid slot — recovers
    the difference.
    """
    P = 60.0 / bpm
    count = int(max(0.0, (len(env) / fps) - phase) / P)
    if count < 8:
        return phase
    ticks = np.arange(count)
    best, best_score = phase, -1.0
    for d in np.linspace(-span, span, steps):
        ph = phase + d
        idx = np.round((ph + P * ticks) * fps).astype(int)
        idx = idx[(idx >= 0) & (idx < len(env))]
        if len(idx) < 8:
            continue
        score = float(env[idx].mean())
        if score > best_score:
            best, best_score = ph, score
    return best


# --------------------------------------------------------------------------- #
# lanes
# --------------------------------------------------------------------------- #
BANDS = [(30, 140), (140, 400), (400, 1200), (1200, 3500), (3500, 8000)]


def spectral_features(mag, harm, frames):
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / SR)
    tot = harm.sum(axis=1) + 1e-6
    low = sum(harm[:, (freqs >= lo) & (freqs < hi)].sum(axis=1)
              for lo, hi in ((30, 140), (140, 400))) / tot
    lf = np.log2(np.maximum(freqs, 20.0))
    cent = (harm * lf[None, :]).sum(axis=1) / tot
    f = np.clip(frames, 0, len(cent) - 1)
    return low[f], cent[f]


def _rank01(v):
    """percentile rank in 0..1 - robust whatever the underlying distribution."""
    if len(v) < 2:
        return np.zeros_like(v, dtype=float)
    return np.argsort(np.argsort(v)).astype(float) / (len(v) - 1)


def assign_lanes(low, cent, is_perc, ticks, jack_ticks):
    """
    Spread notes over the four columns by pitch contour.

    An earlier version sent every percussive note to the outer lanes and every
    melodic one to the inner lanes.  That reads nicely *until* the melodic layer
    is thinned out, at which point the middle columns empty and the chart
    becomes a two-key game.  Driving the lane from the (uniform) percentile rank
    of the spectral centroid keeps all four columns in play, whatever the two
    layers happen to contribute.
    """
    n = len(ticks)
    if n == 0:
        return np.zeros(0, dtype=int)
    crawl = _rank01(cent)        # 0 = darkest note, 1 = brightest
    punch = _rank01(low)         # 0 = least bass,    1 = most bass

    lanes = np.zeros(n, dtype=int)
    last, last_tick = -1, -10 ** 9
    flip = 0
    for i in range(n):
        # round(rank * 3) gives a 17 / 33 / 33 / 17 split -- the middle columns
        # carry the melodic motion, the outer two anchor it
        lane = int(min(3, max(0, round(float(crawl[i]) * 3))))

        # a heavy bass hit takes an outer lane, alternating sides
        if punch[i] > 0.90:
            lane = 0 if flip % 2 == 0 else 3
            flip += 1

        # never write an unplayable jack on the same column
        if lane == last and (ticks[i] - last_tick) < jack_ticks:
            lane = (lane + 1) % 4 if lane < 2 else (lane - 1)

        lanes[i] = lane
        last, last_tick = lane, ticks[i]
    return lanes


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--media", default=os.path.join(ROOT, "src", TRACK["audio"].replace("../", "")))
    ap.add_argument("--wav", default=os.path.join(ROOT, "tools", "_analysis.wav"))
    ap.add_argument("--keep-wav", action="store_true")
    args = ap.parse_args()

    decode(args.media, args.wav)
    x, sr = read_wav_mono(args.wav)
    assert sr == SR
    dur = len(x) / SR

    # ---- spectra --------------------------------------------------------- #
    mag = stft_mag(x, N_FFT, HOP)
    harm, _ = hpss(mag)
    mag_b = stft_mag(x, N_FFT_B, HOP_B)
    freqs_b = np.fft.rfftfreq(N_FFT_B, 1.0 / SR)

    # ---- percussive layer: linear power flux ----------------------------- #
    e_perc = np.concatenate([np.zeros(1, np.float32),
                             np.maximum(np.diff(mag_b, axis=0), 0.0).sum(axis=1)])
    e_perc = np.convolve(e_perc, np.ones(PERC["smooth"], np.float32) / PERC["smooth"], mode="same")
    pk_perc = pick_peaks(e_perc, FPS_B, 0.070, PERC["win"], PERC["mad_k"], PERC["floor"])
    t_perc = pk_perc / FPS_B

    if len(t_perc) < 50:
        sys.exit("too few percussive onsets (%d) - is the file correct?" % len(t_perc))

    bpm, phase, quality, cands = pick_grid(t_perc)
    raw_phase = phase
    phase = refine_phase(e_perc, FPS_B, bpm, phase)
    P = 60.0 / bpm
    sub = P / 4.0                                   # 1/16 note
    tick_dur = P * TICK                             # seconds per tick (TICK = beats)

    # ---- melodic layer ---------------------------------------------------- #
    #
    # log1p() compresses dynamically, so during a fade-in a near-silent level
    # rise becomes a huge *relative* jump and fires an onset at t~0 that is
    # louder than the median real onset.  Gating the flux by absolute energy
    # removes it: an onset only counts once the music is actually audible.
    sel = (freqs_b >= MEL["lo"]) & (freqs_b < MEL["hi"])
    band = mag_b[:, sel]
    e_mel = np.concatenate([np.zeros(1, np.float32),
                            np.maximum(np.diff(np.log1p(1000.0 * mag_b), axis=0), 0.0)[:, sel].sum(axis=1)])
    e_mel = np.convolve(e_mel, np.ones(MEL["smooth"], np.float32) / MEL["smooth"], mode="same")

    abs_energy = np.convolve(band.sum(axis=1),
                             np.ones(MEL["smooth"], np.float32) / MEL["smooth"], mode="same")
    gate_floor = MEL["energy_gate"] * np.percentile(abs_energy, 99)
    n_gated = int((e_mel[abs_energy < gate_floor] > 0).sum())
    e_mel = e_mel * (abs_energy >= gate_floor)

    pk_mel = pick_peaks(e_mel, FPS_B, 0.070, MEL["win"], MEL["mad_k"], MEL["floor"])
    t_mel = pk_mel / FPS_B

    # The melodic detector is much looser than the percussive one (±40 ms), so
    # force-quantising all of its onsets invents notes that sit up to half a
    # 16th away from anything audible.  Only onsets that already lie close to
    # the grid are worth keeping; the rest would just feel mushy.
    mel_grid = np.round((t_mel - phase) / sub)
    mel_res = np.abs(t_mel - (phase + mel_grid * sub))
    n_mel_raw = len(t_mel)
    keep_mel = mel_res < MEL["max_residual"]
    t_mel = t_mel[keep_mel]

    # ---- snap both layers onto the grid ----------------------------------- #
    def snap(times):
        g = np.round((times - phase) / sub)
        s = phase + g * sub
        return np.round((s - phase) / tick_dur).astype(np.int64), s

    tk_perc, ts_perc = snap(t_perc)
    tk_mel, ts_mel = snap(t_mel)

    ok = ts_perc > LEAD_IN
    tk_perc, ts_perc, t_perc = tk_perc[ok], ts_perc[ok], t_perc[ok]
    ok = ts_mel > LEAD_IN
    tk_mel, ts_mel, t_mel = tk_mel[ok], ts_mel[ok], t_mel[ok]

    # A note at t < 0 is unreachable, and one inside the lead-in is already past
    # its judgement window when the run starts -- a guaranteed miss the player
    # can do nothing about.  Guard the invariant here rather than trusting the
    # lead-in filter alone.
    ok = tk_perc >= 0
    tk_perc, ts_perc, t_perc = tk_perc[ok], ts_perc[ok], t_perc[ok]
    ok = tk_mel >= 0
    tk_mel, ts_mel, t_mel = tk_mel[ok], ts_mel[ok], t_mel[ok]

    # per-layer strengths as percentile ranks, then a fixed weighting so that a
    # percussive note always outranks a melodic one of the same relative rank
    def strength_at(times, env):
        i = np.clip(np.round(times * FPS_B).astype(int), 0, len(env) - 1)
        return env[i]

    s_perc = 0.50 + 0.50 * _rank01(strength_at(ts_perc, e_perc))
    s_mel = 0.50 * _rank01(strength_at(ts_mel, e_mel))

    # merge onto the shared grid; a percussive hit always wins its slot
    entries = {}
    for k, s, t in zip(tk_perc, s_perc, t_perc):
        k = int(k)
        if k not in entries or s > entries[k][0]:
            entries[k] = (float(s), float(t), True)
    for k, s, t in zip(tk_mel, s_mel, t_mel):
        k = int(k)
        if k not in entries:
            entries[k] = (float(s), float(t), False)

    keys = sorted(entries)
    tick_arr = np.array(keys, dtype=np.int64)
    raw = np.array([entries[k][1] for k in keys])
    is_perc = np.array([entries[k][2] for k in keys])
    raw_s = np.array([entries[k][0] for k in keys])

    frames = np.clip(np.round(raw * FPS).astype(int), 0, mag.shape[0] - 1)
    low, cent = spectral_features(mag, harm, frames)
    jack_ticks = max(1, int(round(JACK_S / tick_dur)))
    lanes = assign_lanes(low, cent, is_perc, tick_arr, jack_ticks)

    # ---- report ----------------------------------------------------------- #
    res = np.abs(t_perc - ts_perc) * 1000 if len(ts_perc) else np.array([0.0])
    print("duration          : %.2f s" % dur)
    print("grid candidates   : " + ", ".join("%.2f(|z|=%.3f)" % (b, q) for q, b, _ in cands[:5]))
    print("chosen tempo      : %.4f bpm  (beat %.4f s, 1/16 = %.1f ms)" % (bpm, P, sub * 1000))
    print("beat phase        : %.4f s   (|z| fit %.4f, refined %+.1f ms)"
          % (phase, raw_phase, (phase - raw_phase) * 1000))
    print("tick              : %.6f s (96 per beat)" % tick_dur)
    print("percussive onsets : %d (%.2f/s), snap error median %.1f ms"
          % (len(t_perc), len(t_perc) / dur, float(np.median(res))))
    print("melodic onsets    : %d kept of %d (%.2f/s) - %d dropped as off-grid"
          % (len(t_mel), n_mel_raw, len(t_mel) / dur, int(n_mel_raw - len(t_mel))))
    print("energy gate       : floor %.1f, muted %d frames (silence / fade-in)"
          % (gate_floor, n_gated))
    print("merged chart slots: %d (%.2f/s)  [%d percussive, %d melodic]"
          % (len(tick_arr), len(tick_arr) / dur, int(is_perc.sum()), int((~is_perc).sum())))
    print("chart span        : %.2f .. %.2f s" % (raw.min(), raw.max()))

    # ---- difficulty tiers -------------------------------------------------- #
    #
    # A single global strength threshold ranks the whole song on one scale, and
    # this song does not sit on one scale: the back half is louder but far more
    # legato, so its onsets rank lower overall and a low tier throws the whole
    # back half away.  The removed `easy` tier kept 78 notes in the first fifty
    # seconds and four in the last forty while `hard` (78 %) barely noticed.
    # That is a density cliff.
    #
    # Each tier therefore gets a *second* threshold measured inside its own
    # window, and keeps a note that clears either one.  The global threshold
    # decides what the tier already handled; the local one can only ever lower
    # the bar, so nothing that used to be charted disappears -- sparse windows
    # are topped up to their share and the rest is left alone.
    ratios = {"hard": 0.78, "expert": 1.0}
    # The local share runs a little ahead of the global one, because a window
    # that happens to be quiet should still be playable rather than empty.
    local_ratios = {"hard": 0.82, "expert": 1.0}
    tier_span = max(1, int(round(TIER_WINDOW_S / tick_dur)))

    def local_floor(ratio):
        """Per-slot strength floor = the `ratio`-quantile inside each window.

        The windows are slices of *time*, not of the candidate array: grouping
        by array position would put the whole song in one window as soon as the
        array is shorter than the window is wide.
        """
        floor = np.full(len(tick_arr), np.inf)
        win = (tick_arr - int(tick_arr[0])) // tier_span
        for w in np.unique(win):
            m = win == w
            seg = raw_s[m]
            n_local = max(1, int(round(len(seg) * ratio)))
            if n_local >= len(seg):
                floor[m] = -np.inf
            else:
                floor[m] = np.sort(seg)[::-1][n_local - 1]
        return floor

    charts = {}
    for name, ratio in ratios.items():
        n_keep = int(round(len(tick_arr) * ratio))
        thr = np.sort(raw_s)[::-1][n_keep - 1] if n_keep > 0 else 1e9
        bar = np.minimum(thr, local_floor(local_ratios[name]))
        out, last_tick, last_lane = [], -10 ** 9, -1
        for i in range(len(tick_arr)):
            if raw_s[i] < bar[i]:
                continue
            t, l = int(tick_arr[i]), int(lanes[i])
            if t == last_tick and l == last_lane:
                continue
            if l == last_lane and (t - last_tick) < jack_ticks:
                continue
            out.append({"t": t, "l": l, "s": round(float(raw_s[i]), 3)})
            last_tick, last_lane = t, l
        charts[name] = out

    # ---- extra: the tier above expert ------------------------------------- #
    #
    # Expert already uses every candidate slot, so there is nothing left to
    # detect: "denser" is not available.  A real top difficulty does not get
    # harder by finding more notes either -- it gets harder by making the
    # strongest hits two-handed.  So `extra` is expert plus a chord partner on
    # the loudest share of its notes.
    #
    # The partner is taken from a lane that is free at that instant, preferring
    # the mirrored lane (0<->3, 1<->2) so the two hands share the work instead of
    # one thumb playing a double.  Never more than two notes on a tick.
    lane_ticks = [np.array(sorted(n["t"] for n in charts["expert"] if n["l"] == L), dtype=np.int64)
                  for L in range(4)]

    def lane_free(L, t):
        a = lane_ticks[L]
        if a.size == 0:
            return True
        i = int(np.searchsorted(a, t))
        for j in (i - 1, i):
            if 0 <= j < a.size and abs(int(a[j]) - t) < jack_ticks:
                return False
        return True

    base = charts["expert"]
    n_chord = int(round(len(base) * EXTRA_CHORD_RATIO))
    cut = np.sort([n["s"] for n in base])[::-1][n_chord - 1] if n_chord > 0 else 2.0
    occupied = {(n["t"], n["l"]) for n in base}
    extra = [dict(n) for n in base]
    chords = 0
    for n in base:
        if n["s"] < cut:
            continue
        t, l = n["t"], n["l"]
        for cand in (3 - l, (l + 1) % 4, (l + 2) % 4, (l + 3) % 4):
            if cand == l or (t, cand) in occupied:
                continue
            if not lane_free(cand, t):
                continue
            extra.append({"t": t, "l": cand, "s": round(float(n["s"]) * 0.9, 3)})
            occupied.add((t, cand))
            chords += 1
            break
    extra.sort(key=lambda n: (n["t"], n["l"]))
    charts["extra"] = extra

    for name, out in charts.items():
        d = np.diff([n["t"] for n in out]) * tick_dur if len(out) > 1 else np.array([1.0])
        extra_note = "  (+%d chords)" % chords if name == "extra" else ""
        print("  %-7s %4d notes (%.2f nps, min gap %.0f ms, lanes %s)%s"
              % (name, len(out), len(out) / dur, d.min() * 1000,
                 np.bincount([n["l"] for n in out], minlength=4).tolist(), extra_note))
        # the point of the local pass: report the spread, not just the average
        span = np.array([n["t"] for n in out]) * tick_dur
        quarters = [int(((span >= i * dur / 4) & (span < (i + 1) * dur / 4)).sum())
                    for i in range(4)]
        print("          quarters %s  (%.2f .. %.2f notes/s)"
              % (quarters, min(quarters) / (dur / 4), max(quarters) / (dur / 4)))

    # ---- show cues -------------------------------------------------------- #
    #
    # A cue is stored as a *time*, and per difficulty.  The effect must fire at
    # the instant a note reaches the judgement line, so every cue is resolved to
    # a note that actually exists in that difficulty: the requested note number
    # for the difficulty it was written for, and the nearest note (within
    # FIRE_MIRROR_TOL) for the others.  A single shared list would otherwise pop
    # the pyro at moments where that difficulty has no note at all.
    def note_time(n):
        return phase + n["t"] * tick_dur

    requested = []
    if FIRE_AUTO:
        picks = detect_climaxes(x, SR, e_perc, FPS, FIRE_AUTO_COUNT,
                                FIRE_AUTO_MIN_GAP, FIRE_AUTO_SKIP, FIRE_AUTO_SPREAD)
        print("auto climaxes     : %d found" % len(picks))
        for tt, en, ac in picks:
            print("    %7.2f s   energy %.2f   activity %.2f" % (tt, en, ac))
        # source None => apply to every difficulty, snapped by tolerance
        requested = [(None, None, tt, FIRE_AUTO_SNAP_TOL) for tt, _, _ in picks]
    else:
        for tier, cues in FIRE_CUES.items():
            times = FIRE_CUE_TIMES.get(tier) or []
            if times:
                # explicit seconds win: they survive a regeneration unchanged
                for t in times:
                    requested.append((tier, None, float(t), FIRE_CUE_SNAP_TOL))
                continue
            notes = charts.get(tier)
            if not notes:
                print("  ! fire cues for '%s' ignored: no such difficulty" % tier)
                continue
            for n in cues:
                if 1 <= n <= len(notes):
                    requested.append((tier, int(n), note_time(notes[n - 1]), 0.0))
                else:
                    print("  ! fire cue #%d on '%s' skipped: it has only %d notes"
                          % (n, tier, len(notes)))

    events_by_diff = {name: [] for name in charts}
    for tier, n, target, slack in requested:
        for name in ([tier] if tier else charts.keys()):
            notes = charts[name]
            tol = slack if tier is None else (0.0 if n is not None else FIRE_CUE_SNAP_TOL)
            best = min(notes, key=lambda q: abs(note_time(q) - target))
            drift = abs(note_time(best) - target)
            if drift > tol:
                if name == tier:
                    print("  ! fire cue @%.2fs has no note on '%s' within %.0f ms"
                          % (target, name, tol * 1000))
                continue
            events_by_diff[name].append({
                "t": int(best["t"]),
                "type": FIRE_TYPE,
                "cue": n,
                "from": tier or "auto",
                "drift": round(drift, 3),
            })

    for name in events_by_diff:
        seen, uniq = set(), []
        for e in sorted(events_by_diff[name], key=lambda e: e["t"]):
            if e["t"] in seen:
                continue
            seen.add(e["t"])
            uniq.append(e)
        events_by_diff[name] = uniq

    if requested:
        print("fire cues         : %d requested (%s)"
              % (len(requested), "auto" if FIRE_AUTO else ", ".join(sorted(FIRE_CUES))))
        for name in ("hard", "expert", "extra"):
            if name not in events_by_diff:
                continue
            print("  %-7s %d bursts  %s"
                  % (name, len(events_by_diff[name]),
                     " ".join("%s@%.2fs"
                              % ("#" + str(e["cue"]) if e["cue"] else "*",
                                 phase + e["t"] * tick_dur)
                              for e in events_by_diff[name])))

    # ---- emit ------------------------------------------------------------- #
    os.makedirs(OUTDIR, exist_ok=True)
    payload = {
        "format": "tongtou-chart/1",
        "meta": {
            "title": TRACK["title"], "artist": TRACK["artist"],
            "audio": TRACK["audio"], "bga": TRACK["bga"],
            "duration": round(dur, 3),
            "bpm": round(float(bpm), 4),
            "offset": round(float(phase), 6),
            "tick": round(float(tick_dur), 12),
            "lanes": 4,
            "generated": "tools/analyze.py",
        },
        "events": events_by_diff,
        "charts": charts,
    }
    out = os.path.join(OUTDIR, "%s.json" % TRACK["title"])
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print("wrote %s (%.1f KB)" % (out, os.path.getsize(out) / 1024.0))

    if not args.keep_wav and os.path.exists(args.wav):
        os.remove(args.wav)


if __name__ == "__main__":
    main()
