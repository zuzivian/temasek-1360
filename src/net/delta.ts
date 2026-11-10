// Structural diffs of JSON-shaped values, so the server can send what changed in a player's
// World instead of the whole ~10 KB of it. Pure and deterministic; shared by the server and
// the browser.
//
//   { s: v }               replace this value with v
//   { o: {k: P}, x?: [k] }  object: patch keys k, and delete the keys in x
//   { a: [[i, P], ...] }    array of unchanged length: patch the listed indices
//
// Keys whose value is undefined count as absent, as they do in JSON.

export type Patch =
  | { s: unknown }
  | { o: Record<string, Patch>; x?: string[] }
  | { a: [number, Patch][] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
/** Keys that must never be written through a patch, so a bad patch can't reach a prototype. */
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

/** What turns `prev` into `next`, or null if they are already equal. */
export function diff(prev: unknown, next: unknown): Patch | null {
  if (prev === next) return null;
  if (Array.isArray(prev) && Array.isArray(next)) {
    if (prev.length !== next.length) return { s: next };
    const a: [number, Patch][] = [];
    for (let i = 0; i < next.length; i++) {
      const p = diff(prev[i], next[i]);
      if (p) a.push([i, p]);
    }
    if (!a.length) return null;
    // Replacing a short array outright is smaller than listing most of its entries.
    return a.length * 2 > next.length && next.length < 16 ? { s: next } : { a };
  }
  if (isObj(prev) && isObj(next)) {
    const o: Record<string, Patch> = {}, x: string[] = [];
    let any = false;
    for (const k of Object.keys(next)) {
      if (!own(next, k)) continue;
      const p = own(prev, k) ? diff(prev[k], next[k]) : { s: next[k] };
      if (p) { o[k] = p; any = true; }
    }
    for (const k of Object.keys(prev)) if (own(prev, k) && !own(next, k)) x.push(k);
    if (!any && !x.length) return null;
    return x.length ? { o, x } : { o };
  }
  return { s: next === undefined ? null : next };
}

/**
 * Apply a patch made by diff(). Objects and arrays are changed in place where the patch allows
 * it; the (possibly new) value is returned. Values that arrive with { s } are copied, so the
 * result never shares structure with the patch.
 */
export function applyPatch(target: unknown, p: Patch): unknown {
  if ('s' in p) return structuredClone(p.s);
  if ('a' in p) {
    if (!Array.isArray(target)) throw new Error('patch: expected an array');
    for (const [i, sub] of p.a) {
      if (!Number.isInteger(i) || i < 0 || i >= target.length) throw new Error('patch: index out of range');
      target[i] = applyPatch(target[i], sub);
    }
    return target;
  }
  if (!isObj(target)) throw new Error('patch: expected an object');
  for (const k of Object.keys(p.o)) {
    if (UNSAFE.has(k)) throw new Error('patch: unsafe key');
    target[k] = applyPatch(target[k], p.o[k]);
  }
  for (const k of p.x ?? []) if (!UNSAFE.has(k)) delete target[k];
  return target;
}
