import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameHost, MAX_INTENTS_PER_TICK, replay } from '../src/net/host.ts';
import { PROTOCOL, parseClientMsg, parseIntent } from '../src/net/protocol.ts';
import { newWorld, save } from '../src/sim/world.ts';

test('host: tick() advances one step and intents apply at once without moving time', () => {
  const h = new GameHost(newWorld(5));
  assert.equal(h.world.tick, 0);
  h.tick(); h.tick();
  assert.equal(h.world.tick, 2);
  const ev = h.submit({ t: 'talk', npc: 'lawak' })!;
  assert.ok(Array.isArray(ev));
  assert.equal(h.world.tick, 2, 'an intent does not advance time');
  assert.ok(h.world.player.task?.t === 'talk', 'the intent took effect immediately');
  for (let i = 0; i < 40 && !h.world.dialog; i++) h.tick();
  assert.ok(h.world.dialog, 'walking up to Pak Lawak opens the dialogue on a later tick');
});

test('host: a recorded session replays to the identical world', () => {
  const start = newWorld(42);
  const h = new GameHost(structuredClone(start), { record: true });
  h.submit({ t: 'talk', npc: 'lawak' });
  for (let i = 0; i < 300; i++) {
    const w = h.world;
    if (w.dialog) h.submit({ t: 'say', option: 0 });
    else if (w.step >= 1 && !w.player.task) h.submit({ t: 'fish', spot: 0 });
    h.tick();
  }
  assert.ok(h.world.fishCaught > 0, 'the session did something worth replaying');
  assert.equal(save(replay(start, h.log!)), save(h.world));
});

test('host: intents beyond the per-tick limit are dropped until the next tick', () => {
  const h = new GameHost(newWorld(1));
  for (let i = 0; i < MAX_INTENTS_PER_TICK; i++) assert.ok(h.submit({ t: 'close' }));
  assert.equal(h.submit({ t: 'close' }), null);
  h.tick();
  assert.ok(h.submit({ t: 'close' }), 'the budget resets every tick');
});

test('protocol: well-formed intents pass through as clean copies', () => {
  const ok = [
    { t: 'walk', to: { x: 3, y: 4 } }, { t: 'fish', spot: 1 }, { t: 'talk', npc: 'rahmah' }, { t: 'say', option: 2 },
    { t: 'sell', slot: 0 }, { t: 'sellAll', item: 'kembung' }, { t: 'buy', item: 'joran' }, { t: 'buy', item: 'jamu' },
    { t: 'close' }, { t: 'drink' },
    { t: 'combat', it: { t: 'step', to: { x: 1, y: 2 } } }, { t: 'combat', it: { t: 'use', ability: 'ombak', target: 'p1', grade: 'perfect' } },
    { t: 'combat', it: { t: 'end' } }, { t: 'combat', it: { t: 'dodge', grade: 'good' } }
  ];
  for (const it of ok) assert.deepEqual(parseIntent(it), it, JSON.stringify(it));
  assert.deepEqual(parseIntent({ t: 'walk', to: { x: 1, y: 2, evil: true }, extra: 1 }), { t: 'walk', to: { x: 1, y: 2 } });
});

test('protocol: malformed intents are rejected, never passed to the sim', () => {
  const bad: unknown[] = [
    null, 7, 'walk', [], {}, { t: 'teleport' }, { t: 'walk' }, { t: 'walk', to: { x: 1.5, y: 2 } }, { t: 'walk', to: { x: '1', y: 2 } },
    { t: 'fish', spot: -1 }, { t: 'talk', npc: 'nobody' }, { t: 'talk', npc: '__proto__' }, { t: 'talk', npc: 'toString' },
    { t: 'sell', slot: 1e9 }, { t: 'buy', item: 'constructor' }, { t: 'combat' }, { t: 'combat', it: { t: 'use', ability: 'ombak', target: 'p1', grade: 'great' } },
    { t: 'combat', it: { t: 'use', ability: 'nuke', target: 'p1', grade: 'none' } }, { t: 'combat', it: { t: 'win' } }
  ];
  for (const it of bad) assert.equal(parseIntent(it), null, JSON.stringify(it));
});

test('protocol: client messages', () => {
  assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'hello', v: PROTOCOL, seed: 9 })), { t: 'hello', v: PROTOCOL, seed: 9 });
  assert.equal(parseClientMsg(JSON.stringify({ t: 'hello', v: PROTOCOL + 1 })), null, 'wrong protocol version');
  assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'intent', it: { t: 'close' } })), { t: 'intent', it: { t: 'close' } });
  assert.equal(parseClientMsg(JSON.stringify({ t: 'intent', it: { t: 'nope' } })), null);
  assert.equal(parseClientMsg('{not json'), null);
  assert.equal(parseClientMsg('"hello"'), null);
});

test('client link: loopback hands back the same world object; server URLs come from ?server', async () => {
  const { LoopbackLink, serverUrl } = await import('../src/client/net.ts');
  const w = newWorld(8);
  const seen: string[] = [];
  const link = new LoopbackLink(w, u => { assert.equal(u.world, w, 'offline play mutates one world in place'); seen.push(u.kind); });
  link.send({ t: 'talk', npc: 'lawak' });
  link.tick();
  assert.deepEqual(seen, ['act', 'tick']);
  assert.equal(w.tick, 1);
  const loc = (search: string, protocol = 'http:') => ({ search, host: 'localhost:8080', protocol });
  assert.equal(serverUrl(loc('')), null, 'no parameter: offline');
  assert.equal(serverUrl(loc('?server')), 'ws://localhost:8080/ws');
  assert.equal(serverUrl(loc('?server', 'https:')), 'wss://localhost:8080/ws');
  assert.equal(serverUrl(loc('?server=127.0.0.1:9000')), 'ws://127.0.0.1:9000/ws');
  assert.equal(serverUrl(loc('?server=ws://box:1/ws')), 'ws://box:1/ws');
});

// ---------- step 2: shared realm, interest, deltas ----------
import { applyPatch, diff } from '../src/net/delta.ts';
import { FORGET_RADIUS, MAX_PLAYERS, Realm, SEE_RADIUS } from '../src/net/realm.ts';
import { Mirror, Outbox } from '../src/net/sync.ts';
import type { Intent, World } from '../src/sim/world.ts';

const roundTrip = (a: unknown, b: unknown) => {
  const p = diff(a, b);
  const out = p ? applyPatch(structuredClone(a), JSON.parse(JSON.stringify(p))) : structuredClone(a);
  assert.deepEqual(out, b, `${JSON.stringify(a)} -> ${JSON.stringify(b)} via ${JSON.stringify(p)}`);
  return p;
};

test('delta: diff then applyPatch rebuilds the target, and equal values give no patch', () => {
  assert.equal(diff({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }), null);
  assert.equal(diff(newWorld(3), newWorld(3)), null);
  roundTrip({ a: 1 }, { a: 2 });
  roundTrip({ a: 1, gone: true }, { a: 1 });
  roundTrip({ a: 1 }, { a: 1, added: { deep: [1] } });
  roundTrip({ a: null }, { a: { x: 1 } });
  roundTrip({ a: { x: 1 } }, { a: null });
  roundTrip({ p: [{ x: 1 }, { x: 2 }] }, { p: [{ x: 2 }] });
  roundTrip({ p: [1, 2, 3] }, { p: 'str' });
  roundTrip(Array(100).fill(0), Array(100).fill(0).map((v, i) => (i === 7 ? 1 : v)));
  // Undefined-valued keys count as absent, as in JSON.
  assert.equal(diff({ a: 1, c: undefined }, { a: 1 }), null);
  roundTrip({ a: 1 }, { a: 1, c: 5 });
  // Revealing a few fog tiles patches just those tiles, not the whole map.
  const w0 = newWorld(3), w1 = structuredClone(w0);
  w1.explored[100] = 1; w1.explored[200] = 1; w1.tick = 1;
  const p = roundTrip(w0, w1)!;
  assert.ok(JSON.stringify(p).length < 80, JSON.stringify(p));
});

test('delta: patches cannot write through prototype keys', () => {
  const evil = JSON.parse('{"o":{"__proto__":{"s":{"polluted":true}}}}');
  assert.throws(() => applyPatch({}, evil));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.throws(() => applyPatch([1, 2], { a: [[5, { s: 1 }]] }), /out of range/);
  assert.throws(() => applyPatch(3, { o: { a: { s: 1 } } }), /expected an object/);
});

/** A small scripted session: talk to Pak Lawak, page through, then fish or walk. */
function scripted(w: World, flavour: number): Intent[] {
  if (w.dialog) return [{ t: 'say', option: 0 }];
  if (w.step === 0 && !w.player.task) return [{ t: 'talk', npc: 'lawak' }];
  if (w.step >= 1 && !w.player.task && !w.player.path.length) return [flavour % 2 ? { t: 'fish', spot: 0 } : { t: 'walk', to: { x: 12 + (w.tick % 5), y: 26 } }];
  return [];
}

test('realm: each player evolves exactly as a solo game would (deterministic, no interference)', () => {
  const realm = new Realm();
  const seeds = [11, 12, 13];
  const ids = seeds.map(s => realm.join(newWorld(s))!);
  const solo = seeds.map(s => new GameHost(newWorld(s)));
  for (let t = 0; t < 400; t++) {
    ids.forEach((id, i) => { for (const it of scripted(realm.world(id)!, i)) realm.submit(id, it); });
    solo.forEach((h, i) => { for (const it of scripted(h.world, i)) h.submit(it); });
    realm.tick();
    solo.forEach(h => h.tick());
  }
  ids.forEach((id, i) => assert.equal(save(realm.world(id)!), save(solo[i].world), `player ${id}`));
  assert.ok(realm.world(ids[1])!.fishCaught > 0, 'the fisher fished');
});

test('realm: who sees whom, with a margin so people at the edge do not flicker', () => {
  const realm = new Realm();
  const a = realm.join(newWorld(1))!, b = realm.join(newWorld(2))!;
  const put = (id: number, x: number, y: number) => { const p = realm.world(id)!.player; p.x = x; p.y = y; };
  put(a, 10, 20); put(b, 10 + SEE_RADIUS, 20);
  assert.deepEqual(realm.visibleTo(a), [b]);
  assert.deepEqual(realm.visibleTo(b), [a], 'seeing is mutual');
  put(b, 10 + SEE_RADIUS + 1, 20);
  assert.deepEqual(realm.visibleTo(a), [], 'a stranger just past the radius is not shown');
  assert.deepEqual(realm.visibleTo(a, new Set([b])), [b], 'someone already seen stays until FORGET_RADIUS');
  put(b, 10 + FORGET_RADIUS + 1, 20);
  assert.deepEqual(realm.visibleTo(a, new Set([b])), []);
  realm.world(b)!.player.fishing = true; realm.world(b)!.player.task = { t: 'fish', spot: 2 };
  assert.deepEqual(realm.avatar(b), { id: b, x: 10 + FORGET_RADIUS + 1, y: 20, facing: 1, fishing: 2 });
  realm.leave(b);
  assert.equal(realm.avatar(b), null);
  assert.equal(realm.size, 1);
});

test('realm: refuses players beyond MAX_PLAYERS', () => {
  const realm = new Realm();
  for (let i = 0; i < MAX_PLAYERS; i++) assert.ok(realm.join(newWorld(i)) !== null);
  assert.equal(realm.join(newWorld(0)), null);
});

test('sync: a Mirror fed only deltas stays identical to the server through all of Act 1', async () => {
  const { decide, act1Done } = await import('./bot.ts');
  const realm = new Realm();
  const me = realm.join(newWorld(4))!;
  const other = realm.join(newWorld(5))!;
  const out = new Outbox(realm, me);
  const wire = <T>(m: T): T => JSON.parse(JSON.stringify(m)) as T;
  const mirror = new Mirror(wire(out.welcome()));
  const mind = { sold: false };
  let bytes = 0, whole = 0, msgs = 0;
  for (let t = 0; t < 20000 && !act1Done(realm.world(me)!); t++) {
    for (const it of decide(mirror.world, mind)) {
      const ev = realm.submit(me, it)!;
      mirror.apply(wire(out.update('act', ev)));
    }
    // The other player wanders, coming in and out of view.
    if (t % 40 === 0) realm.submit(other, { t: 'walk', to: t % 80 ? { x: 40, y: 12 } : { x: 12, y: 27 } });
    const evs = realm.tick();
    const m = out.update('tick', evs.get(me)!);
    const text = JSON.stringify(m);
    bytes += text.length; whole += JSON.stringify({ t: 'state', kind: 'tick', world: realm.world(me), ev: m.ev ?? [] }).length; msgs++;
    const u = mirror.apply(JSON.parse(text));
    assert.deepEqual(u.others.map(o => o.id), out.sees());
    if (t % 25 === 0) assert.equal(save(mirror.world), save(realm.world(me)!), `drifted at tick ${realm.world(me)!.tick}`);
  }
  assert.ok(act1Done(realm.world(me)!), 'finished Act 1 from the mirrored copy');
  assert.equal(save(mirror.world), save(realm.world(me)!));
  assert.ok(bytes * 10 < whole, `deltas: ${bytes} bytes over ${msgs} ticks, against ${whole} for whole Worlds`);
});

test('client link: offline play shows nobody else', async () => {
  const { LoopbackLink } = await import('../src/client/net.ts');
  const seen: number[] = [];
  const link = new LoopbackLink(newWorld(1), u => seen.push(u.others.length));
  link.tick(); link.send({ t: 'close' });
  assert.deepEqual(seen, [0, 0]);
});
