import { ACT1_MAP } from './map-data.ts';
import type { Vec } from './core.ts';

export type TileKind =
  | 'forest' | 'grass' | 'sand' | 'shallow' | 'sea' | 'river' | 'bridge' | 'hill'
  | 'palace' | 'gate' | 'spring' | 'house' | 'balai' | 'stall' | 'palm' | 'rock' | 'tooth'
  | 'tent' | 'fire' | 'pod' | 'scorch' | 'spot';

const KINDS: Record<string, TileKind> = {
  F: 'forest', ',': 'grass', '.': 'sand', '-': 'shallow', '~': 'sea', '=': 'river', b: 'bridge',
  h: 'hill', K: 'palace', G: 'gate', w: 'spring', H: 'house', B: 'balai', P: 'stall', T: 'palm',
  r: 'rock', R: 'tooth', X: 'tent', c: 'fire', O: 'pod', s: 'scorch', f: 'spot'
};

const WALKABLE = new Set<TileKind>(['grass', 'sand', 'bridge', 'hill', 'scorch']);
const WATER = new Set<TileKind>(['shallow', 'sea', 'river', 'spot']);

export type GameMap = {
  w: number;
  h: number;
  kinds: TileKind[];
  /** Raised tiles (the forbidden hill) draw one step up. */
  elev: number[];
};

export function parseMap(rows: readonly string[]): GameMap {
  const h = rows.length, w = rows[0].length;
  const kinds: TileKind[] = [], elev: number[] = [];
  for (let y = 0; y < h; y++) {
    if (rows[y].length !== w) throw new Error(`map row ${y} has length ${rows[y].length}, expected ${w}`);
    for (let x = 0; x < w; x++) {
      const k = KINDS[rows[y][x]];
      if (!k) throw new Error(`unknown map char '${rows[y][x]}' at ${x},${y}`);
      kinds.push(k);
      elev.push(k === 'hill' || k === 'palace' || k === 'spring' ? 1 : 0);
    }
  }
  return { w, h, kinds, elev };
}

export const MAP: GameMap = parseMap(ACT1_MAP);

export function kindAt(m: GameMap, x: number, y: number): TileKind {
  if (x < 0 || y < 0 || x >= m.w || y >= m.h) return 'sea';
  return m.kinds[y * m.w + x];
}
export function walkable(m: GameMap, x: number, y: number): boolean {
  return WALKABLE.has(kindAt(m, x, y));
}
export function isWater(m: GameMap, x: number, y: number): boolean {
  return WATER.has(kindAt(m, x, y));
}
export function elevAt(m: GameMap, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= m.w || y >= m.h) return 0;
  return m.elev[y * m.w + x];
}
export function findAll(m: GameMap, kind: TileKind): Vec[] {
  const out: Vec[] = [];
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (kindAt(m, x, y) === kind) out.push({ x, y });
  return out;
}
