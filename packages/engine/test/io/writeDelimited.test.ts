import { describe, expect, it } from 'vitest';
import { DelimitedWriteError, writeDelimited } from '../../src/io/writeDelimited';
import type { OutputFileSpec, OutputSheet } from '../../src/types';

// Decoders mirror the existing writeCsv.test.ts convention: ignoreBOM:true
// keeps a leading BOM visible in the decoded string (as U+FEFF) instead of
// having TextDecoder silently strip it, so tests can assert on it explicitly.
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}
function decodeWindows1255(bytes: Uint8Array): string {
  return new TextDecoder('windows-1255').decode(bytes);
}
function stripBom(text: string): string {
  return text.replace(/^﻿/, '');
}

/**
 * A single row/field carries: Hebrew + English (Name column), a negative
 * number in a numeric column (Amount), a value containing both a comma AND a
 * tab plus a quote character and an embedded newline (Note, row 1 -- this
 * intentionally conflicts with whichever delimiter is active, comma or tab),
 * and a formula-looking text value (Note, row 2).
 */
function bigSheet(): OutputSheet {
  return {
    name: 'Sheet1',
    direction: 'ltr',
    language: 'en',
    columns: [{ header: 'Name' }, { header: 'Amount', numeric: true }, { header: 'Note' }],
    rows: [
      { kind: 'header', cells: [{ v: 'Name' }, { v: 'Amount' }, { v: 'Note' }] },
      {
        kind: 'data',
        cells: [{ v: 'דנה' }, { v: -5 }, { v: 'a,\tb "q"\nline2' }],
      },
      {
        kind: 'data',
        cells: [{ v: 'John' }, { v: 42 }, { v: '=SUM(A1:A2)' }],
      },
    ],
    merges: [],
  };
}

/** Same shape as bigSheet but with no delimiter/quote/newline conflicts, for quote:"none" and determinism. */
function safeSheet(): OutputSheet {
  return {
    name: 'Sheet1',
    direction: 'ltr',
    language: 'en',
    columns: [{ header: 'Name' }, { header: 'Amount', numeric: true }, { header: 'Note' }],
    rows: [
      { kind: 'header', cells: [{ v: 'Name' }, { v: 'Amount' }, { v: 'Note' }] },
      { kind: 'data', cells: [{ v: 'דנה' }, { v: -5 }, { v: 'plain hebrew-safe note' }] },
      { kind: 'data', cells: [{ v: 'John' }, { v: 42 }, { v: '=SUM(A1:A2)' }] },
    ],
    merges: [],
  };
}

function headerToggleSheet(): OutputSheet {
  return {
    name: 'Sheet1',
    direction: 'ltr',
    language: 'en',
    columns: [{ header: 'A' }, { header: 'B' }],
    rows: [
      { kind: 'title', cells: [{ v: 'Report Title' }, { v: null }] },
      { kind: 'header', cells: [{ v: 'A' }, { v: 'B' }] },
      { kind: 'data', cells: [{ v: 'x' }, { v: 1 }] },
      { kind: 'blank', cells: [{ v: null }, { v: null }] },
      { kind: 'subtotal', cells: [{ v: 'Subtotal' }, { v: 1 }] },
      { kind: 'grandTotal', cells: [{ v: 'Total' }, { v: 1 }] },
    ],
    merges: [],
  };
}

// The big fixture's expected body with minimal quoting, independent of
// delimiter char and encoding (only the delimiter and byte encoding change).
function expectedMinimalBody(delimiter: string): string {
  const noteRow1 = `"a,\tb ""q""\nline2"`; // always needs quoting: contains a literal quote char + newline
  return (
    ['Name', 'Amount', 'Note'].join(delimiter) +
    '\r\n' +
    ['דנה', '-5', noteRow1].join(delimiter) +
    '\r\n' +
    ['John', '42', "'=SUM(A1:A2)"].join(delimiter) +
    '\r\n'
  );
}

function expectedAllQuotedBody(delimiter: string): string {
  const noteRow1 = `"a,\tb ""q""\nline2"`;
  return (
    ['"Name"', '"Amount"', '"Note"'].join(delimiter) +
    '\r\n' +
    ['"דנה"', '"-5"', noteRow1].join(delimiter) +
    '\r\n' +
    ['"John"', '"42"', `"'=SUM(A1:A2)"`].join(delimiter) +
    '\r\n'
  );
}

describe('writeDelimited - defaults', () => {
  it('defaults csv to comma delimiter, utf8bom, header on, minimal quoting', () => {
    const bytes = writeDelimited(safeSheet(), { type: 'csv' });
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
    const text = stripBom(decodeUtf8(bytes));
    expect(text).toBe('Name,Amount,Note\r\nדנה,-5,plain hebrew-safe note\r\nJohn,42,\'=SUM(A1:A2)\r\n');
  });

  it('defaults txt to tab delimiter', () => {
    const bytes = writeDelimited(safeSheet(), { type: 'txt' });
    const text = stripBom(decodeUtf8(bytes));
    expect(text).toBe('Name\tAmount\tNote\r\nדנה\t-5\tplain hebrew-safe note\r\nJohn\t42\t\'=SUM(A1:A2)\r\n');
  });

  it('an explicit delimiter overrides the type default', () => {
    const bytes = writeDelimited(safeSheet(), { type: 'csv', delimiter: ';' });
    const text = stripBom(decodeUtf8(bytes));
    expect(text.startsWith('Name;Amount;Note\r\n')).toBe(true);
  });
});

describe('writeDelimited - header on/off', () => {
  it.each([
    ['csv', ','],
    ['txt', '\t'],
  ] as const)('header:true writes the header row (%s)', (type, delimiter) => {
    const bytes = writeDelimited(headerToggleSheet(), { type, header: true });
    const text = stripBom(decodeUtf8(bytes));
    const expected =
      ['Report Title', ''].join(delimiter) +
      '\r\n' +
      ['A', 'B'].join(delimiter) +
      '\r\n' +
      ['x', '1'].join(delimiter) +
      '\r\n' +
      ['', ''].join(delimiter) +
      '\r\n' +
      ['Subtotal', '1'].join(delimiter) +
      '\r\n' +
      ['Total', '1'].join(delimiter) +
      '\r\n';
    expect(text).toBe(expected);
  });

  it.each([
    ['csv', ','],
    ['txt', '\t'],
  ] as const)('header:false drops only the header-kind row, keeping title/blank/subtotal/grandTotal (%s)', (type, delimiter) => {
    const bytes = writeDelimited(headerToggleSheet(), { type, header: false });
    const text = stripBom(decodeUtf8(bytes));
    const expected =
      ['Report Title', ''].join(delimiter) +
      '\r\n' +
      ['x', '1'].join(delimiter) +
      '\r\n' +
      ['', ''].join(delimiter) +
      '\r\n' +
      ['Subtotal', '1'].join(delimiter) +
      '\r\n' +
      ['Total', '1'].join(delimiter) +
      '\r\n';
    expect(text).toBe(expected);
  });
});

describe('writeDelimited - quote modes', () => {
  it.each(['csv', 'txt'] as const)('minimal: quotes only fields that need it (%s)', (type) => {
    const delimiter = type === 'txt' ? '\t' : ',';
    const bytes = writeDelimited(bigSheet(), { type, quote: 'minimal' });
    const text = stripBom(decodeUtf8(bytes));
    expect(text).toBe(expectedMinimalBody(delimiter));
  });

  it.each(['csv', 'txt'] as const)('all: quotes every field (%s)', (type) => {
    const delimiter = type === 'txt' ? '\t' : ',';
    const bytes = writeDelimited(bigSheet(), { type, quote: 'all' });
    const text = stripBom(decodeUtf8(bytes));
    expect(text).toBe(expectedAllQuotedBody(delimiter));
  });

  it.each(['csv', 'txt'] as const)('none: never quotes, and passes safe values through unescaped (%s)', (type) => {
    const bytes = writeDelimited(safeSheet(), { type, quote: 'none' });
    const text = stripBom(decodeUtf8(bytes));
    const delimiter = type === 'txt' ? '\t' : ',';
    expect(text).toBe(
      ['Name', 'Amount', 'Note'].join(delimiter) +
        '\r\n' +
        ['דנה', '-5', 'plain hebrew-safe note'].join(delimiter) +
        '\r\n' +
        ['John', '42', "'=SUM(A1:A2)"].join(delimiter) +
        '\r\n'
    );
  });

  it('none: a literal quote character is left unescaped (never silently altered)', () => {
    const sheet: OutputSheet = {
      name: 'S',
      direction: 'ltr',
      language: 'en',
      columns: [{ header: 'Note' }],
      rows: [{ kind: 'data', cells: [{ v: 'say "hi"' }] }],
      merges: [],
    };
    const bytes = writeDelimited(sheet, { type: 'csv', quote: 'none' });
    const text = stripBom(decodeUtf8(bytes));
    expect(text).toBe('say "hi"\r\n');
  });

  it.each(['csv', 'txt'] as const)(
    'none: throws a typed DelimitedWriteError when a value contains the delimiter or a line break (%s)',
    (type) => {
      let caught: unknown;
      try {
        writeDelimited(bigSheet(), { type, quote: 'none' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(DelimitedWriteError);
      const err = caught as DelimitedWriteError;
      expect(err.code).toBe('unquotableValue');
      // Row 1 (first data row), col 2 (Note): the field carrying the comma+tab+newline.
      expect(err.row).toBe(1);
      expect(err.col).toBe(2);
    }
  );
});

describe('writeDelimited - encoding', () => {
  it('utf8bom: writes a BOM and decodes back to the exact text', () => {
    const bytes = writeDelimited(bigSheet(), { type: 'csv', encoding: 'utf8bom' });
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
    expect(stripBom(decodeUtf8(bytes))).toBe(expectedMinimalBody(','));
  });

  it('utf8: writes no BOM', () => {
    const bytes = writeDelimited(bigSheet(), { type: 'csv', encoding: 'utf8' });
    expect(bytes[0]).not.toBe(0xef);
    expect(decodeUtf8(bytes)).toBe(expectedMinimalBody(','));
  });

  it('windows1255: encodes Hebrew and ASCII into single-byte Windows-1255, no BOM', () => {
    const bytes = writeDelimited(bigSheet(), { type: 'csv', encoding: 'windows1255' });
    // Every byte must be a single Windows-1255 code unit (no multi-byte UTF-8 sequences).
    expect(decodeWindows1255(bytes)).toBe(expectedMinimalBody(','));
  });

  it('windows1255: known byte values for Hebrew letters (שלום, matching read.ts\'s own fixture)', () => {
    const sheet: OutputSheet = {
      name: 'S',
      direction: 'rtl',
      language: 'he',
      columns: [{ header: 'x' }],
      rows: [{ kind: 'data', cells: [{ v: 'שלום' }] }],
      merges: [],
    };
    const bytes = writeDelimited(sheet, { type: 'csv', encoding: 'windows1255' });
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0xf9, 0xec, 0xe5, 0xed]);
  });

  it('windows1255: throws a typed DelimitedWriteError for a character with no Windows-1255 byte', () => {
    const sheet: OutputSheet = {
      name: 'S',
      direction: 'ltr',
      language: 'en',
      columns: [{ header: 'x' }, { header: 'y' }],
      rows: [{ kind: 'data', cells: [{ v: 'ok' }, { v: '中' }] }],
      merges: [],
    };
    let caught: unknown;
    try {
      writeDelimited(sheet, { type: 'csv', encoding: 'windows1255' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DelimitedWriteError);
    const err = caught as DelimitedWriteError;
    expect(err.code).toBe('unencodable');
    expect(err.row).toBe(0);
    expect(err.col).toBe(1);
    expect(err.char).toBe('中');
  });
});

describe('writeDelimited - determinism', () => {
  const types = ['csv', 'txt'] as const;
  const headers = [true, false] as const;
  const quotes = ['minimal', 'all', 'none'] as const;
  const encodings = ['utf8bom', 'utf8', 'windows1255'] as const;

  for (const type of types) {
    for (const header of headers) {
      for (const quote of quotes) {
        for (const encoding of encodings) {
          it(`writing twice produces identical bytes (${type}, header:${header}, quote:${quote}, ${encoding})`, () => {
            const spec: OutputFileSpec = { type, header, quote, encoding };
            const sheet = quote === 'none' ? safeSheet() : bigSheet();
            const first = writeDelimited(sheet, spec);
            const second = writeDelimited(sheet, spec);
            expect(first).toEqual(second);
            // Fresh object graph too, not just the same in-memory sheet.
            const third = writeDelimited(quote === 'none' ? safeSheet() : bigSheet(), spec);
            expect(first).toEqual(third);
          });
        }
      }
    }
  }
});
