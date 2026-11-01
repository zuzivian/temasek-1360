// Balance report: runs the scripted bot through Act 1 many times and prints fight results.
// Usage: node scripts/balance.ts [runs]
import { playAct1 } from '../tests/bot.ts';
import { level } from '../src/sim/world.ts';
import type { Grade } from '../src/sim/combat.ts';

const runs = Number(process.argv[2] ?? 40);
for (const [label, grade, dodge, jamu] of [['plain, 3 jamu', 'none', 'none', 3], ['plain, no jamu', 'none', 'none', 0], ['good timing, 3 jamu', 'good', 'good', 3]] as [string, Grade, Grade, number][]) {
  let finished = 0, ticks = 0, losses = { patrol: 0, todak: 0 }, minutes: number[] = [];
  const lv = { pancing: 0, dagang: 0, silat: 0 };
  for (let s = 1; s <= runs; s++) {
    const r = playAct1({ seed: s * 7919, grade, dodge, jamuStock: jamu });
    if (r.finished) finished++;
    ticks += r.ticks; minutes.push(r.ticks * 0.6 / 60);
    for (const f of r.fights) if (!f.won) losses[f.enc as 'patrol' | 'todak']++;
    for (const k of Object.keys(lv) as (keyof typeof lv)[]) lv[k] += level(r.world, k);
  }
  minutes.sort((a, b) => a - b);
  console.log(`${label}: finished ${finished}/${runs}; median ${minutes[runs >> 1].toFixed(1)} min of game time (bot, no reading); losses patrol ${losses.patrol}, todak ${losses.todak}; avg levels Pancing ${(lv.pancing / runs).toFixed(1)} Dagang ${(lv.dagang / runs).toFixed(1)} Silat ${(lv.silat / runs).toFixed(1)}`);
}
