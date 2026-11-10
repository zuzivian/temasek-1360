import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startGameServer } from '../server/game-server.ts';
import { acceptKey, frame, originAllowed, parseFrame } from '../server/ws.ts';
import { PROTOCOL, WS_PATH, type ServerMsg } from '../src/net/protocol.ts';
import { newWorld, save, step, type World } from '../src/sim/world.ts';

type Msg = ServerMsg;

/** A test client on Node's built-in WebSocket that queues messages so the test can await them. */
async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
  const inbox: Msg[] = [];
  const waiters: ((m: Msg) => void)[] = [];
  ws.onmessage = e => { const m = JSON.parse(String(e.data)) as Msg; const w = waiters.shift(); if (w) w(m); else inbox.push(m); };
  await new Promise<void>((ok, fail) => { ws.onopen = () => ok(); ws.onerror = () => fail(new Error('connect failed')); });
  const next = (ms = 2000) => new Promise<Msg>((ok, fail) => {
    const m = inbox.shift();
    if (m) { ok(m); return; }
    const t = setTimeout(() => fail(new Error('timed out waiting for a message')), ms);
    waiters.push(x => { clearTimeout(t); ok(x); });
  });
  const until = async (pred: (m: Msg) => boolean, ms = 3000) => { for (;;) { const m = await next(ms); if (pred(m)) return m; } };
  const send = (o: unknown) => ws.send(typeof o === 'string' ? o : JSON.stringify(o));
  const closed = new Promise<number>(ok => { ws.onclose = e => ok(e.code); });
  return { ws, next, until, send, closed };
}
const stateOf = (m: Msg) => { assert.equal(m.t, 'state'); return m as Extract<Msg, { t: 'state' }>; };

test('server: hello gets a welcome, then a tick about every tickMs', async () => {
  const srv = await startGameServer({ tickMs: 40, seed: () => 77 });
  try {
    const c = await connect(srv.port);
    c.send({ t: 'hello', v: PROTOCOL });
    const welcome = stateOf(await c.until(m => m.t === 'state'));
    assert.equal(welcome.kind, 'welcome');
    assert.deepEqual(welcome.world, newWorld(77), 'a new player gets a fresh world from the server seed');
    const ticks: number[] = [];
    const t0 = Date.now();
    while (ticks.length < 5) { const m = stateOf(await c.next()); if (m.kind === 'tick') ticks.push(m.world.tick); }
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
    c.send({ t: 'hello', v: PROTOCOL, save: save(start) });
    stateOf(await c.until(m => m.t === 'state' && m.kind === 'welcome'));
    c.send({ t: 'intent', it: { t: 'walk', to: { x: 12, y: 27 } } });
    const after = stateOf(await c.until(m => m.t === 'state' && m.kind === 'act'));
    assert.ok(after.world.player.path.length > 0, 'the walk was planned right away');
    // The server's world must equal a local replay of the same intent at the same tick.
    const local: World = structuredClone(start);
    for (let i = 0; i < after.world.tick; i++) step(local, []);
    const { act } = await import('../src/sim/world.ts');
    act(local, { t: 'walk', to: { x: 12, y: 27 } });
    assert.equal(save(after.world), save(local));
    const moved = stateOf(await c.until(m => m.t === 'state' && m.kind === 'tick'));
    assert.ok(moved.world.player.x !== start.player.x || moved.world.player.y !== start.player.y, 'the next tick walks');
    c.ws.close();
  } finally { await srv.close(); }
});

test('server: bad messages get an error and the session survives; floods get disconnected', async () => {
  const srv = await startGameServer({ tickMs: 1000 });
  try {
    const c = await connect(srv.port);
    c.send({ t: 'intent', it: { t: 'close' } });
    assert.deepEqual(await c.next(), { t: 'error', msg: 'send hello first' });
    c.send({ t: 'hello', v: PROTOCOL, save: '{"v":1,"broken":true}' });
    const w = stateOf(await c.next());
    assert.equal(w.world.tick, 0, 'an unreadable save falls back to a new world');
    c.send('{nope');
    assert.deepEqual(await c.next(), { t: 'error', msg: 'bad message' });
    c.send({ t: 'intent', it: { t: 'talk', npc: '__proto__' } });
    assert.deepEqual(await c.next(), { t: 'error', msg: 'bad message' });
    c.send({ t: 'intent', it: { t: 'close' } });
    assert.equal(stateOf(await c.next()).kind, 'act', 'still playing after bad input');
    for (let i = 0; i < 30; i++) c.send('x');
    assert.equal(await c.closed, 1008, 'too many bad messages closes the socket with policy-violation');
  } finally { await srv.close(); }
});

test('server: players are independent and leaving frees the session', async () => {
  const srv = await startGameServer({ tickMs: 30 });
  try {
    const a = await connect(srv.port), b = await connect(srv.port);
    a.send({ t: 'hello', v: PROTOCOL, seed: 1 });
    b.send({ t: 'hello', v: PROTOCOL, seed: 2 });
    await a.until(m => m.t === 'state'); await b.until(m => m.t === 'state');
    a.send({ t: 'intent', it: { t: 'walk', to: { x: 12, y: 27 } } });
    const wa = stateOf(await a.until(m => m.t === 'state' && m.kind === 'act')).world;
    const wb = stateOf(await b.until(m => m.t === 'state' && m.kind === 'tick')).world;
    assert.ok(wa.player.path.length > 0 && wb.player.path.length === 0);
    assert.equal(srv.sessions(), 2);
    b.ws.close(); await b.closed;
    for (let i = 0; i < 50 && srv.sessions() !== 1; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(srv.sessions(), 1);
    a.ws.close();
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
    c.send({ t: 'hello', v: PROTOCOL, seed: 4 });
    const mind = { sold: false };
    let inflight = 0, w: World | null = null, fights = 0;
    for (let n = 0; n < 40000; n++) {
      const m = stateOf(await c.next(5000));
      if (m.kind === 'act') inflight--;
      if (m.ev.some(e => e.t === 'combatEnd')) fights++;
      w = m.world;
      if (act1Done(w)) break;
      // Like a real client: act on fresh state only, never on a tick that crossed our own intent.
      if (inflight > 0) continue;
      for (const it of decide(w, mind)) { c.send({ t: 'intent', it }); inflight++; }
    }
    assert.ok(w && act1Done(w), `finished Act 1 over the socket (step ${w?.step}, tick ${w?.tick})`);
    assert.ok(fights >= 2, 'fought the patrol and Si Todak');
    c.ws.close();
  } finally { await srv.close(); }
});
