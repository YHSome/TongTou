#!/usr/bin/env node
/**
 * Screenshot harness: boots the game headlessly and captures real frames at a
 * chosen resolution, so the 4K layout can be inspected without a display.
 *
 *   node tools/shots.mjs [width] [height]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'tools', 'shots');
const PORT = 8124;
const CDP_PORT = 9334;
const W = Number(process.argv[2] || 3840);
const H = Number(process.argv[3] || 2160);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
].filter(Boolean);

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = []; this.errors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      } else {
        if (m.method === 'Runtime.exceptionThrown') {
          this.errors.push(m.params.exceptionDetails.exception?.description
            || m.params.exceptionDetails.text);
        } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
          this.errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
        }
        for (const l of this.listeners) l(m);
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 60000);
    });
  }
  on(fn) { this.listeners.push(fn); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
    return r.result.value;
  }
  async shot(name, clip) {
    const params = { format: 'png', captureBeyondViewport: false };
    if (clip) params.clip = { ...clip, scale: clip.scale || 1 };
    const r = await this.send('Page.captureScreenshot', params);
    const file = join(OUT, `${name}.png`);
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`  saved ${file}`);
    return file;
  }
}

async function main() {
  const browser = BROWSERS.find((b) => existsSync(b));
  if (!browser) throw new Error('no browser found');
  mkdirSync(OUT, { recursive: true });

  const profile = mkdtempSync(join(tmpdir(), 'tt-shots-'));
  const server = spawn(process.execPath, [join(ROOT, 'serve.mjs'), String(PORT), '--strict'], { cwd: ROOT, stdio: 'ignore' });
  await sleep(700);

  const proc = spawn(browser, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--mute-audio',
    '--hide-scrollbars',
    `--window-size=${W},${H}`,
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

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: 1, mobile: false,
    });

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });

    for (let i = 0; i < 160; i++) {
      await sleep(250);
      try { if (await cdp.eval('!!window.TONGTOU && window.TONGTOU.state.mode !== "boot"')) break; } catch { /* wait */ }
    }

    // pin the render target explicitly
    await cdp.eval(`(() => {
      const s = window.TONGTOU.state.settings;
      s.renderScale = '${H}';
      return true;
    })()`);
    await sleep(300);

    const size = await cdp.eval('JSON.stringify({w:window.TONGTOU.renderer.W,h:window.TONGTOU.renderer.H})');
    console.log(`  render target: ${size}`);

    // trusted input only: a synthetic KeyboardEvent carries no user activation,
    // so the AudioContext would stay suspended and the run would never start
    const key = async (code, k, vk, text) => {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', code, key: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', code, key: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      });
      await sleep(350);
    };

    // ---- title screen ---------------------------------------------------
    await cdp.shot(`${W}x${H}-1-title`);

    // ---- difficulty select ----------------------------------------------
    await key('Enter', 'Enter', 13, '\r');     // title -> select
    await cdp.shot(`${W}x${H}-0-select`);
    await key('Escape', 'Escape', 27, '');     // back to the title
    await sleep(400);

    // ---- settings (key binder) ------------------------------------------
    await cdp.eval(`(() => {
      const b = document.querySelector('#title-menu [data-act="settings"]');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(700);
    await cdp.shot(`${W}x${H}-4-settings`);

    // ---- developer screen (F9 -> password) -------------------------------
    await key('F9', 'F9', 120, '');
    await sleep(500);
    await cdp.shot(`${W}x${H}-c-dev-lock`);
    await cdp.eval(`(() => {
      const i = document.getElementById('dev-password');
      i.value = window.TONGTOU.DEV_PASSWORD;
      document.getElementById('dev-lock-form').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(600);
    await cdp.shot(`${W}x${H}-b-dev`);
    await key('F9', 'F9', 120, '');
    await sleep(400);

    await cdp.eval(`(() => {
      const b = document.querySelector('#settings [data-act="back"]');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(500);
    await cdp.eval(`(() => {
      const b = document.querySelector('#select [data-act="back"]');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(500);

    // ---- gameplay -------------------------------------------------------
    await key('Enter', 'Enter', 13, '\r');     // title -> select
    await key('Enter', 'Enter', 13, '\r');     // select -> play
    await sleep(600);
    const mode = await cdp.eval('window.TONGTOU.state.mode');
    console.log(`  mode: ${mode}  ctx: ${await cdp.eval('window.TONGTOU.audio.ctx.state')}`);
    if (mode !== 'play') throw new Error(`gameplay did not start (mode=${mode})`);

    await cdp.eval('window.TONGTOU.state.settings.autoPlay = true');
    await cdp.eval('window.TONGTOU.state.settings.showOffsetGuide = true');
    await sleep(24000);            // into a dense section with a real combo
    await cdp.shot(`${W}x${H}-2-play`);

    const info = await cdp.eval(`(() => { const e = window.TONGTOU.engine;
      return JSON.stringify({t:+window.TONGTOU.audio.now().toFixed(2), combo:e.maxCombo,
        score:e.score, gauge:+e.gauge.toFixed(1), perfect:e.counts.perfect}); })()`);
    console.log(`  at shot: ${info}`);

    // ---- hit-feedback closeup -------------------------------------------
    // Pausing freezes the clock, so effects injected now stay on screen and the
    // burst can be inspected at a known age instead of hoping to catch it.
    await cdp.eval('window.TONGTOU.pausePlay(); true');
    await sleep(500);
    await cdp.eval(`(() => {
      const r = window.TONGTOU.renderer;
      const t = window.TONGTOU.audio.now();
      r.effects.length = 0;
      // four judgements at different ages so every layer is visible at once
      const plan = [['perfect', 0, 0.05], ['great', 1, 0.13], ['perfect', 2, 0.02], ['good', 3, 0.10]];
      for (const [kind, lane, age] of plan) r.ingest([{ type: 'judge', kind, lane, time: t - age }], t - age);
      r._hitAt = plan.map((p) => t - p[2]);
      r._pulsePower = [0.52, 0.36, 0.52, 0.22];
      return true;
    })()`);
    await sleep(700);
    // the pause overlay would cover the very thing being inspected
    await cdp.eval(`(() => {
      for (const s of document.querySelectorAll('.screen')) s.classList.remove('is-active');
      return true;
    })()`);
    await sleep(400);
    const tally = await cdp.eval(`(() => {
      const r = window.TONGTOU.renderer;
      const t = window.TONGTOU.audio.now();
      const out = {};
      for (const e of r.effects) out[e.kind] = (out[e.kind] || 0) + 1;
      return JSON.stringify({ tally: out, n: r.effects.length,
        fx: r.fxLevel, firstAge: r.effects.length ? +(t - r.effects[0].born).toFixed(3) : null });
    })()`);
    console.log(`  effects at shot: ${tally}`);
    if (cdp.errors.length) {
      console.log('  !! page errors:');
      for (const e of [...new Set(cdp.errors)].slice(0, 5)) console.log(`     ${e.split('\n')[0]}`);
    } else {
      console.log('  page errors: none');
    }
    await cdp.shot(`${W}x${H}-5-hitfx`);
    // zoom on the judgement line so the burst can actually be judged
    const box = JSON.parse(await cdp.eval(`(() => {
      const r = window.TONGTOU.renderer, L = r.L, s = r.scale;
      return JSON.stringify({ x: L.fieldX / s, judgeY: L.judgeY / s,
        w: L.fieldW / s, laneW: L.laneW / s, h: window.innerHeight });
    })()`));
    await cdp.shot(`${W}x${H}-6-hitfx-zoom`, {
      x: Math.max(0, box.x - 10),
      y: Math.max(0, box.judgeY - box.laneW * 1.1),
      width: Math.min(W - Math.max(0, box.x - 10), box.w + 20),
      height: box.laneW * 1.7,
      scale: 2,
    });
    await cdp.eval(`(() => {
      document.getElementById('pause').classList.add('is-active');
      return true;
    })()`);
    await cdp.eval('window.TONGTOU.resumePlay(); true');
    await sleep(400);

    // ---- concert pyro ---------------------------------------------------
    // The burst is a pure function of time, so a synthetic cue at a known age
    // renders exactly what the player sees mid-burst.
    await cdp.eval('window.__realEvents = window.TONGTOU.engine.timeline.events.slice(); true');
    // freeze the clock, otherwise the game keeps advancing during the capture
    // sleep and every frame lands at the wrong point of the burst
    await cdp.eval('window.TONGTOU.pausePlay(); true');
    await sleep(500);
    // the pause overlay would cover the very thing being inspected
    await cdp.eval(`(() => {
      for (const s of document.querySelectorAll('.screen')) s.classList.remove('is-active');
      return true;
    })()`);
    await sleep(300);
    for (const [name, age] of [['8-fire-build', 0.45], ['9-fire-peak', 1.40], ['a-fire-tail', 3.05]]) {
      await cdp.eval(`(() => {
        const tl = window.TONGTOU.engine.timeline;
        const t = window.TONGTOU.audio.now();
        tl.events = [{ time: t - ${age}, type: 'fire', cue: 'shot' }];
        return true;
      })()`);
      await sleep(500);
      await cdp.shot(`${W}x${H}-${name}`);
    }
    await cdp.eval(`(() => {
      window.TONGTOU.engine.timeline.events = window.__realEvents;
      return true;
    })()`);
    // jump to the end; the sweep resolves the rest and the run finishes.
    // The clock must be running again or `seek` lands on a paused transport and
    // the sweep never reaches the end of the song.
    await cdp.eval('window.TONGTOU.resumePlay(); true');
    await sleep(500);
    await cdp.eval('window.TONGTOU.audio.seek(window.TONGTOU.audio.duration - 0.6)');
    await sleep(3000);
    const endMode = await cdp.eval('window.TONGTOU.state.mode');
    console.log(`  end mode: ${endMode}`);
    await cdp.shot(`${W}x${H}-3-result`);

    // ---- tip dialog ------------------------------------------------------
    // it only exists on the result screen, so it is captured from there
    if (endMode === 'result') {
      await cdp.eval(`document.getElementById('sponsor-btn').click(); true`);
      await sleep(700);
      console.log(`  tip dialog open: ${await cdp.eval('window.TONGTOU.state.sponsorOpen')}`);
      await cdp.shot(`${W}x${H}-7-sponsor`);
    }
  } finally {
    try { cdp?.ws.close(); } catch { /* ignore */ }
    proc.kill();
    server.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error('shots failed:', e); process.exit(1); });
