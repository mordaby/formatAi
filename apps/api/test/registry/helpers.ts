// Shared fixtures and a small HTTP helper for the registry tests: two sources of one format (a source
// with columns ID/Amount, another with Code/Price, both producing ID and Total), and edits of the output side.
import type { LearnResult, Rules } from '@formatai/shared';
import type { FastifyInstance } from 'fastify';
import { correctRules } from '../learn/fixtures.js';
import { TEST_USER } from '../protection/harness.js';

export { TEST_USER };

/** Source 1: ID <- ID, Total <- Amount x 2. (The learn fixtures' "correct rules".) */
export function sourceOne(): LearnResult {
  return correctRules();
}

/** Source 2 of the same format: its own input columns (Code, Price) and its own computed id, same output. */
export function sourceTwo(): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'code', header: 'Code', type: 'idLike', required: true },
        { id: 'price', header: 'Price', type: 'decimal', required: true },
      ],
    },
    transform: {
      computed: [{ id: 'cost', type: 'decimal', expr: { op: 'mul', args: [{ col: 'price' }, { const: 2 }] } }],
      valueMaps: [],
      sort: [],
    },
    output: {
      sheetName: 'Out',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [
        { header: 'ID', from: 'code' },
        { header: 'Total', from: 'cost' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

/** The body the browser sends to save a learned result. */
export function saveBody(rules: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rules,
    status: 'verified',
    acceptedDifferences: 0,
    exampleExceptions: [],
    learnPath: 'llm',
    masking: false,
    model: 'fake-model',
    promptVersion: 'learn-v7',
    ...over,
  };
}

/** A deep copy of `rules` changed by `edit` - what the rules map does on Apply. */
export function edited<T extends LearnResult | Rules>(rules: T, edit: (r: T) => void): T {
  const copy = structuredClone(rules);
  edit(copy);
  return copy;
}

export interface CallOptions {
  /** A user id (24 hex characters); `null` = not signed in. Default: `TEST_USER`. */
  user?: string | null;
  tier?: 'registered' | 'paid';
}

export interface Response<T = any> {
  status: number;
  body: T;
}

/** `call('POST', '/api/formats', body, { user })` against the app, with the stubbed identity headers. */
export function makeCaller(app: FastifyInstance) {
  return async function call<T = any>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    o: CallOptions = {},
  ): Promise<Response<T>> {
    const user = o.user === undefined ? TEST_USER : o.user;
    const res = await app.inject({
      method,
      url,
      remoteAddress: '198.51.100.7',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(user ? { 'x-test-user': user, 'x-test-tier': o.tier ?? 'registered' } : {}),
      },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed: unknown = null;
    try {
      parsed = res.body === '' ? null : res.json();
    } catch {
      parsed = res.body;
    }
    return { status: res.statusCode, body: parsed as T };
  };
}
