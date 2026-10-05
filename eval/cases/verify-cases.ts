#!/usr/bin/env -S pnpm exec tsx
// Sanity-checks every case build.ts wrote (SPEC 10), before the real runner
// (eval/run.ts, built later) ever touches them:
//   1. every input.*/output.*/next.input.*/next.output.* opens with the
//      engine's own `readWorkbook` (i.e. is a genuinely valid xlsx/csv/txt);
//   2. every `reference.rules.json` parses against `RulesSchema` and passes
//      `checkRules`/`typeCheck`/`checkLimits` with no problems;
//   3. for a verified case, running `convertFile(referenceRules, ...)` on
//      input.* reproduces output.* byte-for-byte, and on next.input.*
//      reproduces next.output.* byte-for-byte (the actual "holds up on next
//      month's file" check SPEC 10 asks the hold-out pair for) - except a case
//      with `handEditedRows`: its rules reproduce output.* in every row but
//      exactly that many (the rows a person edited by hand);
//   4. the registry trio (registry-supplier-a/b/c) satisfies the format lock
//      (SPEC 8.12): `checkFormatLock` finds no problems for b/c against a's format.
//
// Run with: pnpm --filter @formatai/eval exec tsx cases/verify-cases.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFormatLock, checkLimits, formatOf, readWorkbook, typeCheck } from '@formatai/engine';
import { checkRules, RulesSchema } from '@formatai/shared';
import type { Rules } from '@formatai/shared';
import { convertFile } from '@formatai/engine';

const CASES_DIR = path.dirname(fileURLToPath(import.meta.url));

interface CaseMeta {
  difficulty: string;
  domain: string;
  features: string[];
  expect: unknown;
  handEditedRows?: number;
  attachTo?: string;
}

let failures = 0;
let checks = 0;

function fail(label: string, message: string): void {
  failures++;
  console.error(`FAIL  ${label}: ${message}`);
}
function ok(label: string): void {
  checks++;
  console.log(`ok    ${label}`);
}

function findArtifact(dir: string, base: string): { fileName: string; bytes: Uint8Array } | undefined {
  const entries = fs.readdirSync(dir);
  const match = entries.find((e) => e.startsWith(`${base}.`));
  if (!match) return undefined;
  return { fileName: match, bytes: new Uint8Array(fs.readFileSync(path.join(dir, match))) };
}

async function checkOpens(label: string, fileName: string, bytes: Uint8Array): Promise<void> {
  try {
    const wb = await readWorkbook(bytes, fileName);
    if (wb.sheets.length === 0 || wb.sheets.every((s) => s.rows.length === 0)) {
      fail(label, `${fileName} opened but has no rows`);
      return;
    }
    ok(`${label}: ${fileName} opens via readWorkbook`);
  } catch (err) {
    fail(label, `${fileName} failed to open: ${String(err)}`);
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

async function checkReproduces(
  label: string,
  rules: Rules,
  inputFile: { fileName: string; bytes: Uint8Array },
  expectedFile: { fileName: string; bytes: Uint8Array },
  what: string,
): Promise<void> {
  const result = await convertFile(rules, inputFile.bytes, inputFile.fileName);
  if (!result.ok) {
    fail(label, `convertFile(${what}) failed: ${JSON.stringify(result.error)}`);
    return;
  }
  if (!bytesEqual(result.bytes, expectedFile.bytes)) {
    fail(label, `convertFile(${what}) output does not byte-match ${expectedFile.fileName}`);
    return;
  }
  ok(`${label}: convertFile(${what}) reproduces ${expectedFile.fileName} byte-for-byte`);
}

/** A case whose example output was edited by hand in `expected` rows: the rules differ from output.* in exactly that many data rows. */
async function checkDiffersInRows(
  label: string,
  rules: Rules,
  inputFile: { fileName: string; bytes: Uint8Array },
  outputFile: { fileName: string; bytes: Uint8Array },
  expected: number,
): Promise<void> {
  const result = await convertFile(rules, inputFile.bytes, inputFile.fileName);
  if (!result.ok) {
    fail(label, `convertFile(input -> output) failed: ${JSON.stringify(result.error)}`);
    return;
  }
  const made = (await readWorkbook(result.bytes, outputFile.fileName)).sheets[0]!.rows;
  const given = (await readWorkbook(outputFile.bytes, outputFile.fileName)).sheets[0]!.rows;
  if (made.length !== given.length) {
    fail(label, `the rules make ${made.length} rows, ${outputFile.fileName} has ${given.length}`);
    return;
  }
  const differing = made.filter((row, i) => JSON.stringify(row.map((c) => c?.v ?? null)) !== JSON.stringify((given[i] ?? []).map((c) => c?.v ?? null))).length;
  if (differing !== expected) fail(label, `the rules differ from ${outputFile.fileName} in ${differing} row(s), expected exactly ${expected} (handEditedRows)`);
  else ok(`${label}: the rules reproduce ${outputFile.fileName} in every row but the ${expected} hand-edited ones`);
}

async function main(): Promise<void> {
  const entries = fs
    .readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const rulesByCase = new Map<string, Rules>();

  for (const name of entries) {
    const dir = path.join(CASES_DIR, name);
    const metaPath = path.join(dir, 'meta.json');
    if (!fs.existsSync(metaPath)) continue; // not a case dir (e.g. lib/)

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as CaseMeta;
    const label = name;

    const input = findArtifact(dir, 'input');
    const output = findArtifact(dir, 'output');
    if (!input) { fail(label, 'missing input.*'); continue; }
    if (!output) { fail(label, 'missing output.*'); continue; }

    await checkOpens(label, input.fileName, input.bytes);
    await checkOpens(label, output.fileName, output.bytes);

    const nextInput = findArtifact(dir, 'next.input');
    const nextOutput = findArtifact(dir, 'next.output');
    const expectsVerified =
      meta.expect === 'verified' || (typeof meta.expect === 'object' && meta.expect !== null && 'masking_off' in meta.expect);

    if (expectsVerified) {
      if (!nextInput || !nextOutput) {
        fail(label, 'expected a next.input.*/next.output.* hold-out pair (case expects to verify)');
      }
    } else if (nextInput || nextOutput) {
      fail(label, 'has a next.* hold-out pair but does not expect to verify');
    }
    if (nextInput) await checkOpens(label, nextInput.fileName, nextInput.bytes);
    if (nextOutput) await checkOpens(label, nextOutput.fileName, nextOutput.bytes);

    const rulesPath = path.join(dir, 'reference.rules.json');
    if (fs.existsSync(rulesPath)) {
      const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8')) as Rules;
      rulesByCase.set(name, rules);

      const parsed = RulesSchema.safeParse(rules);
      if (!parsed.success) fail(label, `RulesSchema: ${parsed.error.message}`);
      else ok(`${label}: reference.rules.json parses (RulesSchema)`);

      const refProblems = checkRules(rules);
      if (refProblems.length > 0) fail(label, `checkRules found problems: ${JSON.stringify(refProblems)}`);
      else ok(`${label}: checkRules clean`);

      const typeProblems = typeCheck(rules);
      if (typeProblems.length > 0) fail(label, `typeCheck found problems: ${JSON.stringify(typeProblems)}`);
      else ok(`${label}: typeCheck clean`);

      const limitProblems = checkLimits(rules, 'paid');
      if (limitProblems.length > 0) fail(label, `checkLimits found problems: ${JSON.stringify(limitProblems)}`);
      else ok(`${label}: checkLimits clean`);

      if (meta.handEditedRows !== undefined) await checkDiffersInRows(label, rules, input, output, meta.handEditedRows);
      else await checkReproduces(label, rules, input, output, 'input -> output');
      if (nextInput && nextOutput) {
        await checkReproduces(label, rules, nextInput, nextOutput, 'next.input -> next.output');
      }
    } else if (expectsVerified) {
      fail(label, 'expects to verify but has no reference.rules.json');
    }
  }

  // Registry format lock (SPEC 8.12).
  const a = rulesByCase.get('registry-supplier-a');
  const b = rulesByCase.get('registry-supplier-b');
  const c = rulesByCase.get('registry-supplier-c');
  if (a && b && c) {
    const format = formatOf(a);
    const bProblems = checkFormatLock(b, format);
    if (bProblems.length > 0) fail('registry-supplier-b', `checkFormatLock vs a: ${JSON.stringify(bProblems)}`);
    else ok('registry-supplier-b: checkFormatLock against registry-supplier-a finds no problems');

    const cProblems = checkFormatLock(c, format);
    if (cProblems.length > 0) fail('registry-supplier-c', `checkFormatLock vs a: ${JSON.stringify(cProblems)}`);
    else ok('registry-supplier-c: checkFormatLock against registry-supplier-a finds no problems');
  } else {
    fail('registry', 'expected registry-supplier-a/b/c to all have reference.rules.json');
  }

  console.log(`\n${checks} checks passed, ${failures} failed.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
