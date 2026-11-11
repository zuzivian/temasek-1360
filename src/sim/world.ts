// The whole game state and its 0.6 s tick. Pure and deterministic: given the same state and
// the same intents, step() always produces the same result. The browser client only sends
// intents and draws; a future server can run this file unchanged.
import { aiTick, playerAct, startCombat, unitById, type CombatEvent, type CombatIntent, type CombatState } from './combat.ts';
import {
  DIALOG, ENCOUNTERS, FISH, GEAR, INV_SLOTS, ITEMS, MONSOON_NAME, MONSOON_TICKS, MONSOON_WIND, NPCS, QUEST, RESPAWN, SHOPS, SPOTS, START, openingNode,
  type AbilityId, type DialogAct, type EncounterSpec, type FishId, type GearId, type ItemId, type Monsoon, type NpcId
} from './content.ts';
import { chebyshev, rngNext, type Vec } from './core.ts';
import { MAP, walkable } from './map.ts';
import { findPath, pathToAdjacent } from './path.ts';
import { levelForXp, type SkillId } from './skills.ts';

export type Slot = { id: ItemId; n: number };
export type Task = { t: 'fish'; spot: number } | { t: 'talk'; npc: NpcId } | null;

export type World = {
  v: 1;
  tick: number;
  rng: number;
  player: { x: number; y: number; path: Vec[]; facing: 1 | -1; hp: number; task: Task; fishing: boolean };
  lawak: { x: number; y: number; following: boolean };
  skills: Record<SkillId, number>;
  inv: Slot[];
  gear: Partial<Record<GearId, boolean>>;
  picis: number;
  step: number;
  fishCaught: number;
  flags: Record<string, boolean>;
  abilities: AbilityId[];
  explored: number[];
  enc: { id: 'patrol' | 'todak'; alive: boolean; respawnAt: number }[];
  combat: CombatState | null;
  dialog: { node: string } | null;
  shop: 'rahmah' | 'lim' | 'ratan' | null;
  /** No new fight can start before this tick, so one fight never chains straight into another. */
  calmUntil?: number;
  /**
   * The encounters whose trigger zone you were standing in when the last fight ended: only these
   * wait for calmUntil. A zone you walk into during the calm still starts at its edge, so you can't
   * stroll into the middle of the next arena. Saves from before this field calm every encounter.
   */
  calmFor?: EncounterSpec['id'][];
};

export type Intent =
  | { t: 'walk'; to: Vec }
  | { t: 'fish'; spot: number }
  | { t: 'talk'; npc: NpcId }
  | { t: 'say'; option: number }
  | { t: 'sell'; slot: number }
  | { t: 'sellAll'; item: ItemId }
  | { t: 'buy'; item: ItemId | GearId }
  | { t: 'close' }
  | { t: 'drink' }
  | { t: 'combat'; it: CombatIntent };

export type Tone = 'info' | 'good' | 'warn' | 'quest' | 'say';
export type Ev =
  | { t: 'msg'; text: string; tone: Tone }
  | { t: 'xp'; skill: SkillId; amount: number; x: number; y: number }
  | { t: 'level'; skill: SkillId; level: number }
  | { t: 'sfx'; name: string }
  | { t: 'catch'; item: FishId; x: number; y: number }
  | { t: 'quest'; step: number }
  | { t: 'monsoon'; m: Monsoon }
  | { t: 'combatStart' }
  | { t: 'combat'; e: CombatEvent }
  | { t: 'combatEnd'; won: boolean }
  | { t: 'dialog' }
  | { t: 'shop' }
  | { t: 'coins'; amount: number }
  | { t: 'festival' };

const FOG_RADIUS = 6;

export function newWorld(seed = 1360): World {
  const w: World = {
    v: 1, tick: 0, rng: seed,
    player: { x: START.x, y: START.y, path: [], facing: 1, hp: 40, task: null, fishing: false },
    lawak: { x: NPCS.lawak.home.x, y: NPCS.lawak.home.y, following: false },
    skills: { pancing: 0, dagang: 0, silat: 0 },
    inv: [], gear: {}, picis: 0,
    step: 0, fishCaught: 0, flags: {}, abilities: ['tendang', 'ombak', 'jamu'],
    explored: new Array(MAP.w * MAP.h).fill(0),
    enc: ENCOUNTERS.map(e => ({ id: e.id, alive: true, respawnAt: 0 })),
    combat: null, dialog: null, shop: null
  };
  reveal(w);
  return w;
}

// ---------- small queries the client also uses ----------
export const monsoonAt = (tick: number): Monsoon => (Math.floor(tick / MONSOON_TICKS) % 2 === 0 ? 'NE' : 'SW');
export const monsoonLeft = (tick: number): number => MONSOON_TICKS - (tick % MONSOON_TICKS);
export const level = (w: World, s: SkillId): number => levelForXp(w.skills[s]);
export const maxHp = (w: World): number => 40 + 4 * (level(w, 'silat') - 1) + (w.gear.kain ? 10 : 0);
export const count = (w: World, id: ItemId): number => w.inv.reduce((n, s) => n + (s.id === id ? s.n : 0), 0);
export const npcPresent = (w: World, id: NpcId): boolean => !NPCS[id].monsoon || NPCS[id].monsoon === monsoonAt(w.tick);
export function npcPos(w: World, id: NpcId): Vec {
  return id === 'lawak' ? { x: w.lawak.x, y: w.lawak.y } : NPCS[id].home;
}
export const isExplored = (w: World, x: number, y: number): boolean => x >= 0 && y >= 0 && x < MAP.w && y < MAP.h && w.explored[y * MAP.w + x] === 1;

function npcBlocks(w: World, x: number, y: number): boolean {
  for (const id of Object.keys(NPCS) as NpcId[]) {
    if (id === 'lawak' && w.lawak.following) continue;
    if (!npcPresent(w, id)) continue;
    const p = npcPos(w, id);
    if (p.x === x && p.y === y) return true;
  }
  return false;
}
const freeFor = (w: World) => (x: number, y: number) => walkable(MAP, x, y) && !npcBlocks(w, x, y);

function reveal(w: World): void {
  const { x, y } = w.player;
  for (let dy = -FOG_RADIUS; dy <= FOG_RADIUS; dy++) for (let dx = -FOG_RADIUS; dx <= FOG_RADIUS; dx++) {
    const tx = x + dx, ty = y + dy;
    if (tx < 0 || ty < 0 || tx >= MAP.w || ty >= MAP.h || dx * dx + dy * dy > FOG_RADIUS * FOG_RADIUS + 2) continue;
    w.explored[ty * MAP.w + tx] = 1;
  }
}

function addXp(w: World, skill: SkillId, amount: number, ev: Ev[]): void {
  const before = level(w, skill);
  w.skills[skill] += amount;
  ev.push({ t: 'xp', skill, amount, x: w.player.x, y: w.player.y });
  const after = level(w, skill);
  if (after > before) {
    ev.push({ t: 'level', skill, level: after }, { t: 'sfx', name: 'level' });
    const name = { pancing: 'Pancing', dagang: 'Dagang', silat: 'Silat' }[skill];
    ev.push({ t: 'msg', text: `${name} level ${after}!`, tone: 'good' });
  }
}

function addItem(w: World, id: ItemId, n = 1, force = false): boolean {
  if (ITEMS[id].stack) {
    const s = w.inv.find(s => s.id === id);
    if (s) { s.n += n; return true; }
  }
  if (w.inv.length >= INV_SLOTS && !force) return false;
  if (ITEMS[id].stack) w.inv.push({ id, n });
  else for (let i = 0; i < n && (force || w.inv.length < INV_SLOTS); i++) w.inv.push({ id, n: 1 });
  return true;
}
function takeItem(w: World, id: ItemId): boolean {
  const i = w.inv.findIndex(s => s.id === id);
  if (i < 0) return false;
  if (--w.inv[i].n <= 0) w.inv.splice(i, 1);
  return true;
}

function closePanels(w: World): void { w.dialog = null; w.shop = null; }

// ---------- intents ----------
function handle(w: World, it: Intent, ev: Ev[]): void {
  if (w.combat) {
    if (it.t === 'combat') combatIntent(w, it.it, ev);
    return;
  }
  const p = w.player;
  switch (it.t) {
    case 'walk': {
      closePanels(w);
      const path = findPath(p, it.to, freeFor(w));
      if (path) { p.path = path; p.task = null; p.fishing = false; }
      else ev.push({ t: 'msg', text: "You can't walk there.", tone: 'warn' });
      return;
    }
    case 'fish': {
      closePanels(w);
      const spot = SPOTS[it.spot];
      if (!spot) return;
      if (!w.gear.joran) { ev.push({ t: 'msg', text: 'You need a fishing rod. Someone on the beach might lend you one.', tone: 'warn' }); return; }
      const path = pathToAdjacent(p, spot.at, freeFor(w));
      if (!path) { ev.push({ t: 'msg', text: "You can't reach that spot.", tone: 'warn' }); return; }
      p.path = path; p.task = { t: 'fish', spot: it.spot }; p.fishing = false;
      return;
    }
    case 'talk': {
      closePanels(w);
      if (!npcPresent(w, it.npc)) return;
      const path = pathToAdjacent(p, npcPos(w, it.npc), freeFor(w));
      if (!path) { ev.push({ t: 'msg', text: "You can't reach them.", tone: 'warn' }); return; }
      p.path = path; p.task = { t: 'talk', npc: it.npc }; p.fishing = false;
      return;
    }
    case 'say': return say(w, it.option, ev);
    case 'close': closePanels(w); return;
    case 'sell': return sell(w, it.slot, ev);
    case 'sellAll': {
      for (let i = w.inv.length - 1; i >= 0; i--) if (w.inv[i].id === it.item) sell(w, i, ev);
      return;
    }
    case 'buy': return buy(w, it.item, ev);
    case 'drink': {
      if (p.hp >= maxHp(w)) { ev.push({ t: 'msg', text: 'You feel fine already.', tone: 'info' }); return; }
      if (!takeItem(w, 'jamu')) { ev.push({ t: 'msg', text: 'No jamu left. Mak Cik Rahmah sells it.', tone: 'warn' }); return; }
      p.hp = Math.min(maxHp(w), p.hp + 18);
      ev.push({ t: 'sfx', name: 'heal' }, { t: 'msg', text: 'Bitter, earthy, and very good for you.', tone: 'good' });
      return;
    }
    case 'combat': return;
  }
}

function applyAct(w: World, act: DialogAct | undefined, ev: Ev[]): void {
  if (!act) return;
  if (act.flag) w.flags[act.flag] = true;
  if (act.gear) { w.gear[act.gear] = true; ev.push({ t: 'msg', text: `You got: ${GEAR[act.gear].name} (${GEAR[act.gear].en}).`, tone: 'good' }); }
  if (act.give) { addItem(w, act.give[0], act.give[1]); w.flags[`got_${act.give[0]}`] = true; ev.push({ t: 'msg', text: `You got: ${ITEMS[act.give[0]].name}.`, tone: 'good' }, { t: 'sfx', name: 'gong' }); }
  if (act.take) takeItem(w, act.take);
  if (act.heal) w.player.hp = maxHp(w);
  if (act.unlock && !w.abilities.includes(act.unlock)) { w.abilities.push(act.unlock); ev.push({ t: 'msg', text: 'New fight move: Bayang Todak (once per fight).', tone: 'good' }, { t: 'sfx', name: 'perfect' }); }
  if (act.shop && npcPresent(w, act.shop)) { w.shop = act.shop; ev.push({ t: 'shop' }, { t: 'sfx', name: 'open' }); }
}

function say(w: World, option: number, ev: Ev[]): void {
  if (!w.dialog) return;
  const node = DIALOG[w.dialog.node];
  if (node.options && node.options.length) {
    const o = node.options[option];
    if (!o) return;
    w.dialog = o.next ? { node: o.next } : null;
    applyAct(w, o.act, ev);
  } else {
    w.dialog = node.next ? { node: node.next } : null;
    applyAct(w, node.act, ev);
  }
  if (w.dialog) ev.push({ t: 'dialog' });
}

function shopPrice(shop: 'rahmah' | 'lim' | 'ratan', id: ItemId): number {
  const mult = SHOPS[shop].buys[id as FishId];
  if (!mult) return 0;
  return Math.max(1, Math.round(ITEMS[id].price * mult * (1 - SHOPS[shop].tax)));
}
export { shopPrice };

function sell(w: World, slot: number, ev: Ev[]): void {
  if (!w.shop || !npcPresent(w, w.shop)) return;
  const s = w.inv[slot];
  if (!s) return;
  const price = shopPrice(w.shop, s.id);
  if (!price) { ev.push({ t: 'msg', text: `${NPCS[w.shop].name} doesn't want that.`, tone: 'warn' }); return; }
  w.inv.splice(slot, 1);
  w.picis += price;
  ev.push({ t: 'coins', amount: price }, { t: 'sfx', name: 'coin' });
  addXp(w, 'dagang', price * 3, ev);
  if (w.shop === 'rahmah' && w.step === 2 && !w.flags.sold) {
    w.flags.sold = true;
    ev.push({ t: 'msg', text: 'Mak Cik Rahmah: "No festival this year. Perompak stole the gong. Go and see Tok Penghulu."', tone: 'say' });
  }
}

function buy(w: World, item: ItemId | GearId, ev: Ev[]): void {
  if (!w.shop || !npcPresent(w, w.shop) || !SHOPS[w.shop].sells.includes(item)) return;
  if (item in GEAR) {
    const g = GEAR[item as GearId];
    if (w.gear[item as GearId]) { ev.push({ t: 'msg', text: 'You already have one.', tone: 'info' }); return; }
    if (w.picis < g.price) { ev.push({ t: 'msg', text: `Not enough picis (${g.price} needed).`, tone: 'warn' }); return; }
    w.picis -= g.price; w.gear[item as GearId] = true;
    if (item === 'kain') w.player.hp += 10;
    ev.push({ t: 'msg', text: `Bought ${g.name}: ${g.en}.`, tone: 'good' }, { t: 'sfx', name: 'coin' });
    return;
  }
  const info = ITEMS[item as ItemId];
  if (w.picis < info.price) { ev.push({ t: 'msg', text: `Not enough picis (${info.price} needed).`, tone: 'warn' }); return; }
  if (!addItem(w, item as ItemId)) { ev.push({ t: 'msg', text: 'Your bag is full.', tone: 'warn' }); return; }
  w.picis -= info.price;
  ev.push({ t: 'msg', text: `Bought ${info.name}.`, tone: 'good' }, { t: 'sfx', name: 'coin' });
}

// ---------- combat bridge ----------
function combatIntent(w: World, it: CombatIntent, ev: Ev[]): void {
  const c = w.combat!;
  const ctx = { rng: w.rng, wind: MONSOON_WIND[monsoonAt(w.tick)] };
  const out = playerAct(c, ctx, { silatLevel: level(w, 'silat'), jamu: count(w, 'jamu'), consumeJamu: () => { takeItem(w, 'jamu'); } }, it);
  w.rng = ctx.rng;
  absorbCombat(w, out, ev);
}

function absorbCombat(w: World, out: CombatEvent[], ev: Ev[]): void {
  for (const e of out) {
    ev.push({ t: 'combat', e });
    if (e.t === 'hit' && e.unit === 'you') addXp(w, 'silat', e.dmg * 2, ev);
    if (e.t === 'end') endCombat(w, e.won, ev);
  }
}

function endCombat(w: World, won: boolean, ev: Ev[]): void {
  const c = w.combat!;
  const you = unitById(c, 'you')!;
  const spec = ENCOUNTERS.find(e => e.id === c.enc)!;
  const enc = w.enc.find(e => e.id === c.enc)!;
  w.combat = null;
  w.calmUntil = w.tick + 8;
  w.calmFor = won ? ENCOUNTERS.filter(e => chebyshev(you, e.center) <= e.trigger).map(e => e.id) : [];
  ev.push({ t: 'combatEnd', won });
  if (won) {
    w.player.hp = Math.max(1, Math.min(maxHp(w), you.hp));
    w.player.x = you.x; w.player.y = you.y;
    enc.alive = false; enc.respawnAt = w.tick + spec.respawnTicks;
    ev.push({ t: 'sfx', name: 'victory' });
    if (c.enc === 'patrol') {
      if (!w.flags.won_patrol) ev.push({ t: 'msg', text: "The perompak flee east toward Dragon's Tooth. Follow them.", tone: 'quest' });
      w.flags.won_patrol = true;
      const loot = 4 + Math.floor(rngNext(w) * 5);
      w.picis += loot; ev.push({ t: 'coins', amount: loot }, { t: 'msg', text: `You find ${loot} picis in the sand.`, tone: 'good' });
    } else {
      w.flags.won_todak = true;
      // The gong is the quest's key item, so it is granted here (never lost to a full bag or a closed dialogue).
      addItem(w, 'gong', 1, true); w.flags.got_gong = true;
      ev.push({ t: 'msg', text: 'You got: Gong pesta.', tone: 'good' });
      w.dialog = { node: 'todak.flee' };
      ev.push({ t: 'dialog' });
    }
  } else {
    w.player.hp = maxHp(w);
    w.player.x = RESPAWN.x; w.player.y = RESPAWN.y; w.player.path = [];
    w.lawak.x = RESPAWN.x + 1; w.lawak.y = RESPAWN.y;
    ev.push({ t: 'sfx', name: 'defeat' }, { t: 'msg', text: 'Pak Lawak drags you back to the beach. "Again! But better!"', tone: 'warn' });
  }
}

function checkEncounters(w: World, ev: Ev[]): void {
  const calm = w.tick < (w.calmUntil ?? 0);
  for (const e of w.enc) {
    const spec = ENCOUNTERS.find(s => s.id === e.id)!;
    if (calm && (!w.calmFor || w.calmFor.includes(e.id))) continue;
    // Patrols come back for practice only once Act 1 is done, so the story path stays clear.
    if (!e.alive && spec.repeat && w.step >= 7 && w.tick >= e.respawnAt) e.alive = true;
    if (!e.alive || w.step < spec.requiresStep) continue;
    if (chebyshev(w.player, spec.center) > spec.trigger) continue;
    closePanels(w);
    w.player.path = []; w.player.task = null; w.player.fishing = false;
    w.combat = startCombat(spec.id, {
      maxHp: maxHp(w), hp: w.player.hp, silatLevel: level(w, 'silat'), hasJamu: count(w, 'jamu') > 0,
      abilities: w.abilities, withAlly: w.lawak.following
    }, w.player);
    ev.push({ t: 'msg', text: spec.bark, tone: 'say' }, { t: 'combatStart' }, { t: 'sfx', name: 'gong' });
    return;
  }
}

// ---------- movement and actions ----------
function moveAlong(pos: { x: number; y: number; facing?: 1 | -1 }, path: Vec[], steps: number): number {
  let n = 0;
  while (n < steps && path.length) {
    const s = path.shift()!;
    if (pos.facing !== undefined) pos.facing = s.x - pos.x + (s.y - pos.y) >= 0 ? 1 : -1;
    pos.x = s.x; pos.y = s.y; n++;
  }
  return n;
}

function fishTick(w: World, ev: Ev[]): void {
  const p = w.player, task = p.task;
  if (!task || task.t !== 'fish') return;
  const spot = SPOTS[task.spot];
  if (chebyshev(p, spot.at) > 1) return;
  if (!p.fishing) {
    p.fishing = true;
    p.facing = spot.at.x - p.x + (spot.at.y - p.y) >= 0 ? 1 : -1;
    ev.push({ t: 'sfx', name: 'splash' }, { t: 'msg', text: 'You cast your line.', tone: 'info' });
    return;
  }
  if (w.inv.length >= INV_SLOTS) {
    p.task = null; p.fishing = false;
    ev.push({ t: 'msg', text: 'Your bag is full. Sell your catch at the pasar.', tone: 'warn' });
    return;
  }
  const lvl = level(w, 'pancing');
  const table = spot.table(monsoonAt(w.tick)).filter(([f]) => FISH[f].level <= lvl);
  if (!table.length) {
    p.task = null; p.fishing = false;
    const need = Math.min(...spot.table(monsoonAt(w.tick)).map(([f]) => FISH[f].level));
    ev.push({ t: 'msg', text: `Nothing here bites for you yet. Needs Pancing ${need}.`, tone: 'warn' });
    return;
  }
  const chance = Math.min(0.75, 0.2 + 0.012 * lvl + (w.gear.kail ? 0.12 : 0));
  if (rngNext(w) > chance) return;
  const total = table.reduce((n, [, wt]) => n + wt, 0);
  let r = rngNext(w) * total, fish: FishId = table[0][0];
  for (const [f, wt] of table) { if ((r -= wt) <= 0) { fish = f; break; } }
  addItem(w, fish);
  w.fishCaught++;
  ev.push({ t: 'catch', item: fish, x: p.x, y: p.y }, { t: 'sfx', name: 'catch' }, { t: 'msg', text: `You catch ${ITEMS[fish].name.toLowerCase()}.`, tone: 'info' });
  addXp(w, 'pancing', FISH[fish].xp, ev);
}

function followTick(w: World): void {
  const l = w.lawak;
  if (!l.following) return;
  if (chebyshev(l, w.player) <= 2) return;
  const path = pathToAdjacent(l, w.player, (x, y) => walkable(MAP, x, y) && !(x === w.player.x && y === w.player.y));
  if (path) moveAlong(l, path, 2);
  else { l.x = w.player.x; l.y = w.player.y; }
}

function questTick(w: World, ev: Ev[]): void {
  const done = [
    () => !!w.flags.met_lawak,
    () => w.fishCaught >= 3,
    () => !!w.flags.sold,
    () => !!w.flags.asked_penghulu,
    () => !!w.flags.won_patrol,
    () => !!w.flags.got_gong,
    () => !!w.flags.returned_gong
  ];
  while (w.step < done.length && done[w.step]()) {
    w.step++;
    if (w.step === 1) w.lawak.following = true;
    ev.push({ t: 'quest', step: w.step }, { t: 'sfx', name: w.step === 7 ? 'gong' : 'quest' });
    if (w.step === 7) ev.push({ t: 'festival' }, { t: 'msg', text: `${QUEST.title}: selesai! The festival begins.`, tone: 'quest' });
    else ev.push({ t: 'msg', text: `New goal: ${QUEST.steps[w.step].goal}`, tone: 'quest' });
  }
}

/** Apply one intent right away (clicks feel instant); time still only moves in step(). */
export function act(w: World, it: Intent): Ev[] {
  const ev: Ev[] = [];
  handle(w, it, ev);
  questTick(w, ev);
  return ev;
}

/** The place the current quest step points at, for the on-screen marker. */
export function questTarget(w: World): Vec | null {
  switch (w.step) {
    case 0: return { x: w.lawak.x, y: w.lawak.y };
    case 1: return SPOTS[1].at;
    case 2: return NPCS.rahmah.home;
    case 3: case 6: return NPCS.penghulu.home;
    case 4: return ENCOUNTERS[0].center;
    case 5: return ENCOUNTERS[1].center;
    default: return w.flags.puppet_todak ? null : NPCS.dalang.home;
  }
}

function monsoonTurned(w: World, ev: Ev[]): void {
  const now = monsoonAt(w.tick);
  ev.push({ t: 'monsoon', m: now }, { t: 'msg', text: `${MONSOON_NAME[now]} arrives. ${now === 'NE' ? 'Rain, and Chinese junks in the river.' : 'Dry skies, and a ship from Gujarat.'}`, tone: 'quest' });
  if (w.shop && w.shop !== 'rahmah') w.shop = null;
  const who = w.dialog ? DIALOG[w.dialog.node].who : null;
  if (who && who !== 'you' && who !== 'todak' && !npcPresent(w, who)) w.dialog = null;
}

/**
 * Move this World onto another clock (the shared realm's) without simulating the gap: `tick`
 * jumps, and every timer that counts in ticks (fight cool-down, respawns) moves with it, so
 * nothing fires early or late. If the jump lands in the other monsoon, it turns as in step().
 */
export function setClock(w: World, tick: number): Ev[] {
  const d = tick - w.tick, ev: Ev[] = [];
  if (!d) return ev;
  const before = monsoonAt(w.tick);
  w.tick = tick;
  if (w.calmUntil !== undefined) w.calmUntil += d;
  for (const e of w.enc) if (!e.alive) e.respawnAt += d;
  if (monsoonAt(tick) !== before) monsoonTurned(w, ev);
  return ev;
}

/** Advance the world by one 0.6 s tick. */
export function step(w: World, intents: Intent[]): Ev[] {
  const ev: Ev[] = [];
  const before = monsoonAt(w.tick);
  w.tick++;
  const now = monsoonAt(w.tick);
  if (now !== before) monsoonTurned(w, ev);
  for (const it of intents) handle(w, it, ev);

  if (w.combat) {
    const ctx = { rng: w.rng, wind: MONSOON_WIND[now] };
    const out = aiTick(w.combat, ctx);
    w.rng = ctx.rng;
    absorbCombat(w, out, ev);
    questTick(w, ev);
    return ev;
  }

  const p = w.player;
  const moved = moveAlong(p, p.path, 2);
  if (moved) { reveal(w); ev.push({ t: 'sfx', name: 'step' }); }
  if (!p.path.length && p.task?.t === 'talk') {
    const npc = p.task.npc;
    p.task = null;
    const at = npcPos(w, npc);
    if (chebyshev(p, at) <= 1 && npcPresent(w, npc)) {
      p.facing = at.x - p.x + (at.y - p.y) >= 0 ? 1 : -1;
      w.dialog = { node: openingNode(npc, w.step, w.flags) };
      ev.push({ t: 'dialog' }, { t: 'sfx', name: 'open' });
    }
  }
  if (!p.path.length) fishTick(w, ev);
  followTick(w);
  if (w.tick % 5 === 0 && p.hp < maxHp(w)) p.hp++;
  if (!w.dialog) checkEncounters(w, ev);
  questTick(w, ev);
  return ev;
}

// ---------- saves ----------
export function save(w: World): string { return JSON.stringify(w); }
export function load(s: string): World | null {
  try {
    const w = JSON.parse(s) as World;
    if (!w || w.v !== 1 || !Array.isArray(w.explored) || w.explored.length !== MAP.w * MAP.h) return null;
    return w;
  } catch { return null; }
}
