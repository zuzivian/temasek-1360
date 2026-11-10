// The shared world: every connected player on one map and one clock. Progression stays per
// player (docs/DESIGN.md: "Progression is per player"), so each player keeps their own World
// (quest, bag, fights, fog) inside a GameHost, and the realm adds what players share: being
// on the same beach, seen by whoever stands near them.
//
// Deterministic: players tick in join order, and no player's intents can change another's
// World, so each World evolves exactly as it would in a solo GameHost (tested).
import { chebyshev } from '../sim/core.ts';
import type { Ev, Intent, World } from '../sim/world.ts';
import { GameHost } from './host.ts';
import type { Avatar } from './protocol.ts';

/** Players the realm accepts at once; the next hello is told the server is full. */
export const MAX_PLAYERS = 64;
/** A player starts seeing someone within this many tiles (Chebyshev, about a screen at zoom 1)… */
export const SEE_RADIUS = 14;
/** …and stops only past this, so someone walking along the edge doesn't flicker in and out. */
export const FORGET_RADIUS = SEE_RADIUS + 2;

export class Realm {
  /** Insertion order is join order, which is the tick order. */
  private readonly hosts = new Map<number, GameHost>();
  private nextId = 1;
  private readonly record: boolean;

  constructor(opts: { record?: boolean } = {}) { this.record = !!opts.record; }

  get size(): number { return this.hosts.size; }
  ids(): number[] { return [...this.hosts.keys()]; }
  host(id: number): GameHost | undefined { return this.hosts.get(id); }
  world(id: number): World | undefined { return this.hosts.get(id)?.world; }

  /** Add a player with their World; returns their id, or null when the realm is full. */
  join(world: World): number | null {
    if (this.hosts.size >= MAX_PLAYERS) return null;
    const id = this.nextId++;
    this.hosts.set(id, new GameHost(world, { record: this.record }));
    return id;
  }
  leave(id: number): void { this.hosts.delete(id); }

  /** Apply one player's intent now; null if it was rate-limited or the player is gone. */
  submit(id: number, it: Intent): Ev[] | null { return this.hosts.get(id)?.submit(it) ?? null; }

  /** One 0.6 s step for everyone, in join order. A player whose sim throws is reported, not ticked again. */
  tick(onError?: (id: number, e: unknown) => void): Map<number, Ev[]> {
    const out = new Map<number, Ev[]>();
    for (const [id, h] of this.hosts) {
      try { out.set(id, h.tick()); } catch (e) {
        if (!onError) throw e;
        this.hosts.delete(id);
        onError(id, e);
      }
    }
    return out;
  }

  /** What others can see of a player. */
  avatar(id: number): Avatar | null {
    const w = this.world(id);
    if (!w) return null;
    const p = w.player;
    const a: Avatar = { id, x: p.x, y: p.y, facing: p.facing };
    if (p.fishing && p.task?.t === 'fish') a.fishing = p.task.spot;
    if (w.combat) a.fighting = true;
    return a;
  }

  /**
   * The players `id` should see now, given who it already sees (`seen`): anyone within
   * SEE_RADIUS, plus anyone already seen who is still within FORGET_RADIUS. Sorted by id.
   */
  visibleTo(id: number, seen: ReadonlySet<number> = new Set()): number[] {
    const me = this.world(id)?.player;
    if (!me) return [];
    const out: number[] = [];
    for (const [other, h] of this.hosts) {
      if (other === id) continue;
      const d = chebyshev(me, h.world.player);
      if (d <= SEE_RADIUS || (seen.has(other) && d <= FORGET_RADIUS)) out.push(other);
    }
    return out.sort((a, b) => a - b);
  }
}
