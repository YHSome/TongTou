/**
 * Bootstrap and the frame loop.
 *
 *   boot  -> discover the track in ./src, decode audio, load or generate a chart
 *   title -> difficulty select -> play
 *   play  -> audio clock drives engine + renderer; Esc pauses
 *
 * The loop is deliberately thin: the engine owns all gameplay state and the
 * renderer is a pure function of that state plus the current audio time.
 */

import {
  DEFAULT_TRACK, defaultSettings, loadSettings, saveSettings, isTouchDevice, codeLabel,
  loadDevMode, saveDevMode, devOfferedByUrl, DEV_PASSWORD,
} from './config.js';
import { AudioEngine } from './audio.js';
import { Input } from './input.js';
import { Engine } from './engine.js';
import { Renderer } from './render.js';
import { loadChart } from './chart.js';
import {
  $, show, toast, setBootProgress, buildSettings, buildControls, renderDifficulties,
  renderResult, activeScreen, SETTING_SPECS, DEV_SPECS,
  openSponsor, closeSponsor, isSponsorOpen,
} from './ui.js';

/* ------------------------------------------------------------------------ */
/* state                                                                     */
/* ------------------------------------------------------------------------ */

const settings = loadSettings();
const audio = new AudioEngine();
const input = new Input(window);
const renderer = new Renderer($('#view'));

let loaded = null;            // { meta, charts, source }
const tracks = [];            // discoverable tracks (manifest or built-in)
let track = { ...DEFAULT_TRACK };
let difficulty = 'easy';
let devMode = loadDevMode();
let devReturnTo = 'settings';   // where the developer screens fall back to
let timeline = null;
let engine = null;
let mode = 'boot';            // boot | title | select | settings | help | play | pause | result
let rafId = 0;
let lastFrame = 0;
let fpsSmooth = 60;

/* ------------------------------------------------------------------------ */
/* fullscreen + orientation                                              */
/* ------------------------------------------------------------------------ */

/**
 * Go fullscreen when a run starts.
 *
 * Off by default: a background game has no business taking over the screen, and
 * "any device that reports a touch digitiser" includes plenty of ordinary
 * laptops.  It is opt-in from the developer screen, and even then only tries on
 * touch devices.
 *
 * Must be called from inside a user-gesture turn, which is exactly where
 * `startPlay()` runs from.  Orientation is deliberately NOT locked: the
 * hand-held layout is playable in both, and forcing a rotation is intrusive.
 * Failures are ignored — fullscreen is a nicety, not a requirement.
 */
async function goFullscreen() {
  if (!settings.fullscreenOnStart) return;
  if (!isTouchDevice()) return;
  if (document.fullscreenElement) return;
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) return;
  try {
    await req.call(el, { navigationUI: 'hide' });
  } catch { /* iOS Safari refuses on non-video elements — fine */ }
}

/* ------------------------------------------------------------------------ */
/* helpers                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Drive the whole-screen cold -> warm grade from the pyro's intensity.
 *
 * The playfield is drawn on the canvas, so the canvas alone can never tint what
 * is *behind* it.  The `#grade` overlay sits between the stage background and the
 * canvas and covers the whole picture; the canvas adds the matching wash over the
 * lanes on top.
 */
let lastGrade = -1;
function applyFireGrade(w) {
  if (Math.abs(w - lastGrade) < 0.006) return;
  lastGrade = w;
  const grade = document.getElementById('grade');
  if (grade) {
    grade.style.opacity = String(Math.min(1, w * 1.05));
    // the overlay also carries the warm shift the BGA used to get from a filter
    grade.style.filter = `saturate(${(1 + 0.45 * w).toFixed(3)})`
      + ` sepia(${(0.36 * w).toFixed(3)})`
      + ` hue-rotate(${(-12 * w).toFixed(1)}deg)`;
  }
}

function applySettingsToLive() {
  audio.userOffset = (Number(settings.offsetMs) || 0) / 1000;
  audio.setVolume(settings.volume);
  // the hit tick rides the music volume rather than having its own slider
  audio.setHitVolume(settings.hitSound ? settings.volume * (Number(settings.hitGain) || 0) : 0);
  input.setBindings(settings.laneKeys);
  // seed the renderer so the very first frame already uses the right intensity
  renderer.fxLevel = settings.hitFx || 'normal';
  document.body.dataset.bgart = settings.stageArt === false ? '0' : '1';
  lastGrade = -1;                 // force the next frame to repaint the grade
  applyFireGrade(0);
  updateKeyHints();
  persisted();
}

/* ------------------------------------------------------------------------ */
/* developer mode                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Reflect developer mode on the page.
 *
 * The entry button on the settings screen is deliberately *always* there — see
 * the note on `.dev-only` in the stylesheet.  It never unlocks anything by
 * itself, so hiding it bought no safety and cost reachability: a phone has no
 * `F9`, and with the button hidden the developer screen was simply unreachable
 * on touch devices.
 */
function applyDevMode() {
  document.body.dataset.dev = devMode ? '1' : '0';
  const entry = document.querySelector('.dev-only');
  if (entry) {
    entry.hidden = false;
    entry.textContent = devMode ? '开发者设置 · 已解锁' : '开发者设置';
  }
  saveDevMode(devMode);
}

function setDevMode(on, announce = true) {
  const next = !!on;
  if (next === devMode) return devMode;
  devMode = next;
  // AUTO is a developer tool, so it cannot outlive the mode that unlocked it
  if (!devMode && settings.autoPlay) setAutoPlay(false);
  applyDevMode();
  if (!devMode && (activeScreen() === 'dev' || activeScreen() === 'dev-unlock')) {
    leaveDev();
  }
  if (devMode) buildControls($('#dev-grid'), settings, DEV_SPECS, onDevChange);
  if (announce) toast(devMode ? '开发者模式：开（F9 关闭）' : '开发者模式：关');
  return devMode;
}

/**
 * Ask to get in.  There is exactly one way to unlock — the prompt — and `F9`
 * and `?dev=1` only offer it.
 *
 * `devReturnTo` remembers the screen to fall back to.  F9 is available during a
 * run, and a paused run must come back to its pause menu rather than being
 * stranded behind a settings screen.
 */
function requestDev() {
  if (devMode) { show('dev'); setMode('dev'); return false; }
  devReturnTo = (mode === 'play') ? 'pause' : 'settings';
  if (mode === 'play') pausePlay();
  show('dev-unlock');
  setMode('dev-unlock');
  const err = $('#dev-lock-error');
  if (err) err.textContent = '';
  const input = $('#dev-password');
  if (input) {
    input.value = '';
    // wait for the screen transition, or mobile keyboards fight the focus call
    setTimeout(() => input.focus(), 60);
  }
  return true;
}

/** Step back out of the developer screens, wherever they were opened from. */
function leaveDev() {
  const input = $('#dev-password');
  if (input) input.value = '';
  const err = $('#dev-lock-error');
  if (err) err.textContent = '';
  const to = devReturnTo === 'pause' ? 'pause' : 'settings';
  show(to);
  setMode(to);
}

function submitDevPassword() {
  const input = $('#dev-password');
  const err = $('#dev-lock-error');
  const typed = (input && input.value) || '';
  if (typed === DEV_PASSWORD) {
    if (input) input.value = '';
    if (err) err.textContent = '';
    setDevMode(true);
    show('dev');
    setMode('dev');
    return true;
  }
  if (err) {
    err.textContent = typed ? '口令不对' : '请输入口令';
  }
  if (input) {
    input.value = '';
    input.focus();
  }
  const panel = document.querySelector('#dev-unlock .panel');
  if (panel) {
    panel.classList.remove('shake');
    void panel.offsetWidth;          // restart the animation
    panel.classList.add('shake');
  }
  return false;
}

/** Back out of the prompt without unlocking. */
function cancelDevUnlock() {
  leaveDev();
}

/** Reflect the current bindings in the help screen and on the title card. */
function updateKeyHints() {
  const labels = settings.laneKeys.map(codeLabel);
  const kb = document.getElementById('help-keys');
  if (kb) kb.innerHTML = labels.map((l) => `<kbd>${escapeHtml(l)}</kbd>`).join('');
  const foot = document.getElementById('title-keys');
  if (foot) foot.innerHTML = labels.map((l) => `<kbd>${escapeHtml(l)}</kbd>`).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let persistTimer = null;
function persisted() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => saveSettings(settings), 300);
}

function setMode(next) {
  mode = next;
  input.setEnabled(next === 'play');
  // drives CSS: the in-game pause button only exists during a hand-held run
  document.body.dataset.mode = next;
  // ...and the HUD must re-reserve its corner the moment it appears
  syncPauseButton();
  syncAutoChip();
}

/**
 * The pause button is a real DOM element floating over the hand-held HUD bar,
 * so the bar has to know how much room it steals.  It is measured rather than
 * assumed: `display: none` reports an empty rect, which is exactly the
 * "no inset" case.
 */
function syncPauseButton() {
  const btn = $('#pause-btn');
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  renderer.setHudInset(r.width > 0 ? r.right + 8 : 0);
}

/**
 * Track discovery: an optional `src/manifest.json` may list several tracks.
 * Without it the built-in track in config.js is used, and any missing chart is
 * generated by analysing the audio in the browser.
 */
async function discoverTracks() {
  let list = [];
  try {
    const res = await fetch('src/manifest.json', { cache: 'no-cache' });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.tracks)) list = data.tracks;
    }
  } catch { /* no manifest — fine */ }

  const normalised = list
    .filter((t) => t && t.audio)
    .map((t) => ({
      title: t.title || 'untitled',
      artist: t.artist || 'unknown',
      audio: t.audio,
      chart: t.chart || '',
    }));

  if (!normalised.length) normalised.push({ ...DEFAULT_TRACK });
  return normalised;
}

function renderTrackList() {
  const host = $('#tracks');
  if (!host) return;
  if (tracks.length < 2) {
    host.innerHTML = '';
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.innerHTML = '';
  tracks.forEach((t, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = t.title;
    b.setAttribute('aria-pressed', String(t === track));
    if (t === track) b.classList.add('primary');
    b.addEventListener('click', () => selectTrack(t));
    host.appendChild(b);
  });
}

/* ------------------------------------------------------------------------ */
/* boot                                                                      */
/* ------------------------------------------------------------------------ */

async function boot() {
  // the module loaded, so disarm the file:// / watchdog help panel
  if (typeof window.__tongtouBootFail === 'function') window.__tongtouBootFail = null;
  const helpBox = document.getElementById('boot-help');
  if (helpBox) helpBox.hidden = true;

  try {
    setBootProgress(0.05, '初始化音频引擎…');
    await audio.init();
    audio.prepareHitSound();
    applySettingsToLive();

    setBootProgress(0.12, '扫描 ./src 素材…');
    tracks.length = 0;
    tracks.push(...await discoverTracks());
    track = tracks[0];
    renderTrackList();
    if (!track.chart) {
      // no prepared chart: the analyser path will build one from the audio
      toast('未提供谱面，将实时分析音频生成', 4000);
    }

    await loadTrack(track);

    setDifficulty('easy');
    setTimeout(() => { setMode('title'); show('title'); }, 260);
  } catch (err) {
    console.error(err);
    setBootProgress(1, `启动失败: ${err.message}`);
    toast(`启动失败：${err.message}`, 9000);

    // leave the user something actionable instead of a dead progress bar
    const help = document.getElementById('boot-help');
    const note = document.getElementById('boot-note');
    if (help) {
      help.hidden = false;
      const body = help.querySelector('.bh-body');
      if (body) {
        body.innerHTML =
          `无法读取素材：<code>${err.message}</code><br>` +
          '请确认已通过本地服务器打开本目录，并且 <code>src/</code> 下有音频文件。';
      }
    }
    if (note) note.textContent = '启动失败 —— 请查看下方说明';
  }
}

async function loadTrack(t) {
  track = t;

  setBootProgress(0.3, '解码音频…');
  const res = await fetch(encodeURI(track.audio));
  if (!res.ok) throw new Error(`无法读取 ${track.audio} (HTTP ${res.status})`);
  const bytes = await res.arrayBuffer();
  setBootProgress(0.6, '解析音频…');
  await audio.decode(bytes);

  setBootProgress(0.72, '载入谱面…');
  loaded = await loadChart(track, audio.buffer, (msg) => setBootProgress(0.78, msg));

  setBootProgress(1, '就绪');
  applySettingsToLive();

  const note = loaded.source === 'file'
    ? `谱面: ${track.chart}`
    : `谱面: 浏览器实时分析生成 (${loaded.meta.bpm.toFixed(2)} BPM)`;
  $('#asset-note').textContent = `${note} · 渲染 ${renderer.W}×${renderer.H}`;

  // title screen reflects the actual track metadata
  $('#title-name').textContent = loaded.meta.title;
  $('#title-sub').textContent =
    `${loaded.meta.artist} · ${loaded.meta.lanes} KEYS · BPM ${loaded.meta.bpm.toFixed(0)}`;
  document.title = `${loaded.meta.title} · TONGTOU 4K`;
}

async function selectTrack(t) {
  if (t === track) return;
  audio.stop();
  renderTrackList();
  try {
    await loadTrack(t);
    setDifficulty(difficulty);
    toast(`已切换到 ${track.title}`);
  } catch (err) {
    toast(`切换失败：${err.message}`, 6000);
  }
}

function setDifficulty(name) {
  if (!loaded || !loaded.charts[name]) return;
  difficulty = name;
  timeline = loaded.charts[name];
  renderDifficulties($('#diffs'), loaded.charts, difficulty, (picked) => {
    setDifficulty(picked);
  });
  $('#sel-title').textContent = loaded.meta.title;
  $('#sel-sub').textContent =
    `${loaded.meta.artist} · BPM ${loaded.meta.bpm.toFixed(0)} · ${timeline.total} NOTES`;
}

/* ------------------------------------------------------------------------ */
/* playing                                                                   */
/* ------------------------------------------------------------------------ */

async function startPlay(from = 0) {
  if (!timeline) return;

  // must happen inside the gesture turn, before any await
  goFullscreen();

  // The audio clock drives the whole game, and `ctx.currentTime` does not
  // advance while the context is suspended — so a run must not begin until the
  // context is actually running.  A real gesture normally settles this at once.
  const running = await audio.ensureRunning();
  if (!running) {
    toast('无法启动音频：浏览器拒绝了播放权限，请检查自动播放设置', 7000);
    return;
  }

  appliedResize(true);

  engine = new Engine(timeline, settings);
  renderer.effects.length = 0;
  input.reset();

  audio.userOffset = (Number(settings.offsetMs) || 0) / 1000;
  audio.setVolume(settings.volume);

  audio.play(from);

  setMode('play');
  show(null);
  document.body.dataset.playing = '1';
  lastFrame = performance.now();
}

function pausePlay() {
  if (mode !== 'play') return;
  audio.pause();
  setMode('pause');
  show('pause');
}

async function resumePlay() {
  if (mode !== 'pause') return;
  await audio.unpause();
  setMode('play');
  show(null);
  lastFrame = performance.now();
}

function quitToTitle() {
  audio.stop();
  renderer.clear();
  document.body.dataset.playing = '0';
  setMode('title');
  show('title');
}

function finishPlay() {
  if (!engine) return;
  const summary = engine.summary();
  renderResult(summary, timeline, difficulty);
  audio.stop();
  renderer.clear();
  document.body.dataset.playing = '0';
  setMode('result');
  show('result');
}

/* ------------------------------------------------------------------------ */
/* hit sound                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Per-lane transposition so simultaneous notes form a chord instead of an
 * identical click stack.  A minor-ish stack, quiet enough to sit under the
 * music.
 */
const LANE_RATE = [1.0, 1.122, 1.335, 1.498];

/** Judgement -> relative loudness of the tick. */
const HIT_GAIN = { perfect: 1.0, great: 0.85, good: 0.6, bad: 0.35, miss: 0 };

function playHitSounds(events) {
  if (!settings.hitSound) return;
  for (const e of events) {
    if (e.type !== 'judge') continue;
    const gain = HIT_GAIN[e.kind] ?? 0;
    if (gain <= 0) continue;
    audio.playHit(LANE_RATE[e.lane] || 1, gain);
  }
}

/* ------------------------------------------------------------------------ */
/* loop                                                                      */
/* ------------------------------------------------------------------------ */

function frame(now) {
  rafId = requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrame) / 1000) || 0.016;
  lastFrame = now;
  fpsSmooth += (1 / Math.max(0.0001, dt) - fpsSmooth) * 0.05;

  if (mode !== 'play' && mode !== 'pause') return;

  audio._sample();                    // refresh the input-stamping calibration

  const t = audio.now();
  const events = engine.update(t, mode === 'play' ? input : null);
  if (events.length) {
    renderer.ingest(events, t);
    playHitSounds(events);
  }
  renderer.ingest([], t);             // expire finished effects


  renderer.draw({
    time: t,
    timeline,
    engine,
    settings,
    input,
    audio,
    playing: mode === 'play',
    fps: fpsSmooth,
  });

  // the pyro grades the whole picture, including the video behind the canvas
  applyFireGrade(mode === 'play' || mode === 'pause' ? (renderer.fireGlow || 0) : 0);

  if (mode === 'play' && (engine.finished || audio.ended)) finishPlay();
}

/* ------------------------------------------------------------------------ */
/* input routing                                                             */
/* ------------------------------------------------------------------------ */

input.clock = (ts) => (typeof ts === 'number' ? audio.stampFor(ts) : audio.now());

input.interceptor = (e) => {
  // A focused text field owns its own keys — the developer password box would
  // otherwise never see a character, because anything this returns `true` for
  // has its default action cancelled.
  if (e.target instanceof HTMLInputElement && e.target.type === 'password') {
    if (e.code === 'Escape') { cancelDevUnlock(); return true; }
    return false;
  }

  // F2 is a hard global: it is on the reserved list so it can never be a lane.
  // It is also behind the developer gate, because AUTO is a developer tool.
  if (e.code === 'F2') {
    if (!devMode) toast('自动演奏只在开发者模式下可用');
    else toggleSetting('autoPlay');
    return true;
  }

  // F9 is the developer switch, available from any screen.  It is also on the
  // reserved list, so it can never be bound to a lane and shadowed.
  if (e.code === 'F9') {
    if (devMode && activeScreen() === 'dev') leaveDev();
    else requestDev();
    return true;
  }

  // An open dialog owns the keyboard.  Esc is the only way out, so it must not
  // also fall through to the result-screen shortcut and restart the song.
  if (isSponsorOpen()) {
    if (e.code === 'Escape' || e.code === 'Enter' || e.code === 'Space') closeSponsor();
    return true;
  }

  // During a run, a bound lane key always belongs to the lane.  Without this a
  // player who rebinds a lane to Space or R would lose it to the shortcut.
  if (mode === 'play' && input.isBound(e.code)) return false;

  switch (mode) {
    case 'boot':
      return true;

    case 'title':
      if (e.code === 'Enter') { show('select'); setMode('select'); return true; }
      if (e.code === 'KeyS') { show('settings'); setMode('settings'); return true; }
      if (e.code === 'KeyH') { show('help'); setMode('help'); return true; }
      if (e.code === 'KeyR') { location.reload(); return true; }
      return false;

    case 'select':
      if (e.code === 'Escape') { show('title'); setMode('title'); return true; }
      if (e.code === 'Enter') { startPlay(); return true; }
      if (e.code.startsWith('Arrow')) { cycleDifficulty(e.code === 'ArrowRight' || e.code === 'ArrowDown' ? 1 : -1); return true; }
      return false;

    case 'settings':
    case 'help':
      if (e.code === 'Escape') { show('select'); setMode('select'); return true; }
      return true;

    case 'dev':
      if (e.code === 'Escape') { leaveDev(); return true; }
      return true;

    case 'dev-unlock':
      // the field swallows its own characters; here only the exits matter
      if (e.code === 'Escape') { leaveDev(); return true; }
      return true;

    case 'play':
      if (e.code === 'Escape' || e.code === 'Space') { pausePlay(); return true; }
      if (e.code === 'KeyR') { startPlay(); return true; }
      return false;

    case 'pause':
      if (e.code === 'Space' || e.code === 'Enter') { resumePlay(); return true; }
      if (e.code === 'KeyR') { startPlay(); return true; }
      if (e.code === 'KeyQ') { quitToTitle(); return true; }
      if (e.code === 'ArrowLeft') { seekBy(-3); return true; }
      if (e.code === 'ArrowRight') { seekBy(3); return true; }
      if (e.code === 'ArrowUp') { nudgeOffset(+1); return true; }
      if (e.code === 'ArrowDown') { nudgeOffset(-1); return true; }
      return true;

    case 'result':
      if (e.code === 'KeyR' || e.code === 'Enter') { startPlay(); return true; }
      if (e.code === 'KeyQ' || e.code === 'Escape') { quitToTitle(); return true; }
      return true;

    default:
      return false;
  }
};

function cycleDifficulty(delta) {
  const names = Object.keys(loaded.charts);
  const i = names.indexOf(difficulty);
  setDifficulty(names[(i + delta + names.length) % names.length]);
}

/**
 * Pause-time seeking. Because judgement state is per note, seeking mid-run is
 * not meaningful — so the run is restarted from the target position.
 */
async function seekBy(delta) {
  const to = Math.max(0, Math.min(audio.duration - 0.5, audio.now() + delta));
  const at = to;
  await startPlay(at);
  pausePlay();
  toast(`已跳转到 ${at.toFixed(1)}s（判定记录已重置）`);
}

function nudgeOffset(delta) {
  settings.offsetMs = Math.max(-180, Math.min(180, (Number(settings.offsetMs) || 0) + delta));
  audio.userOffset = settings.offsetMs / 1000;
  persisted();
  toast(`判定偏移 ${settings.offsetMs > 0 ? '+' : ''}${settings.offsetMs} ms`);
}

function toggleSetting(key) {
  // AUTO has a gate on it, so it routes through its own setter rather than
  // being flipped here like the rest
  if (key === 'autoPlay') { setAutoPlay(!settings.autoPlay); return; }
  settings[key] = !settings[key];
  persisted();
  toast(`${labelOf(key)}: ${settings[key] ? '开' : '关'}`);
}

/**
 * Turn AUTO on or off.
 *
 * AUTO is a developer tool, not a player feature: it can only be switched on
 * while developer mode is unlocked, and leaving the mode switches it back off.
 * Turning it off is always allowed, from anywhere.
 */
function setAutoPlay(on, announce = true) {
  const want = !!on;
  if (want && !devMode) {
    toast('自动演奏只在开发者模式下可用');
    return false;
  }
  const changed = settings.autoPlay !== want;
  settings.autoPlay = want;
  persisted();
  syncAutoChip();
  if (announce && changed) toast(`${labelOf('autoPlay')}: ${want ? '开' : '关'}`);
  return settings.autoPlay;
}

/**
 * Reflect AUTO on the page.  The chip is CSS-hidden unless this says it is on,
 * so it doubles as the only on-screen evidence that the game is playing itself.
 */
function syncAutoChip() {
  document.body.dataset.auto = settings.autoPlay ? '1' : '0';
}

function labelOf(key) {
  return SETTING_SPECS.find((s) => s.key === key)?.label
    || INTERNAL_LABELS[key]
    || key;
}

/**
 * Human names for the tuning keys that have no settings row — without these the
 * toast leaked the raw key name ("autoPlay: 开"), which tells the player
 * nothing about what they just switched.
 */
const INTERNAL_LABELS = {
  autoPlay: '自动演奏',
  hitFx: '打击反馈',
  noteTravel: '下落时长',
  visualizer: '频谱',
  showKeyCues: '键位提示',
  noFail: '练习模式',
};

/* ------------------------------------------------------------------------ */
/* screen buttons                                                            */
/* ------------------------------------------------------------------------ */

document.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const from = activeScreen();

  switch (act) {
    case 'play': show('select'); setMode('select'); break;
    case 'settings': show('settings'); setMode('settings'); break;
    case 'help': show('help'); setMode('help'); break;
    case 'reload': location.reload(); break;
    case 'back': show(from === 'help' || from === 'settings' ? 'select' : 'title'); setMode(from === 'help' || from === 'settings' ? 'select' : 'title'); break;
    case 'start': startPlay(); break;
    case 'reset':
      Object.assign(settings, defaultSettings());
      buildSettings($('#settings-grid'), settings, onSettingChange);
      // the developer screen reads the same object, so it is stale now
      if (devMode) buildControls($('#dev-grid'), settings, DEV_SPECS, onDevChange);
      onSettingChange('*');
      toast('已恢复默认设置');
      break;
    case 'dev': requestDev(); break;
    case 'dev-cancel': leaveDev(); break;
    case 'dev-back': leaveDev(); break;
    case 'dev-reset':
      Object.assign(settings, defaultSettings());
      buildSettings($('#settings-grid'), settings, onSettingChange);
      buildControls($('#dev-grid'), settings, DEV_SPECS, onDevChange);
      onSettingChange('*');
      toast('已恢复默认设置');
      break;
    case 'dev-off':
      setDevMode(false);
      show('settings');
      setMode('settings');
      break;
    case 'resume': resumePlay(); break;
    case 'restart': startPlay(); break;
    case 'quit': quitToTitle(); break;
    case 'select': show('select'); setMode('select'); break;
    case 'retry': startPlay(); break;
    case 'sponsor': openSponsor(); break;
    default: break;
  }
});

let offsetGuideTimer = null;

function onSettingChange(key, value) {
  applySettingsToLive();
  if (key === 'offsetMs') {
    // The live timing readout is only useful while calibrating, so it appears
    // on its own for a few seconds instead of taking up a settings row.
    renderer.debugTiming = true;
    clearTimeout(offsetGuideTimer);
    offsetGuideTimer = setTimeout(() => { renderer.debugTiming = false; }, 4000);
  }
  if (key === 'renderScale' || key === 'layout' || key === '*') {
    appliedResize(true);
  }
}

/**
 * The developer screen writes the same settings object, so it reuses the same
 * change path — plus the two things the player screen never had to think about:
 * a live renderer rebuild, and AUTO's on-screen indicator.
 */
function onDevChange(key, value) {
  onSettingChange(key, value);
  if (key === 'autoPlay') {
    syncAutoChip();
    toast(value ? '自动演奏: 开' : '自动演奏: 关');
  }
  if (key === 'fullscreenOnStart') toast(value ? '开局将尝试全屏' : '开局不再全屏');
}

/* ------------------------------------------------------------------------ */
/* resize                                                                    */
/* ------------------------------------------------------------------------ */

/** Read the CSS `env(safe-area-inset-*)` values out of the root element. */
function readSafeArea() {
  if (typeof getComputedStyle !== 'function') return { top: 0, right: 0, bottom: 0, left: 0 };
  const cs = getComputedStyle(document.documentElement);
  const px = (name) => {
    const v = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(v) ? v : 0;
  };
  return {
    top: px('--sai-top'),
    right: px('--sai-right'),
    bottom: px('--sai-bottom'),
    left: px('--sai-left'),
  };
}

function appliedResize(force = false) {
  const cssW = window.innerWidth;
  const cssH = window.innerHeight;
  const safe = readSafeArea();
  // the safe area is needed to build the layout, so feed it in first
  renderer.setSafeArea(safe.top, safe.right, safe.bottom, safe.left);
  const changed = renderer.resize(
    settings.renderScale, cssW, cssH, window.devicePixelRatio || 1, settings.layout || 'auto',
  );
  if (changed || force) {
    document.body.dataset.layout = renderer.mode;
    document.body.dataset.portrait = String(!!renderer.portrait);
    // the HUD inset is stored in device pixels, so a new scale invalidates it
    syncPauseButton();
    // repaint the filter from scratch; the pyro grade owns it now
    lastGrade = -1;
    applyFireGrade(renderer.fireGlow || 0);
  }
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => appliedResize(), 120);
});

// rotating a phone changes which hand-held geometry applies
window.addEventListener('orientationchange', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => appliedResize(true), 250);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && mode === 'play') pausePlay();
});

/* ------------------------------------------------------------------------ */
/* go                                                                        */
/* ------------------------------------------------------------------------ */

appliedResize(true);
input.attachSurface($('#view'));
input.laneResolver = (cssX, cssY) => renderer.hitTest(cssX, cssY);
// a phone has no Esc key, so the run needs its own way out
$('#pause-btn').addEventListener('click', (e) => {
  e.preventDefault();
  // drop focus, or a later Space press would hit the button as well as resume
  e.currentTarget.blur();
  pausePlay();
});

// ...and no F2 either, so AUTO needs a tap target of its own
$('#auto-chip').addEventListener('click', (e) => {
  e.preventDefault();
  e.currentTarget.blur();
  setAutoPlay(false, false);
  toast('已关闭自动演奏');
});

// the developer prompt: submit is the only way in
$('#dev-lock-form').addEventListener('submit', (e) => {
  e.preventDefault();
  submitDevPassword();
});
buildSettings($('#settings-grid'), settings, onSettingChange);
applyDevMode();
if (devMode) buildControls($('#dev-grid'), settings, DEV_SPECS, onDevChange);
show('boot');
setMode('boot');
requestAnimationFrame((n) => { lastFrame = n; rafId = requestAnimationFrame(frame); });
boot();

// ?dev=1 offers the prompt; it does not skip it
if (devOfferedByUrl()) {
  setTimeout(() => { if (!devMode) requestDev(); }, 400);
}

// expose a little of the internals for debugging from the console
window.TONGTOU = {
  get state() {
    return {
      mode, difficulty, settings, source: loaded?.source,
      sponsorOpen: isSponsorOpen(), dev: devMode,
    };
  },
  get engine() { return engine; },
  get renderer() { return renderer; },
  get input() { return input; },
  get audio() { return audio; },
  /** the shipped difficulty tiers, in play order */
  difficulties: () => (loaded ? Object.keys(loaded.charts) : []),
  /** test hook: press a lane without a real event */
  hitTest: (x, y) => renderer.hitTest(x, y),
  /** test hook: drive the whole-screen colour grade directly */
  applyGrade: applyFireGrade,
  startPlay, pausePlay, resumePlay, finishPlay,
  /** test hook: jump straight to the result screen */
  openSponsor, closeSponsor,
  /** test hook: flip AUTO without a keyboard (refused unless developer mode is on) */
  setAutoPlay,
  /** test hook: offer the developer prompt, and answer it */
  requestDev, submitDevPassword, leaveDev, DEV_PASSWORD,
  /** test hook: force developer mode (bypassing the prompt) */
  setDevMode,
};
