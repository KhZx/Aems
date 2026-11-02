import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const PORT = process.env.PORT || 3000;
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const ROOT_PREFIX = ROOT.endsWith(sep) ? ROOT : ROOT + sep;

/** Resolve a URL path inside ROOT and reject traversal outside it. */
function resolveInside(pathname) {
  const full = resolve(ROOT, `.${pathname}`);
  if (!full.startsWith(ROOT_PREFIX)) throw new Error('Forbidden path');
  return full;
}

// Resolve extension-less paths: /login → /login.html, /admin → /admin.html
async function resolveFile(path) {
  const file = resolveInside(path);
  if (!extname(path)) {
    try {
      await readFile(file);
      return file;
    } catch {
      return resolveInside(path + '.html');
    }
  }
  return file;
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.webp': 'image/webp',
  '.sql':  'text/plain',
};

createServer(async (req, res) => {
  let raw;
  try {
    raw = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }
  const path = raw === '/' ? '/index.html' : raw;
  let file;
  try {
    file = await resolveFile(path);
  } catch {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    const ct = MIME[extname(file)] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': ct,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    try {
      const errPage = await readFile(join(ROOT, 'error.html'));
      res.writeHead(404, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(errPage);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>404 — Not Found</h1><p>${path}</p>`);
    }
  }
}).on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`⚡ Port ${PORT} already in use — server is already running at http://localhost:${PORT}`);
    process.exit(0);
  } else {
    throw err;
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`🚑 AEMS dev server → http://localhost:${PORT}`);
});
