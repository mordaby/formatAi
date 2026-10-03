// The registry half of the API client (SPEC 8.12, 8.15, 13): a signed-in user's formats and the conversions that link them to their
// sources. Every call needs a sign-in; a refusal is an `ApiError` whose code the screens turn into a plain sentence (`limitHit` with
// `savedFormats` / `rulesPerFormat` / `newFormatsPerMonth`, `formatMismatch` / `sourceMismatch` with their problems, `nameTaken`, ...).
// Source objects have no screen in the MVP (SPEC 8.15): only the list of their names is read, for Add a source.
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
  LearnOutcomeRequest,
  LearnOutcomeResponse,
  ListFormatsResponse,
  ListSourcesResponse,
  ListVersionsResponse,
  RenameFormatRequest,
  SourceSummary,
  UpdateConversionRequest,
  UpdateConversionResponse,
} from '@formatai/shared';
import { stripAiNotes, type LearnResult, type Rules } from '@formatai/shared';
import type { HttpRequest } from './http';

export interface RegistryApi {
  /** GET /api/formats */
  listFormats(signal?: AbortSignal): Promise<FormatSummary[]>;
  /** GET /api/formats/:id */
  getFormat(id: string, signal?: AbortSignal): Promise<GetFormatResponse>;
  /** POST /api/formats: the format (from the rules' output side), its source (an existing one is reused, silently, when the example matches it) and the first conversion. */
  createFormat(body: CreateFormatRequest): Promise<CreateFormatResponse>;
  /** PATCH /api/formats/:id */
  renameFormat(id: string, name: string): Promise<FormatSummary>;
  /** DELETE /api/formats/:id: frees a slot, gives no AI learn back. */
  deleteFormat(id: string): Promise<void>;
  /** POST /api/formats/:id/conversions (SPEC 5 A2): 422 `formatMismatch` names the columns that differ. */
  attachSource(formatId: string, body: AttachSourceRequest): Promise<AttachSourceResponse>;
  /** GET /api/sources (SPEC 8.15): the caller's sources; Add a source reads their names (a name is the company's, unique among them). */
  listSources(signal?: AbortSignal): Promise<SourceSummary[]>;
  /** GET /api/conversions/:id: the rules, for the editor. */
  getConversion(id: string, signal?: AbortSignal): Promise<ConversionDetail>;
  /** PATCH /api/conversions/:id: rename its SOURCE and/or save edited rules (a format edit reaches every source of the format, an input-side edit every format of the source). */
  updateConversion(id: string, body: UpdateConversionRequest): Promise<UpdateConversionResponse>;
  /** DELETE /api/conversions/:id. */
  deleteConversion(id: string): Promise<void>;
  /** GET /api/conversions/:id/versions: newest first. */
  versions(id: string, signal?: AbortSignal): Promise<ConversionVersionSummary[]>;
  /** POST /api/conversions/:id/restore/:version: an earlier version, saved as a new one. */
  restore(id: string, version: number): Promise<ConversionSummary>;
  /** POST /api/learn/:learnId/outcome: what the browser's own full verification found (SPEC 21 v5 item 3). */
  learnOutcome(learnId: string, outcome: LearnOutcomeRequest['outcome']): Promise<LearnOutcomeResponse>;
}

const enc = encodeURIComponent;

/** SPEC 15 (learn-v7): the AI's explanation and function request are never saved with a rules file. The editor's rules never carry them (they
 * live beside the rules, in the session), and the API strips them as well; this is the browser's own guarantee at the boundary. */
function withoutAiNotes<B extends { rules?: Rules | LearnResult }>(body: B): B {
  return body.rules ? { ...body, rules: stripAiNotes(body.rules) } : body;
}

export function createRegistryApi(request: HttpRequest): RegistryApi {
  return {
    listFormats: async (signal) => (await request<ListFormatsResponse>('GET', '/api/formats', undefined, signal)).formats,
    getFormat: (id, signal) => request<GetFormatResponse>('GET', `/api/formats/${enc(id)}`, undefined, signal),
    createFormat: (body) => request<CreateFormatResponse>('POST', '/api/formats', withoutAiNotes(body)),
    renameFormat: async (id, name) => {
      const body: RenameFormatRequest = { name };
      return (await request<{ format: FormatSummary }>('PATCH', `/api/formats/${enc(id)}`, body)).format;
    },
    deleteFormat: async (id) => {
      await request<{ deleted: true }>('DELETE', `/api/formats/${enc(id)}`);
    },
    // The whole answer (the source the save used comes with it).
    attachSource: (formatId, body) => request<AttachSourceResponse>('POST', `/api/formats/${enc(formatId)}/conversions`, withoutAiNotes(body)),
    listSources: async (signal) => (await request<ListSourcesResponse>('GET', '/api/sources', undefined, signal)).sources,
    getConversion: async (id, signal) => (await request<{ conversion: ConversionDetail }>('GET', `/api/conversions/${enc(id)}`, undefined, signal)).conversion,
    updateConversion: (id, body) => request<UpdateConversionResponse>('PATCH', `/api/conversions/${enc(id)}`, withoutAiNotes(body)),
    deleteConversion: async (id) => {
      await request<{ deleted: true }>('DELETE', `/api/conversions/${enc(id)}`);
    },
    versions: async (id, signal) => (await request<ListVersionsResponse>('GET', `/api/conversions/${enc(id)}/versions`, undefined, signal)).versions,
    restore: async (id, version) => (await request<{ conversion: ConversionSummary }>('POST', `/api/conversions/${enc(id)}/restore/${version}`, {})).conversion,
    learnOutcome: (learnId, outcome) => request<LearnOutcomeResponse>('POST', `/api/learn/${enc(learnId)}/outcome`, { outcome }),
  };
}
