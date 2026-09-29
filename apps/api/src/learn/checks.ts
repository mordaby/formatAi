// SPEC 9.2 "Checking what the LLM wrote": the layers, in order, that turn a raw LLM
// response into either a usable rules file or a precise list of `RepairProblem`s for
// the next repair call. Layers 1-5 (structure/references/types/limits/format lock) are
// gates: layer 2 onward only runs once the layers before it produced a parseable
// object, and layer 7 ("run on the samples") only runs once every gate is clean,
// because `runRules` itself refuses to execute rules `checkRules` (layer 2) rejects
// (see `packages/engine/src/pipeline/runRules.ts`) - running it earlier would only
// ever report a single generic rejection on top of the precise problems already
// collected. Layer 6 (the overfitting lint) is never a gate: it always runs and always
// appends its findings to the returned rules' `assumptions`, regardless of what else
// failed, since it costs nothing and the caller may still show this attempt to a human.
import { checkFormatLock, checkLimits, typeCheck } from '@formatai/engine';
import {
  checkRules,
  fromWire,
  LearnResultSchema,
  type Format,
  type LearnResult,
  type ProfileType,
  type RepairProblem,
  type RuleProblem,
  type LearnPayload,
  type Tier,
} from '@formatai/shared';
import { overfitLint } from './overfitLint.js';
import { runOnSamples } from './sampleRun.js';

export interface ChecksOptions {
  tier: Tier;
}

export interface ChecksResult {
  problems: RepairProblem[];
  /** The parsed `LearnResult`, with any overfitting-lint findings appended to
   * `assumptions` (SPEC 9.2 layer 6) - or `null` when layer 1 (structure) itself
   * failed, since there is then no valid object to return at all. */
  rules: LearnResult | null;
}

function ruleProblemToRepairProblem(p: RuleProblem): RepairProblem {
  // RuleProblem's sub-kinds (reference/depth/duplicateId/arity) are all SPEC 9.2
  // layer 2 "References" - RepairProblem has one `reference` kind for the whole
  // layer, with no separate `path` field, so the path is folded into the message.
  return { kind: 'reference', message: p.path ? `${p.path}: ${p.message}` : p.message };
}

/** SPEC 9.2 layer 2, beyond `checkRules` (which only checks references *within* the
 * rules file): every declared input header must actually exist in the payload (the
 * LLM is told to copy headers exactly, LEARN_PROMPT "Languages and direction"), and
 * `from: null` must appear EXACTLY on `skipColumns` ∪ `unsupported` - never more,
 * never less (LEARN_PROMPT: "Do not list them in unsupported; they are already
 * reported", and SPEC 8.10: an unsupported column "has `from: null`"). */
function extraReferenceProblems(rules: LearnResult, payload: LearnPayload): RepairProblem[] {
  const problems: RepairProblem[] = [];

  const payloadHeaders = new Set(payload.input.columns.map((c) => c.header));
  for (const col of rules.input.columns) {
    if (!payloadHeaders.has(col.header)) {
      problems.push({
        kind: 'reference',
        message: `input column "${col.id}" has header "${col.header}", which does not exist in the payload`,
      });
    }
  }

  const outputHeaderAt = new Map(payload.output.columns.map((c) => [c.i, c.header] as const));
  const mustBeNull = new Set<string>();
  for (const i of payload.skipColumns ?? []) {
    const header = outputHeaderAt.get(i);
    if (header !== undefined) mustBeNull.add(header);
  }
  for (const u of rules.unsupported) mustBeNull.add(u.outputColumn);

  for (const col of rules.output.columns) {
    const shouldBeNull = mustBeNull.has(col.header);
    const isNull = col.from === null;
    if (shouldBeNull && !isNull) {
      problems.push({
        kind: 'reference',
        message: `output column "${col.header}" is in skipColumns or unsupported, so "from" must be null`,
      });
    } else if (!shouldBeNull && isNull) {
      problems.push({
        kind: 'reference',
        message: `output column "${col.header}" has "from": null but is not in skipColumns or unsupported`,
      });
    }
  }

  return problems;
}

function toProfileType(t: ProfileType): string {
  return t;
}

/** Runs every SPEC 9.2 layer, in order, on one raw (wire-shaped) LLM response. */
export function runChecks(rawJson: unknown, payload: LearnPayload, opts: ChecksOptions): ChecksResult {
  // ----- Layer 1: structure -----
  const decoded = fromWire(rawJson);
  const parsed = LearnResultSchema.safeParse(decoded);
  if (!parsed.success) {
    const problems: RepairProblem[] = parsed.error.issues.map((issue) => ({
      kind: 'schema',
      path: issue.path.map(String).join('.'),
      message: issue.message,
    }));
    return { problems, rules: null };
  }

  const rules: LearnResult = parsed.data;
  const problems: RepairProblem[] = [];

  // ----- Layer 2: references -----
  problems.push(...checkRules(rules).map(ruleProblemToRepairProblem));
  problems.push(...extraReferenceProblems(rules, payload));

  // ----- Layer 3: types -----
  const inputProfile = payload.input.columns.map((c) => ({ header: c.header, type: toProfileType(c.type) }));
  const outputTypes: Record<string, string> = {};
  for (const c of payload.output.columns) outputTypes[c.header] = toProfileType(c.type);
  problems.push(
    ...typeCheck(rules, { inputProfile, outputTypes }).map(
      (p): RepairProblem => ({ kind: 'type', path: p.path, message: p.message }),
    ),
  );

  // ----- Layer 4: limits and safety -----
  problems.push(
    ...checkLimits(rules, opts.tier).map((p): RepairProblem => ({ kind: 'limit', path: p.path, message: p.message })),
  );

  // ----- Layer 5: format lock (attach mode only) -----
  if (payload.target) {
    const format: Format = {
      output: payload.target.output,
      layout: payload.target.layout,
      outputValidations: payload.target.validations,
    };
    problems.push(
      ...checkFormatLock(rules, format).map(
        (p): RepairProblem => ({ kind: 'formatMismatch', path: p.path, message: p.message }),
      ),
    );
  }

  // ----- Layer 6: overfitting lint (never a rejection) -----
  const lintAssumptions = overfitLint(rules, payload);
  const rulesWithLint: LearnResult =
    lintAssumptions.length > 0 ? { ...rules, assumptions: [...rules.assumptions, ...lintAssumptions] } : rules;

  // ----- Layer 7: run on the samples (only once every gate above is clean) -----
  if (problems.length === 0) {
    problems.push(...runOnSamples(rulesWithLint, payload));
  }

  return { problems, rules: rulesWithLint };
}
