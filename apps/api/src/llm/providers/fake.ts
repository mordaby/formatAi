// SPEC 9.6/10: a provider that returns canned responses, for tests and the eval
// harness's dry run. No network, no SDK.
import { LlmError } from '../errors.js';
import type { CompleteRequest, CompleteResult, LlmProvider, LlmUsage } from '../types.js';

export interface FakeCannedResponse {
  json?: unknown;
  /** Defaults to `JSON.stringify(json)` when omitted. */
  raw?: string;
  usage?: Partial<LlmUsage>;
  costUsd?: number;
  model?: string;
  /** Throw this instead of returning a result. */
  error?: LlmError;
}

/** A stable key for a request, used by `registerForRequest`/`respondTo`. */
export function hashRequest(req: Pick<CompleteRequest, 'system' | 'content' | 'schema' | 'model' | 'purpose'>): string {
  return JSON.stringify({
    system: req.system,
    content: req.content,
    schema: req.schema,
    model: req.model,
    purpose: req.purpose,
  });
}

export interface FakeLlmProvider extends LlmProvider {
  /** Queue a response (FIFO); consumed by the next call that has no keyed match. */
  enqueue(response: FakeCannedResponse): void;
  /** Register a response for calls whose request matches this one exactly (see `hashRequest`). */
  registerForRequest(
    req: Pick<CompleteRequest, 'system' | 'content' | 'schema' | 'model' | 'purpose'>,
    response: FakeCannedResponse,
  ): void;
  /** Every request received so far, in order - for assertions in tests. */
  readonly calls: CompleteRequest[];
  /** Clears the queue, keyed registrations, and call log. */
  reset(): void;
}

export function createFakeProvider(): FakeLlmProvider {
  const queue: FakeCannedResponse[] = [];
  const byHash = new Map<string, FakeCannedResponse>();
  const calls: CompleteRequest[] = [];

  return {
    name: 'fake',
    calls,
    enqueue(response) {
      queue.push(response);
    },
    registerForRequest(req, response) {
      byHash.set(hashRequest(req), response);
    },
    reset() {
      queue.length = 0;
      byHash.clear();
      calls.length = 0;
    },
    async complete(req: CompleteRequest): Promise<CompleteResult> {
      calls.push(req);
      const start = Date.now();

      const canned = byHash.get(hashRequest(req)) ?? queue.shift();
      if (!canned) {
        throw new LlmError('providerError', 'fake', 'no canned response registered for this request');
      }
      if (canned.error) throw canned.error;

      const raw = canned.raw ?? JSON.stringify(canned.json ?? {});
      let json = canned.json;
      if (json === undefined) {
        try {
          json = JSON.parse(raw);
        } catch {
          throw new LlmError('invalidJson', 'fake', 'canned response raw text was not valid JSON');
        }
      }

      const usage: LlmUsage = {
        tokensIn: canned.usage?.tokensIn ?? 0,
        tokensOut: canned.usage?.tokensOut ?? 0,
        tokensCachedRead: canned.usage?.tokensCachedRead ?? 0,
        tokensCachedWrite: canned.usage?.tokensCachedWrite ?? 0,
      };

      return {
        json,
        raw,
        usage,
        costUsd: canned.costUsd ?? 0,
        latencyMs: Date.now() - start,
        model: canned.model ?? req.model,
        provider: 'fake',
      };
    },
  };
}
