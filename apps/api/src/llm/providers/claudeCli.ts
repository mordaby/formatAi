// SPEC 9.6: a dev-only provider that spawns the Claude Code CLI in print mode and
// runs on the developer's own Claude subscription, never billed through provider
// pricing. This file may import `node:child_process` freely (it isn't a "provider
// SDK" in the SPEC 9.6 sense), but must never import `@anthropic-ai/sdk` or `openai`.
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { LlmError } from '../errors.js';
import type { CompleteRequest, CompleteResult, LlmProvider, LlmUsage } from '../types.js';

/** SPEC 9.1 "claude-cli": the command line itself (not just the system prompt) is
 * capped at ~32k chars on Windows; `--json-schema <json>` is one argument on that same
 * line, so a schema over this size is appended to the system-prompt temp file instead
 * (see `complete()` below) rather than ever risking the command-line limit. */
const SCHEMA_CLI_ARG_LIMIT = 20_000;

export type SpawnFn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string },
) => ChildProcessWithoutNullStreams;

/**
 * The child gets our environment minus API credentials: with ANTHROPIC_API_KEY (or an auth token)
 * present, Claude Code would bill that key instead of the user's subscription login, which is the
 * whole point of this dev provider.
 */
/**
 * Resolve the CLI executable. On Windows the npm shim is `claude.cmd`, which Node cannot spawn
 * without a shell (and a shell would mangle the long arguments), so we start the real
 * `claude.exe` shipped inside the npm package.
 */
export function resolveClaudeCommand(
  platform: string = process.platform,
  pathEnv: string = process.env.PATH ?? '',
  exists: (p: string) => boolean = existsSync,
): string {
  if (platform !== 'win32') return 'claude';
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const direct = join(dir, 'claude.exe');
    if (exists(direct)) return direct;
    if (exists(join(dir, 'claude.cmd'))) {
      const bundled = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (exists(bundled)) return bundled;
    }
  }
  return 'claude';
}

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
  /** The model's own stop reason for its last turn (e.g. "end_turn", "tool_use", "max_tokens"), when the CLI reports one. */
  stop_reason?: string | null;
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
  cwd?: string,
): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnFn(command, args, { env: cliChildEnv(), ...(cwd ? { cwd } : {}) });
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
      const command = opts.cliPath ?? resolveClaudeCommand();
      // The system prompt goes through a temp file: Windows caps a command line at ~32k chars.
      // The child also runs in that temp dir so no project CLAUDE.md is picked up.
      const workDir = mkdtempSync(join(tmpdir(), 'formatai-cli-'));
      const systemFile = join(workDir, 'system.txt');
      // The CLI's own `--json-schema` validator treats a top-level `$schema` key as a
      // ref it must resolve (against its own internal registry, which doesn't have
      // this one) rather than a version identifier, and rejects the whole schema with
      // `--json-schema is not a valid JSON Schema: no schema with key or ref "..."`.
      // `z.toJSONSchema()` (`learnResultWireJsonSchema()`) always adds one, so it's
      // stripped here - the schema's actual shape is unaffected.
      const { $schema: _schemaMeta, ...schemaForCli } = req.schema as Record<string, unknown>;
      const schemaJson = JSON.stringify(schemaForCli);
      // learn-v5's wire schema fits well under this (a few thousand chars, down from
      // ~92,700 pre-formula-text) - but keep the guard: `--json-schema` is one more
      // command-line argument, still subject to the same ~32k Windows cap as the system
      // prompt, so a schema that grows past this threshold goes into the system-prompt
      // temp file instead (with an instruction to return only matching JSON), never onto
      // the command line.
      const schemaTooLargeForCli = schemaJson.length > SCHEMA_CLI_ARG_LIMIT;
      const systemContent = schemaTooLargeForCli
        ? `${req.system}\n\n# Output schema\nReturn ONLY a single JSON object matching this JSON Schema. No prose, no code fences, no explanation - just the JSON.\n\n${schemaJson}`
        : req.system;
      writeFileSync(systemFile, systemContent, 'utf8');
      const userContent = req.content.map((block) => block.text).join('\n\n');

      const args = [
        '-p',
        '--system-prompt-file',
        systemFile,
        ...(schemaTooLargeForCli ? [] : ['--json-schema', schemaJson]),
        '--output-format',
        'json',
        '--model',
        toCliModelAlias(req.model),
        // No tools exposed to the model (SPEC 9.1/15): "" disables the built-in tool set.
        '--tools',
        '',
        '--permission-prompts',
        'none',
        // Never write the session (it contains the payload) to disk; ignore user MCP servers.
        '--no-session-persistence',
        '--strict-mcp-config',
      ];

      let outcome: { stdout: string; exitCode: number | null };
      try {
        try {
          outcome = await runProcess(spawnFn, command, args, userContent, workDir);
        } catch (err) {
          if (!isEnoent(err)) {
            throw new LlmError('providerError', 'claude-cli', 'failed to spawn the claude CLI', { cause: err });
          }
          // Windows can't spawn npm's .cmd shims without a shell, so there is no npx fallback there.
          if (process.platform === 'win32') {
            throw new LlmError(
              'providerError',
              'claude-cli',
              'claude CLI not found: run `npm i -g @anthropic-ai/claude-code` and log in, or set CLAUDE_CLI_PATH',
              { cause: err },
            );
          }
          // Not found on PATH: fall back to `npx -y @anthropic-ai/claude-code`.
          try {
            outcome = await runProcess(spawnFn, 'npx', ['-y', '@anthropic-ai/claude-code', ...args], userContent, workDir);
          } catch (fallbackErr) {
            throw new LlmError('providerError', 'claude-cli', 'failed to spawn the claude CLI via npx', {
              cause: fallbackErr,
            });
          }
        }
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }

      let cliResult: ClaudeCliJsonResult;
      try {
        cliResult = JSON.parse(outcome.stdout) as ClaudeCliJsonResult;
      } catch {
        throw new LlmError('providerError', 'claude-cli', 'the claude CLI did not return valid JSON output');
      }

      const usage: LlmUsage = {
        tokensIn: cliResult.usage?.input_tokens ?? 0,
        tokensOut: cliResult.usage?.output_tokens ?? 0,
        tokensCachedRead: cliResult.usage?.cache_read_input_tokens ?? 0,
        tokensCachedWrite: cliResult.usage?.cache_creation_input_tokens ?? 0,
      };

      // Prompt audit X2: the CLI's JSON carries the model's `stop_reason`; an answer cut off at the output limit is reported the way the
      // API providers report it (whatever else the CLI says about that run). The CLI's own thinking and token limits are left as they are.
      if (cliResult.stop_reason === 'max_tokens' || cliResult.stop_reason === 'model_context_window_exceeded') {
        return { json: null, raw: cliResult.result ?? '', truncated: true, usage, costUsd: 0, latencyMs: Date.now() - start, model: req.model, provider: 'claude-cli' };
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
