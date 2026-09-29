import { describe, expect, it } from 'vitest';
import { learnResultJsonSchema } from '../src/rules/jsonSchema';

/** Every fixed-shape object node (one with `properties`) must be closed. Genuine
 * open dictionaries (e.g. valueMaps.map) have no `properties` key and are exempt. */
function findOpenObjectPaths(node: unknown, path: string, out: string[]): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => findOpenObjectPaths(child, `${path}[${i}]`, out));
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.type === 'object' && obj.properties && obj.additionalProperties !== false) {
    out.push(path);
  }
  for (const key of Object.keys(obj)) {
    if (key === '$schema') continue;
    findOpenObjectPaths(obj[key], `${path}.${key}`, out);
  }
}

describe('learnResultJsonSchema', () => {
  it('requires exactly the LEARN_PROMPT §5 top-level keys', () => {
    const schema = learnResultJsonSchema();
    expect(schema.required).toEqual([
      'schemaVersion',
      'input',
      'transform',
      'output',
      'validations',
      'unsupported',
      'assumptions',
    ]);
  });

  it('has no object with a fixed shape that allows additional properties', () => {
    const schema = learnResultJsonSchema();
    const offenders: string[] = [];
    findOpenObjectPaths(schema, '$', offenders);
    expect(offenders).toEqual([]);
  });

  it('is valid, parseable JSON with a $defs section for the recursive Expr type', () => {
    const schema = learnResultJsonSchema();
    expect(JSON.parse(JSON.stringify(schema))).toBeTruthy();
    expect(schema.$defs).toBeTruthy();
  });
});
