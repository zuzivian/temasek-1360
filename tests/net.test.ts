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
