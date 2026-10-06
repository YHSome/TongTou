/**
 * BGA (background animation) layer.
 *
 * The video is a plain <video> element behind the canvas, so it is not driven by
 * the audio clock.  Two clocks are therefore reconciled every frame:
 *
 *   - `video.currentTime` seeks smoothly but drifts,
 *   - the audio clock is authoritative.
 *
 * A small drift is corrected with `playbackRate`, a large one with a hard seek,
 * and `requestVideoFrameCallback` is used (when available) so the correction is
 * applied right after a frame is presented rather than mid-decode.
 */

export class BgaLayer {
  constructor(videoEl) {
    this.video = videoEl;
    this.ready = false;
    this.failed = false;
    this.hasSource = false;
    this._hardSeekThreshold = 0.14;   // seconds
    this._rateClamp = 0.06;           // max +-6% rate trim
    this._lastRateTrim = 1;
    this._vfcHandle = null;
    this._pendingSync = 0;
  }

  static canPlay() {
    return typeof document !== 'undefined';
  }

  /** Point the layer at a file. Resolves even on failure (BGA is optional). */
  load(url) {
    this.hasSource = false;
    this.ready = false;
    this.failed = false;
    if (!url || !BgaLayer.canPlay()) return Promise.resolve(false);

    const v = this.video;
    v.src = encodeURI(url);
    v.muted = true;                 // audio comes from the Web Audio graph
    v.loop = false;
    v.playsInline = true;
    v.preload = 'auto';
    v.playbackRate = 1;

    return new Promise((resolve) => {
      const done = (ok) => {
        v.removeEventListener('loadeddata', onOk);
        v.removeEventListener('error', onErr);
        clearTimeout(timer);
        this.ready = ok;
        this.failed = !ok;
        this.hasSource = ok;
        v.classList.toggle('ready', ok);
        resolve(ok);
      };
      const onOk = () => done(true);
      const onErr = () => done(false);
      // a 6 s budget — a huge file may still be buffering, which is fine
      const timer = setTimeout(() => done(v.readyState >= 2), 6000);

      v.addEventListener('loadeddata', onOk, { once: true });
      v.addEventListener('error', onErr, { once: true });
      try { v.load(); } catch { /* ignore */ }
    });
  }

  get available() {
    return this.hasSource && !this.failed && this.video.readyState >= 2;
  }

  setVisible(on) {
    this.video.classList.toggle('ready', !!on && this.available);
  }

  /** Called on play / resume / seek. */
  sync(force = true) {
    if (!this.available) return;
    this._pendingSync = force ? 2 : this._pendingSync;
  }

  /**
   * Attach to `audioTime`. Cheap: only called when the video can present a
   * frame, or once per frame as a fallback.
   */
  update(audioTime, isPlaying) {
    if (!this.available) return;
    const v = this.video;

    if (!isPlaying) {
      if (!v.paused) v.pause();
      return;
    }
    if (v.paused) {
      v.play().catch(() => { /* autoplay policy — silent, visuals only */ });
    }

    this._applyDrift(audioTime);
  }

  _applyDrift(audioTime) {
    const v = this.video;
    const drift = v.currentTime - audioTime;

    if (this._pendingSync > 0 || Math.abs(drift) > this._hardSeekThreshold) {
      // hard resync: cheap on a local file and immediately correct
      try {
        const t = Math.max(0, Math.min(audioTime, (v.duration || audioTime) - 0.05));
        if (Math.abs(drift) > 0.02 || this._pendingSync > 0) v.currentTime = t;
      } catch { /* seeking while not seekable */ }
      this._pendingSync = Math.max(0, this._pendingSync - 1);
      v.playbackRate = 1;
      this._lastRateTrim = 1;
      return;
    }

    // soft correction: nudge the rate so the video catches up imperceptibly
    const target = Math.max(1 - this._rateClamp, Math.min(1 + this._rateClamp, 1 - drift * 0.25));
    if (Math.abs(target - this._lastRateTrim) > 0.004) {
      v.playbackRate = target;
      this._lastRateTrim = target;
    }
  }

  pause() {
    if (this.available && !this.video.paused) this.video.pause();
  }

  async resume(audioTime) {
    if (!this.available) return;
    try {
      this.video.currentTime = Math.max(0, audioTime);
      await this.video.play();
    } catch { /* ignore */ }
  }

  seek(audioTime) {
    if (!this.available) return;
    try { this.video.currentTime = Math.max(0, audioTime); } catch { /* ignore */ }
  }

  stop() {
    if (!this.available) return;
    this.pause();
    try { this.video.currentTime = 0; } catch { /* ignore */ }
  }
}
