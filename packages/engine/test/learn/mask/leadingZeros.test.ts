// Amendment 2026-10-06 (SPEC 7.2): leading zeros survive masking. The bug: every value got an unrelated fake, so an ID and the same ID
// padded with zeros ("12345" -> "000012345", or the NUMBER 12345 -> the text "000012345") looked like two different values once masked,
// and the AI step could not see the padding. Now a run of digits is masked as its leading zeros, kept as they are, plus the fake of its
// significant digits: "12345", "012345", "000012345" and 12345 share one fake ("83920", "083920", "000083920", 83920).
import { isIsraeliIdNumber, type PayloadCell } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { createMasker, maskRules, unmaskRules } from '../../../src/learn/mask';
import { buildPayload } from '../../../src/learn/payload';
import { preflight } from '../../../src/learn/preflight';
import { isValidIsraeliId, makeValidIsraeliId } from '../../../src/values/israeliId';
import { analyzeOk, xlsx, type V } from '../analyze/helpers';

const key = (seed: string): Uint8Array => new TextEncoder().encode(seed);

/** An Israeli ID with a leading zero ("0" + 8 digits), one without, and one with two (7 significant digits). */
const ID_ZERO = makeValidIsraeliId('01234567');
const ID_NINE = makeValidIsraeliId('31234500');
const ID_TWO_ZEROS = makeValidIsraeliId('00523456');

describe('masking keeps leading zeros: every form of a value shares one fake', () => {
  it('"12345", "012345", "000012345" and the number 12345 (an ID column): the zeros as they are, then one fake of the significant digits', () => {
    const m = createMasker(key('forms'));
    const f = m.maskCell('12345', 'idLike') as string;
    expect(f).toMatch(/^[1-9][0-9]{4}$/);
    expect(f).not.toBe('12345');
    expect(m.maskCell('012345', 'idLike')).toBe(`0${f}`);
    expect(m.maskCell('000012345', 'idLike')).toBe(`0000${f}`);
    expect(m.maskCell(12345, 'idLike')).toBe(Number(f));
  });

  it('in any order, and the same for the same key (deterministic per session key)', () => {
    const forms: PayloadCell[] = ['000012345', 12345, '012345', '12345'];
    const a = createMasker(key('order'));
    const b = createMasker(key('order'));
    const fromA = forms.map((v) => a.maskCell(v, 'idLike'));
    const fromB = [...forms].reverse().map((v) => b.maskCell(v, 'idLike')).reverse();
    expect(fromB).toEqual(fromA);
    const other = createMasker(key('another key')).maskCell('000012345', 'idLike');
    expect(other).not.toBe(fromA[0]);
    expect(String(other).startsWith('0000')).toBe(true);
  });

  it('a text column and digits inside text get the same fakes as the ID column', () => {
    const m = createMasker(key('text'));
    const f = m.maskCell('12345', 'idLike') as string;
    expect(m.maskCell('000012345', 'text')).toBe(`0000${f}`);
    const sentence = m.maskCell('Ref 000012345 / 12345', 'text') as string;
    expect(sentence).toMatch(new RegExp(`^[A-Z][a-z]{2} 0000${f} / ${f}$`));
    // letters around digits: the zeros are kept, the significant digits masked
    expect(m.maskCell('A-000123', 'idLike')).toMatch(/^[A-Z]-000[1-9][0-9]{2}$/);
  });

  it('a run of zeros only hides nothing and is sent as it is', () => {
    const m = createMasker(key('zeros'));
    expect(m.maskCell('0', 'idLike')).toBe('0');
    expect(m.maskCell('0000', 'idLike')).toBe('0000');
    expect(m.maskCell(0, 'idLike')).toBe(0);
    expect(m.maskCell('Box 00', 'text')).toMatch(/^[A-Z][a-z]{2} 00$/);
  });

  it('over many values and paddings: the zeros in front of the fake are exactly the real ones, digits and length kept', () => {
    const m = createMasker(key('many'));
    for (let n = 1; n < 3000; n += 7) {
      const plain = m.maskIdLike(String(n));
      for (const zeros of ['', '0', '00', '0000']) {
        const real = `${zeros}${n}`;
        const fake = m.maskIdLike(real);
        expect(fake).toHaveLength(real.length);
        expect(fake).toMatch(/^[0-9]+$/);
        expect(fake.slice(0, zeros.length)).toBe(zeros);
        expect(fake[zeros.length]).not.toBe('0');
        expect(fake.slice(zeros.length)).toBe(plain);
      }
    }
  });

  it('numbers in other columns are sent real, as before', () => {
    const m = createMasker(key('other'));
    expect(m.maskCell(12345, 'integer')).toBe(12345);
    expect(m.maskCell('000012345', 'date')).toBe('000012345');
  });
});

describe('Israeli IDs with and without a leading zero', () => {
  it('"0" + 8 digits keeps its zero and stays a valid 9-digit ID; its Excel number (the zero lost, 8 digits) gets the same fake without it', () => {
    expect(ID_ZERO.startsWith('0')).toBe(true);
    for (const seed of ['id-a', 'id-b', 'id-c', 'id-d', 'id-e', 'id-f', 'id-g', 'id-h']) {
      const m = createMasker(key(seed));
      const fakeText = m.maskCell(ID_ZERO, 'idLike') as string;
      expect(fakeText).not.toBe(ID_ZERO);
      expect(fakeText).toMatch(/^0[1-9][0-9]{7}$/);
      expect(isIsraeliIdNumber(fakeText)).toBe(true);

      const fakeNumber = m.maskCell(Number(ID_ZERO), 'idLike');
      expect(typeof fakeNumber).toBe('number');
      expect(String(fakeNumber)).toHaveLength(8);
      expect(isValidIsraeliId(String(fakeNumber))).toBe(true); // a valid ID once padded, like the real number
      expect(`0${fakeNumber}`).toBe(fakeText);

      // inside text: the same fakes, with or without the zero
      expect(m.maskCell(`ת.ז. ${ID_ZERO}`, 'text')).toContain(fakeText);
      expect(m.maskCell(`ID ${Number(ID_ZERO)}`, 'text')).toContain(String(fakeNumber));
    }
  });

  it('an ID without a leading zero stays a valid 9-digit ID and never gains one', () => {
    for (const seed of ['nine-a', 'nine-b', 'nine-c', 'nine-d']) {
      const m = createMasker(key(seed));
      const fake = m.maskCell(Number(ID_NINE), 'idLike') as number;
      expect(String(fake)).toMatch(/^[1-9][0-9]{8}$/);
      expect(isIsraeliIdNumber(String(fake))).toBe(true);
      expect(m.maskCell(ID_NINE, 'idLike')).toBe(String(fake));
    }
  });

  it('two leading zeros (7 significant digits): both kept, a valid ID, and the 7-digit number shares the fake', () => {
    const m = createMasker(key('two-zeros'));
    const fakeText = m.maskCell(ID_TWO_ZEROS, 'idLike') as string;
    expect(fakeText).toMatch(/^00[1-9][0-9]{6}$/);
    expect(isIsraeliIdNumber(fakeText)).toBe(true);
    expect(m.maskCell(Number(ID_TWO_ZEROS), 'idLike')).toBe(Number(fakeText));
  });
});

describe('unmasking: every masked form back to its own real form', () => {
  it('fakeToReal holds each form the masker produced', () => {
    const m = createMasker(key('unmask-map'));
    for (const real of ['12345', '012345', '000012345', ID_ZERO, String(Number(ID_ZERO)), ID_TWO_ZEROS]) {
      const fake = m.maskIdLike(real);
      expect(m.fakeToReal.get(fake)).toBe(real);
    }
    // a number's fake maps back as its digits
    const fakeNumber = m.maskCell(Number(ID_NINE), 'idLike');
    expect(m.fakeToReal.get(String(fakeNumber))).toBe(ID_NINE);
  });

  it('unmaskRules restores text constants of every form, and number constants', () => {
    const m = createMasker(key('unmask-rules'));
    const [f5, f6, f9, fid] = (['12345', '012345', '000012345', ID_ZERO] as const).map((r) => m.maskIdLike(r));
    const fNumber = m.maskCell(12345, 'idLike') as number;
    const fIdNumber = m.maskCell(Number(ID_ZERO), 'idLike') as number;
    const rules = {
      transform: {
        computed: [
          { id: 'a', type: 'boolean', expr: { op: 'oneOf', arg: { col: 'code' }, values: [f5, f6, f9, fNumber] } },
          { id: 'b', type: 'boolean', expr: { op: 'eq', args: [{ col: 'id' }, { const: fIdNumber }] } },
        ],
        valueMaps: [{ column: 'id', map: { [fid!]: 'VIP' }, onMissing: 'flag' }],
      },
      input: { rowFilters: [{ column: 'code', op: 'ne', value: f9 }] },
    };
    const real = unmaskRules(rules, m);
    expect(real.transform.computed[0]!.expr).toEqual({ op: 'oneOf', arg: { col: 'code' }, values: ['12345', '012345', '000012345', 12345] });
    expect(real.transform.computed[1]!.expr).toEqual({ op: 'eq', args: [{ col: 'id' }, { const: Number(ID_ZERO) }] });
    expect(real.transform.valueMaps[0]!.map).toEqual({ [ID_ZERO]: 'VIP' });
    expect(real.input.rowFilters[0]!.value).toBe('000012345');
  });

  it('a number the AI writes for an ID it saw zero-padded ("000083920" -> 83920) unmasks to the real number', () => {
    const m = createMasker(key('padded-only'));
    const fake = m.maskCell('000012345', 'idLike') as string;
    expect(m.realNumberOf(Number(fake))).toBe(12345);
    expect(m.fakeNumberOf(12345)).toBe(Number(fake));
  });

  it('maskRules (a completion call) masks a padded constant like the samples, and unmaskRules restores it', () => {
    const m = createMasker(key('complete'));
    const sampleFake = m.maskCell('000012345', 'idLike');
    const rules = { input: { rowFilters: [{ column: 'code', op: 'eq', value: '000012345' }, { column: 'n', op: 'ne', value: 12345 }] } };
    const masked = maskRules(rules, m);
    expect(masked.input.rowFilters[0]!.value).toBe(sampleFake);
    expect(masked.input.rowFilters[1]!.value).toBe(Number(String(sampleFake).replace(/^0+/, '')));
    expect(unmaskRules(masked, m)).toEqual(rules);
  });
});

// ---------------------------------------------------------------------------
// The payload: IDs stored as numbers, the output padded with zeros (the case the bug hid).
// ---------------------------------------------------------------------------

describe('a masked payload where the padding is visible', () => {
  const NAMES = ['Dana', 'Yossi', 'Noa', 'Omer', 'Maya', 'Avi', 'Tal', 'Gil', 'Rina', 'Eli'];
  /** Israeli IDs stored as numbers (half of them lost their leading zero: 8 digits) and item codes of 3-5 digits stored as numbers. */
  const ids = NAMES.map((_, i) => Number(makeValidIsraeliId(String((i % 2 === 0 ? 1234500 : 31234500) + i * 1117).padStart(8, '0'))));
  const codes = NAMES.map((_, i) => 120 + i * 977);
  const input: V[][] = [['ID', 'Code', 'Name'], ...NAMES.map((n, i) => [ids[i]!, codes[i]!, n])];
  const output: V[][] = [['ID', 'Code', 'Name'], ...NAMES.map((n, i) => [String(ids[i]).padStart(9, '0'), String(codes[i]).padStart(6, '0'), n])];
  const a = analyzeOk(xlsx(input), xlsx(output));
  const { payload } = buildPayload(a, preflight(a, 'paid'), { masker: createMasker(key('payload')) });

  it('the setup: both output columns are the input padded with zeros', () => {
    expect(a.columns[0]!.relations[0]).toMatchObject({ rel: 'padLeft', length: 9, char: '0' });
    expect(a.columns[1]!.relations[0]).toMatchObject({ rel: 'padLeft', length: 6, char: '0' });
    expect(ids.some((id) => String(id).length === 8)).toBe(true);
  });

  it('each sample\'s masked output is its masked input padded with zeros, as the real one is', () => {
    expect(payload.samples).toHaveLength(NAMES.length);
    for (const s of payload.samples) {
      const out = s.out as PayloadCell[];
      expect(typeof s.in[0]).toBe('number');
      expect(typeof s.in[1]).toBe('number');
      expect(out[0]).toBe(String(s.in[0]).padStart(9, '0'));
      expect(out[1]).toBe(String(s.in[1]).padStart(6, '0'));
      expect(isIsraeliIdNumber(out[0] as string)).toBe(true);
    }
  });

  it('no real ID or code is sent', () => {
    const cells = new Set(payload.samples.flatMap((s) => [...s.in, ...(s.out as PayloadCell[])]).map(String));
    for (let i = 0; i < NAMES.length; i++) {
      for (const real of [String(ids[i]), String(ids[i]).padStart(9, '0'), String(codes[i]), String(codes[i]).padStart(6, '0')]) {
        expect(cells.has(real)).toBe(false);
      }
    }
    const json = JSON.stringify(payload);
    for (const id of ids) expect(json).not.toContain(String(id));
  });

  it('a title naming a code without its zeros is masked like the zero-padded cells (not a label word sent real)', () => {
    // every cell holds the codes as zero-padded text ("00" + 5 digits); the title names one without its zeros
    const longCodes = NAMES.map((_, i) => 10200 + i * 977);
    const real = String(longCodes.find((c) => !isValidIsraeliId(String(c))));
    const rows: V[][] = [['Code', 'Name'], ...NAMES.map((n, i) => [String(longCodes[i]).padStart(7, '0'), n])];
    const titled = analyzeOk(xlsx(rows), xlsx([[`Report ${real}`], [], ...rows]));
    expect(titled.layout.titleRows[0]?.text).toBe(`Report ${real}`);
    const m = createMasker(key('title'));
    const sent = buildPayload(titled, preflight(titled, 'paid'), { masker: m }).payload;
    expect(JSON.stringify(sent)).not.toContain(real);
    const fakeCell = m.maskCell(`00${real}`, 'idLike') as string;
    expect(sent.output.layout.titleRows[0]?.text).toBe(`Report ${fakeCell.slice(2)}`);
  });
});
