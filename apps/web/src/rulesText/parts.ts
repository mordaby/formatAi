// Small builders for `Part` lists and the template filler the phrase files use.
import type { Part, SimplePart } from './types';

export const txt = (text: string): SimplePart => ({ kind: 'text', text });
export const nm = (text: string): SimplePart => ({ kind: 'name', text });
export const val = (text: string): SimplePart => ({ kind: 'value', text });
export const arrow = (): Part => ({ kind: 'arrow', text: '←' });

export const quoted = (s: string): string => `'${s}'`;

export function partsText(parts: readonly Part[]): string {
  let out = '';
  for (const p of parts) out += p.text;
  return out;
}

/** Drops empty parts and merges neighbouring plain-text parts. */
export function normalize(parts: readonly Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    if (p.text === '') continue;
    const last = out[out.length - 1];
    if (p.kind === 'text' && last && last.kind === 'text') {
      out[out.length - 1] = { kind: 'text', text: last.text + p.text };
    } else {
      out.push(p);
    }
  }
  return out;
}

/** What a template placeholder can be filled with. A plain string becomes a text part. */
export type Arg = string | Part | readonly Part[];

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Fills `{name}` placeholders. A missing argument renders as nothing (a phrase bug must never
 * crash the rules map); `phrases.test.ts` checks that both languages use the same placeholders.
 */
export function fill(template: string, args: Readonly<Record<string, Arg>>): Part[] {
  const out: Part[] = [];
  let last = 0;
  for (const m of template.matchAll(PLACEHOLDER)) {
    const at = m.index ?? 0;
    if (at > last) out.push(txt(template.slice(last, at)));
    const arg = args[m[1] ?? ''];
    if (typeof arg === 'string') out.push(txt(arg));
    else if (arg !== undefined) {
      if (isPartArray(arg)) out.push(...arg);
      else out.push(arg);
    }
    last = at + m[0].length;
  }
  if (last < template.length) out.push(txt(template.slice(last)));
  return normalize(out);
}

function isPartArray(arg: Part | readonly Part[]): arg is readonly Part[] {
  return Array.isArray(arg);
}

/** Places `sep` between the items. */
export function joinWith(items: readonly (readonly Part[])[], sep: string): Part[] {
  const out: Part[] = [];
  items.forEach((item, i) => {
    if (i > 0) out.push(txt(sep));
    out.push(...item);
  });
  return normalize(out);
}
