// The API calls of "convert a file" and "batch" (SPEC 5 C/D, 8.12, 8.15, 11): the SOURCES to match a file against (each with the
// formats it feeds), a conversion's rules, a confirmed column rename (an alias on the SOURCE), and the counts of a finished
// run. (Who is signed in is the app's `useMe()`.)
//
// SPEC 2/15: files never leave the browser. The bodies sent here are `{ rows, flagged }` (counts), `{ header, alias }` (a column name the
// user confirmed), and - only when the user says "Do this every time?" in the row review (SPEC 5 C) - a conversion's rules saved as a new
// version, carrying the one text of the file the user chose to keep and what they typed for it. There is no method that takes a file or a file name.
import { type AddAliasRequest, type ConversionDetail, type IgnoreHeadersRequest, type RecordRunRequest, type SignatureEntry, type SignaturesResponse, type SizeRange, type UpdateConversionRequest, type UpdateConversionResponse, type WidenRangesRequest, type WidenRangesResponse } from '@formatai/shared';
import { createContext, createElement, useContext, type ReactNode } from 'react';
import { createHttp, type CreateHttpOptions } from './http';
import { savedRules } from './savedRules';

export interface ConvertApi {
  /** GET /api/signatures: every saved SOURCE's input signature, with the conversions (formats) it feeds (matching runs in the browser). */
  signatures(signal?: AbortSignal): Promise<SignatureEntry[]>;
  /** GET /api/conversions/:id: the conversion with its rules. */
  conversion(id: string, signal?: AbortSignal): Promise<ConversionDetail>;
  /** POST /api/conversions/:id/runs: counts only. */
  recordRun(id: string, counts: RecordRunRequest): Promise<void>;
  /**
   * POST /api/sources/:id/aliases: the file's header `alias` is the source's input column `header` (SPEC 5 C, 8.15). A confirmed
   * mapping is saved once, on the SOURCE, and so applies to every format the source feeds.
   */
  addAlias(sourceId: string, request: AddAliasRequest): Promise<void>;
  /**
   * POST /api/sources/:id/ignored-headers: the file headers the user dismissed as "new column" (SPEC 8.15). Remembered on the SOURCE so
   * the notice does not come back every month; header names only.
   */
  ignoreHeaders(sourceId: string, headers: readonly string[]): Promise<void>;
  /**
   * PATCH /api/conversions/:id with `rules`: the conversion's rules saved as a NEW VERSION through the same route the rules editor saves with
   * (SPEC 8.11 "Saving", 8.15: an edit of the input side is an edit of the SOURCE, written to every format it feeds). Used by the row review's
   * "Do this every time?" (SPEC 5 C): the rules are the ones just read from the server plus the `readAs` the user chose, nothing else.
   */
  saveRules(conversionId: string, body: UpdateConversionRequest): Promise<UpdateConversionResponse>;
  /**
   * POST /api/conversions/:id/widen-ranges (SPEC 5 C, 8.15, 2026-10-08): the user chose "Run anyway" on a format whose file looked different in
   * size and the file was written - the size range (decade exponents, never a value) of each such column of this file, by input column id. The
   * server takes the union with the saved range, in place (no new version); it can only widen. Resolves to the ids that grew.
   */
  widenRanges(conversionId: string, columns: Readonly<Record<string, SizeRange>>): Promise<string[]>;
}

export type CreateConvertApiOptions = CreateHttpOptions;

export function createConvertApi(options: CreateConvertApiOptions = {}): ConvertApi {
  const { request } = createHttp(options);

  return {
    signatures: async (signal) => (await request<SignaturesResponse>('GET', '/api/signatures', undefined, signal)).signatures,
    conversion: async (id, signal) => (await request<{ conversion: ConversionDetail }>('GET', `/api/conversions/${encodeURIComponent(id)}`, undefined, signal)).conversion,
    recordRun: async (id, counts) => {
      // Built here, field by field, so nothing else can ride along.
      const body: RecordRunRequest = { rows: counts.rows, flagged: counts.flagged };
      await request('POST', `/api/conversions/${encodeURIComponent(id)}/runs`, body);
    },
    addAlias: async (sourceId, req) => {
      // Built here, field by field: the only things sent are two column names the user confirmed.
      const body: AddAliasRequest = { header: req.header, alias: req.alias };
      await request('POST', `/api/sources/${encodeURIComponent(sourceId)}/aliases`, body);
    },
    ignoreHeaders: async (sourceId, headers) => {
      // Built here, field by field: the only thing sent is a list of column names.
      const body: IgnoreHeadersRequest = { headers: headers.map(String) };
      await request('POST', `/api/sources/${encodeURIComponent(sourceId)}/ignored-headers`, body);
    },
    // Built here, field by field. The rules carry the user's own words (what they typed for a text of the file), exactly as an editor save does
    // - and are stored as every save stores them (`savedRules`).
    saveRules: (conversionId, req) => {
      const body: UpdateConversionRequest = {
        ...(req.rules ? { rules: savedRules(req.rules) } : {}),
        ...(req.status ? { status: req.status } : {}),
        ...(req.acceptedDifferences !== undefined ? { acceptedDifferences: req.acceptedDifferences } : {}),
        ...(req.exampleExceptions ? { exampleExceptions: req.exampleExceptions } : {}),
        ...(req.baseVersion !== undefined ? { baseVersion: req.baseVersion } : {}),
      };
      return request<UpdateConversionResponse>('PATCH', `/api/conversions/${encodeURIComponent(conversionId)}`, body);
    },
    widenRanges: async (conversionId, columns) => {
      // Built here, field by field: a column id and two small integers each - no value, no file name.
      const body: WidenRangesRequest = { columns: Object.fromEntries(Object.entries(columns).map(([id, r]) => [id, { lo: r.lo, hi: r.hi }])) };
      return (await request<WidenRangesResponse>('POST', `/api/conversions/${encodeURIComponent(conversionId)}/widen-ranges`, body)).widened;
    },
  };
}

let shared: ConvertApi | undefined;
/** The app-wide client (same-origin in dev through the Vite proxy). */
export function getConvertApi(): ConvertApi {
  return (shared ??= createConvertApi());
}

const ConvertApiContext = createContext<ConvertApi | null>(null);

/** Tests (and anything that needs another client) provide one here; without a provider the real client is used. */
export function ConvertApiProvider({ api, children }: { api: ConvertApi; children: ReactNode }) {
  return createElement(ConvertApiContext.Provider, { value: api }, children);
}

export function useConvertApi(): ConvertApi {
  return useContext(ConvertApiContext) ?? getConvertApi();
}
