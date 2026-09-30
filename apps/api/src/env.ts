import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LLM_PROVIDERS, type LlmProviderName } from '@formatai/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** apps/api/src -> apps/api -> apps -> repo root */
export const repoRoot = path.resolve(__dirname, '../../..');

/**
 * Loads the repo-root `.env` file into `process.env`, if present.
 * Uses Node's built-in loader so we don't need a `dotenv` dependency.
 * Guarded: does nothing if the file is missing, and never throws.
 */
function loadDotEnvFile(): void {
  const envPath = path.join(repoRoot, '.env');
  if (!existsSync(envPath)) return;
  if (typeof process.loadEnvFile !== 'function') return;
  try {
    process.loadEnvFile(envPath);
  } catch {
    // Malformed .env: fall back to whatever is already in process.env.
  }
}

loadDotEnvFile();

/** Optional string keys documented in `.env.example` that this service doesn't need yet (M1-M3). */
const OPTIONAL_STRING_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  /** Path to the Claude Code CLI binary (SPEC 9.6 "claude-cli" provider, dev only). Falls back to "claude" on PATH, then `npx -y @anthropic-ai/claude-code`, when unset. */
  'CLAUDE_CLI_PATH',
  /**
   * SPEC 9.4/9.6: optional overrides for the model registry (`config/models.ts`) so
   * switching models needs no code change. When set, they replace the active
   * provider's `firstTry`/`escalation` entry; when unset, config wins.
   */
  'LLM_MODEL_FIRST_TRY',
  'LLM_MODEL_ESCALATION',
  'SESSION_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'ADMIN_EMAILS',
  'TURNSTILE_SECRET_KEY',
  'VITE_TURNSTILE_SITE_KEY',
  /** Public Turnstile site key served by GET /api/session; falls back to `VITE_TURNSTILE_SITE_KEY` (same repo-root .env). */
  'TURNSTILE_SITE_KEY',
  /** Secret mixed into the IP hash for `ip:<hash>:<day>` counters and into learnId signatures (SPEC 13). Falls back to SESSION_SECRET. Required in production. */
  'IP_HASH_SECRET',
  /** How many proxy hops to trust for `req.ip` (an integer), or "true" to trust them all. Unset = trust none (req.ip is the socket address). */
  'TRUST_PROXY',
] as const;

type OptionalStringKey = (typeof OPTIONAL_STRING_KEYS)[number];

export type Env = {
  PORT: number;
  NODE_ENV: string;
  WEB_ORIGIN: string;
  /** Empty string means "not configured" - see src/db.ts. */
  MONGODB_URI: string;
  MONGODB_DB: string;
  /** SPEC 9.6: which LLM provider `apps/api/src/llm` selects. Defaults to "claude-cli" (dev). */
  LLM_PROVIDER: LlmProviderName;
} & Partial<Record<OptionalStringKey, string>>;

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 8787;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`Invalid PORT env var: expected an integer in 1-65535, got "${raw}"`);
  }
  return n;
}

function trimmedOrUndefined(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isLlmProviderName(value: string): value is LlmProviderName {
  return (LLM_PROVIDERS as readonly string[]).includes(value);
}

function parseLlmProvider(raw: string | undefined): LlmProviderName {
  const trimmed = trimmedOrUndefined(raw) ?? 'claude-cli';
  if (!isLlmProviderName(trimmed)) {
    throw new Error(`Invalid LLM_PROVIDER env var: expected one of ${LLM_PROVIDERS.join(', ')}, got "${raw}"`);
  }
  return trimmed;
}

/**
 * Parses and validates the process environment into a typed Env.
 * Never logs values (some are secrets) - only this module's own errors,
 * which name the bad key, may include non-secret values like PORT.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const env: Env = {
    PORT: parsePort(source.PORT),
    NODE_ENV: trimmedOrUndefined(source.NODE_ENV) ?? 'development',
    WEB_ORIGIN: trimmedOrUndefined(source.WEB_ORIGIN) ?? 'http://localhost:5173',
    MONGODB_URI: trimmedOrUndefined(source.MONGODB_URI) ?? '',
    MONGODB_DB: trimmedOrUndefined(source.MONGODB_DB) ?? 'formatai',
    LLM_PROVIDER: parseLlmProvider(source.LLM_PROVIDER),
  };

  for (const key of OPTIONAL_STRING_KEYS) {
    const value = trimmedOrUndefined(source[key]);
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}
