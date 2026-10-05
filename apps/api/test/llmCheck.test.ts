// `llm-check` (scripts/llmCheck.ts): the argument handling, the model it calls, the payload it builds, and a report that never shows a key.
// No real call is made here: the provider is the real OpenAI adapter on a mocked client.
import OpenAI from 'openai';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { formulaRulesToWire } from '@formatai/engine';
import { models, toWire, type LearnResult } from '@formatai/shared';
import { describe, expect, it, vi } from 'vitest';
import { loadEnv, repoRoot } from '../src/env.js';
import { createOpenAiProvider } from '../src/llm/index.js';
import {
  buildCheckPayload,
  CHECK_CASE,
  checkModelOf,
  formatLlmCheckReport,
  parseLlmCheckArgs,
  redactKeys,
  runLlmCheck,
} from '../scripts/llmCheck.js';

const KEY = 'sk-proj-THIS-IS-A-MADE-UP-KEY-0123456789';

describe('parseLlmCheckArgs', () => {
  it('reads --provider (spaced or with =), skipping the "--" pnpm passes through', () => {
    expect(parseLlmCheckArgs(['--', '--provider', 'openai'])).toEqual({ ok: true, args: { provider: 'openai', slot: 'firstTry' } });
    expect(parseLlmCheckArgs(['--provider=anthropic'])).toEqual({ ok: true, args: { provider: 'anthropic', slot: 'firstTry' } });
  });

  it('--escalation picks the escalation slot; --model names a model', () => {
    expect(parseLlmCheckArgs(['--provider', 'openai', '--escalation'])).toEqual({ ok: true, args: { provider: 'openai', slot: 'escalation' } });
    expect(parseLlmCheckArgs(['--provider', 'openai', '--model', 'gpt-5-nano'])).toEqual({ ok: true, args: { provider: 'openai', slot: 'firstTry', model: 'gpt-5-nano' } });
    expect(parseLlmCheckArgs(['--model=gpt-5', '--provider=openai'])).toMatchObject({ ok: true, args: { model: 'gpt-5' } });
  });

  it('refuses a missing, empty or unknown provider, a provider the check cannot call, and unknown arguments - with the usage', () => {
    for (const argv of [[], ['--provider'], ['--provider', '--escalation'], ['--provider', 'gemini'], ['--provider', 'claude-cli'], ['--provider', 'fake'], ['--provider', 'openai', '--frobnicate'], ['openai'], ['--provider', 'openai', '--model']]) {
      const parsed = parseLlmCheckArgs(argv);
      expect(parsed.ok, argv.join(' ')).toBe(false);
      if (!parsed.ok) {
        expect(parsed.help).toBe(false);
        expect(parsed.message).toContain('usage: pnpm --filter @formatai/api llm-check');
      }
    }
  });

  it('--help / -h prints the usage', () => {
    expect(parseLlmCheckArgs(['--help'])).toMatchObject({ ok: false, help: true });
    expect(parseLlmCheckArgs(['-h'])).toMatchObject({ ok: false, help: true });
  });
});

describe('checkModelOf: the model the app itself would call for that provider and slot', () => {
  const env = loadEnv({
    ...process.env,
    LLM_PROVIDER: 'anthropic',
    LLM_MODEL_FIRST_TRY: 'claude-primary-override',
    LLM_MODEL_ESCALATION: undefined,
    LLM_FALLBACK_PROVIDER: 'openai',
    LLM_FALLBACK_MODEL_FIRST_TRY: undefined,
    LLM_FALLBACK_MODEL_ESCALATION: 'gpt-5-mini',
  });

  it('the primary with its overrides, the fallback with its own, --model over both', () => {
    expect(checkModelOf(env, { provider: 'anthropic', slot: 'firstTry' })).toBe('claude-primary-override');
    expect(checkModelOf(env, { provider: 'anthropic', slot: 'escalation' })).toBe(models.anthropic.escalation);
    expect(checkModelOf(env, { provider: 'openai', slot: 'firstTry' })).toBe(models.openai.firstTry);
    expect(checkModelOf(env, { provider: 'openai', slot: 'escalation' })).toBe('gpt-5-mini');
    expect(checkModelOf(env, { provider: 'openai', slot: 'firstTry', model: 'gpt-5-nano' })).toBe('gpt-5-nano');
  });

  it('a provider that is neither: config/models.ts', () => {
    const plain = loadEnv({ ...process.env, LLM_PROVIDER: 'anthropic', LLM_FALLBACK_PROVIDER: undefined });
    expect(checkModelOf(plain, { provider: 'openai', slot: 'escalation' })).toBe(models.openai.escalation);
  });
});

describe('redactKeys', () => {
  it('cuts the given keys and anything shaped like one (also partly starred) out of a line', () => {
    expect(redactKeys(`bad key ${KEY} here`, [KEY])).toBe('bad key [key] here');
    expect(redactKeys('Incorrect API key provided: sk-proj-****************abcd.', [])).toBe('Incorrect API key provided: [key].');
    expect(redactKeys('nothing secret', [undefined, ''])).toBe('nothing secret');
  });
});

describe(`buildCheckPayload (the bundled case ${CHECK_CASE})`, () => {
  it('is a learn payload with masking ON: the headers are real, the customers\' names are not sent', async () => {
    const payload = await buildCheckPayload();
    expect(payload.masking).toBe(true);
    expect(payload.samples.length).toBeGreaterThan(0);
    const text = JSON.stringify(payload);
    expect(text).toContain('Customer ID');
    const input = readFileSync(path.join(repoRoot, 'eval', 'cases', CHECK_CASE, 'input.csv'), 'utf-8');
    const firstRow = input.split(/\r?\n/)[1]!.split(',');
    for (const name of [firstRow[1]!, firstRow[2]!, firstRow[3]!]) expect(text, name).not.toContain(name);
  });
});

describe('runLlmCheck + formatLlmCheckReport', () => {
  const env = loadEnv({ ...process.env, LLM_PROVIDER: 'anthropic', LLM_FALLBACK_PROVIDER: 'openai', OPENAI_API_KEY: KEY });
  const args = { provider: 'openai' as const, slot: 'firstTry' as const };

  /** The bundled case's reference rules in wire form: a right answer to its payload. */
  function rightAnswer(): unknown {
    const { name: _n, meta: _m, ...rules } = JSON.parse(readFileSync(path.join(repoRoot, 'eval', 'cases', CHECK_CASE, 'reference.rules.json'), 'utf-8')) as LearnResult & { name?: string; meta?: unknown };
    return toWire(formulaRulesToWire(rules as LearnResult) as unknown as LearnResult);
  }

  function provider(respond: (params: OpenAI.Responses.ResponseCreateParamsNonStreaming) => Promise<unknown>) {
    const create = vi.fn(respond);
    return { create, provider: createOpenAiProvider({ client: { responses: { create } } as unknown as OpenAI }) };
  }

  it('a right answer: verified, with the model, latency, tokens and no truncation; one call', async () => {
    const p = provider(async () => ({
      model: 'gpt-5-mini-2025-08-07',
      status: 'completed',
      output_text: JSON.stringify(rightAnswer()),
      usage: { input_tokens: 9000, output_tokens: 700, input_tokens_details: { cached_tokens: 0 } },
    }));
    const report = await runLlmCheck(env, args, await buildCheckPayload(), p.provider);
    expect(p.create).toHaveBeenCalledTimes(1);
    const sent = p.create.mock.calls[0]![0];
    expect(sent).toMatchObject({ model: 'gpt-5-mini', reasoning: { effort: 'low' } });
    expect(report).toMatchObject({ provider: 'openai', model: 'gpt-5-mini', verified: true, masking: true, result: { model: 'gpt-5-mini-2025-08-07', truncated: false } });
    const text = formatLlmCheckReport(report);
    for (const part of ['served by:  gpt-5-mini-2025-08-07', 'tokens:     9000 in, 700 out', 'truncated:  no', 'verified:   yes']) expect(text).toContain(part);
    expect(text).not.toContain(KEY);
  });

  it('a cut-off answer: truncated, not verified', async () => {
    const p = provider(async () => ({ model: 'gpt-5-mini', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '{"sch', usage: { input_tokens: 9000, output_tokens: 16000 } }));
    const report = await runLlmCheck(env, args, await buildCheckPayload(), p.provider);
    expect(report).toMatchObject({ verified: null, result: { truncated: true } });
    expect(formatLlmCheckReport(report)).toContain('truncated:  YES');
  });

  it('a wrong answer: answered, not verified, with the problem kinds (never their text)', async () => {
    const p = provider(async () => ({ model: 'gpt-5-mini', status: 'completed', output_text: '{"schemaVersion":1}', usage: { input_tokens: 1, output_tokens: 1 } }));
    const report = await runLlmCheck(env, args, await buildCheckPayload(), p.provider);
    expect(report.verified).toBe(false);
    expect(Object.keys(report.problems).length).toBeGreaterThan(0);
    expect(formatLlmCheckReport(report)).toMatch(/verified:\s+no - problems: /);
  });

  it('a 400 from the provider: its own message and param (what was wrong), the HTTP status - and no key', async () => {
    const p = provider(async () => {
      throw OpenAI.APIError.generate(400, { error: { message: "Unsupported parameter: 'temperature' is not supported with this model.", type: 'invalid_request_error', param: 'temperature', code: 'unsupported_parameter' } }, undefined, new Headers());
    });
    const report = await runLlmCheck(env, args, await buildCheckPayload(), p.provider);
    expect(report.verified).toBeNull();
    expect(report.error).toMatchObject({ kind: 'providerError', status: 400, type: 'invalid_request_error' });
    const text = formatLlmCheckReport(report);
    expect(text).toContain("Unsupported parameter: 'temperature'");
    expect(text).toContain('(param: temperature)');
  });

  it('a 401: our own words only (the provider\'s message can quote part of the key)', async () => {
    const p = provider(async () => {
      throw OpenAI.APIError.generate(401, { error: { message: `Incorrect API key provided: ${KEY.slice(0, 8)}****6789.`, type: 'invalid_request_error', code: 'invalid_api_key' } }, undefined, new Headers());
    });
    const report = await runLlmCheck(env, args, await buildCheckPayload(), p.provider);
    expect(report.error).toMatchObject({ kind: 'refused', unavailable: 'auth', status: 401 });
    const text = formatLlmCheckReport(report);
    expect(text).not.toContain(KEY.slice(0, 8));
    expect(text).not.toContain('6789');
    expect(text).toContain('authentication or permission error');
  });
});
