// Keeping one client's copy of the game in step with the realm, using as few bytes as practical.
//  - Outbox (server side, one per connection) remembers what that client was last told: its
//    own World and the avatars it can see. Each message carries only the differences.
//  - Mirror (client side) holds the copy and applies those differences.
// Messages arrive in order over one WebSocket, so a patch always applies to the state the
// server diffed against.
import type { Ev, World } from '../sim/world.ts';
import { applyPatch, diff } from './delta.ts';
import type { Realm } from './realm.ts';
import type { Avatar, ServerMsg, StateMsg, Update, UpdateKind, Welcome } from './protocol.ts';

const sameAvatar = (a: Avatar, b: Avatar) => a.x === b.x && a.y === b.y && a.facing === b.facing && a.fishing === b.fishing && a.fighting === b.fighting;

export class Outbox {
  private readonly realm: Realm;
  readonly id: number;
  /** The World exactly as this client holds it now. */
  private sent: World | null = null;
  private seen = new Map<number, Avatar>();

  constructor(realm: Realm, id: number) { this.realm = realm; this.id = id; }

  /** The first message: the whole World once, and everyone in view. */
  welcome(): Welcome {
    const w = this.realm.world(this.id)!;
    this.sent = structuredClone(w);
    this.seen.clear();
    const others: Avatar[] = [];
    for (const o of this.realm.visibleTo(this.id)) { const a = this.realm.avatar(o)!; this.seen.set(o, a); others.push(a); }
    return { t: 'welcome', you: this.id, world: structuredClone(w), others };
  }

  /**
   * What changed since the last message: a patch of the client's own World, avatars that came
   * into view or changed, and ids that went out of view. `avatars: false` skips the others
   * (used for 'act' replies, which only the acting player's own World can change).
   */
  update(kind: UpdateKind, ev: Ev[], avatars = kind === 'tick'): StateMsg {
    if (!this.sent) throw new Error('welcome() first');
    const w = this.realm.world(this.id)!;
    const msg: StateMsg = { t: 'state', kind };
    const d = diff(this.sent, w);
    if (d) { msg.d = d; this.sent = structuredClone(w); }
    if (ev.length) msg.ev = ev;
    if (avatars) {
      const now = this.realm.visibleTo(this.id, new Set(this.seen.keys()));
      const keep = new Set(now);
      const gone = [...this.seen.keys()].filter(o => !keep.has(o));
      for (const o of gone) this.seen.delete(o);
      const seen: Avatar[] = [];
      for (const o of now) {
        const a = this.realm.avatar(o)!, before = this.seen.get(o);
        if (!before || !sameAvatar(before, a)) { seen.push(a); this.seen.set(o, a); }
      }
      if (seen.length) msg.seen = seen;
      if (gone.length) msg.gone = gone;
    }
    return msg;
  }

  /** Ids this client currently sees (for tests and debugging). */
  sees(): number[] { return [...this.seen.keys()].sort((a, b) => a - b); }
}

export class Mirror {
  readonly you: number;
  world: World;
  private readonly others = new Map<number, Avatar>();

  constructor(w: Welcome) {
    this.you = w.you;
    this.world = w.world;
    for (const a of w.others) this.others.set(a.id, a);
  }

  /** The current avatars in view, sorted by id. */
  list(): Avatar[] { return [...this.others.values()].sort((a, b) => a.id - b.id); }

  /** Apply one state message and return what the game should draw. */
  apply(m: StateMsg): Update {
    if (m.d) this.world = applyPatch(this.world, m.d) as World;
    for (const id of m.gone ?? []) this.others.delete(id);
    for (const a of m.seen ?? []) this.others.set(a.id, a);
    return { kind: m.kind, world: this.world, ev: m.ev ?? [], others: this.list() };
  }
}

export const isState = (m: ServerMsg): m is StateMsg => m.t === 'state';
