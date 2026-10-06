// SPEC 9.2 layer 4 / SPEC 21: depth, node budgets after expanding calls, function/table
// counts, table row counts, an acyclic call graph, unique table keys and the rule count
// against the user's tier (SPEC 8.14, 11).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RulesSchema, tiers, type LearnResult } from '@formatai/shared';
import { checkLimits } from '../../src/check/limits';

const here = path.dirname(fileURLToPath(import.meta.url));
const goldenCasesDir = path.join(here, '..', 'golden', 'cases');

function baseRules(overrides: Partial<LearnResult> = {}): LearnResult {
  return {
    schemaVersion: 1,
    input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [] },
    transform: { computed: [], valueMaps: [], sort: [] },
    output: { sheetName: 'Out', direction: 'ltr', language: 'en', titleRows: [], columns: [] },
    validations: [],
    unsupported: [],
    assumptions: [],
    ...overrides,
  };
}

describe('checkLimits: golden rules files pass for the paid tier', () => {
  const caseNames = fs.readdirSync(goldenCasesDir).filter((name) => fs.statSync(path.join(goldenCasesDir, name)).isDirectory());

  it.each(caseNames)('%s', (name) => {
    const json = JSON.parse(fs.readFileSync(path.join(goldenCasesDir, name, 'rules.json'), 'utf8')) as unknown;
    const rules = RulesSchema.parse(json);
    expect(checkLimits(rules, 'paid')).toEqual([]);
  });
});

describe('checkLimits: node budget after expanding function calls', () => {
  // A body with exactly `n` nodes and depth 2 (well within the depth-8 limit, so this
  // test is only ever about the node budget): one variadic `add` over (n - 1) consts.
  function bodyWithNodeCount(n: number) {
    return { op: 'add', args: Array.from({ length: n - 1 }, () => ({ const: 1 })) };
  }

  // One bare call site (a `call` node with no args) costs 1 (the call node) + the
  // inlined body's own node count = 1 + 67 = 68 nodes, every time it's expanded.
  const BODY_NODES = 67;
  const callF = { op: 'call' as const, fn: 'f', args: [] as never[] };

  function rulesChaining(computed: { id: string; type: 'decimal'; expr: unknown }[], outputFrom: string) {
    return baseRules({
      transform: {
        computed: computed as never,
        valueMaps: [],
        sort: [],
        functions: [{ name: 'f', params: [], returns: 'decimal' as const, body: bodyWithNodeCount(BODY_NODES) as never }],
      },
      output: {
        sheetName: 'Out',
        direction: 'ltr',
        language: 'en',
        titleRows: [],
        columns: [{ header: 'Total', from: outputFrom }],
      },
    });
  }

  it('2 calls to the same function, chained into one column, stay within the 200 budget', () => {
    // call0 = call(f) [68 nodes]; call1 = add(call(f), col(call0)) - its own 70 nodes
    // (add + inlined call + the col leaf) plus, via the computed chain, call0's 68 =
    // 138 total: comfortably under 200.
    const rules = rulesChaining(
      [
        { id: 'call0', type: 'decimal', expr: callF },
        { id: 'call1', type: 'decimal', expr: { op: 'add', args: [callF, { col: 'call0' }] } },
      ],
      'call1',
    );
    expect(checkLimits(rules, 'paid')).toEqual([]);
  });

  it('3 calls to the same function, chained into one column, exceed the 200 budget (SPEC 21: "a function used 3 times counts 3x")', () => {
    // Each extra chained call adds another full 68-node inlined body on top of the
    // previous total (138 -> 208): three call sites push the same column over budget,
    // where two did not.
    const rules = rulesChaining(
      [
        { id: 'call0', type: 'decimal', expr: callF },
        { id: 'call1', type: 'decimal', expr: { op: 'add', args: [callF, { col: 'call0' }] } },
        { id: 'call2', type: 'decimal', expr: { op: 'add', args: [callF, { col: 'call1' }] } },
      ],
      'call2',
    );
    const problems = checkLimits(rules, 'paid');
    expect(problems).toContainEqual(expect.objectContaining({ kind: 'limit', path: 'output.columns[0]' }));
  });

  it('reports a limit problem once a column exceeds the node budget', () => {
    // Build a computed expression far past 200 nodes: nested add() calls.
    let expr: unknown = { const: 1 };
    for (let i = 0; i < 210; i++) {
      expr = { op: 'add', args: [expr, { const: 1 }] };
    }
    const rules = baseRules({
      transform: { computed: [{ id: 'big', type: 'decimal', expr: expr as never }], valueMaps: [], sort: [] },
      output: { sheetName: 'Out', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Big', from: 'big' }] },
    });
    const problems = checkLimits(rules, 'paid');
    expect(problems.some((p) => p.path === 'output.columns[0]')).toBe(true);
  });
});

describe('checkLimits: rule counting vs tier (SPEC 8.14/11)', () => {
  function rulesWithNValidations(n: number): LearnResult {
    return baseRules({
      validations: Array.from({ length: n }, (_, i) => ({
        column: `c${i}`,
        rule: 'required' as const,
        severity: 'flag' as const,
      })),
    });
  }

  it('passes when the rule count is within the tier limit', () => {
    const rules = rulesWithNValidations(tiers.registered.rulesPerFormat);
    expect(checkLimits(rules, 'registered')).toEqual([]);
  });

  it('fails when the rule count exceeds the tier limit', () => {
    const rules = rulesWithNValidations(tiers.registered.rulesPerFormat + 1);
    const problems = checkLimits(rules, 'registered');
    expect(problems.some((p) => p.message.includes('rules per format'))).toBe(true);
  });

  it('the same rule count fits comfortably under the paid tier', () => {
    const rules = rulesWithNValidations(tiers.registered.rulesPerFormat + 1);
    expect(checkLimits(rules, 'paid')).toEqual([]);
  });

  it('sort counts as one rule regardless of key count (DECISION)', () => {
    const rules = baseRules({ transform: { computed: [], valueMaps: [], sort: [{ column: 'a', dir: 'asc' }, { column: 'b', dir: 'desc' }] } });
    // Only "sort" (1) counts, not one per key (2) - confirmed indirectly: pushing the
    // tier right up to its limit with validations plus one sort still passes.
    const validations = Array.from({ length: tiers.registered.rulesPerFormat - 1 }, (_, i) => ({
      column: `c${i}`,
      rule: 'required' as const,
      severity: 'flag' as const,
    }));
    rules.validations = validations;
    expect(checkLimits(rules, 'registered')).toEqual([]);
  });

  it('each summaryRows entry counts as one rule (SPEC 21 v4)', () => {
    // 1 (group itself) + 2 output.summaryRows + 1 group.summaryRows = 4 rules besides
    // the validations; fill the rest with validations right up to the tier limit, then
    // one more tips it over.
    const extraRuleCount = 4;
    const makeRules = (validationCount: number): LearnResult =>
      baseRules({
        transform: {
          computed: [],
          valueMaps: [],
          sort: [],
          group: { by: 'a', showDetailRows: true, summaryRows: [{ cells: { a: 'count' } }] },
        },
        output: {
          sheetName: 'Out',
          direction: 'ltr',
          language: 'en',
          titleRows: [],
          columns: [],
          summaryRows: [{ cells: { a: 'count' } }, { cells: { a: 'count' } }],
        },
        validations: Array.from({ length: validationCount }, (_, i) => ({
          column: `c${i}`,
          rule: 'required' as const,
          severity: 'flag' as const,
        })),
      });

    expect(checkLimits(makeRules(tiers.registered.rulesPerFormat - extraRuleCount), 'registered')).toEqual([]);
    const problems = checkLimits(makeRules(tiers.registered.rulesPerFormat - extraRuleCount + 1), 'registered');
    expect(problems.some((p) => p.message.includes('rules per format'))).toBe(true);
  });
});

describe('checkLimits: function/table counts, table rows, duplicate keys, cycles', () => {
  it('reports too many functions', () => {
    const functions = Array.from({ length: 21 }, (_, i) => ({
      name: `f${i}`,
      params: [],
      returns: 'decimal' as const,
      body: { const: 1 },
    }));
    const rules = baseRules({ transform: { computed: [], valueMaps: [], sort: [], functions } });
    expect(checkLimits(rules, 'paid').some((p) => p.path === 'transform.functions')).toBe(true);
  });

  it('reports a table with too many rows', () => {
    const rows = Array.from({ length: 501 }, (_, i) => [`k${i}`, i]);
    const rules = baseRules({ transform: { computed: [], valueMaps: [], sort: [], tables: [{ name: 't', columns: ['k', 'v'], rows }] } });
    expect(checkLimits(rules, 'paid').some((p) => p.path === 'transform.tables[0]')).toBe(true);
  });

  it('reports an input column that reads too many cell texts another way (readAs, SPEC 8.4a)', () => {
    const readAs = (n: number): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, '']));
    const input = (n: number): LearnResult['input'] => ({ sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'a', header: 'A', type: 'decimal', readAs: readAs(n) }] });
    expect(checkLimits(baseRules({ input: input(100) }), 'paid')).toEqual([]);
    const problems = checkLimits(baseRules({ input: input(101) }), 'paid');
    expect(problems.map((p) => p.path)).toEqual(['input.columns[0].readAs']);
  });

  // What one saved format may keep (docs/proposals/saved-format-contents.md section 7): the browser's live check reports the caps the server
  // refuses a save over (shared `contentLimitProblems`).
  it('reports a value map of more than 500 entries, a value of more than 200 characters, and rules over 64 KB', () => {
    const map = (n: number): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, `v${i}`]));
    const withMap = (n: number): LearnResult => baseRules({ transform: { computed: [], valueMaps: [{ column: 'a', map: map(n), onMissing: 'flag' }], sort: [] } });
    expect(checkLimits(withMap(500), 'paid')).toEqual([]);
    expect(checkLimits(withMap(501), 'paid')).toEqual([{ kind: 'limit', path: 'transform.valueMaps[0]', message: 'the value map on "a" has 501 entries, exceeding the maximum of 500' }]);

    const label = (n: number): LearnResult => baseRules({ transform: { computed: [{ id: 'c', type: 'text', expr: { const: 'x'.repeat(n) } }], valueMaps: [], sort: [] } });
    expect(checkLimits(label(200), 'paid')).toEqual([]);
    expect(checkLimits(label(201), 'paid')).toEqual([{ kind: 'limit', path: 'transform.computed[0].expr', message: 'a value of 201 characters, exceeding the maximum of 200 characters for one value' }]);

    // A title row's text (or a summary row's label) is held to 500 characters, not 200.
    const titled = (n: number): LearnResult => baseRules({ output: { sheetName: 'Out', direction: 'ltr', language: 'en', titleRows: [{ text: 't'.repeat(n) }], columns: [] } });
    expect(checkLimits(titled(500), 'paid')).toEqual([]);
    expect(checkLimits(titled(501), 'paid')).toEqual([{ kind: 'limit', path: 'output.titleRows[0]', message: "a title of 501 characters, exceeding the maximum of 500 characters for a title or a summary row's label" }]);

    const rows = Array.from({ length: 480 }, (_, i) => [`key-${i}`, 'v'.repeat(140)]);
    const big = baseRules({ transform: { computed: [], valueMaps: [], sort: [], tables: [{ name: 't', columns: ['k', 'v'], rows }] } });
    expect(checkLimits(big, 'paid').map((p) => p.message)).toEqual([expect.stringMatching(/^the rules take \d+ bytes, exceeding the maximum of 65536 bytes for one format$/)]);
  });

  it('reports a duplicate table key', () => {
    const rules = baseRules({
      transform: { computed: [], valueMaps: [], sort: [], tables: [{ name: 't', columns: ['k', 'v'], rows: [['A', 1], ['A', 2]] }] },
    });
    const problems = checkLimits(rules, 'paid');
    expect(problems.some((p) => p.path === 'transform.tables[0]' && p.message.includes('duplicate key'))).toBe(true);
  });

  it('reports a cyclic call graph (defensive, even though checkRules already prevents it)', () => {
    const rules = baseRules({
      transform: {
        computed: [],
        valueMaps: [],
        sort: [],
        functions: [
          { name: 'a', params: [], returns: 'decimal', body: { op: 'call', fn: 'b', args: [] } },
          { name: 'b', params: [], returns: 'decimal', body: { op: 'call', fn: 'a', args: [] } },
        ],
      },
    });
    expect(checkLimits(rules, 'paid').some((p) => p.path === 'transform.functions' && p.message.includes('cycle'))).toBe(true);
  });

  it('depth: an expression past the configured max depth is reported', () => {
    let expr: unknown = { const: 1 };
    for (let i = 0; i < 10; i++) expr = { op: 'neg', arg: expr };
    const rules = baseRules({ transform: { computed: [{ id: 'c', type: 'decimal', expr: expr as never }], valueMaps: [], sort: [] } });
    expect(checkLimits(rules, 'paid').some((p) => p.path === 'transform.computed[0].expr' && p.message.includes('depth'))).toBe(true);
  });
});
