/**
 * Audio engine.
 *
 * The whole game is driven by the Web Audio sample clock rather than
 * `HTMLMediaElement.currentTime`, because only the audio clock is monotonic and
 * sample-accurate — which is what a rhythm game needs.
 *
 * Three clocks are reconciled here:
 *
 *   1. `ctx.currentTime`      advances in quantum steps and jitters slightly,
 *   2. `performance.now()`    advances smoothly and ISO-stamps input events,
 *   3. `playedSeconds`        the position inside the decoded buffer, which is
 *                             the only value gameplay logic may use.
 *
 * `now()` returns (3).  `stampFor(eventTimeStamp)` maps an input event's own
 * `performance.now()` timestamp onto the same timeline, which recovers
 * sub-frame key-press accuracy instead of quantising input to the frame rate.
 *
 * Latency compensation subtracts the output latency so that notes are judged
 * against what the player actually *hears*.
 */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.source = null;
    this.gain = null;
    this.analyser = null;
    this.freqData = null;

    this.duration = 0;
    this.playing = false;

    /** audio-clock time at which `playedSeconds` was 0 */
    this._origin = 0;
    /** seconds of the buffer already skipped by seeking */
    this._seekBase = 0;
    this._pausedAt = 0;

    /** compensation, seconds */
    this.outputLatency = 0;
    this.userOffset = 0;

    /** calibration pair for input stamping */
    this._perfAtSample = 0;
    this._audioAtSample = 0;
  }

  /* -------------------------------------------------------------------- */
  /* lifecycle                                                             */
  /* -------------------------------------------------------------------- */

  static supported() {
    return typeof window !== 'undefined' &&
      !!(window.AudioContext || window.webkitAudioContext);
  }

  /**
   * Create the context and its graph.
   *
   * Deliberately NEVER awaits `resume()`.  A real browser creates the
   * AudioContext in the `suspended` state, and `resume()` returns a promise
   * that stays pending until the page has user activation — awaiting it here
   * would hang every caller, including `decode()`, before a single note is
   * even decoded.  Starting playback is handled separately by `resumeContext()`
   * from a real gesture.
   */
  async init() {
    if (this.ctx) return this.ctx;

    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('此浏览器不支持 Web Audio API');
    this.ctx = new Ctor({ latencyHint: 'interactive' });

    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.72;
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);

    this.gain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this._measureLatency();
    this._armUnlock();
    return this.ctx;
  }

  /**
   * Resume the context on the first real user gesture.  Autoplay policies only
   * grant activation from an actual input event, so this is the reliable place
   * to start the audio device — `startPlay()` also calls `resumeContext()`.
   */
  _armUnlock() {
    if (this._unlockArmed) return;
    this._unlockArmed = true;

    const remove = () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };
    const unlock = () => {
      if (!this.ctx || this.ctx.state === 'running') { remove(); return; }
      this.ctx.resume().then(() => {
        this._measureLatency();
        remove();
      }).catch(() => { /* stay armed for the next gesture */ });
    };

    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchstart', unlock);
  }

  _measureLatency() {
    const c = this.ctx;
    if (!c) return;
    // `outputLatency` is the honest one (includes the device buffer);
    // fall back to baseLatency, then to a typical 20 ms.
    const out = typeof c.outputLatency === 'number' && c.outputLatency > 0 ? c.outputLatency : 0;
    const base = typeof c.baseLatency === 'number' ? c.baseLatency : 0.02;
    this.outputLatency = out || base;
  }

  /**
   * Decode an encoded audio file into an AudioBuffer.
   *
   * Decoding is legal while the context is suspended, which is why boot can
   * finish before the player has interacted.  A timeout guarantees the boot
   * screen can never hang here silently.
   */
  async decode(arrayBuffer, timeoutMs = 45000) {
    await this.init();
    const t0 = performance.now();

    let timer = 0;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`音频解码超过 ${Math.round(timeoutMs / 1000)} 秒仍未完成`)),
        timeoutMs,
      );
    });

    try {
      this.buffer = await Promise.race([
        this.ctx.decodeAudioData(arrayBuffer).catch((err) => {
          throw new Error(`音频解码失败：${err && err.message ? err.message : String(err)}`);
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }

    this.duration = this.buffer.duration;
    this.decodeMs = Math.round(performance.now() - t0);
    return this.buffer;
  }

  /**
   * Resume playback from a real user gesture.
   *
   * `resume()` only settles once the page has activation, so it is raced
   * against a timeout: a failure here must not stall the caller.
   * Returns true when the context is actually running.
   */
  async resumeContext(timeoutMs = 2500) {
    if (!this.ctx) await this.init();
    if (this.ctx.state === 'running') { this._measureLatency(); return true; }

    let timer = 0;
    try {
      await Promise.race([
        this.ctx.resume(),
        new Promise((r) => { timer = setTimeout(r, timeoutMs); }),
      ]);
    } catch {
      /* the policy refused — the game still runs, just silently */
    } finally {
      clearTimeout(timer);
    }
    this._measureLatency();
    return this.ctx.state === 'running';
  }

  /**
   * Guarantee the context is running before a run starts.
   *
   * This matters more than it looks: while the context is suspended,
   * `ctx.currentTime` does not advance, so `now()` would freeze and the whole
   * playfield would stand still.  If the first attempt is refused, wait for the
   * next real gesture rather than starting a run that cannot progress.
   */
  async ensureRunning(timeoutMs = 8000) {
    if (!this.ctx) await this.init();
    if (this.ctx.state === 'running') return true;
    if (await this.resumeContext()) return true;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('pointerdown', attempt);
        window.removeEventListener('keydown', attempt);
        window.removeEventListener('touchstart', attempt);
        clearTimeout(timer);
        resolve(value);
      };
      const attempt = () => {
        if (!this.ctx || this.ctx.state === 'running') { finish(true); return; }
        this.ctx.resume().then(() => {
          this._measureLatency();
          finish(this.ctx.state === 'running');
        }).catch(() => { /* keep waiting for the next gesture */ });
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      window.addEventListener('pointerdown', attempt);
      window.addEventListener('keydown', attempt);
      window.addEventListener('touchstart', attempt);
    });
  }

  /* -------------------------------------------------------------------- */
  /* transport                                                             */
  /* -------------------------------------------------------------------- */

  /** Start (or restart) playback at `from` seconds. */
  play(from = 0) {
    if (!this.ctx || !this.buffer) return;
    this.stopSource();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    const at = Math.max(0, Math.min(from, Math.max(0, this.duration - 0.001)));
    src.start(0, at);
    this.source = src;
    this._origin = this.ctx.currentTime;
    this._seekBase = at;
    this.playing = true;
    this._sample();
  }

  pause() {
    if (!this.playing) return;
    this._pausedAt = this.now();
    this.stopSource();
    this.playing = false;
    if (this.ctx.state === 'running') this.ctx.suspend();
  }

  async unpause() {
    if (this.playing) return;
    await this.resumeContext();
    this.play(this._pausedAt);
  }

  seek(seconds) {
    const to = Math.max(0, Math.min(seconds, this.duration));
    if (this.playing) this.play(to);
    else this._pausedAt = to;
  }

  stopSource() {
    if (this.source) {
      try { this.source.onended = null; this.source.stop(); } catch { /* already stopped */ }
      try { this.source.disconnect(); } catch { /* ignore */ }
      this.source = null;
    }
  }

  stop() {
    this.stopSource();
    this.playing = false;
    this._pausedAt = 0;
  }

  setVolume(v) {
    if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, v));
  }

  /* -------------------------------------------------------------------- */
  /* clock                                                                 */
  /* -------------------------------------------------------------------- */

  /** Refresh the (performance.now, audio) calibration pair. Call once/frame. */
  _sample() {
    this._perfAtSample = performance.now();
    this._audioAtSample = this._raw();
  }

  /** Raw buffer position without latency / user compensation. */
  _raw() {
    if (!this.ctx) return 0;
    if (!this.playing) return this._pausedAt;
    return this._seekBase + (this.ctx.currentTime - this._origin);
  }

  /**
   * Gameplay time in seconds: buffer position, advanced by the audio clock,
   * minus the output latency and the player's calibration offset.
   */
  now() {
    let t = this.playing
      ? this._seekBase + (this.ctx.currentTime - this._origin)
      : this._pausedAt;
    t -= this.outputLatency;
    t -= this.userOffset;
    return t;
  }

  /** True once the track has run past its end. */
  get ended() {
    return this.duration > 0 && this._raw() >= this.duration - 0.02;
  }

  /**
   * Map an input event's `event.timeStamp` (same origin as `performance.now()`)
   * onto the gameplay timeline.  Events are usually stamped a few ms before the
   * frame that consumes them, so this recovers real sub-frame accuracy.
   */
  stampFor(eventTimeStamp) {
    if (typeof eventTimeStamp !== 'number' || !this._perfAtSample) return this.now();
    const delta = (eventTimeStamp - this._perfAtSample) / 1000;
    // Guard against stale/absurd stamps and events from before the last sample.
    const clamped = Math.max(-0.12, Math.min(0.12, delta));
    return this.now() + clamped;
  }

  /* -------------------------------------------------------------------- */
  /* visualisation                                                         */
  /* -------------------------------------------------------------------- */

  /** Log-spaced spectrum magnitudes in 0..1, or null when unavailable. */
  spectrum(barCount = 64) {
    if (!this.analyser || !this.playing) return null;
    this.analyser.getByteFrequencyData(this.freqData);
    const bins = this.freqData.length;
    const out = new Float32Array(barCount);
    for (let i = 0; i < barCount; i++) {
      // logarithmic band edges: music lives in the low bins
      const lo = Math.floor(Math.pow(bins, i / barCount)) - 1;
      const hi = Math.max(lo + 1, Math.floor(Math.pow(bins, (i + 1) / barCount)));
      let sum = 0;
      for (let b = lo; b < hi && b < bins; b++) sum += this.freqData[b];
      out[i] = (sum / Math.max(1, hi - lo)) / 255;
    }
    return out;
  }

  /** Smoothed broadband level 0..1, used to drive the bloom. */
  level() {
    if (!this.analyser || !this.playing) return 0;
    this.analyser.getByteFrequencyData(this.freqData);
    let sum = 0;
    for (let i = 0; i < 64; i++) sum += this.freqData[i];
    return Math.min(1, sum / (64 * 200));
  }

  /* -------------------------------------------------------------------- */
  /* hit sound                                                             */
  /* -------------------------------------------------------------------- */

  /**
   * Build the hit sound once, as PCM, instead of spawning oscillators per hit.
   *
   * A rhythm game fires several of these per second, so the sound has to be
   * allocation-free at play time.  The timbre is deliberately "crisp": a very
   * short noise transient for the attack, plus two fast-decaying high partials
   * a fifth apart, which reads as a wooden tick rather than a beep.
   */
  _buildHitBuffer() {
    const rate = this.ctx.sampleRate;
    const len = Math.round(rate * 0.085);
    const buf = this.ctx.createBuffer(1, len, rate);
    const out = buf.getChannelData(0);

    const attack = Math.round(rate * 0.0025);   // 2.5 ms of noise
    for (let i = 0; i < len; i++) {
      const t = i / rate;

      // click: filtered noise burst
      let s = 0;
      if (i < attack) {
        const env = Math.exp(-i / (attack * 0.34));
        s += (Math.random() * 2 - 1) * env * 0.55;
      }

      // body: two partials, the upper one quieter and shorter
      const e1 = Math.exp(-t * 95);
      s += Math.sin(2 * Math.PI * 1980 * t) * e1 * 0.55;
      s += Math.sin(2 * Math.PI * 2970 * t) * Math.exp(-t * 150) * 0.25;

      // a touch of low body so it is not pure treble
      s += Math.sin(2 * Math.PI * 640 * t) * Math.exp(-t * 70) * 0.18;

      // 2 ms fade-out at the very start avoids a DC step on some devices
      const lead = Math.min(1, i / Math.max(1, Math.round(rate * 0.0002)));
      out[i] = Math.max(-1, Math.min(1, s * lead));
    }
    return buf;
  }

  /** Prepare the hit sound (call once after init). */
  prepareHitSound(volume = 0.5) {
    if (!this.ctx) return;
    if (!this._hitBuf) this._hitBuf = this._buildHitBuffer();
    if (!this._hitGain) {
      this._hitGain = this.ctx.createGain();
      this._hitGain.gain.value = volume;
      // straight to the output: the hit sound must not be delayed by the
      // analyser's FFT window
      this._hitGain.connect(this.ctx.destination);
    } else {
      this._hitGain.gain.value = volume;
    }
  }

  setHitVolume(v) {
    this._hitVolume = v;
    if (this._hitGain) this._hitGain.gain.value = Math.max(0, Math.min(1, v));
  }

  /**
   * Play one hit.
   *
   * `rate` transposes the same buffer per lane, so a four-note chord sounds
   * like a chord instead of four identical clicks.
   */
  playHit(rate = 1, gain = 1) {
    if (!this.ctx || !this._hitBuf || !this._hitGain) return;
    if (this._hitVolume <= 0) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this._hitBuf;
    src.playbackRate.value = rate;
    if (gain !== 1) {
      const g = this.ctx.createGain();
      g.gain.value = gain;
      src.connect(g);
      g.connect(this._hitGain);
    } else {
      src.connect(this._hitGain);
    }
    try {
      src.start();
    } catch { /* the context went away mid-hit */ }
  }
}
