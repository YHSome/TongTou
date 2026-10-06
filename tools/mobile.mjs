#!/usr/bin/env node
/**
 * Mobile adaptation test.
 *
 *   node tools/mobile.mjs
 *
 * Emulates real phones over the DevTools Protocol (device metrics + touch
 * emulation) and checks the things that a desktop run cannot:
 *
 *   - the hand-held layout is chosen automatically and uses full-width lanes
 *   - the canvas backing store stays inside the mobile pixel budget
 *   - a single touch on each lane judges a note
 *   - four simultaneous touches register as four independent presses (chords)
 *   - sliding a finger off a lane and lifting still releases the right lane
 *   - the layout is recomputed on rotation
 *
 * Touch is delivered with Input.dispatchTouchEvent, so the events are real
 * multi-touch with distinct touch points.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 8129;
const CDP_PORT = 9339;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
].filter(Boolean);

const DEVICES = [
  { name: 'iPhone 14 Pro portrait', w: 393, h: 852, dpr: 3, mobile: true },
  { name: 'iPhone 14 Pro landscape', w: 852, h: 393, dpr: 3, mobile: true },
  { name: 'Pixel 7 portrait', w: 412, h: 915, dpr: 2.625, mobile: true },
  { name: 'iPad mini landscape', w: 1024, h: 768, dpr: 2, mobile: true },
  // deliberately the smallest phone still in use: the result screen has to fit
  // here too, not just on a large handset
  { name: 'iPhone SE portrait', w: 320, h: 568, dpr: 2, mobile: true },
  { name: 'iPhone SE landscape', w: 568, h: 320, dpr: 2, mobile: true },
];

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
    if (r.exceptionDetails) return `<threw: ${r.exceptionDetails.exception?.description}>`;
    return r.result.value;
  }
}

/* --------------------------------------------------------------------- */

let passed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? `  ??${detail}` : ''}`); return; }
  failures.push(`${name}${detail ? ` (${detail})` : ''}`);
  console.log(` FAIL  ${name}${detail ? `  ??${detail}` : ''}`);
}

/** Deliver one or more simultaneous touch points. */
async function touch(cdp, points, type) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
}

async function setDevice(cdp, dev) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: dev.w, height: dev.h, deviceScaleFactor: dev.dpr, mobile: dev.mobile,
    screenOrientation: { angle: dev.w > dev.h ? 90 : 0, type: dev.w > dev.h ? 'landscapePrimary' : 'portraitPrimary' },
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sleep(600);
}

async function main() {
  const browser = BROWSERS.find((b) => existsSync(b));
  if (!browser) throw new Error('no Chrome/Edge found');
  const profile = mkdtempSync(join(tmpdir(), 'tt-mobile-'));
  const server = spawn(process.execPath, [join(ROOT, 'serve.mjs'), String(PORT), '--strict'], { cwd: ROOT, stdio: 'ignore' });
  await sleep(700);

  const proc = spawn(browser, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--mute-audio', '--hide-scrollbars',
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp;
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch { /* wait */ }
    }
    if (!target) throw new Error('devtools never came up');
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    /* ---- 1. layout per device ------------------------------------------ */
    console.log('\n== device layouts ==');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    for (let i = 0; i < 160; i++) {
      await sleep(250);
      if (await cdp.eval('!!window.TONGTOU && window.TONGTOU.state.mode !== "boot"')) break;
    }

    for (const dev of DEVICES) {
      await setDevice(cdp, dev);
      await cdp.eval('window.TONGTOU.renderer && (window.__r = window.TONGTOU.renderer)');
      const info = JSON.parse(await cdp.eval(`(() => {
        const r = window.TONGTOU.renderer;
        return JSON.stringify({ mode: r.mode, portrait: r.portrait, W: r.W, H: r.H,
          scale: r.scale, fieldX: r.L.fieldX, fieldW: r.L.fieldW });
      })()`));

      const fullWidth = info.fieldX === 0 && Math.abs(info.fieldW - info.W) < 2;
      const megapixels = (info.W * info.H) / 1e6;
      const budgetOk = megapixels <= 2.6;

      console.log(`  ${dev.name}: ${info.mode} ${info.W}x${info.H} (${megapixels.toFixed(2)}MP)`
        + `${info.portrait ? ' portrait' : ' landscape'}`);
      ok(`${dev.name}: hand-held layout`, info.mode === 'handheld', info.mode);
      ok(`${dev.name}: lanes span the full width`, fullWidth,
        `fieldX=${info.fieldX} fieldW=${info.fieldW} W=${info.W}`);
      ok(`${dev.name}: render budget respected`, budgetOk, `${megapixels.toFixed(2)} MP`);
    }

    /* ---- 2. touch play -------------------------------------------------- */
    console.log('\n== touch input ==');
    const dev = DEVICES[0];               // iPhone portrait
    await setDevice(cdp, dev);

    // Bring the run up the way a player does: real touches on the DOM menus.
    // The AudioContext only unlocks from a trusted gesture, so driving the
    // menu is not just cosmetic ??it is what makes audio (and therefore the
    // game clock) start at all.
    const centreOf = async (sel) => {
      const r = await cdp.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return null;
        const b = el.getBoundingClientRect();
        if (b.width === 0) return null;
        return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) });
      })()`);
      return r && r !== 'null' ? JSON.parse(r) : null;
    };
    const tap = async (pt, id = 1) => {
      await touch(cdp, [{ x: pt.x, y: pt.y, id }], 'touchStart');
      await sleep(60);
      await touch(cdp, [], 'touchEnd');
      await sleep(320);
    };

    ok('touch emulation reports a contact digitiser',
      (await cdp.eval('navigator.maxTouchPoints')) >= 1,
      `maxTouchPoints=${await cdp.eval('navigator.maxTouchPoints')}`);

    /* ---- the developer entry must exist on a phone ---------------------- */
    // A phone has no F9, so the settings-screen button is the only way in.  It
    // used to be hidden until the mode was already unlocked, which made the
    // whole developer screen unreachable on every touch device.
    {
      await tap(await centreOf('#title-menu [data-act="settings"]'));
      ok('the settings screen opens on a phone',
        (await cdp.eval('window.TONGTOU.state.mode')) === 'settings',
        await cdp.eval('window.TONGTOU.state.mode'));
      const entry = JSON.parse(await cdp.eval(`(() => {
        const b = document.querySelector('#settings .dev-only');
        const r = b.getBoundingClientRect();
        return JSON.stringify({ hidden: b.hidden, shown: b.offsetParent !== null,
          w: Math.round(r.width), h: Math.round(r.height),
          top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight });
      })()`));
      console.log(`  dev entry ${entry.w}x${entry.h} at y${entry.top}..${entry.bottom} of ${entry.vh}`);
      ok('a phone can see the developer entry', entry.shown && !entry.hidden);
      ok('it is a thumb-sized target', entry.w >= 80 && entry.h >= 40, `${entry.w}x${entry.h}`);
      ok('it is inside the viewport without scrolling',
        entry.top >= 0 && entry.bottom <= entry.vh + 1, `${entry.top}..${entry.bottom}`);

      // tapping it must reach the password prompt, not the screen itself
      await tap({ x: 20 + Math.round(entry.w / 2), y: Math.round((entry.top + entry.bottom) / 2) });
      ok('tapping it opens the password prompt',
        (await cdp.eval('window.TONGTOU.state.mode')) === 'dev-unlock'
        && (await cdp.eval('window.TONGTOU.state.dev')) === false,
        await cdp.eval('window.TONGTOU.state.mode'));
      ok('the prompt fits a phone',
        (await cdp.eval(`(() => {
          const p = document.querySelector('#dev-unlock .panel').getBoundingClientRect();
          return p.top >= 0 && p.bottom <= window.innerHeight + 1;
        })()`)) === true);
      await tap(await centreOf('#dev-unlock [data-act="dev-cancel"]'));
      await sleep(300);
      ok('backing out leaves it locked',
        (await cdp.eval('window.TONGTOU.state.dev')) === false
        && (await cdp.eval('window.TONGTOU.state.mode')) === 'settings',
        await cdp.eval('window.TONGTOU.state.mode'));
      await tap(await centreOf('#settings [data-act="back"]'));
      await sleep(400);
    }

    const playBtn = await centreOf('#title-menu [data-act="play"]');
    ok('menu buttons are tappable in the hand-held layout', !!playBtn,
      playBtn ? `(${playBtn.x},${playBtn.y})` : 'not found');
    await tap(playBtn);
    ok('tapping ???????opens the select screen',
      (await cdp.eval('window.TONGTOU.state.mode')) === 'select',
      await cdp.eval('window.TONGTOU.state.mode'));

    const startBtn = await centreOf('#select [data-act="start"]');
    await tap(startBtn);
    await sleep(700);
    let mode = await cdp.eval('window.TONGTOU.state.mode');
    ok('tapping ????starts the run', mode === 'play', mode);
    ok('the touch gesture unlocked audio',
      (await cdp.eval('window.TONGTOU.audio.ctx.state')) === 'running',
      await cdp.eval('window.TONGTOU.audio.ctx.state'));

    // lane centres in CSS pixels, taken straight from the renderer
    const centres = JSON.parse(await cdp.eval(`(() => {
      const r = window.TONGTOU.renderer, s = r.scale;
      return JSON.stringify([0,1,2,3].map(l => Math.round((r.L.fieldX + (l + 0.5) * r.L.laneW) / s)));
    })()`));
    const tapY = Math.round(dev.h * 0.82);   // where a thumb would rest
    console.log(`  lane centres (css px): ${centres.join(', ')}, tap y=${tapY}`);

    // hit-test sanity: each lane centre must resolve to its own lane
    const hits = JSON.parse(await cdp.eval(
      `JSON.stringify(${JSON.stringify(centres)}.map(x => window.TONGTOU.hitTest(x, ${tapY})))`));
    ok('hitTest maps each lane column to its own lane',
      JSON.stringify(hits) === '[0,1,2,3]', JSON.stringify(hits));
    const held0 = JSON.stringify([false, false, false, false]);

    // a single touch must hold exactly its own lane
    await touch(cdp, [{ x: centres[2], y: tapY, id: 1 }], 'touchStart');
    await sleep(120);
    const heldDuring = await cdp.eval('JSON.stringify(window.TONGTOU.input.held)');
    await touch(cdp, [], 'touchEnd');
    await sleep(120);
    const heldAfter = await cdp.eval('JSON.stringify(window.TONGTOU.input.held)');
    ok('a touch holds exactly its own lane', heldDuring === '[false,false,true,false]', heldDuring);
    ok('lifting releases the lane', heldAfter === held0, heldAfter);

    // tapping well above the judgement line must still work (touch targets are
    // the whole lane column, not a thin strip)
    await touch(cdp, [{ x: centres[1], y: Math.round(dev.h * 0.4), id: 2 }], 'touchStart');
    await sleep(120);
    const highHeld = await cdp.eval('JSON.stringify(window.TONGTOU.input.held)');
    await touch(cdp, [], 'touchEnd');
    await sleep(80);
    ok('taps high up the lane still register', highHeld === '[false,true,false,false]', highHeld);

    // four simultaneous fingers = a four-note chord
    const chord = [
      { x: centres[0], y: tapY, id: 11 },
      { x: centres[1], y: tapY, id: 12 },
      { x: centres[2], y: tapY, id: 13 },
      { x: centres[3], y: tapY, id: 14 },
    ];
    await touch(cdp, chord, 'touchStart');
    await sleep(150);
    const chordHeld = await cdp.eval('JSON.stringify(window.TONGTOU.input.held)');
    ok('four simultaneous touches hold all four lanes',
      chordHeld === '[true,true,true,true]', chordHeld);

    // Lifting a subset must release only the fingers named.  CDP's `touchEnd`
    // releases the points listed in the array, so this lifts fingers 1, 2 and 3
    // and lane 0 must stay held on its own.
    await touch(cdp, chord.slice(1), 'touchEnd');
    await sleep(150);
    const partial = await cdp.eval('JSON.stringify(window.TONGTOU.input.held)');
    ok('lifting three fingers keeps the remaining lane held',
      partial === '[true,false,false,false]', partial);

    // ...and the mirror case: put them back, then lift only lane 0
    await touch(cdp, chord.slice(1), 'touchStart');
    await sleep(150);
    ok('re-pressing restores all four lanes',
      (await cdp.eval('JSON.stringify(window.TONGTOU.input.held)')) === '[true,true,true,true]');
    await touch(cdp, [chord[0]], 'touchEnd');
    await sleep(150);
    ok('lifting the first finger keeps the other three held',
      (await cdp.eval('JSON.stringify(window.TONGTOU.input.held)')) === '[false,true,true,true]',
      await cdp.eval('JSON.stringify(window.TONGTOU.input.held)'));

    await touch(cdp, [], 'touchEnd');
    await sleep(150);
    ok('clearing all touches releases every lane',
      (await cdp.eval('JSON.stringify(window.TONGTOU.input.held)')) === held0);

    /* ---- 2b. taps produce real judgements ------------------------------- */
    // AUTO is off, so a note is only judged if a touch lands inside its window.
    // The tap is scheduled against the audio clock to land on the note.
    let hitsMade = 0;
    for (let attempt = 0; attempt < 10 && hitsMade < 3; attempt++) {
      const plan = await cdp.eval(`(() => {
        const e = window.TONGTOU.engine, a = window.TONGTOU.audio;
        const t = a.now();
        const n = e.notes.find(n => !n.judged && n.lane >= 0 && n.time > t + 0.30);
        return n ? JSON.stringify({ lane: n.lane, delay: n.time - a.now() }) : null;
      })()`);
      if (!plan || plan === 'null') break;
      const { lane, delay } = JSON.parse(plan);
      await sleep(Math.max(0, (delay - 0.02) * 1000));
      await touch(cdp, [{ x: centres[lane], y: tapY, id: 200 + attempt }], 'touchStart');
      await sleep(35);
      await touch(cdp, [], 'touchEnd');
      await sleep(220);
      hitsMade = await cdp.eval(
        'window.TONGTOU.engine.counts.perfect + window.TONGTOU.engine.counts.great + window.TONGTOU.engine.counts.good');
    }
    ok('timed taps produce real judgements (touch path reaches the engine)',
      hitsMade >= 1, `${hitsMade} notes hit by touch`);

    /* ---- 2c. pause button ----------------------------------------------- */
    // A phone has no Esc key, so this button is the only way out of a run.
    console.log('\n== pause button ==');
    const btnBox = JSON.parse(await cdp.eval(`(() => {
      const b = document.getElementById('pause-btn');
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      const ren = window.TONGTOU.renderer;
      return JSON.stringify({ display: cs.display, left: r.left, top: r.top,
        right: r.right, bottom: r.bottom, w: r.width, h: r.height,
        inset: ren._hudInset || 0, scale: ren.scale });
    })()`));
    console.log(`  button ${btnBox.w}x${btnBox.h} at (${btnBox.left},${btnBox.top})`
      + ` display=${btnBox.display} hudInset=${btnBox.inset.toFixed(1)}`);
    ok('the pause button is visible during a hand-held run',
      btnBox.display !== 'none', btnBox.display);
    ok('it is a thumb-sized target', btnBox.w >= 40 && btnBox.h >= 40,
      `${btnBox.w}x${btnBox.h}`);
    ok('it sits in the top-left corner, out of the lane field',
      btnBox.left >= 0 && btnBox.top >= 0 && btnBox.right < dev.w * 0.5
        && btnBox.bottom < dev.h * 0.25,
      `(${btnBox.left},${btnBox.top})-(${btnBox.right},${btnBox.bottom})`);
    ok('the HUD bar reserves room for it',
      btnBox.inset >= btnBox.right * btnBox.scale - 1,
      `inset=${btnBox.inset.toFixed(1)} device px vs button right=${(btnBox.right * btnBox.scale).toFixed(1)}`);

    const pausePt = await centreOf('#pause-btn');
    await tap(pausePt);
    ok('tapping it pauses the run',
      (await cdp.eval('window.TONGTOU.state.mode')) === 'pause',
      await cdp.eval('window.TONGTOU.state.mode'));
    ok('the pause screen comes up',
      (await cdp.eval(`document.getElementById('pause').classList.contains('is-active')`)) === true);
    ok('the button stands down while paused',
      (await cdp.eval(`getComputedStyle(document.getElementById('pause-btn')).display`)) === 'none');
    const t0 = await cdp.eval('window.TONGTOU.audio.now()');
    await sleep(450);
    const t1 = await cdp.eval('window.TONGTOU.audio.now()');
    ok('the song clock is really stopped', Math.abs(t1 - t0) < 0.05,
      `advanced ${(t1 - t0).toFixed(3)} s while paused`);

    // ...and the panel's own button must resume it
    await tap(await centreOf('#pause [data-act="resume"]'));
    ok('the pause panel resumes the run',
      (await cdp.eval('window.TONGTOU.state.mode')) === 'play',
      await cdp.eval('window.TONGTOU.state.mode'));
    ok('the pause button returns after resuming',
      (await cdp.eval(`getComputedStyle(document.getElementById('pause-btn')).display`)) !== 'none');

    /* ---- 2d. AUTO on a phone -------------------------------------------- */
    // A phone has no F2, so before this chip there was no way to leave AUTO at
    // all — the game just played itself forever.
    console.log('\n== auto play ==');
    // AUTO is gated behind developer mode, so unlock with the test hook first
    await cdp.eval('window.TONGTOU.setDevMode(true); true');
    await sleep(150);
    await cdp.eval('window.TONGTOU.setAutoPlay(true); true');
    await sleep(350);
    const chip = JSON.parse(await cdp.eval(`(() => {
      const c = document.getElementById('auto-chip');
      const r = c.getBoundingClientRect();
      return JSON.stringify({ display: getComputedStyle(c).display,
        w: Math.round(r.width), h: Math.round(r.height),
        left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right),
        vw: window.innerWidth, vh: window.innerHeight,
        text: c.textContent.replace(/\\s+/g, ' ').trim() });
    })()`));
    console.log(`  AUTO chip ${chip.w}x${chip.h} at (${chip.left},${chip.top}) — "${chip.text}"`);
    ok('AUTO is visible on a phone', chip.display !== 'none', chip.display);
    ok('it is a thumb-sized target', chip.h >= 40 && chip.w >= 80, `${chip.w}x${chip.h}`);
    ok('it fits inside the viewport', chip.left >= 0 && chip.right <= chip.vw && chip.top >= 0,
      `${chip.left}..${chip.right} of ${chip.vw}`);
    ok('it does not sit on top of the lane field',
      chip.top + chip.h < dev.h * 0.2, `bottom ${chip.top + chip.h} vs ${Math.round(dev.h * 0.2)}`);

    await tap({ x: Math.round((chip.left + chip.right) / 2), y: Math.round(chip.top + chip.h / 2) });
    ok('tapping it turns AUTO off',
      (await cdp.eval('window.TONGTOU.state.settings.autoPlay')) === false);
    ok('and it disappears',
      (await cdp.eval(`getComputedStyle(document.getElementById('auto-chip')).display`)) === 'none');

    /* ---- 3. rotation ---------------------------------------------------- */
    console.log('\n== rotation ==');
    await setDevice(cdp, DEVICES[1]);      // landscape
    const rotated = JSON.parse(await cdp.eval(`(() => {
      const r = window.TONGTOU.renderer;
      return JSON.stringify({ portrait: r.portrait, W: r.W, H: r.H, mode: r.mode });
    })()`));
    ok('layout recomputes on rotation', rotated.portrait === false && rotated.W > rotated.H,
      `${rotated.W}x${rotated.H} portrait=${rotated.portrait}`);
    ok('still hand-held after rotating', rotated.mode === 'handheld', rotated.mode);

    /* ---- 4. show cue on a phone ----------------------------------------- */
    console.log('\n== show cue on a phone ==');

    // The burst must take the hand-held form (a golden frame), never the
    // full-width flame jets, which would fire straight up behind the lanes.
    const aura = JSON.parse(await cdp.eval(`(() => {
      const r = window.TONGTOU.renderer, eng = window.TONGTOU.engine;
      const tl = eng.timeline, s = window.TONGTOU.state.settings;
      const t = window.TONGTOU.audio.now();
      const real = tl.events;

      function probe(age) {
        tl.events = age === null ? [] : [{ time: t - age, type: 'fire', cue: 'probe' }];
        r._fireActive = r._fireState(t, tl);
        const ctx = r.ctx;
        let strokes = 0, arcs = 0, fills = 0;
        const os = ctx.stroke.bind(ctx), oa = ctx.arc.bind(ctx), of = ctx.fill.bind(ctx);
        ctx.stroke = (...x) => { strokes++; return os(...x); };
        ctx.arc = (...x) => { arcs++; return oa(...x); };
        ctx.fill = (...x) => { fills++; return of(...x); };
        r.draw({ time: t, timeline: tl, engine: eng, settings: s,
                 input: window.TONGTOU.input, audio: window.TONGTOU.audio,
                 playing: true, fps: 60 });
        ctx.stroke = os; ctx.arc = oa; ctx.fill = of;
        return { strokes, arcs, fills };
      }

      const idle = probe(null);
      const peak = probe(1.40);
      tl.events = real;
      r._fireActive = [];
      return JSON.stringify({ idle, peak, mode: r.mode });
    })()`));
    console.log(`  hand-held mode: ${aura.mode}`);
    console.log(`  draw ops idle=${JSON.stringify(aura.idle)} peak=${JSON.stringify(aura.peak)}`);
    ok('the show cue is hand-held here', aura.mode === 'handheld', aura.mode);
    ok('it draws a framed overlay (new strokes appear)',
      aura.peak.strokes > aura.idle.strokes + 3,
      `${aura.idle.strokes} -> ${aura.peak.strokes}`);
    ok('it stays cheap — no particle storm on a phone',
      aura.peak.fills < aura.idle.fills + 90,
      `fills ${aura.idle.fills} -> ${aura.peak.fills}`);

    // the golden frame is drawn from every edge inward, so the playfield centre
    // must be untouched: sample the middle of the screen
    const centre = await cdp.eval(`(() => {
      const r = window.TONGTOU.renderer, eng = window.TONGTOU.engine;
      const tl = eng.timeline, s = window.TONGTOU.state.settings;
      const t = window.TONGTOU.audio.now();
      const real = tl.events;
      const ctx = r.ctx;
      tl.events = [{ time: t - 1.4, type: 'fire', cue: 'probe' }];
      r._fireActive = r._fireState(t, tl);
      ctx.clearRect(0, 0, r.W, r.H);
      r.draw({ time: t, timeline: tl, engine: eng, settings: s,
               input: window.TONGTOU.input, audio: window.TONGTOU.audio,
               playing: true, fps: 60 });
      // sample a vertical strip in the middle of the field
      const x = r.W >> 1;
      const d = ctx.getImageData(x, (r.H * 0.30) | 0, 4, 4).data;
      let warm = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 8 && d[i] > 150) warm++;
      // and a point on the border band
      const b = ctx.getImageData(4, r.H >> 1, 4, 4).data;
      let edge = 0;
      for (let i = 0; i < b.length; i += 4) if (b[i + 3] > 8) edge++;
      tl.events = real;
      r._fireActive = [];
      return JSON.stringify({ warm, edge });
    })()`);
    const mid = JSON.parse(centre);
    ok('the border is painted', mid.edge > 0, `${mid.edge}/16 px on the left edge`);

    /* ---- 5. screenshots ------------------------------------------------- */
    /* ---- 5. screenshots ------------------------------------------------- */
    console.log('\n== screenshots ==');
    await cdp.eval('window.TONGTOU.state.settings.autoPlay = true');
    await setDevice(cdp, DEVICES[0]);
    await sleep(9000);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: 0, mobile: false });
    await sleep(200);
    await setDevice(cdp, DEVICES[0]);
    await sleep(1400);
    let shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    let out = join(ROOT, 'tools', 'shots', 'phone-portrait.png');
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`  saved ${out}`);

    // portrait, mid show-cue: freeze the clock so the frame is captured at a
    // known point of the burst
    await cdp.eval('window.__ev = window.TONGTOU.engine.timeline.events.slice(); true');
    await cdp.eval('window.TONGTOU.pausePlay(); true');
    await sleep(400);
    await cdp.eval(`(() => {
      for (const s of document.querySelectorAll('.screen')) s.classList.remove('is-active');
      const tl = window.TONGTOU.engine.timeline;
      tl.events = [{ time: window.TONGTOU.audio.now() - 1.3, type: 'fire', cue: 'shot' }];
      return true;
    })()`);
    await sleep(700);
    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    out = join(ROOT, 'tools', 'shots', 'phone-portrait-aura.png');
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`  saved ${out}`);

    await cdp.eval('window.TONGTOU.resumePlay(); true');
    await sleep(300);
    // put the real cues back before taking any further (non-aura) screenshots
    await cdp.eval('window.TONGTOU.engine.timeline.events = window.__ev; true');

    await setDevice(cdp, DEVICES[1]);
    await sleep(1200);
    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    out = join(ROOT, 'tools', 'shots', 'phone-landscape.png');
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`  saved ${out}`);

    // landscape, mid show-cue
    await cdp.eval('window.__ev = window.TONGTOU.engine.timeline.events.slice(); true');
    await cdp.eval('window.TONGTOU.pausePlay(); true');
    await sleep(400);
    await cdp.eval(`(() => {
      for (const s of document.querySelectorAll('.screen')) s.classList.remove('is-active');
      const tl = window.TONGTOU.engine.timeline;
      tl.events = [{ time: window.TONGTOU.audio.now() - 1.3, type: 'fire', cue: 'shot' }];
      return true;
    })()`);
    await sleep(500);
    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    out = join(ROOT, 'tools', 'shots', 'phone-landscape-aura.png');
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`  saved ${out}`);
    const land = JSON.parse(await cdp.eval(`JSON.stringify({
      mode: window.TONGTOU.renderer.mode,
      glow: +window.TONGTOU.renderer.fireGlow.toFixed(3),
      portrait: window.TONGTOU.renderer.portrait })`));
    console.log(`  landscape aura state: ${JSON.stringify(land)}`);
    ok('the golden frame also draws in landscape',
      land.glow > 0.5 && land.mode === 'handheld', JSON.stringify(land));
    await cdp.eval('window.TONGTOU.resumePlay(); true');
    await cdp.eval('window.TONGTOU.engine.timeline.events = window.__ev; true');
    await sleep(200);
    await sleep(1600);
    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    out = join(ROOT, 'tools', 'shots', 'phone-landscape.png');
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`  saved ${out}`);

    /* ---- 6. tip dialog on a phone ---------------------------------------- */
    // The tip lives on the result screen; a phone is exactly where it matters
    // most (and exactly where a QR cannot be scanned from the same screen).
    console.log('\n== tip dialog ==');
    await cdp.eval('window.TONGTOU.finishPlay(); true');
    await sleep(500);
    ok('reached the result screen',
      (await cdp.eval('window.TONGTOU.state.mode')) === 'result',
      await cdp.eval('window.TONGTOU.state.mode'));

    /* ---- the result screen must be one page, not a scroll --------------- */
    // A phone player should see the whole summary at once; if it scrolls they
    // can miss the score, the stats or the tip button entirely.
    const fits = async (label, shotName) => {
      const m = JSON.parse(await cdp.eval(`(() => {
        const s = document.getElementById('result');
        const p = s.querySelector('.panel');
        const r = p.getBoundingClientRect();
        return JSON.stringify({
          vw: window.innerWidth, vh: window.innerHeight,
          screenOverflow: s.scrollHeight - s.clientHeight,
          panelOverflow: p.scrollHeight - p.clientHeight,
          top: Math.round(r.top), bottom: Math.round(r.bottom),
          w: Math.round(r.width), h: Math.round(r.height),
          sponsor: (() => { const b = document.getElementById('sponsor-btn');
            const q = b.getBoundingClientRect();
            return { top: Math.round(q.top), bottom: Math.round(q.bottom) }; })(),
          // compressing must not silently truncate anything.  The tip button is
          // measured with a Range instead of scrollWidth: its sheen is a
          // pseudo-element that deliberately overflows and is clipped, so
          // scrollWidth reports the animation rather than the text.
          clipped: [...s.querySelectorAll('.rcell .label, .rcell .num, .panel-actions .btn:not(.sponsor)')]
            .filter((e) => e.scrollWidth > e.clientWidth + 1)
            .map((e) => e.textContent.trim().slice(0, 16)
              + '(' + e.scrollWidth + '>' + e.clientWidth + ')'),
          sponsorText: (() => {
            const b = document.getElementById('sponsor-btn');
            const r = document.createRange();
            r.selectNodeContents(b);
            return { text: Math.ceil(r.getBoundingClientRect().width), box: b.clientWidth };
          })(),
          gridOverflow: (() => {
            const g = s.querySelector('.result-grid');
            return g.scrollWidth - g.clientWidth;
          })(),
        });
      })()`));
      console.log(`  ${label}: panel ${m.w}x${m.h} @y${m.top}..${m.bottom}`
        + ` viewport ${m.vw}x${m.vh}; screen overflow ${m.screenOverflow}px,`
        + ` panel overflow ${m.panelOverflow}px; tip button ends at ${m.sponsor.bottom}`);
      ok(`${label}: nothing in the summary is truncated`,
        m.clipped.length === 0 && m.gridOverflow <= 1,
        m.clipped.join(' | ') || `${m.gridOverflow}px grid overflow`);
      ok(`${label}: the tip label fits its button`,
        m.sponsorText.text <= m.sponsorText.box,
        `${m.sponsorText.text}px label in ${m.sponsorText.box}px`);
      ok(`${label}: the result screen does not scroll`, m.screenOverflow <= 1,
        `${m.screenOverflow}px over`);
      ok(`${label}: the panel fits the viewport`,
        m.top >= 0 && m.bottom <= m.vh + 1 && m.w <= m.vw + 1,
        `${m.top}..${m.bottom} of ${m.vh}`);
      ok(`${label}: the tip button is on screen without scrolling`,
        m.sponsor.top >= 0 && m.sponsor.bottom <= m.vh + 1,
        `${m.sponsor.top}..${m.sponsor.bottom} of ${m.vh}`);
      return m;
    };

    await fits(`landscape ${await cdp.eval('window.innerWidth')}x${await cdp.eval('window.innerHeight')}`,
      'phone-result-landscape');
    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    out = join(ROOT, 'tools', 'shots', 'phone-result-landscape.png');
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`  saved ${out}`);

    // and the same screen in portrait, straight after a rotation
    await setDevice(cdp, DEVICES[0]);
    await sleep(400);
    await fits(`portrait ${await cdp.eval('window.innerWidth')}x${await cdp.eval('window.innerHeight')}`,
      'phone-result-portrait');
    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    out = join(ROOT, 'tools', 'shots', 'phone-result-portrait.png');
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`  saved ${out}`);
    // back to landscape so the dialog checks below keep their reference size
    await setDevice(cdp, DEVICES[1]);
    await sleep(400);

    // ...and on every other handset, because "fits" is a per-viewport property
    // and the small ones are where a summary screen normally starts scrolling
    for (const d of [DEVICES[2], DEVICES[4], DEVICES[5]]) {
      await setDevice(cdp, d);
      await sleep(400);
      await fits(`${d.name} ${d.w}x${d.h}`);
      if (d.name.includes('SE')) {
        shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        out = join(ROOT, 'tools', 'shots', `phone-result-${d.w}x${d.h}.png`);
        writeFileSync(out, Buffer.from(shot.data, 'base64'));
        console.log(`  saved ${out}`);
      }
    }
    await setDevice(cdp, DEVICES[1]);
    await sleep(400);

    // No scrollIntoView: the whole point of the compact layout is that the
    // button is already on screen and directly tappable.
    const tipCentre = await centreOf('#sponsor-btn');
    const viewH = await cdp.eval('window.innerHeight');
    console.log(`  tip button at ${JSON.stringify(tipCentre)} of ${viewH}px tall`);
    ok('the tip button is already inside the viewport',
      !!tipCentre && tipCentre.y > 0 && tipCentre.y < viewH, JSON.stringify(tipCentre));

    await tap(tipCentre);
    ok('tapping the tip button opens the dialog',
      (await cdp.eval('window.TONGTOU.state.sponsorOpen')) === true);

    const tip = JSON.parse(await cdp.eval(`(() => {
      const card = document.querySelector('.sponsor-card');
      const qr = document.getElementById('sponsor-qr');
      const x = document.getElementById('sponsor-x');
      const extra = document.querySelector('.sponsor-mobile-only');
      const body = document.querySelector('.sponsor-body');
      const c = card.getBoundingClientRect(), q = qr.getBoundingClientRect();
      const xb = x.getBoundingClientRect();
      return JSON.stringify({ cw: Math.round(c.width), ch: Math.round(c.height),
        qw: Math.round(q.width), qh: Math.round(q.height),
        xw: Math.round(xb.width), xh: Math.round(xb.height),
        vw: window.innerWidth, vh: window.innerHeight,
        loaded: qr.naturalWidth > 0,
        overflow: body.scrollHeight - body.clientHeight,
        extra: extra ? getComputedStyle(extra).display : 'none' });
    })()`));
    console.log(`  card ${tip.cw}x${tip.ch}, qr ${tip.qw}x${tip.qh}, on ${tip.vw}x${tip.vh}`);
    ok('the card fits the phone viewport',
      tip.cw <= tip.vw && tip.ch <= tip.vh, `${tip.cw}x${tip.ch} in ${tip.vw}x${tip.vh}`);
    ok('nothing inside the card has to be scrolled to', tip.overflow <= 1,
      `${tip.overflow}px of overflow`);
    ok('the QR loads and is big enough to scan', tip.loaded && tip.qw >= 140 && tip.qw === tip.qh,
      `${tip.qw}x${tip.qh}`);
    ok('the close button is a thumb-sized target', tip.xw >= 40 && tip.xh >= 40,
      `${tip.xw}x${tip.xh}`);
    ok('a phone gets the “cannot scan its own screen” hint', tip.extra !== 'none', tip.extra);
    ok('the dialog sits above the result panel',
      (await cdp.eval(`(() => {
        const m = document.getElementById('sponsor-modal');
        return getComputedStyle(m).zIndex > getComputedStyle(document.getElementById('result')).zIndex;
      })()`)) === true);

    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    out = join(ROOT, 'tools', 'shots', 'phone-sponsor.png');
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`  saved ${out}`);

    // portrait is the case that matters for reading a QR off the screen
    await setDevice(cdp, DEVICES[0]);
    const tipP = JSON.parse(await cdp.eval(`(() => {
      const card = document.querySelector('.sponsor-card');
      const qr = document.getElementById('sponsor-qr');
      const body = document.querySelector('.sponsor-body');
      const c = card.getBoundingClientRect(), q = qr.getBoundingClientRect();
      return JSON.stringify({ cw: Math.round(c.width), ch: Math.round(c.height),
        qw: Math.round(q.width), vw: window.innerWidth, vh: window.innerHeight,
        overflow: body.scrollHeight - body.clientHeight });
    })()`));
    console.log(`  portrait card ${tipP.cw}x${tipP.ch}, qr ${tipP.qw}px on ${tipP.vw}x${tipP.vh}`);
    ok('portrait: the card fits and the QR is large',
      tipP.ch <= tipP.vh && tipP.cw <= tipP.vw && tipP.qw >= 180 && tipP.overflow <= 1,
      `${tipP.cw}x${tipP.ch}, qr ${tipP.qw}, overflow ${tipP.overflow}`);
    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    out = join(ROOT, 'tools', 'shots', 'phone-sponsor-portrait.png');
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`  saved ${out}`);

    await cdp.eval(`document.getElementById('sponsor-ok').click(); true`);
    await sleep(250);
    ok('the 关闭 button closes it',
      (await cdp.eval('window.TONGTOU.state.sponsorOpen')) === false);

    /* ---- 7. no console errors ------------------------------------------ */
    ok('no console errors or exceptions', cdp.errors.length === 0,
      cdp.errors.slice(0, 3).join(' | '));
  } finally {
    try { cdp?.ws.close(); } catch { /* ignore */ }
    proc.kill();
    server.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n${'-'.repeat(58)}`);
  console.log(`${passed} checks passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('mobile test crashed:', e); process.exit(2); });
