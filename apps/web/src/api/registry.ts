// The registry half of the API client (SPEC 8.12, 8.15, 13): a signed-in user's formats, their sources and the conversions
// that link them. Every call needs a sign-in; a refusal is an `ApiError` whose code the screens turn into a plain sentence
// (`limitHit` with `savedFormats` / `rulesPerFormat` / `newFormatsPerMonth`, `formatMismatch` / `sourceMismatch` with their
// problems, `nameTaken`, `sourceInUse`, ...).
import type {
  AttachSourceRequest,
  AttachSourceResponse,
  ConversionDetail,
  ConversionSummary,
  ConversionVersionSummary,
  CreateFormatRequest,
  CreateFormatResponse,
  FormatSummary,
  GetFormatResponse,
  GetSourceResponse,
  LearnOutcomeRequest,
  LearnOutcomeResponse,
  ListFormatsResponse,
  ListSourcesResponse,
  ListVersionsResponse,
  RenameFormatRequest,
  SourceDetail,
  SourceSummary,
  UpdateConversionRequest,
  UpdateConversionResponse,
  UpdateSourceRequest,
  UpdateSourceResponse,
} from '@formatai/shared';
import type { HttpRequest } from './http';

export interface RegistryApi {
  /** GET /api/formats */
  listFormats(signal?: AbortSignal): Promise<FormatSummary[]>;
  /** GET /api/formats/:id */
  getFormat(id: string, signal?: AbortSignal): Promise<GetFormatResponse>;
  /** POST /api/formats: the format (from the rules' output side), its source (an existing one is reused when the example matches it) and the first conversion. */
  createFormat(body: CreateFormatRequest): Promise<CreateFormatResponse>;
  /** PATCH /api/formats/:id */
  renameFormat(id: string, name: string): Promise<FormatSummary>;
  /** DELETE /api/formats/:id: frees a slot, gives no AI learn back. The format's sources stay (SPEC 8.15). */
  deleteFormat(id: string): Promise<void>;
  /** POST /api/formats/:id/conversions (SPEC 5 A2): 422 `formatMismatch` names the columns that differ, 422 `sourceMismatch` the ones the chosen source doesn't fit. */
  attachSource(formatId: string, body: AttachSourceRequest): Promise<AttachSourceResponse>;
  /** GET /api/sources (SPEC 8.15): the caller's sources, each with the formats it feeds. */
  listSources(signal?: AbortSignal): Promise<SourceSummary[]>;
  /** GET /api/sources/:id: one source with its structure (headers, types, reading options - never a value). */
  getSource(id: string, signal?: AbortSignal): Promise<SourceDetail>;
  /** PATCH /api/sources/:id: a rename (409 `nameTaken`) and/or an edit of the structure. */
  updateSource(id: string, body: UpdateSourceRequest): Promise<UpdateSourceResponse>;
  /** DELETE /api/sources/:id: 409 `sourceInUse` while it still feeds a format. */
  deleteSource(id: string): Promise<void>;
  /** GET /api/conversions/:id: the rules, for the editor. */
  getConversion(id: string, signal?: AbortSignal): Promise<ConversionDetail>;
  /** PATCH /api/conversions/:id: rename its SOURCE and/or save edited rules (a format edit reaches every source of the format, an input-side edit every format of the source). */
  updateConversion(id: string, body: UpdateConversionRequest): Promise<UpdateConversionResponse>;
  /** DELETE /api/conversions/:id: its source stays (it may then feed no format). */
  deleteConversion(id: string): Promise<void>;
  /** GET /api/conversions/:id/versions: newest first. */
  versions(id: string, signal?: AbortSignal): Promise<ConversionVersionSummary[]>;
  /** POST /api/conversions/:id/restore/:version: an earlier version, saved as a new one. */
  restore(id: string, version: number): Promise<ConversionSummary>;
  /** POST /api/learn/:learnId/outcome: what the browser's own full verification found (SPEC 21 v5 item 3). */
  learnOutcome(learnId: string, outcome: LearnOutcomeRequest['outcome']): Promise<LearnOutcomeResponse>;
}

const enc = encodeURIComponent;

export function createRegistryApi(request: HttpRequest): RegistryApi {
  return {
    listFormats: async (signal) => (await request<ListFormatsResponse>('GET', '/api/formats', undefined, signal)).formats,
    getFormat: (id, signal) => request<GetFormatResponse>('GET', `/api/formats/${enc(id)}`, undefined, signal),
    createFormat: (body) => request<CreateFormatResponse>('POST', '/api/formats', body),
    renameFormat: async (id, name) => {
      const body: RenameFormatRequest = { name };
      return (await request<{ format: FormatSummary }>('PATCH', `/api/formats/${enc(id)}`, body)).format;
    },
    deleteFormat: async (id) => {
      await request<{ deleted: true }>('DELETE', `/api/formats/${enc(id)}`);
    },
    // The whole answer: the screens say "Reused your source X" from `sourceReused`.
    attachSource: (formatId, body) => request<AttachSourceResponse>('POST', `/api/formats/${enc(formatId)}/conversions`, body),
    listSources: async (signal) => (await request<ListSourcesResponse>('GET', '/api/sources', undefined, signal)).sources,
    getSource: async (id, signal) => (await request<GetSourceResponse>('GET', `/api/sources/${enc(id)}`, undefined, signal)).source,
    updateSource: (id, body) => request<UpdateSourceResponse>('PATCH', `/api/sources/${enc(id)}`, body),
    deleteSource: async (id) => {
      await request<{ deleted: true }>('DELETE', `/api/sources/${enc(id)}`);
    },
    getConversion: async (id, signal) => (await request<{ conversion: ConversionDetail }>('GET', `/api/conversions/${enc(id)}`, undefined, signal)).conversion,
    updateConversion: (id, body) => request<UpdateConversionResponse>('PATCH', `/api/conversions/${enc(id)}`, body),
    deleteConversion: async (id) => {
      await request<{ deleted: true }>('DELETE', `/api/conversions/${enc(id)}`);
    },
    versions: async (id, signal) => (await request<ListVersionsResponse>('GET', `/api/conversions/${enc(id)}/versions`, undefined, signal)).versions,
    restore: async (id, version) => (await request<{ conversion: ConversionSummary }>('POST', `/api/conversions/${enc(id)}/restore/${version}`, {})).conversion,
    learnOutcome: (learnId, outcome) => request<LearnOutcomeResponse>('POST', `/api/learn/${enc(learnId)}/outcome`, { outcome }),
  };
}
