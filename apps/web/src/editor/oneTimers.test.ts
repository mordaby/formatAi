// Answering a one-time question (SPEC 21 v12 item 20, `oneTimers.ts`) on rules in any state, and the one-time cells in the editor's state:
// one undo step with the rules, never "unsaved changes" on their own (they are never saved).
import type { OneTimeQuestion } from '@formatai/engine';
import type { Expr, LearnResult, Validation } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { applyEdit, createEditorState, markSaved, redo, undo } from './model';
import { answerOneTime, answerRule, answerUnsure, oneTimeState } from './oneTimers';

const tenth: Expr = { op: 'round', arg: { op: 'mul', args: [{ col: 'amount' }, { const: 0.1 }] }, digits: 2 };
const byId: Expr = { op: 'eq', args: [{ col: 'orderId' }, { const: 'ORD-03053' }] };
const check: Validation = { column: 'discount', rule: 'sameAs', expr: tenth, severity: 'flag', oneTime: true };

function rules(expr: Expr): LearnResult {
  return {
    schemaVersion: 1,
    input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'orderId', header: 'Order ID', type: 'text' }, { id: 'amount', header: 'Amount', type: 'decimal' }] },
    transform: { computed: [{ id: 'discount', type: 'decimal', expr }], valueMaps: [], sort: [] },
    output: { sheetName: 'S', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Order ID', from: 'orderId' }, { header: 'Discount', from: 'discount' }] },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}
const learned = rules({ op: 'if', cond: byId, then: { const: 0 }, else: tenth });
const q: OneTimeQuestion = { out: 1, header: 'Discount', part: { kind: 'branch', computed: 'discount', when: byId, then: { const: 0 } }, row: 54, inputRow: 54, by: 'id', byColumn: 'Order ID', key: 'ORD-03053', value: 0, rest: 252.61, check };

describe('the answers', () => {
  it('one-time: the part goes (and the check, if any), and the row joins the one-time cells', () => {
    const out = answerOneTime({ ...learned, validations: [check] }, q, [{ exampleRow: 7, column: 'Discount' }])!;
    expect(out.rules.transform.computed[0]!.expr).toEqual(tenth);
    expect(out.rules.validations).toEqual([]);
    expect(out.oneTime).toEqual([{ exampleRow: 7, column: 'Discount' }, { exampleRow: 54, column: 'Discount' }]);
    expect(answerOneTime(rules(tenth), q, [])).toBeNull();
  });

  it('a rule keeps the rules (without the check); not sure adds the check once; a question with no check adds nothing', () => {
    expect(answerRule(learned, q)).toBe(learned);
    expect(answerRule({ ...learned, validations: [check] }, q).validations).toEqual([]);
    const unsure = answerUnsure(learned, q)!;
    expect(unsure.validations).toEqual([check]);
    expect(answerUnsure(unsure, q)).toBe(unsure);
    expect(answerUnsure(learned, { ...q, check: null })).toBeNull();
  });

  it('where it stands: open; unsure while its check is in; closed once the part is out, the column is empty, or a rule was said', () => {
    expect(oneTimeState(learned, q, false)).toBe('open');
    expect(oneTimeState({ ...learned, validations: [check] }, q, false)).toBe('unsure');
    expect(oneTimeState({ ...learned, validations: [check] }, q, true)).toBe('unsure');
    expect(oneTimeState(learned, q, true)).toBe('closed');
    expect(oneTimeState(rules(tenth), q, false)).toBe('closed');
    expect(oneTimeState({ ...learned, output: { ...learned.output, columns: [learned.output.columns[0]!, { header: 'Discount', from: null }] } }, q, false)).toBe('closed');
  });
});

describe('one-time cells in the editor', () => {
  it('go with the rules in one undo step; undo and redo carry them; they never make the rules "unsaved" by themselves', () => {
    const s0 = createEditorState(learned);
    const out = answerOneTime(learned, q, s0.oneTime)!;
    const { state: s1, result } = applyEdit(s0, { type: 'replaceRules', rules: out.rules, oneTime: out.oneTime });
    expect(result).toEqual({ ok: true, changed: true });
    expect(s1.oneTime).toEqual([{ exampleRow: 54, column: 'Discount' }]);
    expect(s1.history.past).toHaveLength(1);
    const back = undo(s1);
    expect([back.oneTime, back.rules]).toEqual([[], learned]);
    expect(redo(back).oneTime).toEqual([{ exampleRow: 54, column: 'Discount' }]);
    // Saved: the rules are what is saved, the cells stay in the session and the rules are not "unsaved".
    const saved = markSaved(s1);
    expect([saved.dirty, saved.oneTime]).toEqual([false, [{ exampleRow: 54, column: 'Discount' }]]);
    // Only the cells change (the rules as they are): still an edit of its own, but nothing unsaved.
    const { state: s2 } = applyEdit(saved, { type: 'replaceRules', rules: saved.rules, oneTime: [] });
    expect([s2.oneTime, s2.dirty, s2.history.past.length]).toEqual([[], false, 2]);
  });
});
