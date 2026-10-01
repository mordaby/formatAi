// SPEC 8.3: "Every operation declares its argument and result types ... The signature
// table ... is the single source for the type checker, the editor and the prompt."
import { describe, expect, it } from 'vitest';
import {
  fits,
  INTEGER_PRESERVING_OPS,
  OP_SIGNATURES,
  unify,
  widensTo,
  type SigOp,
} from '../../src/check/signatures';

describe('widensTo / fits (SPEC 8.3 widening lattice)', () => {
  it('is reflexive: every type widens to itself', () => {
    expect(widensTo('text', 'text')).toBe(true);
    expect(widensTo('decimal', 'decimal')).toBe(true);
    expect(widensTo('date', 'date')).toBe(true);
    expect(widensTo('boolean', 'boolean')).toBe(true);
  });

  it('allows exactly the two implicit widenings', () => {
    expect(widensTo('integer', 'decimal')).toBe(true);
    expect(widensTo('idLike', 'text')).toBe(true);
  });

  it('rejects every other conversion', () => {
    expect(widensTo('decimal', 'integer')).toBe(false);
    expect(widensTo('text', 'idLike')).toBe(false);
    expect(widensTo('text', 'decimal')).toBe(false);
    expect(widensTo('date', 'text')).toBe(false);
    expect(widensTo('boolean', 'text')).toBe(false);
  });

  it("'any' fits every type", () => {
    for (const t of ['text', 'idLike', 'integer', 'decimal', 'date', 'boolean'] as const) {
      expect(fits(t, 'any')).toBe(true);
    }
  });
});

describe('unify (branches / same-kind comparisons)', () => {
  it('a single type unifies with itself', () => {
    expect(unify(['decimal'])).toBe('decimal');
    expect(unify(['integer'])).toBe('integer');
  });

  it('integer + decimal unify to decimal', () => {
    expect(unify(['integer', 'decimal'])).toBe('decimal');
    expect(unify(['decimal', 'integer'])).toBe('decimal');
  });

  it('idLike + text unify to text', () => {
    expect(unify(['idLike', 'text'])).toBe('text');
  });

  it('unrelated types do not unify', () => {
    expect(unify(['text', 'date'])).toBeUndefined();
    expect(unify(['boolean', 'decimal'])).toBeUndefined();
    expect(unify(['idLike', 'integer'])).toBeUndefined();
  });

  it('empty input has no unified type', () => {
    expect(unify([])).toBeUndefined();
  });
});

describe('OP_SIGNATURES: representative entries', () => {
  it('covers every Expr op exactly once', () => {
    const ops = Object.keys(OP_SIGNATURES) as SigOp[];
    expect(new Set(ops).size).toBe(ops.length);
    expect(ops).toContain('add');
    expect(ops).toContain('lookup');
    expect(ops).toContain('not');
    expect(ops.length).toBe(56);
  });

  it('mul takes variadic decimal-ish args', () => {
    expect(OP_SIGNATURES.mul.args).toEqual({ shape: 'variadicSameType', type: 'decimal', min: 1 });
  });

  it('div always returns decimal (not integer-preserving)', () => {
    expect(OP_SIGNATURES.div.result).toEqual({ kind: 'fixed', type: 'decimal' });
  });

  it('length returns integer, other text ops return text', () => {
    expect(OP_SIGNATURES.length.result).toEqual({ kind: 'fixed', type: 'integer' });
    expect(OP_SIGNATURES.concat.result).toEqual({ kind: 'fixed', type: 'text' });
    expect(OP_SIGNATURES.upper.result).toEqual({ kind: 'fixed', type: 'text' });
  });

  it('datePart/dateDiff return integer; dateAdd/endOfMonth return date', () => {
    expect(OP_SIGNATURES.datePart.result).toEqual({ kind: 'fixed', type: 'integer' });
    expect(OP_SIGNATURES.dateDiff.result).toEqual({ kind: 'fixed', type: 'integer' });
    expect(OP_SIGNATURES.dateAdd.result).toEqual({ kind: 'fixed', type: 'date' });
    expect(OP_SIGNATURES.endOfMonth.result).toEqual({ kind: 'fixed', type: 'date' });
  });

  it('toNumber returns decimal, toText returns text and accepts any', () => {
    expect(OP_SIGNATURES.toNumber.result).toEqual({ kind: 'fixed', type: 'decimal' });
    expect(OP_SIGNATURES.toText.result).toEqual({ kind: 'fixed', type: 'text' });
    expect(OP_SIGNATURES.toText.args).toEqual({ shape: 'unary', type: 'any' });
  });

  it('all condition ops return boolean (SPEC 8.3: "conditions -> boolean")', () => {
    for (const op of ['isEmpty', 'notEmpty', 'oneOf', 'startsWith', 'endsWith', 'contains', 'and', 'or', 'not'] as const) {
      expect(OP_SIGNATURES[op].result).toEqual({ kind: 'fixed', type: 'boolean' });
    }
    for (const op of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const) {
      expect(OP_SIGNATURES[op].result).toEqual({ kind: 'boolean' });
    }
  });

  it('if/switch/coalesce unify their branches', () => {
    expect(OP_SIGNATURES.if.result).toEqual({ kind: 'unify' });
    expect(OP_SIGNATURES.switch.result).toEqual({ kind: 'unify' });
    expect(OP_SIGNATURES.coalesce.result).toEqual({ kind: 'unify' });
  });

  it('lookup/call are dynamic (resolved against the rules file, not this table)', () => {
    expect(OP_SIGNATURES.lookup.result).toEqual({ kind: 'dynamic' });
    expect(OP_SIGNATURES.call.result).toEqual({ kind: 'dynamic' });
  });
});

describe('INTEGER_PRESERVING_OPS (SPEC 8.3/LEARN_PROMPT: "arithmetic → decimal, integer '
  + 'when all args integer and the op is add, sub, mul, mod, min or max")', () => {
  it('is exactly {add, sub, mul, mod, min, max}', () => {
    expect(INTEGER_PRESERVING_OPS).toEqual(new Set(['add', 'sub', 'mul', 'mod', 'min', 'max']));
  });

  it('excludes div, neg, abs, floor, ceil, round (always decimal, even given only integer args)', () => {
    for (const op of ['div', 'neg', 'abs', 'floor', 'ceil', 'round'] as const) {
      expect(INTEGER_PRESERVING_OPS.has(op)).toBe(false);
      expect(OP_SIGNATURES[op].result).toEqual({ kind: 'fixed', type: 'decimal' });
    }
  });
});
