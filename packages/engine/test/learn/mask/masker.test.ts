import { describe, expect, it } from 'vitest';
import { isValidIsraeliId } from '../../../src/values/israeliId';
import { createMasker } from '../../../src/learn/mask/masker';
import { unmaskRules } from '../../../src/learn/mask/unmaskRules';

function key(seed: string): Uint8Array {
  // Deterministic, arbitrary-length test key (real sessions get one from
  // crypto.getRandomValues; nothing here needs actual randomness).
  return new TextEncoder().encode(seed);
}

const HEBREW_LETTER = /^[א-ת]+$/;
const LATIN_LETTER = /^[A-Za-z]+$/;
const DIGITS_ONLY = /^[0-9]+$/;

describe('createMasker: maskText', () => {
  it('is consistent for the same real word across two "files" and a label string', () => {
    const masker = createMasker(key('session-1'));
    const fakeInFileA = masker.maskText('זקמ עגש');
    const fakeInFileB = masker.maskText('זקמ עגש');
    const fakeInTitle = masker.maskText('דוח זקמ עגש חודשי');
    expect(fakeInFileA).toBe(fakeInFileB);
    expect(fakeInTitle).toContain(fakeInFileA);
  });

  it('preserves script, length and digit positions for a Hebrew word', () => {
    const masker = createMasker(key('shape-hebrew'));
    const real = 'שלומי';
    const fake = masker.maskText(real);
    expect(fake).toHaveLength(real.length);
    expect(HEBREW_LETTER.test(fake)).toBe(true);
    expect(fake).not.toBe(real);
  });

  it('uses a final-form-eligible letter only at the end of a Hebrew word', () => {
    const masker = createMasker(key('shape-hebrew-final'));
    // 60 distinct real words (same prefix, every possible last letter cycled
    // several times) so the fake's last character exercises the full
    // HEBREW_END alphabet, and never a "bare" mid-word form at the end.
    const hebrewLetters = Array.from('אבגדהוזחטיכלמנסעפצקרשת');
    const finals = new Set(['ך', 'ם', 'ן', 'ף', 'ץ']);
    const bases = new Set(['כ', 'מ', 'נ', 'פ', 'צ']);
    let sawFinalAtEnd = false;
    for (let i = 0; i < 60; i++) {
      const lastLetter = hebrewLetters[i % hebrewLetters.length]!;
      const real = `בדיקה${i}` + lastLetter; // distinct word per i (digits + Hebrew: still one word token)
      const fake = masker.maskText(real);
      const last = fake[fake.length - 1]!;
      expect(bases.has(last)).toBe(false); // never a bare base form of the 5 special letters at word end
      if (finals.has(last)) sawFinalAtEnd = true;
    }
    expect(sawFinalAtEnd).toBe(true);
  });

  it('preserves per-character case for Latin words', () => {
    const masker = createMasker(key('shape-latin'));
    const real = 'AbCdEf';
    const fake = masker.maskText(real);
    expect(fake).toHaveLength(real.length);
    for (let i = 0; i < real.length; i++) {
      const r = real[i]!;
      const f = fake[i]!;
      if (r === r.toUpperCase()) expect(f).toBe(f.toUpperCase());
      else expect(f).toBe(f.toLowerCase());
      expect(LATIN_LETTER.test(f)).toBe(true);
    }
  });

  it('keeps digits as digits, letters as letters, within one mixed word', () => {
    const masker = createMasker(key('shape-mixed'));
    const real = 'AB1234cd';
    const fake = masker.maskText(real);
    expect(fake).toHaveLength(real.length);
    expect(/^[A-Z]{2}[0-9]{4}[a-z]{2}$/.test(fake)).toBe(true);
  });

  it('keeps separators (spaces and punctuation) exactly as they were', () => {
    const masker = createMasker(key('separators'));
    const real = "זקמ עגש, מס' 123-45!";
    const fake = masker.maskText(real);
    // Same length, and every non-word character sits at the same position.
    expect(fake).toHaveLength(real.length);
    for (let i = 0; i < real.length; i++) {
      const isWordChar = /[\p{L}\p{Nd}]/u.test(real[i]!);
      if (!isWordChar) expect(fake[i]).toBe(real[i]);
    }
  });

  it('passes registered label words through unchanged, but masks everything else', () => {
    const masker = createMasker(key('labels'), { labelWords: ['דוח', 'סה"כ'] });
    const fake = masker.maskText('דוח זקמ עגש');
    expect(fake.startsWith('דוח ')).toBe(true);
    expect(fake).not.toContain('זקמ');
  });

  it('addLabelWords registers more pass-through words after creation', () => {
    const masker = createMasker(key('labels-2'));
    masker.addLabelWords(['Total']);
    expect(masker.maskText('Total: 5')).toMatch(/^Total: [0-9]$/);
  });

  it('a word masked before being registered as a label word stays masked (consistency wins)', () => {
    const masker = createMasker(key('labels-3'));
    const firstFake = masker.maskText('דוח');
    masker.addLabelWords(['דוח']);
    const secondFake = masker.maskText('דוח');
    expect(secondFake).toBe(firstFake);
  });

  it('round-trips through unmaskRules for Hebrew, English and mixed strings with punctuation and quotes', () => {
    const masker = createMasker(key('roundtrip'));
    const samples = [
      'זקמ עגש',
      'Customer Report',
      "מס' פוליסה: ABC-123, סה\"כ",
      'A1 b2 ג3 ד4!',
    ];
    for (const real of samples) {
      const fake = masker.maskText(real);
      const restored = unmaskRules({ text: fake }, masker).text;
      expect(restored).toBe(real);
    }
  });
});

describe('createMasker: maskIdLike', () => {
  it('turns a valid 9-digit Israeli ID into another valid 9-digit Israeli ID', () => {
    const masker = createMasker(key('id-1'));
    const real = '123456782'; // known-valid id (see values/israeliId.test.ts)
    expect(isValidIsraeliId(real)).toBe(true);
    const fake = masker.maskIdLike(real);
    expect(fake).toHaveLength(real.length);
    expect(DIGITS_ONLY.test(fake)).toBe(true);
    expect(isValidIsraeliId(fake)).toBe(true);
  });

  it('keeps length (and so leading zeros) when the id lost its leading zeros', () => {
    const masker = createMasker(key('id-2'));
    const real = '18'; // pads to 000000018, a known-valid id, with 7 leading zeros lost
    expect(isValidIsraeliId(real)).toBe(true);
    const fake = masker.maskIdLike(real);
    expect(fake).toHaveLength(2);
    expect(isValidIsraeliId(fake)).toBe(true);
  });

  it('is consistent for the same id value across calls', () => {
    const masker = createMasker(key('id-3'));
    const a = masker.maskIdLike('123456782');
    const b = masker.maskIdLike('123456782');
    expect(a).toBe(b);
  });

  it('falls back to digit-by-digit masking for a digit string that is not a valid Israeli id', () => {
    const masker = createMasker(key('id-4'));
    const real = '123456789'; // fails the checksum
    expect(isValidIsraeliId(real)).toBe(false);
    const fake = masker.maskIdLike(real);
    expect(fake).toHaveLength(real.length);
    expect(DIGITS_ONLY.test(fake)).toBe(true);
  });

  it('masks non-digit id-like values as generic text (letters and digits preserved by class)', () => {
    const masker = createMasker(key('id-5'));
    const fake = masker.maskIdLike('A-123456');
    expect(fake).toHaveLength('A-123456'.length);
    expect(/^[A-Za-z]-[0-9]{6}$/.test(fake)).toBe(true);
  });
});

describe('createMasker: maskCell', () => {
  it('masks text and idLike columns only; numbers, dates and booleans pass through real', () => {
    const masker = createMasker(key('cell-1'));
    expect(masker.maskCell('זקמ עגש', 'text')).not.toBe('זקמ עגש');
    expect(masker.maskCell('040217763', 'idLike')).not.toBe('040217763');
    expect(masker.maskCell(1234.5, 'decimal')).toBe(1234.5);
    expect(masker.maskCell(7, 'integer')).toBe(7);
    expect(masker.maskCell('2024-01-01', 'date')).toBe('2024-01-01');
    expect(masker.maskCell(true, 'boolean')).toBe(true);
    expect(masker.maskCell(null, 'text')).toBeNull();
    expect(masker.maskCell(null, 'idLike')).toBeNull();
  });

  it('headers are never run through maskCell at all (columns are metadata, not cell values) -- sanity: passing a header-like string through a numeric type stays real', () => {
    const masker = createMasker(key('cell-2'));
    expect(masker.maskCell('שם לקוח', 'currency')).toBe('שם לקוח');
    expect(masker.maskCell('שם לקוח', 'percent')).toBe('שם לקוח');
  });
});

describe('createMasker: determinism', () => {
  it('the same key produces the same fake for the same word', () => {
    const a = createMasker(key('same-key')).maskText('שלומי כהן');
    const b = createMasker(key('same-key')).maskText('שלומי כהן');
    expect(a).toBe(b);
  });

  it('different keys produce different fakes for the same word', () => {
    const a = createMasker(key('key-one')).maskText('שלומי כהן');
    const b = createMasker(key('key-two')).maskText('שלומי כהן');
    expect(a).not.toBe(b);
  });
});

describe('createMasker: vocabulary sent as it is (SPEC 7.2, learning-loop proposal 7.5)', () => {
  it('a text cell that reads as a date is sent as it is, in any reading or with the shape of one', () => {
    const masker = createMasker(key('dates'));
    for (const d of ['12 במרץ 2026', '2026-03-07', '05/03/2026', '5.3.26', 'March 12, 2026', '12-Mar-2026', 'ינואר 2026', '31/02/2026']) {
      expect(masker.maskCell(d, 'text')).toBe(d);
      expect(masker.maskCell(d, 'idLike')).toBe(d);
    }
    // not a date: a phone number, parts too big for a day or a month
    expect(masker.maskCell('054-123-4567', 'text')).not.toBe('054-123-4567');
    expect(masker.maskCell('45/67/2026', 'text')).not.toBe('45/67/2026');
  });

  it('a placeholder for "no value" is sent as it is when it is the whole cell, case- and space-insensitive', () => {
    const masker = createMasker(key('placeholders'));
    for (const p of ['N/A', 'n/a', ' n / a ', 'NA', 'null', 'None', 'nil', '-', '--', '—', '?', 'אין', 'לא ידוע', 'לא  ידוע', 'ריק']) {
      expect(masker.maskCell(p, 'text')).toBe(p);
    }
    // only the whole cell: next to a name the name is masked, and a real word is not a placeholder
    expect(masker.maskCell('N/A Cohen', 'text')).not.toContain('Cohen');
    expect(masker.maskCell('Nadav', 'text')).not.toBe('Nadav');
  });

  it('month and weekday names are kept inside any text; the words around them are masked', () => {
    const masker = createMasker(key('months'));
    const out = masker.maskText('Order for March from Cohen');
    expect(out).toContain('March');
    expect(out).not.toContain('Cohen');
    expect(masker.maskText('תשלום במרץ לכהן')).toContain('במרץ');
    expect(masker.maskText('דוח ספטמבר')).toContain('ספטמבר');
    expect(masker.maskText('due on Thursday')).toContain('Thursday');
    expect(masker.maskText('נמסר ביום שני בבוקר')).not.toContain('ביום'); // "ביום" is not the weekday name's "יום"
    expect(masker.maskText('יום שני')).toBe('יום שני');
    expect(masker.maskText("יום ה' בערב")).toContain("יום ה'");
    expect(masker.maskText('שבת')).toBe('שבת');
    // "שני" on its own is also a first name: masked
    expect(masker.maskText('שני')).not.toBe('שני');
  });
});
