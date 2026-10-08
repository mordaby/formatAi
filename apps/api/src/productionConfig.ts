// Production start-up check (deployment, SPEC 21 v13): everything a production process needs, listed at once.
// `buildServer` still throws on the few things that cannot work without (a database, Turnstile, a secret) - those are
// the backstop for tests and other callers; this check is what the owner sees first, with EVERY missing setting in one
// message instead of one per restart. It never prints a value: only names, and what a value must look like.
import { existsSync } from 'node:fs';
import { FEATURE_SWITCH_VALUES, featureSwitchOf, features, LEARN_CHECKS_MODES, learnChecksModeOf, models, type LlmProviderName } from '@formatai/shared';
import path from 'node:path';
import { isTurnstileDisabled, repoRoot, type Env } from './env.js';
import { PROVIDER_TABLE } from './auth/providers.js';
import { hasPrice } from './llm/cost.js';

/** A signing secret shorter than this is a guess waiting to happen (`openssl rand -base64 48` gives 64). */
export const MIN_SECRET_CHARS = 32;

export interface ProductionConfigReport {
  /** Each one stops the start. */
  problems: string[];
  /** Each one is logged and the process starts. */
  warnings: string[];
}

/** Where the built web app is served from: `WEB_DIST` (relative to the repo root), else `apps/web/dist`. */
export function webDistDir(env: Env): string {
  return path.resolve(repoRoot, env.WEB_DIST ?? 'apps/web/dist');
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const isSet = (value: string | undefined): boolean => value !== undefined && value.trim() !== '';

/** The API key variable of each API provider (the dev CLI and the fake need none). */
const API_KEY_NAMES = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' } as const;

function apiKeyOf(env: Env, provider: keyof typeof API_KEY_NAMES): string | undefined {
  return env[API_KEY_NAMES[provider]];
}

/**
 * What is wrong with `env` for a production process (empty when nothing). `source` is the raw process environment: it
 * tells whether the origin was named (`PUBLIC_ORIGIN`, Render's `RENDER_EXTERNAL_URL`, or both of `WEB_ORIGIN` and
 * `API_PUBLIC_URL`) rather than defaulting to the development one.
 */
export function checkProductionConfig(
  env: Env,
  source: NodeJS.ProcessEnv = process.env,
  opts: { webDistExists?: (dir: string) => boolean } = {},
): ProductionConfigReport {
  const problems: string[] = [];
  const warnings: string[] = [];
  const webDistExists = opts.webDistExists ?? ((dir: string) => existsSync(path.join(dir, 'index.html')));

  // The database: users, sessions, formats, limits, budgets and the learn cache all live there.
  if (!env.MONGODB_URI) {
    problems.push('MONGODB_URI is not set (the MongoDB Atlas connection string: users, formats, limits and budgets are stored there)');
  }

  // The secrets.
  const secret = (key: 'SESSION_SECRET' | 'IP_HASH_SECRET', purpose: string): void => {
    const value = env[key];
    if (!value) problems.push(`${key} is not set (${purpose}; at least ${MIN_SECRET_CHARS} random characters, e.g. \`openssl rand -base64 48\`)`);
    else if (value.length < MIN_SECRET_CHARS) problems.push(`${key} is too short (${value.length} characters; at least ${MIN_SECRET_CHARS})`);
  };
  secret('SESSION_SECRET', 'signs the sign-in cookies');
  secret('IP_HASH_SECRET', 'keys the per-IP counters and the learn ids');

  // Turnstile: the secret verifies the token, the site key is what the browser's widget needs (served by GET /api/session).
  // TURNSTILE_DISABLED=true (the first deploy, before the widget can be made) turns it off on purpose: a warning, not a problem.
  if (isTurnstileDisabled(env)) {
    warnings.push('Turnstile is OFF (TURNSTILE_DISABLED=true): set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY, then remove TURNSTILE_DISABLED');
  } else {
    if (!env.TURNSTILE_SECRET_KEY) problems.push('TURNSTILE_SECRET_KEY is not set (Cloudflare Turnstile, the secret key; for a first deploy without it set TURNSTILE_DISABLED=true)');
    if (!env.TURNSTILE_SITE_KEY && !env.VITE_TURNSTILE_SITE_KEY) {
      problems.push('TURNSTILE_SITE_KEY is not set (Cloudflare Turnstile, the public site key the browser shows the widget with)');
    }
  }

  // The AI step: the dev CLI and the fake provider exist for a developer's machine.
  if (env.LLM_PROVIDER === 'claude-cli' || env.LLM_PROVIDER === 'fake') {
    problems.push(`LLM_PROVIDER=${env.LLM_PROVIDER} is for development: set LLM_PROVIDER=anthropic (or openai) in production`);
  } else if (!apiKeyOf(env, env.LLM_PROVIDER)) {
    problems.push(`${API_KEY_NAMES[env.LLM_PROVIDER]} is not set (LLM_PROVIDER=${env.LLM_PROVIDER})`);
  }
  // The fallback (SPEC 9.6), when one is set: an API provider, with its own key. Unset is fine: no fallback.
  const fallback = env.LLM_FALLBACK_PROVIDER;
  if (fallback === 'claude-cli' || fallback === 'fake') {
    problems.push(`LLM_FALLBACK_PROVIDER=${fallback} is for development: set LLM_FALLBACK_PROVIDER=openai (or anthropic) in production, or remove it for no fallback`);
  } else if (fallback && !apiKeyOf(env, fallback)) {
    problems.push(`${API_KEY_NAMES[fallback]} is not set (LLM_FALLBACK_PROVIDER=${fallback}; remove LLM_FALLBACK_PROVIDER for no fallback)`);
  }

  // API audit C6 (2026-10-07): every model a call may go to has a price in config (`prices.ts`) - the defaults of the primary and the
  // fallback, and every LLM_MODEL_* / LLM_FALLBACK_MODEL_* override. An unpriced model is counted at the highest configured price
  // (`llm/cost.ts`), which keeps the budget safe but wrong: the owner adds its price first. (The dev CLI and the fake are refused above.)
  const priced = (provider: LlmProviderName, slot: 'firstTry' | 'escalation', override: string | undefined): void => {
    for (const [model, name] of [[models[provider][slot], `the ${provider} ${slot} default`], [override, 'an override']] as const) {
      if (model && !hasPrice(model)) {
        problems.push(`no price configured for the model "${model}" (${name}): add it to packages/shared/src/config/prices.ts, or use a priced model`);
      }
    }
  };
  if (env.LLM_PROVIDER !== 'claude-cli' && env.LLM_PROVIDER !== 'fake') {
    priced(env.LLM_PROVIDER, 'firstTry', env.LLM_MODEL_FIRST_TRY);
    priced(env.LLM_PROVIDER, 'escalation', env.LLM_MODEL_ESCALATION);
  }
  if (fallback && fallback !== 'claude-cli' && fallback !== 'fake') {
    priced(fallback, 'firstTry', env.LLM_FALLBACK_MODEL_FIRST_TRY);
    priced(fallback, 'escalation', env.LLM_FALLBACK_MODEL_ESCALATION);
  }

  // AI code checks (SPEC 21 v14): who gets learn-v9. A value that is no mode is a typo that would silently mean "nobody".
  if (learnChecksModeOf(env.LEARN_CHECKS) === null) {
    problems.push(`LEARN_CHECKS must be one of ${LEARN_CHECKS_MODES.join(', ')} (or unset: off)`);
  }
  // Feature switch "Formats with several sources" (config/features.ts): a value that is neither on nor off is a typo that would silently
  // mean the default.
  if (featureSwitchOf(env.FEATURE_FORMAT_SOURCES, features.formatSources) === null) {
    problems.push(`FEATURE_FORMAT_SOURCES must be one of ${FEATURE_SWITCH_VALUES.join(', ')} (or unset: ${features.formatSources ? 'on' : 'off'})`);
  }

  // Sign-in: at least one provider, and never half of one (a provider with only an id is silently not offered).
  let providers = 0;
  let half = 0;
  for (const spec of Object.values(PROVIDER_TABLE)) {
    const idKey = `${spec.envPrefix}_CLIENT_ID`;
    const secretKey = `${spec.envPrefix}_CLIENT_SECRET`;
    const hasId = isSet(source[idKey]);
    const hasSecret = isSet(source[secretKey]);
    if (hasId && hasSecret) providers++;
    else if (hasId || hasSecret) {
      half++;
      const [set, missing] = hasId ? [idKey, secretKey] : [secretKey, idKey];
      problems.push(`${missing} is not set (${set} is, so ${spec.label} sign-in would silently not be offered)`);
    }
  }
  if (providers === 0 && half === 0) {
    problems.push('no sign-in provider is configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (and/or the MICROSOFT_ ones) - the AI step and saved formats need a signed-in user');
  }

  // The origin the browser sees: the OIDC redirect URIs and the sign-in redirects are built from it.
  const named =
    isSet(source.PUBLIC_ORIGIN) || isSet(source.RENDER_EXTERNAL_URL) || (isSet(source.WEB_ORIGIN) && isSet(source.API_PUBLIC_URL));
  if (!named) {
    problems.push('the public origin is not set: set PUBLIC_ORIGIN (e.g. https://formatai.onrender.com; on Render RENDER_EXTERNAL_URL is used when it is not set)');
  } else {
    for (const [key, value] of [['WEB_ORIGIN', env.WEB_ORIGIN], ['API_PUBLIC_URL', env.API_PUBLIC_URL]] as const) {
      if (!value) continue;
      try {
        const url = new URL(value);
        // A Secure cookie is never sent over plain http (except to this machine), so sign-in would not work.
        if (url.protocol !== 'https:' && !LOCAL_HOSTS.has(url.hostname)) problems.push(`${key} must be an https:// URL in production`);
      } catch {
        problems.push(`${key} is not a valid URL`);
      }
    }
  }

  // The web app is served by this process (one service, one origin), so it must have been built.
  const dist = webDistDir(env);
  if (!webDistExists(dist)) problems.push(`the web app is not built: ${path.join(dist, 'index.html')} is missing (run \`pnpm build\`, or set WEB_DIST)`);

  // Not stops, but worth a line in the log.
  if (!isSet(source.TRUST_PROXY)) {
    warnings.push('TRUST_PROXY is not set: behind a proxy every visitor looks like the proxy to the per-IP limits (on Render set TRUST_PROXY=true)');
  }
  if (!env.ADMIN_EMAILS && !env.MICROSOFT_ADMIN_OIDS) {
    warnings.push('ADMIN_EMAILS and MICROSOFT_ADMIN_OIDS are both empty: nobody can open the admin view');
  }

  return { problems, warnings };
}

/** The message `index.ts` prints before it exits, or null when the configuration is fine. */
export function formatProductionProblems(problems: readonly string[]): string | null {
  if (problems.length === 0) return null;
  return [
    `formatAI cannot start in production: ${problems.length} setting${problems.length === 1 ? ' needs' : 's need'} attention.`,
    ...problems.map((p) => `  - ${p}`),
    'Set them in the Render dashboard (Environment) - docs/deploy.md has the list. Values are never printed.',
  ].join('\n');
}
