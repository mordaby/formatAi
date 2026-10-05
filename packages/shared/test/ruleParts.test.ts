// One part of a rule (SPEC 21 v12 item 20, `rules/ruleParts.ts`): found by its content, taken out so the rest of the column's rule applies
// to the row it explained - a branch of an `if` / `switch`, a value of a list, a lookup row, a value-map entry - and the `sameAs` check's
// `oneTime` mark, which "Not sure" keeps.
import { describe, expect, it } from 'vitest';
import { canonicalJson, hasRulePart, withoutRulePart, type RulePart } from '../src/rules/ruleParts';
import { AiValidationSchema, LearnResultSchema, ValidationSchema, type Expr, type LearnResult, type Validation } from '../src/rules/schema';
import { FLAG_MESSAGE_KEYS } from '../src/codes';
import { flagMessages } from '../src/i18n/messages';

const col = (id: string): Expr => ({ col: id });
const c = (v: string | number): Expr => ({ const: v });
const eq = (a: Expr, b: Expr): Expr => ({ op: 'eq', args: [a, b] });
const tenth: Expr = { op: 'round', arg: { op: 'mul', args: [col('amount'), c(0.1)] }, digits: 2 };

function rules(expr: Expr, extra: Partial<LearnResult['transform']> = {}): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'order', header: 'Order', type: 'text' },
        { id: 'status', header: 'Status', type: 'text' },
        { id: 'amount', header: 'Amount', type: 'decimal' },
      ],
    },
    transform: { computed: [{ id: 'discount', type: 'decimal', expr }], valueMaps: [], sort: [], ...extra },
    output: { sheetName: 'S', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Order', from: 'order' }, { header: 'Discount', from: 'discount' }] },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}
const exprOf = (r: LearnResult | null): Expr | undefined => r?.transform.computed.find((x) => x.id === 'discount')?.expr;

describe('withoutRulePart: a branch', () => {
  const a = eq(col('order'), c('ORD-1'));
  const b = eq(col('order'), c('ORD-2'));
  const part = (when: Expr, then: Expr): RulePart => ({ kind: 'branch', computed: 'discount', when, then });

  it('an if is replaced by its else; a nested one is found too, and the chain stays', () => {
    const chain: Expr = { op: 'if', cond: a, then: c(0), else: { op: 'if', cond: b, then: c(5), else: tenth } };
    expect(exprOf(withoutRulePart(rules(chain), part(a, c(0))))).toEqual({ op: 'if', cond: b, then: c(5), else: tenth });
    expect(exprOf(withoutRulePart(rules(chain), part(b, c(5))))).toEqual({ op: 'if', cond: a, then: c(0), else: tenth });
    // Both, in either order: a part is said by its content, never by where it was.
    const both = withoutRulePart(withoutRulePart(rules(chain), part(b, c(5)))!, part(a, c(0)));
    expect(exprOf(both)).toEqual(tenth);
  });

  it('a switch loses the case; one left without cases is its else; inside another expression too', () => {
    const sw: Expr = { op: 'switch', cases: [{ when: a, then: c(0) }, { when: b, then: c(5) }], else: tenth };
    expect(exprOf(withoutRulePart(rules(sw), part(a, c(0))))).toEqual({ op: 'switch', cases: [{ when: b, then: c(5) }], else: tenth });
    const one: Expr = { op: 'round', arg: { op: 'switch', cases: [{ when: a, then: c(0) }], else: tenth }, digits: 2 };
    expect(exprOf(withoutRulePart(rules(one), part(a, c(0))))).toEqual({ op: 'round', arg: tenth, digits: 2 });
  });

  it('keys in another order are the same part; another value, another condition or another column is not there (null)', () => {
    const r = rules({ op: 'if', cond: a, then: c(0), else: tenth });
    const reordered = JSON.parse(JSON.stringify({ args: [col('order'), c('ORD-1')], op: 'eq' })) as Expr;
    expect(hasRulePart(r, part(reordered, c(0)))).toBe(true);
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(withoutRulePart(r, part(a, c(1)))).toBeNull();
    expect(withoutRulePart(r, part(b, c(0)))).toBeNull();
    expect(withoutRulePart(r, { kind: 'branch', computed: 'other', when: a, then: c(0) })).toBeNull();
    // Nothing else of the rules changes.
    const out = withoutRulePart(r, part(a, c(0)))!;
    expect({ ...out, transform: { ...out.transform, computed: [] } }).toEqual({ ...r, transform: { ...r.transform, computed: [] } });
  });
});

describe('withoutRulePart: a value of a list, a lookup row, a value-map entry', () => {
  it('a oneOf loses the value; an or-chain of = loses its comparison (one left is that comparison)', () => {
    const list: Expr = { op: 'if', cond: { op: 'oneOf', arg: col('order'), values: ['ORD-1', 'ORD-2'] }, then: c(0), else: tenth };
    const value = (v: string): RulePart => ({ kind: 'listValue', computed: 'discount', arg: col('order'), value: v });
    expect(exprOf(withoutRulePart(rules(list), value('ORD-2')))).toEqual({ op: 'if', cond: { op: 'oneOf', arg: col('order'), values: ['ORD-1'] }, then: c(0), else: tenth });
    const or: Expr = { op: 'if', cond: { op: 'or', args: [eq(col('order'), c('ORD-1')), eq(c('ORD-2'), col('order'))] }, then: c(0), else: tenth };
    expect(exprOf(withoutRulePart(rules(or), value('ORD-2')))).toEqual({ op: 'if', cond: eq(col('order'), c('ORD-1')), then: c(0), else: tenth });
    expect(withoutRulePart(rules(or), value('ORD-3'))).toBeNull();
  });

  it('a lookup table loses the row with that key; a value map loses the entry', () => {
    const lookup: Expr = { op: 'coalesce', args: [{ op: 'lookup', table: 't', key: col('order'), return: 'd', onMissing: 'empty' }, tenth] };
    const r = rules(lookup, { tables: [{ name: 't', columns: ['order', 'd'], rows: [['ORD-1', 0], ['ORD-2', 5]] }] });
    expect(withoutRulePart(r, { kind: 'lookupEntry', table: 't', key: 'ORD-1' })?.transform.tables).toEqual([{ name: 't', columns: ['order', 'd'], rows: [['ORD-2', 5]] }]);
    expect(withoutRulePart(r, { kind: 'lookupEntry', table: 't', key: 'ORD-9' })).toBeNull();
    const mapped = rules(tenth, { valueMaps: [{ column: 'status', map: { A: 'Active', X: 'Closed' }, onMissing: 'keep' }] });
    expect(withoutRulePart(mapped, { kind: 'valueMapEntry', column: 'status', from: 'X' })?.transform.valueMaps).toEqual([{ column: 'status', map: { A: 'Active' }, onMissing: 'keep' }]);
    expect(hasRulePart(mapped, { kind: 'valueMapEntry', column: 'status', from: 'Y' })).toBe(false);
  });
});

describe('the sameAs check of "Not sure" (oneTime)', () => {
  const check: Validation = { column: 'discount', rule: 'sameAs', expr: tenth, severity: 'flag', oneTime: true };

  it('is a stored sameAs with an optional mark - old files load unchanged, the AI step can write neither', () => {
    expect(ValidationSchema.safeParse(check).success).toBe(true);
    expect(LearnResultSchema.safeParse({ ...rules(tenth), validations: [check] }).success).toBe(true);
    expect(ValidationSchema.safeParse({ ...check, oneTime: false }).success).toBe(false);
    expect(AiValidationSchema.safeParse(check).success).toBe(false);
  });

  it('has its own flag message, in both languages', () => {
    expect(FLAG_MESSAGE_KEYS).toContain('flag.validation.sameAs.oneTime');
    expect(flagMessages['flag.validation.sameAs.oneTime'].en).toContain('{other}');
    expect(flagMessages['flag.validation.sameAs.oneTime'].he).toContain('{other}');
  });
});
