import { describe, expect, it } from 'vitest';
import { limits } from '../src/index';

// SPEC non-negotiable 8: the analysis thresholds live in config (`limits.analysis`). SPEC 6.1, 6.2 and 7.1 quote some of them as numbers;
// this pins the values SPEC states, so a change here is also a change to SPEC (and the other way round).
describe('analysis config', () => {
  const a = limits.analysis;

  it('has the numbers SPEC 6.1 states for the header search', () => {
    expect(a.table.headerScanRows).toBe(15);
    expect(a.table.headerDataRows).toBe(3);
    expect(a.table.minDataRows).toBe(2);
  });

  it('has the numbers SPEC 6.2 states', () => {
    expect(a.sampleRows).toBe(2000);
    expect(a.minCoverage).toBe(0.9);
    expect(a.relations.valueMapMaxEntries).toBe(50);
    expect(a.bands.maxBreakpoints).toBe(5);
    expect(a.bands.minBandRows).toBe(2);
    expect(a.chance).toEqual({ shuffles: 200, maxRate: 0.01, maxRows: 1000 });
    expect(a.pivot.minColumns).toBe(3);
  });

  it('has the number SPEC 7.1 states for an Israeli ID', () => {
    expect(a.profile.israeliIdMinShare).toBe(0.95);
  });

  it('keeps every share between 0 and 1 and every count a positive whole number', () => {
    const walk = (o: unknown, path: string): void => {
      if (typeof o === 'number') {
        const isShare = /(Share|Containment|Coverage|Rate|Slack)$/i.test(path);
        if (isShare) expect(o > 0 && o <= 1, path).toBe(true);
        else expect((Number.isInteger(o) && o > 0) || path.endsWith('.keyMaxSpread'), path).toBe(true);
        return;
      }
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) walk(v, path === '' ? k : `${path}.${k}`);
    };
    walk(a, 'analysis');
  });
});
