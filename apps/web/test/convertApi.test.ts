// The API client of convert and batch (SPEC 5 C/D, 8.15): what it asks for and what it sends. A confirmed rename goes to the
// SOURCE (one alias that holds for every format the source feeds), and nothing but the two column names rides along; a dismissed
// "new column" sends header names only.
import type { SignatureEntry } from '@formatai/shared';
import { describe, expect, it, vi } from 'vitest';
import { createConvertApi } from '../src/api/convert';
import { entry, sourceEntry } from './helpers/convertKit';

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

function clientWith(respond: (url: string, init: RequestInit) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init ?? {}));
  return { api: createConvertApi({ baseUrl: 'https://api.test', fetch: fetchMock as unknown as typeof fetch }), fetchMock };
}

describe('signatures', () => {
  it('GET /api/signatures: one entry per source, with the formats it feeds', async () => {
    const wire: SignatureEntry[] = [
      sourceEntry({ sourceId: 's1', name: 'Supplier A', conversions: [{ conversionId: 'c1', formatId: 'F1', formatName: 'Load file' }, { conversionId: 'c2', formatId: 'F2', formatName: 'ERP load' }] }),
      entry({ conversionId: 'c3', sourceId: 's2', sourceName: 'Supplier B' }),
    ];
    const { api, fetchMock } = clientWith(() => json({ signatures: wire }));
    const got = await api.signatures();
    expect(got).toEqual(wire);
    expect(got[0]!.conversions.map((c) => c.formatName)).toEqual(['Load file', 'ERP load']);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.test/api/signatures');
    expect(init.method).toBe('GET');
  });
});

describe('addAlias', () => {
  it('POST /api/sources/:id/aliases with the two column names and nothing else', async () => {
    const { api, fetchMock } = clientWith(() => json({ inputSignature: { columns: [] } }));
    // Extra fields a caller might pass must not ride along: the body is built field by field.
    await api.addAlias('s/1', { header: 'Qty', alias: 'Quantity', secret: 'row 5: 12345' } as { header: string; alias: string });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.test/api/sources/s%2F1/aliases');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ header: 'Qty', alias: 'Quantity' });
  });
});

describe('recordRun', () => {
  it('POST /api/conversions/:id/runs with counts only', async () => {
    const { api, fetchMock } = clientWith(() => json({ runCount: 1 }));
    await api.recordRun('c1', { rows: 10, flagged: 2, fileName: 'jan.csv' } as { rows: number; flagged: number });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.test/api/conversions/c1/runs');
    expect(JSON.parse(init.body as string)).toEqual({ rows: 10, flagged: 2 });
  });
});

describe('ignoreHeaders', () => {
  it('POST /api/sources/:id/ignored-headers with the header names and nothing else', async () => {
    const { api, fetchMock } = clientWith(() => json({ ignoredHeaders: ['Notes'] }));
    // Extra fields a caller might pass must not ride along: the body is built field by field.
    await (api.ignoreHeaders as (id: string, headers: string[], extra?: unknown) => Promise<void>)('s/1', ['Notes', 'Created by'], { values: ['row 5: 12345'] });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.test/api/sources/s%2F1/ignored-headers');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ headers: ['Notes', 'Created by'] });
  });
});
