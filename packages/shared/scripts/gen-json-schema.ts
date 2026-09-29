// Writes the LearnResult JSON Schema to generated/learn-result.schema.json.
// Run after any change to src/rules/schema.ts:
//   pnpm --filter @formatai/api exec tsx ../../packages/shared/scripts/gen-json-schema.ts
//   (or: node --experimental-strip-types packages/shared/scripts/gen-json-schema.ts)
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { learnResultJsonSchema } from '../src/rules/jsonSchema';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'generated');
const outPath = path.join(outDir, 'learn-result.schema.json');

function main(): void {
  mkdirSync(outDir, { recursive: true });
  const schema = learnResultJsonSchema();
  writeFileSync(outPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outPath}`);
}

main();
