import { delimiter, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createClaudeCliProvider, resolveClaudeCommand, type SpawnFn } from '../../src/llm/providers/claudeCli.js';
import type { CompleteRequest } from '../../src/llm/types.js';

function baseRequest(overrides: Partial<CompleteRequest> = {}): CompleteRequest {
  return {
    system: 'you are a rules writer',
    content: [{ text: 'payload json' }],
    schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    model: 'claude-haiku-4-5-20251001',
    purpose: 'learn',
    ...overrides,
  };
}

/** Builds a fake child process that writes `stdoutText` then closes with exit code 0. */
function fakeChild(stdoutText: string) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stdin: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  // Swallow anything written to stdin so the real stream doesn't error.
  child.stdin.on('data', () => {});
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(stdoutText));
    child.emit('close', 0);
  });
  return child;
}

function successResult(result: unknown) {
  return JSON.stringify({
    is_error: false,
    result: JSON.stringify(result),
    total_cost_usd: 0.42,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
  });
}

/** `vi.fn()`'s mock keeps its `.mock.calls` for assertions; only the value handed to
 * the provider needs the narrower `SpawnFn` shape. */
function asSpawnFn(mock: ReturnType<typeof vi.fn>): SpawnFn {
  return mock as unknown as SpawnFn;
}

describe('claude-cli provider - argument building', () => {
  it('spawns `claude -p` with the system prompt file, schema, output-format json, model alias, and no tools', async () => {
    let systemFileContent: string | undefined;
    const spawn = vi.fn().mockImplementation((_cmd: string, args: string[]) => {
      systemFileContent = readFileSync(args[args.indexOf('--system-prompt-file') + 1]!, 'utf8');
      return fakeChild(successResult({ answer: 'hi' }));
    });
    const provider = createClaudeCliProvider({ spawn: asSpawnFn(spawn), nodeEnv: 'development', cliPath: 'claude' });

    await provider.complete(baseRequest());
    expect(systemFileContent).toBe('you are a rules writer');

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args] = spawn.mock.calls[0] as [string, string[]];
    expect(command).toBe('claude');
    expect(args).toEqual(
      expect.arrayContaining([
        '-p',
        '--system-prompt-file',
        '--json-schema',
        JSON.stringify(baseRequest().schema),
        '--output-format',
        'json',
        '--model',
        'haiku',
        '--tools',
        '',
        '--permission-prompts',
        'none',
        '--no-session-persistence',
      ]),
    );
    // The temp dir holding the system prompt is removed after the call.
    expect(existsSync(args[args.indexOf('--system-prompt-file') + 1]!)).toBe(false);
  });

  it('strips $schema before passing it to --json-schema (the CLI treats it as an unresolvable ref, not a version tag)', async () => {
    const spawn = vi.fn().mockImplementation(() => fakeChild(successResult({ answer: 'hi' })));
    const provider = createClaudeCliProvider({ spawn: asSpawnFn(spawn), nodeEnv: 'development', cliPath: 'claude' });
    const schemaWithMeta = { $schema: 'https://json-schema.org/draft/2020-12/schema', ...baseRequest().schema };

    await provider.complete(baseRequest({ schema: schemaWithMeta }));

    const args = spawn.mock.calls[0]![1] as string[];
    const schemaArg = args[args.indexOf('--json-schema') + 1]!;
    expect(schemaArg).not.toContain('$schema');
    expect(JSON.parse(schemaArg)).toEqual(baseRequest().schema);
  });

  it('puts a large schema in the system-prompt file instead of --json-schema (Windows command-line limit)', async () => {
    // Build a schema whose JSON is deliberately over the 20,000-char guard.
    const bigEnum = Array.from({ length: 3000 }, (_, i) => `value${i}`);
    const bigSchema = { type: 'object', properties: { answer: { type: 'string', enum: bigEnum } }, required: ['answer'] };
    let systemFileContent: string | undefined;
    const spawn = vi.fn().mockImplementation((_cmd: string, args: string[]) => {
      systemFileContent = readFileSync(args[args.indexOf('--system-prompt-file') + 1]!, 'utf8');
      return fakeChild(successResult({ answer: 'hi' }));
    });
    const provider = createClaudeCliProvider({ spawn: asSpawnFn(spawn), nodeEnv: 'development', cliPath: 'claude' });

    await provider.complete(baseRequest({ schema: bigSchema }));

    const args = spawn.mock.calls[0]![1] as string[];
    expect(args).not.toContain('--json-schema');
    expect(systemFileContent).toContain('you are a rules writer');
    expect(systemFileContent).toContain('Return ONLY a single JSON object');
    expect(systemFileContent).toContain(JSON.stringify(bigSchema));
  });

  it('resolves the bundled claude.exe next to the npm claude.cmd shim on Windows', () => {
    const npmDir = join('C:', 'npm');
    const exe = join(npmDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const files = new Set([join(npmDir, 'claude.cmd'), exe]);
    const pathEnv = [join('C:', 'other'), npmDir].join(delimiter);
    expect(resolveClaudeCommand('win32', pathEnv, (f) => files.has(f))).toBe(exe);
    expect(resolveClaudeCommand('linux', '/usr/bin')).toBe('claude');
  });

  it('maps a model id containing "sonnet" to the "sonnet" CLI alias', async () => {
    const spawn = vi.fn().mockImplementation(() => fakeChild(successResult({ answer: 'hi' })));
    const provider = createClaudeCliProvider({ spawn: asSpawnFn(spawn), nodeEnv: 'development' });

    await provider.complete(baseRequest({ model: 'claude-sonnet-5' }));

    const args = spawn.mock.calls[0]![1] as string[];
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
  });

  it('uses CLAUDE_CLI_PATH when provided instead of "claude"', async () => {
    const spawn = vi.fn().mockImplementation(() => fakeChild(successResult({ answer: 'hi' })));
    const provider = createClaudeCliProvider({
      spawn: asSpawnFn(spawn),
      nodeEnv: 'development',
      cliPath: '/opt/claude/bin/claude',
    });

    await provider.complete(baseRequest());

    expect(spawn.mock.calls[0]![0]).toBe('/opt/claude/bin/claude');
  });

  it.skipIf(process.platform === 'win32')('falls back to `npx -y @anthropic-ai/claude-code` when the command is not on PATH (ENOENT)', async () => {
    let call = 0;
    const spawn = vi.fn().mockImplementation((command: string) => {
      call += 1;
      if (call === 1) {
        const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stdin: PassThrough };
        child.stdout = new PassThrough();
        child.stdin = new PassThrough();
        child.stdin.on('data', () => {});
        queueMicrotask(() => child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' })));
        return child;
      }
      expect(command).toBe('npx');
      return fakeChild(successResult({ answer: 'hi' }));
    });

    const provider = createClaudeCliProvider({ spawn: asSpawnFn(spawn), nodeEnv: 'development', cliPath: 'claude' });
    const result = await provider.complete(baseRequest());

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1]![0]).toBe('npx');
    expect((spawn.mock.calls[1]![1] as string[]).slice(0, 2)).toEqual(['-y', '@anthropic-ai/claude-code']);
    expect(result.json).toEqual({ answer: 'hi' });
  });
});

describe('claude-cli provider - response mapping', () => {
  it('parses the CLI\'s `result` field as JSON, maps usage, and reports cost 0 (subscription)', async () => {
    const spawn = vi.fn().mockImplementation(() => fakeChild(successResult({ answer: 'hi' })));
    const provider = createClaudeCliProvider({ spawn: asSpawnFn(spawn), nodeEnv: 'development' });

    const result = await provider.complete(baseRequest());

    expect(result.json).toEqual({ answer: 'hi' });
    expect(result.usage).toEqual({ tokensIn: 10, tokensOut: 5, tokensCachedRead: 1, tokensCachedWrite: 2 });
    expect(result.costUsd).toBe(0);
    expect(result.provider).toBe('claude-cli');
  });

  it('throws a "refused" LlmError when the CLI reports it is not logged in', async () => {
    const cliOutput = JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' });
    const spawn = vi.fn().mockImplementation(() => fakeChild(cliOutput));
    const provider = createClaudeCliProvider({ spawn: asSpawnFn(spawn), nodeEnv: 'development' });

    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'refused' });
  });

  it('throws an "invalidJson" LlmError when the CLI\'s result is not valid JSON', async () => {
    const cliOutput = JSON.stringify({ is_error: false, result: 'not json' });
    const spawn = vi.fn().mockImplementation(() => fakeChild(cliOutput));
    const provider = createClaudeCliProvider({ spawn: asSpawnFn(spawn), nodeEnv: 'development' });

    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'invalidJson' });
  });

  it('throws a "providerError" LlmError when stdout is not valid JSON at all', async () => {
    const spawn = vi.fn().mockImplementation(() => fakeChild('not even json'));
    const provider = createClaudeCliProvider({ spawn: asSpawnFn(spawn), nodeEnv: 'development' });

    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'providerError' });
  });
});

describe('claude-cli provider - production refusal', () => {
  it('refuses to run when NODE_ENV=production, without spawning anything', async () => {
    const spawn = vi.fn();
    const provider = createClaudeCliProvider({ spawn: asSpawnFn(spawn), nodeEnv: 'production' });

    await expect(provider.complete(baseRequest())).rejects.toMatchObject({ kind: 'refused' });
    expect(spawn).not.toHaveBeenCalled();
  });
});
