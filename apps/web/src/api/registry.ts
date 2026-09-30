// The registry half of the API client (SPEC 8.12, 13): a signed-in user's formats and their conversions (sources).
// Every call needs a sign-in; a refusal is an `ApiError` whose code the screens turn into a plain sentence
// (`limitHit` with `savedFormats` / `rulesPerFormat` / `newFormatsPerMonth`, `formatMismatch` with its problems, ...).
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
  ListVersionsResponse,
  RenameFormatRequest,
  UpdateConversionRequest,
  UpdateConversionResponse,
} from '@formatai/shared';
import type { HttpRequest } from './http';

export interface RegistryApi {
  /** GET /api/formats */
  listFormats(signal?: AbortSignal): Promise<FormatSummary[]>;
  /** GET /api/formats/:id */
  getFormat(id: string, signal?: AbortSignal): Promise<GetFormatResponse>;
  /** POST /api/formats: the format (from the rules' output side) and its first source. */
  createFormat(body: CreateFormatRequest): Promise<CreateFormatResponse>;
  /** PATCH /api/formats/:id */
  renameFormat(id: string, name: string): Promise<FormatSummary>;
  /** DELETE /api/formats/:id: frees a slot, gives no AI learn back. */
  deleteFormat(id: string): Promise<void>;
  /** POST /api/formats/:id/conversions (SPEC 5 A2): 422 `formatMismatch` names the columns that differ. */
  attachSource(formatId: string, body: AttachSourceRequest): Promise<ConversionSummary>;
  /** GET /api/conversions/:id: the rules, for the editor. */
  getConversion(id: string, signal?: AbortSignal): Promise<ConversionDetail>;
  /** PATCH /api/conversions/:id: rename the source and/or save edited rules (a format edit reaches every source). */
  updateConversion(id: string, body: UpdateConversionRequest): Promise<UpdateConversionResponse>;
  /** DELETE /api/conversions/:id */
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
    attachSource: async (formatId, body) => (await request<AttachSourceResponse>('POST', `/api/formats/${enc(formatId)}/conversions`, body)).conversion,
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
