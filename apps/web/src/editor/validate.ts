// SPEC 9.2 layers 1-2 for one edit: the result must still be a valid rules file (zod) and must not add
// reference problems (checkRules). Layers 3-6 (types, limits, format lock) need the engine and run in the
// worker (`staticChecks`); the editor's own steps already catch the type mistakes a person can make there.
import { checkRules, LearnResultSchema, RulesSchema, type RuleProblem } from '@formatai/shared';
import type { EditableRules, EditProblem } from './types';
import { isStored } from './rulesUtil';
import { layoutTypeProblems } from './typeChecks';

// Rules are never mutated, so a check of one rules object stays true: the rules an edit produces are the next edit's
// "before", and are checked only once.
const referenceCache = new WeakMap<object, RuleProblem[]>();
/** What the editor checks for a NEW edit: also that no function is named like a built-in (a stored file is never refused for it). */
const checkEdited = (r: EditableRules): RuleProblem[] => checkRules(r, { rejectBuiltinFunctionNames: true });
const typeCache = new WeakMap<object, EditProblem[]>();
function cached<T>(cache: WeakMap<object, T>, rules: EditableRules, compute: (r: EditableRules) => T): T {
  let hit = cache.get(rules);
  if (hit === undefined) {
    hit = compute(rules);
    cache.set(rules, hit);
  }
  return hit;
}

export function schemaProblems(rules: EditableRules): EditProblem[] {
  const parsed = isStored(rules) ? RulesSchema.safeParse(rules) : LearnResultSchema.safeParse(rules);
  if (parsed.success) return [];
  return parsed.error.issues.slice(0, 8).map((i) => ({
    code: 'schema' as const,
    message: i.message,
    path: i.path.map(String).join('.'),
  }));
}

/** `checkRules` findings in `after` that `before` did not already have (so an old problem never blocks an unrelated edit). */
export function newReferenceProblems(before: EditableRules, after: EditableRules): EditProblem[] {
  const prior = new Map<string, number>();
  for (const p of cached(referenceCache, before, checkEdited)) {
    const key = `${p.kind}|${p.message}`;
    prior.set(key, (prior.get(key) ?? 0) + 1);
  }
  const out: EditProblem[] = [];
  for (const p of cached(referenceCache, after, checkEdited)) {
    const key = `${p.kind}|${p.message}`;
    const n = prior.get(key) ?? 0;
    if (n > 0) prior.set(key, n - 1);
    else out.push({ code: 'reference', message: p.message, path: p.path });
  }
  return out;
}

/**
 * Type problems in what an edit can break beyond the step's own checks - a summary row or check on a column whose
 * type the edit changed - that `before` did not already have. (Same sentences as the engine's `typeCheck`.)
 */
export function newTypeProblems(before: EditableRules, after: EditableRules): EditProblem[] {
  const prior = new Map<string, number>();
  for (const p of cached(typeCache, before, layoutTypeProblems)) prior.set(p.message, (prior.get(p.message) ?? 0) + 1);
  const out: EditProblem[] = [];
  for (const p of cached(typeCache, after, layoutTypeProblems)) {
    const n = prior.get(p.message) ?? 0;
    if (n > 0) prior.set(p.message, n - 1);
    else out.push(p);
  }
  return out;
}

/** Schema first (a hard stop), then what the edit broke: references, then types. */
export function validateEdit(before: EditableRules, after: EditableRules): EditProblem[] {
  const schema = schemaProblems(after);
  if (schema.length > 0) return schema;
  const refs = newReferenceProblems(before, after);
  if (refs.length > 0) return refs;
  return newTypeProblems(before, after);
}
