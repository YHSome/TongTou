#!/usr/bin/env node
/**
 * Boot timing probe.
 *
 * Runs the page WITHOUT --autoplay-policy=no-user-gesture-required so the
 * AudioContext starts suspended, exactly as it does in a real browser.  Prints
 * a timeline of the boot screen's status text and where it stalls.
 *
 *   node tools/diagnose-boot.mjs --no-autoplay
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 8128;
const CDP_PORT = 9338;
const NO_AUTOPLAY = process.argv.includes('--no-autoplay');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
].filter(Boolean);

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
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

async function main() {
  const browser = BROWSERS.find((b) => existsSync(b));
  const profile = mkdtempSync(join(tmpdir(), 'tt-boot-'));
  const server = spawn(process.execPath, [join(ROOT, 'serve.mjs'), String(PORT), '--strict'], { cwd: ROOT, stdio: 'ignore' });
  await sleep(700);

  const args = [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--mute-audio',
    'about:blank',
  ];
  if (!NO_AUTOPLAY) args.splice(4, 0, '--autoplay-policy=no-user-gesture-required');

  console.log(`autoplay override : ${NO_AUTOPLAY ? 'OFF  (real-browser behaviour)' : 'ON'}`);
  console.log(`url               : http://127.0.0.1:${PORT}/\n`);

  const proc = spawn(browser, args, { stdio: 'ignore' });
  let cdp;
  let ok = false;
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
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });

    let last = '';
    const t0 = Date.now();
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const note = await cdp.eval('document.getElementById("boot-note")?.textContent ?? "?"');
      const ctxState = await cdp.eval('window.TONGTOU?.audio?.ctx?.state ?? "(no ctx)"');
      const mode = await cdp.eval('window.TONGTOU?.state?.mode ?? "boot"');
      const line = `  t=${((Date.now() - t0) / 1000).toFixed(1)}s  note=${JSON.stringify(note)}  ctx=${ctxState}  mode=${mode}`;
      if (line.split('note=')[1] !== last.split('note=')[1]) console.log(line);
      last = line;
      if (mode === 'title' || mode === 'result') { ok = true; break; }
      if (note && note.includes('???')) break;
    }

    const finalMode = await cdp.eval('window.TONGTOU?.state?.mode ?? "boot"');
    const note = await cdp.eval('document.getElementById("boot-note")?.textContent');
    console.log(`\n  final: mode=${finalMode} note=${JSON.stringify(note)}`);

    // ---- trusted input: does the audio device actually start? ------------
    // CDP Input events are trusted, so they grant user activation; a synthetic
    // KeyboardEvent dispatched from Runtime.evaluate does NOT, which is why the
    // earlier smoke test could not have caught the suspended-context hang.
    if (finalMode === 'title') {
      const press = async (code, key, vk, text) => {
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown', code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text,
        });
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp', code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        });
        await sleep(250);
      };

      await press('Enter', 'Enter', 13, '\r');     // title -> select
      await press('Enter', 'Enter', 13, '\r');     // select -> play
      await sleep(700);

      const ctxState = await cdp.eval('window.TONGTOU.audio.ctx.state');
      const mode = await cdp.eval('window.TONGTOU.state.mode');
      const t1 = await cdp.eval('window.TONGTOU.audio.now()');
      await sleep(1200);
      const t2 = await cdp.eval('window.TONGTOU.audio.now()');
      const decodeMs = await cdp.eval('window.TONGTOU.audio.decodeMs');
      const dur = await cdp.eval('window.TONGTOU.audio.duration');

      console.log(`  decode took       : ${decodeMs} ms for ${dur?.toFixed?.(2)}s of audio`);
      console.log(`  mode after Enter  : ${mode}`);
      console.log(`  ctx.state         : ${ctxState}`);
      console.log(`  clock advanced    : ${(t2 - t1).toFixed(3)}s over 1.2s wall`);

      const playing = mode === 'play' && ctxState === 'running' && (t2 - t1) > 0.9;
      console.log(`\n${'-'.repeat(58)}`);
      console.log(playing ? 'PASS  trusted gesture starts audio and the clock runs'
        : 'FAIL  audio did not start after a real gesture');
      process.exitCode = playing ? 0 : 1;
      return;
    }

    if (cdp.errors.length) {
      console.log('  errors:');
      for (const e of cdp.errors.slice(0, 6)) console.log(`    ${e}`);
    }
    console.log(`\n${'-'.repeat(58)}`);
    console.log(ok ? 'PASS  boot completed without a user gesture' : 'FAIL  boot stalled');
    process.exitCode = ok ? 0 : 1;
  } finally {
    try { cdp?.ws.close(); } catch { /* ignore */ }
    proc.kill();
    server.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
