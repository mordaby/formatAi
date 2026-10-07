// Issue #45: the schema every learn call really sends (`learnResultWireJsonSchema`), against OpenAI's strict-mode rules (the structured
// outputs guide, "Supported schemas", checked 2026-10-05), and the round trip of an answer through what OpenAI would return for it.
import { learnResultWireJsonSchema, learnStepWireJsonSchema, wireAnswerSchema, wireStepSchema } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { stripOpenAiNulls, toOpenAiStrictSchema } from '../../src/llm/schema/toOpenAiStrictSchema.js';

type JsonNode = Record<string, unknown>;

const isObject = (v: unknown): v is JsonNode => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A small validator for the JSON Schema subset these schemas use - enough to say whether OpenAI could produce a value. */
function valid(schema: unknown, value: unknown): boolean {
  if (!isObject(schema)) return true;
  const s = schema;
  if (Array.isArray(s.anyOf) && !s.anyOf.some((c) => valid(c, value))) return false;
  if (Array.isArray(s.oneOf) && s.oneOf.filter((c) => valid(c, value)).length !== 1) return false;
  if ('const' in s && value !== s.const) return false;
  if (Array.isArray(s.enum) && !s.enum.includes(value)) return false;
  if (s.type !== undefined) {
    const types = (Array.isArray(s.type) ? s.type : [s.type]) as string[];
    const typeOk = (t: string): boolean =>
      t === 'null'
        ? value === null
        : t === 'integer'
          ? Number.isInteger(value)
          : t === 'array'
            ? Array.isArray(value)
            : t === 'object'
              ? isObject(value)
              : typeof value === t;
    if (!types.some(typeOk)) return false;
  }
  if (typeof value === 'string') {
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(value)) return false;
    if (typeof s.minLength === 'number' && value.length < s.minLength) return false;
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) return false;
    if (typeof s.maximum === 'number' && value > s.maximum) return false;
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) return false;
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) return false;
    if (s.items !== undefined && !value.every((v) => valid(s.items, v))) return false;
  }
  if (isObject(value) && isObject(s.properties)) {
    const props = s.properties;
    if (Array.isArray(s.required) && !(s.required as string[]).every((k) => k in value)) return false;
    if (s.additionalProperties === false && Object.keys(value).some((k) => !(k in props))) return false;
    if (!Object.entries(value).every(([k, x]) => !(k in props) || valid(props[k], x))) return false;
  }
  return true;
}

/** What OpenAI returns for `value` under the strict schema: every property present, in the schema's order, `null` where it is absent. */
function fillLikeOpenAi(schema: unknown, value: unknown): unknown {
  if (!isObject(schema)) return value;
  if (Array.isArray(schema.anyOf)) {
    for (const c of schema.anyOf) {
      const filled = fillLikeOpenAi(c, value);
      if (valid(c, filled)) return filled;
    }
    return value;
  }
  if (isObject(value) && isObject(schema.properties)) {
    const props = schema.properties;
    if (Object.keys(value).some((k) => !(k in props))) return value;
    return Object.fromEntries(Object.keys(props).map((k) => [k, k in value ? fillLikeOpenAi(props[k], value[k]) : null]));
  }
  if (Array.isArray(value) && schema.items !== undefined) return value.map((x) => fillLikeOpenAi(schema.items, x));
  return value;
}

/**
 * A valid answer generated from the ORIGINAL wire schema: member / enum value / type number `branch` of every union (modulo its size), and
 * every optional field (`optional`) or none. Strings are unique, so the answer's ids never collide.
 */
function generate(schema: unknown, opts: { branch: number; optional: boolean }, counter = { n: 0 }): unknown {
  const s = schema as JsonNode;
  const members = (s.oneOf ?? s.anyOf) as unknown[] | undefined;
  if (members) return generate(members[opts.branch % members.length], opts, counter);
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum)) return s.enum[opts.branch % s.enum.length];
  const types = (Array.isArray(s.type) ? s.type : [s.type]) as string[];
  switch (types[opts.branch % types.length]) {
    case 'object': {
      const required = new Set((s.required as string[] | undefined) ?? []);
      const out: JsonNode = {};
      for (const [k, p] of Object.entries((s.properties as JsonNode | undefined) ?? {})) {
        if (required.has(k) || opts.optional) out[k] = generate(p, opts, counter);
      }
      return out;
    }
    case 'array':
      return Array.from({ length: Math.max(1, (s.minItems as number | undefined) ?? 0) }, () => generate(s.items, opts, counter));
    case 'string':
      counter.n += 1;
      return typeof s.pattern === 'string' && s.pattern.includes('\\d{4}') ? '2026-01-31' : `s${counter.n}`;
    case 'integer':
      return typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1 : typeof s.minimum === 'number' ? s.minimum : 1;
    case 'number':
      return typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1.5 : 1.5;
    case 'boolean':
      return true;
    default:
      return null;
  }
}

/** Every schema node of `root` (through properties, items, unions and $defs), with its path and object depth. */
function nodesOf(root: unknown, path = '$', depth = 0, out: { path: string; node: JsonNode; depth: number }[] = []): typeof out {
  if (!isObject(root)) return out;
  const objectDepth = root.type === 'object' ? depth + 1 : depth;
  out.push({ path, node: root, depth: objectDepth });
  for (const [k, p] of Object.entries((root.properties as JsonNode | undefined) ?? {})) nodesOf(p, `${path}.${k}`, objectDepth, out);
  if (root.items !== undefined) nodesOf(root.items, `${path}[]`, objectDepth, out);
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const members = root[key];
    if (Array.isArray(members)) members.forEach((m, i) => nodesOf(m, `${path}/${key}[${i}]`, objectDepth, out));
  }
  for (const [k, d] of Object.entries((root.$defs as JsonNode | undefined) ?? {})) nodesOf(d, `${path}/$defs/${k}`, objectDepth, out);
  return out;
}

/**
 * The schemas the API really sends: the rules answer (learn-v7) and the learn-v9 step answer
 * (`{ checks, rules }`, AI code checks - every call of a learn-v9 learn). `wrap` puts a rules answer where that schema has it.
 */
const SCHEMAS: { label: string; original: JsonNode; zod: ReturnType<typeof wireStepSchema>; wrap: (rules: JsonNode) => JsonNode; rulesOf: (answer: JsonNode) => JsonNode }[] = [
  { label: 'rules', original: learnResultWireJsonSchema(), zod: wireAnswerSchema(), wrap: (r) => r, rulesOf: (a) => a },
  { label: 'learn-v9 step { checks, rules }', original: learnStepWireJsonSchema(), zod: wireStepSchema(), wrap: (r) => ({ checks: null, rules: r }), rulesOf: (a) => a.rules as JsonNode },
];

for (const { label, original, zod, wrap, rulesOf } of SCHEMAS) {
  describe(`issue #45: the real wire schema (${label}) meets OpenAI's strict rules`, () => {
    const strict = toOpenAiStrictSchema(original);
    const nodes = nodesOf(strict);

    it('the root is an object, not a union', () => {
      expect(strict.type).toBe('object');
      expect(strict.anyOf).toBeUndefined();
      expect(strict.oneOf).toBeUndefined();
    });

    it('every object lists every property in `required` and has additionalProperties: false', () => {
      const objects = nodes.filter(({ node }) => node.type === 'object' || node.properties !== undefined);
      expect(objects.length).toBeGreaterThan(40);
      for (const { path, node } of objects) {
        const keys = Object.keys((node.properties as JsonNode | undefined) ?? {}).sort();
        const required = [...((node.required as string[] | undefined) ?? [])].sort();
        expect({ path, required, ap: node.additionalProperties }).toEqual({ path, required: keys, ap: false });
      }
    });

    it('uses no keyword outside the supported subset, and a type list only as one type plus null', () => {
      const unsupported = ['oneOf', 'allOf', 'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', '$schema', 'minLength', 'maxLength', 'patternProperties'];
      for (const { path, node } of nodes) {
        for (const key of unsupported) expect({ path, key, has: key in node }).toEqual({ path, key, has: false });
        if (Array.isArray(node.type)) expect({ path, nonNull: node.type.filter((t) => t !== 'null').length }).toEqual({ path, nonNull: 1 });
      }
    });

    it('stays within the size limits (5,000 properties, 10 levels, 1,000 enum values, 120,000 characters of names and values)', () => {
      let props = 0;
      let enumValues = 0;
      let chars = 0;
      for (const { node } of nodes) {
        const names = Object.keys((node.properties as JsonNode | undefined) ?? {});
        props += names.length;
        chars += names.join('').length;
        if (Array.isArray(node.enum)) {
          enumValues += node.enum.length;
          chars += node.enum.map(String).join('').length;
        }
        if ('const' in node) chars += String(node.const).length;
      }
      expect(props).toBeLessThanOrEqual(5000);
      expect(Math.max(...nodes.map((n) => n.depth))).toBeLessThanOrEqual(10);
      expect(enumValues).toBeLessThanOrEqual(1000);
      expect(chars).toBeLessThanOrEqual(120_000);
    });

    it('every oneOf of the original is a discriminated union, so anyOf means the same', () => {
      const unions = nodesOf(original).filter(({ node }) => Array.isArray(node.oneOf));
      expect(unions.length).toBeGreaterThanOrEqual(4);
      for (const { path, node } of unions) {
        const branches = node.oneOf as JsonNode[];
        const keys = Object.keys((branches[0]!.properties as JsonNode | undefined) ?? {});
        const discriminated = keys.some((k) => {
          const consts = branches.map((b) => ((b.properties as JsonNode | undefined)?.[k] as JsonNode | undefined)?.const);
          return consts.every((c) => c !== undefined) && new Set(consts).size === consts.length;
        });
        expect({ path, discriminated }).toEqual({ path, discriminated: true });
      }
    });

    it('a length bound became the same pattern: an empty id is still refused, any other text accepted', () => {
      const id = nodes.find((n) => n.path.endsWith('.transform.computed[].id'))!.node;
      expect(id.minLength).toBeUndefined();
      expect(valid(id, '')).toBe(false);
      expect(valid(id, 'x')).toBe(true);
      expect(valid(id, 'two\nlines')).toBe(true);
    });

    it('a cell of several types became anyOf of single types, accepting the same values', () => {
      const cell = nodes.find((n) => n.path.endsWith('.rows[][]'))!.node;
      expect(cell.anyOf).toEqual([{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }]);
      for (const v of ['a', 1.5, false, null]) expect(valid(cell, v)).toBe(true);
      expect(valid(cell, [])).toBe(false);
    });

    it('round trip on every union branch, with every optional field and with none: OpenAI could return it, and it maps back to the same answer, which parses', () => {
      const widest = Math.max(...nodesOf(original).map(({ node }) => ((node.oneOf ?? node.anyOf ?? node.enum ?? []) as unknown[]).length));
      let checked = 0;
      for (let branch = 0; branch < widest; branch++) {
        for (const optional of [true, false]) {
          const label = `branch ${branch}, optional fields ${optional ? 'all' : 'none'}`;
          const answer = generate(original, { branch, optional });
          const parsed = zod.safeParse(answer);
          expect(parsed.success, `${label}: ${JSON.stringify(parsed.error?.issues.slice(0, 2))}`).toBe(true);
          const fromOpenAi = fillLikeOpenAi(strict, answer);
          expect(valid(strict, fromOpenAi), `${label}: OpenAI could return it`).toBe(true);
          if (!optional) expect(JSON.stringify(fromOpenAi), label).toContain('null');
          const back = stripOpenAiNulls(original, fromOpenAi);
          expect(back, label).toEqual(answer);
          expect(zod.safeParse(back).success, label).toBe(true);
          checked++;
        }
      }
      expect(checked).toBeGreaterThanOrEqual(20);
    });

    it("round trip of a real answer (crm-rename-reorder's rules, in wire form)", () => {
      const rules = {
        schemaVersion: 1,
        input: {
          sheet: { pick: 'first' },
          headerRow: 'auto',
          columns: [
            { id: 'customerId', header: 'Customer ID', type: 'idLike', required: true },
            { id: 'email', header: 'Email', type: 'text' },
            { id: 'status', header: 'Status', type: 'text' },
          ],
        },
        transform: { computed: [], valueMaps: [], sort: [] },
        output: {
          file: { type: 'csv', header: true, encoding: 'utf8' },
          sheetName: 'CRM Import',
          direction: 'ltr',
          language: 'en',
          titleRows: [],
          headerStyle: { bold: true },
          columns: [
            { header: 'Contact ID', from: 'customerId' },
            { header: 'Email Address', from: 'email' },
            { header: 'Account Status', from: 'status' },
          ],
        },
        validations: [],
        unsupported: [],
        assumptions: [],
      };
      const answer = wrap(rules);
      const parsed = zod.safeParse(answer);
      expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
      const fromOpenAi = fillLikeOpenAi(strict, answer);
      expect(valid(strict, fromOpenAi)).toBe(true);
      expect((rulesOf(fromOpenAi as JsonNode) as { input: JsonNode }).input).toMatchObject({ stopAt: null, rowFilters: null });
      expect(stripOpenAiNulls(original, fromOpenAi)).toEqual(answer);
    });
  });
}

describe('learn-v9: a checks answer through the strict rewrite and back', () => {
  const original = learnStepWireJsonSchema();
  const strict = toOpenAiStrictSchema(original);

  it('each check, with its optional let / where absent or present, comes back as it was; rules stays null', () => {
    const answers: JsonNode[] = [
      { checks: [{ check: 'test', column: 'Class', rule: 'if(out2 < 1000, "Small", "Big")' }], rules: null },
      { checks: [{ check: 'ranges', column: 'Class', by: 'total', let: [{ id: 'total', expr: 'in2 * in3' }], where: 'in4 = "Open"' }], rules: null },
      { checks: [{ check: 'dependsOn', column: 'Class', on: ['in1', 'in4'] }, { check: 'values', column: 'Class' }, { check: 'rows', where: 'in2 > 3', limit: 2 }], rules: null },
    ];
    for (const answer of answers) {
      expect(wireStepSchema().safeParse(answer).success).toBe(true);
      const fromOpenAi = fillLikeOpenAi(strict, answer);
      expect(valid(strict, fromOpenAi)).toBe(true);
      expect(stripOpenAiNulls(original, fromOpenAi)).toEqual(answer);
    }
  });

  it('both top-level fields stay required and nullable after the rewrite: their nulls are kept (they are not optional fields)', () => {
    expect(strict.required).toEqual(['checks', 'rules']);
    expect(stripOpenAiNulls(original, { checks: null, rules: null })).toEqual({ checks: null, rules: null });
  });
});

describe('toOpenAiStrictSchema - the rewrites on their own', () => {
  it('oneOf -> anyOf, a nested union flattened, and a nullable union flattened too', () => {
    const schema = {
      type: 'object',
      properties: {
        f: { anyOf: [{ oneOf: [{ type: 'string' }, { type: 'number' }] }, { type: 'boolean' }] },
        g: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      },
      required: ['f'],
      additionalProperties: false,
    };
    const props = (toOpenAiStrictSchema(schema) as JsonNode).properties as JsonNode;
    expect(props.f).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] });
    expect(props.g).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] });
  });

  it('minLength / maxLength -> the equivalent pattern; an existing pattern is kept; $schema is dropped', () => {
    const out = toOpenAiStrictSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        a: { type: 'string', minLength: 1 },
        b: { type: 'string', minLength: 2, maxLength: 5 },
        c: { type: 'string', minLength: 1, pattern: '^x' },
      },
      required: ['a', 'b', 'c'],
      additionalProperties: false,
    }) as JsonNode;
    const props = out.properties as JsonNode;
    expect(out.$schema).toBeUndefined();
    expect(props.a).toEqual({ type: 'string', pattern: '^[\\s\\S]{1,}$' });
    expect(props.b).toEqual({ type: 'string', pattern: '^[\\s\\S]{2,5}$' });
    expect(props.c).toEqual({ type: 'string', pattern: '^x' });
    expect(new RegExp((props.b as JsonNode).pattern as string).test('abcdef')).toBe(false);
    expect(new RegExp((props.b as JsonNode).pattern as string).test('abc')).toBe(true);
  });

  it('a type list with one non-null type is kept (the documented form); several become anyOf', () => {
    const out = toOpenAiStrictSchema({
      type: 'object',
      properties: { a: { type: ['string', 'null'] }, b: { type: ['string', 'number'] } },
      required: ['a', 'b'],
      additionalProperties: false,
    }) as JsonNode;
    expect((out.properties as JsonNode).a).toEqual({ type: ['string', 'null'] });
    expect((out.properties as JsonNode).b).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }] });
  });

  it('never rewrites data: a const value that looks like a schema is copied as it is', () => {
    const out = toOpenAiStrictSchema({ type: 'object', properties: { a: { const: { oneOf: 1 } } }, required: ['a'], additionalProperties: false }) as JsonNode;
    expect((out.properties as JsonNode).a).toEqual({ const: { oneOf: 1 } });
  });

  it('stripOpenAiNulls looks inside a union nested in a union (a row filter is anyOf[oneOf[comparisons], expr])', () => {
    const schema = {
      type: 'object',
      properties: {
        f: {
          anyOf: [
            { oneOf: [{ type: 'object', properties: { op: { const: 'eq' }, note: { type: 'string' } }, required: ['op'], additionalProperties: false }] },
            { type: 'object', properties: { expr: { type: 'string' } }, required: ['expr'], additionalProperties: false },
          ],
        },
      },
      required: ['f'],
      additionalProperties: false,
    };
    expect(stripOpenAiNulls(schema, { f: { op: 'eq', note: null } })).toEqual({ f: { op: 'eq' } });
    expect(stripOpenAiNulls(schema, { f: { expr: 'a > 1' } })).toEqual({ f: { expr: 'a > 1' } });
  });
});
