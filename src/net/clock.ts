// The shared realm clock. There is no server loop to own it: the realm's tick is a pure
// function of wall-clock time, so every tab (and every serverless request) that knows the time
// agrees on the tick, and so on the monsoon, the traders in port and the countdown. Nothing has
// to run while nobody plays. The only thing a client needs from a server is the time, to correct
// its own clock (see offsetFrom).
import { TICK_MS } from '../sim/core.ts';

/** Realm tick 0: 1 Nov 2026 00:00 UTC, the start of a north-east monsoon. */
export const EPOCH_MS = Date.UTC(2026, 10, 1);

/** The realm's tick at wall-clock time `ms`. */
export const realmTick = (ms: number): number => Math.floor((ms - EPOCH_MS) / TICK_MS);
/** When realm tick `tick` starts, in wall-clock ms. */
export const tickStart = (tick: number): number => EPOCH_MS + tick * TICK_MS;

/**
 * How far this machine's clock is behind the server's, from one request: the server said
 * `serverMs`, and the request left at `sentMs` and its answer came back at `gotMs`. Assumes the
 * answer was stamped halfway through the round trip (good to about ±RTT/2).
 */
export const offsetFrom = (serverMs: number, sentMs: number, gotMs: number): number => serverMs - (sentMs + gotMs) / 2;
