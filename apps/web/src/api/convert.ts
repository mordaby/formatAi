// The API calls of "convert a file" and "batch" (SPEC 5 C/D, 8.12, 8.15, 11): the SOURCES to match a file against (each with the
// formats it feeds), a conversion's rules, a confirmed column rename (an alias on the SOURCE), and the counts of a finished
// run. (Who is signed in is the app's `useMe()`.)
//
// SPEC 2/15: files never leave the browser. The only bodies sent here are `{ rows, flagged }` (counts) and
// `{ header, alias }` (a column name the user confirmed). There is no method that takes a file, a value or a file name.
import type { AddAliasRequest, ConversionDetail, IgnoreHeadersRequest, RecordRunRequest, SignatureEntry, SignaturesResponse } from '@formatai/shared';
import { createContext, createElement, useContext, type ReactNode } from 'react';
import { createHttp, type CreateHttpOptions } from './http';

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
