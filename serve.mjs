import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
import { fileURLToPath } from 'url';

const PORT = 3000;
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.webp': 'image/webp',
  '.sql':  'text/plain',
};

createServer(async (req, res) => {
  const raw = decodeURIComponent(req.url.split('?')[0]);
  const path = raw === '/' ? '/index.html' : raw;
  const file = join(ROOT, path);
  try {
    const data = await readFile(file);
    const ct = MIME[extname(file)] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': ct,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    try {
      const errPage = await readFile(join(ROOT, 'error.html'));
      res.writeHead(404, {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
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
