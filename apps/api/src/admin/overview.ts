// The admin overview (SPEC 14.2): what happened in the last 7 / 30 / 90 UTC days, read from the collections the product already keeps -
// `users`, `llm_calls` (the ledger: counts and an estimate, never text), `conversions`, `function_requests`, `events`. Nothing here reads a
// field that could hold a user's data; every number is a count or a sum, and a number we cannot know is `null` (the page says "n/a"), never 0.
import { limits, type AdminDayRow, type AdminModelRow, type AdminOverview } from '@formatai/shared';
import type { AppDb } from '../db.js';
import { dayKey } from '../protection/keys.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The first instant of the UTC day `daysBack` days before `now`'s. */
export function startOfUtcDay(now: Date, daysBack: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysBack));
}

/** USD sums are floats of many tiny numbers: keep six decimals (a thousandth of a cent), which is far below anything shown. */
const usd = (n: number): number => Math.round(n * 1e6) / 1e6;

interface CallGroup {
  _id: { day: string; model: string };
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  priced: number;
}

/** A call's estimated cost is a number (an unpriced model, or a call from before estimates, has none). */
const PRICED = { $in: [{ $type: '$estimate.costUsd' }, ['double', 'int', 'long', 'decimal']] };

export async function buildOverview(db: AppDb, now: Date, days: number): Promise<AdminOverview> {
  const since = startOfUtcDay(now, days - 1);
  const dayList = Array.from({ length: days }, (_, i) => dayKey(new Date(since.getTime() + i * DAY_MS)));
  const threshold = limits.learn.functionRequests.issueThreshold;
  const realCalls = { ts: { $gte: since }, cacheHit: false };

  const [tiers, newUsers, activeUsers, learnRows, cacheLearns, byDayModel, problemRows, formats, formatsNew, ranInPeriod, runs, requestRows, eventRows, localEvents, fallbackCalls] =
    await Promise.all([
      db.users.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$tier', n: { $sum: 1 } } }]).toArray(),
      db.users.countDocuments({ createdAt: { $gte: since } }),
      db.users.countDocuments({ lastSeenAt: { $gte: since } }),
      // One row per learn (all its calls: the first, the repairs, the escalation): verified when a call passed the server's checks,
      // answered when at least one model answered at all.
      db.llmCalls
        .aggregate<{ ai: number; verified: number; answered: number }>([
          { $match: realCalls },
          {
            $group: {
              _id: '$learnId',
              verified: { $max: { $cond: [{ $eq: ['$outcome', 'verified'] }, 1, 0] } },
              answered: { $max: { $cond: [{ $eq: [{ $substrBytes: ['$outcome', 0, 6] }, 'error:'] }, 0, 1] } },
            },
          },
          { $group: { _id: null, ai: { $sum: 1 }, verified: { $sum: '$verified' }, answered: { $sum: '$answered' } } },
        ])
        .toArray(),
      db.llmCalls.countDocuments({ ts: { $gte: since }, cacheHit: true }),
      db.llmCalls
        .aggregate<CallGroup>([
          { $match: realCalls },
          {
            $group: {
              _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$ts', timezone: 'UTC' } }, model: '$model' },
              calls: { $sum: 1 },
              inputTokens: {
                $sum: { $add: [{ $ifNull: ['$estimate.inputTokens', 0] }, { $ifNull: ['$estimate.cachedInputTokens', 0] }, { $ifNull: ['$estimate.cacheWriteTokens', 0] }] },
              },
              outputTokens: { $sum: { $ifNull: ['$estimate.outputTokens', 0] } },
              cost: { $sum: '$estimate.costUsd' },
              priced: { $sum: { $cond: [PRICED, 1, 0] } },
            },
          },
        ])
        .toArray(),
      // The kinds the checks found, summed over the calls' `problemCounts` (counts only, by construction of the ledger).
      db.llmCalls
        .aggregate<{ _id: string; n: number }>([
          { $match: realCalls },
          { $project: { kv: { $objectToArray: { $ifNull: ['$problemCounts', {}] } } } },
          { $unwind: '$kv' },
          { $group: { _id: '$kv.k', n: { $sum: '$kv.v' } } },
          { $match: { n: { $gt: 0 } } },
          { $sort: { n: -1, _id: 1 } },
          { $limit: limits.admin.topProblemKinds },
        ])
        .toArray(),
      db.formats.countDocuments(),
      db.formats.countDocuments({ createdAt: { $gte: since } }),
      db.conversions.countDocuments({ lastRunAt: { $gte: since } }),
      db.conversions.aggregate<{ runs: number }>([{ $group: { _id: null, runs: { $sum: '$runCount' } } }]).toArray(),
      db.functionRequests
        .aggregate<{ groups: number; requests: number; atThreshold: number; issueOpened: number; newInPeriod: number }>([
          {
            $group: {
              _id: null,
              groups: { $sum: 1 },
              requests: { $sum: '$count' },
              atThreshold: { $sum: { $cond: [{ $gte: ['$distinctOwners', threshold] }, 1, 0] } },
              issueOpened: { $sum: { $cond: [{ $eq: ['$status', 'issueOpened'] }, 1, 0] } },
              newInPeriod: { $sum: { $cond: [{ $gte: ['$firstSeen', since] }, 1, 0] } },
            },
          },
        ])
        .toArray(),
      db.events
        .aggregate<{ _id: string; n: number }>([{ $match: { ts: { $gte: since } } }, { $group: { _id: '$type', n: { $sum: 1 } } }, { $sort: { n: -1, _id: 1 } }, { $limit: 50 }])
        .toArray(),
      db.events.countDocuments({ ts: { $gte: since }, type: 'learn_completed', 'props.path': 'local' }),
      // SPEC 9.6: the calls the fallback provider made (they are in the per-model rows under the fallback's own model too).
      db.llmCalls.countDocuments({ ...realCalls, fallback: true }),
    ]);

  const tierCount = (tier: string): number => tiers.find((t) => t._id === tier)?.n ?? 0;
  const registered = tierCount('registered');
  const paid = tierCount('paid');

  const learn = learnRows[0] ?? { ai: 0, verified: 0, answered: 0 };
  // "Free" learns done in the browser leave no ledger row: they are only known from `learn_completed` events, and while none exist the
  // honest answer is "not recorded", not zero.
  const learnEvents = eventRows.find((e) => e._id === 'learn_completed')?.n ?? 0;

  // ---- the model calls: by day and by model ----
  const dayAcc = new Map<string, { calls: number; cost: number; priced: number }>(dayList.map((d) => [d, { calls: 0, cost: 0, priced: 0 }]));
  const modelAcc = new Map<string, { calls: number; inputTokens: number; outputTokens: number; cost: number; priced: number }>();
  for (const g of byDayModel) {
    const day = dayAcc.get(g._id.day);
    // (a call logged a moment after midnight by a clock that disagrees with ours: it belongs to a day we do not list)
    if (day) {
      day.calls += g.calls;
      day.cost += g.cost;
      day.priced += g.priced;
    }
    const m = modelAcc.get(g._id.model) ?? { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0, priced: 0 };
    m.calls += g.calls;
    m.inputTokens += g.inputTokens;
    m.outputTokens += g.outputTokens;
    m.cost += g.cost;
    m.priced += g.priced;
    modelAcc.set(g._id.model, m);
  }
  const byDay: AdminDayRow[] = dayList.map((d) => {
    const a = dayAcc.get(d)!;
    return { day: d, aiCalls: a.calls, costUsd: a.priced > 0 ? usd(a.cost) : null };
  });
  const byModel: AdminModelRow[] = [...modelAcc.entries()]
    .map(([model, m]) => ({
      model,
      calls: m.calls,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      costUsd: m.priced > 0 ? usd(m.cost) : null,
      unpriced: m.calls - m.priced,
    }))
    .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));
  const calls = byModel.reduce((n, m) => n + m.calls, 0);
  const unpriced = byModel.reduce((n, m) => n + m.unpriced, 0);
  const priced = byModel.filter((m) => m.costUsd !== null);

  const requests = requestRows[0] ?? { groups: 0, requests: 0, atThreshold: 0, issueOpened: 0, newInPeriod: 0 };

  return {
    days,
    from: dayList[0]!,
    to: dayList[dayList.length - 1]!,
    users: { total: registered + paid, registered, paid, newInPeriod: newUsers, activeInPeriod: activeUsers },
    learns: {
      ai: learn.ai,
      aiVerified: learn.verified,
      aiFailed: learn.answered - learn.verified,
      aiErrored: learn.ai - learn.answered,
      cache: cacheLearns,
      local: learnEvents > 0 ? localEvents : null,
    },
    conversions: { formats, formatsNew, ranInPeriod, runsAllTime: runs[0]?.runs ?? 0 },
    llm: {
      calls,
      costUsd: priced.length > 0 ? usd(priced.reduce((n, m) => n + (m.costUsd ?? 0), 0)) : null,
      unpriced,
      fallbackCalls,
      byDay,
      byModel,
    },
    problems: problemRows.map((p) => ({ kind: p._id, count: p.n })),
    functionRequests: {
      groups: requests.groups,
      requests: requests.requests,
      atThreshold: requests.atThreshold,
      issueOpened: requests.issueOpened,
      newInPeriod: requests.newInPeriod,
    },
    events: eventRows.map((e) => ({ type: e._id, count: e.n })),
  };
}
