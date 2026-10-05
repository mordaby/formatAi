/// <reference types="node" />
// The accessibility rules that live in the stylesheets (IS 5568 / WCAG 2.1 AA; v13 M4): the colour roles keep the contrast WCAG asks for in
// every theme (including the high-contrast one), every accessibility setting has its rules, and nothing opts out of the text-size setting.
// (Read from disk: Vite's own CSS handling would hand a test an empty string.)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { A11Y_CLASS } from '../src/app/a11y/prefs';

const dir = join(import.meta.dirname, '..', 'src', 'styles');
const sheets: Record<string, string> = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The text between the braces of the first block that follows `marker`. */
function blockAfter(css: string, marker: string, from = 0): string {
  const at = css.indexOf(marker, from);
  if (at < 0) throw new Error(`no ${marker}`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unbalanced ${marker}`);
}

type Tokens = Record<string, string>;
const tokensOf = (block: string): Tokens => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1]!, m[2]!.toLowerCase()]));

const tokensCss = strip(sheets['tokens.css']!);
const a11yCss = strip(sheets['a11y.css']!);
const lightBase = tokensOf(blockAfter(tokensCss, ':root'));
const darkMedia = '@media (prefers-color-scheme: dark)';
const darkBase = { ...lightBase, ...tokensOf(blockAfter(blockAfter(tokensCss, darkMedia), ':root')) };
const contrastLight = { ...lightBase, ...tokensOf(blockAfter(a11yCss, 'html.a11y-contrast')) };
const contrastDark = { ...darkBase, ...contrastLight, ...tokensOf(blockAfter(blockAfter(a11yCss, darkMedia), 'html.a11y-contrast')) };

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** [foreground, background, minimum]: 4.5 for text (WCAG 1.4.3), 3 for what is not text but must be seen (1.4.11). */
const PAIRS: ReadonlyArray<readonly [string, string, number]> = [
  ['ink', 'paper', 4.5],
  ['ink-2', 'paper', 4.5],
  ['ink-2', 'surface', 4.5],
  ['brand', 'paper', 4.5],
  ['brand', 'surface', 4.5],
  ['on-brand', 'brand', 4.5],
  ['on-brand', 'brand-strong', 4.5],
  ['brand-strong', 'paper', 4.5],
  ['on-brand-tint', 'brand-tint', 4.5],
  ['on-diff-tint', 'diff-tint', 4.5],
  ['on-diff-tint', 'diff-tint-strong', 4.5],
  ['on-diff-tint', 'paper', 4.5],
  ['danger', 'paper', 4.5],
  ['on-danger-tint', 'danger-tint', 4.5],
  // outlines of controls, icons and the focus ring
  ['control-line', 'paper', 3],
  ['control-line', 'surface', 3],
  ['diff-icon', 'paper', 3],
  ['focus', 'paper', 3],
  ['focus', 'surface', 3],
];

describe.each([
  ['light', lightBase],
  ['dark', darkBase],
  ['high contrast, light', contrastLight],
  ['high contrast, dark', contrastDark],
] as const)('contrast of the colour roles: %s theme', (_name, tokens) => {
  it.each(PAIRS)('%s on %s reaches %s:1', (fg, bg, min) => {
    expect(tokens[fg], `--${fg}`).toBeTruthy();
    expect(tokens[bg], `--${bg}`).toBeTruthy();
    expect(ratio(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(min);
  });
});

describe('high contrast', () => {
  it.each([
    ['light', contrastLight],
    ['dark', contrastDark],
  ] as const)('%s: text and brand reach 7:1 (WCAG AAA) and a control outline is the ink', (_n, t) => {
    for (const [fg, bg] of [['ink', 'paper'], ['ink-2', 'paper'], ['brand', 'paper'], ['on-brand', 'brand'], ['on-brand-tint', 'brand-tint'], ['on-diff-tint', 'diff-tint'], ['on-danger-tint', 'danger-tint']] as const) {
      expect(ratio(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(7);
    }
    expect(t['control-line']).toBe(t['ink']);
  });
});

describe('the rules each setting needs', () => {
  it('every setting has its rules in a11y.css, and text size changes the one variable every font size is made from', () => {
    for (const cls of Object.values(A11Y_CLASS)) {
      const selector = cls === 'a11y-motion' ? '.a11y-motion' : `html.${cls}`;
      const where = cls === 'a11y-motion' ? strip(sheets['base.css']!) : a11yCss;
      expect(where, cls).toContain(selector);
    }
    expect(blockAfter(a11yCss, 'html.a11y-text-1')).toContain('--text-scale');
    expect(blockAfter(a11yCss, 'html.a11y-text-2')).toContain('--text-scale');
    // reduced motion: the setting turns off what the system setting turns off
    expect(strip(sheets['base.css']!)).toMatch(/\.reduce-motion \*,[\s\S]*\.a11y-motion \*/);
  });

  it('the focus ring is thick and does not rely on colour alone', () => {
    const ring = blockAfter(a11yCss, 'html.a11y-focus :focus,');
    expect(ring).toMatch(/outline:\s*4px solid/);
    expect(ring).toContain('box-shadow');
  });

  it('the button sits at the inline end, below dialogs, and the footer leaves room under its last line for it', () => {
    const button = blockAfter(a11yCss, '.a11y {');
    expect(button).toContain('position: fixed');
    expect(button).toContain('inset-inline-end');
    expect(button).toMatch(/z-index:\s*30/);
    expect(a11yCss).toMatch(/\.app-footer\s*\{[^}]*padding-block-end/);
    expect(blockAfter(a11yCss, '.a11y__button {')).toMatch(/inline-size:\s*48px/);
  });
});

describe('text size reaches every font size', () => {
  it('no stylesheet sets a font size in plain pixels (it would not follow the text-size setting): use a --fs-* token or calc(Npx * var(--text-scale, 1))', () => {
    const offenders: string[] = [];
    for (const [file, css] of Object.entries(sheets)) {
      strip(css)
        .split('\n')
        .forEach((line, n) => {
          const m = /(^|[\s;{])font-size\s*:\s*([^;}]+)/.exec(line);
          if (!m) return;
          const value = m[2]!.trim();
          const scales = value.includes('var(--fs-') || value.includes('--text-scale') || /^[\d.]+(em|rem|%)$/.test(value) || /^(inherit|initial|unset|larger|smaller)$/.test(value);
          if (!scales) offenders.push(`${file}:${n + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it('the --fs-* tokens are multiplied by the scale', () => {
    for (const name of ['fs-small', 'fs-body', 'fs-section', 'fs-title']) {
      const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(tokensCss);
      expect(m?.[1], name).toContain('--text-scale');
    }
  });
});
