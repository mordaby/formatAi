// The one call "Do this every time?" makes (SPEC 5 C): the conversion's rules saved as a new version through the route the rules editor
// saves with. Built field by field, so nothing else can ride along.
import { describe, expect, it, vi } from 'vitest';
import { createConvertApi } from '../src/api/convert';

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

describe('saveRules', () => {
  it('PATCH /api/conversions/:id with the rules and what an editor save sends - and nothing else', async () => {
    const fetchMock = vi.fn(async () => json({ conversion: { version: 2 }, formatChanged: false, affectedSources: 0, needsReview: [] }));
    const api = createConvertApi({ baseUrl: 'https://api.test', fetch: fetchMock as unknown as typeof fetch });
    const rules = { schemaVersion: 1, input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'a', header: 'A', type: 'decimal', readAs: { 'N/A': '' } }] } } as never;
    const body = { rules, status: 'verified', acceptedDifferences: 0, exampleExceptions: [3], baseVersion: 1, secret: 'row 5: 12345' };
    const res = await (api.saveRules as (id: string, body: unknown) => Promise<{ conversion: { version: number } }>)('c/1', body);
    expect(res.conversion.version).toBe(2);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/api/conversions/c%2F1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ rules, status: 'verified', acceptedDifferences: 0, exampleExceptions: [3], baseVersion: 1 });
  });
});
