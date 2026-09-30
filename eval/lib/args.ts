// CLI argument parsing for `pnpm eval` (SPEC 10): "pnpm eval --models <a>,<b>
// --masking on,off --runs 3 [--provider anthropic|openai|claude-cli|fake]
// [--cases <substring>] [--out <dir>] [--no-escalation] [--mode full|complete|both]".
//
// Kept dependency-free (no argv-parsing package) since the surface is tiny and fixed.
import { LLM_PROVIDERS, type LlmProviderName } from '@formatai/shared';

/** What the AI step is asked to do (LEARN_PROMPT "Completing a partial rules file"): `full` learns everything from the two
 * files (today's learn); `complete` runs the local partial result first (no LLM) and then the AI step only on what is
 * missing, keeping the local rules as a fixed part. */
export type EvalMode = 'full' | 'complete';
export const EVAL_MODES: readonly EvalMode[] = ['full', 'complete'];

export interface EvalArgs {
  /** Model ids to benchmark as the first-try model, one full pass each. Undefined
   * means "the provider's own default firstTry" (resolved once the provider is known). */
  models?: string[];
  masking: ('on' | 'off')[];
  runs: number;
  /** Undefined means "whatever env.LLM_PROVIDER / .env resolves to". */
  provider?: LlmProviderName;
  /** Substring filter on the case directory name. */
  cases?: string;
  /** Report output directory. Defaults to `eval/reports/<UTC timestamp>`. */
  out?: string;
  noEscalation: boolean;
  /** Which modes to run, in order (default: `['full']`). `--mode both` (or `full,complete`) runs both for a side-by-side report. */
  modes: EvalMode[];
}

function isLlmProviderName(v: string): v is LlmProviderName {
  return (LLM_PROVIDERS as readonly string[]).includes(v);
}

/** Splits a comma-separated flag value, trimming and dropping empty entries. */
function splitList(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export class EvalArgsError extends Error {}

/**
 * Parses `process.argv.slice(2)`-shaped args. Every flag is `--name value` or
 * `--name=value`; `--no-escalation` is a bare boolean flag.
 */
export function parseArgs(argv: readonly string[]): EvalArgs {
  const args: EvalArgs = { masking: ['on', 'off'], runs: 1, noEscalation: false, modes: ['full'] };

  let i = 0;
  const next = (flag: string): string => {
    const v = argv[i];
    i++;
    if (v === undefined) throw new EvalArgsError(`${flag} needs a value`);
    return v;
  };

  while (i < argv.length) {
    const raw = argv[i]!;
    i++;
    if (raw === '--no-escalation') {
      args.noEscalation = true;
      continue;
    }
    const eq = raw.indexOf('=');
    const flag = eq >= 0 ? raw.slice(0, eq) : raw;
    const inlineValue = eq >= 0 ? raw.slice(eq + 1) : undefined;
    const value = (): string => inlineValue ?? next(flag);

    switch (flag) {
      case '--models':
        args.models = splitList(value());
        break;
      case '--masking': {
        const modes = splitList(value());
        for (const m of modes) {
          if (m !== 'on' && m !== 'off') throw new EvalArgsError(`--masking: expected "on" or "off", got "${m}"`);
        }
        args.masking = modes as ('on' | 'off')[];
        break;
      }
      case '--runs': {
        const v = value();
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) throw new EvalArgsError(`--runs: expected a positive integer, got "${v}"`);
        args.runs = n;
        break;
      }
      case '--provider': {
        const v = value();
        if (!isLlmProviderName(v)) throw new EvalArgsError(`--provider: expected one of ${LLM_PROVIDERS.join(', ')}, got "${v}"`);
        args.provider = v;
        break;
      }
      case '--mode': {
        const v = value();
        const modes = v === 'both' ? [...EVAL_MODES] : splitList(v);
        for (const m of modes) {
          if (!(EVAL_MODES as readonly string[]).includes(m)) throw new EvalArgsError(`--mode: expected "full", "complete" or "both", got "${m}"`);
        }
        if (modes.length === 0) throw new EvalArgsError('--mode: at least one of "full"/"complete" is required');
        args.modes = [...new Set(modes)] as EvalMode[];
        break;
      }
      case '--cases':
        args.cases = value();
        break;
      case '--out':
        args.out = value();
        break;
      default:
        throw new EvalArgsError(`unknown flag "${flag}"`);
    }
  }

  if (args.masking.length === 0) throw new EvalArgsError('--masking: at least one of "on"/"off" is required');
  return args;
}
