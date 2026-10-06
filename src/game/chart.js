/**
 * Chart loading and note-timeline construction.
 *
 * Preferred path: a chart JSON produced by `tools/analyze.py`
 * (format `tongtou-chart/1`), which carries an exact tempo, beat phase and
 * per-note tick positions.
 *
 * Fallback: nothing in ./src/chart matches, so the audio is analysed in the
 * browser with the same two-layer idea as the offline tool — a strict linear
 * power-flux detector for tight, grid-locked attacks, plus a log-flux melodic
 * layer to fill the chart out — then quantised to the fitted grid.
 */

const CHART_FORMAT = 'tongtou-chart/1';

/* ------------------------------------------------------------------------ */
/* note timeline                                                             */
/* ------------------------------------------------------------------------ */

/** A chart plus its derived, render-ready note array. */
export class Timeline {
  constructor(meta, notes, events = []) {
    this.meta = meta;
    this.notes = notes;              // sorted by time, each { time, lane, size, index }
    this.duration = meta.duration;
    this.bpm = meta.bpm;
    this.beat = 60 / meta.bpm;
    this.offset = meta.offset;
    this.lanes = meta.lanes || 4;
    this.total = notes.length;

    /**
     * Chart-driven show cues (concert pyro, etc).  These fire on the clock, not
     * on judgement, so missing the note still triggers them.
     */
    this.events = events;            // sorted by time, each { time, type, cue }

    // running counts used by the renderer to bound its scan window
    this._times = new Float64Array(notes.length);
    for (let i = 0; i < notes.length; i++) this._times[i] = notes[i].time;
  }

  /**
   * Binary search for the first note at or after `t`.
   * Lets the renderer touch only the notes actually on screen.
   */
  firstIndexAtOrAfter(t) {
    let lo = 0, hi = this._times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this._times[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Beat number at time `t` (0 at the first beat), for bar pulses. */
  beatAt(t) {
    return (t - this.offset) / this.beat;
  }

  /** Show cues active at time `t` (window length is the effect's business). */
  eventsNear(t, window) {
    const out = [];
    for (const e of this.events) {
      if (e.time > t) break;
      if (t - e.time < window) out.push(e);
    }
    return out;
  }
}

function toTimeline(data) {
  if (!data || !data.meta || !data.charts) throw new Error('bad chart file');
  const meta = {
    title: data.meta.title || 'untitled',
    artist: data.meta.artist || 'unknown',
    audio: data.meta.audio || '',
    duration: Number(data.meta.duration) || 0,
    bpm: Number(data.meta.bpm) || 120,
    offset: Number(data.meta.offset) || 0,
    tick: Number(data.meta.tick) || 1 / 96,
    lanes: Number(data.meta.lanes) || 4,
    generated: data.meta.generated || '',
  };
  const charts = {};
  for (const [name, raw] of Object.entries(data.charts)) {
    const arr = raw
      .map((n, i) => ({
        time: meta.offset + n.t * meta.tick,
        lane: n.l | 0,
        size: typeof n.s === 'number' ? n.s : 0.6,
        index: i,
        judged: null,
      }))
      .sort((a, b) => a.time - b.time);
    charts[name] = new Timeline(meta, arr, eventsFor(meta, data.events, name));
  }
  return { meta, charts };
}

/**
 * Resolve a chart file's show cues for one difficulty.
 *
 * The file stores them per difficulty so that every cue lands on a note that
 * exists in *that* difficulty — a single shared list makes the effect fire at
 * moments where nothing is crossing the judgement line.
 */
function eventsFor(meta, raw, difficulty) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : (raw[difficulty] || []);
  if (!Array.isArray(list)) return [];
  return list
    .map((e) => ({
      time: meta.offset + (Number(e.t) || 0) * meta.tick,
      type: e.type || 'fire',
      cue: e.cue ?? null,
    }))
    .sort((a, b) => a.time - b.time);
}

/* ------------------------------------------------------------------------ */
/* difficulty bookkeeping                                                    */
/* ------------------------------------------------------------------------ */

export const DIFFICULTY_ORDER = ['hard', 'expert', 'extra'];
export const DIFFICULTY_LABEL = { hard: 'HARD', expert: 'EXPERT', extra: 'EXTRA' };

/** A 1..15 style level derived from note density, for display. */
export function difficultyLevel(timeline) {
  const nps = timeline.total / Math.max(1, timeline.duration);
  return Math.max(1, Math.min(15, Math.round(nps * 2.6 + 1)));
}

/* ------------------------------------------------------------------------ */
/* loading                                                                   */
/* ------------------------------------------------------------------------ */

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * Load the prepared chart.  Returns `{ meta, charts, source }` where `source`
 * is `'file'` or `'analysis'`.
 */
export async function loadChart(track, audioBuffer, onProgress = () => {}) {
  if (track.chart) {
    try {
      onProgress('读取谱面 ' + track.chart);
      const data = await fetchJson(encodeURI(track.chart));
      if (data.format !== CHART_FORMAT) throw new Error('unsupported chart format');
      const parsed = toTimeline(data);
      onProgress('谱面已载入');
      return { ...parsed, source: 'file' };
    } catch (err) {
      console.warn('[chart] falling back to analysis:', err.message);
    }
  }

  onProgress('未找到谱面，正在分析音频…');
  const data = await analyseTrack(audioBuffer, track, onProgress);
  const parsed = toTimeline(data);
  return { ...parsed, source: 'analysis' };
}

/* ------------------------------------------------------------------------ */
/* in-browser analysis fallback                                              */
/* ------------------------------------------------------------------------ */

/** FFT magnitude spectrogram with a Hann window. */
function stft(samples, sampleRate, { fftSize = 1024, hop = 64 } = {}) {
  const win = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));

  const frames = Math.max(1, 1 + Math.floor((samples.length - fftSize) / hop));
  const bins = fftSize / 2 + 1;
  const mag = new Float32Array(frames * bins);

  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);

  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < fftSize; i++) {
      re[i] = samples[off + i] * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);

    const base = f * bins;
    for (let b = 0; b < bins; b++) {
      mag[base + b] = Math.hypot(re[b], im[b]);
    }
  }
  return { mag, frames, bins, fps: sampleRate / hop, freqs: (b) => (b * sampleRate) / fftSize };
}

/** Iterative radix-2 FFT, in place. Length must be a power of two. */
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function smooth3(a) {
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const p = a[i - 1] ?? a[i], n = a[i + 1] ?? a[i];
    o[i] = (p + a[i] + n) / 3;
  }
  return o;
}

/** Adaptive median/MAD peak picker; matches the offline tool's behaviour. */
function pickPeaks(env, fps, { gapSec, winSec, madK, floor }) {
  const win = Math.max(3, (Math.floor(winSec * fps) | 1));
  const half = win >> 1;
  const n = env.length;
  const winBuf = new Float32Array(win);
  const gap = Math.max(1, Math.round(gapSec * fps));

  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= Math.max(1, n);

  const out = [];
  for (let i = 1; i < n - 1; i++) {
    if (env[i] < env[i - 1] || env[i] < env[i + 1]) continue;
    let w = 0;
    for (let k = -half; k <= half; k++) {
      const j = Math.min(n - 1, Math.max(0, i + k));
      winBuf[w++] = env[j];
    }
    const slice = winBuf.subarray(0, w);
    const med = medianOf(slice);
    const mad = medianOfAbsDev(slice, med) * 1.4826 + 1e-9;
    if (env[i] < med + madK * mad || env[i] < mean * floor) continue;
    if (out.length && i - out[out.length - 1] < gap) {
      if (env[i] > env[out[out.length - 1]]) out[out.length - 1] = i;
      continue;
    }
    out.push(i);
  }
  return out;
}

function medianOf(a) {
  const b = Float32Array.from(a).sort();
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}

function medianOfAbsDev(a, med) {
  const d = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) d[i] = Math.abs(a[i] - med);
  return medianOf(d);
}

/**
 * Fit (bpm, phase) to onset times by maximising the complex phase
 * concentration |mean(exp(2*pi*i*t/P))|.
 */
function fitGrid(times, lo = 60, hi = 200) {
  let best = { q: 0, bpm: 120, phase: 0 };
  const scored = [];
  for (let bpm = lo; bpm <= hi; bpm += 0.1) {
    const P = 60 / bpm;
    let sr = 0, si = 0;
    for (let i = 0; i < times.length; i++) {
      const a = (2 * Math.PI * times[i]) / P;
      sr += Math.cos(a); si += Math.sin(a);
    }
    sr /= times.length; si /= times.length;
    const q = Math.hypot(sr, si);
    const phase = ((Math.atan2(si, sr) / (2 * Math.PI)) * P % P + P) % P;
    scored.push({ q, bpm, phase });
  }
  scored.sort((a, b) => b.q - a.q);
  // collapse octave-equivalent candidates: keep the strongest per octave
  const clusters = [];
  for (const c of scored.slice(0, 400)) {
    if (clusters.some((k) => Math.abs(Math.log2(c.bpm / k.bpm)) < 0.06)) continue;
    clusters.push(c);
    if (clusters.length >= 8) break;
  }
  best = clusters[0] || best;
  // pull the octave into the musical 70..190 band
  while (best.bpm < 70) best.bpm *= 2;
  while (best.bpm > 190) { best.bpm /= 2; best.phase /= 2; }
  return best;
}

/** Analyse a decoded AudioBuffer into a chart in the on-disk format. */
async function analyseTrack(audioBuffer, track, onProgress) {
  onProgress('分析音频（解码）…');

  // fold to mono at 22050 Hz, matching the offline tool's front end
  const targetRate = 22050;
  const src = audioBuffer;
  const ratio = src.sampleRate / targetRate;
  const n = Math.floor(src.length / ratio);
  const mono = new Float32Array(n);
  const chCount = src.numberOfChannels;
  const chans = [];
  for (let c = 0; c < chCount; c++) chans.push(src.getChannelData(c));
  for (let i = 0; i < n; i++) {
    const s = Math.floor(i * ratio);
    let v = 0;
    for (let c = 0; c < chCount; c++) v += chans[c][s];
    mono[i] = v / chCount;
  }
  await tick();

  onProgress('分析音频（STFT）…');
  const { mag, frames, bins, fps, freqs } = stft(mono, targetRate, { fftSize: 1024, hop: 64 });
  const binHz = freqs(1);
  await tick();

  // ---- layer 1: linear power flux over the full band ------------------- //
  onProgress('分析音频（起音检测）…');
  const ePerc = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    let s = 0;
    const a = f * bins, b = (f - 1) * bins;
    for (let k = 0; k < bins; k++) {
      const d = mag[a + k] - mag[b + k];
      if (d > 0) s += d;
    }
    ePerc[f] = s;
  }
  const ePercS = smooth3(smooth3(ePerc));
  await tick();

  const pkPerc = pickPeaks(ePercS, fps, { gapSec: 0.07, winSec: 0.45, madK: 3.0, floor: 1.0 });
  if (pkPerc.length < 40) throw new Error('音频过于安静或过短，无法自动生成谱面');
  const tPerc = pkPerc.map((i) => i / fps);

  const grid = fitGrid(tPerc);
  const period = 60 / grid.bpm;
  const sub = period / 4;                  // 1/16 note
  const tickDur = period / 96;

  // ---- layer 2: log flux, melodic band --------------------------------- //
  //
  // Gate by absolute energy: log1p() compresses dynamically, so during a
  // fade-in a near-silent rise becomes a huge relative jump and fires a fake
  // onset at t~0 that outranks real onsets.
  const loBin = Math.max(1, Math.round(400 / binHz));
  const hiBin = Math.min(bins - 1, Math.round(3500 / binHz));
  const eMel = new Float32Array(frames);
  const absEnergy = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    let s = 0;
    let abs = 0;
    const a = f * bins, b = (f - 1) * bins;
    for (let k = loBin; k <= hiBin; k++) {
      const d = Math.log1p(1000 * mag[a + k]) - Math.log1p(1000 * mag[b + k]);
      if (d > 0) s += d;
      abs += mag[a + k];
    }
    eMel[f] = s;
    absEnergy[f] = abs;
  }
  // the gate floor is a fraction of a loud frame, so it adapts to the track
  const sorted = Float32Array.from(absEnergy).sort();
  const gateFloor = 0.05 * sorted[Math.floor(sorted.length * 0.99)];
  for (let f = 0; f < frames; f++) if (absEnergy[f] < gateFloor) eMel[f] = 0;

  const eMelS = smooth3(eMel);
  await tick();

  const pkMel = pickPeaks(eMelS, fps, { gapSec: 0.07, winSec: 0.45, madK: 3.0, floor: 1.5 });

  // ---- snap both layers onto the grid ---------------------------------- //
  // Nothing is charted inside the lead-in: such a note is already past its
  // judgement window when playback starts, so it is an unavoidable miss.
  const LEAD_IN = 1.0;
  const slots = new Map();
  for (const i of pkPerc) {
    const t = i / fps;
    const snapped = grid.phase + Math.round((t - grid.phase) / sub) * sub;
    if (snapped <= LEAD_IN) continue;
    const k = Math.round((snapped - grid.phase) / tickDur);
    if (k < 0) continue;
    if (!slots.has(k)) slots.set(k, { t: k, perc: true, strength: ePercS[i] });
  }
  for (const i of pkMel) {
    const t = i / fps;
    const snapped = grid.phase + Math.round((t - grid.phase) / sub) * sub;
    if (snapped <= LEAD_IN) continue;
    const k = Math.round((snapped - grid.phase) / tickDur);
    if (k < 0) continue;
    if (!slots.has(k)) slots.set(k, { t: k, perc: false, strength: eMelS[i] });
  }

  const keys = [...slots.keys()].sort((a, b) => a - b);
  if (keys.length < 30) throw new Error('自动生成谱面失败：音符过少');

  // ---- lanes ------------------------------------------------------------ */
  onProgress('分析音频（分配轨道）…');
  const feats = keys.map((k) => {
    const time = grid.phase + k * tickDur;
    const f = Math.min(frames - 1, Math.max(0, Math.round(time * fps)));
    let low = 0, tot = 0, logSum = 0;
    const base = f * bins;
    for (let b = 1; b < bins; b++) {
      const v = mag[base + b];
      if (v <= 0) continue;
      tot += v;
      if (b * binHz < 400) low += v;
      logSum += v * Math.log2(Math.max(20, b * binHz));
    }
    return { low: tot > 0 ? low / tot : 0, cent: tot > 0 ? logSum / tot : 0 };
  });

  const rank01 = (arr, get) => {
    const idx = arr.map((_, i) => i).sort((a, b) => get(arr[a]) - get(arr[b]));
    const out = new Float64Array(arr.length);
    idx.forEach((v, r) => { out[v] = arr.length > 1 ? r / (arr.length - 1) : 0; });
    return out;
  };
  const crawl = rank01(feats, (f) => f.cent);
  const punch = rank01(feats, (f) => f.low);

  let flip = 0;
  const notes = keys.map((k, i) => {
    const info = slots.get(k);
    let lane;
    if (info.perc) {
      lane = (punch[i] > 0.5) === (flip === 0) ? 0 : 3;
      flip ^= 1;
    } else {
      const p = crawl[i];
      lane = p < 0.5 ? 1 : 2;
      if (p < 0.1) lane = 0; else if (p > 0.9) lane = 3;
    }
    return { t: k, l: lane, s: 0.55, _perc: info.perc, _st: info.strength };
  });

  // strengths -> 0..1 rank, percussive always above melodic
  const percs = notes.filter((n) => n._perc).sort((a, b) => a._st - b._st);
  percs.forEach((n, i) => { n.s = 0.5 + 0.5 * (percs.length > 1 ? i / (percs.length - 1) : 1); });
  const mels = notes.filter((n) => !n._perc).sort((a, b) => a._st - b._st);
  mels.forEach((n, i) => { n.s = 0.5 * (mels.length > 1 ? i / (mels.length - 1) : 1); });

  // ---- difficulty tiers -------------------------------------------------- //
  //
  // Mirrors `tools/analyze.py`.  The threshold is the *lower* of a global one
  // and one measured inside a local window, so a quiet passage still gets its
  // share instead of being cut off entirely; `extra` then takes expert and adds
  // a chord partner on its strongest notes, which is the only way up once the
  // onset set is exhausted.
  const byStrength = [...notes].sort((a, b) => b.s - a.s);
  const ratios = { hard: 0.78, expert: 1.0 };
  const localRatios = { hard: 0.82, expert: 1.0 };
  const window = Math.max(1, Math.round(8.0 / tickDur));
  const jackTicks = Math.round(0.1 / tickDur);

  function thresholdFor(name) {
    const keep = Math.max(1, Math.round(notes.length * ratios[name]));
    const global = byStrength[keep - 1].s;
    const floor = new Array(notes.length).fill(-Infinity);
    const first = notes.length ? notes[0].t : 0;
    const groups = new Map();
    notes.forEach((n, i) => {
      const w = Math.floor((n.t - first) / window);
      if (!groups.has(w)) groups.set(w, []);
      groups.get(w).push(i);
    });
    for (const idx of groups.values()) {
      const want = Math.max(1, Math.round(idx.length * localRatios[name]));
      if (want < idx.length) {
        const sorted = idx.map((i) => notes[i].s).sort((a, b) => b - a);
        for (const i of idx) floor[i] = sorted[want - 1];
      }
    }
    return (i) => Math.min(global, floor[i]);
  }

  const charts = {};
  for (const name of Object.keys(ratios)) {
    const bar = thresholdFor(name);
    const out = [];
    let lastTick = -1e9, lastLane = -1;
    notes.forEach((n, i) => {
      if (n.s < bar(i)) return;
      if (n.t === lastTick && n.l === lastLane) return;
      if (n.l === lastLane && n.t - lastTick < jackTicks) return;
      out.push({ t: n.t, l: n.l, s: Number(n.s.toFixed(3)) });
      lastTick = n.t; lastLane = n.l;
    });
    charts[name] = out;
  }

  // extra = expert + chords on its strongest notes, mirrored lane preferred
  {
    const base = charts.expert;
    const seen = new Set(base.map((n) => `${n.t}:${n.l}`));
    const laneTicks = [0, 1, 2, 3].map((L) => base.filter((n) => n.l === L).map((n) => n.t));
    const free = (L, t) => laneTicks[L].every((u) => Math.abs(u - t) >= jackTicks);
    const sorted = base.map((n) => n.s).sort((a, b) => b - a);
    const cut = sorted.length
      ? sorted[Math.max(0, Math.round(base.length * 0.34) - 1)] : 2;
    const extra = base.map((n) => ({ ...n }));
    for (const n of base) {
      if (n.s < cut) continue;
      for (const cand of [3 - n.l, (n.l + 1) % 4, (n.l + 2) % 4, (n.l + 3) % 4]) {
        if (cand === n.l || seen.has(`${n.t}:${cand}`) || !free(cand, n.t)) continue;
        extra.push({ t: n.t, l: cand, s: Number((n.s * 0.9).toFixed(3)) });
        seen.add(`${n.t}:${cand}`);
        break;
      }
    }
    extra.sort((a, b) => (a.t - b.t) || (a.l - b.l));
    charts.extra = extra;
  }

  onProgress('自动谱面已生成');

  return {
    format: CHART_FORMAT,
    meta: {
      title: track.title || 'auto',
      artist: track.artist || 'unknown',
      audio: track.audio,
      duration: Number(src.duration.toFixed(3)),
      bpm: Number(grid.bpm.toFixed(4)),
      offset: Number(grid.phase.toFixed(6)),
      tick: Number(tickDur.toFixed(8)),
      lanes: 4,
      generated: 'in-browser analyser',
      gridQuality: Number(grid.q.toFixed(3)),
    },
    charts,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
