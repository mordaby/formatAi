// The provider-side schema transformation for OpenAI's structured outputs with `strict: true` (issue #45). Checked against OpenAI's
// "Structured model outputs" guide, section "Supported schemas", on 2026-10-05. Its rules, and what the wire schema the API sends
// (`learnResultWireJsonSchema`, packages/shared/src/rules/wire.ts) does about each - every change keeps the schema's meaning exactly, and
// `stripOpenAiNulls` maps the answer back so it parses with the same zod schema:
//   1. "All fields must be required"; an optional field is emulated "by using a union type with null". The wire schema has optional fields
//      (47): each is listed in `required` and becomes `anyOf: [original, { type: "null" }]` (the guide's own
//      recursive example uses this form). `stripOpenAiNulls` drops those nulls again.
//   2. "additionalProperties: false must always be set in objects": the wire schema already has it on every object (its open dictionaries
//      are `{ key, value }` pair lists on the wire). The API-side `learnResultJsonSchema` still has open dictionaries; this transform passes
//      them through, so that schema cannot be sent to OpenAI - the wire schema is the one every call sends.
//   3. Supported types and keywords: string `pattern` / `format`; number `minimum` / `maximum` / `exclusiveMinimum` / `exclusiveMaximum` /
//      `multipleOf`; array `minItems` / `maxItems`; `enum`, `const`, `anyOf`, `$defs` / `$ref`. Not supported: `allOf`, `not`, `if` / `then`
//      / `else`, `dependentRequired`, `dependentSchemas`. The wire schema uses none of the unsupported ones, but three things it has are not
//      on the supported list:
//      - `oneOf` (the discriminated unions: `input.sheet`, a row filter's comparison, `transform.expand`, `validations[]`). Every branch of
//        each has a different `const` on the same key, so at most one branch can match and `anyOf` means the same: it becomes `anyOf`
//        (a test asserts every `oneOf` of the wire schema is discriminated). A nested `anyOf` is flattened into its parent's.
//      - `minLength` (the ids and names, `minLength: 1`). The guide lists only `pattern` and `format` for strings, and names `minLength` /
//        `maxLength` among the keywords fine-tuned models "additionally" do not support. DECISION: rewritten as the equivalent `pattern`
//        (`^[\s\S]{1,}$`), which the guide does list, rather than relying on a keyword it does not.
//      - a type list of more than one non-null type (`["string", "number", "boolean", "null"]`, a filter's or a table's cell value). The
//        guide shows only `["string", "null"]`: it becomes `anyOf` of single types.
//   4. "Root objects must not be anyOf and must be an object": the wire root is an object. `$schema` (the draft's URL, a note, no
//      constraint) is not on the list and is dropped.
//   5. Limits: at most 5,000 object properties and 10 levels of nesting, 120,000 characters of names / enum and const values, 1,000 enum
//      values. The wire schema has about 200 properties, 5 levels, 150 enum values (a test checks the limits on the real schema).

type JsonSchemaNode = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonSchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSchemaNode(value: unknown): value is JsonSchemaNode {
  return isPlainObject(value);
}

/** Keywords whose value is data, not a schema: copied as they are, never walked. */
const DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples', 'pattern', 'format', 'description', 'title', '$ref']);

/** Keywords the transform drops (see the file comment, rule 4). */
const DROPPED_KEYWORDS = new Set(['$schema']);

/** Recursively applies the strict-mode transform to every schema node reachable from `root`. */
export function toOpenAiStrictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return transformNode(schema) as Record<string, unknown>;
}

/** A node that is nothing but a union (an `anyOf` and at most a description): its members can join its parent union. */
function isBareUnion(node: unknown): node is { anyOf: unknown[] } {
  return isSchemaNode(node) && Array.isArray(node.anyOf) && Object.keys(node).every((k) => k === 'anyOf' || k === 'description' || k === 'title');
}

/** `anyOf` members with every bare nested union spliced in (`anyOf[anyOf[a, b], c]` means `anyOf[a, b, c]`). */
function flattenUnion(members: unknown[]): unknown[] {
  return members.flatMap((m) => (isBareUnion(m) ? flattenUnion(m.anyOf) : [m]));
}

/** An originally optional field, made required and nullable (rule 1). */
function nullable(schema: unknown): JsonSchemaNode {
  return { anyOf: flattenUnion([schema, { type: 'null' }]) };
}

/** A string's length bounds as the equivalent `pattern` (rule 3); `[\s\S]` is any character, a line break included. */
function lengthPattern(min: unknown, max: unknown): string {
  const lo = typeof min === 'number' ? min : 0;
  const hi = typeof max === 'number' ? String(max) : '';
  return `^[\\s\\S]{${lo},${hi}}$`;
}

function transformNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(transformNode);
  }
  if (!isSchemaNode(node)) {
    return node;
  }

  // Rule 3: a type list with more than one non-null type -> anyOf of single types (only when nothing else on the node would need to be
  // shared out among them; the wire schema's are bare).
  if (Array.isArray(node.type)) {
    const types = node.type as unknown[];
    const nonNull = types.filter((t) => t !== 'null');
    const bare = Object.keys(node).every((k) => k === 'type' || k === 'description' || k === 'title');
    if (nonNull.length > 1 && bare) {
      const { type: _type, ...rest } = node;
      return { ...rest, anyOf: types.map((t) => ({ type: t })) };
    }
  }

  const out: JsonSchemaNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && isSchemaNode(value)) continue; // handled below, together with `required`
    if (key === 'required') continue; // handled below
    if (DROPPED_KEYWORDS.has(key)) continue;
    if (key === 'minLength' || key === 'maxLength') continue; // handled below (rule 3)
    if (DATA_KEYWORDS.has(key)) {
      out[key] = value;
    } else if (key === 'anyOf' || key === 'oneOf') {
      // Rule 3: `oneOf` -> `anyOf` (every one in the wire schema is discriminated); nested unions flattened.
      const members = flattenUnion(Array.isArray(value) ? (value.map(transformNode) as unknown[]) : []);
      out.anyOf = Array.isArray(out.anyOf) ? [...(out.anyOf as unknown[]), ...members] : members;
    } else if ((key === '$defs' || key === 'definitions') && isSchemaNode(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, def]) => [name, transformNode(def)]));
    } else {
      out[key] = transformNode(value);
    }
  }

  // Rule 3: a string's length bounds -> the equivalent pattern. A node that already has a pattern keeps it (two patterns cannot be joined
  // without a lookahead, which OpenAI's regex does not have); the API's own check (`LearnResultSchema`) still enforces the length.
  if ('minLength' in node || 'maxLength' in node) {
    const isString = node.type === 'string' || (Array.isArray(node.type) && node.type.includes('string'));
    if (isString && out.pattern === undefined) out.pattern = lengthPattern(node.minLength, node.maxLength);
  }

  const properties = node.properties;
  if (isSchemaNode(properties)) {
    const originalRequired = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    const newProperties: JsonSchemaNode = {};
    const newRequired: string[] = [];

    for (const [propName, propSchema] of Object.entries(properties)) {
      const transformedProp = transformNode(propSchema);
      newProperties[propName] = originalRequired.has(propName) ? transformedProp : nullable(transformedProp);
      newRequired.push(propName);
    }

    out.properties = newProperties;
    out.required = newRequired;
  }

  return out;
}

/**
 * Removes the nulls `toOpenAiStrictSchema` forced onto originally-optional fields, so
 * the result validates against the original (non-strict) zod/JSON schema again - a
 * field OpenAI returned as `null` because it was optional-in-disguise is dropped
 * entirely rather than kept as `null`. A field whose ORIGINAL schema genuinely allows
 * `null` as a required value (e.g. a `const` value of `null`) is left untouched, since
 * `originalSchema`/`originalRequired` here always reflect the schema BEFORE the
 * strict-mode transform.
 *
 * Walks `value` alongside `originalSchema` (the pre-transform schema passed to
 * `toOpenAiStrictSchema`), resolving `$ref` against its own `$defs` and, for a
 * `oneOf`/`anyOf` node, picking whichever candidate structurally matches the concrete
 * value (closed schemas + `const` fields make this unambiguous for this schema's
 * discriminated-union style).
 */
export function stripOpenAiNulls(originalSchema: Record<string, unknown>, value: unknown): unknown {
  return strip(originalSchema, value, originalSchema);
}

function resolveRef(root: JsonSchemaNode, ref: string): JsonSchemaNode | undefined {
  if (!ref.startsWith('#/')) return undefined;
  const parts = ref.slice(2).split('/');
  let node: unknown = root;
  for (const part of parts) {
    if (!isSchemaNode(node)) return undefined;
    node = node[part];
  }
  return isSchemaNode(node) ? node : undefined;
}

function resolve(schema: unknown, root: JsonSchemaNode): JsonSchemaNode | undefined {
  if (!isSchemaNode(schema)) return undefined;
  if (typeof schema.$ref === 'string') {
    const resolved = resolveRef(root, schema.$ref);
    return resolved ? resolve(resolved, root) : undefined;
  }
  return schema;
}

/** A union's members, with every nested union's members spliced in (a row filter is `anyOf[oneOf[comparisons], expr]`). */
function candidatesOf(schema: JsonSchemaNode, root: JsonSchemaNode): unknown[] | undefined {
  const members = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (!members) return undefined;
  return members.flatMap((m) => {
    const resolved = resolve(m, root);
    const nested = resolved && !isSchemaNode(resolved.properties) ? candidatesOf(resolved, root) : undefined;
    return nested ?? [m];
  });
}

/** Picks whichever union member's shape matches `value` (see the doc comment above). */
function pickCandidate(candidates: unknown[], value: unknown, root: JsonSchemaNode): JsonSchemaNode | undefined {
  if (value === null) {
    return candidates.map((c) => resolve(c, root)).find((c) => c?.type === 'null');
  }
  if (Array.isArray(value)) {
    // An array may hold objects with optional-field nulls: walk it with the union's array member.
    return candidates.map((c) => resolve(c, root)).find((c) => c?.type === 'array');
  }
  if (!isPlainObject(value)) {
    // Primitive value: nothing here to disambiguate for our purposes, since
    // only object nodes carry the optional-field nulls this function strips.
    return undefined;
  }

  const valueKeys = new Set(Object.keys(value));
  let best: JsonSchemaNode | undefined;
  let bestScore = -1;

  for (const candidate of candidates) {
    const resolved = resolve(candidate, root);
    if (!resolved || !isSchemaNode(resolved.properties)) continue;

    const props = resolved.properties as JsonSchemaNode;
    const propKeys = new Set(Object.keys(props));
    const required = Array.isArray(resolved.required) ? (resolved.required as string[]) : [];

    const requiredOk = required.every((k) => valueKeys.has(k));
    const keysOk = [...valueKeys].every((k) => propKeys.has(k));
    if (!requiredOk || !keysOk) continue;

    let score = required.length;
    for (const key of Object.keys(props)) {
      const propSchema = props[key];
      if (isSchemaNode(propSchema) && 'const' in propSchema && (value as JsonSchemaNode)[key] === propSchema.const) {
        score += 10;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = resolved;
    }
  }

  return best;
}

function strip(schemaIn: unknown, value: unknown, root: JsonSchemaNode): unknown {
  const schema = resolve(schemaIn, root);
  if (!schema) return value;

  const candidates = candidatesOf(schema, root);
  if (candidates) {
    const match = pickCandidate(candidates, value, root);
    return match ? strip(match, value, root) : value;
  }

  if (isSchemaNode(schema.properties) && isPlainObject(value)) {
    const props = schema.properties as JsonSchemaNode;
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    const additionalProperties = schema.additionalProperties;
    const out: JsonSchemaNode = {};

    for (const [key, v] of Object.entries(value)) {
      const propSchema = props[key];
      const wasOptional = propSchema !== undefined && !required.has(key);
      if (v === null && wasOptional) continue; // drop the null OpenAI added for an optional field

      if (propSchema !== undefined) {
        out[key] = strip(propSchema, v, root);
      } else if (isSchemaNode(additionalProperties)) {
        out[key] = strip(additionalProperties, v, root);
      } else {
        out[key] = v;
      }
    }
    return out;
  }

  if (schema.type === 'array' && Array.isArray(value)) {
    const items = schema.items;
    return items === undefined ? value : value.map((item) => strip(items, item, root));
  }

  return value;
}
