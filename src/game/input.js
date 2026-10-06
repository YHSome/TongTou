/**
 * Input handling.
 *
 * Two sources feed the same lane-press queue:
 *
 *   keyboard   D F J K, each press timestamped by the audio engine
 *   touch      multi-touch pointer events resolved to a lane by the renderer
 *
 * Every press is delivered with an audio-clock timestamp derived from the
 * event's own `timeStamp`, not from the frame that happens to consume it, so
 * key presses keep sub-frame accuracy instead of being quantised to the
 * display refresh rate.
 *
 * Touch specifics worth calling out:
 *   - pointer events are used rather than touch events, so a mouse, a pen and
 *     a finger all work through one path;
 *   - each touch carries its own `pointerId`, so four simultaneous fingers on
 *     four lanes register as four independent presses and releases (this is
 *     what makes chords playable);
 *   - the pointer is captured on pointerdown, so a finger that slides slightly
 *     still delivers its pointerup to the right lane.
 */

import { DEFAULT_KEYS } from './config.js';

export class Input {
  constructor(target = window) {
    this.target = target;

    /** four KeyboardEvent.code values, index = lane */
    this.bindings = DEFAULT_KEYS.slice();
    /** reverse lookup, rebuilt by setBindings() */
    this._byCode = new Map();

    /** held state per lane (true while any source holds it) */
    this.held = [false, false, false, false];
    /** lane -> list of pending { time } presses, drained by the engine */
    this.presses = [[], [], [], []];
    /** lane -> list of { time } releases */
    this.releases = [[], [], [], []];

    /** pointerId -> lane, so releases are attributed to the finger that began */
    this._pointerLane = new Map();
    /** lane -> count of pointers currently down, so release only fires once */
    this._lanePointers = [0, 0, 0, 0];
    /** lane -> whether a keyboard key currently holds it */
    this._keyHeld = [false, false, false, false];

    /** Set by main: (cssX, cssY) => lane index or -1 */
    this.laneResolver = () => -1;
    /** Set by main: (event, lane) => boolean — return true to consume */
    this.interceptor = null;
    /** Set by main: (eventTimeStamp?) => number, the audio clock */
    this.clock = () => performance.now() / 1000;
    this.enabled = false;

    /** the element that receives touch input during play */
    this.surface = null;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerEnd = this._onPointerEnd.bind(this);
    this._onPointerCancel = this._onPointerCancel.bind(this);

    // build the reverse lookup only once every lane array exists, because
    // setBindings() releases held state as a side effect
    this.setBindings(this.bindings);

    target.addEventListener('keydown', this._onKeyDown, { passive: false });
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._onBlur);
    target.addEventListener('contextmenu', (e) => {
      // long-press on a lane must not pop the context menu
      if (this.enabled && e.target && e.target.closest && e.target.closest('.view')) e.preventDefault();
    });
  }

  /**
   * Replace the four lane bindings.
   * Held state is released first, otherwise a key that is moved to another lane
   * while down would never receive its keyup for the old lane.
   */
  setBindings(codes) {
    if (Array.isArray(codes) && codes.length === 4) this.bindings = codes.slice();
    this._byCode.clear();
    for (let lane = 0; lane < 4; lane++) {
      const code = this.bindings[lane];
      if (code) this._byCode.set(code, lane);
    }
    this._onBlur();
  }

  /** Lane index for a `KeyboardEvent.code`, or -1. */
  laneFor(code) {
    const lane = this._byCode.get(code);
    return lane === undefined ? -1 : lane;
  }

  /** True when this code is currently mapped to a lane. */
  isBound(code) {
    return this._byCode.has(code);
  }

  /**
   * Attach the multi-touch surface (the game canvas).
   * `touch-action: none` is set from here so the browser never treats a lane
   * tap as a scroll, pinch or double-tap-zoom gesture.
   */
  attachSurface(el) {
    if (this.surface === el) return;
    this.surface = el;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', this._onPointerDown, { passive: false });
    el.addEventListener('pointerup', this._onPointerEnd);
    el.addEventListener('pointercancel', this._onPointerCancel);
    el.addEventListener('lostpointercapture', this._onPointerCancel);
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this._onBlur();
  }

  /* -------------------------------------------------------------------- */
  /* keyboard                                                              */
  /* -------------------------------------------------------------------- */

  _onKeyDown(e) {
    if (e.repeat) return;
    // The interceptor may claim shell keys, but a key that is currently bound
    // to a lane wins during gameplay — otherwise a player who binds Space or R
    // would lose the lane to the pause/restart shortcut.
    if (this.interceptor && this.interceptor(e)) { e.preventDefault(); return; }

    const lane = this.laneFor(e.code);
    if (lane < 0) return;
    e.preventDefault();
    if (this._keyHeld[lane]) return;

    this._keyHeld[lane] = true;
    this._press(lane, e.timeStamp);
  }

  _onKeyUp(e) {
    const lane = this.laneFor(e.code);
    if (lane < 0) return;
    e.preventDefault();
    if (!this._keyHeld[lane]) return;

    this._keyHeld[lane] = false;
    this._release(lane, e.timeStamp);
  }

  /* -------------------------------------------------------------------- */
  /* touch / pointer                                                       */
  /* -------------------------------------------------------------------- */

  _onPointerDown(e) {
    if (!this.enabled || !this.surface) return;
    // a mouse click on the playfield should not also act as a lane press
    // while the pointer is being used for UI — only touch and pen do
    if (e.pointerType === 'mouse') return;

    const rect = this.surface.getBoundingClientRect();
    const lane = this.laneResolver(e.clientX - rect.left, e.clientY - rect.top);
    if (lane < 0) return;

    e.preventDefault();
    this._pointerLane.set(e.pointerId, lane);
    this._lanePointers[lane] += 1;

    try { this.surface.setPointerCapture(e.pointerId); } catch { /* not capturable */ }

    if (this._lanePointers[lane] === 1) this._press(lane, e.timeStamp);
  }

  _onPointerEnd(e) {
    const lane = this._pointerLane.get(e.pointerId);
    if (lane === undefined) return;

    this._pointerLane.delete(e.pointerId);
    this._lanePointers[lane] = Math.max(0, this._lanePointers[lane] - 1);

    // only release the lane once the last finger on it lifts
    if (this._lanePointers[lane] === 0) this._release(lane, e.timeStamp);
  }

  _onPointerCancel(e) {
    // a cancelled pointer (palm rejection, gesture takeover) must still release
    this._onPointerEnd(e);
  }

  /* -------------------------------------------------------------------- */
  /* lane state                                                            */
  /* -------------------------------------------------------------------- */

  _press(lane, timeStamp) {
    if (this.held[lane]) return;
    this.held[lane] = true;
    this.presses[lane].push({ time: this.clock(timeStamp) });
  }

  _release(lane, timeStamp) {
    // a lane stays held while either a key or another finger is still on it
    if (this._keyHeld[lane] || this._lanePointers[lane] > 0) return;
    if (!this.held[lane]) return;
    this.held[lane] = false;
    this.releases[lane].push({ time: this.clock(timeStamp) });
  }

  _onBlur() {
    for (let l = 0; l < 4; l++) {
      this._keyHeld[l] = false;
      this._lanePointers[l] = 0;
      if (this.held[l]) {
        this.held[l] = false;
        this.releases[l].push({ time: this.clock() });
      }
    }
    this._pointerLane.clear();
  }

  /** Drain queued presses for one lane. */
  takePresses(lane) {
    const q = this.presses[lane];
    if (!q.length) return null;
    this.presses[lane] = [];
    return q;
  }

  takeReleases(lane) {
    const q = this.releases[lane];
    if (!q.length) return null;
    this.releases[lane] = [];
    return q;
  }

  reset() {
    for (let l = 0; l < 4; l++) {
      this.presses[l] = [];
      this.releases[l] = [];
      this.held[l] = false;
      this._keyHeld[l] = false;
      this._lanePointers[l] = 0;
    }
    this._pointerLane.clear();
  }
}
