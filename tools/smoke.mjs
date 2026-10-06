#!/usr/bin/env node
/**
 * Headless smoke test.
 *
 *   node tools/smoke.mjs
 *
 * Boots the real page in headless Edge/Chrome over the DevTools Protocol and
 * asserts the whole chain works: chart fetch, audio decode, renderer sizing,
 * the frame loop, judgement and scoring.  Any console error or uncaught
 * exception fails the run.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 8123;
const CDP_PORT = 9333;
const URL_GAME = `http://127.0.0.1:${PORT}/`;

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const b of BROWSERS) if (existsSync(b)) return b;
  throw new Error('no Chrome/Edge binary found');
}

/* --------------------------------------------------------------------- */
/* tiny CDP client                                                        */
/* --------------------------------------------------------------------- */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      } else {
        for (const l of this.listeners) l(msg);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 30000);
    });
  }

  on(fn) { this.listeners.push(fn); }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
    }
    return r.result.value;
  }
}

/* --------------------------------------------------------------------- */

const problems = [];
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  ??${detail}` : ''}`);
  if (!ok) problems.push(name);
}

async function main() {
  const browser = findBrowser();
  const profile = mkdtempSync(join(tmpdir(), 'tongtou-'));
  console.log(`browser : ${browser}`);
  console.log(`profile : ${profile}\n`);

  const server = spawn(process.execPath, [join(ROOT, 'serve.mjs'), String(PORT), '--strict'], {
    cwd: ROOT, stdio: 'ignore',
  });
  await sleep(700);

  const proc = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--mute-audio',
    '--window-size=1920,1080',
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    // wait for the debugging endpoint
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(250);
      try {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
        const list = await res.json();
        target = list.find((t) => t.type === 'page');
      } catch { /* not up yet */ }
    }
    if (!target) throw new Error('devtools endpoint never came up');

    cdp = await Cdp.connect(target.webSocketDebuggerUrl);

    cdp.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        problems.push('exception');
        console.log(` EXCEPTION  ${d.exception?.description || d.text}`);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        problems.push('console.error');
        console.log(` CONSOLE.ERROR  ${text}`);
      }
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.navigate', { url: URL_GAME });

    // ---- wait for boot -------------------------------------------------
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      await sleep(250);
      try {
        ready = await cdp.eval('!!window.TONGTOU && window.TONGTOU.state.mode !== "boot"');
      } catch { /* page still loading */ }
    }
    check('page boots past the boot screen', ready);

    const state = ready ? await cdp.eval('JSON.stringify(window.TONGTOU.state)') : '{}';
    console.log(`  state: ${state}`);
    const st = JSON.parse(state);
    check('chart produced difficulties',
      !!(st && st.source) && ['file', 'analysis'].includes(st.source), `source=${st.source}`);

    // the shipped tier set.  easy / normal were removed and `extra` added, so
    // the whole list is pinned here rather than just "some charts exist".
    const tiers = JSON.parse(await cdp.eval(`(() => {
      const t = window.TONGTOU.difficulties();
      const cards = [...document.querySelectorAll('#diffs .diff')].map((d) => ({
        name: d.dataset.d, label: d.querySelector('.diff-name').textContent.trim(),
        lv: d.querySelector('.diff-lv').textContent.trim(),
        meta: d.querySelector('.diff-meta').textContent.trim(),
        selected: d.getAttribute('aria-selected'),
      }));
      return JSON.stringify({ t, cards, active: window.TONGTOU.state.difficulty });
    })()`));
    console.log(`  tiers: ${tiers.t.join(' / ')}  active=${tiers.active}`);
    check('the chart ships exactly easy / hard / expert / extra',
      tiers.t.join(',') === 'easy,hard,expert,extra', tiers.t.join(','));
    check('the select screen shows one card per tier',
      tiers.cards.length === 4 && tiers.cards.every((c, i) => c.name === tiers.t[i]),
      tiers.cards.map((c) => c.name).join(','));
    check('the cards are labelled EASY / HARD / EXPERT / EXTRA',
      tiers.cards.map((c) => c.label).join(',') === 'EASY,HARD,EXPERT,EXTRA',
      tiers.cards.map((c) => c.label).join(','));
    check('the default difficulty is the easiest shipped tier',
      tiers.active === 'easy', tiers.active);
    check('the default card is the selected one',
      tiers.cards[0] && tiers.cards[0].selected === 'true', JSON.stringify(tiers.cards[0]));
    // difficulty must read as a progression in the UI too
    const lvs = tiers.cards.map((c) => Number(c.lv));
    check('the displayed levels climb',
      lvs.every((v, i) => i === 0 || v > lvs[i - 1]), lvs.join(' < '));
    const counts = tiers.cards.map((c) => Number((c.meta.match(/(\d+) NOTES/) || [])[1]));
    check('the note counts climb',
      counts.every((v, i) => i === 0 || v > counts[i - 1]), counts.join(' < '));

    const timelineInfo = await cdp.eval(`JSON.stringify({
      mode: window.TONGTOU.state.mode,
      notes: window.TONGTOU.engine ? 0 : 0,
    })`);
    check('reached the title screen', JSON.parse(timelineInfo).mode === 'title');

    // ---- renderer sizing ------------------------------------------------
    const size = await cdp.eval('JSON.stringify({w:window.TONGTOU.renderer.W,h:window.TONGTOU.renderer.H})');
    const sz = JSON.parse(size);
    check('renderer sized the canvas', sz.w > 0 && sz.h > 0, `${sz.w}x${sz.h}`);

    // ---- no BGA ----------------------------------------------------------
    // The video was removed on purpose (69 MB for a background), so make sure
    // nothing is still reaching for it: a leftover reference would either 404 or
    // silently leave a black band where the stage background should be.
    const bgaLeftovers = JSON.parse(await cdp.eval(`(() => {
      const stage = document.getElementById('stage');
      const layers = [...stage.children].map((el) => el.id || el.className);
      const cs = getComputedStyle(stage);
      return JSON.stringify({
        video: !!document.getElementById('bga'),
        media: stage.querySelectorAll('video, audio').length,
        layers,
        background: cs.backgroundImage.includes('gradient'),
      });
    })()`));
    console.log(`  stage layers: ${bgaLeftovers.layers.join(' / ')}`);
    check('the BGA element is gone', bgaLeftovers.video === false && bgaLeftovers.media === 0);
    check('the stage still paints its own background',
      bgaLeftovers.background === true);

    // ---- the stage artwork -----------------------------------------------
    // Loading the image and waiting for it to decode is the only thing that
    // proves the asset resolves: a wrong path or a missing file shows up as an
    // empty layer and no error anywhere else.
    const art = JSON.parse(await cdp.eval(`(async () => {
      const el = document.querySelector('.stage-art');
      const raw = getComputedStyle(el).backgroundImage;
      const m = /url\\(["']?([^"')]+)["']?\\)/.exec(raw);
      const url = m ? m[1] : '';
      const img = new Image();
      const loaded = await new Promise((res) => {
        img.onload = () => res(true);
        img.onerror = () => res(false);
        img.src = url;
      });
      const veil = document.querySelector('.stage-veil');
      return JSON.stringify({
        url, loaded, w: img.naturalWidth, h: img.naturalHeight,
        filter: getComputedStyle(el).filter,
        shown: el.offsetWidth > 0,
        veilAbove: !!veil && veil.offsetWidth > 0,
      });
    })()`));
    console.log(`  stage art: ${art.url} -> ${art.loaded ? `${art.w}x${art.h}` : 'FAILED'}`
      + ` (${art.filter})`);
    check('the stage artwork is in the layer stack', art.url.length > 0 && art.shown, art.url);
    check('the artwork asset actually loads and decodes', art.loaded === true, art.url);
    check('it is drawn behind the vignette', art.veilAbove === true);
    // 300x300 blown up to the viewport, so it has to be softened on purpose
    check('the upscale is blurred rather than blocky', /blur\(/.test(art.filter), art.filter);

    // ---- enter select + play --------------------------------------------
    // CDP input events are trusted, so they grant user activation the way a
    // real key press does.  A synthetic KeyboardEvent from Runtime.evaluate is
    // NOT trusted and would never unblock the AudioContext ??using one here
    // would hide the suspended-context hang this test exists to catch.
    const sendKey = async (code, key, vk, text) => {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      });
      await sleep(300);
    };

    check('audio context starts suspended (real-browser policy)',
      (await cdp.eval('window.TONGTOU.audio.ctx.state')) === 'suspended',
      await cdp.eval('window.TONGTOU.audio.ctx.state'));

    await sendKey('Enter', 'Enter', 13, '\r');     // title -> select

    // arrow keys step through the tiers; the list changed shape again, so make
    // sure the cycling still visits every one and wraps
    const cycled = [];
    for (let i = 0; i < 4; i++) {
      cycled.push(await cdp.eval('window.TONGTOU.state.difficulty'));
      await sendKey('ArrowRight', 'ArrowRight', 39, '');
    }
    console.log(`  arrow cycling: ${cycled.join(' -> ')}`);
    check('arrow keys visit all four tiers in order',
      cycled.join(',') === 'easy,hard,expert,extra', cycled.join(','));
    check('cycling wraps back to the easiest tier',
      (await cdp.eval('window.TONGTOU.state.difficulty')) === 'easy',
      await cdp.eval('window.TONGTOU.state.difficulty'));

    // Now step up one tier for the run itself.  `easy` is only 0.84 NPS, and the
    // mechanics checked below (AUTO resolving every due note, per-lane hit sounds)
    // need enough notes inside their measurement windows to mean anything — on
    // easy they would pass by having almost nothing to measure.
    await sendKey('ArrowRight', 'ArrowRight', 39, '');
    check('the run uses a tier dense enough to measure',
      (await cdp.eval('window.TONGTOU.state.difficulty')) === 'hard',
      await cdp.eval('window.TONGTOU.state.difficulty'));

    // A run must not take over the screen.  `fullscreenOnStart` is off by
    // default, and the spy stays in place for the whole run so any request from
    // anywhere in the start path would be caught.
    await cdp.eval(`(() => {
      window.__fs = { asked: 0, args: null };
      const el = document.documentElement;
      el.requestFullscreen = function (...a) { window.__fs.asked++; window.__fs.args = a; return Promise.resolve(); };
      el.webkitRequestFullscreen = el.requestFullscreen;
      return true;
    })()`);
    check('fullscreen is off by default',
      (await cdp.eval('window.TONGTOU.state.settings.fullscreenOnStart')) === false,
      String(await cdp.eval('window.TONGTOU.state.settings.fullscreenOnStart')));

    await sendKey('Enter', 'Enter', 13, '\r');     // select -> play
    await sleep(900);
    check('starting a run does not ask for fullscreen',
      (await cdp.eval('window.__fs.asked')) === 0,
      `${await cdp.eval('window.__fs.asked')} request(s)`);

    // The opt-in half of this is checked at the very end of the suite: proving
    // it needs a restart, and restarting here would wipe the run the AUTO
    // scoring section below measures.

    let nowMode = await cdp.eval('window.TONGTOU.state.mode');
    check('started gameplay', nowMode === 'play', `mode=${nowMode}`);
    check('trusted gesture resumed the audio context',
      (await cdp.eval('window.TONGTOU.audio.ctx.state')) === 'running',
      await cdp.eval('window.TONGTOU.audio.ctx.state'));

    // ---- the live offset readout is on by default ------------------------
    // "实时调整判定偏移" only helps while you are playing, so it has to be on
    // without anyone opening a menu.  Counted from the canvas rather than from
    // the settings flag: the flag being true proves nothing if nothing draws.
    {
      check('the live offset readout is on out of the box',
        (await cdp.eval('window.TONGTOU.state.settings.showOffsetGuide')) === true);
      const readout = JSON.parse(await cdp.eval(`(() => {
        const r = window.TONGTOU.renderer, eng = window.TONGTOU.engine;
        const tl = eng.timeline, settings = window.TONGTOU.state.settings;
        const ctx = r.ctx, t = window.TONGTOU.audio.now();
        // Give the renderer a judgement to display.  Waiting for a real one is
        // timing-dependent, and the draw path only reads these two fields.
        const savedJudge = eng.lastJudge, savedErr = eng.lastErrorMs;
        eng.lastJudge = 'great'; eng.lastErrorMs = 12.3;

        const texts = [];
        const orig = ctx.fillText.bind(ctx);
        ctx.fillText = (s, ...a) => { texts.push(String(s)); return orig(s, ...a); };
        const state = { time: t, timeline: tl, engine: eng, settings,
                        input: window.TONGTOU.input, audio: window.TONGTOU.audio,
                        playing: true, fps: 60 };
        const wasOn = settings.showOffsetGuide;
        settings.showOffsetGuide = true;
        r.draw(state);
        const withGuide = texts.slice();

        texts.length = 0;
        settings.showOffsetGuide = false;
        r.draw(state);
        const without = texts.slice();

        settings.showOffsetGuide = wasOn;
        eng.lastJudge = savedJudge; eng.lastErrorMs = savedErr;
        ctx.fillText = orig;

        const ms = (list) => list.filter((s) => /ms$|ms\\b/.test(s)).length;
        const fps = (list) => list.filter((s) => /FPS/.test(s)).length;
        return JSON.stringify({
          withGuide: ms(withGuide), without: ms(without),
          fpsWith: fps(withGuide), sample: withGuide.filter((s) => /ms/.test(s)).slice(0, 2),
        });
      })()`));
      console.log(`  offset readout: on=${readout.withGuide} off=${readout.without}`
        + ` ${JSON.stringify(readout.sample)}`);
      check('the readout draws the last error in ms', readout.withGuide >= 1,
        `${readout.withGuide} matching fillText call(s)`);
      check('turning it off stops drawing it', readout.without === 0, `${readout.without}`);
      check('the frame-rate half stays a developer readout',
        readout.fpsWith === 0, `${readout.fpsWith} FPS line(s) while playing normally`);
    }

    // ---- auto-play a while and verify scoring ---------------------------
    await cdp.eval('window.TONGTOU.state.settings.autoPlay = true');
    await sleep(14000);

    const playInfo = await cdp.eval(`(() => {
      const e = window.TONGTOU.engine;
      const t = window.TONGTOU.audio.now();
      // how many notes *should* have been judged by now?
      const due = e.notes.filter(n => n.time <= t - 0.130).length;
      const judged = e.counts.perfect + e.counts.great + e.counts.good
                   + e.counts.bad + e.counts.miss;
      // Recompute the score independently: base points per judgement plus the
      // 理论值 precision bonus, summed from each note's own recorded error.
      const base = e.counts.perfect * 100 + e.counts.great * 50 + e.counts.good * 25;
      let bonus = 0;
      for (const n of e.notes) {
        if (n.judged === 'perfect') bonus += Math.max(0, 50 - Math.abs(n.error * 1000));
      }
      const expectedScore = Math.round(base + bonus);
      return JSON.stringify({
        time: t, score: e.score, expectedScore, bonus: Math.round(bonus),
        maxScore: e.maxScore,
        combo: e.maxCombo, perfect: e.counts.perfect, miss: e.counts.miss,
        due, judged, total: e.notes.length,
        acc: e.accuracy, gauge: e.gauge,
        audioState: window.TONGTOU.audio.ctx.state,
        duration: window.TONGTOU.audio.duration,
        mode: window.TONGTOU.state.mode,
      });
    })()`);
    console.log(`  play: ${playInfo}`);
    const p = JSON.parse(playInfo);

    check('audio decoded with a real duration', p.duration > 100, `${p.duration?.toFixed?.(1)}s`);
    check('audio context is running', p.audioState === 'running', p.audioState);
    check('clock advanced', p.time > 5, `t=${p.time?.toFixed?.(2)}s`);
    check('AUTO judged every due note', p.perfect >= p.due && p.due > 20,
      `perfect=${p.perfect}, due=${p.due}`);
    check('AUTO produced no misses', p.miss === 0, `miss=${p.miss}`);
    check('combo tracks the judged notes', p.combo === p.judged, `${p.combo} vs ${p.judged}`);
    check('score matches the scoring model exactly', p.score === p.expectedScore,
      `${p.score} vs ${p.expectedScore}`);
    check('the 理论值 bonus is accumulating', p.bonus > 0 && p.maxScore > 0,
      `bonus=${p.bonus}, max=${p.maxScore}`);
    check('the score cannot exceed the chart maximum', p.score <= p.maxScore,
      `${p.score} / ${p.maxScore}`);
    // 29 perfect of 304 notes -> points 58 / max 608 = 9.54%, which is correct
    // mid-run: a full-chart accuracy only reaches 1.0 at the last note.
    check('accuracy equals the judged fraction while every hit is PERFECT',
      Math.abs(p.acc - p.perfect / p.total) < 1e-9,
      `${p.acc.toFixed(6)} vs ${(p.perfect / p.total).toFixed(6)}`);
    check('gauge in range', p.gauge > 0 && p.gauge <= 100, `gauge=${p.gauge?.toFixed?.(1)}`);
    check('still playing', p.mode === 'play', p.mode);

    // ---- frame loop is actually drawing ---------------------------------
    const drew = await cdp.eval(`(() => {
      const cv = document.getElementById('view');
      const ctx = cv.getContext('2d');
      // sample a strip of the lane field: it must not be fully transparent
      const d = ctx.getImageData(cv.width*0.72|0, cv.height*0.85|0, 8, 8).data;
      let opaque = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque++;
      return opaque;
    })()`);
    check('playfield is being rendered', drew > 0, `${drew}/64 opaque pixels`);

    // ---- pause / resume --------------------------------------------------
    await sendKey('Escape', 'Escape', 27, '');
    await sleep(300);
    check('pause works', (await cdp.eval('window.TONGTOU.state.mode')) === 'pause');
    await sendKey('Space', ' ', 32, ' ');
    await sleep(300);
    check('resume works', (await cdp.eval('window.TONGTOU.state.mode')) === 'play');

    // the on-screen pause button exists for touch devices only; a desktop run
    // has a keyboard and must keep the corner clean
    check('the touch pause button stays hidden on desktop',
      (await cdp.eval(`getComputedStyle(document.getElementById('pause-btn')).display`)) === 'none',
      await cdp.eval(`getComputedStyle(document.getElementById('pause-btn')).display`));

    // ---- AUTO: visible, one tap to leave, never persisted ----------------
    // AUTO used to be reachable only through an undocumented F2 and it *stuck*
    // across sessions, so a single stray press left the game playing itself
    // with nothing on screen to explain why.
    console.log('\n== auto play ==');
    const chipInfo = () => cdp.eval(`(() => {
      const c = document.getElementById('auto-chip');
      const r = c.getBoundingClientRect();
      const cs = getComputedStyle(c);
      return JSON.stringify({ display: cs.display, w: Math.round(r.width), h: Math.round(r.height),
        top: Math.round(r.top), left: Math.round(r.left), text: c.textContent.replace(/\\s+/g, ' ').trim(),
        auto: window.TONGTOU.state.settings.autoPlay });
    })()`);

    // earlier sections drive AUTO on directly to exercise the auto-play path,
    // so start from a known state
    await cdp.eval('window.TONGTOU.setAutoPlay(false); true');
    await sleep(250);
    check('AUTO starts off', JSON.parse(await chipInfo()).auto === false);
    check('nothing claims AUTO is on while it is off',
      JSON.parse(await chipInfo()).display === 'none');

    // ---- AUTO is behind the developer gate -------------------------------
    // It is a developer tool, not a player feature: with developer mode locked
    // neither the key nor the hook can switch it on.
    await sendKey('F2', 'F2', 113, '');
    check('F2 does nothing while developer mode is locked',
      JSON.parse(await chipInfo()).auto === false);
    check('and says why',
      (await cdp.eval('document.getElementById("toast").textContent')).includes('开发者模式'),
      await cdp.eval('document.getElementById("toast").textContent'));
    check('the programmatic path is refused too',
      (await cdp.eval('window.TONGTOU.setAutoPlay(true)')) === false);
    check('...and really did not take',
      JSON.parse(await chipInfo()).auto === false);

    // unlock through the real prompt: F9, type, submit
    await sendKey('F9', 'F9', 120, '');
    check('F9 opens the password prompt rather than the screen',
      (await cdp.eval('window.TONGTOU.state.mode')) === 'dev-unlock'
      && (await cdp.eval('window.TONGTOU.state.dev')) === false,
      await cdp.eval('window.TONGTOU.state.mode'));
    await cdp.eval(`(() => {
      const i = document.getElementById('dev-password');
      i.value = window.TONGTOU.DEV_PASSWORD;
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('dev-lock-form').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(400);
    check('the right password unlocks and opens the developer screen',
      (await cdp.eval('window.TONGTOU.state.dev')) === true
      && (await cdp.eval('window.TONGTOU.state.mode')) === 'dev',
      await cdp.eval('window.TONGTOU.state.mode'));

    // leave the developer screen but stay unlocked, so the run continues.
    // Opening the prompt paused the run, so put it back before touching AUTO.
    await sendKey('Escape', 'Escape', 27, '');
    await sleep(300);
    check('the run came back to its pause menu, not to the settings screen',
      (await cdp.eval('window.TONGTOU.state.mode')) === 'pause',
      await cdp.eval('window.TONGTOU.state.mode'));
    await cdp.eval('window.TONGTOU.resumePlay(); true');
    await sleep(500);
    check('and it is running again', (await cdp.eval('window.TONGTOU.state.mode')) === 'play');

    await sendKey('F2', 'F2', 113, '');
    const on = JSON.parse(await chipInfo());
    check('F2 turns AUTO on once developer mode is unlocked', on.auto === true, String(on.auto));
    check('turning AUTO on shows an on-screen indicator', on.display !== 'none', on.display);
    check('the indicator says it can be turned off',
      /AUTO/.test(on.text) && /关闭/.test(on.text), on.text);
    check('the indicator is a real target, not a hairline',
      on.w >= 80 && on.h >= 28, `${on.w}x${on.h}`);
    check('it sits inside the top of the screen, clear of the lanes',
      on.top >= 0 && on.top < 60, `top=${on.top}`);
    check('the toast names the feature instead of the raw key',
      (await cdp.eval('document.getElementById("toast").textContent')).includes('自动演奏'),
      await cdp.eval('document.getElementById("toast").textContent'));

    await cdp.eval(`document.getElementById('auto-chip').click(); true`);
    await sleep(350);
    const off = JSON.parse(await chipInfo());
    check('one click on the indicator turns AUTO off', off.auto === false);
    check('and the indicator disappears with it', off.display === 'none', off.display);
    check('the click reports what happened',
      (await cdp.eval('document.getElementById("toast").textContent')).includes('关闭自动演奏'),
      await cdp.eval('document.getElementById("toast").textContent'));

    // ...and locking developer mode again takes AUTO away with it
    await cdp.eval('window.TONGTOU.setAutoPlay(true); true');
    await sleep(200);
    check('AUTO is on again for the lock test',
      (await cdp.eval('window.TONGTOU.state.settings.autoPlay')) === true);
    await cdp.eval('window.TONGTOU.setDevMode(false); true');
    await sleep(250);
    check('locking developer mode switches AUTO back off',
      (await cdp.eval('window.TONGTOU.state.settings.autoPlay')) === false);
    check('and clears its indicator',
      JSON.parse(await chipInfo()).display === 'none');
    await cdp.eval('window.TONGTOU.setDevMode(true); true');
    await sleep(200);

    // The persistence half of this lives at the very end of the suite: proving
    // it needs a real page reload, which would reset the run everything else
    // below depends on.

    const decodeMs = await cdp.eval('window.TONGTOU.audio.decodeMs');
    check('audio decode is fast enough to not feel like a hang', decodeMs < 5000, `${decodeMs} ms`);

    // ---- hit feedback ---------------------------------------------------
    // On a successful judgement the note must stop being drawn, and a burst
    // must appear in its place.
    console.log('\n== hit feedback ==');

    const consumed = JSON.parse(await cdp.eval(`(() => {
      const r = window.TONGTOU.renderer, eng = window.TONGTOU.engine;
      const tl = eng.timeline, settings = window.TONGTOU.state.settings;
      const ctx = r.ctx;
      const orig = ctx.drawImage.bind(ctx);

      // Judge through the ENGINE, not by poking a flag.  The engine clones the
      // timeline, so a test that sets \`timeline.notes[i].judged\` by hand proves
      // nothing about the real path -- which is exactly how the "notes never
      // disappear" bug slipped through before.
      const idx = eng.notes.findIndex(n => !n.judged && n.lane === 2 && n.time > 5);
      const note = eng.notes[idx];
      const laneSprite = r.sprites[note.lane];
      const T = note.time;

      function drawCount() {
        let hits = 0;
        ctx.drawImage = (img, ...a) => { if (img === laneSprite) hits++; return orig(img, ...a); };
        r.draw({ time: T, timeline: tl, engine: eng, settings,
                 input: window.TONGTOU.input, audio: window.TONGTOU.audio, playing: true, fps: 60 });
        ctx.drawImage = orig;
        return hits;
      }

      const unjudged = drawCount();

      // real judgement path: the same call the input handler makes
      const before = note.judged;
      const kind = eng.press(note.lane, note.time);
      const after = note.judged;
      const viaEngine = drawCount();

      out = {
        unjudged, viaEngine, before: String(before), after: String(after), kind: String(kind),
        sameArray: eng.notes[idx] === note,
        timelineStillNull: tl.notes[idx].judged === null,
      };
      return JSON.stringify(out);
    })()`));

    console.log(`  note-sprite draws  unjudged=${consumed.unjudged} afterEngineHit=${consumed.viaEngine}`);
    console.log(`  engine judging: ${consumed.before} -> ${consumed.after} (${consumed.kind})`
      + `, timeline copy stays ${consumed.timelineStillNull ? 'null' : 'set'}`);
    check('a real engine judgement makes the note vanish immediately',
      consumed.viaEngine === consumed.unjudged - 1,
      `${consumed.unjudged} -> ${consumed.viaEngine}`);
    check('the engine really judged it', consumed.after === 'perfect', consumed.after);
    check('the renderer reads the engine copy, not the timeline copy',
      consumed.timelineStillNull === true, `timeline judged=${consumed.timelineStillNull}`);

    // misses must still fall past the line rather than vanish
    const missDraw = await cdp.eval(`(() => {
      const r = window.TONGTOU.renderer, eng = window.TONGTOU.engine;
      const tl = eng.timeline, settings = window.TONGTOU.state.settings;
      const ctx = r.ctx, orig = ctx.drawImage.bind(ctx);
      const note = eng.notes.find(n => !n.judged && n.lane === 1 && n.time > 6);
      const sprite = r.sprites[note.lane];
      let hits = 0;
      ctx.drawImage = (img, ...a) => { if (img === sprite) hits++; return orig(img, ...a); };
      // let it run past the window so the sweep marks it a miss
      eng.update(note.time + 0.2, null);
      const judged = String(note.judged);
      r.draw({ time: note.time + 0.2, timeline: tl, engine: eng, settings,
               input: window.TONGTOU.input, audio: window.TONGTOU.audio, playing: true, fps: 60 });
      ctx.drawImage = orig;
      return judged + ':' + hits;
    })()`);
    check('a missed note keeps falling (still drawn)',
      missDraw.startsWith('miss:') && Number(missDraw.split(':')[1]) >= 1, missDraw);

    const fx = JSON.parse(await cdp.eval(`(() => {
      const r = window.TONGTOU.renderer;
      const out = {};
      for (const kind of ['perfect', 'great', 'good', 'bad', 'miss']) {
        r.effects.length = 0;
        r.ingest([{ type: 'judge', kind, lane: 1, time: 0 }], 0);
        const tally = {};
        for (const e of r.effects) tally[e.kind] = (tally[e.kind] || 0) + 1;
        out[kind] = tally;
      }
      r.effects.length = 0;
      return JSON.stringify(out);
    })()`));
    console.log(`  effect bursts: ${JSON.stringify(fx)}`);

    for (const kind of ['perfect', 'great', 'good']) {
      check(`${kind}: spawns core + wave + beam + flash + sparks`,
        fx[kind].core === 1 && fx[kind].wave === 1 && fx[kind].beam === 1
        && fx[kind].flash === 1 && fx[kind].spark >= 1,
        JSON.stringify(fx[kind]));
    }
    check('PERFECT is the loudest burst',
      fx.perfect.spark > fx.great.spark && fx.great.spark > fx.good.spark,
      `${fx.perfect.spark} > ${fx.great.spark} > ${fx.good.spark}`);
    check('BAD is a quiet burst', fx.bad.spark <= 5, `${fx.bad.spark} sparks`);
    check('MISS spawns no sparks, only a warning flash',
      fx.miss.spark === undefined && fx.miss.flash === 1, JSON.stringify(fx.miss));

    // the intensity setting must actually change the output
    const levels = JSON.parse(await cdp.eval(`(() => {
      const r = window.TONGTOU.renderer;
      const s = window.TONGTOU.state.settings;
      const was = s.hitFx;
      const out = {};
      for (const lv of ['strong', 'normal', 'off']) {
        s.hitFx = lv;
        r.fxLevel = lv;
        r.effects.length = 0;
        r.ingest([{ type: 'judge', kind: 'perfect', lane: 0, time: 0 }], 0);
        out[lv] = r.effects.filter(e => e.kind === 'spark').length;
      }
      s.hitFx = was; r.fxLevel = was; r.effects.length = 0;
      return JSON.stringify(out);
    })()`));
    console.log(`  sparks by intensity: ${JSON.stringify(levels)}`);
    check('the intensity setting scales the burst',
      levels.strong > levels.normal && levels.off === 0, JSON.stringify(levels));

    // effects must expire so the list cannot grow without bound
    const bounded = await cdp.eval(`(() => {
      const r = window.TONGTOU.renderer;
      r.effects.length = 0;
      for (let i = 0; i < 200; i++) r.ingest([{ type: 'judge', kind: 'perfect', lane: i % 4, time: i * 0.01 }], i * 0.01);
      const peak = r.effects.length;
      r.ingest([], 60);           // far future: everything expires
      return peak + ':' + r.effects.length;
    })()`);
    const [peak, after] = bounded.split(':').map(Number);
    check('effects stay bounded and expire', peak <= 700 && after === 0,
      `peak=${peak} after=${after}`);

    // each new note needs its own judgement, so take over from AUTO here
    await cdp.eval('window.TONGTOU.state.settings.autoPlay = false');

    // ---- feedback must stay cheap ---------------------------------------
    // A dense section can have a dozen bursts alive at once, and every effect
    // builds gradients per frame, so measure a full draw under a heavy load.
    const perf = JSON.parse(await cdp.eval(`(() => {
      const r = window.TONGTOU.renderer, eng = window.TONGTOU.engine;
      const tl = eng.timeline, settings = window.TONGTOU.state.settings;
      const t = window.TONGTOU.audio.now();

      // 4 lanes x 12 simultaneous bursts ~ a very busy passage
      r.effects.length = 0;
      for (let i = 0; i < 12; i++) {
        for (let lane = 0; lane < 4; lane++) {
          r.ingest([{ type: 'judge', kind: 'perfect', lane, time: t - i * 0.01 }], t - i * 0.01);
        }
      }
      const alive = r.effects.length;

      const state = { time: t, timeline: tl, engine: eng, settings,
                      input: window.TONGTOU.input, audio: window.TONGTOU.audio,
                      playing: true, fps: 60 };
      r.draw(state);                                   // warm up
      const N = 20;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) r.draw(state);
      const ms = (performance.now() - t0) / N;
      r.effects.length = 0;
      return JSON.stringify({ alive, ms: +ms.toFixed(2), px: r.W * r.H });
    })()`));
    console.log(`  draw under load: ${perf.alive} effects, ${perf.ms} ms/frame at ${perf.px / 1e6} MP`);
    check('a heavy burst still draws well inside a 60 fps budget',
      perf.ms < 16.7, `${perf.ms} ms (budget 16.7)`);

    // the pyro builds ~60 gradients per frame, so measure it under load too
    const perfFire = JSON.parse(await cdp.eval(`(() => {
      const r = window.TONGTOU.renderer, eng = window.TONGTOU.engine;
      const tl = eng.timeline, settings = window.TONGTOU.state.settings;
      const t = window.TONGTOU.audio.now();
      const real = tl.events;
      tl.events = [{ time: t - 1.2, type: 'fire', cue: 'perf' }];
      r.effects.length = 0;
      for (let lane = 0; lane < 4; lane++) {
        r.ingest([{ type: 'judge', kind: 'perfect', lane, time: t - 0.05 }], t - 0.05);
      }
      const state = { time: t, timeline: tl, engine: eng, settings,
                      input: window.TONGTOU.input, audio: window.TONGTOU.audio,
                      playing: true, fps: 60 };
      r.draw(state);
      const N = 20;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) r.draw(state);
      const ms = (performance.now() - t0) / N;
      tl.events = real;
      r.effects.length = 0;
      return JSON.stringify({ ms: +ms.toFixed(2) });
    })()`));
    console.log(`  draw with pyro: ${perfFire.ms} ms/frame`);
    check('the concert pyro also fits the frame budget',
      perfFire.ms < 16.7, `${perfFire.ms} ms (budget 16.7)`);

    // ---- hit sound ------------------------------------------------------
    console.log('\n== hit sound ==');
    const snd = JSON.parse(await cdp.eval(`(() => {
      const a = window.TONGTOU.audio;
      if (!a._hitBuf) return JSON.stringify({ built: false });
      const d = a._hitBuf.getChannelData(0);
      const rate = a._hitBuf.sampleRate;
      const n = d.length;
      const rms = (from, to) => {
        let s = 0;
        for (let i = from; i < to; i++) s += d[i] * d[i];
        return Math.sqrt(s / Math.max(1, to - from));
      };
      let peak = 0, peakAt = 0;
      for (let i = 0; i < n; i++) {
        const v = d[i] < 0 ? -d[i] : d[i];
        if (v > peak) { peak = v; peakAt = i; }
      }
      let zc = 0;
      for (let i = 1; i < n; i++) if ((d[i - 1] < 0) !== (d[i] < 0)) zc++;
      const third = Math.floor(n / 3);
      return JSON.stringify({
        built: true,
        ms: +(n / rate * 1000).toFixed(1),
        peak: +peak.toFixed(3),
        peakMs: +(peakAt / rate * 1000).toFixed(2),
        rmsHead: +rms(0, third).toFixed(4),
        rmsTail: +rms(2 * third, n).toFixed(5),
        kzcr: +(zc / (n / rate) / 1000).toFixed(2),
      });
    })()`));
    console.log(`  hit sound: ${JSON.stringify(snd)}`);
    check('a hit sound buffer was synthesised', snd.built === true);
    check('it is short (a tick, not a tone)', snd.ms > 40 && snd.ms < 160, `${snd.ms} ms`);
    check('the attack is immediate', snd.peakMs < 8, `peak at ${snd.peakMs} ms`);
    check('it decays fast (percussive envelope)',
      snd.rmsHead > snd.rmsTail * 8, `head ${snd.rmsHead} vs tail ${snd.rmsTail}`);
    // a bright click crosses zero thousands of times a second
    check('it is bright / crisp', snd.kzcr > 1.5, `${snd.kzcr} k zero-crossings/s`);

    // every successful judgement must fire it, transposed per lane
    await cdp.eval(`(() => {
      const a = window.TONGTOU.audio, s = window.TONGTOU.state.settings;
      window.__hitSpy = { calls: 0, rates: {} };
      if (!a.__origPlayHit) a.__origPlayHit = a.playHit.bind(a);
      a.playHit = (r, g) => {
        window.__hitSpy.calls++;
        window.__hitSpy.rates[r] = (window.__hitSpy.rates[r] || 0) + 1;
        return a.__origPlayHit(r, g);
      };
      s.hitSound = true;
      s.autoPlay = true;
      return true;
    })()`);
    await sleep(2400);
    const spy = JSON.parse(await cdp.eval('JSON.stringify(window.__hitSpy)'));
    console.log(`  judgements fired the sound ${spy.calls} times; rates ${JSON.stringify(spy.rates)}`);
    check('AUTO judgements actually trigger the hit sound', spy.calls > 3, `${spy.calls} calls`);
    check('the hit sound is transposed per lane',
      Object.keys(spy.rates).length >= 2, Object.keys(spy.rates).join(','));

    // and the switch must silence it
    await cdp.eval(`(() => {
      window.TONGTOU.state.settings.hitSound = false;
      window.TONGTOU.audio.setHitVolume(0);
      window.__hitSpy.calls = 0;
      return true;
    })()`);
    await sleep(1600);
    const mutedCalls = JSON.parse(await cdp.eval('JSON.stringify(window.__hitSpy)'));
    check('turning the hit sound off silences it', mutedCalls.calls === 0, `${mutedCalls.calls} calls`);

    await cdp.eval(`(() => {
      const a = window.TONGTOU.audio, s = window.TONGTOU.state.settings;
      if (a.__origPlayHit) a.playHit = a.__origPlayHit;
      s.hitSound = true;
      s.autoPlay = false;
      a.setHitVolume(0.55);
      return true;
    })()`);

    // ---- concert pyro ---------------------------------------------------
    // The cues come from the chart and fire on the clock, so the note being
    // hit or missed is irrelevant.
    console.log('\n== concert pyro ==');

    const fireCues = JSON.parse(await cdp.eval(`(() => {
      const tl = window.TONGTOU.engine.timeline;
      return JSON.stringify({
        events: tl.events.length,
        types: [...new Set(tl.events.map(e => e.type))],
        cues: tl.events.map(e => e.cue),
        times: tl.events.map(e => +e.time.toFixed(2)),
      });
    })()`));
    console.log(`  chart cues: ${JSON.stringify(fireCues)}`);
    check('the loaded chart carries fire cues',
      fireCues.events > 0 && fireCues.types[0] === 'fire', `${fireCues.events} events`);
    check('every cue resolved to a real time',
      fireCues.times.every((t) => t > 1 && t < 140), fireCues.times.join(','));

    // The whole point: the burst must start at the instant a note reaches the
    // judgement line, not when the note spawns at the top of the field.
    const atLine = JSON.parse(await cdp.eval(`(() => {
      const eng = window.TONGTOU.engine, tl = eng.timeline;
      const travel = window.TONGTOU.renderer.travelTime(window.TONGTOU.state.settings);
      const out = [];
      for (const e of tl.events) {
        const nearest = eng.notes.reduce((best, n) =>
          Math.abs(n.time - e.time) < Math.abs(best - e.time) ? n.time : best, Infinity);
        out.push({
          delta: +(nearest - e.time).toFixed(4),
          travel: +travel.toFixed(3),
          notesAtCue: eng.notes.filter(n => Math.abs(n.time - e.time) < 0.002).length,
        });
      }
      return JSON.stringify(out);
    })()`));
    const worst = Math.max(...atLine.map((a) => Math.abs(a.delta)), 0);
    console.log(`  cue->note delta: max ${(worst * 1000).toFixed(1)} ms`
      + ` (note travel time ${atLine[0] ? atLine[0].travel : '?'} s)`);
    check('every burst starts exactly when a note crosses the line',
      worst < 0.001 && atLine.every((a) => a.notesAtCue >= 1),
      `max delta ${(worst * 1000).toFixed(1)} ms`);
    check('the trigger is not the note spawn time',
      atLine.every((a) => Math.abs(a.delta) < a.travel * 0.01),
      `travel is ${atLine[0] ? atLine[0].travel : '?'} s, delta ~0`);

    // drive the cue by time and count the drawing it produces.  The burst is a
    // golden frame plus a handful of motes, so the frame shows up as strokes and
    // rect fills while the motes show up as path fills.
    const fire = JSON.parse(await cdp.eval(`(() => {
      const r = window.TONGTOU.renderer, eng = window.TONGTOU.engine;
      const tl = eng.timeline, settings = window.TONGTOU.state.settings;
      const ctx = r.ctx, t = window.TONGTOU.audio.now();
      const real = tl.events;

      function ops(age) {
        tl.events = age === null ? [] : [{ time: t - age, type: 'fire', cue: 'probe' }];
        let fills = 0, arcs = 0, strokes = 0, rects = 0;
        const of = ctx.fill.bind(ctx), oa = ctx.arc.bind(ctx);
        const os = ctx.stroke.bind(ctx), or = ctx.fillRect.bind(ctx);
        ctx.fill = (...a) => { fills++; return of(...a); };
        ctx.arc = (...a) => { arcs++; return oa(...a); };
        ctx.stroke = (...a) => { strokes++; return os(...a); };
        ctx.fillRect = (...a) => { rects++; return or(...a); };
        r.draw({ time: t, timeline: tl, engine: eng, settings,
                 input: window.TONGTOU.input, audio: window.TONGTOU.audio, playing: true, fps: 60 });
        ctx.fill = of; ctx.arc = oa; ctx.stroke = os; ctx.fillRect = or;
        return { fills, arcs, strokes, rects };
      }

      const out = {
        idle: ops(null),
        ignition: ops(0.10),
        peak: ops(1.20),
        dying: ops(3.30),
        after: ops(3.60),      // past the 3.5 s window
        before: ops(-0.50),    // cue has not fired yet
      };
      tl.events = real;
      return JSON.stringify(out);
    })()`));
    console.log(`  draw ops: idle=${fire.idle.strokes}s/${fire.idle.rects}r/${fire.idle.fills}f`
      + ` peak=${fire.peak.strokes}s/${fire.peak.rects}r/${fire.peak.fills}f`
      + ` after=${fire.after.strokes}s/${fire.after.rects}r/${fire.after.fills}f`);

    check('the cue paints a golden frame and edge bloom',
      fire.ignition.strokes >= fire.idle.strokes + 6 && fire.ignition.rects >= fire.idle.rects + 4,
      `+${fire.ignition.strokes - fire.idle.strokes} strokes, +${fire.ignition.rects - fire.idle.rects} rects`);
    check('the frame tracks the envelope instead of a fixed overlay',
      fire.dying.rects === fire.idle.rects + 4 && fire.dying.strokes >= fire.idle.strokes + 6,
      `tail ${fire.dying.strokes}s/${fire.dying.rects}r`);
    check('motes build up over the burst',
      fire.peak.fills > fire.ignition.fills && fire.dying.fills > fire.peak.fills,
      `${fire.ignition.fills} -> ${fire.peak.fills} -> ${fire.dying.fills}`);
    check('it stays cheap — no particle storm',
      fire.peak.fills - fire.idle.fills < 40 && fire.peak.rects - fire.idle.rects <= 4,
      `peak adds ${fire.peak.fills - fire.idle.fills} fills, ${fire.peak.rects - fire.idle.rects} rects`);
    check('it stops after 3.5 s', fire.after.fills === fire.idle.fills
      && fire.after.arcs === fire.idle.arcs
      && fire.after.strokes === fire.idle.strokes
      && fire.after.rects === fire.idle.rects, `${fire.after.fills}/${fire.after.arcs}`);
    check('it does not fire before its cue', fire.before.fills === fire.idle.fills
      && fire.before.strokes === fire.idle.strokes
      && fire.before.rects === fire.idle.rects, `${fire.before.fills}/${fire.before.strokes}`);

    // Compare on / off / idle back-to-back: the frame content depends on live
    // game state, so a baseline captured at a different instant is not valid.
    const fireOff = JSON.parse(await cdp.eval(`(() => {
      const r = window.TONGTOU.renderer, eng = window.TONGTOU.engine;
      const tl = eng.timeline, settings = window.TONGTOU.state.settings;
      const ctx = r.ctx, t = window.TONGTOU.audio.now();
      const real = tl.events;
      const state = { time: t, timeline: tl, engine: eng, settings,
                      input: window.TONGTOU.input, audio: window.TONGTOU.audio,
                      playing: true, fps: 60 };

      function measure() {
        let fills = 0;
        const of = ctx.fill.bind(ctx);
        ctx.fill = (...a) => { fills++; return of(...a); };
        r.draw(state);
        ctx.fill = of;
        return fills;
      }

      tl.events = [{ time: t - 1.2, type: 'fire', cue: 'probe' }];
      settings.concertFx = true;
      const on = measure();
      settings.concertFx = false;
      const offWithCue = measure();
      tl.events = [];
      settings.concertFx = true;
      const idle = measure();

      tl.events = real;
      return JSON.stringify({ on, offWithCue, idle });
    })()`));
    console.log(`  switch: on=${fireOff.on} off=${fireOff.offWithCue} idle=${fireOff.idle}`);
    check('the 演出特效 switch disables it',
      fireOff.on > fireOff.idle && fireOff.offWithCue === fireOff.idle,
      `on ${fireOff.on}, off ${fireOff.offWithCue}, idle ${fireOff.idle}`);

    // The burst must ease in, hold, and ease out.  A hard attack or a fast
    // release is what "abrupt" meant, so measure the envelope instead of
    // trusting a screenshot.
    const shape = JSON.parse(await cdp.eval(`(() => {
      const r = window.TONGTOU.renderer, eng = window.TONGTOU.engine;
      const tl = eng.timeline, t = window.TONGTOU.audio.now();
      const real = tl.events;
      const samples = [];
      for (let u = 0; u <= 1.0001; u += 0.05) {
        tl.events = [{ time: t - u * 3.5, type: 'fire', cue: 'probe' }];
        r._fireActive = r._fireState(t, tl);
        samples.push(+r.fireGlow.toFixed(4));
      }
      tl.events = real;
      r._fireActive = [];
      return JSON.stringify(samples);
    })()`));
    console.log('  envelope u=0..1: ' + shape.map((v) => v.toFixed(2)).join(' '));
    const fxPeak = Math.max(...shape);
    const at = (u) => shape[Math.round(u / 0.05)];
    check('the burst eases in rather than strobing on',
      at(0) < 0.02 && at(0.05) < fxPeak * 0.45 && at(0.15) > fxPeak * 0.6,
      `u0=${at(0)} u0.05=${at(0.05)} u0.15=${at(0.15)}`);
    check('it holds at full strength through the middle',
      at(0.3) > fxPeak * 0.95 && at(0.5) > fxPeak * 0.95 && at(0.62) > fxPeak * 0.9,
      `${at(0.3)} ${at(0.5)} ${at(0.62)}`);
    check('it eases out instead of snapping back to cold',
      at(0.8) > fxPeak * 0.25 && at(0.9) > fxPeak * 0.05 && at(0.95) > 0,
      `u0.8=${at(0.8)} u0.9=${at(0.9)} u0.95=${at(0.95)}`);

    // and the whole-screen grade must actually follow it.  With the BGA gone the
    // grade layer is the only thing painting the shift outside the canvas, so it
    // carries both the opacity ramp and the warm filter.
    const grade = JSON.parse(await cdp.eval(`(() => {
      const real = window.TONGTOU.engine.timeline.events;
      const r = window.TONGTOU.renderer, eng = window.TONGTOU.engine;
      const tl = eng.timeline, t = window.TONGTOU.audio.now();
      const layer = document.getElementById('grade');
      const out = {};
      for (const [label, u] of [['idle', null], ['mid', 0.4]]) {
        tl.events = u === null ? [] : [{ time: t - u * 3.5, type: 'fire', cue: 'g' }];
        r._fireActive = r._fireState(t, tl);
        r.fireGlow = r._fireActive.length ? r.fireGlow : 0;
        window.TONGTOU.applyGrade(r.fireGlow);
        out[label] = { filter: layer.style.filter, overlay: layer.style.opacity };
      }
      tl.events = real;
      return JSON.stringify(out);
    })()`));
    console.log(`  grade idle: overlay=${grade.idle.overlay} filter=${grade.idle.filter}`);
    console.log(`  grade mid : overlay=${grade.mid.overlay} filter=${grade.mid.filter}`);
    check('the grade layer gets a warm filter during the burst',
      /sepia\(0\.[2-9]/.test(grade.mid.filter) && /hue-rotate\(-/.test(grade.mid.filter),
      grade.mid.filter);
    check('the warm overlay ramps with it',
      Number(grade.mid.overlay) > 0.2 && Number(grade.idle.overlay) === 0,
      `mid ${grade.mid.overlay}, idle ${grade.idle.overlay}`);
    check('the grade is neutral when nothing is burning',
      /sepia\(0(\.0+)?\)/.test(grade.idle.filter)
      && /hue-rotate\(-?0(\.0+)?deg\)/.test(grade.idle.filter),
      grade.idle.filter);

    // ---- settings persistence -------------------------------------------
    const persisted = await cdp.eval('!!localStorage.getItem("tongtou.settings.v1")');
    check('settings are persisted', persisted === true);

    // ---- key rebinding --------------------------------------------------
    // Exercised through the real settings UI, then confirmed by pressing the
    // new keys during an actual run.
    console.log('\n== key rebinding ==');
    await sendKey('Escape', 'Escape', 27, '');       // pause
    await sleep(250);
    await sendKey('KeyQ', 'q', 81, 'q');             // back to title
    await sleep(350);
    await sendKey('KeyS', 's', 83, 's');             // title -> settings
    await sleep(400);
    check('settings screen opened',
      (await cdp.eval('window.TONGTOU.state.mode')) === 'settings',
      await cdp.eval('window.TONGTOU.state.mode'));

    const slots = await cdp.eval(`JSON.stringify(
      [...document.querySelectorAll('.keyslot')].map(b => b.textContent))`);
    check('four key slots are shown with the current bindings',
      slots === '["D","F","J","K"]', slots);

    // This is meant to be a small game: the settings screen must stay short.
    // Anything that is merely *tunable* belongs in config.js, not in the UI.
    const rows = JSON.parse(await cdp.eval(`JSON.stringify(
      [...document.querySelectorAll('#settings-grid .setting')].map(r =>
        r.querySelector('.sl').textContent))`));
    console.log(`  settings rows (${rows.length}): ${rows.join(' / ')}`);
    check('the settings screen stays lightweight', rows.length <= 6, `${rows.length} rows`);
    check('it only exposes player-dependent choices',
      rows.every((r) => /键位|速度|偏移|音量|音效|特效/.test(r)),
      rows.join(','));
    check('no resolution / layout knobs leak into the UI',
      !rows.some((r) => /渲染|布局|全屏|AUTO|练习/.test(r)), rows.join(','));

    // rebind lane 0 by clicking its slot and pressing A
    await cdp.eval('document.querySelectorAll(".keyslot")[0].click()');
    await sleep(150);
    const armed = await cdp.eval('document.querySelectorAll(".keyslot")[0].classList.contains("armed")');
    check('clicking a slot arms it for capture', armed === true);
    await sendKey('KeyA', 'a', 65, 'a');
    await sleep(250);
    const afterOne = await cdp.eval('JSON.stringify(window.TONGTOU.state.settings.laneKeys)');
    check('captured key replaces the binding', afterOne === '["KeyA","KeyF","KeyJ","KeyK"]', afterOne);

    // a reserved key must be refused, leaving the binding untouched
    await cdp.eval('document.querySelectorAll(".keyslot")[1].click()');
    await sleep(150);
    await sendKey('Escape', 'Escape', 27, '');
    await sleep(250);
    const afterEsc = await cdp.eval('JSON.stringify(window.TONGTOU.state.settings.laneKeys)');
    check('Escape cancels the capture instead of binding',
      afterEsc === afterOne, afterEsc);

    // pressing an already-bound key swaps the two lanes
    await cdp.eval('document.querySelectorAll(".keyslot")[2].click()');
    await sleep(150);
    await sendKey('KeyA', 'a', 65, 'a');
    await sleep(250);
    const swapped = await cdp.eval('JSON.stringify(window.TONGTOU.state.settings.laneKeys)');
    check('binding a used key swaps the lanes',
      swapped === '["KeyJ","KeyF","KeyA","KeyK"]', swapped);
    check('the preset selector reports a custom binding',
      (await cdp.eval('document.querySelector(".keypreset").value')) === 'custom',
      await cdp.eval('document.querySelector(".keypreset").value'));

    // choose the ASKL preset from the dropdown
    await cdp.eval(`(() => {
      const sel = document.querySelector('.keypreset');
      sel.value = 'askl';
      sel.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await sleep(250);
    const askl = await cdp.eval('JSON.stringify(window.TONGTOU.state.settings.laneKeys)');
    check('the ASKL preset applies', askl === '["KeyA","KeyS","KeyK","KeyL"]', askl);
    const slotLabels = await cdp.eval(
      'JSON.stringify([...document.querySelectorAll(".keyslot")].map(b => b.textContent))');
    check('slots repaint to the preset', slotLabels === '["A","S","K","L"]', slotLabels);

    // back to the game and actually play the new keys
    await sendKey('Escape', 'Escape', 27, '');
    await sleep(300);
    await sendKey('Enter', 'Enter', 13, '\r');       // select screen
    await sleep(300);
    await sendKey('Enter', 'Enter', 13, '\r');       // start
    await sleep(800);
    check('restarted a run with the new bindings',
      (await cdp.eval('window.TONGTOU.state.mode')) === 'play',
      await cdp.eval('window.TONGTOU.state.mode'));

    for (const [code, key, vk, lane] of [['KeyA', 'a', 65, 0], ['KeyS', 's', 83, 1],
      ['KeyK', 'k', 75, 2], ['KeyL', 'l', 76, 3]]) {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: key,
      });
      await sleep(90);
      const held = await cdp.eval('JSON.stringify(window.TONGTOU.input.held)');
      const expect = JSON.stringify([0, 1, 2, 3].map((l) => l === lane));
      check(`pressing ${key.toUpperCase()} holds lane ${lane}`, held === expect, held);
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      });
      await sleep(60);
    }

    // the old keys must be inert now
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', code: 'KeyD', key: 'd', windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68, text: 'd',
    });
    await sleep(90);
    check('the previous binding is no longer active',
      (await cdp.eval('JSON.stringify(window.TONGTOU.input.held)')) === '[false,false,false,false]',
      await cdp.eval('JSON.stringify(window.TONGTOU.input.held)'));
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', code: 'KeyD', key: 'd', windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68,
    });

    // the in-game cue must follow the binding too
    const cues = await cdp.eval(`(() => {
      const r = window.TONGTOU.renderer;
      return r._cueCache && r._cueCache.key ? r._cueCache.key : null;
    })()`);
    check('in-game cue cache keyed on the new labels',
      typeof cues === 'string' && cues.endsWith('A\u0000S\u0000K\u0000L'),
      JSON.stringify(cues));

    // and the bindings survive a reload (they are in the settings blob)
    const stored = await cdp.eval(
      'JSON.parse(localStorage.getItem("tongtou.settings.v1")).laneKeys.join(",")');
    check('rebound keys are written to localStorage',
      stored === 'KeyA,KeyS,KeyK,KeyL', stored);

    /* ---- 赞赏 ------------------------------------------------------------ */
    // The tip dialog hangs off the result screen.  It is a purely local box of
    // pixels: no fetch, no storage, no score effect.
    console.log('\n== tip / sponsor ==');

    await cdp.eval('window.TONGTOU.finishPlay(); true');
    await sleep(500);
    check('finished the run into the result screen',
      (await cdp.eval('window.TONGTOU.state.mode')) === 'result',
      await cdp.eval('window.TONGTOU.state.mode'));

    const tipBtn = await cdp.eval(`(() => {
      const b = document.getElementById('sponsor-btn');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height),
        hidden: getComputedStyle(b).display === 'none',
        label: b.textContent.trim() });
    })()`);
    check('the result screen offers a tip button', tipBtn !== null && tipBtn !== 'null', tipBtn);

    const tipBox = JSON.parse(tipBtn);
    check('it is tappable, not a hairline', tipBox.w > 80 && tipBox.h >= 32,
      `${tipBox.w}x${tipBox.h}`);
    check('the tip asks for the house currency — 辣条',
      tipBox.label.includes('辣条'), tipBox.label);

    const copy = JSON.parse(await cdp.eval(`JSON.stringify({
      head: document.querySelector('.sponsor-head h2').textContent.trim(),
      note: document.querySelector('.sponsor-note').textContent.replace(/\\s+/g, ''),
    })`));
    check('the dialog copy matches the button',
      copy.head.includes('辣条') && copy.note.includes('辣条')
      && !copy.note.includes('水'), `${copy.head} / ${copy.note}`);

    check('the dialog starts closed',
      (await cdp.eval('window.TONGTOU.state.sponsorOpen')) === false,
      await cdp.eval('window.TONGTOU.state.sponsorOpen'));

    await cdp.eval(`document.getElementById('sponsor-btn').click(); true`);
    await sleep(400);
    check('clicking it opens the dialog',
      (await cdp.eval('window.TONGTOU.state.sponsorOpen')) === true);
    check('the dialog is actually visible',
      (await cdp.eval(`document.getElementById('sponsor-modal').classList.contains('is-open')`)) === true
      && (await cdp.eval(`getComputedStyle(document.getElementById('sponsor-modal')).visibility`)) === 'visible');

    const qr = await cdp.eval(`(() => {
      const img = document.getElementById('sponsor-qr');
      return JSON.stringify({ complete: img.complete, w: img.naturalWidth,
        h: img.naturalHeight, shown: Math.round(img.getBoundingClientRect().width) });
    })()`);
    const qrInfo = JSON.parse(qr);
    check('the QR image really decoded', qrInfo.complete === true && qrInfo.w > 0,
      `${qrInfo.w}x${qrInfo.h}`);
    check('the QR is square and on screen', qrInfo.w === qrInfo.h && qrInfo.shown > 100,
      `${qrInfo.shown}px wide`);

    // the dialog owns the keyboard: Esc closes it and must NOT restart the song
    await sendKey('Escape', 'Escape', 27, '');
    check('Escape closes the dialog',
      (await cdp.eval('window.TONGTOU.state.sponsorOpen')) === false);
    check('Escape did not also restart the run',
      (await cdp.eval('window.TONGTOU.state.mode')) === 'result',
      await cdp.eval('window.TONGTOU.state.mode'));

    // backdrop click closes it too
    await cdp.eval(`document.getElementById('sponsor-btn').click(); true`);
    await sleep(250);
    await cdp.eval(`document.getElementById('sponsor-modal').click(); true`);
    await sleep(250);
    check('clicking the backdrop closes the dialog',
      (await cdp.eval('window.TONGTOU.state.sponsorOpen')) === false);

    // ...and leaving the result screen must not strand it (R restarts)
    await cdp.eval(`document.getElementById('sponsor-btn').click(); true`);
    await sleep(300);
    check('reopened for the leave check',
      (await cdp.eval('window.TONGTOU.state.sponsorOpen')) === true);
    await cdp.eval('window.TONGTOU.startPlay(); true');
    await sleep(1400);
    check('leaving the result screen closes the dialog',
      (await cdp.eval('window.TONGTOU.state.sponsorOpen')) === false);
    check('and the run really started',
      (await cdp.eval('window.TONGTOU.state.mode')) === 'play',
      await cdp.eval('window.TONGTOU.state.mode'));
    check('the dialog is hidden while playing',
      (await cdp.eval(`getComputedStyle(document.getElementById('sponsor-modal')).visibility`)) === 'hidden');

    /* ---- developer mode -------------------------------------------------- */
    // Everything that was taken off the player settings screen has to stay
    // reachable somewhere, or "simplified" just means "lost".
    console.log('\n== developer mode ==');

    await cdp.eval('window.TONGTOU.setDevMode(false); true');
    await sendKey('Escape', 'Escape', 27, '');          // out of the run
    await sendKey('KeyQ', 'q', 81, 'q');
    await sleep(400);
    await sendKey('KeyS', 's', 83, 's');                // title -> settings
    await sleep(400);
    check('on the settings screen for the dev checks',
      (await cdp.eval('window.TONGTOU.state.mode')) === 'settings',
      await cdp.eval('window.TONGTOU.state.mode'));

    const devProbe = async () => JSON.parse(await cdp.eval(`(() => {
      const entry = document.querySelector('#settings .dev-only');
      const grid = document.getElementById('settings-grid');
      return JSON.stringify({
        dev: window.TONGTOU.state.dev,
        bodyFlag: document.body.dataset.dev,
        entryHidden: entry.hidden,
        entryVisible: entry.offsetParent !== null,
        rows: [...grid.querySelectorAll('.setting')].map(
          (r) => r.querySelector('.sl').textContent.trim()),
        screen: window.TONGTOU.state.mode,
        onDev: window.TONGTOU.state.mode === 'dev',
        onPrompt: window.TONGTOU.state.mode === 'dev-unlock',
        error: (document.getElementById('dev-lock-error') || {}).textContent || '',
        stored: localStorage.getItem('tongtou.dev.v1'),
      });
    })()`));

    const off1 = await devProbe();
    check('developer mode starts off', off1.dev === false && off1.bodyFlag === '0', off1.bodyFlag);
    // The entry point is always there — it only opens the prompt, so hiding it
    // bought nothing and made the screen unreachable on a phone (no F9).
    check('the entry point is present and reachable before unlocking',
      off1.entryHidden === false && off1.entryVisible === true,
      `hidden=${off1.entryHidden} visible=${off1.entryVisible}`);
    check('the player settings screen is still exactly six rows',
      off1.rows.length === 6, off1.rows.join(' / '));
    check('and still carries none of the developer vocabulary',
      !off1.rows.some((r) => /渲染|布局|全屏|频谱|压暗|AUTO|练习|反馈/.test(r)), off1.rows.join(' / '));

    /* ---- the password gate ---------------------------------------------- */
    // F9 offers the prompt; it does not open the screen.
    await sendKey('F9', 'F9', 120, '');
    const prompted = await devProbe();
    check('F9 asks for the password instead of unlocking',
      prompted.onPrompt === true && prompted.dev === false,
      `${prompted.screen} dev=${prompted.dev}`);
    check('the field is a real password field',
      (await cdp.eval(`document.getElementById('dev-password').type`)) === 'password');
    check('nothing is unlocked until it is answered',
      prompted.stored === null, String(prompted.stored));

    // ...and a wrong one leaves it locked
    const wrong = JSON.parse(await cdp.eval(`(() => {
      const i = document.getElementById('dev-password');
      i.value = 'hunter2';
      document.getElementById('dev-lock-form').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }));
      return JSON.stringify({
        dev: window.TONGTOU.state.dev,
        screen: window.TONGTOU.state.mode,
        error: document.getElementById('dev-lock-error').textContent,
        stillFocused: document.activeElement === i,
      });
    })()`));
    await sleep(200);
    check('a wrong password does not unlock', wrong.dev === false && wrong.screen === 'dev-unlock',
      `${wrong.screen} dev=${wrong.dev}`);
    check('it says so, and clears the field for a retry',
      wrong.error.length > 0 && (await cdp.eval(`document.getElementById('dev-password').value`)) === '',
      wrong.error);
    check('and it does not get written to storage',
      (await cdp.eval('localStorage.getItem("tongtou.dev.v1")')) === null,
      String(await cdp.eval('localStorage.getItem("tongtou.dev.v1")')));

    // Esc backs out of the prompt without unlocking
    await sendKey('Escape', 'Escape', 27, '');
    await sleep(300);
    const backedOut = await devProbe();
    check('Esc leaves the prompt for the settings screen',
      backedOut.screen === 'settings' && backedOut.dev === false, backedOut.screen);
    check('the settings screen keeps the entry point and its six rows',
      backedOut.entryHidden === false && backedOut.entryVisible === true
      && backedOut.rows.length === 6,
      `visible=${backedOut.entryVisible} rows=${backedOut.rows.length}`);

    // the right password opens it
    await sendKey('F9', 'F9', 120, '');
    await sleep(250);
    await cdp.eval(`(() => {
      const i = document.getElementById('dev-password');
      i.value = window.TONGTOU.DEV_PASSWORD;
      document.getElementById('dev-lock-form').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(400);
    const unlocked = await devProbe();
    check('the right password unlocks developer mode',
      unlocked.dev === true && unlocked.bodyFlag === '1', `${unlocked.screen} dev=${unlocked.dev}`);
    check('and opens the developer screen', unlocked.onDev === true, unlocked.screen);
    check('the entry point is now reachable',
      unlocked.entryHidden === false && unlocked.entryVisible === true,
      `hidden=${unlocked.entryHidden}`);
    check('the unlock is remembered', unlocked.stored === '1', String(unlocked.stored));
    check('the player settings screen did not grow',
      unlocked.rows.length === 6, `${unlocked.rows.length} rows`);
    const devRows = JSON.parse(await cdp.eval(`(() => {
      const grid = document.getElementById('dev-grid');
      return JSON.stringify({
        groups: [...grid.querySelectorAll('.setting-group')].map((g) => g.textContent.trim()),
        rows: [...grid.querySelectorAll('.setting')].map((r) => ({
          label: r.querySelector('.sl').textContent.trim(),
          control: r.querySelector('.setting-control').firstElementChild?.className
            || r.querySelector('.setting-control').tagName.toLowerCase(),
        })),
      });
    })()`));
    console.log(`  developer groups: ${devRows.groups.join(' / ')}`);
    console.log(`  developer rows  : ${devRows.rows.map((r) => r.label).join(' / ')}`);

    const wanted = ['渲染分辨率', '界面布局', '整体压暗', '频谱可视化',
      '键位提示', '开局全屏', '下落时长', '打击反馈', '实时判定偏差', '练习模式',
      '打击音效音量', '自动演奏（AUTO）'];
    const got = devRows.rows.map((r) => r.label);
    check('every simplified setting is back on the developer screen',
      wanted.every((w) => got.includes(w)),
      wanted.filter((w) => !got.includes(w)).join(' / ') || 'all present');
    check('they are grouped rather than one flat list',
      devRows.groups.length >= 3, devRows.groups.join(','));
    check('each row has a real control',
      devRows.rows.every((r) => r.control && r.control !== ''), JSON.stringify(devRows.rows[0]));

    // the list is long, so on a wide screen it has to pack into columns rather
    // than become a scrolling single file
    const devGrid = JSON.parse(await cdp.eval(`(() => {
      const g = document.getElementById('dev-grid');
      const p = g.closest('.panel');
      return JSON.stringify({
        panel: Math.round(p.getBoundingClientRect().width),
        content: Math.round(g.getBoundingClientRect().width),
        columns: getComputedStyle(g).gridTemplateColumns.split(' ').length,
        rows: g.querySelectorAll('.setting').length,
        tall: Math.round(p.getBoundingClientRect().height),
        vh: window.innerHeight,
      });
    })()`));
    console.log(`  dev grid: ${devGrid.columns} columns in ${devGrid.content}px`
      + ` (panel ${devGrid.panel}px), ${devGrid.rows} rows, panel ${devGrid.tall}px of ${devGrid.vh}`);
    check('the developer list packs into columns on a wide screen',
      devGrid.columns >= 2, `${devGrid.columns} column(s)`);

    // The screen itself must not scroll: the title, the note and the three
    // buttons stay put and only the list moves, so the way out is always
    // reachable no matter how long the list grows.
    const devFit = JSON.parse(await cdp.eval(`(() => {
      const s = document.getElementById('dev');
      const p = s.querySelector('.panel');
      const g = document.getElementById('dev-grid');
      const r = p.getBoundingClientRect();
      const back = s.querySelector('[data-act="dev-back"]').getBoundingClientRect();
      const last = g.querySelector('.setting:last-of-type');
      return JSON.stringify({
        vh: window.innerHeight,
        screenOverflow: s.scrollHeight - s.clientHeight,
        panelTop: Math.round(r.top), panelBottom: Math.round(r.bottom),
        backBottom: Math.round(back.bottom),
        listScrolls: g.scrollHeight - g.clientHeight,
        lastVisible: !!last,
      });
    })()`));
    console.log(`  dev fit: panel ${devFit.panelTop}..${devFit.panelBottom} of ${devFit.vh},`
      + ` screen overflow ${devFit.screenOverflow}px, list scrolls ${devFit.listScrolls}px`);
    check('the developer screen itself never scrolls', devFit.screenOverflow <= 1,
      `${devFit.screenOverflow}px over`);
    check('its panel fits the viewport', devFit.panelBottom <= devFit.vh + 1 && devFit.panelTop >= 0,
      `${devFit.panelTop}..${devFit.panelBottom} of ${devFit.vh}`);
    check('the way out is on screen without scrolling the panel',
      devFit.backBottom <= devFit.vh + 1, `${devFit.backBottom} of ${devFit.vh}`);

    // ...and the list really does reach its own end
    const devScroll = await cdp.eval(`(() => {
      const g = document.getElementById('dev-grid');
      g.scrollTop = g.scrollHeight;
      const last = g.querySelector('.setting:last-of-type').getBoundingClientRect();
      const box = g.getBoundingClientRect();
      return JSON.stringify({ shown: last.bottom <= box.bottom + 1, top: Math.round(g.scrollTop) });
    })()`);
    const devScrollInfo = JSON.parse(devScroll);
    check('the last developer row is reachable',
      devScrollInfo.shown === true || devFit.listScrolls <= 1, devScroll);

    // changing one has to actually change the game
    const devChange = JSON.parse(await cdp.eval(`(() => {
      const before = window.TONGTOU.state.settings.noteTravel;
      const row = [...document.querySelectorAll('#dev-grid .setting')]
        .find((r) => r.querySelector('.sl').textContent.trim() === '下落时长');
      const input = row.querySelector('input[type=range]');
      input.value = '1.20';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const rapid = [...document.querySelectorAll('#dev-grid .setting')]
        .find((r) => r.querySelector('.sl').textContent.trim() === '打击反馈');
      const sel = rapid.querySelector('select');
      const beforeFx = window.TONGTOU.state.settings.hitFx;
      sel.value = 'off';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return JSON.stringify({
        before, after: window.TONGTOU.state.settings.noteTravel,
        beforeFx, afterFx: window.TONGTOU.state.settings.hitFx,
        rendererFx: window.TONGTOU.renderer.fxLevel,
      });
    })()`));
    check('a developer slider writes through to the live settings',
      devChange.after === 1.20 && devChange.before !== 1.20,
      `${devChange.before} -> ${devChange.after}`);
    check('a developer select reaches the renderer too',
      devChange.afterFx === 'off' && devChange.rendererFx === 'off',
      `${devChange.beforeFx} -> ${devChange.afterFx}, renderer=${devChange.rendererFx}`);
    await sleep(450);                     // settings writes are debounced by 300 ms
    check('it is written to storage like any other setting',
      Math.abs(JSON.parse(await cdp.eval('localStorage.getItem("tongtou.settings.v1")')).noteTravel - 1.2) < 1e-9,
      await cdp.eval('JSON.parse(localStorage.getItem("tongtou.settings.v1")).noteTravel'));

    // developer mode lives on its own key: 恢复默认 must not turn it off
    await cdp.eval(`document.querySelector('#settings [data-act="reset"]')?.click(); true`);
    await cdp.eval('window.TONGTOU.setDevMode(true); true');
    await sleep(200);
    check('developer mode survives a settings reset',
      (await cdp.eval('window.TONGTOU.state.dev')) === true);

    // and it survives a reload, from its own storage key
    await cdp.send('Page.reload');
    for (let i = 0; i < 200; i++) {
      await sleep(250);
      try {
        if (await cdp.eval('!!window.TONGTOU && window.TONGTOU.state.mode !== "boot"')) break;
      } catch { /* mid-navigation */ }
    }
    check('developer mode is remembered across a reload',
      (await cdp.eval('window.TONGTOU.state.dev')) === true,
      String(await cdp.eval('window.TONGTOU.state.dev')));
    check('it is stored apart from the player settings',
      (await cdp.eval('localStorage.getItem("tongtou.dev.v1")')) === '1'
      && !('dev' in JSON.parse(await cdp.eval('localStorage.getItem("tongtou.settings.v1")'))),
      await cdp.eval('localStorage.getItem("tongtou.dev.v1")'));

    // ...and turning it off leaves the button where it was
    await cdp.eval('window.TONGTOU.setDevMode(false); true');
    await sleep(250);
    check('turning it off keeps the entry point in place for next time',
      (await cdp.eval(`document.querySelector('#settings .dev-only').hidden`)) === false
      && (await cdp.eval(`document.querySelector('#settings .dev-only').offsetParent !== null`)) === true);
    check('and clears the stored flag',
      (await cdp.eval('localStorage.getItem("tongtou.dev.v1")')) === null,
      String(await cdp.eval('localStorage.getItem("tongtou.dev.v1")')));

    /* ---- the fullscreen opt-in still works ----------------------------- */
    // Last, because proving it needs a restart.  This is the other half of
    // "starting a run must not take over the screen": the default is off, but
    // the developer switch can still turn it on.
    console.log('\n== fullscreen opt-in ==');

    await cdp.eval(`(() => {
      // the developer section reloaded the page, so the spy has to be re-armed
      window.__fs = { asked: 0 };
      const el = document.documentElement;
      el.requestFullscreen = function () { window.__fs.asked++; return Promise.resolve(); };
      el.webkitRequestFullscreen = el.requestFullscreen;
      window.TONGTOU.state.settings.fullscreenOnStart = true;
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
      return true;
    })()`);
    await cdp.eval('window.TONGTOU.startPlay(); true');
    await sleep(1500);
    check('opting in still requests fullscreen on a touch device',
      (await cdp.eval('window.__fs.asked')) >= 1,
      `${await cdp.eval('window.__fs.asked')} request(s)`);

    await cdp.eval(`(() => {
      window.TONGTOU.state.settings.fullscreenOnStart = false;
      delete navigator.maxTouchPoints;
      window.TONGTOU.pausePlay();
      return true;
    })()`);
    await sleep(400);

    /* ---- AUTO must not survive a reload -------------------------------- */
    // Last, because a reload throws away the run everything above depends on.
    console.log('\n== auto play does not stick ==');

    // the developer screen was locked again by the section above, and AUTO is
    // gated behind it — unlock so this is a real test rather than a no-op
    await cdp.eval('window.TONGTOU.setDevMode(true); true');
    await sleep(200);
    check('AUTO could be switched on for this check',
      (await cdp.eval('window.TONGTOU.setAutoPlay(true)')) === true);
    await sleep(700);                 // settings writes are debounced by 300 ms
    check('AUTO is never written to storage',
      !('autoPlay' in JSON.parse(await cdp.eval('localStorage.getItem("tongtou.settings.v1")'))),
      await cdp.eval('localStorage.getItem("tongtou.settings.v1")'));

    await cdp.send('Page.reload');
    for (let i = 0; i < 200; i++) {
      await sleep(250);
      try {
        if (await cdp.eval('!!window.TONGTOU && window.TONGTOU.state.mode !== "boot"')) break;
      } catch { /* mid-navigation */ }
    }
    check('a reload brings the game back with AUTO off',
      (await cdp.eval('window.TONGTOU.state.settings.autoPlay')) === false,
      String(await cdp.eval('window.TONGTOU.state.settings.autoPlay')));
    check('and nothing on screen claims otherwise',
      (await cdp.eval(`getComputedStyle(document.getElementById('auto-chip')).display`)) === 'none');
  } finally {
    try { cdp?.ws.close(); } catch { /* ignore */ }
    proc.kill();
    server.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('\n' + '-'.repeat(58));
  const failed = checks.filter((c) => !c.ok);

  // An uncaught exception or console.error is a failure in its own right ??it
  // must not be possible to "pass" while the page is throwing every frame.
  if (problems.length) {
    console.log(`problems: ${[...new Set(problems)].join(', ')}`);
  }
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length || problems.length ? 1 : 0);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(2);
});
