// Shared scaffolding for eval/cases/build.ts: turning a case's in-memory
// description (input bytes, a reference rules file, expectations) into the
// on-disk layout SPEC 10 defines (`eval/cases/<name>/input.*`, `output.*`,
// `meta.json`, optionally `reference.rules.json` and the `next.*` hold-out
// pair). Kept separate from build.ts so each of the 17 case builders can stay
// focused on its own data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LearnResult, Rules, RulesMeta } from '@formatai/shared';
import type { OutputFileSpec } from '@formatai/engine';
import { convertFile } from '@formatai/engine';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

/** `eval/cases/` itself - this file lives one level below it, in `lib/`. */
export function casesRoot(): string {
  return path.join(LIB_DIR, '..');
}

export type Difficulty = 'easy' | 'medium' | 'hard';

/** SPEC 10's case-format `expect` field: a single classification, or - for the
 * one case that demonstrates SPEC 7.2's masking accuracy gap - a per-masking-mode
 * pair (documented in README.md). */
export type Expect = string | { masking_on: string; masking_off: string };

export interface CaseMeta {
  difficulty: Difficulty;
  domain: string;
  features: string[];
  expect: Expect;
  attachTo?: string;
}

export interface FileArtifact {
  /** Extension only, e.g. "xlsx" | "csv" | "txt" (no leading dot). */
  ext: string;
  bytes: Uint8Array;
}

export interface CaseSpec {
  name: string;
  meta: CaseMeta;
  input: FileArtifact;
  output: FileArtifact;
  /** Only for `expect: "verified"` cases (SPEC 10): the hold-out pair the future
   * runner uses to check the learned rules generalize to "next month"'s file. */
  next?: { input: FileArtifact; output: FileArtifact };
  /** Omitted for the two cases the engine's rules language can't produce at all
   * (pivot, external-data column) - see README.md. */
  referenceRules?: Rules;
}

const DEFAULT_META: RulesMeta = { source: 'examplePair', status: 'verified' };

/** Assembles a full `Rules` object (LearnResult + name/meta) from a body that
 * only needs to state the schema-required LearnResult fields. Every eval
 * reference rules file uses the same meta shape (SPEC 13/8.12): learned from an
 * example pair, verified against it. */
export function mkRules(name: string, body: LearnResult, metaOverrides: Partial<RulesMeta> = {}): Rules {
  return { ...body, name, meta: { ...DEFAULT_META, ...metaOverrides } };
}

/** Runs the real engine pipeline (SPEC 8.2) end to end, exactly as flow C/D
 * would, so a "verified" case's output.* is produced by the engine itself, not
 * hand-simulated (see build.ts's file header for why that's the whole point). */
export async function runConvert(
  rules: Rules,
  bytes: Uint8Array,
  fileName: string,
  fileOverride?: OutputFileSpec,
): Promise<Uint8Array> {
  const result = await convertFile(rules, bytes, fileName, fileOverride ? { file: fileOverride } : {});
  if (!result.ok) {
    throw new Error(`convertFile failed for ${fileName}: ${JSON.stringify(result.error)}`);
  }
  return result.bytes;
}

function writeFile(dir: string, baseName: string, artifact: FileArtifact): void {
  fs.writeFileSync(path.join(dir, `${baseName}.${artifact.ext}`), Buffer.from(artifact.bytes));
}

/** Writes one case's full on-disk layout (SPEC 10), overwriting any previous
 * contents of `eval/cases/<name>/` so re-running build.ts is idempotent. */
export function writeCase(spec: CaseSpec): void {
  const dir = path.join(casesRoot(), spec.name);
  fs.mkdirSync(dir, { recursive: true });

  // Clear stale sibling files from a previous shape of this case (e.g. an input
  // extension that changed between runs) before writing the current ones.
  for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { force: true });

  writeFile(dir, 'input', spec.input);
  writeFile(dir, 'output', spec.output);
  if (spec.next) {
    writeFile(dir, 'next.input', spec.next.input);
    writeFile(dir, 'next.output', spec.next.output);
  }
  if (spec.referenceRules) {
    fs.writeFileSync(path.join(dir, 'reference.rules.json'), `${JSON.stringify(spec.referenceRules, null, 2)}\n`);
  }
  const meta: CaseMeta = spec.meta;
  fs.writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
}
