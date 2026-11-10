// The game server: serves the built page and runs one shared Realm on a 600 ms clock. Every
// connection is a player in it; each is sent only its own World's changes and the players
// near it (src/net/sync.ts). Binds to 127.0.0.1 by default: it is for local play and tests.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { TICK_MS } from '../src/sim/core.ts';
import { load, newWorld, type Ev } from '../src/sim/world.ts';
import { Realm } from '../src/net/realm.ts';
import { Outbox } from '../src/net/sync.ts';
import { MAX_MESSAGE_BYTES, WS_PATH, parseClientMsg, type ServerMsg } from '../src/net/protocol.ts';
import { accept, type WsConn } from './ws.ts';

export type ServerOpts = {
  port?: number;
  host?: string;
  tickMs?: number;
  /** Folder to serve the page from (index.html, dist/, styles.css). Omit to serve only the socket. */
  staticRoot?: string;
  /** Seeds for new worlds; defaults to Math.random. Tests pass a fixed one. */
  seed?: () => number;
  log?: (line: string) => void;
};

export type GameServer = { port: number; sessions: () => number; realm: Realm; close: () => Promise<void> };

/** Malformed messages a client may send before it is disconnected. */
const MAX_BAD_MESSAGES = 20;

type Session = { conn: WsConn; out: Outbox | null; bad: number };

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png'
};

export function startGameServer(opts: ServerOpts = {}): Promise<GameServer> {
  const tickMs = opts.tickMs ?? TICK_MS;
  const seed = opts.seed ?? (() => Math.floor(Math.random() * 1e9));
  const log = opts.log ?? (() => {});
  const sessions = new Set<Session>();
  const realm = new Realm();

  const send = (s: Session, msg: ServerMsg) => s.conn.send(JSON.stringify(msg));

  function onMessage(s: Session, text: string): void {
    const msg = parseClientMsg(text);
    if (!msg) {
      if (++s.bad > MAX_BAD_MESSAGES) s.conn.close(1008);
      else send(s, { t: 'error', msg: 'bad message' });
      return;
    }
    if (msg.t === 'hello') {
      if (s.out) { send(s, { t: 'error', msg: 'already started' }); return; }
      // No accounts yet (roadmap step 3), so the client brings its own save.
      const world = (msg.save ? load(msg.save) : null) ?? newWorld(msg.seed ?? seed());
      const id = realm.join(world);
      if (id === null) { send(s, { t: 'error', msg: 'server full' }); s.conn.close(1013); return; }
      s.out = new Outbox(realm, id);
      send(s, s.out.welcome());
      return;
    }
    if (!s.out) { send(s, { t: 'error', msg: 'send hello first' }); return; }
    let ev: Ev[] | null;
    try { ev = realm.submit(s.out.id, msg.it); } catch (e) { fail(s, e); return; }
    // Every intent gets an answer, so a client waiting on one never hangs.
    if (ev) send(s, s.out.update('act', ev));
    else send(s, { t: 'error', msg: 'too many intents' });
  }

  function fail(s: Session, e: unknown): void {
    log(`session dropped after a sim error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    if (s.out) realm.leave(s.out.id);
    send(s, { t: 'error', msg: 'server error' });
    s.conn.close(1011);
  }

  const timer = setInterval(() => {
    // Everyone steps first, then everyone is told, so each client sees the others as of this tick.
    const byId = new Map<number, Session>();
    for (const s of sessions) if (s.out) byId.set(s.out.id, s);
    const evs = realm.tick((id, e) => { const s = byId.get(id); if (s) fail(s, e); });
    for (const [id, ev] of evs) {
      const s = byId.get(id);
      if (s?.out && s.conn.open) send(s, s.out.update('tick', ev));
    }
  }, tickMs);

  const root = opts.staticRoot ? resolve(opts.staticRoot) : null;
  async function serveFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!root || req.method !== 'GET') { res.writeHead(404).end('not found'); return; }
    let url: string;
    try { url = decodeURIComponent((req.url ?? '/').split('?')[0]); } catch { res.writeHead(400).end(); return; }
    const path = normalize(join(root, url === '/' ? 'index.html' : url));
    if (path !== root && !path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
    } catch { res.writeHead(404).end('not found'); }
  }

  const http = createServer((req, res) => { void serveFile(req, res); });
  http.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== WS_PATH) { socket.destroy(); return; }
    const conn = accept(req, socket, head, MAX_MESSAGE_BYTES);
    if (!conn) return;
    const s: Session = { conn, out: null, bad: 0 };
    sessions.add(s);
    conn.onMessage = text => onMessage(s, text);
    conn.onClose = () => { sessions.delete(s); if (s.out) realm.leave(s.out.id); };
  });

  return new Promise((ok, fail) => {
    http.on('error', fail);
    http.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      const addr = http.address();
      ok({
        port: typeof addr === 'object' && addr ? addr.port : 0,
        sessions: () => sessions.size,
        realm,
        close: () => new Promise<void>(done => {
          clearInterval(timer);
          for (const s of sessions) s.conn.close(1001);
          http.close(() => done());
          http.closeAllConnections();
        })
      });
    });
  });
}
