// Checking and shaping a rules file on its way into the registry (SPEC 9.2 layers 1-5 on every save, 8.12, 13).
// Pure functions: no database, no request - so they are unit-tested on their own.
//
// What one saved format may keep (docs/proposals/saved-format-contents.md section 7; owner, 2026-10-06; SPEC 11, 21 v15): every route that
// stores rules checks them with `checkRulesFile`, which refuses a file over a cap - a value map of more than `limits.rules.maxValueMapEntries`
// entries, a value longer than `maxValueChars`, one version larger than `maxRulesBytes` (shared `contentLimitProblems`) - before anything
// else, and the route answers 400 `rulesTooLarge` (`rulesRefusal`). The browser checks the same caps first (the engine's `checkLimits`).
import { checkFormatLock, checkLimits, formatOf, inputSignatureOf, typeCheck } from '@formatai/engine';
import {
  checkRules,
  contentLimitProblems,
  RulesSchema,
  stripAiNotesFromJson,
  type Format,
  type LearnResult,
  type RepairProblem,
  type Rules,
  type RulesMetaLearnPath,
  type RulesMetaSource,
  type RulesMetaStatus,
  type SignatureColumn,
  type Tier,
} from '@formatai/shared';

/** What the rules file is checked to be (SPEC 9.2 layers 1-4: structure, references, types, limits). */
export type RulesCheck =
  | { ok: true; rules: Rules }
  | {
      ok: false;
      problems: RepairProblem[];
      /** The rules pass every check except the tier's "rules per format" count (SPEC 11): the caller answers
       * with the limit code rather than with problems to fix. */
      onlyRuleLimit: boolean;
      /** Over a cap of what one saved format may keep (see the file header): the caller answers 400 `rulesTooLarge`. */
      tooLarge?: true;
    };

/** `checkLimits` reports the rule count as its one problem without a path (see engine `check/limits.ts`);
 * its wording names "rules per format". */
const RULE_LIMIT_MESSAGE = /rules per format/;

const isRuleLimitProblem = (p: { path?: string; message: string }): boolean =>
  p.path === undefined && RULE_LIMIT_MESSAGE.test(p.message);

/**
 * Layers 1-4 of SPEC 9.2 for a rules file that arrives from the browser (no example data here, so no input
 * profile and no diff). Never throws: a rules file so malformed that a checker itself fails is reported as a
 * problem.
 */
export function checkRulesFile(input: unknown, tier: Tier): RulesCheck {
  // SPEC 15 (learn-v7): the AI's explanation and function request are never saved with a rules file, whatever the client sent.
  const parsed = RulesSchema.safeParse(stripAiNotesFromJson(input));
  if (!parsed.success) {
    return {
      ok: false,
      onlyRuleLimit: false,
      problems: parsed.error.issues.map(
        (issue): RepairProblem => ({ kind: 'schema', path: issue.path.map(String).join('.'), message: issue.message }),
      ),
    };
  }
  const rules = parsed.data as unknown as Rules;
  // The caps of what a saved format may keep, first (SPEC 21 v15): a plain refusal, never problems to fix one by one. (Counts only.)
  const tooLarge = contentLimitProblems(rules);
  if (tooLarge.length > 0) return { ok: false, onlyRuleLimit: false, tooLarge: true, problems: [] };

  const problems: RepairProblem[] = [];
  let ruleLimit = false;
  try {
    for (const p of checkRules(rules)) {
      problems.push({ kind: 'reference', message: p.path ? `${p.path}: ${p.message}` : p.message });
    }
    for (const p of typeCheck(rules)) problems.push({ kind: 'type', path: p.path, message: p.message });
    for (const p of checkLimits(rules, tier)) {
      if (isRuleLimitProblem(p)) ruleLimit = true;
      else problems.push({ kind: 'limit', ...(p.path !== undefined ? { path: p.path } : {}), message: p.message });
    }
  } catch {
    problems.push({ kind: 'reference', message: 'the rules could not be checked' });
  }

  if (problems.length === 0 && !ruleLimit) return { ok: true, rules };
  return { ok: false, problems, onlyRuleLimit: problems.length === 0 && ruleLimit };
}

/** The format lock (SPEC 8.12) as API problems. */
export function lockProblems(rules: Rules | LearnResult, format: Format): RepairProblem[] {
  return checkFormatLock(rules, format).map((p): RepairProblem => ({ kind: 'formatMismatch', path: p.path, message: p.message }));
}

export interface SaveMeta {
  /** The rules file's own name when it has none. */
  name: string;
  formatId: string;
  sourceName: string;
  status: RulesMetaStatus;
  source: RulesMetaSource;
  learnPath: RulesMetaLearnPath;
  masking: boolean;
  model?: string;
  promptVersion?: string;
  now: Date;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The rules file as it is stored: the browser's `rules` (a full rules file, or a bare learn result) with `name`
 * and `meta` set by the server, so that `meta.formatId`, `sourceName`, `status` and the rest always agree with
 * the conversion document (SPEC 13). The result still has to pass `checkRulesFile`.
 */
export function withMeta(rawInput: unknown, m: SaveMeta): unknown {
  // SPEC 15 (learn-v7): never saved with the rules - the web strips them too, the API does not rely on it.
  const raw = stripAiNotesFromJson(rawInput);
  if (!isRecord(raw)) return raw;
  const oldMeta = isRecord(raw.meta) ? raw.meta : {};
  const meta: Record<string, unknown> = {
    ...oldMeta,
    formatId: m.formatId,
    sourceName: m.sourceName,
    source: m.source,
    status: m.status,
    learnPath: m.learnPath,
    masking: m.masking,
    createdAt: typeof oldMeta.createdAt === 'string' ? oldMeta.createdAt : m.now.toISOString(),
  };
  if (m.model !== undefined) meta.model = m.model;
  else delete meta.model;
  if (m.promptVersion !== undefined) meta.promptVersion = m.promptVersion;
  else delete meta.promptVersion;
  return { ...raw, name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : m.name, meta };
}

/** SPEC 13 `inputSignature`: what a dropped file's headers are matched against (SPEC 8.12) - the engine's own
 * `inputSignatureOf`, so what is stored is exactly what `matchConversions` reads. `required` is true only for
 * columns the rules mark so (the engine stops a run only on those). */
export function signatureOf(rules: Rules): { columns: SignatureColumn[] } {
  return inputSignatureOf(rules);
}

/** The format side of a rules file: what is stored on the format document (SPEC 13). */
export function formatFields(rules: Rules | LearnResult): Pick<Format, 'output' | 'layout' | 'outputValidations'> {
  const f = formatOf(rules);
  return { output: f.output, layout: f.layout, outputValidations: f.outputValidations };
}

/** JSON round trip: drops `undefined` (which the MongoDB driver would store as null) and detaches from the input. */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
