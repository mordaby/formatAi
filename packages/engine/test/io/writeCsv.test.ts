import { describe, expect, it } from 'vitest';
import { writeCsv } from '../../src/io/writeCsv';
import type { OutCell, OutputSheet } from '../../src/types';

function sheet(rows: OutCell[][], columns: OutputSheet['columns'] = []): OutputSheet {
  return {
    name: 'Sheet1',
    direction: 'ltr',
    language: 'en',
    columns,
    rows: rows.map((cells) => ({ kind: 'data' as const, cells })),
    merges: [],
  };
}

function decode(bytes: Uint8Array): string {
  // ignoreBOM: TextDecoder strips a leading BOM by default; we want to see it.
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

describe('writeCsv', () => {
  it('writes a UTF-8 BOM and CRLF line endings', () => {
    const bytes = writeCsv(sheet([[{ v: 'a' }, { v: 'b' }]]));
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
    const text = decode(bytes);
    expect(text).toBe('﻿a,b\r\n');
  });

  it('quotes fields containing commas, quotes or newlines (RFC 4180)', () => {
    const bytes = writeCsv(
      sheet([[{ v: 'a,b' }, { v: 'say "hi"' }, { v: 'line1\nline2' }]])
    );
    const text = decode(bytes).replace(/^﻿/, '');
    expect(text).toBe('"a,b","say ""hi""","line1\nline2"\r\n');
  });

  it('renders booleans as TRUE/FALSE and null as empty', () => {
    const bytes = writeCsv(sheet([[{ v: true }, { v: false }, { v: null }]]));
    const text = decode(bytes).replace(/^﻿/, '');
    expect(text).toBe('TRUE,FALSE,\r\n');
  });

  it('never renders numbers in exponential notation', () => {
    const bytes = writeCsv(sheet([[{ v: 1e21 }, { v: 0.0000001 }]]));
    const text = decode(bytes).replace(/^﻿/, '').trim();
    const [big, small] = text.split(',');
    expect(big).not.toMatch(/e/i);
    expect(small).not.toMatch(/e/i);
    expect(big).toBe('1000000000000000000000');
    expect(small).toBe('0.0000001');
  });

  it('prefers cell.text for display when present', () => {
    const bytes = writeCsv(sheet([[{ v: 43831, text: '01/01/2020' }]]));
    const text = decode(bytes).replace(/^﻿/, '').trim();
    expect(text).toBe('01/01/2020');
  });

  describe('formula-injection guard', () => {
    it('prefixes text starting with = + - @ with an apostrophe', () => {
      const bytes = writeCsv(
        sheet([[{ v: '=SUM(A1)' }, { v: '+1' }, { v: '-1' }, { v: '@cmd' }, { v: 'plain' }]])
      );
      const text = decode(bytes).replace(/^﻿/, '').trim();
      expect(text).toBe("'=SUM(A1),'+1,'-1,'@cmd,plain");
    });

    it('does not guard numeric-typed values even if the column looks textual', () => {
      // A cell.text display string starting with "-" but the underlying value is a number.
      const bytes = writeCsv(sheet([[{ v: -5, text: '-5' }]]));
      const text = decode(bytes).replace(/^﻿/, '').trim();
      expect(text).toBe('-5');
    });

    it('does not guard a plain number kept as text in a column marked numeric: true', () => {
      const columns: OutputSheet['columns'] = [{ header: 'Code', numeric: true }];
      const bytes = writeCsv(sheet([[{ v: '-123' }]], columns));
      const text = decode(bytes).replace(/^﻿/, '').trim();
      expect(text).toBe('-123');
    });

    // Found by the engine stress test (eval/STRESS.md): a number column keeps a cell it cannot read as it is (and flags it), so a numeric
    // column can still hold text - "=SUM(A1:A9)" in an Amount column went out live.
    it('guards formula-like text in a column marked numeric: true (a value its type could not read is kept as text)', () => {
      const columns: OutputSheet['columns'] = [{ header: 'Amount', numeric: true }];
      const bytes = writeCsv(sheet([[{ v: '=SUM(A1:A9)' }], [{ v: '+972-50-1234567' }], [{ v: '@cmd' }], [{ v: '-5 units' }], [{ v: 12.5 }], [{ v: -3 }]], columns));
      const text = decode(bytes).replace(/^﻿/, '').trim();
      expect(text.split('\r\n')).toEqual(["'=SUM(A1:A9)", "'+972-50-1234567", "'@cmd", "'-5 units", '12.5', '-3']);
    });

    it('guards a header, title or summary label that starts like a formula, in a numeric column too', () => {
      const s: OutputSheet = {
        name: 'Sheet1',
        direction: 'ltr',
        language: 'en',
        columns: [{ header: '=Amount', numeric: true }],
        rows: [
          { kind: 'title', cells: [{ v: '+Report' }] },
          { kind: 'header', cells: [{ v: '=Amount' }] },
          { kind: 'data', cells: [{ v: 7 }] },
          { kind: 'summaryRow', cells: [{ v: '@Total' }] },
        ],
        merges: [],
      };
      const text = decode(writeCsv(s)).replace(/^﻿/, '').trim();
      expect(text.split('\r\n')).toEqual(["'+Report", "'=Amount", '7', "'@Total"]);
    });
  });
});
