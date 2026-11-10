// Presence for the shared world when there is no game server, only a serverless function
// (api/world.ts on Vercel). Each player's World still runs in their own tab (LoopbackLink),
// on the shared realm clock (clock.ts). What players share is being on the same beach: every few
// seconds a visible tab posts its pose and gets back the players near it. Records live in a
// small key-value store with a short expiry, so with nobody playing nothing runs and nothing is
// stored.
//
// DOM-free and Node-free: the function, the browser and the tests all use this file.
import { chebyshev, type Vec } from '../sim/core.ts';
import { MAP } from '../sim/map.ts';
import { realmTick } from './clock.ts';
import type { Avatar } from './protocol.ts';
import { FORGET_RADIUS, MAX_PLAYERS, SEE_RADIUS } from './realm.ts';

export const PRESENCE_PATH = '/api/world';
/** A player who hasn't posted for this long has gone (closed the tab without saying so). */
export const STALE_MS = 15_000;
/** How often a visible, active tab posts: alone, and with someone in view. */
export const POLL_ALONE_MS = 5_000;
export const POLL_NEAR_MS = 2_000;
/** A tab with no input for this long leaves the realm until the next input. */
export const IDLE_MS = 120_000;
/** The whole presence key expires this long after the last post, so an empty realm stores nothing. */
export const KEY_TTL_MS = 60_000;
/** Steps of a player's walk that are shared, so others can play the walk out between posts. */
export const MAX_PATH = 8;
/** Tiles a walker covers per tick (moveAlong in world.ts). */
const WALK_PER_TICK = 2;

/** What a player shares: where they are at realm tick `tick`, and where they are walking. */
export type Pose = { x: number; y: number; facing: 1 | -1; tick: number; path?: Vec[]; fishing?: number; fighting?: boolean };
/** Another player as the function sends them. */
export type Seen = Pose & { id: number };
/** A stored record: a pose and when the server got it. */
export type Rec = { p: Pose; at: number };

export type PresenceReq = { token: string; pose?: Pose; leave?: boolean; seen?: number[] };
export type PresenceRes = { now: number; tick: number; store: 'kv' | 'memory'; you?: number; others?: Seen[] };
export type Reply = { status: number; body: PresenceRes | { error: string } };

export interface PresenceStore {
  readonly kind: 'kv' | 'memory';
  /** Write one player's record (or delete it when `rec` is null) and read back everyone's, in one round trip. */
  sync(id: number, rec: Rec | null, nowMs: number): Promise<Map<number, Rec>>;
  /** Forget players who went quiet. */
  drop(ids: number[]): Promise<void>;
}

// ---------- validation: everything from the network is untrusted ----------
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const isTile = (v: unknown): v is Vec => isObj(v) && isInt(v.x, 0, MAP.w - 1) && isInt(v.y, 0, MAP.h - 1);
const tile = (v: unknown): v is Obj & Vec => isTile(v);

/** A clean copy of a well-formed pose, or null. */
export function parsePose(raw: unknown): Pose | null {
  if (!isObj(raw) || !tile(raw) || (raw.facing !== 1 && raw.facing !== -1) || !isInt(raw.tick, 0, 2 ** 40)) return null;
  const p: Pose = { x: raw.x, y: raw.y, facing: raw.facing, tick: raw.tick };
  if (raw.path !== undefined) {
    if (!Array.isArray(raw.path) || raw.path.length > MAX_PATH || !raw.path.every(isTile)) return null;
    if (raw.path.length) p.path = raw.path.map(s => ({ x: (s as Vec).x, y: (s as Vec).y }));
  }
  if (raw.fishing !== undefined) { if (!isInt(raw.fishing, 0, 1000)) return null; p.fishing = raw.fishing; }
  if (raw.fighting !== undefined) { if (typeof raw.fighting !== 'boolean') return null; if (raw.fighting) p.fighting = true; }
  return p;
}

/** A clean copy of a well-formed request, or null. The token is a random 128-bit hex string the tab made. */
export function parsePresenceReq(raw: unknown): PresenceReq | null {
  if (!isObj(raw) || typeof raw.token !== 'string' || !/^[0-9a-f]{32}$/.test(raw.token)) return null;
  const out: PresenceReq = { token: raw.token };
  if (raw.leave === true) { out.leave = true; return out; }
  const pose = parsePose(raw.pose);
  if (!pose) return null;
  out.pose = pose;
  if (raw.seen !== undefined) {
    if (!Array.isArray(raw.seen) || raw.seen.length > MAX_PLAYERS || !raw.seen.every(n => isInt(n, 1, 2 ** 31))) return null;
    out.seen = raw.seen as number[];
  }
  return out;
}

/**
 * The public id for a secret token: the first 31 bits of its SHA-256, plus one. Others only ever
 * see the id, and only the token's holder can post (or leave) as that id.
 */
export async function publicId(token: string): Promise<number> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return (((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 1) + 1;
}

/** Where a pose's walk has got to by realm tick `tick` (2 tiles a tick, as in the sim). */
export function poseAt(p: Pose, tick: number): Pose {
  const path = p.path ?? [];
  const n = Math.min(path.length, Math.max(0, (tick - p.tick) * WALK_PER_TICK));
  if (!n) return p;
  let { x, y, facing } = p;
  for (let i = 0; i < n; i++) { const s = path[i]; facing = s.x - x + (s.y - y) >= 0 ? 1 : -1; x = s.x; y = s.y; }
  const out: Pose = { ...p, x, y, facing, tick };
  if (n < path.length) out.path = path.slice(n); else delete out.path;
  return out;
}

/** What the renderer draws for someone seen, at realm tick `tick`. */
export function avatarOf(s: Seen, tick: number): Avatar {
  const p = poseAt(s, tick);
  const a: Avatar = { id: s.id, x: p.x, y: p.y, facing: p.facing };
  if (p.fishing !== undefined && !p.path) a.fishing = p.fishing;
  if (p.fighting) a.fighting = true;
  return a;
}

/** The players `me` (id `myId`) should see now, as in Realm.visibleTo: near ones, and seen ones not yet far. */
export function nearby(myId: number, me: Pose, all: Map<number, Rec>, seen: ReadonlySet<number>, nowMs: number): Seen[] {
  const tick = realmTick(nowMs), here = poseAt(me, tick), out: Seen[] = [];
  for (const [id, r] of all) {
    if (id === myId || nowMs - r.at > STALE_MS) continue;
    const d = chebyshev(here, poseAt(r.p, tick));
    if (d <= SEE_RADIUS || (seen.has(id) && d <= FORGET_RADIUS)) out.push({ id, ...r.p });
  }
  return out.sort((a, b) => a.id - b.id);
}

/** GET: just the time, so a tab can find the realm clock without joining. */
export const clockReply = (store: PresenceStore, nowMs: number): Reply =>
  ({ status: 200, body: { now: nowMs, tick: realmTick(nowMs), store: store.kind } });

/** POST: post a pose (or leave) and get back who is near. */
export async function handlePresence(store: PresenceStore, raw: unknown, nowMs: number): Promise<Reply> {
  const req = parsePresenceReq(raw);
  if (!req) return { status: 400, body: { error: 'bad request' } };
  const id = await publicId(req.token);
  const base = clockReply(store, nowMs).body as PresenceRes;
  if (req.leave) { await store.sync(id, null, nowMs); return { status: 200, body: base }; }
  const pose = req.pose!;
  const all = await store.sync(id, { p: pose, at: nowMs }, nowMs);
  const stale: number[] = [];
  let live = 0;
  for (const [other, r] of all) {
    if (nowMs - r.at > STALE_MS) stale.push(other);
    else if (other !== id) live++;
  }
  if (stale.length) await store.drop(stale);
  if (live >= MAX_PLAYERS) { await store.sync(id, null, nowMs); return { status: 503, body: { error: 'realm full' } }; }
  return { status: 200, body: { ...base, you: id, others: nearby(id, pose, all, new Set(req.seen ?? []), nowMs) } };
}

// ---------- stores ----------

/** In-process store: tests, local play, and a deployment with no KV connected (one instance only). */
export class MemoryStore implements PresenceStore {
  readonly kind = 'memory';
  private readonly recs = new Map<number, Rec>();
  private lastPost = 0;
  async sync(id: number, rec: Rec | null, nowMs: number): Promise<Map<number, Rec>> {
    if (nowMs - this.lastPost > KEY_TTL_MS) this.recs.clear(); // the same expiry the KV key has
    if (rec) { this.recs.set(id, rec); this.lastPost = nowMs; } else this.recs.delete(id);
    return new Map(this.recs);
  }
  async drop(ids: number[]): Promise<void> { for (const id of ids) this.recs.delete(id); }
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Redis over Upstash's REST API (what Vercel's Upstash/KV integration provides), with plain
 * fetch so there is no dependency. One hash holds everyone; a post is one HTTP request of three
 * commands (HSET, PEXPIRE, HGETALL).
 */
export class RedisStore implements PresenceStore {
  readonly kind = 'kv';
  private readonly url: string;
  private readonly token: string;
  private readonly fetchFn: Fetch;
  private readonly key: string;
  constructor(url: string, token: string, fetchFn: Fetch, key = 't1360:presence') {
    this.url = url.replace(/\/$/, ''); this.token = token; this.fetchFn = fetchFn; this.key = key;
  }

  private async pipeline(cmds: (string | number)[][]): Promise<unknown[]> {
    const res = await this.fetchFn(`${this.url}/pipeline`, {
      method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify(cmds)
    });
    if (!res.ok) throw new Error(`kv: HTTP ${res.status}`);
    const out = await res.json() as { result?: unknown; error?: string }[];
    const bad = out.find(r => r.error);
    if (bad) throw new Error(`kv: ${bad.error}`);
    return out.map(r => r.result);
  }

  async sync(id: number, rec: Rec | null, _nowMs: number): Promise<Map<number, Rec>> {
    const cmds: (string | number)[][] = rec
      ? [['HSET', this.key, String(id), JSON.stringify(rec)], ['PEXPIRE', this.key, KEY_TTL_MS], ['HGETALL', this.key]]
      : [['HDEL', this.key, String(id)], ['HGETALL', this.key]];
    const out = await this.pipeline(cmds);
    const flat = (out[out.length - 1] ?? []) as string[];
    const all = new Map<number, Rec>();
    for (let i = 0; i + 1 < flat.length; i += 2) {
      try {
        const r = JSON.parse(flat[i + 1]) as Rec, p = parsePose(r?.p);
        if (p && Number.isFinite(r.at)) all.set(Number(flat[i]), { p, at: r.at });
      } catch { /* skip a damaged record */ }
    }
    return all;
  }

  async drop(ids: number[]): Promise<void> { if (ids.length) await this.pipeline([['HDEL', this.key, ...ids.map(String)]]); }
}

/** The store a deployment should use: Redis when its REST URL and token are set, else memory. */
export function storeFromEnv(env: Record<string, string | undefined>, fetchFn: Fetch): PresenceStore {
  const url = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL, token = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new RedisStore(url, token, fetchFn) : new MemoryStore();
}
