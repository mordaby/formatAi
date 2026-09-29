// Engine entry point: validates a rules file and runs it on an input table.
//
// Saved formats live on (SPEC 8), so every schemaVersion ever released keeps
// its own runner here, frozen: a new schema version adds a new entry (and a new
// vN/ folder, or an upgrade step into the newest runner) and never changes how
// an older version runs.

import {
  LearnResultSchema,
  RulesSchema,
  checkRules,
  type LearnResult,
  type Rules,
} from '@formatai/shared';
import type { InputTable, RunResult } from '../types';
import { InternalRulesError } from './v1/rows';
import { runV1 } from './v1/run';

export interface RunRulesOptions {
  /** Copied into every Flag (SPEC 8.9). */
  fileName?: string;
}

type Runner = (rules: unknown, table: InputTable, opts: RunRulesOptions) => RunResult;

function invalidRules(reason: string, path?: string): RunResult {
  const params: Record<string, string> = { reason };
  if (path !== undefined && path !== '') params.path = path;
  return { ok: false, error: { code: 'invalidRules', params } };
}

function hasKey(o: unknown, key: string): boolean {
  return typeof o === 'object' && o !== null && Object.hasOwn(o, key);
}

// ---------- schemaVersion 1 ----------

const runSchemaV1: Runner = (raw, table, opts) => {
  // A saved Rules object carries name + meta; a fresh LearnResult doesn't.
  const parsed =
    hasKey(raw, 'name') || hasKey(raw, 'meta')
      ? RulesSchema.safeParse(raw)
      : LearnResultSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return invalidRules('schema', first ? first.path.map(String).join('.') : undefined);
  }
  const rules: LearnResult | Rules = parsed.data;
  const problems = checkRules(rules);
  if (problems.length > 0) {
    const first = problems[0];
    return invalidRules(first ? first.kind : 'check', first?.path);
  }
  try {
    return runV1(rules, table, opts);
  } catch (e) {
    // Only rule-shaped problems are turned into invalidRules; anything else is a bug.
    if (e instanceof InternalRulesError) return invalidRules('engine');
    throw e;
  }
};

const RUNNERS: Readonly<Record<number, Runner>> = {
  1: runSchemaV1,
};

/** Schema versions this engine can run. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = Object.keys(RUNNERS).map(Number);

/**
 * Runs a rules file on an input table. Pure and synchronous: the same rules and
 * the same table always give the same result.
 *
 * Returns `{ ok: false, error: { code: 'invalidRules' } }` when the rules fail
 * schema validation or checkRules (params.reason: 'schema' | 'reference' |
 * 'depth' | 'duplicateId' | 'unknownVersion' | 'engine'; params.path: the
 * first offending field), and `missingRequiredColumns` (with `missing`
 * headers) when a required input column isn't in the table.
 */
export function runRules(
  rules: LearnResult | Rules,
  table: InputTable,
  opts: RunRulesOptions = {},
): RunResult {
  const version: unknown = hasKey(rules, 'schemaVersion')
    ? (rules as { schemaVersion: unknown }).schemaVersion
    : undefined;
  const runner = typeof version === 'number' ? RUNNERS[version] : undefined;
  if (runner === undefined) return invalidRules('unknownVersion');
  return runner(rules, table, opts);
}
