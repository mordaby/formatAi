/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// docs/design-plan.md and SPEC 16.2: logical CSS properties only (so RTL and LTR are both right
// without a second stylesheet), one token set with a dark theme, and respect for reduced motion.
// (Read from disk: Vite's own CSS handling would hand a test an empty string.)
const dir = join(import.meta.dirname, '..', 'src', 'styles');
const sheets: Record<string, string> = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => [`/src/styles/${f}`, readFileSync(join(dir, f), 'utf8')]));

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('stylesheets', () => {
  it('finds them (guards against a silently empty glob)', () => {
    expect(Object.keys(sheets).map((p) => p.split('/').pop())).toEqual(expect.arrayContaining(['tokens.css', 'base.css', 'ui.css', 'app.css']));
  });

  it('never uses physical left/right (logical properties only)', () => {
    const offenders: string[] = [];
    for (const [path, css] of Object.entries(sheets)) {
      stripComments(css)
        .split('\n')
        .forEach((line, n) => {
          // property names (margin-left, padding-right, border-left, left:, right:), values (text-align: left, float: right), and translateX
          if (/(^|[\s;{-])(left|right)\s*:|-(left|right)\b|:\s*(left|right)\b|translateX|float\s*:|\bcursor:\s*[ew]-resize/.test(line)) offenders.push(`${path}:${n + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it('defines every color role for light and dark from the same names', () => {
    const tokens = stripComments(sheets['/src/styles/tokens.css']!);
    const [light, dark] = tokens.split('@media (prefers-color-scheme: dark)') as [string, string];
    const names = (css: string): Set<string> => new Set([...css.matchAll(/(--(?:paper|surface|line|line-strong|ink|ink-2|brand|on-brand|brand-tint|on-brand-tint|diff|diff-icon|diff-tint|diff-tint-strong|on-diff-tint|danger|danger-tint|on-danger-tint|focus)):/g)].map((m) => m[1]!));
    expect(names(dark)).toEqual(names(light));
    // The approved palette (docs/design-plan.md).
    for (const [token, value] of [['--paper', '#fbfaf7'], ['--brand', '#0f6e6a'], ['--diff', '#e08a00'], ['--ink', '#1f2328'], ['--line-strong', '#b9b4a6']] as const) {
      expect(light.toLowerCase()).toContain(`${token}: ${value}`);
    }
  });

  it('uses IBM Plex Sans Hebrew and turns motion off for reduced-motion users', () => {
    expect(sheets['/src/styles/tokens.css']).toContain("'IBM Plex Sans Hebrew'");
    const base = sheets['/src/styles/base.css']!;
    expect(base).toContain('@media (prefers-reduced-motion: reduce)');
    expect(base).toContain('.reduce-motion');
  });
});
