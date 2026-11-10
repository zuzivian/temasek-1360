import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startGameServer } from '../server/game-server.ts';
import { acceptKey, frame, originAllowed, parseFrame } from '../server/ws.ts';
import { MAX_INTENTS_PER_TICK } from '../src/net/host.ts';
import { PROTOCOL, WS_PATH, type Avatar, type ServerMsg, type StateMsg } from '../src/net/protocol.ts';
import { FORGET_RADIUS, SEE_RADIUS } from '../src/net/realm.ts';
import { START } from '../src/sim/content.ts';
import { chebyshev } from '../src/sim/core.ts';
import { Mirror } from '../src/net/sync.ts';
import { newWorld, save, step, type World } from '../src/sim/world.ts';

/** One message as the test sees it: the raw message, its size, and the client's copy after applying it. */
type Got = { m: ServerMsg; bytes: number; kind: string; world: World; others: Avatar[] };

/**
 * A test client on Node's built-in WebSocket. It queues messages so the test can await them and
 * keeps a Mirror exactly as the browser does, applied as each message is taken from the queue.
 */
async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
  const inbox: string[] = [];
  const waiters: ((m: string) => void)[] = [];
  ws.onmessage = e => { const m = String(e.data); const w = waiters.shift(); if (w) w(m); else inbox.push(m); };
  await new Promise<void>((ok, fail) => { ws.onopen = () => ok(); ws.onerror = () => fail(new Error('connect failed')); });
  let mirror: Mirror | null = null;
  const take = (text: string): Got => {
    const m = JSON.parse(text) as ServerMsg;
    let kind: string = m.t;
    if (m.t === 'welcome') mirror = new Mirror(m);
    else if (m.t === 'state') { assert.ok(mirror, 'state before welcome'); mirror.apply(m); kind = m.kind; }
    else kind = m.msg;
    return { m, bytes: text.length, kind, world: mirror?.world as World, others: mirror?.list() ?? [] };
  };
  const next = (ms = 2000) => new Promise<Got>((ok, fail) => {
    const m = inbox.shift();
    if (m !== undefined) { ok(take(m)); return; }
    const t = setTimeout(() => fail(new Error('timed out waiting for a message')), ms);
    waiters.push(x => { clearTimeout(t); ok(take(x)); });
  });
  const until = async (pred: (g: Got) => boolean, ms = 3000, max = 3000) => {
    for (let i = 0; i < max; i++) { const g = await next(ms); if (pred(g)) return g; }
    throw new Error(`no matching message in ${max}`);
  };
  const send = (o: unknown) => ws.send(typeof o === 'string' ? o : JSON.stringify(o));
  const hello = async (o: { seed?: number; save?: string } = {}) => { send({ t: 'hello', v: PROTOCOL, ...o }); return until(g => g.kind === 'welcome'); };
  const closed = new Promise<number>(ok => { ws.onclose = e => ok(e.code); });
  return { ws, next, until, send, hello, closed, you: () => (mirror as Mirror | null)?.you ?? 0 };
}

test('server: hello gets a welcome, then a tick about every tickMs', async () => {
  const srv = await startGameServer({ tickMs: 40, seed: () => 77 });
  try {
    const c = await connect(srv.port);
    const welcome = await c.hello();
    assert.deepEqual(welcome.world, newWorld(77), 'a new player gets a fresh world from the server seed');
    assert.deepEqual(welcome.others, [], 'alone on the beach');
    const ticks: number[] = [];
    const t0 = Date.now();
    while (ticks.length < 5) { const g = await c.next(); if (g.kind === 'tick') ticks.push(g.world.tick); }
    assert.deepEqual(ticks, [1, 2, 3, 4, 5], 'one step per tick, none skipped or doubled');
    assert.ok(Date.now() - t0 >= 4 * 40 - 15, 'ticks are paced by the clock, not sent as fast as possible');
    c.ws.close();
  } finally { await srv.close(); }
});

test('server: intents apply at once and match the same game run locally', async () => {
  const srv = await startGameServer({ tickMs: 30 });
  try {
    const c = await connect(srv.port);
    const start = newWorld(5);
    await c.hello({ save: save(start) });
    c.send({ t: 'intent', it: { t: 'walk', to: { x: 12, y: 27 } } });
    const after = await c.until(g => g.kind === 'act');
    assert.ok(after.world.player.path.length > 0, 'the walk was planned right away');
    // The client's patched copy must equal a local replay of the same intent at the same tick.
    const local: World = structuredClone(start);
    for (let i = 0; i < after.world.tick; i++) step(local, []);
    const { act } = await import('../src/sim/world.ts');
    act(local, { t: 'walk', to: { x: 12, y: 27 } });
    assert.equal(save(after.world), save(local));
    const moved = await c.until(g => g.kind === 'tick');
    assert.ok(moved.world.player.x !== start.player.x || moved.world.player.y !== start.player.y, 'the next tick walks');
    c.ws.close();
  } finally { await srv.close(); }
});

test('server: bad messages get an error and the session survives; floods get disconnected', async () => {
  const srv = await startGameServer({ tickMs: 60000 });
  try {
    const c = await connect(srv.port);
    c.send({ t: 'intent', it: { t: 'close' } });
    assert.deepEqual((await c.next()).m, { t: 'error', msg: 'send hello first' });
    c.send({ t: 'hello', v: PROTOCOL, save: '{"v":1,"broken":true}' });
    const w = await c.next();
    assert.equal(w.kind, 'welcome');
    assert.equal(w.world.tick, 0, 'an unreadable save falls back to a new world');
    c.send('{nope');
    assert.deepEqual((await c.next()).m, { t: 'error', msg: 'bad message' });
    c.send({ t: 'intent', it: { t: 'talk', npc: '__proto__' } });
    assert.deepEqual((await c.next()).m, { t: 'error', msg: 'bad message' });
    c.send({ t: 'intent', it: { t: 'close' } });
    assert.equal((await c.next()).kind, 'act', 'still playing after bad input');
    // Intents over the per-tick budget are answered with an error, never silently dropped.
    for (let i = 0; i < MAX_INTENTS_PER_TICK + 3; i++) c.send({ t: 'intent', it: { t: 'close' } });
    const replies: string[] = [];
    for (let i = 0; i < MAX_INTENTS_PER_TICK + 3; i++) replies.push((await c.next()).kind);
    assert.deepEqual(replies, [...Array(MAX_INTENTS_PER_TICK - 1).fill('act'), ...Array(4).fill('too many intents')]);
    for (let i = 0; i < 30; i++) c.send('x');
    assert.equal(await c.closed, 1008, 'too many bad messages closes the socket with policy-violation');
  } finally { await srv.close(); }
});

test('server: players keep their own Worlds in the shared realm, and leaving frees the slot', async () => {
  const srv = await startGameServer({ tickMs: 30 });
  try {
    const a = await connect(srv.port), b = await connect(srv.port);
    await a.hello({ seed: 1 }); await b.hello({ seed: 2 });
    assert.ok(a.you() !== b.you());
    a.send({ t: 'intent', it: { t: 'walk', to: { x: 12, y: 27 } } });
    const wa = (await a.until(g => g.kind === 'act')).world;
    const wb = (await b.until(g => g.kind === 'tick')).world;
    assert.ok(wa.player.path.length > 0 && wb.player.path.length === 0, "one player's intent never touches another's World");
    assert.equal(srv.sessions(), 2);
    assert.equal(srv.realm.size, 2);
    b.ws.close(); await b.closed;
    for (let i = 0; i < 50 && srv.sessions() !== 1; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(srv.sessions(), 1);
    assert.equal(srv.realm.size, 1, 'the realm forgets a player who left');
    a.ws.close();
  } finally { await srv.close(); }
});

test('server: two clients see each other only when near, and far moves are never sent', async () => {
  const srv = await startGameServer({ tickMs: 25 });
  try {
    const a = await connect(srv.port), b = await connect(srv.port);
    await a.hello({ seed: 1 });
    const wb = await b.hello({ seed: 2 });
    // Both start on the beach by the seed pod.
    assert.deepEqual(wb.others.map(o => o.id), [a.you()], 'B arrives and already sees A');
    const seenA = await a.until(g => g.others.length > 0, 3000, 5);
    assert.deepEqual(seenA.others.map(o => o.id), [b.you()], 'A sees B appear on the next tick');
    // B walks far up the east side, well past FORGET_RADIUS.
    const far = { x: 40, y: 12 };
    assert.ok(chebyshev(START, far) > FORGET_RADIUS);
    b.send({ t: 'intent', it: { t: 'walk', to: far } });
    await b.until(g => g.kind === 'act');
    const goneAt = await a.until(g => g.m.t === 'state' && !!g.m.gone, 8000, 400);
    assert.deepEqual(goneAt.others, [], 'A forgets B once B is far');
    // Once B is out of view, nothing about B reaches A, however much B moves.
    let bTick = 0;
    while (bTick < 200) {
      const g = await b.next(4000);
      if (g.kind !== 'tick') continue;
      bTick = g.world.tick;
      if (g.world.player.x === far.x && g.world.player.y === far.y) break;
    }
    const later: Got[] = [];
    for (let i = 0; i < 10; i++) later.push(await a.until(g => g.kind === 'tick'));
    for (const g of later) {
      const m = g.m as StateMsg;
      assert.equal(m.seen, undefined, 'no avatars sent while B is far');
      assert.ok(!JSON.stringify(m).includes(`"id":${b.you()}`), 'no mention of B at all');
    }
    // B walks back and reappears for A.
    b.send({ t: 'intent', it: { t: 'walk', to: { x: 12, y: 27 } } });
    assert.equal((await b.until(g => g.kind === 'act')).world.player.path.length > 0, true, 'the walk back was accepted');
    const back = await a.until(g => g.others.length > 0, 8000, 400);
    assert.equal(back.others[0].id, b.you());
    assert.ok(chebyshev(back.others[0], back.world.player) <= SEE_RADIUS);
    a.ws.close(); b.ws.close();
  } finally { await srv.close(); }
});

test('server: tick messages are deltas, far smaller than the whole World', async () => {
  const srv = await startGameServer({ tickMs: 20 });
  try {
    const c = await connect(srv.port);
    await c.hello({ seed: 3 });
    c.send({ t: 'intent', it: { t: 'walk', to: { x: 14, y: 26 } } });
    // Step 1 sent the whole World every tick; compare against that, tick by tick.
    let delta = 0, full = 0, ticks = 0, worst = 0;
    while (ticks < 20) {
      const g = await c.next();
      if (g.kind !== 'tick') continue;
      ticks++;
      const whole = JSON.stringify({ t: 'state', kind: 'tick', world: g.world, ev: (g.m as StateMsg).ev ?? [] }).length;
      delta += g.bytes; full += whole; worst = Math.max(worst, g.bytes / whole);
    }
    assert.ok(worst < 0.2, `every tick, even while walking and clearing fog, is under a fifth of a whole-World message (worst ${(worst * 100).toFixed(1)}%)`);
    assert.ok(delta * 20 < full, `20 ticks cost ${delta} bytes instead of ${full}`);
    c.ws.close();
  } finally { await srv.close(); }
});

test('ws: frames, handshake key and origin rules', () => {
  // The RFC 6455 handshake example.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  // A masked client text frame "Hi" split across two reads.
  const mask = [1, 2, 3, 4], text = [72, 105];
  const bytes = new Uint8Array([0x81, 0x80 | 2, ...mask, text[0] ^ mask[0], text[1] ^ mask[1]]);
  assert.equal(parseFrame(bytes.subarray(0, 5), 100), null, 'incomplete');
  const f = parseFrame(bytes, 100);
  assert.ok(f && !('error' in f));
  assert.deepEqual([...f.payload], text);
  assert.equal(f.size, bytes.length);
  assert.deepEqual(parseFrame(new Uint8Array([0x81, 2, 72, 105]), 100), { error: 1002 }, 'unmasked client frames are refused');
  assert.deepEqual(parseFrame(new Uint8Array([0x81, 0x80 | 126, 0x10, 0x00]), 100), { error: 1009 }, 'too big');
  // Server frames use the three length encodings.
  assert.deepEqual([...frame(1, new Uint8Array(3)).subarray(0, 2)], [0x81, 3]);
  assert.deepEqual([...frame(1, new Uint8Array(300)).subarray(0, 4)], [0x81, 126, 1, 44]);
  assert.deepEqual([...frame(1, new Uint8Array(70000)).subarray(0, 10)], [0x81, 127, 0, 0, 0, 0, 0, 1, 0x11, 0x70]);
  assert.ok(originAllowed('', '127.0.0.1:8080'));
  assert.ok(originAllowed('http://localhost:8080', 'localhost:8787'));
  assert.ok(originAllowed('http://game.example:80', 'game.example:9000'));
  assert.ok(!originAllowed('https://evil.example', 'localhost:8080'));
  assert.ok(!originAllowed('not a url', 'localhost:8080'));
});

test('server: the Act 1 bot finishes the act playing only through the socket', async () => {
  const { decide, act1Done } = await import('./bot.ts');
  const srv = await startGameServer({ tickMs: 3 });
  try {
    const c = await connect(srv.port);
    await c.hello({ seed: 4 });
    const mind = { sold: false };
    let inflight = 0, w: World | null = null, fights = 0, decidedAt = -1;
    for (let n = 0; n < 40000; n++) {
      const g = await c.next(5000);
      if (g.kind === 'act') inflight--;
      if ((g.m as StateMsg).ev?.some(e => e.t === 'combatEnd')) fights++;
      w = g.world;
      if (act1Done(w)) break;
      // Like the local bot: at most one decision per tick, and only on state that already
      // includes our last intent.
      if (inflight > 0 || w.tick === decidedAt) continue;
      decidedAt = w.tick;
      for (const it of decide(w, mind)) { c.send({ t: 'intent', it }); inflight++; }
    }
    assert.ok(w && act1Done(w), `finished Act 1 over the socket (step ${w?.step}, tick ${w?.tick})`);
    assert.ok(fights >= 2, 'fought the patrol and Si Todak');
    // The patched copy the bot played from is exactly the server's World.
    assert.equal(save(w), save(srv.realm.world(c.you())!));
    c.ws.close();
  } finally { await srv.close(); }
});
