import { API_ERROR_CODES, LIMIT_CODES, type LearnPayload, type LearnResult } from '@formatai/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, isApiError, toApiError } from '../src/api';

const payload = { masking: true } as unknown as LearnPayload;
const rules = { schemaVersion: 1 } as unknown as LearnResult;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

function apiWith(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init ?? {}));
  return { api: createApi({ baseUrl: 'https://api.test', fetch: fetchMock as unknown as typeof fetch }), fetchMock };
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>, call = 0): unknown {
  return JSON.parse((fetchMock.mock.calls[call]![1] as RequestInit).body as string);
}

describe('requests', () => {
  it('session(): GET /api/session with the cookie', async () => {
    const { api, fetchMock } = apiWith(() => json({ anonId: true, tier: 'free', limits: {} }));
    await expect(api.session()).resolves.toMatchObject({ tier: 'free' });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.test/api/session');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('include');
    expect(init.body).toBeUndefined();
  });

  it('learn(): POSTs the payload as JSON, with the Turnstile token when there is one', async () => {
    const { api, fetchMock } = apiWith(() => json({ rules, verified: true, problems: [], learnId: 'L1', cached: false }));
    const res = await api.learn(payload, { turnstileToken: 'tok' });
    expect(res.learnId).toBe('L1');
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.test/api/learn');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(sentBody(fetchMock)).toEqual({ payload, turnstileToken: 'tok' });
  });

  it('learn(): leaves the token out when there is none, and adds noCache only when asked', async () => {
    const { api, fetchMock } = apiWith(() => json({ rules: null, verified: false, problems: [], cached: false }));
    await api.learn(payload);
    expect(sentBody(fetchMock, 0)).toEqual({ payload });
    await api.learn(payload, { noCache: true });
    expect(sentBody(fetchMock, 1)).toEqual({ payload, noCache: true });
  });

  it('repair(): POSTs learnId, payload, previousRules and problems', async () => {
    const { api, fetchMock } = apiWith(() => json({ rules, verified: true, problems: [] }));
    const problems = [{ kind: 'layout' as const, message: 'x' }];
    await api.repair('L1', payload, rules, problems);
    const [url] = fetchMock.mock.calls[0]! as [string];
    expect(url).toBe('https://api.test/api/learn/repair');
    expect(sentBody(fetchMock)).toEqual({ learnId: 'L1', payload, previousRules: rules, problems });
  });

  it('only ever sends JSON: no method takes a File or Blob (SPEC 2/15)', async () => {
    const { api, fetchMock } = apiWith(() => json({ rules: null, verified: false, problems: [], cached: false }));
    await api.learn(payload);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(typeof init.body).toBe('string');
    expect(init.body).not.toBeInstanceOf(FormData);
  });
});

describe('error mapping', () => {
  it.each(API_ERROR_CODES)('maps the API code %s to an ApiError with that code', async (code) => {
    const { api } = apiWith(() => json({ error: code }, { status: 400 }));
    const err = await api.learn(payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(code);
    expect(isApiError(err, code)).toBe(true);
  });

  it.each(LIMIT_CODES)('keeps the limit that accompanies limitHit (%s)', async (limit) => {
    const { api } = apiWith(() => json({ error: 'limitHit', limit }, { status: 429 }));
    const err = (await api.learn(payload).catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('limitHit');
    expect(err.limit).toBe(limit);
    expect(err.status).toBe(429);
  });

  it('reads Retry-After', async () => {
    const { api } = apiWith(() => json({ error: 'rateLimited' }, { status: 429, headers: { 'retry-after': '30' } }));
    expect(((await api.learn(payload).catch((e: unknown) => e)) as ApiError).retryAfterSec).toBe(30);
  });

  it('falls back on the status when the body has no known code', () => {
    expect(toApiError(429, {}).code).toBe('rateLimited');
    expect(toApiError(413, undefined).code).toBe('payloadTooLarge');
    expect(toApiError(500, { error: 'boom' }).code).toBe('server');
    expect(toApiError(502, undefined).code).toBe('server');
    expect(toApiError(404, undefined).code).toBe('unknown');
    expect(toApiError(400, { error: 'somethingNew' }).code).toBe('unknown');
  });

  it('a non-JSON error body (a proxy error page) still maps by status', async () => {
    const { api } = apiWith(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    expect(((await api.learn(payload).catch((e: unknown) => e)) as ApiError).code).toBe('server');
  });

  it('a request that never got a response is `network`, status 0', async () => {
    const { api } = apiWith(() => {
      throw new TypeError('Failed to fetch');
    });
    const err = (await api.session().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('network');
    expect(err.status).toBe(0);
  });

  it('a caller abort is passed through, not reported as a network error', async () => {
    const { api } = apiWith(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    const err = await api.learn(payload).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ApiError);
    expect((err as DOMException).name).toBe('AbortError');
  });

  it('a 200 with an unreadable body is a server problem', async () => {
    const { api } = apiWith(() => new Response('not json', { status: 200 }));
    expect(((await api.session().catch((e: unknown) => e)) as ApiError).code).toBe('server');
  });
});

// SPEC 8.15: the registry client - a conversion's source is decided by the server when it is saved (the source objects have no screen in the
// MVP: only the list of their names is read, for Add a source).
describe('registry: sources', () => {
  const conversion = { id: 'C1', formatId: 'F1', sourceId: 'S1', sourceName: 'Supplier A' };
  const call = (fetchMock: ReturnType<typeof vi.fn>, n = 0): [string, RequestInit] => fetchMock.mock.calls[n]! as [string, RequestInit];

  it('attachSource(): POSTs the source choice and the example input\'s headers, and answers with the WHOLE response (source, sourceReused)', async () => {
    const answer = { conversion, source: { id: 'S1', name: 'Supplier A', formats: 1 }, sourceReused: { id: 'S1', name: 'Supplier A' } };
    const { api, fetchMock } = apiWith(() => json(answer, { status: 201 }));
    const body = { rules, status: 'verified', acceptedDifferences: 0, exampleExceptions: [], learnPath: 'local', masking: true, sourceId: 'S1', inputHeaders: ['Code', 'Name'] } as unknown as Parameters<typeof api.registry.attachSource>[1];
    await expect(api.registry.attachSource('F 1', body)).resolves.toEqual(answer);
    const [url, init] = call(fetchMock);
    expect(url).toBe('https://api.test/api/formats/F%201/conversions');
    expect(init.method).toBe('POST');
    expect(sentBody(fetchMock)).toMatchObject({ sourceId: 'S1', inputHeaders: ['Code', 'Name'] });
  });

  it('createFormat(): passes newSource and inputHeaders through, and the answer names the source', async () => {
    const answer = { format: { id: 'F1' }, conversion, source: { id: 'S1', name: 'Supplier A', formats: 1 } };
    const { api, fetchMock } = apiWith(() => json(answer, { status: 201 }));
    const body = { name: 'Orders', rules, status: 'verified', acceptedDifferences: 0, exampleExceptions: [], learnPath: 'local', masking: true, newSource: { name: 'Supplier A' }, inputHeaders: ['Code'] } as unknown as Parameters<typeof api.registry.createFormat>[0];
    await expect(api.registry.createFormat(body)).resolves.toEqual(answer);
    expect(call(fetchMock)[0]).toBe('https://api.test/api/formats');
    expect(sentBody(fetchMock)).toMatchObject({ newSource: { name: 'Supplier A' }, inputHeaders: ['Code'] });
  });

  it('listSources(): GET, unwrapped - and the client has no other call on the source objects (no screen for them in the MVP)', async () => {
    const source = { id: 'S1', name: 'Supplier A', conversions: [] };
    const { api, fetchMock } = apiWith(() => json({ sources: [source] }));
    await expect(api.registry.listSources()).resolves.toEqual([source]);
    expect(call(fetchMock, 0)[0]).toBe('https://api.test/api/sources');
    expect(call(fetchMock, 0)[1].method).toBe('GET');
    expect(Object.keys(api.registry).filter((k) => /source/i.test(k)).sort()).toEqual(['attachSource', 'listSources']);
  });

  it('a 422 sourceMismatch keeps its problems (the source lock\'s findings), a 409 nameTaken maps to its code', async () => {
    const problems = [{ kind: 'sourceMismatch', path: 'input.columns[1].type', message: 'column "Price": type must equal the source\'s "decimal", got "text"' }];
    const { api } = apiWith(() => json({ error: 'sourceMismatch', problems }, { status: 422 }));
    const err = (await api.registry.attachSource('F1', {} as never).catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('sourceMismatch');
    expect(err.problems).toEqual(problems);

    const taken = apiWith(() => json({ error: 'nameTaken' }, { status: 409 }));
    expect(((await taken.api.registry.attachSource('F1', {} as never).catch((e: unknown) => e)) as ApiError).code).toBe('nameTaken');
  });
});
