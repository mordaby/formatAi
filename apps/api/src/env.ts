import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  'SESSION_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'ADMIN_EMAILS',
  'TURNSTILE_SECRET_KEY',
  'VITE_TURNSTILE_SITE_KEY',
] as const;

type OptionalStringKey = (typeof OPTIONAL_STRING_KEYS)[number];

export type Env = {
  PORT: number;
  NODE_ENV: string;
  WEB_ORIGIN: string;
  /** Empty string means "not configured" - see src/db.ts. */
  MONGODB_URI: string;
  MONGODB_DB: string;
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
  };

  for (const key of OPTIONAL_STRING_KEYS) {
    const value = trimmedOrUndefined(source[key]);
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}
