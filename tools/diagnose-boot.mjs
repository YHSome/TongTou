#!/usr/bin/env node
/**
 * Reproduce the "stuck on loading" report by opening the page the two ways a
 * user might, and reporting what the boot screen actually says.
 *
 *   node tools/diagnose-boot.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 8125;
const CDP_PORT = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
].filter(Boolean);

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      } else if (m.method === 'Log.entryAdded') {
        this.logs.push(`[${m.params.entry.level}] ${m.params.entry.text}`);
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.logs.push(`[exception] ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
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
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return `<threw: ${r.exceptionDetails.exception?.description}>`;
    return r.result.value;
  }
}

async function probe(cdp, url, label, waitMs) {
  cdp.logs.length = 0;
  await cdp.send('Page.navigate', { url });
  await sleep(waitMs);
  const note = await cdp.eval('document.getElementById("boot-note")?.textContent ?? "(no #boot-note)"');
  const hasApp = await cdp.eval('typeof window.TONGTOU');
  const bootActive = await cdp.eval('document.getElementById("boot")?.classList.contains("is-active")');
  const mode = await cdp.eval('window.TONGTOU?.state?.mode ?? null');
  const helpShown = await cdp.eval('(() => { const h = document.getElementById("boot-help"); return h ? !h.hidden : null; })()');
  const helpCmds = await cdp.eval('[...document.querySelectorAll("#boot-help [data-copy]")].map(b => b.getAttribute("data-copy"))');

  console.log(`\n=== ${label} ===`);
  console.log(`  url          : ${url}`);
  console.log(`  window.TONGTOU: ${hasApp}`);
  console.log(`  mode         : ${mode}`);
  console.log(`  boot screen visible : ${bootActive}`);
  console.log(`  boot-note    : ${JSON.stringify(note)}`);
  console.log(`  help panel shown    : ${helpShown}`);
  if (helpShown) console.log(`  help commands: ${JSON.stringify(helpCmds)}`);
  if (cdp.logs.length) {
    console.log('  console/log output:');
    for (const l of cdp.logs.slice(0, 12)) console.log(`    ${l}`);
  } else {
    console.log('  console/log output: (none)');
  }
  return { note, hasApp, mode, bootActive, helpShown, helpCmds };
}

async function main() {
  const browser = BROWSERS.find((b) => existsSync(b));
  const profile = mkdtempSync(join(tmpdir(), 'tt-diag-'));
  const server = spawn(process.execPath, [join(ROOT, 'serve.mjs'), String(PORT), '--strict'], { cwd: ROOT, stdio: 'ignore' });
  await sleep(700);

  const proc = spawn(browser, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio',
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
    await cdp.send('Log.enable');

    const fileUrl = 'file:///' + join(ROOT, 'index.html').replace(/\\/g, '/');
    const fileState = await probe(cdp, fileUrl, 'file:// (what a double-click does)', 6000);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const out = join(ROOT, 'tools', 'shots', 'file-protocol-help.png');
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`  saved ${out}`);

    await probe(cdp, `http://127.0.0.1:${PORT}/`, 'http:// via serve.mjs', 9000);

    // ---- verdict ---------------------------------------------------------
    const ok = fileState.helpShown === true && fileState.helpCmds?.length >= 2;
    console.log(`\n${'-'.repeat(58)}`);
    console.log(ok
      ? 'PASS  file:// shows an actionable notice instead of hanging'
      : 'FAIL  file:// still hangs silently');
    process.exitCode = ok ? 0 : 1;
  } finally {
    try { cdp?.ws.close(); } catch { /* ignore */ }
    proc.kill();
    server.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
