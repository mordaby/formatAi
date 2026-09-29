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
  attachTo?: string;
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

/** Every case under `casesDir`, optionally filtered to names containing `substring`
 * (case-insensitive). Sorted by name for deterministic run order. */
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
  if (!substring) return cases;
  const needle = substring.toLowerCase();
  return cases.filter((c) => c.name.toLowerCase().includes(needle));
}
