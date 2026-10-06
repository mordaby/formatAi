// Identifier-shaped values (docs/proposals/saved-format-contents.md section 5; `identifiers.ts`): the five shapes code recognizes with
// certainty - an Israeli ID (check digit), a phone (a numbering plan), an email, a card (issuer and Luhn), an IBAN (mod-97), each checked by
// validator.js since the column classification (owner, 2026-10-06) - and, as decided by the owner, NO digit-run rule: a ledger account, an
// item code or a barcode used as a label is never one of them.
import isLuhnNumber from 'validator/lib/isLuhnNumber.js';
import { describe, expect, it } from 'vitest';
import {
  identifierKindOf,
  identifierShapeOf,
  isCardNumber,
  isEmailAddress,
  isIban,
  isIsraeliIdNumber,
  isPhoneNumber,
  isValidIsraeliId,
} from '../src/identifiers';

const luhnValid = (digits: string): boolean => isLuhnNumber(digits);

describe('an Israeli ID number', () => {
  it('9 digits with a valid check digit', () => {
    expect(isIsraeliIdNumber('123456782')).toBe(true);
    expect(isIsraeliIdNumber('039337423')).toBe(true);
    expect(identifierKindOf('123456782')).toBe('israeliId');
    // Stored as a number (9 digits) it is the same ID.
    expect(identifierKindOf(123456782)).toBe('israeliId');
  });

  it('NOT a 9-digit code that fails the check digit, an 8-digit code, all zeros, or a longer run', () => {
    expect(isIsraeliIdNumber('123456789')).toBe(false);
    expect(identifierKindOf('123456789')).toBeNull();
    expect(identifierKindOf(123456789)).toBeNull();
    // 8 digits: an ID with its leading zero lost looks like any code - the padding check (`isValidIsraeliId`) is not used for saved values.
    expect(isValidIsraeliId('12345674')).toBe(true);
    expect(isIsraeliIdNumber('12345674')).toBe(false);
    expect(identifierKindOf('12345674')).toBeNull();
    expect(isIsraeliIdNumber('000000000')).toBe(false);
    expect(isIsraeliIdNumber('1234567820')).toBe(false);
  });
});

describe('no digit-run rule: ledger accounts, item codes and barcodes are labels', () => {
  it.each(['61000100', '61000200', '40000000', '1234567', '20261006', '7290000123457', '9780306406157', 'SKU-1234567890', 61000100, 1000, 2026])(
    '%s is not an identifier',
    (v) => {
      expect(identifierKindOf(v)).toBeNull();
    },
  );
});

describe('a phone number', () => {
  it.each(['050-1234567', '0501234567', '052 123 4567', '03-1234567', '031234567', '(03) 123-4567', '077-2123456', '+972-50-123-4567', '+972501234567', '+1 (212) 555-0123', '+44 7911 123456'])(
    '%s is a phone',
    (v) => {
      expect(isPhoneNumber(v)).toBe(true);
      expect(identifierKindOf(v)).toBe('phone');
    },
  );

  it.each(['1234567890', '0601234567', '01-1234567', '+0501234567', '+12345', '05012345', 'call 05'])('%s is not', (v) => {
    expect(isPhoneNumber(v)).toBe(false);
  });

  // DECISION (column classification, 2026-10-06): validator's plans, not our own pattern. Its Israeli plan has 077 among the 07x numbers, and
  // abroad it knows mobile plans only; libphonenumber-js knows every plan but adds about 120 KB to each bundle (the report has the numbers).
  it.each(['072-2123456', '+44 20 7946 0958'])('%s (an Israeli VoIP number other than 077, a landline abroad) is no longer recognized', (v) => {
    expect(isPhoneNumber(v)).toBe(false);
  });

  it('a phone stored as a number has lost its leading zero: not recognized', () => {
    expect(identifierKindOf(501234567)).toBeNull();
  });
});

describe('an email address', () => {
  it('the usual shape, alone or inside a label', () => {
    expect(isEmailAddress('dana.cohen@example.co.il')).toBe(true);
    expect(identifierKindOf('dana.cohen@example.co.il')).toBe('email');
    expect(identifierKindOf('Write to dana@example.com please')).toBe('email');
  });

  it.each(['dana@example', 'a @b.com', '@example.com', 'dana@', 'user at example.com'])('%s is not', (v) => {
    expect(isEmailAddress(v)).toBe(false);
    expect(identifierKindOf(v)).toBeNull();
  });
});

describe('a card number (Luhn)', () => {
  it('13-19 digits, Luhn-valid, starting with 2-6, spaces or dashes allowed', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(isCardNumber('4111111111111111')).toBe(true);
    expect(isCardNumber('4111 1111 1111 1111')).toBe(true);
    expect(isCardNumber('5500-0000-0000-0004')).toBe(true);
    expect(isCardNumber('378282246310005')).toBe(true);
    expect(identifierKindOf('4111 1111 1111 1111')).toBe('card');
    expect(identifierKindOf(4111111111111111)).toBe('card');
  });

  it('NOT one digit off (Luhn fails), too short, too long, all zeros, or a barcode (starts with 7-9)', () => {
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(isCardNumber('4111111111111112')).toBe(false);
    expect(isCardNumber('411111111111')).toBe(false);
    expect(isCardNumber('41111111111111111111')).toBe(false);
    expect(isCardNumber('0000000000000000')).toBe(false);
    // An EAN-13 barcode that happens to pass Luhn: 7290000000018 does, and it is still not a card.
    expect(luhnValid('7290000000018')).toBe(true);
    expect(isCardNumber('7290000000018')).toBe(false);
  });
});

describe('an IBAN (mod-97)', () => {
  it('a country code, check digits and the account, with or without spaces', () => {
    expect(isIban('IL620108000000099999999')).toBe(true);
    expect(isIban('IL62 0108 0000 0009 9999 999')).toBe(true);
    expect(isIban('GB82WEST12345698765432')).toBe(true);
    expect(identifierKindOf('IL62 0108 0000 0009 9999 999')).toBe('iban');
    expect(identifierKindOf('account IL620108000000099999999')).toBe('iban');
  });

  it('NOT one character off (mod-97 fails), too short, or check digits 00 / 01 / 99', () => {
    expect(isIban('GB82WEST12345698765431')).toBe(false);
    expect(isIban('IL6201080000')).toBe(false);
    expect(isIban('GB00WEST12345698765432')).toBe(false);
    expect(identifierKindOf('GB82WEST12345698765431')).toBeNull();
  });
});

describe('inside a longer label', () => {
  it('a word of the label is checked on its own shape', () => {
    expect(identifierKindOf('Target customer 123456782')).toBe('israeliId');
    expect(identifierKindOf('לקוח יעד: 123456782.')).toBe('israeliId');
    expect(identifierKindOf('Call 050-1234567')).toBe('phone');
    expect(identifierKindOf('Order 123456789 shipped')).toBeNull();
    expect(identifierKindOf('Expense account 61000100')).toBeNull();
  });

  it('booleans, empty values and short texts are never identifiers', () => {
    expect(identifierKindOf(true)).toBeNull();
    expect(identifierKindOf(null)).toBeNull();
    expect(identifierKindOf('')).toBeNull();
    expect(identifierKindOf('קטנה')).toBeNull();
    expect(identifierKindOf(-123456782)).toBeNull();
    expect(identifierKindOf(123456782.5)).toBeNull();
  });
});

describe('identifierShapeOf: one cell of a column, whole (the engine\'s column classification)', () => {
  it('each shape, as text, with the marks and spaces a cell may carry', () => {
    expect(identifierShapeOf('123456782')).toBe('israeliId');
    expect(identifierShapeOf('\u200f 123456782 ')).toBe('israeliId');
    expect(identifierShapeOf('050-1234567')).toBe('phone');
    expect(identifierShapeOf('050\u00a01234567')).toBe('phone');
    expect(identifierShapeOf('dana@example.com')).toBe('email');
    expect(identifierShapeOf('4580 1234 5678 9010')).toBeNull(); // Luhn fails
    expect(identifierShapeOf('4111 1111 1111 1111')).toBe('card');
    expect(identifierShapeOf('IL62 0108 0000 0009 9999 999')).toBe('iban');
  });

  it('a number: an ID of 9 digits or a card; a price, a ledger account or a 9-digit code failing the check digit is none', () => {
    expect(identifierShapeOf(123456782)).toBe('israeliId');
    expect(identifierShapeOf(4111111111111111)).toBe('card');
    for (const v of [1250000, 61000100, 123456789, 12345674, 501234567, 99.5]) expect(identifierShapeOf(v)).toBeNull();
  });

  it('only the whole cell: a label with an ID inside is the Save popup\'s word-by-word check, not a cell shape', () => {
    expect(identifierShapeOf('Target customer 123456782')).toBeNull();
    expect(identifierKindOf('Target customer 123456782')).toBe('israeliId');
    expect(identifierShapeOf('Expense account 61000100')).toBeNull();
  });
});
