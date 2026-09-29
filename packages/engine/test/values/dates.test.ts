import { describe, expect, it } from 'vitest';
import {
  formatYmd,
  isExcelDateFormat,
  isValidYmd,
  MONTH_NAMES,
  parseDate,
  serialToYmd,
  suggestDaySwap,
  toExcelDateFormat,
  ymdToSerial,
  type Ymd,
} from '../../src/values/dates';

describe('serialToYmd / ymdToSerial round trips', () => {
  it('handles the 1900 leap-year bug boundary', () => {
    expect(serialToYmd(59)).toEqual({ y: 1900, m: 2, d: 28 });
    expect(serialToYmd(60)).toEqual({ y: 1900, m: 2, d: 29 }); // fake date
    expect(serialToYmd(61)).toEqual({ y: 1900, m: 3, d: 1 });

    expect(ymdToSerial({ y: 1900, m: 2, d: 28 })).toBe(59);
    expect(ymdToSerial({ y: 1900, m: 2, d: 29 })).toBe(60);
    expect(ymdToSerial({ y: 1900, m: 3, d: 1 })).toBe(61);
  });

  it('round-trips serial -> ymd -> serial for ordinary dates', () => {
    for (const serial of [1, 2, 45, 59, 61, 100, 1000, 25000, 44197, 60000]) {
      const ymd = serialToYmd(serial);
      expect(ymdToSerial(ymd)).toBe(serial);
    }
  });

  it('round-trips ymd -> serial -> ymd for ordinary dates', () => {
    const dates: Ymd[] = [
      { y: 1900, m: 1, d: 1 },
      { y: 1901, m: 1, d: 1 },
      { y: 2000, m: 2, d: 29 }, // real leap day
      { y: 2023, m: 12, d: 31 },
      { y: 2024, m: 2, d: 29 },
    ];
    for (const ymd of dates) {
      expect(serialToYmd(ymdToSerial(ymd))).toEqual(ymd);
    }
  });

  it('ignores the time fraction', () => {
    expect(serialToYmd(45000.75)).toEqual(serialToYmd(45000));
  });

  it('shifts by 1462 for the 1904 date system', () => {
    const ymd: Ymd = { y: 2020, m: 6, d: 15 };
    const serial1900 = ymdToSerial(ymd);
    expect(serialToYmd(serial1900 - 1462, true)).toEqual(ymd);
  });
});

describe('isValidYmd', () => {
  it('accepts real calendar dates', () => {
    expect(isValidYmd({ y: 2024, m: 2, d: 29 })).toBe(true); // real leap day
    expect(isValidYmd({ y: 2023, m: 12, d: 31 })).toBe(true);
  });

  it('rejects impossible dates', () => {
    expect(isValidYmd({ y: 2023, m: 2, d: 30 })).toBe(false);
    expect(isValidYmd({ y: 2023, m: 2, d: 29 })).toBe(false); // 2023 not a leap year
    expect(isValidYmd({ y: 2023, m: 13, d: 1 })).toBe(false);
    expect(isValidYmd({ y: 2023, m: 0, d: 1 })).toBe(false);
    expect(isValidYmd({ y: 2023, m: 1, d: 0 })).toBe(false);
  });

  it('accepts Excel\'s fake 1900-02-29', () => {
    expect(isValidYmd({ y: 1900, m: 2, d: 29 })).toBe(true);
  });
});

describe('parseDate', () => {
  it('parses DD/MM/YYYY and D/M/YYYY', () => {
    expect(parseDate('31/12/2023', ['DD/MM/YYYY'])).toEqual({ y: 2023, m: 12, d: 31 });
    expect(parseDate('1/2/2023', ['D/M/YYYY'])).toEqual({ y: 2023, m: 2, d: 1 });
  });

  it('parses MM/DD/YYYY', () => {
    expect(parseDate('12/31/2023', ['MM/DD/YYYY'])).toEqual({ y: 2023, m: 12, d: 31 });
  });

  it('parses two-digit years with the 50 pivot', () => {
    expect(parseDate('05-06-23', ['DD-MM-YY'])).toEqual({ y: 2023, m: 6, d: 5 }); // DECISION: <50 -> 2000s
    expect(parseDate('05-06-75', ['DD-MM-YY'])).toEqual({ y: 1975, m: 6, d: 5 }); // >=50 -> 1900s
  });

  it('parses any literal separator', () => {
    expect(parseDate('2023.03.05', ['YYYY.MM.DD'])).toEqual({ y: 2023, m: 3, d: 5 });
  });

  it('parses excelSerial from a number', () => {
    expect(parseDate(45000, ['excelSerial'])).toEqual(serialToYmd(45000));
  });

  it('parses excelSerial from a plain integer/decimal string', () => {
    expect(parseDate('45000', ['excelSerial'])).toEqual(serialToYmd(45000));
    expect(parseDate('45000.75', ['excelSerial'])).toEqual(serialToYmd(45000));
  });

  it('does not match excelSerial against a non-numeric string', () => {
    expect(parseDate('31/12/2023', ['excelSerial'])).toBeNull();
  });

  it('does not match a token format against a raw number', () => {
    expect(parseDate(45000, ['DD/MM/YYYY'])).toBeNull();
  });

  it('is strict: an impossible date does not match', () => {
    expect(parseDate('31/02/2023', ['DD/MM/YYYY'])).toBeNull();
    expect(parseDate('13/13/2023', ['DD/MM/YYYY'])).toBeNull();
  });

  it('tries formats in order and returns the first that matches', () => {
    expect(parseDate('31/12/2023', ['YYYY-MM-DD', 'DD/MM/YYYY'])).toEqual({ y: 2023, m: 12, d: 31 });
    expect(parseDate('2023-12-31', ['YYYY-MM-DD', 'DD/MM/YYYY'])).toEqual({ y: 2023, m: 12, d: 31 });
  });

  it('returns null when no format matches', () => {
    expect(parseDate('not a date', ['DD/MM/YYYY'])).toBeNull();
  });
});

describe('suggestDaySwap', () => {
  it('suggests swapping day and month when that makes the date valid', () => {
    // Read as MM/DD/YYYY, "13" as a month is impossible; swapped it is Feb 13.
    expect(suggestDaySwap('13/02/2023', 'MM/DD/YYYY')).toEqual({ y: 2023, m: 2, d: 13 });
  });

  it('returns null when the original reading is already valid', () => {
    expect(suggestDaySwap('13/02/2023', 'DD/MM/YYYY')).toBeNull();
  });

  it('returns null when neither reading is valid', () => {
    expect(suggestDaySwap('25/13/2023', 'DD/MM/YYYY')).toBeNull();
  });

  it('returns null when the text does not fit the format shape at all', () => {
    expect(suggestDaySwap('2023/02/13', 'DD/MM/YYYY')).toBeNull();
  });
});

describe('formatYmd', () => {
  const ymd: Ymd = { y: 2023, m: 3, d: 5 };

  it('formats token-style formats', () => {
    expect(formatYmd(ymd, 'DD/MM/YYYY', 'en')).toBe('05/03/2023');
    expect(formatYmd(ymd, 'D/M/YYYY', 'en')).toBe('5/3/2023');
    expect(formatYmd(ymd, 'MMMM YYYY', 'en')).toBe('March 2023');
    expect(formatYmd(ymd, 'MMMM YYYY', 'he')).toBe(`${MONTH_NAMES.he[2]} 2023`);
    expect(formatYmd(ymd, 'MMM YYYY', 'en')).toBe('Mar 2023');
  });

  it('formats Excel-style (lowercase) formats identically', () => {
    expect(formatYmd(ymd, 'dd/mm/yyyy', 'en')).toBe('05/03/2023');
    expect(formatYmd(ymd, 'mmmm yyyy', 'he')).toBe(`${MONTH_NAMES.he[2]} 2023`);
  });

  it('ignores a [$-40D] locale prefix', () => {
    expect(formatYmd(ymd, '[$-40D]mmmm yyyy', 'he')).toBe(`${MONTH_NAMES.he[2]} 2023`);
  });

  it('formats YY as a 2-digit year', () => {
    expect(formatYmd(ymd, 'DD/MM/YY', 'en')).toBe('05/03/23');
  });

  it('keeps quoted literal text as-is', () => {
    expect(formatYmd(ymd, '"Date:" DD/MM/YYYY', 'en')).toBe('Date: 05/03/2023');
  });

  it('treats a backslash-escaped character as a literal, not a token', () => {
    expect(formatYmd(ymd, 'DD\\M MM', 'en')).toBe('05M 03');
  });
});

describe('toExcelDateFormat', () => {
  it('converts token style to lowercase Excel numFmt', () => {
    expect(toExcelDateFormat('DD/MM/YYYY', 'en')).toBe('dd/mm/yyyy');
    expect(toExcelDateFormat('MMMM YYYY', 'en')).toBe('mmmm yyyy');
  });

  it('prefixes [$-40D] for Hebrew month-name formats', () => {
    expect(toExcelDateFormat('MMMM YYYY', 'he')).toBe('[$-40D]mmmm yyyy');
  });

  it('does not add a locale prefix when there is no month name', () => {
    expect(toExcelDateFormat('DD/MM/YYYY', 'he')).toBe('dd/mm/yyyy');
  });

  it('returns already-Excel-style input normalized (idempotent)', () => {
    expect(toExcelDateFormat('dd/mm/yyyy', 'en')).toBe('dd/mm/yyyy');
    expect(toExcelDateFormat('[$-40D]mmmm yyyy', 'he')).toBe('[$-40D]mmmm yyyy');
  });
});

describe('isExcelDateFormat', () => {
  it('recognizes typical date formats', () => {
    expect(isExcelDateFormat('dd/mm/yyyy')).toBe(true);
    expect(isExcelDateFormat('[$-40D]mmmm yyyy')).toBe(true);
    expect(isExcelDateFormat('yyyy-mm-dd')).toBe(true);
  });

  it('rejects non-date formats', () => {
    expect(isExcelDateFormat('#,##0.00')).toBe(false);
    expect(isExcelDateFormat('General')).toBe(false);
    expect(isExcelDateFormat('0%')).toBe(false);
    expect(isExcelDateFormat('@')).toBe(false);
  });

  it('rejects elapsed-time and plain time formats, even though they contain "m"', () => {
    expect(isExcelDateFormat('[h]:mm:ss')).toBe(false);
    expect(isExcelDateFormat('hh:mm:ss')).toBe(false);
  });
});
