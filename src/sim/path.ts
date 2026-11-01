import type { Vec } from './core.ts';

const DIRS: readonly [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]
];

/**
 * A* over an 8-connected grid without corner cutting (a diagonal step needs both orthogonal
 * neighbours open, as in RuneScape). Returns the steps after `from`, ending at `to`, or null.
 * `free(x, y)` says whether a tile can be stood on. `to` itself must be free.
 */
export function findPath(from: Vec, to: Vec, free: (x: number, y: number) => boolean, opts: { maxNodes?: number; diagonal?: boolean } = {}): Vec[] | null {
  if (from.x === to.x && from.y === to.y) return [];
  if (!free(to.x, to.y)) return null;
  const maxNodes = opts.maxNodes ?? 4000, diagonal = opts.diagonal ?? true;
  const key = (x: number, y: number) => x * 4096 + y;
  const h = (x: number, y: number) => {
    const dx = Math.abs(x - to.x), dy = Math.abs(y - to.y);
    return diagonal ? Math.max(dx, dy) + 0.414 * Math.min(dx, dy) : dx + dy;
  };
  const g = new Map<number, number>([[key(from.x, from.y), 0]]);
  const came = new Map<number, number>();
  const open: { x: number; y: number; f: number }[] = [{ x: from.x, y: from.y, f: h(from.x, from.y) }];
  const closed = new Set<number>();
  let expanded = 0;
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    const ck = key(cur.x, cur.y);
    if (closed.has(ck)) continue;
    closed.add(ck);
    if (cur.x === to.x && cur.y === to.y) {
      const out: Vec[] = [];
      let k = ck;
      while (k !== key(from.x, from.y)) { out.push({ x: Math.floor(k / 4096), y: k % 4096 }); k = came.get(k)!; }
      return out.reverse();
    }
    if (++expanded > maxNodes) return null;
    for (const [dx, dy, cost] of DIRS) {
      if (!diagonal && dx !== 0 && dy !== 0) continue;
      const nx = cur.x + dx, ny = cur.y + dy;
      if (!free(nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (!free(cur.x + dx, cur.y) || !free(cur.x, cur.y + dy))) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const ng = g.get(ck)! + cost;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng); came.set(nk, ck);
        open.push({ x: nx, y: ny, f: ng + h(nx, ny) });
      }
    }
  }
  return null;
}

/** Path to the nearest free tile next to `target` (for talking to an NPC or fishing a spot). */
export function pathToAdjacent(from: Vec, target: Vec, free: (x: number, y: number) => boolean): Vec[] | null {
  let best: Vec[] | null = null;
  for (const [dx, dy] of DIRS) {
    const t = { x: target.x + dx, y: target.y + dy };
    if (t.x === from.x && t.y === from.y) return [];
    const p = findPath(from, t, free);
    if (p && (!best || p.length < best.length)) best = p;
  }
  return best;
}
