// Shared types and small pure helpers for the simulation. Nothing in src/sim touches the DOM,
// so the same code can later run on an authoritative server.

export type Vec = { x: number; y: number };

export type Element = 'Kayu' | 'Tanah' | 'Angin' | 'Air' | 'Api' | 'Besi';

/** Each element beats the next one in this cycle: Kayu > Tanah > Angin > Air > Api > Besi > Kayu. */
export const ELEMENT_CYCLE: readonly Element[] = ['Kayu', 'Tanah', 'Angin', 'Air', 'Api', 'Besi'];

export const ELEMENT_EN: Record<Element, string> = {
  Kayu: 'wood', Tanah: 'earth', Angin: 'wind', Air: 'water', Api: 'fire', Besi: 'metal'
};

/** Damage multiplier for an attack of element `atk` against a defender of element `def`. */
export function elementMultiplier(atk: Element | null, def: Element | null): number {
  if (!atk || !def) return 1;
  const a = ELEMENT_CYCLE.indexOf(atk), d = ELEMENT_CYCLE.indexOf(def);
  if ((a + 1) % 6 === d) return 1.5;
  if ((d + 1) % 6 === a) return 0.67;
  return 1;
}

export const TICK_MS = 600;

// ---------- seeded RNG (mulberry32), state kept as a plain number so saves stay JSON ----------
export function rngNext(state: { rng: number }): number {
  let t = (state.rng = (state.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export function rngInt(state: { rng: number }, lo: number, hi: number): number {
  return lo + Math.floor(rngNext(state) * (hi - lo + 1));
}

export const manhattan = (a: Vec, b: Vec): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export const chebyshev = (a: Vec, b: Vec): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
export const same = (a: Vec, b: Vec): boolean => a.x === b.x && a.y === b.y;
