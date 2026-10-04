// SPEC 11 "Files per run" (21 v11): how many files the Run screen takes at once comes from the tier, in config only.
import { describe, expect, it } from 'vitest';
import { tiers } from '../src/config/tiers';

describe('tiers: files per run', () => {
  it('is 1 for a visitor, 5 for a registered user and 50 for a paid account', () => {
    expect([tiers.anonymous.filesPerRun, tiers.registered.filesPerRun, tiers.paid.filesPerRun]).toEqual([1, 5, 50]);
  });

  it('never goes down from one plan to the next', () => {
    expect(tiers.registered.filesPerRun).toBeGreaterThanOrEqual(tiers.anonymous.filesPerRun);
    expect(tiers.paid.filesPerRun).toBeGreaterThanOrEqual(tiers.registered.filesPerRun);
  });
});
