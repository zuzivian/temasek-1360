// The wire format between a client and the game server. DOM-free and Node-free, so the browser,
// the server and the in-process loopback all share it.
//
// client → server:  hello (once), then intent messages
// server → client:  'welcome' after hello: your id, your whole World once, and the players in
//                   view. Then 'state' messages: kind 'act' after each applied intent, 'tick'
//                   after each 0.6 s step. A state carries only what changed (see sync.ts): a
//                   patch of your World, avatars that came into view or moved, and ids that
//                   left view. Every intent is answered by an 'act' state or an error.
import { ABILITIES, GEAR, ITEMS, NPCS } from '../sim/content.ts';
import type { Ev, Intent, World } from '../sim/world.ts';
import type { Patch } from './delta.ts';

export const PROTOCOL = 2;
/** The path the game server accepts WebSocket upgrades on. */
export const WS_PATH = '/ws';
/** Largest client message the server reads (a save is about 10 KB). */
export const MAX_MESSAGE_BYTES = 256 * 1024;

export type Hello = { t: 'hello'; v: number; save?: string; seed?: number };
export type ClientMsg = Hello | { t: 'intent'; it: Intent };

/** What another player looks like from nearby. Their World stays on the server. */
export type Avatar = { id: number; x: number; y: number; facing: 1 | -1; fishing?: number; fighting?: boolean };

export type Welcome = { t: 'welcome'; you: number; world: World; others: Avatar[] };
export type UpdateKind = 'act' | 'tick';
/** d: patch of your World; seen: avatars new to view or changed; gone: ids out of view. Empty parts are left out. */
export type StateMsg = { t: 'state'; kind: UpdateKind; d?: Patch; ev?: Ev[]; seen?: Avatar[]; gone?: number[] };
export type ServerMsg = Welcome | StateMsg | { t: 'error'; msg: string };

/** What the client draws from: its own World and whoever is in view (none when offline). */
export type Update = { kind: UpdateKind | 'welcome'; world: World; ev: Ev[]; others: Avatar[] };

// ---------- validation: everything from the network is untrusted ----------
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (table: object, k: unknown): boolean => typeof k === 'string' && Object.prototype.hasOwnProperty.call(table, k);
const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const isVec = (v: unknown): boolean => isObj(v) && isInt(v.x, -1e4, 1e4) && isInt(v.y, -1e4, 1e4);
const isGrade = (v: unknown): boolean => v === 'perfect' || v === 'good' || v === 'none';

/** Returns a clean copy of a well-formed intent, or null. The sim then decides if it is legal. */
export function parseIntent(raw: unknown): Intent | null {
  if (!isObj(raw)) return null;
  switch (raw.t) {
    case 'walk': return isVec(raw.to) ? { t: 'walk', to: { x: (raw.to as Obj).x as number, y: (raw.to as Obj).y as number } } : null;
    case 'fish': return isInt(raw.spot, 0, 1000) ? { t: 'fish', spot: raw.spot } : null;
    case 'talk': return has(NPCS, raw.npc) ? { t: 'talk', npc: raw.npc as keyof typeof NPCS } : null;
    case 'say': return isInt(raw.option, 0, 100) ? { t: 'say', option: raw.option } : null;
    case 'sell': return isInt(raw.slot, 0, 1000) ? { t: 'sell', slot: raw.slot } : null;
    case 'sellAll': return has(ITEMS, raw.item) ? { t: 'sellAll', item: raw.item as keyof typeof ITEMS } : null;
    case 'buy': return has(ITEMS, raw.item) || has(GEAR, raw.item) ? { t: 'buy', item: raw.item as keyof typeof ITEMS } : null;
    case 'close': return { t: 'close' };
    case 'drink': return { t: 'drink' };
    case 'combat': {
      const c = raw.it;
      if (!isObj(c)) return null;
      switch (c.t) {
        case 'step': return isVec(c.to) ? { t: 'combat', it: { t: 'step', to: { x: (c.to as Obj).x as number, y: (c.to as Obj).y as number } } } : null;
        case 'use':
          return has(ABILITIES, c.ability) && typeof c.target === 'string' && c.target.length <= 32 && isGrade(c.grade)
            ? { t: 'combat', it: { t: 'use', ability: c.ability as keyof typeof ABILITIES, target: c.target, grade: c.grade as 'none' } }
            : null;
        case 'end': return { t: 'combat', it: { t: 'end' } };
        case 'dodge': return isGrade(c.grade) ? { t: 'combat', it: { t: 'dodge', grade: c.grade as 'none' } } : null;
        default: return null;
      }
    }
    default: return null;
  }
}

/** Parses one client message; null for anything malformed. */
export function parseClientMsg(text: string): ClientMsg | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!isObj(raw)) return null;
  if (raw.t === 'hello') {
    if (raw.v !== PROTOCOL) return null;
    const out: Hello = { t: 'hello', v: PROTOCOL };
    if (typeof raw.save === 'string') out.save = raw.save;
    if (isInt(raw.seed, -(2 ** 31), 2 ** 32)) out.seed = raw.seed;
    return out;
  }
  if (raw.t === 'intent') {
    const it = parseIntent(raw.it);
    return it ? { t: 'intent', it } : null;
  }
  return null;
}
