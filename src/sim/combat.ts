// Turn-based grid combat fought on the world tiles themselves (as in Dofus and the Voya Nui game).
// Each unit has action points (AP) for abilities and movement points (MP) for steps.
// Timing helps but never fails you: a well-timed press makes a hit stronger or a blow softer.
import { ABILITIES, ENCOUNTERS, type AbilityId, type EncounterSpec, type Look } from './content.ts';
import { elementMultiplier, manhattan, rngInt, type Element, type Vec } from './core.ts';
import { MAP, walkable } from './map.ts';

export type Grade = 'perfect' | 'good' | 'none';
export const ATTACK_GRADE: Record<Grade, number> = { perfect: 1.25, good: 1.1, none: 1 };
export const DODGE_GRADE: Record<Grade, number> = { perfect: 0.6, good: 0.8, none: 1 };

export type Unit = {
  id: string; name: string; side: 'hero' | 'foe'; ctrl: 'player' | 'ai';
  look: Look; el: Element; x: number; y: number;
  hp: number; maxHp: number; ap: number; mp: number; apMax: number; mpMax: number;
  abilities: AbilityId[]; used: AbilityId[]; boss: boolean; alive: boolean; facing: 1 | -1;
};

export type Windup = { unit: string; ability: AbilityId; target: string; dodge: Grade };

export type CombatState = {
  enc: EncounterSpec['id'];
  box: { x0: number; y0: number; x1: number; y1: number };
  units: Unit[];
  order: string[];
  turn: number;
  round: number;
  phase: 'fight' | 'won' | 'lost';
  windup: Windup | null;
  /** Ticks to wait before the next AI action, so the player can read what happened. */
  wait: number;
};

export type CombatEvent =
  | { t: 'turn'; unit: string }
  | { t: 'move'; unit: string; path: Vec[] }
  | { t: 'windup'; unit: string; ability: AbilityId; target: string }
  | { t: 'hit'; unit: string; target: string; ability: AbilityId; dmg: number; mult: number; grade: Grade; dodge: Grade }
  | { t: 'heal'; unit: string; amount: number }
  | { t: 'down'; unit: string }
  | { t: 'end'; won: boolean };

export type HeroStats = { maxHp: number; hp: number; silatLevel: number; hasJamu: boolean; abilities: AbilityId[]; withAlly: boolean };

export type Ctx = { rng: number; wind: Vec };

export function startCombat(encId: EncounterSpec['id'], hero: HeroStats, at: Vec): CombatState {
  const spec = ENCOUNTERS.find(e => e.id === encId)!;
  const box = {
    x0: Math.max(0, spec.center.x - 6), y0: Math.max(0, spec.center.y - 5),
    x1: Math.min(MAP.w - 1, spec.center.x + 5), y1: Math.min(MAP.h - 1, spec.center.y + 5)
  };
  const start = inBox(box, at) && walkable(MAP, at.x, at.y) ? { ...at } : nearestFree(box, { x: box.x0, y: spec.center.y }, []);
  const units: Unit[] = [{
    id: 'you', name: 'You', side: 'hero', ctrl: 'player', look: 'hero', el: 'Air', x: start.x, y: start.y,
    hp: hero.hp, maxHp: hero.maxHp, ap: 6, mp: 3, apMax: 6, mpMax: 3, abilities: hero.abilities, used: [], boss: false, alive: true, facing: 1
  }];
  if (hero.withAlly) {
    const p = nearestFree(box, { x: start.x - 1, y: start.y + 1 }, units);
    units.push({ id: 'lawak', name: 'Pak Lawak', side: 'hero', ctrl: 'ai', look: 'clown', el: 'Api', x: p.x, y: p.y, hp: 30, maxHp: 30, ap: 4, mp: 3, apMax: 4, mpMax: 3, abilities: ['cabai'], used: [], boss: false, alive: true, facing: 1 });
  }
  spec.foes.forEach((f, i) => {
    const p = nearestFree(box, f.at, units);
    units.push({ id: `foe${i}`, name: f.name, side: 'foe', ctrl: 'ai', look: f.look, el: f.el, x: p.x, y: p.y, hp: f.hp, maxHp: f.hp, ap: f.ap, mp: f.mp, apMax: f.ap, mpMax: f.mp, abilities: f.abilities, used: [], boss: !!f.boss, alive: true, facing: -1 });
  });
  return { enc: encId, box, units, order: units.map(u => u.id), turn: 0, round: 1, phase: 'fight', windup: null, wait: 1 };
}

export const unitById = (c: CombatState, id: string): Unit | undefined => c.units.find(u => u.id === id);
export const current = (c: CombatState): Unit => unitById(c, c.order[c.turn])!;
export const inBox = (b: CombatState['box'], p: Vec): boolean => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;

function occupied(units: Unit[], x: number, y: number, except?: string): boolean {
  return units.some(u => u.alive && u.id !== except && u.x === x && u.y === y);
}
function nearestFree(box: CombatState['box'], p: Vec, units: Unit[]): Vec {
  for (let r = 0; r < 12; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    const q = { x: p.x + dx, y: p.y + dy };
    if (inBox(box, q) && walkable(MAP, q.x, q.y) && !occupied(units, q.x, q.y)) return q;
  }
  return { x: box.x0, y: box.y0 };
}

/** Tiles the unit can step on this turn (4-way moves, as in Dofus), within its MP. */
export function reachable(c: CombatState, u: Unit): Map<string, Vec[]> {
  const out = new Map<string, Vec[]>();
  const free = (x: number, y: number) => inBox(c.box, { x, y }) && walkable(MAP, x, y) && !occupied(c.units, x, y, u.id);
  const frontier: { p: Vec; path: Vec[] }[] = [{ p: { x: u.x, y: u.y }, path: [] }];
  const seen = new Set([`${u.x},${u.y}`]);
  while (frontier.length) {
    const { p, path } = frontier.shift()!;
    if (path.length >= u.mp) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const q = { x: p.x + dx, y: p.y + dy }, k = `${q.x},${q.y}`;
      if (seen.has(k) || !free(q.x, q.y)) continue;
      seen.add(k);
      const np = [...path, q];
      out.set(k, np);
      frontier.push({ p: q, path: np });
    }
  }
  return out;
}

/** Max range including the monsoon: ranged attacks thrown downwind reach one tile further. */
export function maxRange(ab: AbilityId, from: Vec, to: Vec, wind: Vec): number {
  const a = ABILITIES[ab];
  if (!a.ranged) return a.max;
  const dx = to.x - from.x, dy = to.y - from.y, m = Math.hypot(dx, dy) || 1;
  return (dx * wind.x + dy * wind.y) / m > 0.5 ? a.max + 1 : a.max;
}
export function downwind(from: Vec, to: Vec, wind: Vec): boolean {
  const dx = to.x - from.x, dy = to.y - from.y, m = Math.hypot(dx, dy) || 1;
  return (dx * wind.x + dy * wind.y) / m > 0.5;
}

export function canUse(c: CombatState, u: Unit, ab: AbilityId, target: Unit, ctx: { wind: Vec; hasJamu?: boolean }): boolean {
  const a = ABILITIES[ab];
  if (!u.alive || !target.alive || u.ap < a.ap) return false;
  if (a.oncePerFight && u.used.includes(ab)) return false;
  if (a.consumes && !ctx.hasJamu) return false;
  if (a.self) return target.id === u.id && !(a.heal && u.hp >= u.maxHp);
  if (target.side === u.side) return false;
  const d = manhattan(u, target);
  if (a.line && u.x !== target.x && u.y !== target.y) return false;
  return d >= a.min && d <= maxRange(ab, u, target, ctx.wind);
}

function heroLevelBonus(u: Unit, silatLevel: number): number {
  return u.ctrl === 'player' ? 1 + (silatLevel - 1) * 0.03 : 1;
}

function applyHit(c: CombatState, ctx: Ctx, u: Unit, ab: AbilityId, target: Unit, grade: Grade, dodge: Grade, silatLevel: number, ev: CombatEvent[]): number {
  const a = ABILITIES[ab];
  const hitOne = (t: Unit) => {
    const mult = elementMultiplier(a.el, t.el);
    const dmg = Math.max(1, Math.round(rngInt(ctx, a.dmg[0], a.dmg[1]) * mult * ATTACK_GRADE[grade] * DODGE_GRADE[dodge] * heroLevelBonus(u, silatLevel)));
    t.hp = Math.max(0, t.hp - dmg);
    ev.push({ t: 'hit', unit: u.id, target: t.id, ability: ab, dmg, mult, grade, dodge });
    if (t.hp === 0) { t.alive = false; ev.push({ t: 'down', unit: t.id }); }
    return dmg;
  };
  u.facing = target.x - u.x + (target.y - u.y) >= 0 ? 1 : -1;
  let total = hitOne(target);
  if (a.aoeAdjacent) for (const o of c.units) if (o !== target && o.alive && o.side !== u.side && manhattan(u, o) === 1) total += hitOne(o);
  return total;
}

function checkEnd(c: CombatState, ev: CombatEvent[]): void {
  if (c.phase !== 'fight') return;
  if (!c.units.some(u => u.side === 'foe' && u.alive)) { c.phase = 'won'; ev.push({ t: 'end', won: true }); }
  else if (!unitById(c, 'you')!.alive) { c.phase = 'lost'; ev.push({ t: 'end', won: false }); }
}

function nextTurn(c: CombatState, ev: CombatEvent[]): void {
  for (let i = 0; i < c.order.length; i++) {
    c.turn = (c.turn + 1) % c.order.length;
    if (c.turn === 0) c.round++;
    const u = current(c);
    if (u.alive) { u.ap = u.apMax; u.mp = u.mpMax; ev.push({ t: 'turn', unit: u.id }); c.wait = u.ctrl === 'ai' ? 1 : 0; return; }
  }
}

// ---------- player intents ----------
export type CombatIntent =
  | { t: 'step'; to: Vec }
  | { t: 'use'; ability: AbilityId; target: string; grade: Grade }
  | { t: 'end' }
  | { t: 'dodge'; grade: Grade };

export type PlayerSide = { silatLevel: number; jamu: number; consumeJamu: () => void };

/** Apply one player intent. Returns events; ignores anything illegal. */
export function playerAct(c: CombatState, ctx: Ctx, side: PlayerSide, it: CombatIntent): CombatEvent[] {
  const ev: CombatEvent[] = [];
  if (c.phase !== 'fight') return ev;
  if (it.t === 'dodge') { if (c.windup && c.windup.target === 'you' && c.windup.dodge === 'none') c.windup.dodge = it.grade; return ev; }
  const u = current(c);
  if (u.ctrl !== 'player') return ev;
  if (it.t === 'step') {
    const path = reachable(c, u).get(`${it.to.x},${it.to.y}`);
    if (!path) return ev;
    u.facing = it.to.x - u.x + (it.to.y - u.y) >= 0 ? 1 : -1;
    u.x = it.to.x; u.y = it.to.y; u.mp -= path.length;
    ev.push({ t: 'move', unit: u.id, path });
  } else if (it.t === 'use') {
    const target = unitById(c, it.target);
    if (!target || !canUse(c, u, it.ability, target, { wind: ctx.wind, hasJamu: side.jamu > 0 })) return ev;
    const a = ABILITIES[it.ability];
    u.ap -= a.ap;
    if (a.oncePerFight) u.used.push(it.ability);
    if (a.heal) {
      side.consumeJamu();
      const amount = Math.min(a.heal, u.maxHp - u.hp);
      u.hp += amount;
      ev.push({ t: 'heal', unit: u.id, amount });
    } else applyHit(c, ctx, u, it.ability, target, it.grade, 'none', side.silatLevel, ev);
    checkEnd(c, ev);
  } else if (it.t === 'end') {
    nextTurn(c, ev);
  }
  return ev;
}

// ---------- AI, one action per tick ----------
export function aiTick(c: CombatState, ctx: Ctx): CombatEvent[] {
  const ev: CombatEvent[] = [];
  if (c.phase !== 'fight') return ev;
  const u = current(c);
  if (u.ctrl !== 'ai') return ev;
  if (c.wait > 0) { c.wait--; return ev; }
  if (!u.alive) { nextTurn(c, ev); return ev; }

  // A telegraphed attack lands one tick after it was announced, so the player can time a dodge.
  if (c.windup && c.windup.unit === u.id) {
    const w = c.windup; c.windup = null;
    const target = unitById(c, w.target);
    if (target && target.alive) {
      u.ap -= ABILITIES[w.ability].ap;
      applyHit(c, ctx, u, w.ability, target, 'none', w.dodge, 1, ev);
      if (ABILITIES[w.ability].oncePerFight) u.used.push(w.ability);
    }
    checkEnd(c, ev);
    c.wait = 1;
    return ev;
  }

  const enemies = c.units.filter(o => o.alive && o.side !== u.side);
  if (!enemies.length) { checkEnd(c, ev); return ev; }
  // Prefer the player, then the weakest target.
  const ranked = [...enemies].sort((a, b) => (a.ctrl === 'player' ? -1 : 0) - (b.ctrl === 'player' ? -1 : 0) || a.hp - b.hp);
  for (const ab of u.abilities) {
    for (const t of ranked) {
      if (!canUse(c, u, ab, t, { wind: ctx.wind })) continue;
      if (u.side === 'foe') {
        c.windup = { unit: u.id, ability: ab, target: t.id, dodge: 'none' };
        ev.push({ t: 'windup', unit: u.id, ability: ab, target: t.id });
      } else {
        u.ap -= ABILITIES[ab].ap;
        applyHit(c, ctx, u, ab, t, 'none', 'none', 1, ev);
        checkEnd(c, ev);
        c.wait = 1;
      }
      return ev;
    }
  }

  // Nothing usable from here: walk to the tile that lets an ability land, else get closer.
  if (u.mp > 0) {
    const target = ranked[0];
    const scoreAt = (x: number, y: number): number => {
      const ox = u.x, oy = u.y;
      u.x = x; u.y = y;
      let best = Infinity;
      for (const ab of u.abilities) for (const t of ranked) {
        if (canUse(c, u, ab, t, { wind: ctx.wind })) best = Math.min(best, t.id === target.id ? -2 : -1);
      }
      u.x = ox; u.y = oy;
      return best < 0 ? best : manhattan({ x, y }, target);
    };
    let best: Vec[] | null = null, bestScore = scoreAt(u.x, u.y);
    for (const path of reachable(c, u).values()) {
      const end = path[path.length - 1], sc = scoreAt(end.x, end.y) + path.length * 0.01;
      if (sc < bestScore) { bestScore = sc; best = path; }
    }
    if (best) {
      const end = best[best.length - 1];
      u.facing = end.x - u.x + (end.y - u.y) >= 0 ? 1 : -1;
      u.x = end.x; u.y = end.y; u.mp -= best.length;
      ev.push({ t: 'move', unit: u.id, path: best });
      c.wait = 1;
      return ev;
    }
  }
  nextTurn(c, ev);
  return ev;
}
