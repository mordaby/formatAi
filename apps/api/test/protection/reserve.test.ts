import { describe, expect, it } from 'vitest';
import type { LearnCounterSpec } from '../../src/protection/keys.js';
import { reserveLearn } from '../../src/protection/reserve.js';
import { createMemoryStore, type ProtectionStore } from '../../src/protection/store.js';

const expiresAt = new Date(Date.now() + 24 * 3_600_000);
const specs = (limitA: number, limitB: number): LearnCounterSpec[] => [
  { key: 'anon:A:d', limit: limitA, expiresAt, limitCode: 'learnsPerDay' },
  { key: 'ip:B:d', limit: limitB, expiresAt, limitCode: 'learnsPerDay' },
];

describe('reserveLearn (SPEC 9.5: check before the LLM, count atomically)', () => {
  it('counts one learn on every counter while under the limits', async () => {
    const store = createMemoryStore();
    expect(await reserveLearn(store, specs(2, 2))).toEqual({ ok: true });
    expect(store.counter('anon:A:d')).toBe(1);
    expect(store.counter('ip:B:d')).toBe(1);
  });

  it('refuses the learn over a limit and leaves every counter exactly as it was', async () => {
    const store = createMemoryStore();
    await reserveLearn(store, specs(2, 5));
    await reserveLearn(store, specs(2, 5));
    const third = await reserveLearn(store, specs(2, 5));
    expect(third).toEqual({ ok: false, limitCode: 'learnsPerDay' });
    expect(store.counter('anon:A:d')).toBe(2);
    expect(store.counter('ip:B:d')).toBe(2);
  });

  it('refuses when either counter is full', async () => {
    const store = createMemoryStore();
    await reserveLearn(store, specs(5, 1));
    expect((await reserveLearn(store, specs(5, 1))).ok).toBe(false);
    expect(store.counter('anon:A:d')).toBe(1);
  });

  it('never lets concurrent learns slip past a limit with room for one', async () => {
    const store = createMemoryStore();
    const results = await Promise.all(Array.from({ length: 10 }, () => reserveLearn(store, specs(3, 3))));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(store.counter('anon:A:d')).toBe(3);
  });

  it('rolls back what it had reserved, and rethrows, when the store fails midway', async () => {
    const inner = createMemoryStore();
    let calls = 0;
    const flaky: ProtectionStore = {
      ...inner,
      incrementCounter: async (key, by, expiresAt) => {
        calls += 1;
        if (calls === 2) throw new Error('db down');
        return inner.incrementCounter(key, by, expiresAt);
      },
    };
    await expect(reserveLearn(flaky, specs(2, 2))).rejects.toThrow('db down');
    expect(inner.counter('anon:A:d')).toBe(0);
  });
});
