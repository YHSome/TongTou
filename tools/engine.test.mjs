#!/usr/bin/env node
/**
 * Engine + chart logic tests (no browser required).
 *
 *   node tools/engine.test.mjs
 *
 * These cover the parts that are pure logic: chart integrity, judgement
 * windows, combo/score/gauge arithmetic and the miss sweep.  The browser
 * integration test lives in tools/smoke.mjs.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Timeline, DIFFICULTY_ORDER, DIFFICULTY_LABEL } from '../src/game/chart.js';
import { Engine, judge } from '../src/game/engine.js';
import { Input } from '../src/game/input.js';
import {
  WINDOW, GAUGE_MAX, GAUGE_START, JUDGE_INFO, PRECISION_MAX_MS,
  DEFAULT_KEYS, KEY_PRESETS, codeLabel, isReservedKey, normalizeKeys, presetFor,
  defaultSettings, DEFAULTS, loadSettings, saveSettings,
} from '../src/game/config.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CHART = resolve(ROOT, 'src/chart/雨爱.json');

let passed = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { passed++; return; }
  failures.push(`${name}${detail ? ` —${detail}` : ''}`);
  console.log(` FAIL  ${name}${detail ? `  (${detail})` : ''}`);
}

function near(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }

function section(title) { console.log(`\n${title}`); }

/* ------------------------------------------------------------------ */
/* chart integrity                                                     */
/* ------------------------------------------------------------------ */

section('chart file');
const raw = JSON.parse(readFileSync(CHART, 'utf8'));
ok('format tag', raw.format === 'tongtou-chart/1', raw.format);
ok('declares 4 lanes', raw.meta.lanes === 4);

const meta = raw.meta;
ok('duration is the full track', meta.duration > 139 && meta.duration < 141, `${meta.duration}`);
ok('tempo is the detected 162 BPM', near(meta.bpm, 162, 0.01), `${meta.bpm}`);
ok('beat phase is set', meta.offset >= 0 && meta.offset < 60 / meta.bpm, `${meta.offset}`);
ok('tick is 1/96 beat', near(meta.tick, 60 / meta.bpm / 96, 1e-7), `${meta.tick}`);
ok('tick rounding stays sub-millisecond over the track',
  ((60 / meta.bpm / 96 - meta.tick) * (meta.duration / meta.tick)) < 0.001);

const charts = {};
for (const [name, list] of Object.entries(raw.charts)) {
  const notes = list
    .map((n) => ({ time: meta.offset + n.t * meta.tick, lane: n.l | 0, size: n.s ?? 0.6 }))
    .sort((a, b) => a.time - b.time);
  // mirror toTimeline(): cues are stored per difficulty
  const evRaw = raw.events && !Array.isArray(raw.events) ? (raw.events[name] || []) : [];
  const events = evRaw
    .map((e) => ({ time: meta.offset + e.t * meta.tick, type: e.type, cue: e.cue }))
    .sort((a, b) => a.time - b.time);
  charts[name] = new Timeline(meta, notes.map((n, i) => ({ ...n, index: i })), events);
}

section('note arrays');
ok('three difficulties', Object.keys(charts).length === 3, Object.keys(charts).join(','));
// the UI order must match what the chart actually ships, or a tier silently
// disappears from the select screen (or gains a card with no chart behind it)
ok('the UI order lists exactly the shipped tiers',
  DIFFICULTY_ORDER.join(',') === Object.keys(raw.charts).join(','),
  `${DIFFICULTY_ORDER.join(',')} vs ${Object.keys(raw.charts).join(',')}`);
ok('every tier has a display label',
  Object.keys(raw.charts).every((n) => typeof DIFFICULTY_LABEL[n] === 'string' && DIFFICULTY_LABEL[n]),
  Object.keys(raw.charts).map((n) => DIFFICULTY_LABEL[n]).join(','));
for (const [name, tl] of Object.entries(charts)) {
  const times = tl.notes.map((n) => n.time);
  const sorted = times.every((t, i) => i === 0 || t >= times[i - 1]);
  const lanesOk = tl.notes.every((n) => n.lane >= 0 && n.lane <= 3);
  const inRange = times.every((t) => t >= 0 && t <= meta.duration);
  const spread = Math.max(...times) > meta.duration * 0.9;
  ok(`${name}: sorted`, sorted);
  ok(`${name}: lanes in 0..3`, lanesOk);
  ok(`${name}: times inside the track`, inRange);
  ok(`${name}: spans the whole track`, spread, `last=${Math.max(...times).toFixed(1)}s`);
  ok(`${name}: no negative or zero-time notes`, times[0] > 0, `first=${times[0].toFixed(3)}s`);
}

// difficulty must increase monotonically in density
const order = ['hard', 'expert', 'extra'];
for (let i = 1; i < order.length; i++) {
  ok(`density rises ${order[i - 1]} -> ${order[i]}`,
    charts[order[i]].total > charts[order[i - 1]].total,
    `${charts[order[i - 1]].total} -> ${charts[order[i]].total}`);
}

// minimum spacing must stay playable
for (const [name, tl] of Object.entries(charts)) {
  // A chord is two notes on one tick, so the playable quantity is the gap
  // between *distinct* times, not between consecutive entries.
  const distinct = [...new Set(tl.notes.map((n) => n.time))].sort((a, b) => a - b);
  const minGap = Math.min(...distinct.slice(1).map((t, i) => t - distinct[i]));

  let minSameLane = Infinity;
  const perLane = [new Set(), new Set(), new Set(), new Set()];
  const perTick = new Map();
  for (const n of tl.notes) {
    perLane[n.lane].add(n.time.toFixed(6));
    perTick.set(n.time.toFixed(6), (perTick.get(n.time.toFixed(6)) || 0) + 1);
  }
  for (const lane of perLane) {
    const t = [...lane].map(Number).sort((a, b) => a - b);
    for (let i = 1; i < t.length; i++) minSameLane = Math.min(minSameLane, t[i] - t[i - 1]);
  }
  const maxChord = Math.max(...perTick.values());

  ok(`${name}: distinct times stay >= 30 ms apart`, minGap >= 0.030, `${(minGap * 1000).toFixed(1)} ms`);
  ok(`${name}: same-lane min gap >= 90 ms`, !Number.isFinite(minSameLane) || minSameLane >= 0.090,
    `${(minSameLane * 1000).toFixed(1)} ms`);
  // extra buys its difficulty with chords, but a wall of three-note chords is
  // not harder so much as unreadable
  ok(`${name}: never more than two notes at once`, maxChord <= 2, `${maxChord} at one tick`);
}

/* ------------------------------------------------------------------ */
/* density is even across the song                                     */
/* ------------------------------------------------------------------ */

section('density spread');

// The generator used to threshold every difficulty on one global strength
// scale, and this song does not sit on one scale: its second half is louder but
// far more legato, so its onsets rank lower and the low tiers dropped the whole
// back half.  Easy read 78 notes in the first fifty seconds and four in the
// last forty — a cliff, not a chart.  These assertions are the shape of the
// complaint, so the fix cannot silently regress.
const QUARTER_FLOOR = 0.45;      // of the average quarter
for (const name of order) {
  const tl = charts[name];
  const span = tl.notes.map((n) => n.time);
  const q = [0, 1, 2, 3].map((i) => span.filter(
    (t) => t >= (i * meta.duration) / 4 && t < ((i + 1) * meta.duration) / 4).length);
  const avg = tl.total / 4;
  ok(`${name}: every quarter of the song is charted`,
    Math.min(...q) >= avg * QUARTER_FLOOR,
    `quarters ${q.join('/')} vs avg ${avg.toFixed(0)}`);
  ok(`${name}: no quarter is left nearly empty`, Math.min(...q) >= 30,
    `thinnest quarter has ${Math.min(...q)} notes`);
  // and the tail specifically: the last quarter must not be a wasteland
  ok(`${name}: the final quarter carries its weight`, q[3] >= avg * 0.45,
    `${q[3]} notes in the last ${(meta.duration / 4).toFixed(0)} s`);
}

/* ------------------------------------------------------------------ */
/* judgement windows                                                   */
/* ------------------------------------------------------------------ */

section('judgement windows');
ok('0 ms -> perfect', judge(0) === 'perfect');
ok('+21 ms -> perfect', judge(0.021) === 'perfect');
ok('+23 ms -> great', judge(0.023) === 'great');
ok('+44 ms -> great', judge(0.044) === 'great');
ok('+46 ms -> good', judge(0.046) === 'good');
ok('+79 ms -> good', judge(0.079) === 'good');
ok('+81 ms -> bad', judge(0.081) === 'bad');
ok('+129 ms -> bad', judge(0.129) === 'bad');
ok('+131 ms -> outside', judge(0.131) === null);
ok('-21 ms -> perfect', judge(-0.021) === 'perfect');
ok('-129 ms -> bad', judge(-0.129) === 'bad');
ok('-131 ms -> outside', judge(-0.131) === null);
ok('window boundaries are ordered', WINDOW.perfect < WINDOW.great && WINDOW.great < WINDOW.good && WINDOW.good < WINDOW.bad);

// A press that lands exactly on an edge must be judged deterministically, not
// by float noise.  Note timestamps of different magnitudes used to flip the
// same 22.000 ms offset between PERFECT and GREAT.
for (const edge of [WINDOW.perfect, WINDOW.great, WINDOW.good, WINDOW.bad]) {
  const expected = { [WINDOW.perfect]: 'perfect', [WINDOW.great]: 'great',
    [WINDOW.good]: 'good', [WINDOW.bad]: 'bad' }[edge];
  const stable = [0.1, 5.0, 33.333, 77.7, 138.9].every((base) => {
    // reconstruct the error the way the engine does: (base + edge) - base
    return judge((base + edge) - base) === expected;
  });
  ok(`a press exactly on the ${expected.toUpperCase()} edge is judged ${expected}`,
    stable, `edge ${edge}`);
}

/* ------------------------------------------------------------------ */
/* simulated play                                                      */
/* ------------------------------------------------------------------ */

/** A fake Input that presses each note at a fixed timing offset. */
function makeInput(timeline, errorSec) {
  const pending = [[], [], [], []];
  let last = -1;
  return {
    held: [false, false, false, false],
    advance(t) {
      for (let i = 0; i < timeline.total; i++) {
        const n = timeline.notes[i];
        const pressAt = n.time + errorSec;
        if (pressAt > last && pressAt <= t) pending[n.lane].push({ time: pressAt });
      }
      last = t;
    },
    takePresses(lane) {
      const q = pending[lane];
      if (!q.length) return null;
      pending[lane] = [];
      return q;
    },
  };
}

function simulate(timeline, errorSec, settings = {}) {
  const eng = new Engine(timeline, { autoPlay: false, noFail: false, ...settings });
  const input = makeInput(timeline, errorSec);
  const dt = 1 / 480;
  for (let t = -0.5; t <= timeline.duration + 1.0; t += dt) {
    input.advance(t);
    eng.update(t, input);
  }
  return eng;
}

/** Simulate with no input at all —the pure miss path. */
function simulateIdle(timeline, settings = {}) {
  const eng = new Engine(timeline, { autoPlay: false, noFail: false, ...settings });
  const dt = 1 / 480;
  for (let t = -0.5; t <= timeline.duration + 1.0; t += dt) eng.update(t, null);
  return eng;
}

section('simulated play');
const hard = charts.hard;

const perfect = simulate(hard, 0.0);
ok('perfect run: every note judged', perfect.counts.perfect + perfect.counts.great +
  perfect.counts.good + perfect.counts.bad + perfect.counts.miss === hard.total,
  `${perfect.counts.perfect}/${hard.total}`);
ok('perfect run: no misses', perfect.counts.miss === 0, `${perfect.counts.miss}`);
ok('perfect run: full combo', perfect.maxCombo === hard.total, `${perfect.maxCombo}/${hard.total}`);
ok('perfect run: hits the chart maximum', perfect.score === perfect.maxScore,
  `${perfect.score} / ${perfect.maxScore}`);
ok('the maximum is notes x (base + precision), not a fixed constant',
  perfect.maxScore === hard.total * (JUDGE_INFO.perfect.weight + PRECISION_MAX_MS),
  `${perfect.maxScore}`);
ok('a dead-on run banks the full precision bonus',
  perfect.bonus === hard.total * PRECISION_MAX_MS,
  `${perfect.bonus} / ${perfect.maxBonus}`);
ok('perfect run: 100% accuracy', near(perfect.accuracy, 1), `${perfect.accuracy}`);
ok('perfect run: rank AAA', perfect.rank === 'AAA', perfect.rank);
ok('perfect run: gauge full', near(perfect.gauge, GAUGE_MAX), `${perfect.gauge}`);
ok('perfect run: clears', perfect.clear === true && perfect.failed === false);

/* ---- the 理论值 formula ------------------------------------------------ */

section('precision bonus (理论值)');

// bonus = PRECISION_MAX_MS - |error in ms|, awarded on PERFECT only
for (const [errMs, label] of [[0, 'dead on'], [5, '5 ms'], [12, '12 ms'], [22, 'window edge']]) {
  const eng = simulate(hard, errMs / 1000);
  const expectPer = PRECISION_MAX_MS - errMs;
  const okBonus = Math.abs(eng.bonus - hard.total * expectPer) < 1e-6;
  ok(`${label}: bonus is ${PRECISION_MAX_MS} - ${errMs} = ${expectPer} per note`,
    okBonus && eng.counts.perfect === hard.total,
    `bonus ${eng.bonus.toFixed(1)} vs ${(hard.total * expectPer).toFixed(1)}`);
}

// GREAT and below earn base points but no bonus
{
  const g = simulate(hard, 0.040);
  ok('GREAT earns no precision bonus', g.bonus === 0, `${g.bonus}`);
  ok('GREAT still scores its base value',
    g.score === g.maxPoints * 0.5, `${g.score} vs ${g.maxPoints * 0.5}`);
}

// accuracy is judgement-only, so the bonus cannot inflate it
{
  const off = simulate(hard, 0.020);
  ok('a sloppy-but-perfect run is still 100% accuracy',
    near(off.accuracy, 1), `${off.accuracy}`);
  ok('yet it scores less than a dead-on run',
    off.score < perfect.score && off.bonus > 0,
    `${off.score} < ${perfect.score}`);
}

const late = simulate(hard, 0.060);
ok('late run: all GOOD', late.counts.good === hard.total, `${late.counts.good}/${hard.total}`);
ok('late run: quarter of the base points, no bonus',
  late.score === Math.round(late.maxPoints * 0.25) && late.bonus === 0,
  `${late.score} vs ${Math.round(late.maxPoints * 0.25)}`);
ok('accuracy keeps its BMS meaning (all-GOOD = 25%)',
  near(late.accuracy, 0.25), `${late.accuracy}`);

const great = simulate(hard, 0.040);
ok('great run: all GREAT', great.counts.great === hard.total, `${great.counts.great}`);
ok('great run: half of the base points', great.score === Math.round(great.maxPoints * 0.5),
  `${great.score}`);
ok('great run: 50% accuracy', near(great.accuracy, 0.5), `${great.accuracy}`);

// With no input at all, every note must be missed.  The gauge starts at 20 and
// a miss costs 5 * (100/totalNotes), so the run dies after ceil(20/(5*100/N))
// misses —check the arithmetic, not just "it failed".
const idle = simulateIdle(hard);
const missCost = 5 * (100 / hard.total);
const expectedMisses = Math.ceil(GAUGE_START / missCost);
ok('idle run: no hits', idle.counts.perfect + idle.counts.great + idle.counts.good === 0);
ok('idle run: gauge drains in the predicted number of misses',
  idle.counts.miss === expectedMisses, `${idle.counts.miss} vs ${expectedMisses}`);
ok('idle run: zero score', idle.score === 0, `${idle.score}`);
ok('idle run: zero combo', idle.maxCombo === 0);
ok('idle run: gauge bottomed out', idle.gauge === 0, `${idle.gauge}`);
ok('idle run: fails', idle.failed === true);
ok('idle run: stops at the failure', idle.cursor === idle.counts.miss);

const practice = simulateIdle(hard, { noFail: true });
ok('practice mode never fails', practice.failed === false);
ok('practice mode still scores 0', practice.score === 0, `${practice.score}`);
ok('practice mode keeps playing to the end',
  practice.counts.miss === hard.total, `${practice.counts.miss}/${hard.total}`);
ok('practice mode finishes', practice.finished === true);

/* ------------------------------------------------------------------ */
/* engine invariants                                                   */
/* ------------------------------------------------------------------ */

section('engine invariants');

// a press far outside every window must not consume a note
{
  const tl = new Timeline(meta, [{ time: 10, lane: 0, size: 0.6, index: 0 }]);
  const eng = new Engine(tl, { autoPlay: false, noFail: false });
  eng.update(9.0, null);                     // t = 9.0
  const consumed = eng.press(0, 9.0);        // 1 s early: outside every window
  ok('out-of-window press does not judge', consumed === null && eng.notes[0].judged === null);
  const hit = eng.press(0, 10.01);
  ok('in-window press judges once', hit === 'perfect' && eng.notes[0].judged === 'perfect');
  const again = eng.press(0, 10.02);
  ok('a note cannot be judged twice', again === null && eng.counts.perfect === 1);
}

// wrong lane must not consume the note
{
  const tl = new Timeline(meta, [{ time: 10, lane: 2, size: 0.6, index: 0 }]);
  const eng = new Engine(tl, { autoPlay: false, noFail: false });
  eng.update(9.9, null);
  ok('wrong lane press is ignored', eng.press(0, 10.0) === null && eng.notes[0].judged === null);
  ok('right lane still hits', eng.press(2, 10.0) === 'perfect');
}

// chords: simultaneous notes on different lanes must all be reachable
{
  const tl = new Timeline(meta, [
    { time: 5, lane: 0, size: 0.6, index: 0 },
    { time: 5, lane: 3, size: 0.6, index: 1 },
  ]);
  const eng = new Engine(tl, { autoPlay: false, noFail: false });
  eng.update(4.9, null);
  const a = eng.press(0, 5.0);
  const b = eng.press(3, 5.005);
  ok('chord notes are both hittable', a === 'perfect' && b === 'perfect',
    `${a}/${b}`);
}

// miss sweep fires exactly at the window edge
{
  const tl = new Timeline(meta, [{ time: 10, lane: 1, size: 0.6, index: 0 }]);
  const eng = new Engine(tl, { autoPlay: false, noFail: false });
  eng.update(10 + WINDOW.bad - 0.005, null);
  ok('not missed inside the window', eng.notes[0].judged === null);
  eng.update(10 + WINDOW.bad + 0.005, null);
  ok('missed just past the window', eng.notes[0].judged === 'miss');
}

// Notes already past their window when the run begins must be dropped rather
// than counted as misses -- otherwise a stray early note costs the player a
// note and their combo through no fault of their own.
{
  const tl = new Timeline({ ...meta }, [
    { time: 0.02, lane: 0, size: 0.6, index: 0 },   // long past if we start at 0.2
    { time: 5.0, lane: 1, size: 0.6, index: 1 },
    { time: 5.5, lane: 2, size: 0.6, index: 2 },
  ]);
  const eng = new Engine(tl, { autoPlay: false, noFail: false });
  eng.update(0.2, null);                            // the run starts here
  ok('an unreachable opening note is dropped, not missed',
    eng.counts.miss === 0 && eng.skipped === 1,
    `miss=${eng.counts.miss} skipped=${eng.skipped}`);
  ok('dropping it does not touch the combo', eng.combo === 0 && eng.maxCombo === 0);
  ok('it is excluded from the scoring denominator',
    eng.maxPoints === 2 * JUDGE_INFO.perfect.weight, `${eng.maxPoints}`);
  ok('the gauge is recalibrated to the reachable notes',
    near(eng.unit, 100 / 2), `${eng.unit}`);
  ok('it is marked skip, so the renderer never draws it',
    eng.notes[0].judged === 'skip', String(eng.notes[0].judged));

  // the playable remainder must still be worth a full 1,000,000
  const input2 = makeInput(tl, 0);
  for (let t = 0.2; t <= tl.duration + 1; t += 1 / 480) {
    input2.advance(t);
    eng.update(t, input2);
  }
  ok('a perfect run on the remainder still reaches the chart maximum',
    eng.score === eng.maxScore, `${eng.score} / ${eng.maxScore}`);
  ok('and full accuracy', near(eng.accuracy, 1), `${eng.accuracy}`);
}

{
  const tl = charts.expert;
  const eng = new Engine(tl, { autoPlay: false, noFail: false });
  const note = tl.notes[0];
  eng.update(note.time - 0.5, null);
  eng.press(note.lane, note.time);
  const expected = Math.min(GAUGE_MAX, GAUGE_START + JUDGE_INFO.perfect.gauge * (100 / tl.total));
  ok('gauge after one perfect matches the model', near(eng.gauge, expected, 1e-9),
    `${eng.gauge} vs ${expected}`);
  const expectedScore = JUDGE_INFO.perfect.weight + PRECISION_MAX_MS;   // dead-on
  ok('score after one dead-on perfect = base + full 理论值', eng.score === expectedScore,
    `${eng.score} vs ${expectedScore}`);
}

// progress + auto-play.  Driven against `extra` on purpose: it is the only tier
// with chords, so this is also the check that simultaneous notes are resolved
// as two separate judgements rather than one swallowed note.
{
  const eng = new Engine(charts.extra, { autoPlay: true, noFail: false });
  const dt = 1 / 240;
  for (let t = 0; t <= charts.extra.duration + 1; t += dt) eng.update(t, null);
  ok('AUTO clears the chart perfectly', eng.counts.perfect === charts.extra.total && eng.counts.miss === 0,
    `${eng.counts.perfect}/${charts.extra.total}, miss=${eng.counts.miss}`);
  ok('AUTO finishes', eng.finished === true);
  ok('AUTO progress reaches 1', eng.progress >= 0.99, `${eng.progress}`);
}

/* ------------------------------------------------------------------ */
/* key bindings                                                        */
/* ------------------------------------------------------------------ */

section('key bindings');

ok('default bindings are D F J K',
  DEFAULT_KEYS.join(',') === 'KeyD,KeyF,KeyJ,KeyK', DEFAULT_KEYS.join(','));

// every preset must be directly usable
for (const p of KEY_PRESETS) {
  const okLen = p.codes.length === 4;
  const unique = new Set(p.codes).size === 4;
  const free = p.codes.every((c) => !isReservedKey(c));
  ok(`preset "${p.label}" is 4 unique bindable keys`, okLen && unique && free,
    p.codes.join(','));
}
ok('an ASKL preset exists',
  KEY_PRESETS.some((p) => p.codes.join(',') === 'KeyA,KeyS,KeyK,KeyL'));

ok('codeLabel: letters', codeLabel('KeyA') === 'A');
ok('codeLabel: digits', codeLabel('Digit1') === '1');
ok('codeLabel: numpad is distinguishable', codeLabel('Numpad1') === 'N1');
ok('codeLabel: punctuation', codeLabel('Semicolon') === ';');
ok('codeLabel: named keys', codeLabel('Space') === '空格');
ok('codeLabel: unknown falls through', codeLabel('IntlBackslash') === 'IntlBackslash');

ok('Escape is reserved', isReservedKey('Escape'));
ok('arrows are reserved', isReservedKey('ArrowLeft'));
ok('F2 (AUTO) is reserved', isReservedKey('F2'));
ok('letters are bindable', !isReservedKey('KeyA'));
ok('Space is bindable', !isReservedKey('Space'));
ok('digits are bindable', !isReservedKey('Digit7'));

ok('normalizeKeys rejects a non-array', normalizeKeys(null).join(',') === DEFAULT_KEYS.join(','));
ok('normalizeKeys keeps a valid binding',
  normalizeKeys(['KeyA', 'KeyS', 'KeyK', 'KeyL']).join(',') === 'KeyA,KeyS,KeyK,KeyL');
// lane 0 reserved -> default; lane 2 duplicate -> default; lane 3 kept
ok('normalizeKeys repairs reserved and duplicate entries',
  normalizeKeys(['Escape', 'KeyA', 'KeyA', 'KeyB']).join(',') === 'KeyD,KeyA,KeyJ,KeyB',
  normalizeKeys(['Escape', 'KeyA', 'KeyA', 'KeyB']).join(','));
ok('normalizeKeys pads a short array',
  normalizeKeys(['KeyA']).join(',') === 'KeyA,KeyF,KeyJ,KeyK',
  normalizeKeys(['KeyA']).join(','));

/* ------------------------------------------------------------------ */
/* show cues                                                           */
/* ------------------------------------------------------------------ */

section('show cues');

// Every cue must sit on a note that exists in its own difficulty.  A single
// shared cue list made the pyro fire on `easy` up to 19.7 s away from any note.
{
  const evByDiff = raw.events && !Array.isArray(raw.events) ? raw.events : {};
  const names = Object.keys(charts);
  ok('the chart stores cues per difficulty',
    Object.keys(evByDiff).length > 0 && !Array.isArray(raw.events),
    JSON.stringify(Object.keys(evByDiff)));
  ok('the cues requested for hard are present',
    (evByDiff.hard || []).length > 0, `${(evByDiff.hard || []).length} bursts`);

  for (const name of names) {
    const tl = charts[name];
    const evs = evByDiff[name] || [];
    let worst = 0;
    for (const e of evs) {
      const t = meta.offset + e.t * meta.tick;
      const d = Math.min(...tl.notes.map((n) => Math.abs(n.time - t)));
      worst = Math.max(worst, d);
    }
    ok(`${name}: every cue lands on a real note`, worst < 0.001,
      `${evs.length} bursts, worst delta ${(worst * 1000).toFixed(1)} ms`);
    // and the Timeline exposes exactly those cues
    ok(`${name}: the timeline carries them`, tl.events.length === evs.length,
      `${tl.events.length} vs ${evs.length}`);
  }

  // cues must never leak between difficulties
  const hardCues = (evByDiff.hard || []).length;
  const easyCues = (evByDiff.easy || []).length;
  ok('a difficulty with no coincident notes gets no burst',
    hardCues > easyCues, `hard ${hardCues}, easy ${easyCues}`);
}


section('chart lead-in');

// A note inside the lead-in is already past its judgement window when the run
// starts: an unavoidable miss the player can do nothing about.  Negative ticks
// are unreachable outright.  Both used to happen (a fade-in fired a spurious
// onset at t=0.018 s that landed on tick -24).
for (const [name, tl] of Object.entries(charts)) {
  const times = tl.notes.map((n) => n.time);
  const first = Math.min(...times);
  const negTick = raw.charts[name].filter((n) => n.t < 0).length;
  ok(`${name}: nothing charted before a 1 s lead-in`, first >= 1.0,
    `first note at ${first.toFixed(3)} s`);
  ok(`${name}: no negative tick indices`, negTick === 0, `${negTick} negative`);
}

ok('presetFor recognises DFJK', presetFor(DEFAULT_KEYS) === 'dfjk');
ok('presetFor recognises ASKL', presetFor(['KeyA', 'KeyS', 'KeyK', 'KeyL']) === 'askl');
ok('presetFor reports customs', presetFor(['KeyZ', 'KeyX', 'KeyC', 'KeyV']) === 'custom');

// resetting must not alias the shared default array
{
  const a = defaultSettings();
  const b = defaultSettings();
  a.laneKeys[0] = 'KeyZ';
  ok('defaultSettings returns independent copies', b.laneKeys[0] === 'KeyD');
  ok('defaultSettings carries the defaults', b.laneKeys.join(',') === DEFAULT_KEYS.join(','));
  ok('DEFAULTS itself is never mutated', DEFAULTS.laneKeys[0] === 'KeyD');
}

/* ------------------------------------------------------------------ */
/* settings persistence                                                */
/* ------------------------------------------------------------------ */

section('settings persistence');

{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  // AUTO is a mode, not a preference.  Persisting it used to leave the game
  // auto-playing in every later session — "自动播放关不掉了".
  const s = defaultSettings();
  s.autoPlay = true;
  s.volume = 0.42;
  s.scrollSpeed = 2.25;
  saveSettings(s);
  ok('the saved blob never contains AUTO', !('autoPlay' in JSON.parse(store.get('tongtou.settings.v1'))));

  const back = loadSettings();
  ok('AUTO does not come back after a reload', back.autoPlay === false, String(back.autoPlay));
  ok('the other settings still round-trip',
    back.volume === 0.42 && back.scrollSpeed === 2.25, `${back.volume} / ${back.scrollSpeed}`);
  ok('every setting can still force AUTO on at runtime',
    (() => { back.autoPlay = true; saveSettings(back); return loadSettings().autoPlay === false; })());

  // a blob written by an older build must be ignored, not honoured
  store.set('tongtou.settings.v1', JSON.stringify({ ...defaultSettings(), autoPlay: true, volume: 0.7 }));
  ok('a stale AUTO=true blob is ignored too', loadSettings().autoPlay === false);
  ok('...without discarding its other keys', loadSettings().volume === 0.7);

  // ---- a changed default has to reach people who already saved the old one --
  // Writing the whole settings object out means a stored value always beats a
  // new DEFAULTS value, so changing a default without a migration only ever
  // affects fresh installs.  That is exactly how "开局不要自动全屏" would have
  // silently failed to arrive.
  store.set('tongtou.settings.v1',
    JSON.stringify({ ...defaultSettings(), fullscreenOnStart: true }));   // rev 0 blob
  ok('a default is off out of the box', defaultSettings().fullscreenOnStart === false);
  ok('an old blob carrying the previous default is migrated',
    loadSettings().fullscreenOnStart === false);
  ok('the migration stamps the blob so it only runs once',
    loadSettings().rev === 1, String(loadSettings().rev));

  // ...but a choice made *after* the migration is a choice, and must stick
  const picked = loadSettings();
  picked.fullscreenOnStart = true;
  saveSettings(picked);
  ok('a deliberate choice made after the migration is kept',
    loadSettings().fullscreenOnStart === true);
  ok('and it is stamped as current, so it will not be migrated again',
    JSON.parse(store.get('tongtou.settings.v1')).rev === 1);

  delete globalThis.localStorage;
}

/* ------------------------------------------------------------------ */
/* input: dynamic binding                                              */
/* ------------------------------------------------------------------ */

section('input bindings');

const stubTarget = { addEventListener() {}, removeEventListener() {} };
const mkEvent = (code, extra = {}) => ({
  code, repeat: false, timeStamp: 1000, preventDefault() {}, ...extra,
});

{
  const inp = new Input(stubTarget);
  ok('input starts on the default bindings', inp.laneFor('KeyD') === 0 && inp.laneFor('KeyK') === 3);
  ok('unbound keys report -1', inp.laneFor('KeyA') === -1);
  ok('isBound reflects the mapping', inp.isBound('KeyF') && !inp.isBound('KeyA'));

  inp.setBindings(['KeyA', 'KeyS', 'KeyK', 'KeyL']);
  ok('setBindings: ASKL maps to lanes 0..3',
    [0, 1, 2, 3].every((l) => inp.laneFor(['KeyA', 'KeyS', 'KeyK', 'KeyL'][l]) === l));
  ok('setBindings: old keys no longer bound',
    inp.laneFor('KeyD') === -1 && inp.laneFor('KeyF') === -1);
  ok('setBindings: keyboard is now on the ASKL row',
    inp.isBound('KeyA') && inp.isBound('KeyL'));

  // a real press must land on the right lane and queue exactly one press
  inp._onKeyDown(mkEvent('KeyA'));
  ok('bound key queues a press on its lane', inp.presses[0].length === 1, `${inp.presses[0].length}`);
  ok('bound key marks the lane held', inp.held[0] === true);
  ok('repeat events are ignored', (() => {
    inp._onKeyDown(mkEvent('KeyA', { repeat: true }));
    return inp.presses[0].length === 1;
  })());

  inp._onKeyUp(mkEvent('KeyA'));
  ok('bound key releases', inp.held[0] === false);

  // rebinding while a key is physically down must not strand the old lane
  inp._onKeyDown(mkEvent('KeyL'));
  ok('lane 3 held before rebinding', inp.held[3] === true);
  inp.setBindings(DEFAULT_KEYS);
  ok('rebinding clears held state', inp.held.every((h) => h === false));
  ok('input now follows DFJK again', inp.laneFor('KeyD') === 0);

  // the interceptor must be able to leave lane keys alone during play
  let seen = 0;
  inp.setBindings(['KeyA', 'KeyS', 'KeyK', 'KeyL']);
  inp.interceptor = () => { seen++; return false; };
  inp._onKeyDown(mkEvent('KeyS'));
  ok('interceptor is consulted', seen === 1);
  ok('interceptor returning false lets the lane through', inp.held[1] === true);
}

/* ------------------------------------------------------------------ */

console.log(`\n${'-'.repeat(58)}`);
console.log(`${passed} assertions passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
