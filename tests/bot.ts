// A scripted player that drives the pure simulation through Act 1. Used by the playthrough
// test and the balance report. It plays plainly: no perfect timing unless asked.
import { ABILITIES, ENCOUNTERS, SPOTS, type AbilityId } from '../src/sim/content.ts';
import { canUse, current, reachable, type Grade } from '../src/sim/combat.ts';
import { manhattan, type Vec } from '../src/sim/core.ts';
import { count, newWorld, step, type Intent, type World } from '../src/sim/world.ts';
import { MONSOON_WIND } from '../src/sim/content.ts';
import { monsoonAt } from '../src/sim/world.ts';

export type BotOpts = { seed?: number; grade?: Grade; dodge?: Grade; maxTicks?: number; jamuStock?: number };
export type BotResult = { world: World; ticks: number; fights: { enc: string; won: boolean; ticks: number }[]; finished: boolean };

function combatIntent(w: World, grade: Grade, dodge: Grade): Intent | null {
  const c = w.combat!;
  if (c.windup && c.windup.target === 'you' && c.windup.dodge === 'none' && dodge !== 'none') return { t: 'combat', it: { t: 'dodge', grade: dodge } };
  const u = current(c);
  if (u.ctrl !== 'player') return null;
  const wind = MONSOON_WIND[monsoonAt(w.tick)];
  const jamu = count(w, 'jamu');
  if (u.hp < 16 && jamu > 0 && canUse(c, u, 'jamu', u, { wind, hasJamu: true })) return { t: 'combat', it: { t: 'use', ability: 'jamu', target: 'you', grade: 'none' } };
  const foes = c.units.filter(o => o.side === 'foe' && o.alive).sort((a, b) => a.hp - b.hp);
  const order: AbilityId[] = ['bayang', 'ombak', 'tendang'];
  for (const ab of order) {
    if (!u.abilities.includes(ab)) continue;
    for (const f of foes) if (canUse(c, u, ab, f, { wind })) return { t: 'combat', it: { t: 'use', ability: ab, target: f.id, grade } };
  }
  if (u.mp > 0) {
    // Step to a tile 2-4 away from the weakest foe so Ombak can land next.
    const target = foes[0];
    let best: Vec | null = null, bestScore = Infinity;
    for (const path of reachable(c, u).values()) {
      const end = path[path.length - 1], d = manhattan(end, target);
      const score = d >= 2 && d <= ABILITIES.ombak.max ? -1 : Math.abs(d - 3);
      if (score < bestScore) { bestScore = score; best = end; }
    }
    const here = manhattan(u, target), hereScore = here >= 2 && here <= ABILITIES.ombak.max ? -1 : Math.abs(here - 3);
    if (best && bestScore < hereScore) return { t: 'combat', it: { t: 'step', to: best } };
  }
  return { t: 'combat', it: { t: 'end' } };
}

export function playAct1(opts: BotOpts = {}): BotResult {
  const w = newWorld(opts.seed ?? 1360);
  const grade = opts.grade ?? 'none', dodge = opts.dodge ?? 'none';
  const maxTicks = opts.maxTicks ?? 20000, jamuStock = opts.jamuStock ?? 3;
  const fights: BotResult['fights'] = [];
  let fightStart = 0, sold = false;
  for (let t = 0; t < maxTicks; t++) {
    const intents: Intent[] = [];
    if (w.combat) {
      const it = combatIntent(w, grade, dodge);
      if (it) intents.push(it);
    } else if (w.dialog) {
      intents.push({ t: 'say', option: 0 });
    } else if (w.shop) {
      const fish = w.inv.findIndex(s => s.id !== 'jamu' && s.id !== 'gong');
      if (fish >= 0) intents.push({ t: 'sell', slot: fish });
      else if (w.shop === 'rahmah' && count(w, 'jamu') < jamuStock && w.picis >= 8) intents.push({ t: 'buy', item: 'jamu' });
      else { intents.push({ t: 'close' }); sold = true; }
    } else if (!w.player.path.length && !w.player.task) {
      switch (w.step) {
        case 0: intents.push({ t: 'talk', npc: 'lawak' }); break;
        case 1: intents.push({ t: 'fish', spot: 0 }); break;
        case 2: intents.push({ t: 'talk', npc: 'rahmah' }); break;
        case 3:
          // Fish a little more and stock up on jamu before asking for trouble.
          if (!sold || (count(w, 'jamu') < jamuStock && w.inv.length < 8)) {
            if (w.inv.length >= 8) { sold = false; intents.push({ t: 'talk', npc: 'rahmah' }); }
            else intents.push({ t: 'fish', spot: 1 });
          } else intents.push({ t: 'talk', npc: 'penghulu' });
          break;
        case 4: intents.push({ t: 'walk', to: ENCOUNTERS[0].center }); break;
        case 5: intents.push({ t: 'walk', to: ENCOUNTERS[1].center }); break;
        case 6: intents.push({ t: 'talk', npc: 'penghulu' }); break;
        default: break;
      }
    } else if (w.player.task?.t === 'fish' && w.step === 3 && w.inv.length >= 8) {
      intents.push({ t: 'talk', npc: 'rahmah' }); sold = false;
    }
    const wasFighting = !!w.combat;
    const enc = w.combat?.enc;
    const ev = step(w, intents);
    if (!wasFighting && w.combat) fightStart = w.tick;
    for (const e of ev) if (e.t === 'combatEnd') fights.push({ enc: enc ?? '?', won: e.won, ticks: w.tick - fightStart });
    if (w.step >= 7 && !w.dialog) return { world: w, ticks: w.tick, fights, finished: true };
  }
  return { world: w, ticks: w.tick, fights, finished: false };
}

export { SPOTS };
