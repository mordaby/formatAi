// A three-way merge of rules, for the deep analysis with AI: it works on the rules as they were when it started (`base`); the user
// may have edited other fields since (`ours`); the answer (`theirs`) is made for `base`. The merge keeps what the user changed and takes
// what the answer added or filled in. Anything both sides changed differently is a conflict: the result is null and the caller keeps the
// user's rules. Pure JSON: no schema knowledge beyond "lists of things with an `id` or a `name` are matched by it".
import type { EditableRules } from './types';

const CONFLICT = Symbol('conflict');
type Json = unknown;

function same(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  const ao = a as Record<string, Json>;
  const bo = b as Record<string, Json>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  // (an absent key is the same as an undefined one)
  for (const k of keys) if (!same(ao[k], bo[k])) return false;
  return true;
}

const isObject = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The key a list of objects is matched by: `id`, or else `name`, when every element has one (strings, all different). */
function keyOf(...lists: Json[][]): 'id' | 'name' | undefined {
  for (const key of ['id', 'name'] as const) {
    const all = lists.every((list) => {
      const seen = new Set<unknown>();
      return list.every((e) => isObject(e) && typeof e[key] === 'string' && !seen.has(e[key]) && seen.add(e[key]) !== undefined);
    });
    if (all && lists.some((l) => l.length > 0)) return key;
  }
  return undefined;
}

function merge3(base: Json, ours: Json, theirs: Json): Json | typeof CONFLICT {
  if (same(ours, base)) return theirs; // the user did not touch it: whatever the answer made of it
  if (same(theirs, base) || same(ours, theirs)) return ours; // the answer did not touch it (or made the same change)
  if (isObject(base) && isObject(ours) && isObject(theirs)) {
    const out: Record<string, Json> = {};
    for (const k of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
      const v = merge3(base[k], ours[k], theirs[k]);
      if (v === CONFLICT) return CONFLICT;
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (Array.isArray(base) && Array.isArray(ours) && Array.isArray(theirs)) {
    const key = keyOf(base, ours, theirs);
    if (key) {
      // Matched by id/name: what either side added stays, what one side removed (and the other left alone) goes, the rest merges.
      const at = (list: Json[], k: string): Json => list.find((e) => (e as Record<string, Json>)[key] === k);
      const keys: string[] = [];
      for (const list of [base, ours, theirs]) for (const e of list) if (!keys.includes((e as Record<string, string>)[key]!)) keys.push((e as Record<string, string>)[key]!);
      const out: Json[] = [];
      for (const k of keys) {
        const v = merge3(at(base, k), at(ours, k), at(theirs, k));
        if (v === CONFLICT) return CONFLICT;
        if (v !== undefined) out.push(v);
      }
      return out;
    }
    if (ours.length === base.length && theirs.length === base.length) {
      const out: Json[] = [];
      for (let i = 0; i < base.length; i++) {
        const v = merge3(base[i], ours[i], theirs[i]);
        if (v === CONFLICT) return CONFLICT;
        out.push(v);
      }
      return out;
    }
  }
  return CONFLICT;
}

/** The rules with both the user's edits since `base` and the answer's changes to it, or null when they collide. */
export function mergeRules<T extends EditableRules>(base: T, ours: T, theirs: T): T | null {
  const merged = merge3(base, ours, theirs);
  return merged === CONFLICT ? null : (merged as T);
}
