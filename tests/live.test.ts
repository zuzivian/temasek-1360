// The shared world without a game server: the realm clock (lazy ticks from timestamps), the
// presence function, its Redis store, and LiveLink, the browser's side of it. Ends with two
// clients on the real api/world.ts handler seeing each other on the same monsoon countdown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EPOCH_MS, offsetFrom, realmTick, tickStart } from '../src/net/clock.ts';
import {
  AWAY_TTL_MS, HEARTBEAT_MS, IDLE_MS, KEY_TTL_MS, MemoryStore, POLL_ALONE_MS, POLL_NEAR_MS, RedisStore, STALE_MS, avatarOf, clockReply, handlePresence,
  parsePresenceReq, poseAt, publicId, storeFromEnv, type PresenceRes, type Seen
} from '../src/net/presence.ts';
import { FORGET_RADIUS, MAX_PLAYERS, SEE_RADIUS } from '../src/net/realm.ts';
import { LiveLink, poseOf, type LiveOpts } from '../src/client/net.ts';
import { MONSOON_TICKS } from '../src/sim/content.ts';
import { TICK_MS } from '../src/sim/core.ts';
import { monsoonAt, monsoonLeft, newWorld, setClock, step } from '../src/sim/world.ts';
import type { Update } from '../src/net/protocol.ts';
import * as api from '../api/world.ts';
import { playAct1 } from './bot.ts';

const tok = (n: number) => n.toString(16).padStart(32, '0');
const pose = (x: number, y: number, tick = 0) => ({ x, y, facing: 1 as const, tick });

// ---------- the clock ----------

test('clock: the realm tick is a pure function of the time', () => {
  assert.equal(realmTick(EPOCH_MS), 0);
  assert.equal(realmTick(EPOCH_MS + TICK_MS - 1), 0);
  assert.equal(realmTick(EPOCH_MS + TICK_MS), 1);
  const t = 1_433_131;
  assert.equal(realmTick(tickStart(t)), t);
  assert.equal(realmTick(tickStart(t) - 1), t - 1);
  assert.equal(monsoonAt(0), 'NE', 'the epoch starts a north-east monsoon');
  // A server 1 s ahead, answering a 200 ms round trip.
  assert.equal(offsetFrom(11_100, 10_000, 10_200), 1000);
});

test('setClock: jumping onto the realm clock moves tick timers with it and turns the monsoon', () => {
  const w = newWorld(3);
  w.calmUntil = 8; w.enc[0].alive = false; w.enc[0].respawnAt = 50; w.enc[1].respawnAt = 0;
  const ev = setClock(w, 1000);
  assert.equal(w.tick, 1000);
  assert.equal(w.calmUntil, 1008, 'the fight cool-down keeps its 8 ticks');
  assert.equal(w.enc[0].respawnAt, 1050, 'a respawn keeps its distance');
  assert.equal(w.enc[1].respawnAt, 0, 'a living encounter is left alone');
  assert.equal(ev.length, 0, 'tick 1000 is still NE (500-tick monsoons: 0-499 NE, 500-999 SW, 1000 NE)');
  // Into the south-west monsoon with the junk trader's shop open: the shop closes, as in step().
  w.shop = 'lim';
  const turn = setClock(w, 1000 + MONSOON_TICKS);
  assert.equal(monsoonAt(w.tick), 'SW');
  assert.ok(turn.some(e => e.t === 'monsoon' && e.m === 'SW'));
  assert.equal(w.shop, null);
  assert.deepEqual(setClock(w, w.tick), [], 'no jump, no events');
});

test('setClock: Act 1 plays the same on the realm clock as from tick 0 (bot, 2 seeds)', () => {
  for (const seed of [1, 7]) {
    const at = realmTick(Date.UTC(2026, 10, 10, 12));
    const r = playAct1({ seed, startTick: at });
    assert.ok(r.finished, `seed ${seed} finished Act 1 starting at realm tick ${at}`);
  }
});

// ---------- presence ----------

test('presence: requests are validated, and ids come from tokens', async () => {
  assert.equal(parsePresenceReq({ token: 'nope', pose: pose(1, 1) }), null);
  assert.equal(parsePresenceReq({ token: tok(1) }), null, 'a post needs a pose');
  assert.equal(parsePresenceReq({ token: tok(1), pose: { ...pose(1, 1), x: 9999 } }), null, 'off the map');
  assert.equal(parsePresenceReq({ token: tok(1), pose: { ...pose(1, 1), facing: 0 } }), null);
  assert.equal(parsePresenceReq({ token: tok(1), pose: { ...pose(1, 1), path: new Array(9).fill({ x: 1, y: 1 }) } }), null, 'path too long');
  assert.equal(parsePresenceReq({ token: tok(1), pose: pose(1, 1), seen: ['x'] }), null);
  const ok = parsePresenceReq({ token: tok(1), pose: { ...pose(1, 1), extra: 1, __proto__: { evil: 1 } }, leave: false });
  assert.deepEqual(ok, { token: tok(1), pose: { x: 1, y: 1, facing: 1, tick: 0 } }, 'a clean copy, nothing extra');
  assert.deepEqual(parsePresenceReq({ token: tok(1), leave: true }), { token: tok(1), leave: true });
  const a = await publicId(tok(1)), b = await publicId(tok(2));
  assert.equal(a, await publicId(tok(1)));
  assert.notEqual(a, b);
  assert.ok(a >= 1 && a <= 2 ** 31);
});

test('presence: poseAt plays a shared walk forward at 2 tiles a tick', () => {
  const p = { ...pose(5, 5, 100), path: [{ x: 6, y: 5 }, { x: 7, y: 5 }, { x: 7, y: 4 }] };
  assert.deepEqual(poseAt(p, 99), p, 'not before it was posted');
  assert.deepEqual(poseAt(p, 101), { x: 7, y: 5, facing: 1, tick: 101, path: [{ x: 7, y: 4 }] });
  const end = poseAt(p, 150);
  assert.deepEqual({ x: end.x, y: end.y, path: end.path }, { x: 7, y: 4, path: undefined });
  assert.equal(end.facing, -1, 'stepping up-left faces left');
  assert.equal(avatarOf({ ...p, id: 9, fishing: 2 }, 100).fishing, undefined, 'not fishing while still walking');
  assert.equal(avatarOf({ ...pose(1, 1), id: 9, fishing: 2 }, 100).fishing, 2);
});

test('presence: players see who is near, keep seeing them to the forget radius, quiet ones go away, then vanish', async () => {
  const store = new MemoryStore(), now = tickStart(1000);
  const post = async (n: number, x: number, y: number, t = now, seen?: number[]) =>
    (await handlePresence(store, { token: tok(n), pose: pose(x, y, realmTick(t)), seen }, t)).body as PresenceRes;
  const a = await post(1, 10, 20);
  assert.deepEqual(a.others, []);
  assert.equal(a.tick, 1000);
  const b = await post(2, 10 + SEE_RADIUS, 20);
  assert.deepEqual(b.others!.map(o => o.id), [a.you], 'B sees A, exactly at the see radius');
  await post(3, 10 + FORGET_RADIUS + 1, 20);
  const a2 = await post(1, 10, 20);
  assert.deepEqual(a2.others!.map(o => o.id), [b.you], 'C is too far for A');
  // B steps back to the forget radius: A, who already sees B, keeps seeing them; a newcomer wouldn't.
  await post(2, 10 + FORGET_RADIUS, 20);
  assert.deepEqual((await post(1, 10, 20, now, [b.you!])).others!.map(o => o.id), [b.you]);
  assert.deepEqual((await post(1, 10, 20, now, [])).others!.map(o => o.id), []);
  // Leaving removes you at once. Going quiet makes you away after STALE_MS, standing where you
  // were last seen, and removes you only after AWAY_TTL_MS.
  await handlePresence(store, { token: tok(2), leave: true }, now);
  await handlePresence(store, { token: tok(4), pose: { ...pose(11, 20, realmTick(now)), path: [{ x: 12, y: 20 }] } }, now);
  const quiet = now + STALE_MS + 1;
  const seen = (await post(1, 10, 20, quiet)).others!;
  assert.deepEqual(seen.map(o => [o.id, o.away, o.path]), [[await publicId(tok(4)), true, undefined]], 'player 2 left; player 4 is away, not walking');
  const gone = now + AWAY_TTL_MS + 1;
  assert.deepEqual((await post(1, 10, 20, gone)).others, [], 'player 4 expired after the away TTL');
  assert.equal((await store.sync(0, null, gone)).size, 1, 'expired records were dropped');
  // Nobody posting for KEY_TTL_MS: the realm is empty again.
  assert.equal((await store.sync(0, null, gone + KEY_TTL_MS + 1)).size, 0);
});

test('presence: the realm is capped at MAX_PLAYERS', async () => {
  const store = new MemoryStore(), now = tickStart(5);
  for (let i = 1; i <= MAX_PLAYERS; i++) assert.equal((await handlePresence(store, { token: tok(i), pose: pose(10, 20) }, now)).status, 200);
  const full = await handlePresence(store, { token: tok(9999), pose: pose(10, 20) }, now);
  assert.equal(full.status, 503);
  assert.equal((await store.sync(0, null, now)).size, MAX_PLAYERS, 'the refused player was not kept');
  assert.equal((await handlePresence(store, { token: 'bad' }, now)).status, 400);
});

/** A tiny Redis behind Upstash's REST pipeline, counting HTTP requests and commands. */
function fakeUpstash() {
  const hashes = new Map<string, Map<string, string>>(), stats = { requests: 0, commands: 0, auth: '' };
  const fetchFn = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    assert.ok(url.endsWith('/pipeline'));
    stats.requests++; stats.auth = init.headers.authorization;
    const out = (JSON.parse(init.body) as string[][]).map(([cmd, key, ...rest]) => {
      stats.commands++;
      const h = hashes.get(key) ?? new Map<string, string>(); hashes.set(key, h);
      if (cmd === 'HSET') { h.set(rest[0], rest[1]); return { result: 1 }; }
      if (cmd === 'HDEL') { let n = 0; for (const f of rest) n += h.delete(f) ? 1 : 0; return { result: n }; }
      if (cmd === 'HGETALL') return { result: [...h].flat() };
      if (cmd === 'PEXPIRE') return { result: 1 };
      return { error: `unknown ${cmd}` };
    });
    return { ok: true, status: 200, json: async () => out };
  };
  return { fetchFn, stats, hashes };
}

test('presence: the Redis store is one HTTP request of three commands per post', async () => {
  const kv = fakeUpstash();
  const store = storeFromEnv({ KV_REST_API_URL: 'https://example.upstash.io/', KV_REST_API_TOKEN: 'secret' }, kv.fetchFn);
  assert.ok(store instanceof RedisStore);
  assert.equal(storeFromEnv({}, kv.fetchFn).kind, 'memory', 'no KV configured: memory');
  const now = tickStart(77);
  await handlePresence(store, { token: tok(1), pose: pose(10, 20, 77) }, now);
  assert.deepEqual(kv.stats, { requests: 1, commands: 3, auth: 'Bearer secret' });
  const r = (await handlePresence(store, { token: tok(2), pose: pose(12, 20, 77) }, now)).body as PresenceRes;
  assert.deepEqual(r.others, [{ id: await publicId(tok(1)), ...pose(10, 20, 77) }]);
  const before = { ...kv.stats };
  const hb = await handlePresence(store, { token: tok(1), beat: true, pose: pose(10, 20, 77) }, now);
  assert.deepEqual([kv.stats.requests - before.requests, kv.stats.commands - before.commands], [1, 2], 'a heartbeat: one request, HSET + PEXPIRE, nothing read');
  assert.equal((hb.body as PresenceRes).others, undefined, 'and nothing sent back but the time');
  kv.hashes.get('t1360:presence')!.set('5', 'not json');
  assert.equal((await store.sync(1, null, now)).size, 2, 'a damaged record is skipped, not fatal');
  assert.equal((clockReply(store, now).body as PresenceRes).store, 'kv');
});

// ---------- LiveLink against the real api/world.ts handlers ----------

/**
 * A fake wall clock and timers, with fetch (and sendBeacon) wired straight into api/world.ts, or
 * with `own: true` into a presence handler of its own that also runs on the fake clock, for TTLs.
 */
function harness(opts0: { own?: boolean } = {}) {
  const t = { now: tickStart(1_433_000) + 123 };
  let timers: { at: number; fn: () => void; id: number }[] = [], nextId = 1;
  const store = new MemoryStore(), stats = { posts: 0, beats: 0, leaves: 0 };
  // Every request in flight, so settle() can wait for them all instead of guessing how long they take.
  const inflight = new Set<Promise<unknown>>();
  const track: LiveOpts['fetch'] = (url, init) => {
    const p = fetchRaw(url, init);
    inflight.add(p);
    // Remove it a turn after it lands, once the caller's own continuation has run.
    void p.finally(() => setTimeout(() => inflight.delete(p), 0)).catch(() => {});
    return p;
  };
  const fetchRaw: LiveOpts['fetch'] = async (url, init) => {
    if (init?.body) { const b = JSON.parse(init.body); if (b.leave) stats.leaves++; else if (b.beat) stats.beats++; else stats.posts++; }
    if (opts0.own) {
      const r = init?.method === 'POST' ? await handlePresence(store, JSON.parse(init.body!), t.now) : clockReply(store, t.now);
      return { ok: r.status === 200, status: r.status, json: async () => r.body };
    }
    const req = new Request(`http://localhost${url}`, { method: init?.method ?? 'GET', body: init?.body });
    const res = await api.default(req);
    // The handler stamps Date.now(); report it on our fake clock instead so offsets are testable.
    const body = await res.json() as PresenceRes;
    return { ok: res.ok, status: res.status, json: async () => ({ ...body, now: t.now }) };
  };
  const fetchFn = track;
  const opts = (): LiveOpts => ({
    url: '/api/world', fetch: fetchFn, now: () => t.now,
    beacon: (url, body) => { void fetchFn(url, { method: 'POST', body }); },
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: t.now + ms, fn, id }); return id; },
    clearTimer: h => { timers = timers.filter(x => x.id !== h); }
  });
  /** Move the clock on, firing timers that come due and letting their requests settle. */
  /** Wait until no request is in flight (and what each one triggered has run). */
  const settle = async () => {
    for (let guard = 0; guard < 1000; guard++) {
      await new Promise(r => setTimeout(r, 0));
      if (!inflight.size) { await new Promise(r => setTimeout(r, 0)); if (!inflight.size) return; }
      else await Promise.allSettled([...inflight]);
    }
    throw new Error('requests never settled');
  };
  const advance = async (ms: number, links: LiveLink[] = []) => {
    await settle(); // let requests already in flight land (and schedule their next timer) first
    const end = t.now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      t.now = next.at; timers.shift();
      next.fn();
      await settle();
      for (const l of links) l.pump();
    }
    t.now = end;
    for (const l of links) l.pump();
    await settle();
  };
  const pending = () => timers.length;
  return { t, opts, advance, pending, store, stats, settle };
}

test('LiveLink: ticks lazily up to the realm clock, and jumps after a long gap', async () => {
  const h = harness(), ups: Update[] = [];
  const link = await LiveLink.connect(newWorld(4), u => ups.push(u), h.opts());
  const start = realmTick(h.t.now);
  assert.equal(link.world.tick, start, 'a new game starts on the realm tick');
  assert.equal(link.pump(), 0, 'nothing to do until the next tick boundary');
  h.t.now += 3 * TICK_MS;
  assert.equal(link.pump(), 3);
  assert.equal(link.world.tick, start + 3);
  assert.equal(ups.filter(u => u.kind === 'tick').length, 3);
  // A tab hidden for 10 minutes: one tick, not a thousand, and the clock is right after it.
  link.setVisible(false);
  h.t.now += 10 * 60_000;
  assert.equal(link.pump(), 1);
  assert.equal(link.world.tick, realmTick(h.t.now));
  link.close();
});

test('LiveLink: posts only while visible and in use, slower when alone', async () => {
  const h = harness();
  const link = await LiveLink.connect(newWorld(4), () => {}, h.opts());
  await h.advance(0, [link]);
  assert.equal(link.posts, 1, 'joins at once');
  assert.ok(link.you);
  await h.advance(POLL_ALONE_MS * 4, [link]);
  assert.equal(link.posts, 5, `alone: one post every ${POLL_ALONE_MS / 1000} s`);
  link.setVisible(false);
  const hidden = link.posts;
  await h.advance(5 * 60_000 + 1, [link]);
  assert.equal(link.posts, hidden, 'a hidden tab polls nothing');
  assert.equal(link.beats, 6, `only a heartbeat at once, then one every ${HEARTBEAT_MS / 1000} s`);
  assert.equal(h.pending(), 1, 'one timer: the next heartbeat');
  link.setVisible(true);
  await h.advance(0, [link]);
  assert.equal(link.posts, hidden + 1, 'back: posts (resyncs) at once');
  // Idle: after IDLE_MS without input it goes away on heartbeats; any input brings it back.
  await h.advance(IDLE_MS + POLL_ALONE_MS, [link]);
  assert.equal(link.active, false, 'idle tabs go away');
  const idle = link.posts, idleBeats = link.beats;
  await h.advance(5 * 60_000, [link]);
  assert.equal(link.posts, idle, 'an idle tab polls nothing');
  assert.equal(link.beats - idleBeats, 5, 'just heartbeats');
  link.touch();
  await h.advance(0, [link]);
  assert.equal(link.active, true);
  assert.equal(link.posts, idle + 1);
  link.close();
  assert.equal(h.pending(), 0, 'closed: no timers at all');
  assert.equal(h.stats.leaves, 1, 'and one leave');
});

test('LiveLink e2e: two clients on api/world see each other and the same monsoon countdown', async () => {
  const h = harness();
  const a = await LiveLink.connect(newWorld(1), () => {}, h.opts());
  // B brings an old save from tick 40: it moves onto the realm clock too.
  const old = newWorld(2); for (let i = 0; i < 40; i++) step(old, []);
  h.t.now += 1700;
  const b = await LiveLink.connect(old, () => {}, h.opts());
  await h.advance(0, [a, b]);
  await h.advance(POLL_ALONE_MS, [a, b]);
  assert.equal(a.world.tick, b.world.tick, 'one realm tick');
  assert.equal(monsoonAt(a.world.tick), monsoonAt(b.world.tick));
  assert.equal(monsoonLeft(a.world.tick), monsoonLeft(b.world.tick), 'the same countdown');
  assert.deepEqual(a.others().map(o => o.id), [b.you]);
  assert.deepEqual(b.others().map(o => o.id), [a.you]);
  // B walks; A sees the walk played out on the realm clock between posts.
  b.send({ t: 'walk', to: { x: 12, y: 27 } });
  assert.ok(b.world.player.path.length >= 3, 'B has somewhere to walk');
  const goal = structuredClone(b.world.player.path.at(-1));
  await h.advance(POLL_NEAR_MS + 4 * TICK_MS, [a, b]);
  const seen = a.others()[0];
  assert.deepEqual({ x: seen.x, y: seen.y }, { x: b.world.player.x, y: b.world.player.y }, 'A draws B where B is');
  assert.deepEqual({ x: b.world.player.x, y: b.world.player.y }, goal);
  assert.ok(a.posts > 1 && b.posts > 1);
  // B hides the tab: A still sees B, dimmed as away, where B stood.
  b.setVisible(false);
  await h.advance(POLL_NEAR_MS + 10, [a, b]);
  assert.deepEqual(a.others().map(o => [o.id, o.away, o.x, o.y]), [[b.you, true, goal!.x, goal!.y]], 'a hidden player stays, away');
  // B comes back: resynced at once, on the same clock, and no longer away for A.
  h.t.now += 30_000;
  b.setVisible(true);
  await h.advance(POLL_NEAR_MS + 10, [a, b]);
  assert.deepEqual(b.others().map(o => o.id), [a.you], 'B sees A again straight away');
  assert.equal(a.others()[0]?.away, undefined, 'A sees B back');
  assert.equal(a.world.tick, b.world.tick);
  a.close(); b.close();
});

test('LiveLink: a hidden tab stays in the world for 5 min, expires after the away TTL, and a leave beacon removes it at once', async () => {
  const h = harness({ own: true });
  const a = await LiveLink.connect(newWorld(1), () => {}, h.opts());
  const b = await LiveLink.connect(newWorld(2), () => {}, h.opts());
  await h.advance(POLL_ALONE_MS, [a, b]);
  assert.deepEqual(a.others().map(o => o.id), [b.you]);
  const bId = b.you;
  // B is hidden for five minutes: heartbeats keep B there, as away.
  b.setVisible(false);
  for (let m = 1; m <= 5; m++) {
    await h.advance(60_000, [a, b]);
    a.touch(); // A keeps playing
    assert.deepEqual(a.others().map(o => [o.id, o.away]), [[bId, true]], `B still there, away, after ${m} min`);
  }
  assert.ok(h.stats.beats >= 5 && h.stats.beats <= 7, `about one heartbeat a minute (${h.stats.beats})`);
  // B's tab is frozen (no more heartbeats): B stays away until the TTL, then is gone.
  b.close(); // stop its timers…
  await h.settle();
  await h.store.sync(bId!, { p: { ...poseOf(b.world), away: true }, at: h.t.now }, h.t.now); // …but undo its leave: as if frozen, not closed
  await h.advance(AWAY_TTL_MS - 30_000, [a]);
  a.touch();
  await h.advance(POLL_NEAR_MS, [a]);
  assert.deepEqual(a.others().map(o => o.id), [bId], 'still there just inside the TTL');
  await h.advance(60_000, [a]);
  a.touch();
  await h.advance(POLL_ALONE_MS, [a]);
  assert.deepEqual(a.others(), [], 'gone after the TTL');
  // A third player closes the page: the pagehide beacon removes them on A's very next post.
  const c = await LiveLink.connect(newWorld(3), () => {}, h.opts());
  await h.advance(POLL_ALONE_MS, [a, c]);
  assert.deepEqual(a.others().map(o => o.id), [c.you]);
  const leaves = h.stats.leaves;
  c.close();
  await h.advance(POLL_NEAR_MS, [a]);
  assert.equal(h.stats.leaves, leaves + 1, 'one leave beacon');
  assert.deepEqual(a.others(), [], 'removed at once, not after a TTL');
  a.close();
});

test('poseOf: shares at most a short stretch of the path', () => {
  const w = newWorld(1);
  w.player.path = Array.from({ length: 20 }, (_, i) => ({ x: 10 + i, y: 20 }));
  const p = poseOf(w);
  assert.equal(p.path!.length, 8);
  assert.ok(parsePresenceReq({ token: tok(1), pose: p }));
  const s: Seen = { ...p, id: 1 };
  assert.equal(avatarOf(s, p.tick).x, w.player.x);
});
