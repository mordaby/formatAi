// Try flow C on your own files: apply saved rules to a new file. No LLM, nothing leaves your computer.
//   pnpm convert <rules.json> <new-file> [--out result.xlsx]
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { convertFile } from '@formatai/engine';
import { flagMessages, type LearnResult } from '@formatai/shared';
import { cellText, fail, parseArgs, userPath } from './common';

const { positional, flags } = parseArgs(process.argv.slice(2));
if (positional.length < 2) fail('Usage: pnpm convert <rules.json> <new-file> [--out result.xlsx]');
const rulesPath = userPath(positional[0]!);
const filePath = userPath(positional[1]!);

let rules: LearnResult;
try {
  rules = JSON.parse(readFileSync(rulesPath, 'utf8')) as LearnResult;
} catch {
  fail(`Can't read rules from ${rulesPath}`);
}
let bytes: Uint8Array;
try {
  bytes = new Uint8Array(readFileSync(filePath));
} catch {
  fail(`Can't read ${filePath}`);
}

const ext = rules.output.file?.type ?? 'xlsx';
const outPath = flags.out
  ? userPath(flags.out)
  : join(dirname(filePath), `${basename(filePath, extname(filePath))}.converted.${ext}`);

const started = Date.now();
const result = await convertFile(rules, bytes, basename(filePath));
if (!result.ok) {
  const missing = result.error.missing?.length ? ` Missing columns: ${result.error.missing.join(', ')}` : '';
  fail(`This file doesn't match the rules (${result.error.code}).${missing}`);
}

writeFileSync(outPath, result.bytes);
const s = result.summary;
console.log(`\nConverted ${basename(filePath)} → ${outPath}  (${Date.now() - started} ms)`);
console.log(`  rows in ${s.rowsIn}, rows out ${s.rowsOut}, filtered ${s.rowsFiltered}, duplicates removed ${s.duplicatesRemoved.length}, flagged duplicates ${s.duplicatesFlagged}, blocked ${s.blockedRows.length}`);
if (result.flags.length) {
  console.log(`\n${result.flags.length} flagged cell(s) to check:`);
  for (const f of result.flags.slice(0, 20)) {
    const msg = (flagMessages as Record<string, { en: string }>)[f.messageKey]?.en ?? f.messageKey;
    const text = msg.replace(/\{(\w+)\}/g, (_, k: string) => String(f.params?.[k] ?? `{${k}}`));
    console.log(`  row ${f.rowNumber}, ${f.column} = ${cellText(f.value)}: ${text}${f.suggestion !== undefined ? ` (suggestion: ${f.suggestion})` : ''}`);
  }
  if (result.flags.length > 20) console.log(`  … and ${result.flags.length - 20} more`);
}
console.log('');
