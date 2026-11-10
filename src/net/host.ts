// One player's authoritative game: owns a World, applies intents as they arrive and advances
// time only in tick(). It has no timers of its own; whoever drives it decides when a tick
// happens: the WebSocket server every 600 ms, or the browser's frame loop when playing offline
// through the loopback. Both run exactly this code, so offline and online play the same rules.
import { act, step, type Ev, type Intent, type World } from '../sim/world.ts';

/** Intents beyond this many per tick are dropped, so a flooding client can't stall the loop. */
export const MAX_INTENTS_PER_TICK = 30;

/** What happened, in order. Replaying it on the starting world rebuilds the same state. */
export type LogEntry = { t: 'act'; it: Intent } | { t: 'tick' };

export class GameHost {
  readonly world: World;
  /** Present only when recording was asked for (tests, replays); a live server keeps none. */
  readonly log: LogEntry[] | null;
  private sinceTick = 0;

  constructor(world: World, opts: { record?: boolean } = {}) {
    this.world = world;
    this.log = opts.record ? [] : null;
  }

  /** Apply one intent now (clicks feel instant). Returns null if it was dropped by the rate limit. */
  submit(it: Intent): Ev[] | null {
    if (this.sinceTick >= MAX_INTENTS_PER_TICK) return null;
    this.sinceTick++;
    this.log?.push({ t: 'act', it });
    return act(this.world, it);
  }

  /** Advance the world by one 0.6 s step. */
  tick(): Ev[] {
    this.sinceTick = 0;
    this.log?.push({ t: 'tick' });
    return step(this.world, []);
  }
}

/** Re-run a recorded log on a copy of the starting world. Used to check that the host is deterministic. */
export function replay(start: World, log: LogEntry[]): World {
  const w = structuredClone(start);
  for (const e of log) {
    if (e.t === 'act') act(w, e.it);
    else step(w, []);
  }
  return w;
}
