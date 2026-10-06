#!/usr/bin/env node
/**
 * Deployment health check: boot the game from a *remote* URL and confirm it
 * really runs there.
 *
 *   node tools/probe-deploy.mjs [url]
 *
 * `npm run test:browser` proves the game works on localhost, where the server
 * is ours and every path is where we left it.  A static host is a different
 * environment: the site lives in a subdirectory (so every path has to be
 * relative), the MIME type of a `.js` file is the host's business, and the
 * 69 MB video has to come down over the open internet.  None of that is covered
 * by a green local suite, so this checks the parts that only break once
 * deployed.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_UNDER_TEST = process.argv[2] || 'https://yhsome.github.io/TongTou/';
const CDP_PORT = 9355;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
].filter(Boolean);

let passed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? `  ??${detail}` : ''}`); return; }
  failures.push(`${name}${detail ? ` (${detail})` : ''}`);
  console.log(` FAIL  ${name}${detail ? `  ??${detail}` : ''}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []; this.failed = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
        return;
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      } else if (m.method === 'Network.loadingFailed') {
        this.failed.push(`${m.params.type || '?'} ${m.params.errorText}`);
      } else if (m.method === 'Network.responseReceived') {
        const r = m.params.response;
        if (r.status >= 400) this.failed.push(`HTTP ${r.status} ${r.url}`);
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
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)); }
      }, 120000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
    return r.result.value;
  }
}

async function main() {
  const browser = BROWSERS.find((b) => existsSync(b));
  if (!browser) throw new Error('no Chrome/Edge found');
  console.log(`deploy check: ${URL_UNDER_TEST}\n`);

  const profile = mkdtempSync(join(tmpdir(), 'tt-deploy-'));
  const proc = spawn(browser, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--mute-audio', '--hide-scrollbars', 'about:blank',
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
    await cdp.send('Network.enable');

    // Trusted input only: a synthetic KeyboardEvent carries no user activation,
    // so the AudioContext would never resume and the run would never start.
    const key = async (code, k, vk, text) => {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', code, key: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', code, key: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      });
      await sleep(350);
    };

    await cdp.send('Page.navigate', { url: URL_UNDER_TEST });
    let booted = false;
    for (let i = 0; i < 240; i++) {
      await sleep(250);
      try {
        if (await cdp.eval('!!window.TONGTOU && window.TONGTOU.state.mode !== "boot"')) { booted = true; break; }
      } catch { /* still loading */ }
    }
    ok('the deployed page boots past the boot screen', booted);
    if (!booted) {
      console.log('  (the page never reached the title screen; skipping the rest)');
    } else {
      const st = JSON.parse(await cdp.eval('JSON.stringify(window.TONGTOU.state)'));
      console.log(`  source: ${st.source}   mode: ${st.mode}`);
      ok('it loaded the shipped chart, not the in-browser fallback',
        st.source === 'file', `source=${st.source}`);

      const tiers = JSON.parse(await cdp.eval('JSON.stringify(window.TONGTOU.difficulties())'));
      ok('all three difficulty tiers came with it',
        tiers.join(',') === 'hard,expert,extra', tiers.join(','));

      // the video is the one asset big enough to expose a host's limits
      const ready = await cdp.eval(`(() => {
        const v = document.getElementById('bga');
        return JSON.stringify({ src: v.currentSrc || v.src, readyState: v.readyState,
          networkState: v.networkState, duration: v.duration || null });
      })()`);
      const v = JSON.parse(ready);
      console.log(`  bga: readyState=${v.readyState} networkState=${v.networkState} duration=${v.duration}`);
      ok('the video element found its source on the host', /^https?:/.test(v.src), v.src);
      ok('the video is actually fetching (not a 404)', v.networkState !== 3,
        `networkState=${v.networkState}`);

      // play a real run: audio, chart, judgement and rendering all at once
      await key('Enter', 'Enter', 13, '\r');
      await key('Enter', 'Enter', 13, '\r');
      await sleep(1200);
      const mode = await cdp.eval('window.TONGTOU.state.mode');
      ok('a run starts from the deployed page', mode === 'play', `mode=${mode}`);
      ok('the audio context resumes there too',
        (await cdp.eval('window.TONGTOU.audio.ctx.state')) === 'running',
        await cdp.eval('window.TONGTOU.audio.ctx.state'));

      await cdp.eval('window.TONGTOU.state.settings.autoPlay = true; true');
      await sleep(6000);
      const played = JSON.parse(await cdp.eval(`(() => {
        const e = window.TONGTOU.engine;
        return JSON.stringify({ t: +window.TONGTOU.audio.now().toFixed(2),
          judged: e.counts.perfect + e.counts.great + e.counts.good + e.counts.bad + e.counts.miss,
          combo: e.maxCombo, score: e.score });
      })()`));
      console.log(`  after 6 s: ${JSON.stringify(played)}`);
      ok('the song clock advances on the deployed site', played.t > 4, `${played.t} s`);
      ok('notes are being judged there', played.judged > 0, `${played.judged} judged`);

      const drew = await cdp.eval(`(() => {
        const cv = document.getElementById('view');
        const ctx = cv.getContext('2d');
        const d = ctx.getImageData(cv.width * 0.72 | 0, cv.height * 0.85 | 0, 8, 8).data;
        let opaque = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque++;
        return opaque;
      })()`);
      ok('the canvas is rendering there', drew > 0, `${drew}/64 opaque pixels`);
    }

    // A 404 on any sub-resource is exactly the failure mode a subdirectory host
    // produces (an absolute path that used to work at "/"), so surface them all.
    // The one expected miss is the optional track manifest: the game probes for
    // `src/manifest.json` and falls back to the built-in track when it is not
    // there, which is the documented single-track setup.
    const OPTIONAL = /\/manifest\.json$/;
    const bad = cdp.failed.filter((f) => !/favicon/i.test(f) && !OPTIONAL.test(f));
    const optionalMisses = cdp.failed.filter((f) => OPTIONAL.test(f));
    if (optionalMisses.length) console.log(`  (expected: optional manifest.json not present)`);
    ok('no sub-resource failed to load', bad.length === 0, bad.slice(0, 4).join(' | ') || 'none');
    ok('no console errors or exceptions', cdp.errors.length === 0,
      cdp.errors.slice(0, 3).join(' | ') || 'none');
  } finally {
    try { cdp?.ws.close(); } catch { /* ignore */ }
    proc.kill();
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

main().catch((e) => { console.error('deploy check crashed:', e); process.exit(2); });
