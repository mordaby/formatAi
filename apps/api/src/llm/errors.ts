// SPEC 9.6/15: a typed error every provider adapter normalizes into. Messages must
// never include payload text (cell values, headers, file names) - SPEC 15 "Logs never
// contain cell values, file names or payloads." Provider-diagnostic text (an SDK error
// message, a CLI status line) is fine; the untrusted user payload is not.

export type LlmErrorKind = 'timeout' | 'rateLimited' | 'refused' | 'invalidJson' | 'providerError';

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly provider: string;

  constructor(kind: LlmErrorKind, provider: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LlmError';
    this.kind = kind;
    this.provider = provider;
  }
}
