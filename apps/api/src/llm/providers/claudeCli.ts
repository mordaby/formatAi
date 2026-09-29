// SPEC 9.6: a dev-only provider that spawns the Claude Code CLI in print mode and
// runs on the developer's own Claude subscription, never billed through provider
// pricing. This file may import `node:child_process` freely (it isn't a "provider
// SDK" in the SPEC 9.6 sense), but must never import `@anthropic-ai/sdk` or `openai`.
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { LlmError } from '../errors.js';
import type { CompleteRequest, CompleteResult, LlmProvider, LlmUsage } from '../types.js';

export type SpawnFn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

/**
 * The child gets our environment minus API credentials: with ANTHROPIC_API_KEY (or an auth token)
 * present, Claude Code would bill that key instead of the user's subscription login, which is the
 * whole point of this dev provider.
 */
export function cliChildEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...parent };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

export interface CreateClaudeCliProviderOptions {
  /** `CLAUDE_CLI_PATH` env value. Defaults to "claude" (resolved via PATH). */
  cliPath?: string;
  /** Defaults to `process.env.NODE_ENV`. The provider refuses to run in production. */
  nodeEnv?: string;
  /** Dependency injection for tests. Defaults to `node:child_process`'s `spawn`. */
  spawn?: SpawnFn;
}

interface ClaudeCliJsonResult {
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** `claude --model` accepts an alias ("haiku", "sonnet", ...) or a full model id. */
function toCliModelAlias(model: string): string {
  const lower = model.toLowerCase();
  for (const alias of ['haiku', 'sonnet', 'opus', 'fable', 'mythos']) {
    if (lower.includes(alias)) return alias;
  }
  return model;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';
}

function runProcess(
  spawnFn: SpawnFn,
  command: string,
  args: string[],
  stdin: string,
): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnFn(command, args, { env: cliChildEnv() });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let settled = false;

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      resolve({ stdout, exitCode });
    });

    child.stdin?.write(stdin);
    child.stdin?.end();
  });
}

export function createClaudeCliProvider(opts: CreateClaudeCliProviderOptions = {}): LlmProvider {
  const spawnFn: SpawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);

  return {
    name: 'claude-cli',
    async complete(req: CompleteRequest): Promise<CompleteResult> {
      const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV ?? 'development';
      if (nodeEnv === 'production') {
        throw new LlmError('refused', 'claude-cli', 'the claude-cli provider is refused when NODE_ENV=production');
      }

      const start = Date.now();
      const command = opts.cliPath ?? 'claude';
      const userContent = req.content.map((block) => block.text).join('\n\n');

      const args = [
        '-p',
        '--system-prompt',
        req.system,
        '--json-schema',
        JSON.stringify(req.schema),
        '--output-format',
        'json',
        '--model',
        toCliModelAlias(req.model),
        // No tools exposed to the model (SPEC 9.1/15): "" disables the built-in tool set.
        '--tools',
        '',
        '--permission-prompts',
        'none',
      ];

      let outcome: { stdout: string; exitCode: number | null };
      try {
        outcome = await runProcess(spawnFn, command, args, userContent);
      } catch (err) {
        if (!isEnoent(err)) {
          throw new LlmError('providerError', 'claude-cli', 'failed to spawn the claude CLI', { cause: err });
        }
        // Not found on PATH: fall back to `npx -y @anthropic-ai/claude-code`.
        try {
          outcome = await runProcess(spawnFn, 'npx', ['-y', '@anthropic-ai/claude-code', ...args], userContent);
        } catch (fallbackErr) {
          throw new LlmError('providerError', 'claude-cli', 'failed to spawn the claude CLI via npx', {
            cause: fallbackErr,
          });
        }
      }

      let cliResult: ClaudeCliJsonResult;
      try {
        cliResult = JSON.parse(outcome.stdout) as ClaudeCliJsonResult;
      } catch {
        throw new LlmError('providerError', 'claude-cli', 'the claude CLI did not return valid JSON output');
      }

      if (cliResult.is_error) {
        const message = cliResult.result ?? 'the claude CLI reported an error';
        const lower = message.toLowerCase();
        if (lower.includes('log in') || lower.includes('login') || lower.includes('auth')) {
          throw new LlmError('refused', 'claude-cli', message);
        }
        if (lower.includes('rate limit') || lower.includes('budget') || lower.includes('overloaded')) {
          throw new LlmError('rateLimited', 'claude-cli', message);
        }
        throw new LlmError('providerError', 'claude-cli', message);
      }

      const raw = cliResult.result ?? '';
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new LlmError('invalidJson', 'claude-cli', 'model response was not valid JSON');
      }

      const usage: LlmUsage = {
        tokensIn: cliResult.usage?.input_tokens ?? 0,
        tokensOut: cliResult.usage?.output_tokens ?? 0,
        tokensCachedRead: cliResult.usage?.cache_read_input_tokens ?? 0,
        tokensCachedWrite: cliResult.usage?.cache_creation_input_tokens ?? 0,
      };

      return {
        json,
        raw,
        usage,
        // SPEC "claude-cli": runs on the developer's own subscription - never metered
        // through provider pricing, regardless of what the CLI itself reports.
        costUsd: 0,
        latencyMs: Date.now() - start,
        model: req.model,
        provider: 'claude-cli',
      };
    },
  };
}
