#!/usr/bin/env node
/**
 * Minimal static server for TONGTOU 4K.
 *
 *   node serve.mjs            -> http://127.0.0.1:8080
 *   node serve.mjs 3000       -> http://127.0.0.1:3000
 *
 * A server is required: `fetch()`, `decodeAudioData()` and <video> seeking all
 * refuse to read local files over `file://`.
 *
 * Byte ranges are supported so the browser can seek inside the audio without
 * pulling the whole file down again.
 */

import { createServer, get as httpGet } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const OPEN = argv.includes('--open') || argv.includes('-o');
/**
 * `--strict` disables every fallback: the requested port must be free or the
 * process exits.  The test harnesses use it so they can never silently attach
 * to a different port than the one they are about to request.
 */
const STRICT = argv.includes('--strict');
const PORT = Number(argv.find((a) => /^\d+$/.test(a)) || process.env.PORT || 8080);

/**
 * Identity used to recover from a port that is already taken.
 *
 * Starting this script twice is easy to do (double-clicking start.cmd again, or
 * forgetting a previous window), and the second copy used to die with a bare
 * `EADDRINUSE`.  Instead the marker lets a new instance tell three cases apart:
 * nothing there, *our own* server for *this* directory, or a stranger.
 */
const APP_ID = 'tongtou-4k';
const APP_VERSION = 1;
const MARKER_PATH = '/__tongtou';
const PORT_ATTEMPTS = 20;

const MARKER = {
  app: APP_ID,
  version: APP_VERSION,
  root: ROOT,
  pid: process.pid,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function safeJoin(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const p = normalize(decoded).replace(/^([/\\])+/, '');
  const full = join(ROOT, p);
  // never escape the project root
  if (!full.startsWith(ROOT)) return null;
  return full;
}

function handleRequest(req, res) {
  const path = (req.url || '/').split('?')[0].split('#')[0];

  // identity probe — also lets a second instance detect this one
  if (path === MARKER_PATH) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ...MARKER, port: activePort }));
    return;
  }

  let target = safeJoin(req.url || '/');
  if (!target) {
    res.writeHead(403, { 'x-tongtou': APP_ID }).end('forbidden');
    return;
  }

  let stat;
  try {
    stat = statSync(target);
    if (stat.isDirectory()) {
      target = join(target, 'index.html');
      stat = statSync(target);
    }
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-tongtou': APP_ID })
      .end('404 not found');
    return;
  }

  const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
  const total = stat.size;
  const range = req.headers.range;

  // range requests keep video seeking smooth
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : total - 1;
      if (start >= total || end >= total || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${total}` }).end();
        return;
      }
      res.writeHead(206, {
        'content-type': type,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${total}`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-cache',
        'x-tongtou': APP_ID,
      });
      createReadStream(target, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': total,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
    'x-tongtou': APP_ID,
  });

  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(target).pipe(res);
}

/**
 * One-shot HTTP GET with no connection pooling.
 *
 * `agent: false` matters here: a pooled keep-alive socket would keep the event
 * loop alive and, on Windows, `process.exit()` racing that teardown trips a
 * libuv assertion (`UV_HANDLE_CLOSING`).  Every request here is fire-and-forget.
 */
function httpGetText(port, path, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = httpGet({ host: '127.0.0.1', port, path, agent: false, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 400000) { req.destroy(); resolve(null); }   // guard
      });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** Launch the default browser without leaving a child handle behind. */
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
  try {
    const child = spawn(cmd, { shell: true, detached: true, stdio: 'ignore' });
    child.unref();
  } catch { /* best effort — the URL is printed either way */ }
}

/**
 * Ask a port what is answering there.
 *
 * Returns one of:
 *   { kind: 'ours',  owner }   this project, current build (has the marker)
 *   { kind: 'legacy' }         this project, but an older server process
 *   { kind: 'other' }          responding, but not us
 *   null                       nothing listening / not HTTP
 */
async function probe(port) {
  const marker = await httpGetText(port, MARKER_PATH).catch(() => null);
  if (marker) {
    try {
      const data = JSON.parse(marker);
      if (data && data.app === APP_ID) return { kind: 'ours', owner: data };
    } catch { /* not our marker */ }
  }

  const html = await httpGetText(port, '/').catch(() => null);
  if (typeof html === 'string' && html.includes('TONGTOU')) return { kind: 'legacy' };
  if (typeof html === 'string') return { kind: 'other' };
  return null;
}

/** Resolve with the listening server, or reject with the original error. */
function tryListen(port) {
  return new Promise((resolve, reject) => {
    const s = createServer(handleRequest);
    const onError = (err) => {
      s.removeListener('listening', onListening);
      s.close(() => {});
      reject(err);
    };
    const onListening = () => {
      s.removeListener('error', onError);
      resolve(s);
    };
    s.once('error', onError);
    s.once('listening', onListening);
    s.listen(port, '127.0.0.1');
  });
}

async function bind(startPort) {
  for (let port = startPort; port < startPort + PORT_ATTEMPTS; port++) {
    const found = await probe(port);
    if (found) {
      if (STRICT) throw Object.assign(new Error(`port ${port} is already in use`), { code: 'EADDRINUSE' });

      // A live server for this project wins.  Even without the marker we reuse
      // it: this script reads every file from disk per request, so an older
      // *server process* still serves the newest *content*.
      if (found.kind === 'ours' && found.owner.root === ROOT) {
        return { reused: true, port, owner: found.owner, legacy: false };
      }
      if (found.kind === 'ours') continue;        // our app, different directory
      if (found.kind === 'legacy') {
        return { reused: true, port, owner: null, legacy: true };
      }
      continue;                                   // somebody else's app
    }
    try {
      const s = await tryListen(port);
      return { server: s, port };
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        if (STRICT) throw err;
        continue;                                // lost a race, try the next
      }
      throw err;
    }
  }
  throw new Error(`${startPort} 起的连续 ${PORT_ATTEMPTS} 个端口都被占用`);
}

/* ------------------------------------------------------------------------ */
/* start                                                                     */
/* ------------------------------------------------------------------------ */

/** Port this process ends up serving on (reported by the marker endpoint). */
let activePort = PORT;

const result = await bind(PORT).catch((err) => {
  console.error('');
  console.error(`  无法启动本地服务器：${err.message}`);
  console.error('');
  process.exit(1);
});

if (result.reused) {
  const url = `http://127.0.0.1:${result.port}/`;
  console.log('');
  console.log(`  TONGTOU 4K 已经在运行（端口 ${result.port}）`);
  console.log('');
  console.log(`  ->  ${url}`);
  console.log('');
  if (result.owner) console.log(`  pid : ${result.owner.pid}`);
  console.log('');
  if (result.legacy) {
    console.log('  这个进程是较早版本启动的（没有身份标识），但它每次请求都从磁盘读取文件，');
    console.log('  所以它提供的就是当前代码 —— 直接使用上面的地址即可。');
    console.log('');
  }
  console.log('  重复运行本脚本不会再报 EADDRINUSE。');
  console.log(`  要停掉旧进程：  netstat -ano | findstr :${result.port}`);
  console.log('');
  if (OPEN) openBrowser(url);
  // the existing process is already serving; this one has nothing to do
  process.exit(0);
}

activePort = result.port;
const url = `http://127.0.0.1:${activePort}/`;

result.server.on('error', (err) => {
  console.error('server error:', err.message);
  process.exit(1);
});

// ASCII only in the banner: a non-UTF8 Windows console codepage mangles arrows
console.log('');
console.log(`  TONGTOU 4K  ->  ${url}`);
if (activePort !== PORT) {
  console.log(`  (端口 ${PORT} 被占用，已自动改用 ${activePort})`);
}
console.log('');
console.log(`  root: ${ROOT}`);
console.log('  ctrl+c to stop');
console.log('');

if (OPEN) openBrowser(url);

