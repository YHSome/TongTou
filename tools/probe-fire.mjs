#!/usr/bin/env node
/**
 * End-to-end check: does the concert pyro actually start at the moment a note
 * reaches the judgement line, in a real running game on HARD?
 *
 *   node tools/probe-fire.mjs
 *
 * The unit tests prove the cue time equals a note time in the data.  This
 * watches the live frame loop instead, and reports where the nearest note was
 * when the burst became visible.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 8141;
const CDP_PORT = 9351;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSER = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
].filter(Boolean).find((b) => existsSync(b));

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
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
    if (r.exceptionDetails) return `<threw: ${r.exceptionDetails.exception?.description}>`;
    return r.result.value;
  }
}

const server = spawn(process.execPath, [join(ROOT, 'serve.mjs'), String(PORT), '--strict'], { cwd: ROOT, stdio: 'ignore' });
await sleep(800);
const profile = mkdtempSync(join(tmpdir(), 'tt-fire-'));
const proc = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--mute-audio', '--window-size=1920,1080',
  'about:blank'], { stdio: 'ignore' });

try {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page');
    } catch { /* wait */ }
  }
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 160; i++) {
    await sleep(250);
    if (await cdp.eval('!!window.TONGTOU && window.TONGTOU.state.mode !== "boot"')) break;
  }

  const key = async (code, k, vk, text) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: k, windowsVirtualKeyCode: vk, text });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: k, windowsVirtualKeyCode: vk });
    await sleep(320);
  };

  await key('Enter', 'Enter', 13, '\r');                    // -> select
  await cdp.eval('document.querySelector(\'.diff[data-d="hard"]\').click()');
  await sleep(300);
  await key('Enter', 'Enter', 13, '\r');                    // -> play (unlocks audio)
  await sleep(600);

  console.log('difficulty:', await cdp.eval('window.TONGTOU.state.difficulty'));

  const cues = JSON.parse(await cdp.eval(`JSON.stringify(
    window.TONGTOU.engine.timeline.events.map(e => +e.time.toFixed(3)))`));
  console.log('hard fire cues at:', cues.join(', '), '\n');

  for (const cue of cues.slice(0, 3)) {
    // restart just before the cue so we can watch it arrive
    await cdp.eval(`window.TONGTOU.startPlay(${Math.max(0, cue - 1.2)})`);
    await sleep(400);

    // The real frame loop is running; sample until the burst appears.
    const trace = [];
    for (let i = 0; i < 90; i++) {
      const s = await cdp.eval(`(() => {
        const r = window.TONGTOU.renderer, eng = window.TONGTOU.engine;
        const tl = eng.timeline, t = window.TONGTOU.audio.now();
        let lit = false;
        for (const e of tl.events) {
          const u = (t - e.time) / 3.5;
          if (u >= 0 && u < 1) lit = true;
        }
        let best = Infinity, bestLane = -1;
        for (const n of eng.notes) {
          const d = n.time - t;
          if (Math.abs(d) < Math.abs(best)) { best = d; bestLane = n.lane; }
        }
        return JSON.stringify({ t: +t.toFixed(3), lit, nearestDt: +best.toFixed(3), lane: bestLane });
      })()`);
      const st = JSON.parse(s);
      trace.push(st);
      if (st.lit) break;
      await sleep(40);
    }
    const lit = trace.find((s) => s.lit);
    if (!lit) { console.log(`  cue @${cue}s: burst never observed`); continue; }
    // sampling every 40 ms means we can only ever catch the burst up to one
    // interval after it starts, so allow a little slack before crying foul
    const slack = 0.055;
    const verdict = Math.abs(lit.nearestDt) <= slack ? 'ON THE LINE' : '!!! OFF THE LINE';
    console.log(`  cue @${cue}s -> burst visible at t=${lit.t}`
      + `  nearest note dt=${lit.nearestDt}s (lane ${lit.lane},`
      + ` sampled ${((lit.t - cue) * 1000).toFixed(0)} ms after the cue)  ${verdict}`);
  }

  const errs = cdp.errors;
  console.log('\npage errors:', errs.length ? errs.slice(0, 3) : 'none');
  cdp.ws.close();
} finally {
  proc.kill();
  server.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
