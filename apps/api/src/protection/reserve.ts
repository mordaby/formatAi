// SPEC 9.5/11: check the per-tier learn limits BEFORE the LLM is called, and count the learn
// atomically. Each counter is incremented first (`$inc` returns the new total) and rolled back if
// that put it over its limit - so two concurrent requests can never both slip under a limit that
// only has room for one, which a read-then-write check could not promise.
import type { LimitCode } from '@formatai/shared';
import type { LearnCounterSpec } from './keys.js';
import type { ProtectionStore } from './store.js';

export type Reservation = { ok: true } | { ok: false; limitCode: LimitCode };

/**
 * Reserves one learn on every counter in `specs`. If any counter would exceed its limit, every
 * counter this call touched is rolled back and the refusing counter's `limitCode` is returned -
 * nothing is recorded for a refused learn (the `limit_hit` event is not written yet: SPEC 14.1). Throws (after rolling back what it
 * had reserved) if the store fails, so a database outage refuses learns rather than letting them
 * through uncounted.
 */
export async function reserveLearn(store: ProtectionStore, specs: readonly LearnCounterSpec[]): Promise<Reservation> {
  const touched: LearnCounterSpec[] = [];
  let refusedBy: LearnCounterSpec | undefined;

  const rollback = (): Promise<unknown> =>
    Promise.allSettled(touched.map((s) => store.incrementCounter(s.key, -1, s.expiresAt)));

  try {
    for (const spec of specs) {
      const total = await store.incrementCounter(spec.key, 1, spec.expiresAt);
      touched.push(spec);
      if (total > spec.limit && !refusedBy) refusedBy = spec;
    }
  } catch (err) {
    await rollback();
    throw err;
  }

  if (refusedBy) {
    await rollback();
    return { ok: false, limitCode: refusedBy.limitCode };
  }
  return { ok: true };
}
