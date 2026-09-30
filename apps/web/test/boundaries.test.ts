import { describe, expect, it } from 'vitest';

// SPEC 2: file data is read and processed in the worker only. The engine's barrel pulls in
// ExcelJS and SheetJS (~1.5 MB), so the main thread must never load it as code: it may only
// `import type` from '@formatai/engine' (erased at build time). The worker entry files are the
// one place allowed to import it for real. The pure formula printer/parser is reachable from
// the main thread through the '@formatai/engine/formula' alias instead.
const sources = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

// liveCheck.ts is the rules editor's half of the worker (engineMethods.ts registers it): it runs in the worker too.
const ALLOWED = new Set(['/src/worker/engineMethods.ts', '/src/worker/liveCheck.ts']);
const VALUE_IMPORT = /import\s+(?!type\b)[^;]*?from\s+['"]@formatai\/engine['"]/;
const SIDE_EFFECT_IMPORT = /import\s+['"]@formatai\/engine['"]/;

describe('main-thread bundle boundary', () => {
  it('finds the source files (guards against a silently empty glob)', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(15);
  });

  it("only the worker's method file imports @formatai/engine as code", () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !ALLOWED.has(path))
      .filter(([path]) => !/\.test\.tsx?$/.test(path)) // tests are never part of the bundle
      .filter(([, src]) => VALUE_IMPORT.test(src) || SIDE_EFFECT_IMPORT.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('the worker itself has no network code (it asks the main thread through ctx.host)', () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => path.startsWith('/src/worker/') && !path.endsWith('rpcClient.ts') && !path.endsWith('engineClient.ts'))
      .filter(([, src]) => /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
