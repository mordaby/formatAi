// The round for a list (docs/proposals/saved-format-contents.md section 4) may be answered with AI code checks (learn-v9): the worker then
// answers them on every row before the round is sent again, like the learn's own rounds. Its progress says so - which round of checks it
// is - and that is what grants the learn the time a round of checks takes (`checkRoundAllowance`, C4 of the 2026-10-07 audit): without it
// the work counted toward the learn's timeout as if the worker hung. The engine's learn is replaced here by one that makes the two calls of
// such a round; the worker method around it is the real one.
import type { LearnPayload, LearnResult } from '@formatai/shared';
import { describe, expect, it, vi } from 'vitest';
import type { LearnOutput, LearnProgress } from '../src/worker/engineApi';
import { engineMethods } from '../src/worker/engineMethods';
import { loopback } from './helpers/loopback';

const { learnFromExamples } = vi.hoisted(() => ({ learnFromExamples: vi.fn() }));
vi.mock('@formatai/engine', async (orig) => ({ ...(await orig<typeof import('@formatai/engine')>()), learnFromExamples }));

const PAYLOAD = { masking: false, output: { columns: [] }, samples: [] } as unknown as LearnPayload;
const RULES = { schemaVersion: 1 } as unknown as LearnResult;
const LIST = [{ kind: 'list', out: 1, message: 'Column "B" is a list of 30 fixed values.' }];
const ROUND = { checks: [{ check: 'values', column: 'B' }], answers: [{ rows: 3, distinct: 2, empty: 0, top: [] }] };

describe('the round for a list, answered with checks', () => {
  it('says which round of checks the worker is answering, right after the answer asked them (and then the round goes again)', async () => {
    learnFromExamples.mockImplementation(async (opts: { callRepair: (...a: unknown[]) => Promise<unknown> }) => {
      await opts.callRepair(PAYLOAD, RULES, LIST, { round: 2, maxRounds: 3, rows: [], newRows: 0, list: true });
      await opts.callRepair(PAYLOAD, RULES, LIST, { round: 3, maxRounds: 3, rows: [], newRows: 0, list: true, checks: [ROUND] });
      return { path: 'llm', rules: null, preflight: { status: 'ok', issues: [], skipColumns: [] }, verification: null, assumptions: [], unsupported: [], calls: [], stages: {} };
    });
    const answers = [
      { rules: null, problems: [], calls: [], checks: ROUND.checks }, // checks instead of the rules
      { rules: RULES, problems: [], calls: [] },
    ];
    const callRepair = vi.fn(async () => answers.shift());
    const seen: LearnProgress[] = [];
    const client = loopback(engineMethods);
    const bytes = new TextEncoder().encode('a\n1\n').buffer as ArrayBuffer;
    await client.call<LearnOutput>(
      'learn',
      { input: { name: 'in.csv', bytes: bytes.slice(0) }, output: { name: 'out.csv', bytes: bytes.slice(0) }, masking: false, tier: 'paid' },
      { host: { callLearn: vi.fn(), callRepair, callStep: vi.fn() }, onProgress: (p) => seen.push(p as LearnProgress) },
    );
    expect(callRepair).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([
      { phase: 'reading' },
      { phase: 'learning', attempt: 'repair', round: { n: 2, of: 3, rows: 0, list: true } },
      { phase: 'learning', attempt: 'repair', round: { n: 2, of: 3, rows: 0, list: true }, checkRound: { n: 1, of: 3 } },
      { phase: 'learning', attempt: 'repair', round: { n: 3, of: 3, rows: 0, list: true } },
      { phase: 'verifying' },
    ]);
  });
});
