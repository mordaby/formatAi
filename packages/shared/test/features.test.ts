// Feature switches (owner decision 2026-10-07, config/features.ts): "Formats with several sources" is off for the MVP; the API's
// environment value is read with `featureSwitchOf` (on / off, any case; unset is the default; anything else is null - a production
// start refuses it). The source limit the web app shows up front is the API's own count (`canAddSource`).
import { describe, expect, it } from 'vitest';
import { canAddSource, features, featureSwitchOf } from '../src/index';

describe('feature switches', () => {
  it('"Formats with several sources" is off by default', () => {
    expect(features.formatSources).toBe(false);
  });

  it('reads on / off in any case, unset or empty as the default, and anything else as null', () => {
    expect(featureSwitchOf(undefined, false)).toBe(false);
    expect(featureSwitchOf('  ', true)).toBe(true);
    expect(featureSwitchOf('on', false)).toBe(true);
    expect(featureSwitchOf(' OFF ', true)).toBe(false);
    for (const typo of ['true', '1', 'yes', 'onn']) expect(featureSwitchOf(typo, false)).toBeNull();
  });
});

describe('sources per format (SPEC 11)', () => {
  it('a registered user adds up to 3, a paid one any number, a visitor none', () => {
    expect([0, 1, 2].map((n) => canAddSource('registered', n))).toEqual([true, true, true]);
    expect(canAddSource('registered', 3)).toBe(false);
    expect(canAddSource('paid', 500)).toBe(true);
    expect(canAddSource('anonymous', 0)).toBe(false);
  });
});
