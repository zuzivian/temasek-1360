// Tiny static server for local play: node scripts/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const port = Number(process.argv[2] ?? 8080);
const root = process.cwd();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const path = normalize(join(root, url === '/' ? 'index.html' : url));
  if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch { res.writeHead(404).end('not found'); }
}).listen(port, () => console.log(`Temasek 1360 on http://localhost:${port}`));
