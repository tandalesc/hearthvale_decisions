// Production server: serves the vite build from dist/ and mounts the same
// narrator/decisions middleware the dev server uses, without vite.
//
//   node server/serve.js         # PORT=3001 HOST=0.0.0.0 by default
//
// local.env is read from the project root by system1.js's loader, exactly as
// in dev. No dependencies beyond Node itself.

import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {join, extname, normalize, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createGzip} from 'node:zlib';
import {system1Plugin} from './system1.js';
import {narratorPlugin} from './narrator.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '0.0.0.0';

// The plugins are connect-style: reuse their attach functions with a tiny shim.
const stack = [];
const shim = {middlewares: {use(fn) { stack.push(fn); }}};
for (const plugin of [system1Plugin(), narratorPlugin()]) {
  plugin.configResolved({root});
  await plugin.configureServer(shim); // system1 also blocks local.env/.env paths for every request
}
function runApiMiddleware(req, res, fallThrough) {
  let i = 0;
  const next = () => { const fn = stack[i++]; if (fn) fn(req, res, next); else fallThrough(); };
  next();
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg', '.map']);

async function serveStatic(req, res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.statusCode = 400; return res.end('Invalid path'); }
  const file = normalize(join(dist, pathname));
  if (file !== dist && !file.startsWith(dist + sep)) { res.statusCode = 403; return res.end('Forbidden'); }

  let target = file;
  let info = await stat(target).catch(() => null);
  if (info?.isDirectory()) { target = join(target, 'index.html'); info = await stat(target).catch(() => null); }
  if (!info) { // unknown paths get the app shell
    target = join(dist, 'index.html');
    info = await stat(target).catch(() => null);
    if (!info) { res.statusCode = 404; return res.end('Not found'); }
  }

  const type = TYPES[extname(target).toLowerCase()] || 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Built assets are content-hashed; everything else must revalidate.
  res.setHeader('Cache-Control', target.startsWith(join(dist, 'assets') + sep)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache');

  const wantsGzip = COMPRESSIBLE.has(extname(target).toLowerCase())
    && info.size > 1024
    && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  res.statusCode = 200;
  if (req.method === 'HEAD') return res.end();
  if (wantsGzip) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    createReadStream(target).pipe(createGzip({level: 6})).pipe(res);
  } else {
    res.setHeader('Content-Length', info.size);
    createReadStream(target).pipe(res);
  }
}

createServer((req, res) => {
  if (!['GET', 'HEAD', 'POST'].includes(req.method)) { res.statusCode = 405; return res.end(); }
  runApiMiddleware(req, res, () => serveStatic(req, res).catch(() => { if (!res.headersSent) res.statusCode = 500; res.end(); }));
}).listen(port, host, () => console.log(`hearthvale: http://${host}:${port}/`));
