// A three-way merge of rules, for the deep analysis with AI: it works on the rules as they were when it started (`base`); the user
// may have edited other fields since (`ours`); the answer (`theirs`) is made for `base`. The merge keeps what the user changed and takes
// what the answer added or filled in. Anything both sides changed differently is a conflict: the result is null and the caller keeps the
// user's rules. Pure JSON: no schema knowledge beyond "lists of things with an `id` or a `name` are matched by it" - and the three lists of
// the rules whose entries have neither (`LIST_KEYS`): the unsupported columns and the assumptions are matched by their output column, the
// checks by what they are. Matched by position, two sides that both changed such a list's length would always collide (the user fills a column
// by hand - its "unsupported" entry goes - while the answer reports another one), and a good answer would be thrown away.
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

/** JSON with its object keys in order: two checks that say the same thing have the same text, however their keys were written. */
function stable(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isObject(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

type ListKey = (entry: Json) => string;
/**
 * The lists of the rules (by their place in the rules) whose entries have no `id` or `name`, and what an entry is matched by: an unsupported
 * column by its output column (one entry each), an assumption by its output column and reason, a check by all it says (a check that changes is
 * one gone and another added).
 */
const LIST_KEYS: Record<string, ListKey> = {
  unsupported: (e) => `${(e as { outputColumn?: unknown }).outputColumn}`,
  assumptions: (e) => `${(e as { outputColumn?: unknown }).outputColumn ?? ''}\u0000${(e as { reasonCode?: unknown }).reasonCode}`,
  validations: stable,
};

/** Each entry's key, made unique within its list (the second entry with the same key is `key#1`, ...). */
function keysOf(list: Json[], keyOfEntry: ListKey): string[] {
  const seen = new Map<string, number>();
  return list.map((e) => {
    const k = keyOfEntry(e);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return n === 0 ? k : `${k}#${n}`;
  });
}

/** What either side added stays, what one side removed (and the other left alone) goes, the rest merges - entry by entry, by key. */
function mergeKeyed(path: string, base: Json[], ours: Json[], theirs: Json[], keyOfEntry: ListKey): Json[] | typeof CONFLICT {
  const lists = [base, ours, theirs].map((list) => {
    const keys = keysOf(list, keyOfEntry);
    return new Map(keys.map((k, i) => [k, list[i]] as const));
  });
  const keys: string[] = [];
  for (const map of lists) for (const k of map.keys()) if (!keys.includes(k)) keys.push(k);
  const out: Json[] = [];
  for (const k of keys) {
    const v = merge3(lists[0]!.get(k), lists[1]!.get(k), lists[2]!.get(k), `${path}[]`);
    if (v === CONFLICT) return CONFLICT;
    if (v !== undefined) out.push(v);
  }
  return out;
}

function merge3(base: Json, ours: Json, theirs: Json, path = ''): Json | typeof CONFLICT {
  if (same(ours, base)) return theirs; // the user did not touch it: whatever the answer made of it
  if (same(theirs, base) || same(ours, theirs)) return ours; // the answer did not touch it (or made the same change)
  if (isObject(base) && isObject(ours) && isObject(theirs)) {
    const out: Record<string, Json> = {};
    for (const k of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
      const v = merge3(base[k], ours[k], theirs[k], path === '' ? k : `${path}.${k}`);
      if (v === CONFLICT) return CONFLICT;
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (Array.isArray(base) && Array.isArray(ours) && Array.isArray(theirs)) {
    const listKey = LIST_KEYS[path];
    if (listKey) return mergeKeyed(path, base, ours, theirs, listKey);
    const key = keyOf(base, ours, theirs);
    // Matched by id/name.
    if (key) return mergeKeyed(path, base, ours, theirs, (e) => (e as Record<string, string>)[key]!);
    if (ours.length === base.length && theirs.length === base.length) {
      const out: Json[] = [];
      for (let i = 0; i < base.length; i++) {
        const v = merge3(base[i], ours[i], theirs[i], `${path}[]`);
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
