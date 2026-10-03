// Command-line parsing of `run-catalogue.ts` (kept apart from the runner so a test can import it: the runner itself runs `main()` when loaded).
//
//   --types <list>     comma-separated: full ids, a topic ("extraction") or a prefix ("dates.add-*"). Default: all.
//   --seeds <list>     comma-separated seeds (default 1,2).
//   --list             print the catalogue (id, topic, language, expressible) and exit.
//   --dump [dir]       also write every generated file and the rules (reference and learned) under dir (default catalogue/.cache).
//   --out <dir>        where report.md / report.csv / results.json go (default: this directory).
//   --report-only      do not measure: re-render the report from the existing results.json.
//   --ai <model>       the AI measurement: the real learn flow with the AI step allowed, on the types the free engine does not solve.
//     --provider <p>     anthropic | openai | claude-cli | fake (default: LLM_PROVIDER from the environment / .env). `--ai fake` means --provider fake.
//     --masking on|off   default on (what the app does)
//     --mode full|complete   default complete (the app's default path: the free engine first, then the AI step on what is missing)
//     --no-escalation    skip the escalation model (the first-try model and its repair rounds still run)
//     --chunk N/M        run only the N-th of M deterministic parts of the needs-AI set (1 <= N <= M)
//     --resume           skip (type, seed) pairs already measured in results.json under the same model/mode/masking/escalation
//     --plan             print what would run (the needs-AI set, the chunk, what --resume would skip) and exit: no LLM call
//     --replace          overwrite AI results recorded under another model/mode/masking (without it such a run refuses to start)
import path from 'node:path';
import { LLM_PROVIDERS, type LlmProviderName } from '@formatai/shared';
import { EVAL_MODES, type EvalMode } from '../lib/args';

export class CatalogueArgsError extends Error {}

export interface Chunk {
  /** 1-based. */
  index: number;
  total: number;
}

export interface AiArgs {
  model: string;
  /** Undefined = the provider the environment says (LLM_PROVIDER), resolved by the runner. */
  provider?: LlmProviderName;
  masking: boolean;
  mode: EvalMode;
  noEscalation: boolean;
  chunk?: Chunk;
  resume: boolean;
  plan: boolean;
  replace: boolean;
}

export interface CatalogueArgs {
  types: string[];
  seeds: number[];
  list: boolean;
  dump?: string;
  out: string;
  reportOnly: boolean;
  ai?: AiArgs;
}

export interface ArgDefaults {
  /** Default of --out. */
  out: string;
  /** Default of a bare --dump. */
  dumpDir: string;
}

export function parseChunk(v: string): Chunk {
  const m = /^(\d+)\/(\d+)$/.exec(v.trim());
  if (!m) throw new CatalogueArgsError(`--chunk: expected N/M (for example 1/3), got "${v}"`);
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (total < 1 || index < 1 || index > total) throw new CatalogueArgsError(`--chunk: N must be between 1 and M, got ${index}/${total}`);
  return { index, total };
}

function isProvider(v: string): v is LlmProviderName {
  return (LLM_PROVIDERS as readonly string[]).includes(v);
}

export function parseArgs(argv: readonly string[], defaults: ArgDefaults): CatalogueArgs {
  const args: CatalogueArgs = { types: [], seeds: [1, 2], list: false, out: defaults.out, reportOnly: false };
  const split = (v: string): string[] => v.split(',').map((s) => s.trim()).filter((s) => s !== '');

  let model: string | undefined;
  let provider: LlmProviderName | undefined;
  let masking: boolean | undefined;
  let mode: EvalMode | undefined;
  let noEscalation = false;
  let chunk: Chunk | undefined;
  let resume = false;
  let plan = false;
  let replace = false;
  /** The AI-only flags that were given, to refuse them when --ai is missing (a silent no-op would let a typo cost a full run). */
  const aiOnly: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.indexOf('=');
    const flag = eq >= 0 ? raw.slice(0, eq) : raw;
    const inline = eq >= 0 ? raw.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = argv[++i];
      if (v === undefined) throw new CatalogueArgsError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--types':
        args.types = split(value());
        break;
      case '--seeds':
        args.seeds = split(value()).map((s) => {
          const n = Number(s);
          if (!Number.isInteger(n)) throw new CatalogueArgsError(`--seeds: "${s}" is not an integer`);
          return n;
        });
        break;
      case '--list':
        args.list = true;
        break;
      case '--dump': {
        const next = argv[i + 1];
        args.dump = inline ?? (next !== undefined && !next.startsWith('--') ? (i++, next) : defaults.dumpDir);
        break;
      }
      case '--out':
        args.out = path.resolve(value());
        break;
      case '--report-only':
        args.reportOnly = true;
        break;
      case '--ai': {
        const v = value().trim();
        if (v === '' || v.startsWith('-')) throw new CatalogueArgsError(`--ai needs a model name (for example haiku), got "${v}"`);
        model = v;
        break;
      }
      case '--provider': {
        const v = value();
        if (!isProvider(v)) throw new CatalogueArgsError(`--provider: expected one of ${LLM_PROVIDERS.join(', ')}, got "${v}"`);
        provider = v;
        aiOnly.push(flag);
        break;
      }
      case '--masking': {
        const v = value();
        if (v !== 'on' && v !== 'off') throw new CatalogueArgsError(`--masking: expected "on" or "off", got "${v}"`);
        masking = v === 'on';
        aiOnly.push(flag);
        break;
      }
      case '--mode': {
        const v = value();
        if (!(EVAL_MODES as readonly string[]).includes(v)) throw new CatalogueArgsError(`--mode: expected "full" or "complete", got "${v}"`);
        mode = v as EvalMode;
        aiOnly.push(flag);
        break;
      }
      case '--no-escalation':
        noEscalation = true;
        aiOnly.push(flag);
        break;
      case '--chunk':
        chunk = parseChunk(value());
        aiOnly.push(flag);
        break;
      case '--resume':
        resume = true;
        aiOnly.push(flag);
        break;
      case '--plan':
        plan = true;
        aiOnly.push(flag);
        break;
      case '--replace':
        replace = true;
        aiOnly.push(flag);
        break;
      default:
        throw new CatalogueArgsError(`unknown option ${raw}`);
    }
  }

  if (model === undefined) {
    if (aiOnly.length > 0) throw new CatalogueArgsError(`${aiOnly[0]} only applies together with --ai <model>`);
    return args;
  }
  if (args.reportOnly) throw new CatalogueArgsError('--report-only never measures: drop --ai (the report shows whatever AI results results.json has)');
  // The model id "fake" is never a real model: it always runs on the fake provider, whatever the environment says.
  if (model === 'fake') {
    if (provider !== undefined && provider !== 'fake') throw new CatalogueArgsError('--ai fake runs on the fake provider only (no real model has that name): drop --provider or use --provider fake');
    provider = 'fake';
  }
  args.ai = {
    model,
    ...(provider !== undefined ? { provider } : {}),
    masking: masking ?? true,
    mode: mode ?? 'complete',
    noEscalation,
    ...(chunk ? { chunk } : {}),
    resume,
    plan,
    replace,
  };
  return args;
}
