// Tiny static server for local play: node scripts/serve.mjs [port]
// It also answers /api/world with the same function Vercel runs (api/world.ts), with presence
// kept in memory, so two local tabs share the world as they do on the deployed site.
// Pass --static to serve only files (then the page plays offline).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const args = process.argv.slice(2);
const port = Number(args.find(a => /^\d+$/.test(a)) ?? 8080);
const api = args.includes('--static') ? null : await import('../api/world.ts');
const root = process.cwd();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

async function callApi(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://localhost${req.url}`, { method: req.method, headers: { 'content-type': req.headers['content-type'] ?? '' }, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined });
  const out = await api.default(request);
  res.writeHead(out.status, Object.fromEntries(out.headers)).end(await out.text());
}

createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (api && url === '/api/world') { await callApi(req, res); return; }
  const path = normalize(join(root, url === '/' ? 'index.html' : url));
  if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch { res.writeHead(404).end('not found'); }
}).listen(port, () => console.log(`Temasek 1360 on http://localhost:${port}${api ? ' (shared world on /api/world)' : ''}`));
