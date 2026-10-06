// Loads eval/cases/<name>/ directories (SPEC 10, eval/cases/README.md) into plain
// in-memory structures the runner can feed straight into `learnFromExamples` and the
// hold-out check. Pure file-system reads; no engine/API imports here.
import fs from 'node:fs';
import path from 'node:path';
import type { Rules } from '@formatai/shared';

export type ExpectClassification = string; // 'verified' | 'unsupported:<code>' | 'blocked:<reason>'

export interface CaseMeta {
  difficulty: string;
  domain: string;
  features: string[];
  expect: ExpectClassification | { masking_on: ExpectClassification; masking_off: ExpectClassification };
  /**
   * DECISION: a plain-words note on what the expected outcome really is, for a case whose target is richer than `expect` can say
   * (`discount-hand-edited`: "the rule for the rest, the 3 rows reported" - no classification means that yet). The harness does not
   * score it: `expect` still decides "expectation met", and the report prints the note next to the case.
   */
  expectNote?: string;
  /** Rows of `output.*` edited by hand: the reference rules differ from it in exactly this many (see `cases/README.md`); not used by the runner. */
  handEditedRows?: number;
  attachTo?: string;
  /** What the user would answer (a copied list: at Save); the runner applies it before scoring (`CaseAnswers`). Absent: nothing is answered. */
  answers?: CaseAnswers;
}

/**
 * A case's answers to the questions the user is asked (owner amendment, 2026-10-06), applied by the runner to the kept rules as the web app
 * applies them, before the run is scored (`applyCaseAnswers`). `copiedList`: the answer to every list of fixed values, asked at Save ("Save
 * this format?" - "<column> is a list of <n> fixed values taken from your example ...") - `oneTime` ("Save without it") takes the column's
 * list out, so the column needs your input; `rule` ("Keep it") keeps it, which is the same as no answer. `identifier`
 * (docs/proposals/saved-format-contents.md section 6): the answer to every identifier-shaped value the rules keep ("<column> keeps an ID
 * number in its rules") - `without` ("Save without it") takes its column out (reason `savedWithout`); `keep` keeps it, the same as no answer.
 */
export interface CaseAnswers {
  copiedList?: 'oneTime' | 'rule';
  identifier?: 'keep' | 'without';
}

export interface CaseFile {
  fileName: string;
  bytes: Uint8Array;
}

export interface CaseDef {
  name: string;
  dir: string;
  meta: CaseMeta;
  input: CaseFile;
  output: CaseFile;
  next?: { input: CaseFile; output: CaseFile };
  referenceRules?: Rules;
}

function findArtifact(dir: string, base: string): CaseFile | undefined {
  if (!fs.existsSync(dir)) return undefined;
  const entries = fs.readdirSync(dir);
  const match = entries.find((e) => e.startsWith(`${base}.`));
  if (!match) return undefined;
  return { fileName: match, bytes: new Uint8Array(fs.readFileSync(path.join(dir, match))) };
}

/** One case directory, or undefined when `dir` isn't a case (no meta.json - e.g. `lib/`). */
export function loadCase(dir: string): CaseDef | undefined {
  const metaPath = path.join(dir, 'meta.json');
  if (!fs.existsSync(metaPath)) return undefined;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as CaseMeta;
  const input = findArtifact(dir, 'input');
  const output = findArtifact(dir, 'output');
  if (!input || !output) throw new Error(`eval case "${path.basename(dir)}": missing input.* or output.*`);

  const nextInput = findArtifact(dir, 'next.input');
  const nextOutput = findArtifact(dir, 'next.output');
  const next = nextInput && nextOutput ? { input: nextInput, output: nextOutput } : undefined;

  const rulesPath = path.join(dir, 'reference.rules.json');
  const referenceRules = fs.existsSync(rulesPath) ? (JSON.parse(fs.readFileSync(rulesPath, 'utf-8')) as Rules) : undefined;

  return { name: path.basename(dir), dir, meta, input, output, next, referenceRules };
}

/** Every case under `casesDir`, optionally filtered to the names containing `substring` (case-insensitive). `substring` may be a
 * comma-separated list ("purchase-orders,registry-supplier-"): a case is kept when its name contains ANY of them. Sorted by name for
 * deterministic run order. */
export function loadCases(casesDir: string, substring?: string): CaseDef[] {
  const names = fs
    .readdirSync(casesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const cases: CaseDef[] = [];
  for (const name of names) {
    const def = loadCase(path.join(casesDir, name));
    if (def) cases.push(def);
  }
  const needles = (substring ?? '')
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length > 0);
  if (needles.length === 0) return cases;
  return cases.filter((c) => needles.some((needle) => c.name.toLowerCase().includes(needle)));
}
