import { describe, expect, it } from 'vitest';
import { detectFileSpec, detectFileSpecWithConfidence, sniffDelimitedText } from '../../src/io/detectFileSpec';
import { readWorkbook } from '../../src/io/read';
import type { RawWorkbook } from '../../src/types';

describe('detectFileSpec', () => {
  it('xlsx/xls always map to { type: "xlsx" }, ignoring sheets', () => {
    const wbXlsx: RawWorkbook = { fileType: 'xlsx', sheets: [] };
    expect(detectFileSpec(wbXlsx)).toEqual({ type: 'xlsx' });

    const wbXls: RawWorkbook = { fileType: 'xls', sheets: [] };
    expect(detectFileSpec(wbXls)).toEqual({ type: 'xlsx' });
  });

  it('csv with a header row: comma delimiter, header true, quote minimal', async () => {
    const text = 'Name,Amount,Date\nDana,100,01/02/2024\nYossi,200,03/04/2024\n';
    const bytes = new TextEncoder().encode(text);
    const wb = await readWorkbook(bytes, 'out.csv');

    const spec = detectFileSpec(wb);
    expect(spec.type).toBe('csv');
    expect(spec.delimiter).toBe(',');
    expect(spec.encoding).toBe('utf8');
    expect(spec.header).toBe(true);
    expect(spec.quote).toBe('minimal');
  });

  it('a tab-delimited .txt load file where every row is data: header false', async () => {
    const text = '1001\tDana\t100.00\r\n1002\tYossi\t200.00\r\n1003\tNoa\t300.00\r\n';
    const bytes = new TextEncoder().encode(text);
    const wb = await readWorkbook(bytes, 'load.txt');

    const spec = detectFileSpec(wb);
    expect(spec.type).toBe('txt');
    expect(spec.delimiter).toBe('\t');
    expect(spec.header).toBe(false);
  });

  it('a csv where every column is text gives no type evidence: header defaults to true, reported as ambiguous', async () => {
    const text = 'Full name,Email,City\nDana Levi,dana@example.com,Haifa\nOmer Katz,omer@example.com,Eilat\nNoa Tal,noa@example.com,Acre\n';
    const wb = await readWorkbook(new TextEncoder().encode(text), 'out.csv');

    expect(detectFileSpec(wb).header).toBe(true);
    expect(detectFileSpecWithConfidence(wb)).toMatchObject({
      headerConfidence: 'ambiguous',
      spec: { type: 'csv', delimiter: ',', header: true },
    });
  });

  it('a header decided by types is reported as evidence, in both directions', async () => {
    const headered = await readWorkbook(new TextEncoder().encode('Name,Amount\nDana,100\nYossi,200\n'), 'out.csv');
    expect(detectFileSpecWithConfidence(headered)).toMatchObject({ headerConfidence: 'evidence', spec: { header: true } });

    const headerless = await readWorkbook(new TextEncoder().encode('1001\tDana\t100.00\r\n1002\tYossi\t200.00\r\n'), 'load.txt');
    expect(detectFileSpecWithConfidence(headerless)).toMatchObject({ headerConfidence: 'evidence', spec: { header: false } });
  });

  it('a semicolon-delimited csv with a header', async () => {
    const text = 'Name;Amount\nDana;100\nYossi;200\n';
    const bytes = new TextEncoder().encode(text);
    const wb = await readWorkbook(bytes, 'out.csv');

    const spec = detectFileSpec(wb);
    expect(spec.delimiter).toBe(';');
    expect(spec.header).toBe(true);
  });

  it('quote: "all" when every non-empty field in the file was quoted (sniffed from the raw bytes)', async () => {
    const text = '"Name","Amount"\r\n"Dana","100"\r\n"Yossi","200"\r\n';
    const bytes = new TextEncoder().encode(text);
    const wb = await readWorkbook(bytes, 'out.csv');

    const sniff = sniffDelimitedText(bytes);
    expect(sniff.allQuoted).toBe(true);

    const spec = detectFileSpec(wb, 0, sniff);
    expect(spec.quote).toBe('all');
  });

  it('quote stays "minimal" when not every field is quoted, even with a sniff result', async () => {
    const text = 'Name,Amount\r\n"Dana",100\r\nYossi,200\r\n';
    const bytes = new TextEncoder().encode(text);
    const wb = await readWorkbook(bytes, 'out.csv');

    const sniff = sniffDelimitedText(bytes);
    expect(sniff.allQuoted).toBe(false);

    const spec = detectFileSpec(wb, 0, sniff);
    expect(spec.quote).toBe('minimal');
  });

  it('maps detected encodings to the OutputFileSpec enum (utf-8-bom -> utf8bom, windows-1255 -> windows1255)', async () => {
    const bomText = new TextEncoder().encode('Name,Amount\nDana,100\nYossi,200\n');
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bomText]);
    const wbBom = await readWorkbook(withBom, 'out.csv');
    expect(detectFileSpec(wbBom).encoding).toBe('utf8bom');

    // "שלום" in windows-1255, comma-delimited two-row csv.
    const heb = new Uint8Array([0xf9, 0xec, 0xe5, 0xed]);
    const win1255Bytes = new Uint8Array([...new TextEncoder().encode('Name,Amount\n'), ...heb, 0x2c, 0x31, 0x0a]);
    const wbWin = await readWorkbook(win1255Bytes, 'out.csv');
    expect(detectFileSpec(wbWin).encoding).toBe('windows1255');
  });

  it('sheetIndex selects which sheet of a multi-sheet workbook to inspect for header detection', () => {
    const wb: RawWorkbook = {
      fileType: 'csv',
      delimiter: ',',
      encoding: 'utf-8',
      sheets: [
        {
          name: 'headerless',
          rows: [
            [{ v: '1' }, { v: 'a' }],
            [{ v: '2' }, { v: 'b' }],
          ],
          merges: [],
          hiddenRows: [],
          hiddenCols: [],
          colWidths: [],
        },
        {
          name: 'headered',
          rows: [
            [{ v: 'Id' }, { v: 'Name' }],
            [{ v: '1' }, { v: 'a' }],
            [{ v: '2' }, { v: 'b' }],
          ],
          merges: [],
          hiddenRows: [],
          hiddenCols: [],
          colWidths: [],
        },
      ],
    };
    expect(detectFileSpec(wb, 0).header).toBe(false);
    expect(detectFileSpec(wb, 1).header).toBe(true);
  });
});
