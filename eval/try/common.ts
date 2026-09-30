// Shared helpers for the local try-it commands (`pnpm learn`, `pnpm convert`).
import { isAbsolute, resolve } from 'node:path';

/** Paths are relative to where the user ran `pnpm …`, not to this package. */
export function userPath(p: string): string {
  return isAbsolute(p) ? p : resolve(process.env.INIT_CWD ?? process.cwd(), p);
}

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') continue;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) flags[k] = argv[++i]!;
      else flags[k] = 'true';
    } else positional.push(a);
  }
  return { positional, flags };
}

export function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

export const cellText = (v: unknown): string => (v === null || v === undefined ? '(empty)' : String(v));
