/**
 * Game engine: note state, judgement, scoring, gauge and effects.
 *
 * The engine is pure logic — it never touches the DOM or the canvas.  Given the
 * current audio time and the queued input presses it advances the note state,
 * produces an event list for the renderer, and reports progress.
 */

import {
  WINDOW, MISS_AFTER, JUDGE_INFO, PRECISION_MAX_MS, GAUGE_MAX, GAUGE_START, RANKS,
} from './config.js';

/**
 * Slack added to the window comparisons.
 *
 * Press times come from `performance.now()` arithmetic mapped onto the audio
 * clock, so a press that is *meant* to land exactly on a window edge can be a
 * few ULP above or below it.  Without this, a press at exactly 22.000 ms was
 * judged PERFECT or GREAT depending only on the magnitude of the note's own
 * timestamp — 123 PERFECT / 113 GREAT for one identical offset in practice.
 * One microsecond is far below any perceptible timing difference.
 */
const EDGE_EPS = 1e-6;

/** Judgement for a signed timing error, or null when outside every window. */
export function judge(error) {
  const d = Math.abs(error);
  if (d <= WINDOW.perfect + EDGE_EPS) return 'perfect';
  if (d <= WINDOW.great + EDGE_EPS) return 'great';
  if (d <= WINDOW.good + EDGE_EPS) return 'good';
  if (d <= WINDOW.bad + EDGE_EPS) return 'bad';
  return null;
}

export class Engine {
  constructor(timeline, settings) {
    this.timeline = timeline;
    this.settings = settings;

    this.notes = timeline.notes.map((n) => ({ ...n, judged: null, judgedAt: 0 }));
    this.total = this.notes.length;
    this.unit = 100 / Math.max(1, this.total);   // one gauge "unit"

    this.reset();
  }

  reset() {
    for (const n of this.notes) { n.judged = null; n.judgedAt = 0; }

    this.counts = { perfect: 0, great: 0, good: 0, bad: 0, miss: 0 };
    this.combo = 0;
    this.maxCombo = 0;

    // Score = base points + the 「理论值」precision bonus.  Both maxima are
    // derived from the chart, so the maximum is `notes x (100 + 50)` rather
    // than a fixed constant.
    this.points = 0;
    this.bonus = 0;
    this.score = 0;
    this.maxPoints = this.total * JUDGE_INFO.perfect.weight;
    this.maxBonus = this.total * PRECISION_MAX_MS;
    this.maxScore = this.maxPoints + this.maxBonus;

    this.gauge = GAUGE_START;

    this.cursor = 0;              // first note not yet finalised
    this.skipped = 0;             // notes dropped as unreachable at run start
    this.events = [];             // read by the renderer each frame
    this.finished = false;
    this.failed = false;
    this.clear = false;
    this.time = 0;

    this.lastJudge = null;
    this.lastJudgeAt = -99;
    this.startTime = null;
  }

  /* -------------------------------------------------------------------- */
  /* progress                                                              */
  /* -------------------------------------------------------------------- */

  get accuracy() {
    return this.maxPoints > 0 ? this.points / this.maxPoints : 0;
  }

  get rank() {
    const a = this.accuracy;
    for (const [threshold, rank] of RANKS) if (a >= threshold) return rank;
    return 'F';
  }

  get progress() {
    const d = this.timeline.duration || 1;
    return Math.min(1, Math.max(0, this.time / d));
  }

  /* -------------------------------------------------------------------- */
  /* input                                                                 */
  /* -------------------------------------------------------------------- */

  /**
   * Apply one lane press at time `t`.
   * Only notes inside the BAD window are candidates, so a press can never
   * "steal" a far-away note.
   */
  press(lane, t) {
    const window = WINDOW.bad;
    let best = null;
    let bestErr = Infinity;

    // the cursor lags the current time by at most one window
    for (let i = this.cursor; i < this.total; i++) {
      const n = this.notes[i];
      if (n.time - t > window) break;         // sorted: nothing closer later
      if (n.judged || n.lane !== lane) continue;
      if (t - n.time > window) continue;      // already too late
      const err = t - n.time;
      if (Math.abs(err) < Math.abs(bestErr)) { best = n; bestErr = err; }
    }

    if (!best) {
      this.events.push({ type: 'empty', lane, time: t });
      return null;
    }

    const kind = judge(bestErr) || 'bad';
    this._apply(best, kind, bestErr, t);
    return kind;
  }

  _apply(note, kind, error, t) {
    const info = JUDGE_INFO[kind];
    note.judged = kind;
    note.judgedAt = t;
    note.error = error;

    this.counts[kind] += 1;
    this.points += info.weight;

    // 「理论值」: a PERFECT pays its base value plus how close the press was to
    // the ideal instant, measured in milliseconds.
    let bonus = 0;
    if (kind === 'perfect') {
      bonus = Math.max(0, PRECISION_MAX_MS - Math.abs(error) * 1000);
      this.bonus += bonus;
    }
    note.bonus = bonus;
    this.score = Math.round(this.points + this.bonus);

    if (kind === 'perfect' || kind === 'great' || kind === 'good') {
      this.combo += 1;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    } else {
      this.combo = 0;
    }

    // gauge: additive in units of 100/totalNotes, so a clean run fills it
    this.gauge += info.gauge * this.unit;
    this.gauge = Math.max(0, Math.min(GAUGE_MAX, this.gauge));
    if (this.gauge <= 0 && !this.settings.noFail) this.failed = true;

    this.lastJudge = kind;
    this.lastJudgeAt = t;
    this.lastErrorMs = error * 1000;
    this.events.push({ type: 'judge', kind, lane: note.lane, time: t, error, note, bonus });
  }

  /**
   * Drop notes that were already unreachable when the run started.
   *
   * They are marked `skip` rather than `miss`, and removed from the scoring
   * denominator, so a chart with a stray early note neither breaks the combo
   * nor caps the attainable score.
   */
  _skipUnreachable(t) {
    let n = 0;
    while (this.cursor < this.total && this.notes[this.cursor].time < t - MISS_AFTER) {
      const note = this.notes[this.cursor];
      if (!note.judged) {
        note.judged = 'skip';
        note.judgedAt = t;
        n += 1;
      }
      this.cursor += 1;
    }
    if (n > 0) {
      this.skipped += n;
      const scoring = Math.max(1, this.total - this.skipped);
      this.maxPoints = scoring * JUDGE_INFO.perfect.weight;
      this.maxBonus = scoring * PRECISION_MAX_MS;
      this.maxScore = this.maxPoints + this.maxBonus;
      this.unit = 100 / scoring;      // keep the gauge calibrated too
      this.score = 0;
    }
    return n;
  }

  /** Missing notes that have passed beyond the window. */
  _sweep(t) {    const limit = t - MISS_AFTER;
    while (this.cursor < this.total && this.notes[this.cursor].judged) this.cursor++;

    for (let i = this.cursor; i < this.total; i++) {
      const n = this.notes[i];
      if (n.time > limit) break;
      if (!n.judged) this._apply(n, 'miss', n.time - t, t);
    }
    while (this.cursor < this.total && this.notes[this.cursor].judged) this.cursor++;
  }

  /** Let the engine play every note perfectly — used by the AUTO modifier. */
  _auto(t) {
    for (let i = this.cursor; i < this.total; i++) {
      const n = this.notes[i];
      if (n.time > t) break;
      if (n.judged) continue;
      if (t - n.time <= WINDOW.bad) this._apply(n, 'perfect', 0, n.time);
    }
  }

  /* -------------------------------------------------------------------- */
  /* frame                                                                 */
  /* -------------------------------------------------------------------- */

  update(t, input) {
    if (this.startTime === null) {
      this.startTime = t;
      // A note that is already past its window the moment the run begins can
      // never be hit.  Counting it as a miss would cost the player a note and
      // break their combo through no fault of their own, so drop it from the
      // chart entirely (numerator *and* denominator).
      this._skipUnreachable(t);
    }
    this.time = t;
    this.events.length = 0;

    if (!this.finished) {
      // 1. drain lanes in a stable order so simultaneous chords are fair
      for (let lane = 0; lane < 4; lane++) {
        const presses = input ? input.takePresses(lane) : null;
        if (presses) for (const p of presses) this.press(lane, p.time);
      }

      // 2. auto-play resolves anything the player left
      if (this.settings.autoPlay) this._auto(t);

      // 3. expire everything past its window
      this._sweep(t);
    }

    // 4. end of chart
    const allDone = this.cursor >= this.total;
    const pastEnd = t >= this.timeline.duration + 0.4;
    if ((allDone && pastEnd) || this.failed) this.finished = true;
    if (this.finished) this.clear = !this.failed;

    return this.events;
  }

  /** Snapshot for the results screen. */
  summary() {
    return {
      score: this.score,
      maxScore: this.maxScore,
      bonus: Math.round(this.bonus),
      maxBonus: this.maxBonus,
      accuracy: this.accuracy,
      rank: this.rank,
      clear: this.clear,
      failed: this.failed,
      counts: { ...this.counts },
      maxCombo: this.maxCombo,
      total: this.total - this.skipped,
      gauge: this.gauge,
    };
  }
}
