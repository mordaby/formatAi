// The "Advanced" view (SPEC 8.11: "The raw JSON stays behind an Advanced toggle and is validated on save").
// The text shows the rules exactly as stored, except that every expression is written as FORMULA TEXT
// (`round(amount * 0.17, 2)`), the same notation the learn uses (SPEC 8.3); saving parses it back into the
// whitelisted trees. Nothing in it is ever executed.
import { canonicalizeRules, formulaRulesFromWire, formulaRulesToWire } from '@formatai/engine/formula';
import { fail } from './problems';
import type { EditableRules, EditProblem } from './types';
import { stable } from './rulesUtil';
import { validateEdit } from './validate';
import { LearnResultSchema, RulesSchema } from '@formatai/shared';

/** The rules as the Advanced view shows them. */
export function advancedJsonOf(rules: EditableRules): string {
  return JSON.stringify(formulaRulesToWire(rules), null, 2);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Reads the Advanced text back into rules: JSON, then formulas, then the schema (layer 1) and the
 * references (layer 2). Returns the new rules, or every problem found (a bad formula says where).
 * Text that says the same thing as `current` gives `current` back unchanged.
 */
export function parseAdvancedJson(text: string, current: EditableRules): EditableRules | EditProblem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail({ code: 'json', message: e instanceof Error ? e.message : 'this is not valid JSON' });
  }
  if (!isRecord(raw)) return fail({ code: 'json', message: 'the rules must be one JSON object' });

  const { rules: decoded, problems: formulaProblems } = formulaRulesFromWire(raw);
  if (formulaProblems.length > 0) {
    return formulaProblems.map((p) =>
      p.kind === 'formula'
        ? { code: 'formula' as const, message: p.message, path: p.path, offset: p.offset }
        : { code: 'formula' as const, message: 'message' in p ? String(p.message) : 'a formula could not be read' },
    );
  }

  const stored = isRecord(decoded) && ('meta' in decoded || 'name' in decoded);
  const parsed = stored ? RulesSchema.safeParse(decoded) : LearnResultSchema.safeParse(decoded);
  if (!parsed.success) {
    return parsed.error.issues.slice(0, 8).map((i) => ({ code: 'schema' as const, message: i.message, path: i.path.map(String).join('.') }));
  }
  const next: EditableRules = parsed.data;
  if (stable(canonicalizeRules(next)) === stable(canonicalizeRules(current))) return current;

  const problems = validateEdit(current, next);
  return problems.length > 0 ? problems : next;
}
