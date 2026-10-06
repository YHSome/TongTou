/**
 * Canvas renderer.
 *
 * One canvas covers the whole viewport and draws, in order:
 *   field background -> beat lines -> notes -> key glow -> hit effects
 *   -> left HUD -> judgement -> visualiser.
 *
 * Resolution: the backing store is sized independently of CSS pixels, so the
 * game genuinely renders at 3840x2160 on a 4K target (`renderScale: '2160'`) or
 * at native DPR when set to auto.  Every layout value is derived from the
 * backing size, so a 1080p and a 4K render are geometrically identical.
 *
 * Cost control: the static field background and the per-lane note bodies are
 * rasterised once into offscreen canvases on resize, then blitted.
 */

import {
  LANE_COLORS, LAYOUT, HANDHELD_LAYOUT, PIXEL_BUDGET, JUDGE_COLORS, RENDER_SCALES, GAUGE_MAX,
  HIT_FX, FX_LEVEL, detectHandheld, codeLabel,
} from './config.js';

/** How long the receptor stays punched after a hit, in seconds. */
const PULSE_LIFE = 0.19;

/** Hard ceiling on live effects; see the prune step in `ingest`. */
const MAX_EFFECTS = 600;

/** Concert pyro burst length, in seconds. */
export const FIRE_DURATION = 3.5;

/** Deterministic 0..1 hash, so particles are reproducible from their index. */
function hash01(a, b) {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** Interpolation used by the burst envelope. */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Smooth 0..1 ramp — a linear attack reads as a strobe, this reads as a flame. */
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
};

const FONT = '"Inter","Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif';
const MONO = '"JetBrains Mono","Cascadia Mono",Consolas,monospace';

/** Score shown with leading zeros, arcade style. */
const pad = (n, w) => String(Math.max(0, Math.round(n))).padStart(w, '0');

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });

    this.W = 0;   // backing store size
    this.H = 0;
    this.scale = 1;

    this.bg = document.createElement('canvas');
    this.bgCtx = this.bg.getContext('2d');
    this.sprites = [];
    this.receptors = [];

    this.effects = [];
    this._comboPop = 0;
    this._judgePop = 0;
    this._gaugeGhost = GAUGE_MAX;
    this._lastJudge = null;
    this._cueCache = { key: '', sprite: null };
  }

  /* -------------------------------------------------------------------- */
  /* sizing                                                                */
  /* -------------------------------------------------------------------- */

  resize(renderScaleId, cssW, cssH, dpr, layoutPref = 'auto') {
    const preset = RENDER_SCALES.find((r) => r.id === renderScaleId) || RENDER_SCALES[0];

    // device class decides both geometry and the pixel budget
    this.handheld = layoutPref === 'handheld'
      || (layoutPref !== 'desktop' && detectHandheld(cssW, cssH));

    let scale;
    if (preset.height > 0) {
      // an explicit target: render exactly that many vertical pixels
      scale = preset.height / Math.max(1, cssH);
    } else {
      // auto: honour the device pixel ratio, then clamp to the class budget
      const budget = this.handheld ? PIXEL_BUDGET.handheld : PIXEL_BUDGET.desktop;
      scale = Math.max(1, Math.min(2, dpr || 1));
      const pixels = Math.max(1, cssW * cssH) * scale * scale;
      if (pixels > budget) scale = Math.sqrt(budget / Math.max(1, cssW * cssH));
    }
    // hard ceiling on the backing store (7680 wide keeps every GPU happy)
    const maxW = this.handheld ? 4096 : 7680;
    if (cssW * scale > maxW) scale = maxW / Math.max(1, cssW);

    const w = Math.max(320, Math.round(cssW * scale));
    const h = Math.max(240, Math.round(cssH * scale));

    if (w === this.W && h === this.H && layoutPref === this._lastLayoutPref && !this._layoutDirty) {
      return false;
    }
    this._lastLayoutPref = layoutPref;
    this._layoutDirty = false;

    this.W = w;
    this.H = h;
    this.scale = scale;
    this.canvas.width = w;
    this.canvas.height = h;

    this._layout();
    this._buildField();
    this._buildSprites();
    return true;
  }

  /** Notch / home-indicator insets in CSS pixels, applied to the hand-held HUD. */
  setSafeArea(top, right, bottom, left) {
    const s = this.scale || 1;
    const next = { top: top * s, right: right * s, bottom: bottom * s, left: left * s };
    const prev = this.safe;
    if (prev && prev.top === next.top && prev.right === next.right
      && prev.bottom === next.bottom && prev.left === next.left) return false;
    this.safe = next;
    // the geometry depends on the insets, so the layout must be rebuilt even
    // when the canvas size itself is unchanged (e.g. entering fullscreen)
    this._layoutDirty = true;
    return true;
  }

  /**
   * Width, in CSS pixels, of any DOM chrome floating over the top-left of the
   * hand-held HUD bar (currently the pause button).  The bar is drawn on the
   * canvas, so it cannot flow around a DOM element and has to be told.
   */
  setHudInset(cssPx) {
    const s = this.scale || 1;
    const next = Math.max(0, (Number(cssPx) || 0) * s);
    if (this._hudInset === next) return false;
    this._hudInset = next;
    return true;
  }

  _layout() {
    const { W, H } = this;
    const portrait = W / H < 1.05;
    this.portrait = portrait;
    this.mode = this.handheld ? 'handheld' : 'desktop';

    let fieldX, fieldW, fieldTop, fieldBottom, judgeY;

    if (this.handheld) {
      // Full-width four lanes.  Splitting the whole screen into four columns is
      // the only arrangement that gives each thumb a lane it can actually own,
      // and it works in both orientations.
      const g = portrait ? HANDHELD_LAYOUT.portrait : HANDHELD_LAYOUT.landscape;
      const safe = this.safe || { top: 0, right: 0, bottom: 0, left: 0 };

      // In landscape the notch bites into the outermost lanes, so the field is
      // inset horizontally; in portrait it only pushes the HUD bar down.
      fieldX = portrait ? 0 : safe.left;
      fieldW = portrait ? W : Math.max(W * 0.5, W - safe.left - safe.right);
      this.hudTop = safe.top;
      this.hudBottom = safe.top + H * g.hudHeight;
      fieldTop = this.hudBottom + H * 0.008;
      judgeY = Math.max(fieldTop + H * 0.35, H * g.judgeLine);
      fieldBottom = H * g.fieldBottom;
      this.hudH = this.hudBottom - this.hudTop;
    } else {
      fieldW = H * LAYOUT.fieldWidthOfHeight;
      fieldX = W - fieldW - H * LAYOUT.fieldRightMarginOfHeight;
      fieldTop = H * LAYOUT.fieldTop;
      fieldBottom = H * LAYOUT.fieldBottom;
      judgeY = H * LAYOUT.judgeLine;
      this.hudTop = 0;
      this.hudBottom = 0;
      this.hudH = 0;
    }

    const laneW = fieldW / 4;

    this.L = {
      fieldX,
      fieldW,
      laneW,
      fieldTop,
      fieldBottom,
      judgeY,
      // hand-held lanes are as wide as a quarter of the screen, so the note
      // height is bounded against screen height as well as lane width
      noteH: this.handheld
        ? Math.max(H * 0.018, Math.min(laneW * 0.24, H * 0.040))
        : laneW * 0.24,
      pad: H * 0.018,
      hudX: this.handheld ? W * 0.035 : H * 0.045,
      hudW: this.handheld ? W * 0.93 : Math.max(0, fieldX - H * 0.12),
      radius: Math.max(2, laneW * 0.10),
      lineH: Math.max(1, H * 0.0012),
    };
    this.L.travelDist = this.L.judgeY - this.L.fieldTop;
  }

  /**
   * Map a screen-space point (CSS pixels relative to the canvas) to a lane.
   *
   * Touch targets deliberately extend below the judgement line and, in the
   * hand-held layout, across the entire screen: a player aiming at a fast
   * stream should never miss because their thumb landed a few pixels off.
   */
  hitTest(cssX, cssY) {
    const L = this.L;
    if (!L) return -1;
    const x = cssX * this.scale;
    const y = cssY * this.scale;

    if (this.mode === 'handheld') {
      if (y < L.fieldTop * 0.85) return -1;      // keep taps off the HUD bar
      const lane = Math.floor((x - L.fieldX) / L.laneW);
      return lane >= 0 && lane < 4 ? lane : -1;
    }

    if (x < L.fieldX || x > L.fieldX + L.fieldW) return -1;
    if (y < L.fieldTop) return -1;
    const lane = Math.floor((x - L.fieldX) / L.laneW);
    return lane >= 0 && lane < 4 ? lane : -1;
  }

  /** Lane rectangles in CSS pixels — used to lay out DOM touch hints. */
  laneRects() {
    const L = this.L;
    const s = this.scale;
    return [0, 1, 2, 3].map((lane) => ({
      lane,
      x: (L.fieldX + lane * L.laneW) / s,
      y: L.fieldTop / s,
      w: L.laneW / s,
      h: (this.H - L.fieldTop) / s,
    }));
  }

  /** Travel time in seconds for a note to cross the whole field. */
  travelTime(settings) {
    const speed = Math.max(0.25, Number(settings.scrollSpeed) || 1);
    const base = Math.max(0.25, Number(settings.noteTravel) || 0.82);
    return base / speed;
  }

  /* -------------------------------------------------------------------- */
  /* cached art                                                            */
  /* -------------------------------------------------------------------- */

  _buildField() {
    const { W, H } = this;
    const L = this.L;
    this.bg.width = W;
    this.bg.height = H;
    const c = this.bgCtx;

    c.clearRect(0, 0, W, H);

    // ---- lane beds ------------------------------------------------------- */
    for (let lane = 0; lane < 4; lane++) {
      const x = L.fieldX + lane * L.laneW;
      const col = LANE_COLORS[lane];
      const g = c.createLinearGradient(0, L.fieldTop, 0, L.fieldBottom);
      g.addColorStop(0, 'rgba(6,9,17,0.05)');
      g.addColorStop(0.55, 'rgba(8,12,22,0.42)');
      g.addColorStop(1, 'rgba(10,14,26,0.72)');
      c.fillStyle = g;
      c.fillRect(x, L.fieldTop, L.laneW, L.fieldBottom - L.fieldTop);

      // a whisper of the lane colour at the top
      const tg = c.createLinearGradient(0, L.fieldTop, 0, L.fieldTop + H * 0.16);
      tg.addColorStop(0, hexA(col.base, 0.10));
      tg.addColorStop(1, hexA(col.base, 0));
      c.fillStyle = tg;
      c.fillRect(x, L.fieldTop, L.laneW, H * 0.16);
    }

    // ---- separators ------------------------------------------------------ */
    c.lineWidth = Math.max(1, H * 0.0012);
    for (let i = 0; i <= 4; i++) {
      const x = Math.round(L.fieldX + i * L.laneW) + 0.5;
      const outer = i === 0 || i === 4;
      // on hand-held the outer edges sit on the screen border, so skip them
      if (outer && this.mode === 'handheld') continue;
      c.strokeStyle = outer ? 'rgba(150,180,255,0.34)' : 'rgba(150,180,255,0.16)';
      c.beginPath(); c.moveTo(x, L.fieldTop); c.lineTo(x, L.fieldBottom); c.stroke();
    }

    // ---- field frame ----------------------------------------------------- */
    if (this.mode !== 'handheld') {
      c.strokeStyle = 'rgba(150,180,255,0.30)';
      c.lineWidth = Math.max(2, H * 0.0024);
      c.strokeRect(L.fieldX, L.fieldTop, L.fieldW, L.fieldBottom - L.fieldTop);
    } else {
      // a bright rule along the top edge keeps the lanes readable over the backdrop
      c.fillStyle = 'rgba(150,180,255,0.22)';
      c.fillRect(0, L.fieldTop - Math.max(1, H * 0.0015), W, Math.max(1, H * 0.0015));
    }

    // ---- judging zone glow ----------------------------------------------- */
    const zone = c.createLinearGradient(0, L.judgeY - L.laneW * 0.9, 0, L.judgeY + L.laneW * 0.5);
    zone.addColorStop(0, 'rgba(120,160,255,0)');
    zone.addColorStop(0.72, 'rgba(120,160,255,0.09)');
    zone.addColorStop(1, 'rgba(120,160,255,0)');
    c.fillStyle = zone;
    c.fillRect(L.fieldX, L.judgeY - L.laneW * 0.9, L.fieldW, L.laneW * 1.4);

    // ---- judgement line -------------------------------------------------- */
    c.fillStyle = 'rgba(210,228,255,0.55)';
    c.fillRect(L.fieldX, L.judgeY - H * 0.0015, L.fieldW, H * 0.003);
    c.fillStyle = hexA('#8fb6ff', 0.18);
    c.fillRect(L.fieldX, L.judgeY + H * 0.0015, L.fieldW, H * 0.006);
  }

  _buildSprites() {
    const L = this.L;
    const w = Math.ceil(L.laneW);
    const h = Math.ceil(L.noteH);
    const bh = Math.ceil(L.noteH * 0.34);

    this.sprites = LANE_COLORS.map((col, lane) => {
      const cv = document.createElement('canvas');
      cv.width = Math.max(8, w);
      cv.height = Math.max(6, h);
      const c = cv.getContext('2d');

      const r = Math.min(cv.width, cv.height) * 0.32;
      const g = c.createLinearGradient(0, 0, 0, cv.height);
      g.addColorStop(0, col.glow);
      g.addColorStop(0.30, col.base);
      g.addColorStop(1, col.dark);
      c.fillStyle = g;
      roundRect(c, 1, 1, cv.width - 2, cv.height - 2, r);
      c.fill();

      // inner highlight
      const gi = c.createLinearGradient(0, 0, 0, cv.height);
      gi.addColorStop(0, 'rgba(255,255,255,0.85)');
      gi.addColorStop(0.35, 'rgba(255,255,255,0.10)');
      gi.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = gi;
      roundRect(c, 2, 2, cv.width - 4, cv.height - 4, r * 0.9);
      c.fill();

      c.strokeStyle = 'rgba(255,255,255,0.55)';
      c.lineWidth = Math.max(1, cv.height * 0.06);
      roundRect(c, 1, 1, cv.width - 2, cv.height - 2, r);
      c.stroke();
      return cv;
    });

    // receptors: the idle outline the player aims at
    this.receptors = LANE_COLORS.map((col) => {
      const cv = document.createElement('canvas');
      cv.width = Math.max(8, w);
      cv.height = Math.max(6, bh * 3);
      const c = cv.getContext('2d');
      const y = (cv.height - bh) / 2;
      c.strokeStyle = hexA(col.base, 0.78);
      c.lineWidth = Math.max(1.5, bh * 0.14);
      roundRect(c, 2, y, cv.width - 4, bh, bh * 0.32);
      c.stroke();
      c.fillStyle = hexA(col.base, 0.16);
      c.fill();
      return cv;
    });
  }

  /**
   * Cache the lane cue glyphs.  These follow the player's bindings, so the
   * cache key includes the labels — rebinding a lane must repaint the cue.
   */
  _buildCues(labels) {
    const L = this.L;
    const size = Math.round(L.laneW * 0.30);
    if (size < 8) return null;
    const key = `${size}|${labels.join('\u0000')}`;
    if (this._cueCache.key === key) return this._cueCache.sprite;

    const sprite = labels.map((text, lane) => {
      const cv = document.createElement('canvas');
      const pad2 = Math.ceil(size * 0.10);
      cv.width = size + pad2 * 2;
      cv.height = size + pad2 * 2;
      const c = cv.getContext('2d');
      // shrink long labels ("空格", "N1") so they still fit the lane
      let px = size;
      c.font = `700 ${px}px ${MONO}`;
      const maxW = cv.width * 0.92;
      while (px > 6 && c.measureText(text).width > maxW) {
        px -= 2;
        c.font = `700 ${px}px ${MONO}`;
      }
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = hexA(LANE_COLORS[lane].glow, 0.9);
      c.fillText(text, cv.width / 2, cv.height / 2);
      return cv;
    });
    this._cueCache = { key, sprite };
    return sprite;
  }

  /* -------------------------------------------------------------------- */
  /* effects                                                              */
  /* -------------------------------------------------------------------- */

  /**
   * Turn engine events into visual effects.
   *
   * Every successful hit spawns a small burst of layered effects rather than a
   * single one:
   *
   *   core   bright puck at the receptor, expands and dies fast
   *   wave   expanding shockwave outline around the receptor
   *   beam   light column climbing the lane
   *   flash  the whole lane bed washes with the lane colour
   *   spark  particles with gravity
   *
   * They are layered with additive blending, so the overlapping alpha reads as
   * brightness.  The per-judgement budget lives in `HIT_FX`.
   */
  ingest(events, time) {
    const L = this.L || { laneW: 40, noteH: 10, fieldX: 0, judgeY: 0 };
    if (!this._hitAt) {
      this._hitAt = [-9, -9, -9, -9];
      this._pulsePower = [0, 0, 0, 0];
    }
    const level = FX_LEVEL[this.fxLevel] || FX_LEVEL.normal;

    for (const e of events) {
      if (e.type !== 'judge') continue;
      const { kind, lane } = e;
      const fx = HIT_FX[kind];
      if (!fx) continue;

      this._hitAt[lane] = time;
      this._pulsePower[lane] = fx.pulse * level.glow;
      if (level.glow <= 0 && level.sparks <= 0) continue;

      const color = LANE_COLORS[lane].glow;
      const base = LANE_COLORS[lane].base;

      // ---- the burst ------------------------------------------------------
      if (fx.coreLife > 0) {
        this.effects.push({
          kind: 'core', lane, born: time, life: fx.coreLife,
          power: fx.corePower * level.glow, color,
        });
      }
      if (fx.waveLife > 0) {
        this.effects.push({
          kind: 'wave', lane, born: time, life: fx.waveLife,
          power: fx.corePower * level.glow, reach: fx.waveReach,
          width: fx.waveWidth, color,
        });
      }
      if (fx.beamLife > 0) {
        this.effects.push({
          kind: 'beam', lane, born: time, life: fx.beamLife,
          power: fx.beamPower * level.glow, color,
        });
      }
      if (fx.flashLife > 0) {
        this.effects.push({
          kind: 'flash', lane, born: time, life: fx.flashLife,
          power: fx.flashPower * level.glow, color: kind === 'miss' ? '#ff5d6c' : base,
          miss: kind === 'miss',
        });
      }

      // ---- particles ------------------------------------------------------
      // `born` is pushed into the future by a random delay, which staggers the
      // shower instead of firing every particle on the same frame.  The effect
      // list already treats a future `born` as "not started yet".
      const count = Math.round(fx.sparks * level.sparks);
      for (let i = 0; i < count; i++) {
        // mostly upward, fanned out, with a little randomness in speed
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.3;
        const jitter = 0.55 + Math.random() * 0.9;
        const speed = fx.sparkSpeed * jitter * L.laneW;
        const [l0, l1] = fx.sparkLife;
        this.effects.push({
          kind: 'spark', lane,
          born: time + Math.random() * (fx.sparkDelay || 0),
          life: l0 + Math.random() * (l1 - l0),
          x: L.fieldX + lane * L.laneW + L.laneW * (0.5 + (Math.random() - 0.5) * 0.5),
          y: L.judgeY,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          size: L.laneW * (0.032 + Math.random() * 0.060),
          color: Math.random() < 0.35 ? '#ffffff' : color,
        });
      }
    }

    // Expire by age, then enforce a hard cap.  Age alone is not enough: a
    // pathological burst (or AUTO on a very dense chart) can spawn thousands of
    // effects inside one lifetime window, and nothing would ever be old enough
    // to drop.
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      if (time - e.born > e.life) this.effects.splice(i, 1);
    }
    if (this.effects.length > MAX_EFFECTS) {
      this.effects = this.effects.slice(-MAX_EFFECTS);
    }
  }

  /** Receptor punch for a lane, 0..1, decaying from the last hit. */
  _pulse(lane, time) {
    if (!this._hitAt) return 0;
    const age = time - this._hitAt[lane];
    if (age < 0 || age > PULSE_LIFE) return 0;
    return (1 - age / PULSE_LIFE) * (this._pulsePower ? this._pulsePower[lane] : 0);
  }

  /* -------------------------------------------------------------------- */
  /* main draw                                                             */
  /* -------------------------------------------------------------------- */

  draw(state) {
    const { time, timeline, engine, settings, input, audio, playing } = state;
    this.fxLevel = settings.hitFx || 'normal';
    const c = this.ctx;
    const { W, H } = this;
    const L = this.L;

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, H);

    // ---- background dim over the video ---------------------------------- */
    if (settings.backgroundDim > 0.001) {
      c.fillStyle = `rgba(3,5,10,${settings.backgroundDim})`;
      c.fillRect(0, 0, W, H);
    }

    // ---- concert pyro, behind the lanes --------------------------------- */
    // The cue is evaluated here and painted after the lanes; nothing is drawn
    // behind them any more, but the state has to exist before the HUD reads it.
    this._fireActive = (settings.concertFx !== false)
      ? this._fireState(time, timeline) : [];

    // ---- field ---------------------------------------------------------- */
    c.drawImage(this.bg, 0, 0);

    const travel = this.travelTime(settings);
    this._drawBeatLines(c, time, timeline, travel);

    // ---- notes ---------------------------------------------------------- */
    // Judgement state lives on the *engine's* copy of the notes (the engine
    // clones the timeline so a restart starts clean), so the renderer must read
    // that array — iterating `timeline.notes` would never see a judgement.
    const notes = (engine && engine.notes && engine.notes.length === timeline.total)
      ? engine.notes
      : timeline.notes;
    const horizon = time + travel;
    const floor = time - 0.35;
    const start = timeline.firstIndexAtOrAfter(floor);
    const laneX = (lane) => L.fieldX + lane * L.laneW;

    for (let i = start; i < notes.length; i++) {
      const n = notes[i];

      // A judged note is consumed: successful hits vanish on the spot (the
      // burst replaces them), misses fall through and slide past the line.
      if (n.judged && n.judged !== 'miss') continue;
      if (n.time > horizon) break;
      if (n.judged && time - n.judgedAt > 0.30) continue;

      const dt = n.time - time;
      const y = L.judgeY - (dt / travel) * L.travelDist;
      if (y < L.fieldTop - L.noteH * 2) continue;

      const x = laneX(n.lane);
      const h = L.noteH * (0.86 + 0.28 * (n.size || 0.6));

      if (n.judged) {
        // miss: dim, drop and fade so the failure is visible
        const age = Math.min(1, (time - n.judgedAt) / 0.30);
        c.globalAlpha = 0.55 * (1 - age);
        c.drawImage(this.sprites[n.lane], x + L.laneW * 0.06, y - h / 2, L.laneW * 0.88, h);
        c.globalAlpha = 1;
        continue;
      }

      c.drawImage(this.sprites[n.lane], x + L.laneW * 0.06, y - h / 2, L.laneW * 0.88, h);
    }

    // ---- receptors + key glow ------------------------------------------- */
    this._drawReceptors(c, input, time);

    // ---- hit effects ----------------------------------------------------- */
    this._drawEffects(c, time);

    // ---- cues ------------------------------------------------------------ */
    this._drawCues(c, settings, time);

    // ---- pyro grade, over the lanes -------------------------------------- */
    if (this._fireActive.length) this._drawShowCue(c, time);

    // ---- HUD (draws the visualiser itself, in the right place per layout) - */
    this._drawHud(c, state);
  }

  /* -------------------------------------------------------------------- */

  _drawBeatLines(c, time, timeline, travel) {
    const L = this.L;
    const beat = timeline.beat;
    const first = Math.floor((time - timeline.offset) / beat) - 1;
    const last = Math.ceil((time + travel - timeline.offset) / beat) + 1;

    for (let k = Math.max(-4, first); k <= last; k++) {
      const bt = timeline.offset + k * beat;
      const dt = bt - time;
      if (dt > travel || dt < -0.05) continue;
      const y = L.judgeY - (dt / travel) * L.travelDist;
      if (y < L.fieldTop) continue;

      const bar = ((k % 4) + 4) % 4 === 0;
      const alpha = bar ? 0.30 : 0.11;
      const fade = 1 - Math.max(0, (y - L.fieldTop) / (L.fieldBottom - L.fieldTop)) * 0.2;
      c.fillStyle = `rgba(180,210,255,${alpha * fade})`;
      c.fillRect(L.fieldX, y, L.fieldW, L.lineH);
    }
  }

  _drawReceptors(c, input, time) {
    const L = this.L;
    for (let lane = 0; lane < 4; lane++) {
      const x = L.fieldX + lane * L.laneW;
      const held = input && input.held[lane];
      const spr = this.receptors[lane];

      // the receptor punches outward on a hit, so the press is felt as motion
      const pulse = this._pulse(lane, time);
      const scale = 1 + pulse * 1.05;
      const w = spr.width * scale;
      const hh = spr.height * scale;
      const y = L.judgeY - hh / 2;

      if (held || pulse > 0.02) {
        const glow = Math.max(held ? 0.30 : 0, pulse * 0.85);
        const g = c.createLinearGradient(0, y - hh, 0, y + hh);
        g.addColorStop(0, hexA(LANE_COLORS[lane].glow, 0));
        g.addColorStop(0.5, hexA(LANE_COLORS[lane].glow, glow));
        g.addColorStop(1, hexA(LANE_COLORS[lane].glow, 0));
        c.fillStyle = g;
        c.fillRect(x - w * 0.06, y - hh, w * 1.12, hh * 2);
      }

      c.globalAlpha = held || pulse > 0.05 ? 1 : 0.75;
      c.drawImage(spr, x + (L.laneW - w) / 2, y, w, hh);
      c.globalAlpha = 1;
    }
  }

  _drawCues(c, settings, time) {
    if (!settings.showKeyCues) return;
    const L = this.L;

    // On a touch device the whole lane column is the button, so keyboard
    // letters would be misleading.  A soft "tap zone" wash under the judgement
    // line tells the player where their thumbs belong instead.
    if (this.mode === 'handheld') {
      const top = L.judgeY + L.noteH * 1.2;
      const h = this.H - top;
      if (h < this.H * 0.05) return;
      for (let lane = 0; lane < 4; lane++) {
        const x = L.fieldX + lane * L.laneW;
        const g = c.createLinearGradient(0, top, 0, this.H);
        g.addColorStop(0, hexA(LANE_COLORS[lane].base, 0.10));
        g.addColorStop(1, hexA(LANE_COLORS[lane].base, 0.02));
        c.fillStyle = g;
        c.fillRect(x + L.laneW * 0.06, top, L.laneW * 0.88, h);
      }
      return;
    }

    const labels = (settings.laneKeys && settings.laneKeys.length === 4)
      ? settings.laneKeys.map(codeLabel)
      : ['D', 'F', 'J', 'K'];
    const cues = this._buildCues(labels);
    if (!cues || !cues[0]) return;

    // Centre the letters in the strip between the judgement line and the bottom
    // of the field.  Deriving the position from the available band (instead of
    // a fixed offset) keeps them clear of the progress bar below the field.
    const bandTop = L.judgeY + L.noteH * 0.85;
    const bandBottom = L.fieldBottom - this.H * 0.004;
    const sprH = cues[0].height;
    if (bandBottom - bandTop < sprH) return;
    const y = bandTop + (bandBottom - bandTop - sprH) / 2;

    for (let lane = 0; lane < 4; lane++) {
      const spr = cues[lane];
      c.globalAlpha = 0.46;
      c.drawImage(spr, L.fieldX + lane * L.laneW + (L.laneW - spr.width) / 2, y);
      c.globalAlpha = 1;
    }
  }

  /** Wipe the canvas — used when leaving gameplay for a DOM screen. */
  clear() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.W, this.H);
    this.effects.length = 0;
  }

  /* -------------------------------------------------------------------- */
  /* concert pyro ("爆火")                                                 */
  /* -------------------------------------------------------------------- */

  /**
   * Which bursts are alive right now, and how strongly.
   *
   * Kept separate from the drawing so the frame can also drive the whole-screen
   * colour grade from `this.fireGlow`, and so the two drawing passes (behind
   * and in front of the lanes) agree on the envelope.
   */
  _fireState(time, timeline) {
    this.fireGlow = 0;
    if (!timeline || !timeline.events || !timeline.events.length) return [];

    const out = [];
    for (const ev of timeline.events) {
      if (ev.type !== 'fire') continue;
      const u = (time - ev.time) / FIRE_DURATION;
      if (u < 0 || u >= 1) continue;
      // overall presence: gentle build, long warm tail.  A hard attack read as
      // a strobe rather than a flame, and a fast release snapped the whole
      // grade back to cold.
      const glow = smoothstep(0, 0.18, u) * (1 - smoothstep(0.66, 1.02, u));
      out.push({ ev, u, glow });
      if (glow > this.fireGlow) this.fireGlow = glow;
    }
    return out;
  }

  /**
   * The show cue: the screen frame turns gold.
   *
   * The layout on both desktop and hand-held is four lanes that own the middle
   * of the screen, so anything painted across the centre competes with the
   * notes.  A frame plus an edge bloom lives entirely in the margin, costs a
   * handful of draw calls instead of eighty gradients, and still reads as "the
   * place just went off" from arm's length.
   *
   * (This replaced a curtain of stage-pyro flames.  At any frame rate they read
   * as a texture map rather than as fire, and the warm colour grade over the
   * backdrop — which is what actually sells the moment — is unchanged.)
   */
  _drawShowCue(c, time) {
    this._drawAura(c, this._fireActive || [], time);
  }

  _drawAura(c, active, time) {
    const { W, H } = this;
    const level = FX_LEVEL[this.fxLevel] || FX_LEVEL.normal;
    const gain = level.glow || 1;

    // overlapping bursts: keep the strongest
    let glow = 0;
    for (const a of active) if (a.glow > glow) glow = a.glow;
    if (glow <= 0.004) return;

    const base = H * 0.016;
    const radius = H * 0.028;
    // keep the frame clear of the notch / home indicator
    const safe = this.safe || { top: 0, right: 0, bottom: 0, left: 0 };
    const iL = base + safe.left;
    const iR = base + safe.right;
    const iT = base + safe.top;
    const iB = base + safe.bottom;
    // slow breathing, so it feels lit rather than switched on
    const pulse = 0.88 + 0.12 * Math.sin(time * 2.3) + 0.05 * Math.sin(time * 5.7 + 1.1);
    const a = Math.min(1, glow * gain * pulse);

    c.save();
    c.globalCompositeOperation = 'lighter';

    // ---- bloom creeping in from every edge ---------------------------
    const band = H * 0.10;
    const edges = [
      [0, 0, 0, band], [0, H, 0, H - band],
      [0, 0, band, 0], [W, 0, W - band, 0],
    ];
    for (const [x0, y0, x1, y1] of edges) {
      const g = c.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, `rgba(255,196,92,${0.30 * a})`);
      g.addColorStop(0.45, `rgba(255,158,48,${0.10 * a})`);
      g.addColorStop(1, 'rgba(255,120,0,0)');
      c.fillStyle = g;
      if (y0 === y1) c.fillRect(Math.min(x0, x1), 0, band, H);
      else c.fillRect(0, Math.min(y0, y1), W, band);
    }

    // ---- the golden frame --------------------------------------------
    // three strokes of decreasing width give a glow without shadowBlur, which
    // is far too expensive to run per frame on a phone
    const gold = (alpha, mid) => {
      const g = c.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, `rgba(255,232,164,${alpha})`);
      g.addColorStop(0.5, `rgba(255,${mid},72,${alpha * 0.7})`);
      g.addColorStop(1, `rgba(255,238,182,${alpha})`);
      return g;
    };
    const x = iL;
    const y = iT;
    const w = W - iL - iR;
    const h = H - iT - iB;

    c.strokeStyle = gold(0.055 * a, 186);
    c.lineWidth = H * 0.030 * a;
    roundRect(c, x, y, w, h, radius); c.stroke();

    c.strokeStyle = gold(0.16 * a, 176);
    c.lineWidth = H * 0.013 * a;
    roundRect(c, x, y, w, h, radius); c.stroke();

    c.strokeStyle = gold(0.72 * a, 214);
    c.lineWidth = Math.max(1.5, H * 0.0042 * a);
    roundRect(c, x, y, w, h, radius); c.stroke();

    // ---- brighter corner brackets ------------------------------------
    const r = radius;
    const corners = [
      [x + r, y + r, Math.PI, Math.PI * 1.5],
      [x + w - r, y + r, Math.PI * 1.5, Math.PI * 2],
      [x + w - r, y + h - r, 0, Math.PI * 0.5],
      [x + r, y + h - r, Math.PI * 0.5, Math.PI],
    ];
    c.strokeStyle = gold(0.95 * a, 226);
    c.lineWidth = Math.max(2, H * 0.0075 * a);
    c.lineCap = 'round';
    for (const [cx, cy, s, e] of corners) {
      c.beginPath();
      c.arc(cx, cy, r, s, e);
      c.stroke();
    }

    // ---- slow golden motes in the margin only ------------------------
    // Confined to the border band, so they can never clutter the lanes.
    const bandW = H * 0.075;
    for (let i = 0; i < 54; i++) {
      const life = 2.6 + hash01(i, 71.3) * 2.2;
      const delay = hash01(i, 83.9) * 3.2;
      const k = time - (active[0].ev.time + delay);
      if (k <= 0 || k >= life) continue;
      const age = k / life;
      const t = clamp01(age * 1.15);

      const lane = i % 4;
      const along = hash01(i, 91.1);
      const depth = hash01(i, 97.7) * bandW;
      const drift = (hash01(i, 55.1) - 0.5) * bandW * 1.4;
      let px;
      let py;
      if (lane === 0) { px = along * W; py = depth + drift; }
      else if (lane === 1) { px = along * W; py = H - depth - drift; }
      else if (lane === 2) { px = depth + drift; py = along * H; }
      else { px = W - depth - drift; py = along * H; }

      const alpha = 0.55 * Math.sin(Math.PI * t) * a;
      if (alpha < 0.01) continue;
      const size = Math.max(1, H * 0.0035 * (0.6 + hash01(i, 61.7)));
      c.fillStyle = `rgba(255,${216 - t * 60 | 0},${140 - t * 90 | 0},${alpha})`;
      c.beginPath();
      c.arc(px, py, size, 0, Math.PI * 2);
      c.fill();
    }

    c.restore();
  }

  _drawEffects(c, time) {
    const L = this.L;
    if (!this.effects.length) return;
    const midX = (lane) => L.fieldX + lane * L.laneW + L.laneW / 2;
    const laneTop = L.fieldTop;
    const laneH = L.fieldBottom - L.fieldTop;

    c.save();
    c.globalCompositeOperation = 'lighter';

    for (const e of this.effects) {
      const age = (time - e.born) / e.life;
      if (age < 0 || age > 1) continue;
      const k = 1 - age;

      switch (e.kind) {
        case 'flash': {
          // whole lane bed washes with the lane colour
          const x = L.fieldX + e.lane * L.laneW;
          const g = c.createLinearGradient(0, L.judgeY - laneH * 0.22, 0, L.judgeY + laneH * 0.12);
          g.addColorStop(0, hexA(e.color, 0));
          g.addColorStop(0.7, hexA(e.color, e.power * k * 0.5));
          g.addColorStop(1, hexA(e.color, 0));
          c.fillStyle = g;
          c.fillRect(x, laneTop, L.laneW, laneH);
          break;
        }

        case 'beam': {
          const x = L.fieldX + e.lane * L.laneW;
          const hgt = L.travelDist * (0.34 + 0.30 * e.power) * (0.5 + 0.5 * k);
          const g = c.createLinearGradient(0, L.judgeY - hgt, 0, L.judgeY);
          g.addColorStop(0, hexA(e.color, 0));
          g.addColorStop(0.6, hexA(e.color, 0.20 * k * e.power));
          g.addColorStop(1, hexA(e.color, 0.58 * k * e.power));
          c.fillStyle = g;
          c.fillRect(x, L.judgeY - hgt, L.laneW, hgt);
          break;
        }

        case 'wave': {
          // expanding shockwave outline around the receptor
          const r = L.laneW * (0.30 + e.reach * age);
          c.strokeStyle = hexA(e.color, 0.62 * k * e.power);
          c.lineWidth = Math.max(1.5, L.noteH * 0.30 * e.width * k);
          roundRect(c, midX(e.lane) - r, L.judgeY - r * 0.44, r * 2, r * 0.88, r * 0.44);
          c.stroke();
          break;
        }

        case 'core': {
          // a lane-wide ellipse flash right on the judgement line.  The white
          // is kept concentrated in the middle: spreading it over the whole
          // ellipse just washes out instead of punching.
          const rx = L.laneW * (0.28 + 0.32 * age);
          const ry = rx * 0.50;
          const g = c.createRadialGradient(midX(e.lane), L.judgeY, 0, midX(e.lane), L.judgeY, rx);
          g.addColorStop(0, hexA('#ffffff', 1.00 * k * e.power));
          g.addColorStop(0.22, hexA('#ffffff', 0.80 * k * e.power));
          g.addColorStop(0.55, hexA(e.color, 0.50 * k * e.power));
          g.addColorStop(1, hexA(e.color, 0));
          c.fillStyle = g;
          c.beginPath();
          c.ellipse(midX(e.lane), L.judgeY, rx, ry, 0, 0, Math.PI * 2);
          c.fill();

          // a thin bright rule along the line reads as the "cut"
          const lw = L.laneW * 0.86;
          c.fillStyle = hexA('#ffffff', 0.85 * k * k * e.power);
          c.fillRect(midX(e.lane) - lw / 2, L.judgeY - L.noteH * 0.14 * k,
            lw, Math.max(1.5, L.noteH * 0.26 * k));
          break;
        }

        case 'spark': {
          const t = time - e.born;
          const px = e.x + e.vx * t;
          const py = e.y + e.vy * t + 0.5 * 1500 * t * t;
          if (py > L.fieldBottom + L.laneW) break;
          c.globalAlpha = Math.min(1, k * 1.4);
          c.fillStyle = e.color;
          c.beginPath();
          c.arc(px, py, Math.max(0.8, e.size * k), 0, Math.PI * 2);
          c.fill();
          c.globalAlpha = 1;
          break;
        }

        default:
          break;
      }
    }
    c.restore();
  }

  /* -------------------------------------------------------------------- */
  /* HUD                                                                   */
  /* -------------------------------------------------------------------- */

  _drawHud(c, state) {
    if (this.mode === 'handheld') this._drawHudHandheld(c, state);
    else this._drawHudDesktop(c, state);
  }

  /**
   * Hand-held HUD: the lanes own the whole screen, so every readout lives in a
   * compact top bar and nothing is drawn where a thumb might land.
   */
  _drawHudHandheld(c, state) {
    const { engine, timeline, settings, audio } = state;
    const { W } = this;
    const H = this.H;
    const portrait = this.portrait;
    // `inset` is also the score-padding helper, so the inset gets its own name
    const inset = Math.max(W * 0.035, (this.safe && this.safe.left) || 0);
    const barTop = this.hudTop || 0;
    const barBottom = this.hudBottom || H * 0.15;
    const barH = barBottom - barTop;

    // ---- bar background ---------------------------------------------------
    const g = c.createLinearGradient(0, barTop, 0, barBottom);
    g.addColorStop(0, 'rgba(5,8,15,0.92)');
    g.addColorStop(1, 'rgba(5,8,15,0.42)');
    c.fillStyle = g;
    c.fillRect(0, barTop, W, barH);

    // spectrum tucked behind the bar so it costs no vertical space
    if (settings.visualizer && audio) {
      this._drawVisualizer(c, audio, {
        x: 0, y: barTop, w: W, h: barH * 0.6, bars: portrait ? 44 : 64, alpha: 0.45,
      });
    }

    const nameSize = Math.round(H * (portrait ? 0.021 : 0.030));
    const subSize = Math.round(H * (portrait ? 0.0115 : 0.0165));
    const scoreSize = Math.round(H * (portrait ? 0.030 : 0.042));

    const rowTop = barTop + barH * 0.10;
    const row1 = rowTop + nameSize;
    const row2 = row1 + subSize * 1.35;

    // ---- left: track ------------------------------------------------------
    // the pause button floats over this corner, so the text block starts after
    // it; the right-aligned readouts keep the plain inset
    const textX = Math.max(inset, this._hudInset || 0);
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.fillStyle = '#eef4ff';
    c.font = `800 ${nameSize}px ${FONT}`;
    c.fillText(clip(timeline.meta.title, W * 0.44, c), textX, row1);

    c.fillStyle = 'rgba(160,180,215,0.75)';
    c.font = `500 ${subSize}px ${FONT}`;
    c.fillText(`${timeline.meta.artist} · ${timeline.meta.bpm.toFixed(0)} BPM`, textX, row2);

    // ---- right: score + accuracy -----------------------------------------
    c.textAlign = 'right';
    c.fillStyle = '#ffffff';
    c.font = `700 ${scoreSize}px ${MONO}`;
    c.fillText(String(engine.score), W - inset, row1);

    c.fillStyle = 'rgba(200,220,255,0.40)';
    c.font = `600 ${Math.round(subSize * 0.95)}px ${MONO}`;
    c.fillText(`/ ${engine.maxScore}`, W - inset, row1 + subSize * 1.35);

    c.fillStyle = '#8ef2c4';
    c.font = `700 ${Math.round(subSize * 1.3)}px ${MONO}`;
    c.fillText(`${(engine.accuracy * 100).toFixed(2)}%`, W - inset, row2 + subSize * 1.35);

    // ---- gauge ------------------------------------------------------------
    const gh = Math.max(2, H * 0.008);
    const gy = row2 + subSize * 1.1;
    const gw = W - inset * 2;
    const frac = Math.max(0, Math.min(1, engine.gauge / GAUGE_MAX));

    c.fillStyle = 'rgba(255,255,255,0.10)';
    roundRect(c, inset, gy, gw, gh, gh / 2); c.fill();

    const healthy = frac > 0.30;
    const gcol = frac <= 0.001 ? '#ff5d6c'
      : healthy ? `hsl(${150 + 40 * (1 - frac)} 80% 58%)` : `hsl(${Math.max(0, frac * 300)} 85% 60%)`;
    const gg = c.createLinearGradient(inset, 0, inset + gw, 0);
    gg.addColorStop(0, hexA(gcol, 0.75));
    gg.addColorStop(1, hexA('#ffffff', 0.92));
    c.save();
    roundRect(c, inset, gy, gw, gh, gh / 2); c.clip();
    c.fillStyle = gg;
    c.fillRect(inset, gy, gw * frac, gh);
    // the gauge's starting position, so the player can read the trend at a glance
    c.fillStyle = 'rgba(255,255,255,0.35)';
    c.fillRect(inset + gw * 0.20, gy - gh * 0.5, Math.max(1, gw * 0.003), gh * 2);
    c.restore();

    // ---- judgement counters + max combo, on the gauge's baseline ----------
    const small = Math.round(subSize * 0.95);
    c.font = `600 ${small}px ${MONO}`;
    c.textAlign = 'left';   // the accuracy readout above left it right-aligned
    let cx = inset;
    const cy = gy + gh + small * 1.05;
    for (const [k, label] of [['perfect', 'P'], ['great', 'G'], ['good', 'GD'], ['miss', 'M']]) {
      const txt = `${label} ${engine.counts[k]}`;
      c.fillStyle = hexA(JUDGE_COLORS[k], 0.85);
      c.fillText(txt, cx, cy);
      cx += c.measureText(txt).width + W * 0.024;
    }
    c.textAlign = 'right';
    c.fillStyle = 'rgba(200,220,255,0.5)';
    c.fillText(`MAX ${engine.maxCombo}`, W - inset, cy);

    // The ±ms readout is on by default: seeing how early or late you are hitting
    // only helps *while playing*, which is the opposite of how this used to work
    // (it appeared only when the offset slider moved).  FPS and resolution stay
    // behind `debugTiming` — those are developer noise.  Both share one line, so
    // the bar never grows a second row.
    const showErr = settings.showOffsetGuide && engine.lastJudge;
    if (this.debugTiming || showErr) {
      const parts = [];
      if (this.debugTiming) parts.push(`${Math.round(state.fps || 0)} FPS · ${this.W}×${this.H}`);
      if (showErr) {
        parts.push(`${engine.lastErrorMs >= 0 ? '+' : ''}${engine.lastErrorMs.toFixed(0)} ms`);
      }
      c.textAlign = 'right';
      c.fillStyle = showErr
        ? hexA(JUDGE_COLORS[engine.lastJudge] || '#fff', 0.85)
        : 'rgba(150,175,215,0.7)';
      c.font = `500 ${small}px ${MONO}`;
      c.fillText(parts.join(' · '), W - inset, barTop + small * 1.2);
      c.textAlign = 'left';
    }

    // ---- progress: flush with the bottom edge of the bar -----------------
    const ph = Math.max(1, H * 0.0022);
    c.fillStyle = 'rgba(255,255,255,0.10)';
    c.fillRect(0, barBottom - ph, W, ph);
    c.fillStyle = hexA('#6bcbff', 0.9);
    c.fillRect(0, barBottom - ph, W * engine.progress, ph);

    c.textAlign = 'left';
    this._drawCombo(c, state);
  }

  _drawHudDesktop(c, state) {
    const { engine, timeline, settings, audio } = state;
    const L = this.L;
    const H = this.H;
    const x = L.hudX;
    const maxW = Math.max(120, L.hudW);

    // ---- song plate ------------------------------------------------------ */
    let y = H * 0.085;
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';

    c.fillStyle = 'rgba(200,220,255,0.42)';
    c.font = `600 ${Math.round(H * 0.0135)}px ${FONT}`;
    c.fillText(spaced('TONGTOU // 4K'), x, y);
    y += H * 0.038;

    c.fillStyle = '#eef4ff';
    c.font = `800 ${Math.round(H * 0.046)}px ${FONT}`;
    c.fillText(clip(timeline.meta.title, maxW, c), x, y);
    y += H * 0.028;

    c.fillStyle = 'rgba(160,180,215,0.78)';
    c.font = `500 ${Math.round(H * 0.0165)}px ${FONT}`;
    c.fillText(`${timeline.meta.artist}  ·  BPM ${timeline.meta.bpm.toFixed(0)}  ·  ${timeline.total} NOTES`, x, y);
    y += H * 0.052;

    // ---- score ----------------------------------------------------------- */
    c.fillStyle = 'rgba(200,220,255,0.42)';
    c.font = `600 ${Math.round(H * 0.014)}px ${MONO}`;
    c.fillText('SCORE', x, y);
    c.textAlign = 'right';
    c.fillStyle = 'rgba(200,220,255,0.34)';
    c.font = `600 ${Math.round(H * 0.013)}px ${MONO}`;
    c.fillText(`/ ${engine.maxScore}`, x + maxW * 0.62, y);
    c.textAlign = 'left';
    y += H * 0.052;

    c.fillStyle = '#ffffff';
    c.font = `700 ${Math.round(H * 0.052)}px ${MONO}`;
    c.fillText(String(engine.score), x, y);
    y += H * 0.046;

    // the gauge sets the width of the right-aligned readouts below it
    const gw = Math.min(maxW * 0.62, H * 0.42);

    // ---- accuracy -------------------------------------------------------- */
    c.fillStyle = 'rgba(200,220,255,0.42)';
    c.font = `600 ${Math.round(H * 0.014)}px ${MONO}`;
    c.fillText('ACCURACY', x, y);
    c.textAlign = 'right';
    c.fillStyle = '#8ef2c4';
    c.font = `700 ${Math.round(H * 0.030)}px ${MONO}`;
    c.fillText(`${(engine.accuracy * 100).toFixed(2)}%`, x + gw, y);
    c.textAlign = 'left';
    y += H * 0.040;

    // ---- gauge ----------------------------------------------------------- */
    const gh = H * 0.017;
    const gy = y;
    const frac = Math.max(0, Math.min(1, engine.gauge / GAUGE_MAX));

    // ghost marker showing recent peak (classic groove-gauge feel)
    this._gaugeGhost += (Math.max(frac, this._gaugeGhost) - this._gaugeGhost) * 0.02;
    if (frac > this._gaugeGhost) this._gaugeGhost = frac;

    c.fillStyle = 'rgba(255,255,255,0.07)';
    roundRect(c, x, gy, gw, gh, gh / 2); c.fill();

    const healthy = frac > 0.30;
    const gcol = frac <= 0.001 ? '#ff5d6c'
      : healthy ? `hsl(${150 + 40 * (1 - frac)} 80% 58%)` : `hsl(${Math.max(0, frac * 300)} 85% 60%)`;
    const g = c.createLinearGradient(x, 0, x + gw, 0);
    g.addColorStop(0, hexA(gcol, 0.75));
    g.addColorStop(1, hexA('#ffffff', 0.92));
    c.save();
    roundRect(c, x, gy, gw, gh, gh / 2); c.clip();
    c.fillStyle = g;
    c.fillRect(x, gy, gw * frac, gh);
    // the starting position of the gauge, so the player can read the trend
    const sx = x + gw * (0.20);
    c.fillStyle = 'rgba(255,255,255,0.30)';
    c.fillRect(sx, gy - gh * 0.35, Math.max(1, gw * 0.004), gh * 1.7);
    c.restore();
    y += H * 0.038;

    // ---- judgement counters --------------------------------------------- */
    const order = [['perfect', 'P'], ['great', 'G'], ['good', 'GD'], ['bad', 'B'], ['miss', 'M']];
    c.font = `600 ${Math.round(H * 0.0145)}px ${MONO}`;
    let cx = x;
    for (const [k, label] of order) {
      const txt = `${label} ${engine.counts[k]}`;
      c.fillStyle = hexA(JUDGE_COLORS[k], 0.92);
      c.fillText(txt, cx, y);
      cx += c.measureText(txt).width + H * 0.020;
    }
    y += H * 0.036;

    // ---- max combo ------------------------------------------------------- */
    c.fillStyle = 'rgba(200,220,255,0.42)';
    c.font = `600 ${Math.round(H * 0.014)}px ${MONO}`;
    c.fillText(`MAX COMBO ${engine.maxCombo}`, x, y);

    // ---- combo (over the field) ----------------------------------------- */
    this._drawCombo(c, state);

    // ---- visualiser: bottom-left, clear of the lane field ---------------- */
    if (settings.visualizer && audio) {
      this._drawVisualizer(c, audio, {
        x: L.hudX, y: H * 0.865, w: L.hudW * 0.95, h: H * 0.10, bars: 72,
      });
    }

    // ---- progress -------------------------------------------------------- */
    const py = L.fieldBottom + H * 0.028;
    const pw = L.fieldW;
    c.fillStyle = 'rgba(255,255,255,0.09)';
    c.fillRect(L.fieldX, py, pw, Math.max(2, H * 0.0035));
    c.fillStyle = hexA('#6bcbff', 0.85);
    c.fillRect(L.fieldX, py, pw * engine.progress, Math.max(2, H * 0.0035));

    c.textAlign = 'left';
    c.fillStyle = 'rgba(180,200,235,0.55)';
    c.font = `500 ${Math.round(H * 0.0135)}px ${MONO}`;
    c.fillText(fmtTime(state.time), L.fieldX, py + H * 0.028);
    c.textAlign = 'right';
    c.fillText(fmtTime(timeline.duration), L.fieldX + pw, py + H * 0.028);
    c.textAlign = 'left';

    // ---- live timing readout --------------------------------------------- */
    // Split the same way as the hand-held bar: the error in ms is a player
    // readout (on by default), the frame rate is a developer one.
    if (this.debugTiming) {
      c.textAlign = 'right';
      c.fillStyle = 'rgba(150,175,215,0.55)';
      c.font = `500 ${Math.round(H * 0.0125)}px ${MONO}`;
      c.fillText(`${Math.round(state.fps || 0)} FPS · ${this.W}×${this.H}`,
        L.fieldX + pw, L.fieldTop - H * 0.030);
      c.textAlign = 'left';
    }
    if (settings.showOffsetGuide && engine.lastJudge) {
      const err = engine.lastErrorMs;
      if (err !== undefined) {
        c.textAlign = 'right';
        c.fillStyle = hexA(JUDGE_COLORS[engine.lastJudge] || '#fff', 0.9);
        c.font = `600 ${Math.round(H * 0.015)}px ${MONO}`;
        c.fillText(`${err >= 0 ? '+' : ''}${err.toFixed(1)} ms`,
          L.fieldX + pw, L.fieldTop - H * 0.012);
        c.textAlign = 'left';
      }
    }
  }

  _drawCombo(c, state) {
    const { engine, time, settings } = state;
    const L = this.L;
    const H = this.H;
    const level = FX_LEVEL[settings.hitFx] || FX_LEVEL.normal;

    // pop the combo counter on each increment
    const since = time - engine.lastJudgeAt;
    if (engine.combo > 0 && since < 0.26) this._comboPop = Math.max(this._comboPop, 1 - since / 0.26);

    if (engine.combo >= 2) {
      const cx = L.fieldX + L.fieldW / 2;
      const cy = L.fieldTop + H * 0.145;
      const pop = 1 + this._comboPop * 0.26 * (level.glow || 1);
      const size = H * 0.062 * pop;
      const tint = JUDGE_COLORS[engine.lastJudge] || '#ffffff';

      c.save();
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.globalAlpha = 0.95;
      c.font = `800 ${Math.round(size)}px ${MONO}`;
      c.lineWidth = Math.max(2, size * 0.065);
      c.strokeStyle = 'rgba(5,8,15,0.78)';
      c.strokeText(String(engine.combo), cx, cy);
      // the number picks up the colour of the hit that produced it
      c.fillStyle = this._comboPop > 0.55 ? tint : '#ffffff';
      if (level.glow > 1) {
        c.shadowColor = tint;
        c.shadowBlur = size * 0.30 * this._comboPop;
      }
      c.fillText(String(engine.combo), cx, cy);
      c.shadowBlur = 0;

      c.font = `700 ${Math.round(size * 0.24)}px ${FONT}`;
      c.globalAlpha = 0.6;
      c.fillStyle = '#bcd3ff';
      c.fillText('COMBO', cx, cy + size * 0.68);
      c.restore();
    }
    this._comboPop *= 0.86;

    // judgement text — punched on arrival, then held briefly and faded out
    if (engine.lastJudge && since < 0.62) {
      const k = 1 - since / 0.62;
      const punch = Math.exp(-since / 0.075) * (level.glow || 1);
      const col = JUDGE_COLORS[engine.lastJudge];
      const base = H * 0.038;
      const size = base * (1 + punch * 0.42);
      const alpha = since < 0.42 ? 1 : (1 - since) / 0.20;

      c.save();
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.globalAlpha = Math.max(0, Math.min(1, alpha)) * 0.98;
      c.font = `800 ${Math.round(size)}px ${FONT}`;
      c.lineWidth = Math.max(2, size * 0.06);
      c.strokeStyle = 'rgba(5,8,15,0.72)';
      const label = engine.lastJudge.toUpperCase();
      const y = L.judgeY - H * 0.080;
      c.strokeText(label, L.fieldX + L.fieldW / 2, y);
      if (level.glow > 1) {
        c.shadowColor = col;
        c.shadowBlur = size * 0.34;
      }
      c.fillStyle = col;
      c.fillText(label, L.fieldX + L.fieldW / 2, y);
      c.restore();
    }
  }

  /**
   * Spectrum bars drawn inside `rect` (canvas pixels).
   * Used at the bottom-left on desktop and behind the top bar on hand-held.
   */
  _drawVisualizer(c, audio, rect) {
    const barCount = rect.bars || 72;
    const spectrum = audio.spectrum(barCount);
    if (!spectrum) return;

    const { x, y, w, h } = rect;
    const alpha = rect.alpha ?? 1;
    const bw = w / spectrum.length;

    c.save();
    for (let i = 0; i < spectrum.length; i++) {
      const v = spectrum[i];
      const bh = Math.max(1, v * h);
      const a = (0.20 + v * 0.65) * alpha;
      c.fillStyle = `rgba(${110 + v * 120},${185 + v * 50},255,${a})`;
      c.fillRect(x + i * bw, y + h - bh, Math.max(1, bw * 0.62), bh);
    }
    c.restore();
  }
}

/* ------------------------------------------------------------------------ */
/* small helpers                                                             */
/* ------------------------------------------------------------------------ */

function roundRect(c, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  c.beginPath();
  c.moveTo(x + rr, y);
  c.lineTo(x + w - rr, y);
  c.arcTo(x + w, y, x + w, y + rr, rr);
  c.lineTo(x + w, y + h - rr);
  c.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  c.lineTo(x + rr, y + h);
  c.arcTo(x, y + h, x, y + h - rr, rr);
  c.lineTo(x, y + rr);
  c.arcTo(x, y, x + rr, y, rr);
  c.closePath();
}

/** #rrggbb + alpha -> rgba(...) */
function hexA(hex, a) {
  if (!hex) return `rgba(255,255,255,${a})`;
  if (hex.startsWith('hsl')) return hex;
  const s = hex.replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((ch) => ch + ch).join('') : s, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

function fmtTime(sec) {
  const s = Math.max(0, sec || 0);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

function spaced(text) {
  return text.split('').join(' ');
}

function clip(text, maxW, c) {
  if (!text) return '';
  if (c.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && c.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}
