// One error vocabulary for every flow (learn, convert): whatever went wrong - a worker
// timeout, a rejected file, an API limit - becomes a `FlowError` the UI can translate.
import type { AiLearnPeriod, LimitCode, RepairProblem } from '@formatai/shared';
import { ApiError, type ApiFailureCode } from '../api';
import type { I18n } from '../i18n';
import { RpcAbortedError, RpcRemoteError, RpcTimeoutError, RpcWorkerError } from '../worker/rpcClient';

export type FlowError =
  | { kind: 'fileTooLarge'; fileName: string; bytes: number; maxBytes: number }
  | { kind: 'unsupportedFileType' }
  | { kind: 'timeout' }
  | { kind: 'workerCrashed' }
  | { kind: 'api'; code: ApiFailureCode; limit?: LimitCode | undefined; retryAfterSec?: number | undefined; period?: AiLearnPeriod | undefined; counted?: boolean | undefined }
  /** The server answered but returned no usable rules (even after its own repair round). */
  | { kind: 'learnFailed'; problems: RepairProblem[] }
  | { kind: 'unexpected'; message: string };

/** The user (or a newer run) cancelled; not an error to show. */
export function isCancellation(e: unknown): boolean {
  return e instanceof RpcAbortedError || (e instanceof DOMException && e.name === 'AbortError') || (e instanceof Error && e.name === 'CancelledError');
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

/**
 * `hostError`: an `ApiError` caught in the main-thread callback that the worker then
 * re-threw (it crosses the worker boundary as a plain object, so the original is kept
 * here and preferred).
 */
export function toFlowError(e: unknown, hostError?: unknown): FlowError {
  const api = hostError instanceof ApiError ? hostError : e instanceof ApiError ? e : undefined;
  if (api) return { kind: 'api', code: api.code, limit: api.limit, retryAfterSec: api.retryAfterSec, period: api.period, counted: api.counted };
  if (e instanceof RpcTimeoutError) return { kind: 'timeout' };
  if (e instanceof RpcWorkerError) return { kind: 'workerCrashed' };
  if (e instanceof RpcRemoteError) {
    if (e.code === 'unsupportedFileType') return { kind: 'unsupportedFileType' };
    return { kind: 'unexpected', message: e.message };
  }
  return { kind: 'unexpected', message: e instanceof Error ? e.message : 'Unknown error' };
}

const CLIENT_API_CODES = new Set<ApiFailureCode>(['network', 'server', 'payloadTooLarge', 'unknown']);

/** The user-facing text of a flow error, in the UI language. */
export function flowErrorText(i18n: I18n, error: FlowError): string {
  const { t, code } = i18n;
  switch (error.kind) {
    case 'fileTooLarge':
      return t('error.fileTooLarge', {
        mb: (error.bytes / (1024 * 1024)).toFixed(1),
        maxMb: Math.round(error.maxBytes / (1024 * 1024)),
      });
    case 'unsupportedFileType':
      return t('error.unsupportedFileType');
    case 'timeout':
      return t('error.timeout');
    case 'workerCrashed':
      return t('error.workerCrashed');
    case 'learnFailed':
      return t('error.learnFailed');
    case 'unexpected':
      return t('error.unexpected');
    case 'api':
      if (!CLIENT_API_CODES.has(error.code)) {
        return code({
          kind: 'apiError',
          code: error.code as Exclude<ApiFailureCode, 'network' | 'server' | 'payloadTooLarge' | 'unknown'>,
          limit: error.limit,
          period: error.period,
          counted: error.counted,
        });
      }
      if (error.code === 'network') return t('error.network');
      if (error.code === 'payloadTooLarge') return t('error.payloadTooLarge');
      if (error.code === 'server') return t('error.server');
      return t('error.unexpected');
  }
}
