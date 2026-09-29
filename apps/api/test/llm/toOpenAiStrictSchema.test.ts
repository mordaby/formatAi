import { learnResultJsonSchema, RulesInputSchema } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { stripOpenAiNulls, toOpenAiStrictSchema } from '../../src/llm/schema/toOpenAiStrictSchema.js';

type JsonNode = Record<string, unknown>;

/** Recursively asserts every object node's `properties` keys exactly equal `required` (OpenAI strict mode's rule), across `properties`, `items`, `$defs`, and every `anyOf`/`oneOf` member. */
function assertEveryObjectFullyRequired(node: unknown, path = '$'): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => assertEveryObjectFullyRequired(child, `${path}[${i}]`));
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const obj = node as JsonNode;

  if (obj.properties && typeof obj.properties === 'object') {
    const propKeys = Object.keys(obj.properties as JsonNode).sort();
    const required = (Array.isArray(obj.required) ? (obj.required as string[]) : []).slice().sort();
    expect({ path, required }).toEqual({ path, required: propKeys });
    for (const [key, value] of Object.entries(obj.properties as JsonNode)) {
      assertEveryObjectFullyRequired(value, `${path}.properties.${key}`);
    }
  }
  if (obj.items) assertEveryObjectFullyRequired(obj.items, `${path}.items`);
  if (Array.isArray(obj.anyOf)) obj.anyOf.forEach((c, i) => assertEveryObjectFullyRequired(c, `${path}.anyOf[${i}]`));
  if (Array.isArray(obj.oneOf)) obj.oneOf.forEach((c, i) => assertEveryObjectFullyRequired(c, `${path}.oneOf[${i}]`));
  if (Array.isArray(obj.allOf)) obj.allOf.forEach((c, i) => assertEveryObjectFullyRequired(c, `${path}.allOf[${i}]`));
  if (obj.$defs && typeof obj.$defs === 'object') {
    for (const [key, value] of Object.entries(obj.$defs as JsonNode)) {
      assertEveryObjectFullyRequired(value, `${path}.$defs.${key}`);
    }
  }
}

describe('toOpenAiStrictSchema - basic transform', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      nickname: { type: 'string' },
    },
    required: ['name'],
    additionalProperties: false,
  };

  it('adds every optional property to `required`', () => {
    const result = toOpenAiStrictSchema(schema) as JsonNode;
    expect(result.required).toEqual(['name', 'nickname']);
  });

  it('wraps a previously-optional property as anyOf[original, null]', () => {
    const result = toOpenAiStrictSchema(schema) as JsonNode;
    const props = result.properties as JsonNode;
    expect(props.name).toEqual({ type: 'string' });
    expect(props.nickname).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
  });

  it('preserves additionalProperties: false', () => {
    const result = toOpenAiStrictSchema(schema) as JsonNode;
    expect(result.additionalProperties).toBe(false);
  });

  it('recurses into nested objects and arrays', () => {
    const nested = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { a: { type: 'string' }, b: { type: 'string' } },
            required: ['a'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    };
    const result = toOpenAiStrictSchema(nested) as JsonNode;
    const itemSchema = ((result.properties as JsonNode).items as JsonNode).items as JsonNode;
    expect(itemSchema.required).toEqual(['a', 'b']);
  });
});

describe('toOpenAiStrictSchema - recursive $ref/$defs', () => {
  const recursiveSchema = {
    type: 'object',
    properties: { value: { $ref: '#/$defs/node' } },
    required: ['value'],
    additionalProperties: false,
    $defs: {
      node: {
        type: 'object',
        properties: {
          op: { type: 'string' },
          label: { type: 'string' },
          child: { $ref: '#/$defs/node' },
        },
        required: ['op'],
        additionalProperties: false,
      },
    },
  };

  it('transforms $defs entries the same way as inline schemas, leaving $ref untouched', () => {
    const result = toOpenAiStrictSchema(recursiveSchema) as JsonNode;
    const node = (result.$defs as JsonNode).node as JsonNode;
    expect(node.required).toEqual(['op', 'label', 'child']);
    expect((node.properties as JsonNode).child).toEqual({
      anyOf: [{ $ref: '#/$defs/node' }, { type: 'null' }],
    });
  });

  it('round-trips a recursive value through stripOpenAiNulls', () => {
    // What OpenAI would send back: every optional field present, null when absent.
    const filled = {
      value: {
        op: 'a',
        label: null,
        child: { op: 'b', label: 'inner', child: null },
      },
    };
    const stripped = stripOpenAiNulls(recursiveSchema, filled);
    expect(stripped).toEqual({
      value: { op: 'a', child: { op: 'b', label: 'inner' } },
    });
  });
});

describe('stripOpenAiNulls - does not strip a legitimately-null required value', () => {
  const schema = {
    type: 'object',
    properties: {
      value: {
        oneOf: [
          {
            type: 'object',
            properties: { const: { type: ['string', 'number', 'boolean', 'null'] } },
            required: ['const'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { col: { type: 'string' } },
            required: ['col'],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ['value'],
    additionalProperties: false,
  };

  it('keeps `null` when the matching union branch requires the field', () => {
    const value = { value: { const: null } };
    expect(stripOpenAiNulls(schema, value)).toEqual({ value: { const: null } });
  });

  it('picks the correct oneOf branch by required-key/closed-schema matching', () => {
    const value = { value: { col: 'amount' } };
    expect(stripOpenAiNulls(schema, value)).toEqual({ value: { col: 'amount' } });
  });
});

describe('toOpenAiStrictSchema / stripOpenAiNulls - the real generated LearnResult schema', () => {
  it('makes every object (including every $defs entry) fully required', () => {
    const strict = toOpenAiStrictSchema(learnResultJsonSchema());
    assertEveryObjectFullyRequired(strict);
  });

  it('preserves additionalProperties: false at the root', () => {
    const strict = toOpenAiStrictSchema(learnResultJsonSchema()) as JsonNode;
    expect(strict.additionalProperties).toBe(false);
  });

  it('round-trips a real `input` value (nested optional fields, discriminated unions, no $ref needed) through strip', () => {
    const rootSchema = learnResultJsonSchema() as JsonNode;
    const inputSchema = { ...(rootSchema.properties as JsonNode).input as JsonNode, $defs: rootSchema.$defs };

    const sampleInput = {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'a', header: 'A', type: 'text' },
        {
          id: 'b',
          header: 'B',
          type: 'integer',
          aliases: ['B2'],
          required: true,
          padLeft: 3,
          inputFormats: ['0000'],
        },
      ],
      rowFilters: [{ column: 'a', op: 'isEmpty' }],
    };
    // Sanity check: this is a genuinely valid RulesInput before we do anything to it.
    expect(() => RulesInputSchema.parse(sampleInput)).not.toThrow();

    // What OpenAI would hand back for this value under the strict schema: `stopAt`
    // (optional, omitted) becomes null, and every optional InputColumn field not set
    // on the first column becomes null too.
    const openAiFilled = {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      stopAt: null,
      columns: [
        { id: 'a', header: 'A', aliases: null, type: 'text', required: null, padLeft: null, inputFormats: null },
        {
          id: 'b',
          header: 'B',
          aliases: ['B2'],
          type: 'integer',
          required: true,
          padLeft: 3,
          inputFormats: ['0000'],
        },
      ],
      rowFilters: [{ column: 'a', op: 'isEmpty' }],
    };

    const stripped = stripOpenAiNulls(inputSchema, openAiFilled);
    expect(stripped).toEqual(sampleInput);
    expect(() => RulesInputSchema.parse(stripped)).not.toThrow();
  });
});
