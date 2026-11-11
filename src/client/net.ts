// How the browser reaches the game rules. The client never calls step() itself: it sends
// intents over a Link and draws whatever World the Link hands back.
//  - LoopbackLink runs a GameHost in this tab (offline play, and the default). The frame loop
//    calls tick() every 600 ms, so pausing the tab pauses the game, as before.
//  - LiveLink is the shared world on a static host plus one serverless function (api/world.ts,
//    the default on the deployed site). The rules still run in this tab, but on the realm clock
//    that every tab shares (net/clock.ts), and while the tab is visible and in use it posts where
//    the player is and gets back who is nearby (net/presence.ts). Hidden or idle, it sends nothing.
//  - SocketLink talks to the game server (server/main.ts), which owns the clock. It keeps a
//    Mirror of this player's World and the players nearby, patched by each message.
import { offsetFrom, realmTick } from '../net/clock.ts';
import { GameHost } from '../net/host.ts';
import { avatarOf, HEARTBEAT_MS, IDLE_MS, PRESENCE_PATH, MAX_PATH, POLL_ALONE_MS, POLL_NEAR_MS, type Pose, type PresenceRes, type Seen } from '../net/presence.ts';
import { PROTOCOL, WS_PATH, type Hello, type ServerMsg, type Update } from '../net/protocol.ts';
import { Mirror } from '../net/sync.ts';
import { setClock, type Ev, type Intent, type World } from '../sim/world.ts';

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

type Http = (url: string, init?: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export type LiveOpts = {
  /** The presence function's URL (PRESENCE_PATH on the page's own host). */
  url: string;
  fetch: Http;
  /** Wall-clock ms; Date.now in the browser. Tests pass a fake. */
  now?: () => number;
  /** Fire-and-forget send for leaving as the tab closes (navigator.sendBeacon). */
  beacon?: (url: string, body: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /** Ticks to catch up by simulating; a longer gap (a hidden tab) jumps the clock instead. */
  maxCatchUp?: number;
};

/** A random 128-bit hex token: this tab's secret, which the function turns into a public id. */
export function newToken(): string {
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** What the presence function is told about this player at the World's current tick. */
export function poseOf(w: World): Pose {
  const p = w.player, pose: Pose = { x: p.x, y: p.y, facing: p.facing, tick: w.tick };
  if (p.path.length) pose.path = p.path.slice(0, MAX_PATH).map(s => ({ x: s.x, y: s.y }));
  if (p.fishing && p.task?.t === 'fish') pose.fishing = p.task.spot;
  if (w.combat) pose.fighting = true;
  return pose;
}

export class LiveLink implements Link {
  readonly online = true;
  readonly host: GameHost;
  /** Server clock minus this machine's, in ms. */
  offsetMs: number;
  /** Players near us as last reported, played forward on the realm clock. */
  seen: Seen[] = [];
  /** Our public id, once the function has told us. */
  you: number | null = null;
  /**
   * True while posting: the tab is visible and was used in the last IDLE_MS. Otherwise the tab is
   * away: it stays in the world (others see it dimmed) on a tiny heartbeat every HEARTBEAT_MS.
   */
  active = false;
  /** Posts (pose + who's near) and heartbeats sent so far (for tests and the cost notes). */
  posts = 0;
  beats = 0;
  private readonly onUpdate: OnUpdate;
  private readonly o: Required<Omit<LiveOpts, 'beacon'>> & Pick<LiveOpts, 'beacon'>;
  private readonly token = newToken();
  private timer: unknown = null;
  private visible = true;
  private lastInput: number;
  private inflight = false;
  private failures = 0;
  private pending: Ev[] = [];
  private closed = false;
  /** A post has gone out since we last left, so the function may hold a record of us. */
  private joined = false;

  constructor(world: World, onUpdate: OnUpdate, offsetMs: number, opts: LiveOpts) {
    this.o = {
      now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: h => clearTimeout(h as number), maxCatchUp: 5, ...opts
    };
    this.host = new GameHost(world);
    this.onUpdate = onUpdate;
    this.offsetMs = offsetMs;
    this.lastInput = this.o.now();
    // Join the realm clock: a save (or a new game at tick 0) moves onto the shared tick.
    this.pending = setClock(world, this.realmTick());
  }

  /** Find the realm clock (one GET), or fail if there is no presence function here. */
  static async connect(world: World, onUpdate: OnUpdate, opts: LiveOpts, timeoutMs = 4000): Promise<LiveLink> {
    const now = opts.now ?? (() => Date.now());
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const sent = now();
      const res = await opts.fetch(opts.url, { method: 'GET', signal: ctl.signal });
      if (!res.ok) throw new Error(`presence: HTTP ${res.status}`);
      const body = await res.json() as PresenceRes;
      if (typeof body?.now !== 'number') throw new Error('presence: not a realm clock');
      const link = new LiveLink(world, onUpdate, offsetFrom(body.now, sent, now()), opts);
      link.setVisible(true);
      return link;
    } finally { clearTimeout(t); }
  }

  get world(): World { return this.host.world; }
  realmTick(): number { return realmTick(this.o.now() + this.offsetMs); }
  others(): ReturnType<typeof avatarOf>[] { return this.seen.map(s => avatarOf(s, this.world.tick)); }

  send(it: Intent): void {
    this.touch();
    const ev = this.host.submit(it);
    if (ev) this.onUpdate({ kind: 'act', world: this.world, ev, others: this.others() });
  }

  /** Run the World up to the realm's tick. Called every frame; returns how many ticks ran. */
  pump(): number {
    const target = this.realmTick();
    let gap = target - this.world.tick, n = 0;
    if (gap <= 0) return 0;
    // Back from a hidden tab (or a stalled one): jump the clock rather than replay minutes of ticks.
    if (gap > this.o.maxCatchUp) { this.pending.push(...setClock(this.world, target - 1)); gap = 1; }
    // In a fight, one tick per frame, so every telegraphed attack is drawn before it lands.
    const limit = this.world.combat ? 1 : gap;
    while (n < limit) {
      const ev = [...this.pending, ...this.host.tick()];
      this.pending = [];
      n++;
      this.onUpdate({ kind: 'tick', world: this.world, ev, others: this.others() });
    }
    return n;
  }

  /** Any input from the player: wakes an idle tab. */
  touch(): void {
    this.lastInput = this.o.now();
    this.refresh();
  }
  /** Coming back to the tab counts as being here: it rejoins (and resyncs) at once. */
  setVisible(v: boolean): void {
    if (v && !this.visible) this.lastInput = this.o.now();
    this.visible = v; this.refresh();
  }

  /** Switch between posting (visible and in use) and away (heartbeats only) as things change. */
  private refresh(): void {
    if (this.closed) return;
    const want = this.visible && this.o.now() - this.lastInput < IDLE_MS;
    if (want === this.active) return;
    this.active = want;
    if (this.timer !== null) { this.o.clearTimer(this.timer); this.timer = null; }
    // Back: resync at once (who's here, the clock); pump() catches the World up on the next frame.
    if (want) { this.failures = 0; void this.post(); return; }
    this.seen = [];
    this.beat(true);
  }

  /** Tell the function we're still here, as away, and schedule the next one. Nothing is read back. */
  private beat(first = false): void {
    if (this.closed || this.active) return;
    if (this.joined) {
      this.beats++;
      const body = JSON.stringify({ token: this.token, beat: true, pose: poseOf(this.world) });
      // The first one goes as a beacon: a tab being hidden may be frozen before a fetch finishes.
      if (first && this.o.beacon) this.o.beacon(this.o.url, body);
      else void this.o.fetch(this.o.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => {});
    }
    this.timer = this.o.setTimer(() => { this.timer = null; this.beat(); }, HEARTBEAT_MS);
  }

  /** Leave the world at once (the page is closing). */
  private leave(): void {
    if (!this.joined) return;
    this.joined = false;
    const body = JSON.stringify({ token: this.token, leave: true });
    if (this.o.beacon) this.o.beacon(this.o.url, body);
    else void this.o.fetch(this.o.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => {});
    this.you = null;
  }

  private schedule(ms: number): void {
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = this.o.setTimer(() => { this.timer = null; void this.post(); }, ms);
  }

  /** Post our pose and take in who is near. Reschedules itself while active. */
  async post(): Promise<void> {
    if (this.closed || !this.active || this.inflight) return;
    if (this.o.now() - this.lastInput >= IDLE_MS) { this.refresh(); return; }
    this.inflight = true;
    const sent = this.o.now();
    try {
      this.posts++; this.joined = true;
      const res = await this.o.fetch(this.o.url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: this.token, pose: poseOf(this.world), seen: this.seen.map(s => s.id) })
      });
      if (!res.ok) throw new Error(`presence: HTTP ${res.status}`);
      const body = await res.json() as PresenceRes;
      const got = this.o.now();
      // Keep the clock correction from the fastest round trips; a slow one is a worse estimate.
      const off = offsetFrom(body.now, sent, got);
      if (Math.abs(off - this.offsetMs) > (got - sent) / 2 + 50) this.offsetMs = off;
      if (this.active) { this.you = body.you ?? null; this.seen = body.others ?? []; }
      this.failures = 0;
    } catch {
      // Nobody else to see for now; keep playing on the realm clock and try again later.
      this.seen = [];
      this.failures++;
    } finally { this.inflight = false; }
    if (this.active && !this.closed) {
      this.schedule(this.failures ? Math.min(60_000, POLL_ALONE_MS * 2 ** this.failures) : this.seen.length ? POLL_NEAR_MS : POLL_ALONE_MS);
    }
  }

  /** Rejoin after close(): a page restored from the back/forward cache. */
  reopen(): void {
    if (!this.closed) return;
    this.closed = false; this.active = false;
    this.lastInput = this.o.now();
    this.refresh();
  }

  close(): void {
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = null;
    this.leave();
    this.active = false; this.closed = true; this.seen = [];
  }
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
 * The shared world's presence function, unless the URL says `?offline`. A page with no such
 * function (a plain static server) finds out on the first request and plays offline.
 */
export function liveUrl(loc: { search: string }): string | null {
  return new URLSearchParams(loc.search).has('offline') ? null : PRESENCE_PATH;
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
