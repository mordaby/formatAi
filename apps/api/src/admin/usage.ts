// The overview's Usage section (SPEC 14.2; the beta usage events, 14.1): how the product is used, read ONLY from the `events` of the period.
// Counts and distinct user ids - never a prop that could hold a name or a value (the events hold none, by their schemas).
//
// A group whose event type has no row in the period is `null` ("n/a" on the page): the product cannot tell "no one did it" from "nothing was
// recorded" (an older deploy, a browser that blocked the request), so it never shows 0 for it. A signed-in count is of DISTINCT `userId`s: a
// visitor's events carry no id, so they are in the event counts and never in a count of people.
import { limits, type AdminLearnRow, type AdminUsage } from '@formatai/shared';
import type { AppDb } from '../db.js';

const oneDecimal = (n: number): number => Math.round(n * 10) / 10;

/** `$group` rows of `{ _id, n }`, as an object keyed by `_id` (a missing key counts 0 for the caller). */
function byKey(rows: readonly { _id: unknown; n: number }[]): Map<string, number> {
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

export async function buildUsage(db: AppDb, since: Date): Promise<AdminUsage> {
  const inPeriod = (type: string) => ({ type, ts: { $gte: since } });
  const returningAfter = limits.admin.returningAfterDays;

  const [learnRows, matchRows, chosenRows, limitRows, saveRows, runRows, funnelRows] = await Promise.all([
    db.events
      .aggregate<{ _id: { path: string; status: string }; n: number }>([
        { $match: inPeriod('learn_completed') },
        { $group: { _id: { path: '$props.path', status: '$props.status' }, n: { $sum: 1 } } },
      ])
      .toArray(),
    db.events.aggregate<{ _id: string; n: number }>([{ $match: inPeriod('file_matched') }, { $group: { _id: '$props.result', n: { $sum: 1 } } }]).toArray(),
    db.events
      .aggregate<{ asked: number; all: number; offered: number; chosen: number; batch: number }>([
        { $match: inPeriod('formats_chosen') },
        {
          $group: {
            _id: null,
            asked: { $sum: 1 },
            all: { $sum: { $cond: ['$props.all', 1, 0] } },
            offered: { $sum: '$props.offered' },
            chosen: { $sum: '$props.chosen' },
            batch: { $sum: { $cond: ['$props.batch', 1, 0] } },
          },
        },
      ])
      .toArray(),
    db.events
      .aggregate<{ _id: string; n: number }>([{ $match: inPeriod('limit_hit') }, { $group: { _id: '$props.limit', n: { $sum: 1 } } }, { $sort: { n: -1, _id: 1 } }])
      .toArray(),
    db.events.aggregate<{ _id: string; n: number }>([{ $match: inPeriod('format_saved') }, { $group: { _id: '$props.kind', n: { $sum: 1 } } }]).toArray(),
    // One row per signed-in user who ran a format: how many runs, and whether any came `returningAfter` days or more after the format's creation.
    db.events
      .aggregate<{ _id: unknown; runs: number; again: number }>([
        { $match: inPeriod('format_run') },
        { $group: { _id: { $ifNull: ['$userId', null] }, runs: { $sum: 1 }, again: { $max: { $cond: [{ $gte: ['$props.daysSinceCreated', returningAfter] }, 1, 0] } } } },
      ])
      .toArray(),
    // The funnel's steps: one row per (type, user), so a step is "has any row" and "how many distinct users".
    db.events
      .aggregate<{ _id: { type: string; user: unknown } }>([
        { $match: { ts: { $gte: since }, type: { $in: ['file_uploaded', 'learn_completed', 'format_saved', 'format_run'] } } },
        { $group: { _id: { type: '$type', user: { $ifNull: ['$userId', null] } } } },
      ])
      .toArray(),
  ]);

  const learns: AdminLearnRow[] | null =
    learnRows.length === 0
      ? null
      : learnRows.map((r) => ({ path: String(r._id.path), status: String(r._id.status), count: r.n })).sort((a, b) => a.path.localeCompare(b.path) || b.count - a.count || a.status.localeCompare(b.status));

  const match = byKey(matchRows);
  const matching = matchRows.length === 0 ? null : { auto: match.get('auto') ?? 0, choose: match.get('choose') ?? 0, none: match.get('none') ?? 0 };

  const chosen = chosenRows[0];
  const formatsChosen: AdminUsage['formatsChosen'] =
    !chosen || chosen.asked === 0
      ? null
      : {
          asked: chosen.asked,
          allShare: Math.round((chosen.all / chosen.asked) * 100) / 100,
          avgOffered: oneDecimal(chosen.offered / chosen.asked),
          avgChosen: oneDecimal(chosen.chosen / chosen.asked),
          single: chosen.asked - chosen.batch,
          batch: chosen.batch,
        };

  const save = byKey(saveRows);
  const saves = saveRows.length === 0 ? null : { new: save.get('new') ?? 0, anotherInput: save.get('anotherInput') ?? 0, update: save.get('update') ?? 0, edit: save.get('edit') ?? 0 };

  // (a run is always a signed-in user's - the route needs a sign-in - so a row without an id is none we can count as a person)
  const signedIn = runRows.filter((r) => r._id !== null);
  const signedInRuns = signedIn.reduce((n, r) => n + r.runs, 0);
  const returningUsers = signedIn.filter((r) => r.again > 0).length;
  const returning: AdminUsage['returning'] =
    runRows.length === 0
      ? null
      : {
          users: returningUsers,
          runs: signedInRuns,
          activeUsers: signedIn.length,
          runsPerActiveUser: signedIn.length === 0 ? null : oneDecimal(signedInRuns / signedIn.length),
        };

  const step = (type: string): number | null => {
    const rows = funnelRows.filter((r) => r._id.type === type);
    return rows.length === 0 ? null : rows.filter((r) => r._id.user !== null).length;
  };

  return {
    learns,
    matching,
    formatsChosen,
    limits: limitRows.length === 0 ? null : limitRows.map((r) => ({ limit: String(r._id), count: r.n })),
    saves,
    returning,
    funnel: {
      uploaded: step('file_uploaded'),
      learned: step('learn_completed'),
      saved: step('format_saved'),
      ran: step('format_run'),
      ranAgain: runRows.length === 0 ? null : returningUsers,
    },
  };
}
