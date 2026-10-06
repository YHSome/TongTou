/**
 * Static configuration: layout ratios, judgement windows, palette and the
 * persisted user settings model.
 *
 * Everything the renderer needs is expressed as a *fraction of the render
 * target*, so the same numbers produce an identical layout at 1080p, 1440p and
 * 3840x2160 — only the backing-store size changes.
 */

/* ------------------------------------------------------------------------ */
/* judgement                                                                 */
/* ------------------------------------------------------------------------ */

/** Absolute timing windows in seconds, symmetric around the note time. */
export const WINDOW = {
  perfect: 0.022,
  great: 0.045,
  good: 0.080,
  bad: 0.130,
};

/** A note is dead once it is this far past the judgement line unhit. */
export const MISS_AFTER = WINDOW.bad;

export const JUDGEMENTS = ['perfect', 'great', 'good', 'bad', 'miss'];

/**
 * Base value per judgement.
 *
 * These are raw points, not a normalised ratio: the total is simply the sum
 * over every note, so the maximum for a chart is `notes x (100 + 50)` rather
 * than a fixed 1,000,000.  `accuracy` is still a ratio, and is computed from
 * these weights alone, so it keeps its BMS meaning (all-GREAT = 50%,
 * all-GOOD = 25%) independently of the precision bonus.
 */
export const JUDGE_INFO = {
  perfect: { weight: 100, gauge: +0.90, label: 'PERFECT' },
  great: { weight: 50, gauge: +0.55, label: 'GREAT' },
  good: { weight: 25, gauge: +0.10, label: 'GOOD' },
  bad: { weight: 0, gauge: -2.50, label: 'BAD' },
  miss: { weight: 0, gauge: -5.00, label: 'MISS' },
};

/**
 * 「理论值」— the precision bonus.
 *
 * A PERFECT earns its base value plus
 *
 *     PRECISION_MAX_MS - |press time - ideal time| in milliseconds
 *
 * so a dead-on hit is worth 50 extra and the edge of the PERFECT window
 * (22 ms) is still worth 28.  The constant has to stay above the PERFECT
 * window or the bonus could go negative.
 */
export const PRECISION_MAX_MS = 50;

/** The gauge is a 0..100 bar, independent of the score scale. */
export const GAUGE_MAX = 100;
export const GAUGE_START = 20;

/** Rank thresholds are applied to `accuracy`, i.e. judgement quality only. */
export const RANKS = [
  [0.981, 'AAA'],
  [0.950, 'AA'],
  [0.900, 'A'],
  [0.800, 'B'],
  [0.700, 'C'],
  [0.500, 'D'],
  [0.000, 'F'],
];

/* ------------------------------------------------------------------------ */
/* input                                                                     */
/* ------------------------------------------------------------------------ */

/* ------------------------------------------------------------------------ */
/* key bindings                                                              */
/* ------------------------------------------------------------------------ */

/** Lane key bindings are `KeyboardEvent.code` values, so they are layout-independent. */
export const DEFAULT_KEYS = ['KeyD', 'KeyF', 'KeyJ', 'KeyK'];

export const KEY_PRESETS = [
  { id: 'dfjk', label: 'D F J K（默认）', codes: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'] },
  { id: 'askl', label: 'A S K L', codes: ['KeyA', 'KeyS', 'KeyK', 'KeyL'] },
  { id: 'asdf', label: 'A S D F', codes: ['KeyA', 'KeyS', 'KeyD', 'KeyF'] },
  { id: 'jkl;', label: 'J K L ;', codes: ['KeyJ', 'KeyK', 'KeyL', 'Semicolon'] },
  { id: '1234', label: '1 2 3 4', codes: ['Digit1', 'Digit2', 'Digit3', 'Digit4'] },
  { id: 'numpad', label: '小键盘 1 2 4 5', codes: ['Numpad1', 'Numpad2', 'Numpad4', 'Numpad5'] },
];

/**
 * Keys that can never be bound to a lane.
 *
 * These all drive the shell — pause, confirm, menu navigation, browser
 * shortcuts — so stealing one would leave the player unable to leave a run or
 * operate a menu.  Everything else (letters, digits, punctuation, Space) is
 * fair game.
 */
export const RESERVED_KEYS = new Set([
  'Escape', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert',
  'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'CapsLock', 'NumLock', 'ScrollLock', 'ContextMenu',
  'MetaLeft', 'MetaRight',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

export function isReservedKey(code) {
  return RESERVED_KEYS.has(code);
}

/** `KeyboardEvent.code` -> a short label for the HUD and the settings screen. */
export function codeLabel(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) {
    const rest = code.slice(6);
    return rest.length === 1 ? `N${rest}` : rest;
  }
  const named = {
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    Backslash: '\\', BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=',
    Backquote: '`', Space: '空格',
  };
  return named[code] || code;
}

/**
 * Coerce anything into a valid 4-lane binding.
 * Duplicates or reserved keys fall back to the default for that lane, so a
 * corrupted settings blob can never leave the game unplayable.
 */
export function normalizeKeys(value) {
  const out = DEFAULT_KEYS.slice();
  if (!Array.isArray(value)) return out;
  const seen = new Set();
  for (let i = 0; i < 4; i++) {
    const code = value[i];
    if (typeof code !== 'string' || !code || isReservedKey(code) || seen.has(code)) continue;
    seen.add(code);
    out[i] = code;
  }
  return out;
}

/** The preset id matching a binding, or 'custom'. */
export function presetFor(codes) {
  const hit = KEY_PRESETS.find((p) => p.codes.every((c, i) => c === codes[i]));
  return hit ? hit.id : 'custom';
}


/* ------------------------------------------------------------------------ */
/* palette                                                                   */
/* ------------------------------------------------------------------------ */

export const LANE_COLORS = [
  { base: '#ff6b8a', glow: '#ffb3c4', dark: '#7d2233' },
  { base: '#6bcbff', glow: '#b6e4ff', dark: '#1d4b70' },
  { base: '#a78bfa', glow: '#d6c8ff', dark: '#3c2d70' },
  { base: '#ffd166', glow: '#ffecb8', dark: '#6d5320' },
];

export const JUDGE_COLORS = {
  perfect: '#ffe9a8',
  great: '#8ef2c4',
  good: '#7fc4ff',
  bad: '#ff8fa3',
  miss: '#8b93a8',
};

/* ------------------------------------------------------------------------ */
/* hit feedback                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Per-judgement feedback budget.
 *
 * A hit must read instantly: the note is consumed (it stops being drawn at all)
 * and a burst is spawned in its place.  Everything scales with the judgement so
 * a PERFECT is unmistakably louder than a GOOD.
 *
 * `reach` is in lane widths, `sparkSpeed` in lane widths per second.
 */
export const HIT_FX = {
  perfect: {
    sparks: 18, sparkSpeed: 2.6, sparkLife: [0.34, 0.62], sparkDelay: 0.06,
    beamLife: 0.40, beamPower: 1.00,
    waveLife: 0.34, waveReach: 1.30, waveWidth: 1.00,
    coreLife: 0.22, corePower: 1.00,
    flashLife: 0.22, flashPower: 0.55,
    pulse: 0.52,
  },
  great: {
    sparks: 11, sparkSpeed: 1.9, sparkLife: [0.26, 0.48], sparkDelay: 0.05,
    beamLife: 0.28, beamPower: 0.68,
    waveLife: 0.25, waveReach: 1.00, waveWidth: 0.72,
    coreLife: 0.16, corePower: 0.66,
    flashLife: 0.17, flashPower: 0.34,
    pulse: 0.36,
  },
  good: {
    sparks: 6, sparkSpeed: 1.3, sparkLife: [0.20, 0.36], sparkDelay: 0.04,
    beamLife: 0.20, beamPower: 0.42,
    waveLife: 0.18, waveReach: 0.78, waveWidth: 0.52,
    coreLife: 0.13, corePower: 0.40,
    flashLife: 0.13, flashPower: 0.20,
    pulse: 0.22,
  },
  bad: {
    sparks: 3, sparkSpeed: 0.8, sparkLife: [0.16, 0.28], sparkDelay: 0.04,
    beamLife: 0.16, beamPower: 0.22,
    waveLife: 0.14, waveReach: 0.60, waveWidth: 0.40,
    coreLife: 0.10, corePower: 0.20,
    flashLife: 0.12, flashPower: 0.14,
    pulse: 0.12,
  },
  miss: {
    sparks: 0, sparkSpeed: 0, sparkLife: [0, 0], sparkDelay: 0,
    beamLife: 0, beamPower: 0,
    waveLife: 0, waveReach: 0, waveWidth: 0,
    coreLife: 0, corePower: 0,
    flashLife: 0.30, flashPower: 0.34,
    pulse: 0,
  },
};

/** Multipliers applied on top of HIT_FX by the `hitFx` setting. */
export const FX_LEVEL = {
  off: { sparks: 0, glow: 0, splash: 0 },
  normal: { sparks: 1.0, glow: 1.0, splash: 1.0 },
  strong: { sparks: 1.35, glow: 1.5, splash: 1.0 },
};

/* ------------------------------------------------------------------------ */
/* layout (fractions of the render target)                                   */
/* ------------------------------------------------------------------------ */

/**
 * Desktop / BMS layout: the lane field is a vertical strip on the right and the
 * HUD occupies the left.  This assumes a wide screen and a keyboard.
 *
 * On a hand-held device it is replaced entirely by a full-width 4-lane field
 * with a compact top bar (see `Renderer._layout`), because four thumbs-width
 * columns is the only arrangement that is actually playable on a phone.
 */
export const LAYOUT = {
  /** playfield width as a fraction of height — keeps lanes square-ish at 16:9 */
  fieldWidthOfHeight: 0.560,
  fieldRightMarginOfHeight: 0.030,
  /** top of the visible field / bottom of the visible field */
  fieldTop: 0.045,
  fieldBottom: 0.925,
  /** where notes must be hit, as a fraction of height */
  judgeLine: 0.855,
  /** receptor height as a fraction of lane width */
  receptorHeightOfLane: 0.20,
};

/** Geometry for the hand-held layout, by orientation. */
export const HANDHELD_LAYOUT = {
  portrait: {
    fieldTop: 0.155,
    judgeLine: 0.700,
    fieldBottom: 1.0,
    hudHeight: 0.150,
  },
  landscape: {
    fieldTop: 0.115,
    judgeLine: 0.785,
    fieldBottom: 0.985,
    hudHeight: 0.118,
  },
};

/** Pixel budget for the canvas backing store, per device class. */
export const PIXEL_BUDGET = {
  desktop: 3840 * 2160,     // a real 4K target
  handheld: 2.4e6,          // ~1080x2340 at 1.0x, enough for crisp lanes
};

/**
 * Decide whether to use the hand-held layout.
 *
 * A coarse primary pointer means a touch device; a small viewport means the
 * BMS strip would be too cramped even with a mouse.  Either way the full-width
 * field is the better answer.
 */
export function detectHandheld(cssW = 0, cssH = 0) {
  if (typeof window === 'undefined') return false;
  let coarse = false;
  try {
    coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  } catch { /* matchMedia unavailable */ }
  const shortSide = Math.min(cssW || window.innerWidth || 0, cssH || window.innerHeight || 0);
  return coarse || shortSide <= 820;
}

/** True when the browser reports a touch digitiser (used for UI hints). */
export function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  return (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
}

/* ------------------------------------------------------------------------ */
/* user settings                                                             */
/* ------------------------------------------------------------------------ */

export const RENDER_SCALES = [
  { id: 'auto', label: '自动 (跟随窗口)', height: 0 },
  { id: '1080', label: '1920 × 1080', height: 1080 },
  { id: '1440', label: '2560 × 1440', height: 1440 },
  { id: '2160', label: '3840 × 2160 (4K)', height: 2160 },
  { id: '4320', label: '7680 × 4320 (8K)', height: 4320 },
];

/**
 * Player-facing defaults.
 *
 * Everything the settings screen exposes lives here; so does a good deal that
 * it deliberately does not.  The rule for this project is that it stays a small
 * game, so a knob only earns a place on the settings screen if it genuinely
 * depends on the player (their keys, their reading speed, their audio offset,
 * their volume).  Anything that is merely *tunable* is a constant in this file
 * with a value chosen once — exposing it would just be homework for the player.
 */
export const DEFAULTS = {
  /* ---- on the settings screen ------------------------------------------ */
  laneKeys: DEFAULT_KEYS.slice(),
  scrollSpeed: 1.0,
  offsetMs: 0,           // audio calibration, added to the audio clock
  volume: 0.85,
  hitSound: true,
  concertFx: true,

  /* ---- internal tuning (developer screen only) ------------------------- */
  noteTravel: 0.82,      // fall time at speed 1.0, in seconds
  hitFx: 'strong',       // hit-feedback intensity
  backgroundDim: 0.55,
  visualizer: true,
  showKeyCues: true,
  showOffsetGuide: false,  // forced on briefly while the offset slider is moved
  renderScale: 'auto',     // 'auto' already targets 4K on desktop, 2.4 MP on phones
  layout: 'auto',          // decides BMS strip vs full-width lanes
  fullscreenOnStart: false, // opt in from the developer screen; see MIGRATIONS
  noFail: true,            // practice mode: the gauge cannot end a run
  hitGain: 0.7,            // hit-tick level relative to the music volume
  autoPlay: false,         // F2 toggles this at runtime, and it is never saved
};

/** A deep copy of the defaults, so resetting never aliases the arrays. */
export function defaultSettings() {
  return { ...DEFAULTS, laneKeys: DEFAULTS.laneKeys.slice() };
}

/* ------------------------------------------------------------------------ */
/* developer mode                                                            */
/* ------------------------------------------------------------------------ */

const DEV_KEY = 'tongtou.dev.v1';

/**
 * The developer password.
 *
 * Be clear about what this is: the whole game is client-side, so anyone who can
 * open the developer tools can read this constant.  It is a speed bump that
 * keeps the screen off the path of a player who is idly poking at the menus —
 * not a security boundary.
 */
export const DEV_PASSWORD = '114514';

/**
 * Developer mode is a deliberate, sticky opt-in, stored on its own key rather
 * than inside the settings blob: 「恢复默认」 must not silently take the
 * developer screen away, and toggling the developer screen must not rewrite a
 * player's settings.
 *
 * Unlocking happens once (through the password prompt) and is remembered, so a
 * developer is not retyping it every reload.  Nothing — not `?dev=1`, not `F9` —
 * skips the prompt; those only *offer* it.
 */
export function loadDevMode() {
  try {
    return localStorage.getItem(DEV_KEY) === '1';
  } catch {
    return false;
  }
}

/** True when the URL asks for the developer prompt to be offered on boot. */
export function devOfferedByUrl() {
  try {
    const q = new URLSearchParams(location.search).get('dev');
    return q === '1' || q === 'true';
  } catch {
    return false;
  }
}

export function saveDevMode(on) {
  try {
    if (on) localStorage.setItem(DEV_KEY, '1');
    else localStorage.removeItem(DEV_KEY);
  } catch {
    /* private mode */
  }
}

const KEY = 'tongtou.settings.v1';

/**
 * AUTO is a *mode*, not a preference, and it is deliberately not saved.
 *
 * Persisting it meant one stray F2 left the game playing itself for good: every
 * later session came up auto-playing, with nothing on screen to explain why and
 * no visible way back.  A reload now always clears it.
 */
const EPHEMERAL = new Set(['autoPlay']);

/**
 * Default changes that have to reach players who already saved the old value.
 *
 * Flipping a constant in `DEFAULTS` only affects people who have never touched
 * the settings screen: everyone else has the whole blob written out, so the
 * stored value wins and the new default is dead on arrival.  Each entry is a
 * migration applied to a blob stamped with the revision *before* it.
 */
const SETTINGS_REV = 1;
const MIGRATIONS = [
  // rev 0 -> 1: starting a run used to grab fullscreen on any device that
  // reported a touch digitiser, which includes plenty of ordinary laptops.
  // A background game has no business taking over the screen.
  (s) => { s.fullscreenOnStart = false; },
];

export function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    stored = {};
  }
  const merged = defaultSettings();
  for (const k of Object.keys(DEFAULTS)) {
    if (EPHEMERAL.has(k)) continue;
    if (k in stored) merged[k] = stored[k];
  }
  merged.laneKeys = normalizeKeys(stored.laneKeys);

  const rev = Number(stored.rev) || 0;
  for (let i = rev; i < MIGRATIONS.length; i++) MIGRATIONS[i](merged);
  merged.rev = SETTINGS_REV;
  return merged;
}

export function saveSettings(s) {
  try {
    const out = {};
    for (const k of Object.keys(s)) {
      if (!EPHEMERAL.has(k)) out[k] = s[k];
    }
    out.rev = SETTINGS_REV;
    localStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    /* private mode — settings just won't persist */
  }
}

/* ------------------------------------------------------------------------ */
/* assets                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * The game ships with one prepared track.  Any other audio file dropped into
 * ./src is picked up by the manifest in chart.js and charted on the fly.
 */
export const DEFAULT_TRACK = {
  title: '雨爱',
  artist: '杨丞琳',
  audio: 'src/雨爱.mp3',
  chart: 'src/chart/雨爱.json',
};
