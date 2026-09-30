// OpenAI structured-output "strict" mode requires every object's `properties` key to
// appear in `required`; a field that was optional in the source schema is instead
// made nullable (we use `anyOf: [original, {type: "null"}]`, which OpenAI accepts -
// the generated LearnResult schema already uses `anyOf`/`oneOf` extensively for its
// unions, so this is not a new shape). `$defs`/`$ref` recursion is supported by
// OpenAI (confirmed against the current structured-outputs guide) and is used as-is
// by the generated schema for its recursive expression AST, so we transform `$defs`
// entries the same way as inline schemas and leave `$ref` untouched.
//
// KNOWN LIMITATION: OpenAI strict mode requires `additionalProperties: false` on
// every object and does not support open-ended dictionaries (`additionalProperties`
// as a schema rather than `false`). The generated LearnResult schema has a few
// genuine open dictionaries by design (`valueMaps.map`, `expand.columnsToRows.labels`,
// the `fixedFanOut` position set - see packages/shared/src/rules/jsonSchema.ts),
// since they take arbitrary keys drawn from the user's own data. This transform
// passes those nodes through unchanged (recursing only into the dictionary's value
// schema), so building the request never throws, but OpenAI is expected to reject
// `strict: true` for a schema containing one of these nodes at the API level. Until
// those fields are restructured as arrays of `{ key, value }` pairs, the OpenAI
// provider is not usable for LearnResult shapes that populate them.

type JsonSchemaNode = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonSchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSchemaNode(value: unknown): value is JsonSchemaNode {
  return isPlainObject(value);
}

/** Recursively applies the strict-mode transform to every schema node reachable from `root`. */
export function toOpenAiStrictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return transformNode(schema) as Record<string, unknown>;
}

function transformNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(transformNode);
  }
  if (!isSchemaNode(node)) {
    return node;
  }

  const out: JsonSchemaNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && isSchemaNode(value)) {
      // handled below together with `required`, once we've copied everything else
      continue;
    }
    if (key === 'required') {
      // handled below
      continue;
    }
    out[key] = transformNode(value);
  }

  const properties = node.properties;
  if (isSchemaNode(properties)) {
    const originalRequired = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    const newProperties: JsonSchemaNode = {};
    const newRequired: string[] = [];

    for (const [propName, propSchema] of Object.entries(properties)) {
      const transformedProp = transformNode(propSchema);
      const wasRequired = originalRequired.has(propName);
      newProperties[propName] = wasRequired
        ? transformedProp
        : { anyOf: [transformedProp, { type: 'null' }] };
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

function candidatesOf(schema: JsonSchemaNode): unknown[] | undefined {
  if (Array.isArray(schema.anyOf)) return schema.anyOf;
  if (Array.isArray(schema.oneOf)) return schema.oneOf;
  return undefined;
}

/** Picks whichever union member's shape matches `value` (see the doc comment above). */
function pickCandidate(candidates: unknown[], value: unknown, root: JsonSchemaNode): JsonSchemaNode | undefined {
  if (value === null) {
    return candidates.map((c) => resolve(c, root)).find((c) => c?.type === 'null');
  }
  if (!isPlainObject(value)) {
    // Primitive/array value: nothing here to disambiguate for our purposes, since
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

  const candidates = candidatesOf(schema);
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
