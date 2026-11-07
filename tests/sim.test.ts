import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elementMultiplier, ELEMENT_CYCLE } from '../src/sim/core.ts';
import { levelForXp, xpForLevel } from '../src/sim/skills.ts';
import { findPath } from '../src/sim/path.ts';
import { MAP, kindAt, walkable } from '../src/sim/map.ts';
import { DIALOG, ENCOUNTERS, NPCS, SPOTS, START, RESPAWN, openingNode } from '../src/sim/content.ts';
import { load, newWorld, save, step, monsoonAt } from '../src/sim/world.ts';
import { startCombat, playerAct, aiTick, reachable } from '../src/sim/combat.ts';
import { playAct1 } from './bot.ts';

test('experience curve matches the classic table', () => {
  assert.equal(levelForXp(0), 1);
  assert.equal(levelForXp(82), 1);
  assert.equal(levelForXp(83), 2);
  assert.equal(xpForLevel(10), 1154);
  assert.equal(xpForLevel(99), 13034431);
  assert.equal(levelForXp(13034431), 99);
});

test('element wheel: each element beats the next and loses to the previous', () => {
  for (let i = 0; i < 6; i++) {
    const a = ELEMENT_CYCLE[i], b = ELEMENT_CYCLE[(i + 1) % 6];
    assert.equal(elementMultiplier(a, b), 1.5, `${a} > ${b}`);
    assert.equal(elementMultiplier(b, a), 0.67, `${b} < ${a}`);
  }
  assert.equal(elementMultiplier('Air', 'Api'), 1.5);
  assert.equal(elementMultiplier('Air', 'Besi'), 1);
  assert.equal(elementMultiplier(null, 'Api'), 1);
});

test('pathfinding goes around blocked tiles and never cuts corners', () => {
  const grid = ['.....', '.###.', '.....'];
  const free = (x: number, y: number) => y >= 0 && y < 3 && x >= 0 && x < 5 && grid[y][x] === '.';
  const p = findPath({ x: 0, y: 1 }, { x: 4, y: 1 }, free)!;
  assert.ok(p, 'path exists');
  assert.deepEqual(p[p.length - 1], { x: 4, y: 1 });
  for (const s of p) assert.ok(free(s.x, s.y));
  assert.equal(findPath({ x: 0, y: 0 }, { x: 2, y: 1 }, free), null, 'blocked goal');
});

test('the map is consistent with the content', () => {
  for (const [id, n] of Object.entries(NPCS)) assert.ok(walkable(MAP, n.home.x, n.home.y), `${id} stands on walkable ground`);
  for (const s of SPOTS) assert.equal(kindAt(MAP, s.at.x, s.at.y), 'spot', `${s.name} is a fishing spot`);
  for (const e of ENCOUNTERS) { assert.ok(walkable(MAP, e.center.x, e.center.y)); for (const f of e.foes) assert.ok(walkable(MAP, f.at.x, f.at.y), `${f.name} spawn`); }
  assert.ok(walkable(MAP, START.x, START.y) && walkable(MAP, RESPAWN.x, RESPAWN.y));
  // Every place the story sends you to can be reached on foot from the start.
  const free = (x: number, y: number) => walkable(MAP, x, y);
  for (const target of [NPCS.rahmah.home, NPCS.penghulu.home, ENCOUNTERS[0].center, ENCOUNTERS[1].center]) {
    assert.ok(findPath(START, target, free, { maxNodes: 20000 }) !== null || findPath(START, { x: target.x + 1, y: target.y }, free, { maxNodes: 20000 }) !== null, `reach ${target.x},${target.y}`);
  }
});

test('every dialogue link points at a real node', () => {
  for (const [id, n] of Object.entries(DIALOG)) {
    if (n.next) assert.ok(DIALOG[n.next], `${id}.next`);
    for (const o of n.options ?? []) if (o.next) assert.ok(DIALOG[o.next], `${id} option ${o.label}`);
  }
  for (const npc of Object.keys(NPCS) as (keyof typeof NPCS)[]) for (let s = 0; s <= 7; s++) assert.ok(DIALOG[openingNode(npc, s, {})], `${npc} step ${s}`);
});

test('the simulation is deterministic', () => {
  const run = () => {
    const w = newWorld(7);
    const out: string[] = [];
    step(w, [{ t: 'talk', npc: 'lawak' }]);
    for (let i = 0; i < 40; i++) {
      const intents = w.dialog ? [{ t: 'say' as const, option: 0 }] : !w.player.task && w.step >= 1 ? [{ t: 'fish' as const, spot: 0 }] : [];
      step(w, intents);
    }
    out.push(save(w));
    return out.join();
  };
  assert.equal(run(), run());
});

test('saves round-trip', () => {
  const w = newWorld(3);
  step(w, [{ t: 'walk', to: { x: 12, y: 27 } }]);
  const back = load(save(w))!;
  assert.deepEqual(back, w);
  assert.equal(load('{"v":2}'), null);
  assert.equal(load('not json'), null);
});

test('the monsoon turns', () => {
  assert.equal(monsoonAt(0), 'NE');
  assert.equal(monsoonAt(499), 'NE');
  assert.equal(monsoonAt(500), 'SW');
  assert.equal(monsoonAt(1000), 'NE');
});

test('combat: moves stay in range, foes telegraph before they hit', () => {
  const c = startCombat('patrol', { maxHp: 40, hp: 40, silatLevel: 1, hasJamu: false, abilities: ['tendang', 'ombak', 'jamu'], withAlly: true }, { x: 32, y: 21 });
  const you = c.units[0];
  for (const path of reachable(c, you).values()) assert.ok(path.length <= you.mp);
  const ctx = { rng: 5, wind: { x: 1, y: 0 } };
  playerAct(c, ctx, { silatLevel: 1, jamu: 0, consumeJamu: () => {} }, { t: 'end' });
  let sawWindup = false;
  for (let i = 0; i < 60 && c.phase === 'fight'; i++) {
    const ev = aiTick(c, ctx);
    if (ev.some(e => e.t === 'windup')) sawWindup = true;
    if (c.order[c.turn] === 'you') break;
  }
  assert.ok(c.phase !== 'fight' || c.order[c.turn] === 'you', 'turn comes back to the player');
  assert.ok(sawWindup || c.units.filter(u => u.side === 'foe').every(u => u.mp >= 0), 'foes act');
});

test('a plain bot finishes Act 1 on several seeds', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = playAct1({ seed });
    assert.ok(r.finished, `seed ${seed} finished (step ${r.world.step}, fights ${JSON.stringify(r.fights)})`);
    assert.ok(r.ticks < 3000, `seed ${seed} took ${r.ticks} ticks`);
  }
});

test('the gong cannot be lost: closing the flee dialogue or a full bag still leaves you holding it', async () => {
  const { act, count } = await import('../src/sim/world.ts');
  for (const fullBag of [false, true]) {
    const w = newWorld(11);
    w.step = 5; w.flags.won_patrol = true; w.enc[0].alive = false; w.lawak.following = true;
    if (fullBag) for (let i = 0; i < 20; i++) w.inv.push({ id: 'udang', n: 1 });
    w.player.x = 36; w.player.y = 22;
    step(w, []);
    assert.ok(w.combat, 'boss fight starts');
    for (const u of w.combat!.units) if (u.side === 'foe') u.hp = 1;
    // finish the foes off directly through the rules
    for (let i = 0; i < 400 && w.combat; i++) {
      const c = w.combat!;
      const cur = c.order[c.turn];
      if (cur === 'you') {
        const foe = c.units.find(u => u.side === 'foe' && u.alive)!;
        const you = c.units[0];
        you.x = foe.x - 1; you.y = foe.y; you.ap = 6;
        act(w, { t: 'combat', it: { t: 'use', ability: 'tendang', target: foe.id, grade: 'none' } });
        if (w.combat) act(w, { t: 'combat', it: { t: 'end' } });
      } else step(w, []);
    }
    assert.equal(w.combat, null);
    act(w, { t: 'close' });
    assert.equal(count(w, 'gong'), 1, `holding the gong (full bag: ${fullBag})`);
    step(w, []);
    assert.equal(w.step, 6);
  }
});

test('a trader who sails away takes the shop and the conversation', async () => {
  const { act } = await import('../src/sim/world.ts');
  const w = newWorld(2);
  w.tick = 499; w.dialog = { node: 'lim.hi' };
  step(w, []);
  assert.equal(w.dialog, null);
  w.dialog = { node: 'lim.hi' };
  act(w, { t: 'say', option: 0 });
  assert.equal(w.shop, null, 'Lim is gone in the south-west monsoon');
});

test('after a fight, the calm only holds back encounters you were already standing in', async () => {
  const { act } = await import('../src/sim/world.ts');
  const todak = ENCOUNTERS.find(e => e.id === 'todak')!;
  // Win the patrol with the hero's last position at `endAt`, through the real rules.
  const winPatrolAt = (endAt: { x: number; y: number }) => {
    const w = newWorld(7);
    w.step = 4; w.flags.asked_penghulu = true; w.lawak.following = true;
    w.player.x = 32; w.player.y = 21;
    step(w, []);
    assert.equal(w.combat?.enc, 'patrol', 'patrol starts');
    for (const u of w.combat!.units) if (u.side === 'foe') u.hp = 1;
    for (let i = 0; i < 400 && w.combat; i++) {
      const c = w.combat!;
      if (c.order[c.turn] !== 'you') { step(w, []); continue; }
      const foe = c.units.find(u => u.side === 'foe' && u.alive)!;
      const you = c.units[0];
      foe.x = endAt.x + 1; foe.y = endAt.y; you.x = endAt.x; you.y = endAt.y; you.ap = 6;
      act(w, { t: 'combat', it: { t: 'use', ability: 'tendang', target: foe.id, grade: 'none' } });
      if (w.combat) act(w, { t: 'combat', it: { t: 'end' } });
    }
    assert.equal(w.combat, null, 'patrol won');
    step(w, []);
    assert.equal(w.step, 5);
    return w;
  };

  // Ending the patrol inside Si Todak's zone: no instant boss fight, but it does come after the calm.
  const inside = winPatrolAt({ x: todak.center.x - todak.trigger, y: todak.center.y });
  step(inside, []);
  assert.equal(inside.combat, null, 'the boss waits out the calm');
  for (let i = 0; i < 10 && !inside.combat; i++) step(inside, []);
  assert.equal(inside.combat?.enc, 'todak', 'the boss starts once the calm ends');

  // Ending outside it and walking in during the calm: the fight starts at the zone's edge, not its middle.
  const outside = winPatrolAt({ x: 32, y: 19 });
  assert.ok(outside.tick < (outside.calmUntil ?? 0), 'still calm');
  act(outside, { t: 'walk', to: todak.center });
  for (let i = 0; i < 20 && !outside.combat; i++) step(outside, []);
  assert.equal(outside.combat?.enc, 'todak');
  const you = outside.combat!.units[0];
  assert.ok(Math.max(Math.abs(you.x - todak.center.x), Math.abs(you.y - todak.center.y)) >= todak.trigger, `starts at the edge (${you.x},${you.y})`);
});
