// Skills use the classic RuneScape experience curve: level 2 at 83 XP, level 99 at 13,034,431 XP.

export type SkillId = 'pancing' | 'dagang' | 'silat';

export type SkillInfo = { id: SkillId; name: string; en: string; launch: true } | { id: string; name: string; en: string; launch: false; season: number };

export const SKILLS: readonly SkillInfo[] = [
  { id: 'pancing', name: 'Pancing', en: 'fishing', launch: true },
  { id: 'dagang', name: 'Dagang', en: 'trading', launch: true },
  { id: 'silat', name: 'Silat', en: 'fighting', launch: true },
  { id: 'layar', name: 'Layar', en: 'sailing', launch: false, season: 2 },
  { id: 'wayang', name: 'Wayang', en: 'shadow puppets', launch: false, season: 2 },
  { id: 'selam', name: 'Selam', en: 'diving', launch: false, season: 3 },
  { id: 'tempa', name: 'Tempa', en: 'smithing', launch: false, season: 3 },
  { id: 'jamu', name: 'Jamu', en: 'herbs', launch: false, season: 4 }
];

export const MAX_LEVEL = 99;

const XP_TABLE: number[] = (() => {
  const t = [0, 0];
  let points = 0;
  for (let lvl = 1; lvl < MAX_LEVEL; lvl++) {
    points += Math.floor(lvl + 300 * Math.pow(2, lvl / 7));
    t.push(Math.floor(points / 4));
  }
  return t;
})();

/** XP needed to reach `level` (1..99). */
export function xpForLevel(level: number): number {
  return XP_TABLE[Math.max(1, Math.min(MAX_LEVEL, level))];
}

export function levelForXp(xp: number): number {
  let lvl = 1;
  while (lvl < MAX_LEVEL && xp >= XP_TABLE[lvl + 1]) lvl++;
  return lvl;
}

/** 0..1 progress from the current level to the next. */
export function levelProgress(xp: number): number {
  const lvl = levelForXp(xp);
  if (lvl >= MAX_LEVEL) return 1;
  const a = XP_TABLE[lvl], b = XP_TABLE[lvl + 1];
  return (xp - a) / (b - a);
}
