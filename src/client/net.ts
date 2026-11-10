// How the browser reaches the game rules. The client never calls step() itself: it sends
// intents over a Link and draws whatever World the Link hands back.
//  - LoopbackLink runs a GameHost in this tab (offline play, and the default). The frame loop
//    calls tick() every 600 ms, so pausing the tab pauses the game, as before.
//  - SocketLink talks to the game server (server/main.ts), which owns the clock. It keeps a
//    Mirror of this player's World and the players nearby, patched by each message.
import { GameHost } from '../net/host.ts';
import { PROTOCOL, WS_PATH, type Hello, type ServerMsg, type Update } from '../net/protocol.ts';
import { Mirror } from '../net/sync.ts';
import type { Intent, World } from '../sim/world.ts';

export type OnUpdate = (u: Update) => void;

export interface Link {
  readonly online: boolean;
  send(it: Intent): void;
  close(): void;
}

export class LoopbackLink implements Link {
  readonly online = false;
  private readonly host: GameHost;
  private readonly onUpdate: OnUpdate;
  constructor(world: World, onUpdate: OnUpdate) {
    this.host = new GameHost(world);
    this.onUpdate = onUpdate;
  }
  send(it: Intent): void {
    const ev = this.host.submit(it);
    if (ev) this.onUpdate({ kind: 'act', world: this.host.world, ev, others: [] });
  }
  /** Advance one 0.6 s step; the caller owns the clock. */
  tick(): void { this.onUpdate({ kind: 'tick', world: this.host.world, ev: this.host.tick(), others: [] }); }
  close(): void {}
}

export class SocketLink implements Link {
  readonly online = true;
  private readonly ws: WebSocket;
  /** Called once if the connection drops after the game started. */
  onLost: () => void = () => {};
  private constructor(ws: WebSocket) { this.ws = ws; }

  /** Connect, say hello, and resolve once the server's welcome arrives. */
  static connect(url: string, hello: Omit<Hello, 't' | 'v'>, onUpdate: OnUpdate, timeoutMs = 4000): Promise<{ link: SocketLink; welcome: Update }> {
    return new Promise((ok, fail) => {
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch (e) { fail(e); return; }
      const link = new SocketLink(ws);
      let started = false, mirror: Mirror | null = null;
      const timer = setTimeout(() => { if (!started) { ws.close(); fail(new Error('timed out')); } }, timeoutMs);
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL, ...hello }));
      ws.onmessage = e => {
        let m: ServerMsg;
        try { m = JSON.parse(String(e.data)) as ServerMsg; } catch { return; }
        if (m.t === 'error') { console.warn(`game server: ${m.msg}`); return; }
        if (m.t === 'welcome') {
          if (started) return;
          mirror = new Mirror(m);
          started = true; clearTimeout(timer);
          ok({ link, welcome: { kind: 'welcome', world: mirror.world, ev: [], others: mirror.list() } });
          return;
        }
        if (!started || !mirror) return;
        let u: Update;
        // A patch that doesn't fit means this copy has drifted; drop the link and carry on offline.
        try { u = mirror.apply(m); } catch (e) { console.warn('game server: bad patch', e); ws.close(); return; }
        onUpdate(u);
      };
      const lost = () => {
        clearTimeout(timer);
        if (!started) { fail(new Error('could not reach the game server')); return; }
        started = false;
        link.onLost();
      };
      ws.onclose = lost;
      ws.onerror = () => ws.close();
    });
  }

  send(it: Intent): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'intent', it }));
  }
  close(): void { this.ws.onclose = null; this.ws.close(); }
}

/**
 * The server to play through, from the page URL: `?server` means this page's own host,
 * `?server=host:port` or `?server=ws://…` names one. No parameter means play offline.
 */
export function serverUrl(loc: { search: string; host: string; protocol: string }): string | null {
  const p = new URLSearchParams(loc.search);
  if (!p.has('server')) return null;
  const v = p.get('server') ?? '';
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws';
  if (!v) return `${scheme}://${loc.host}${WS_PATH}`;
  if (/^wss?:\/\//.test(v)) return v;
  return `${scheme}://${v}${WS_PATH}`;
}
