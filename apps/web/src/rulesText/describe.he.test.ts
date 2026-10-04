import type { Expr, LearnResult } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { describeRules } from './describe';
import { col, INPUT_COLUMNS, lineTexts, num, rules, str, withColumn, type Patch } from './fixtures';
import type { RulesMapModel } from './types';

// The same fixtures as the English tests, with Hebrew headers on the input side, so these tests
// also show how Hebrew sentences carry Hebrew names.
const HEADERS: Record<string, string> = {
  c_cost: 'עלות',
  c_code: 'קוד',
  c_name: 'שם',
  c_group: 'קבוצה',
  c_date: 'תאריך',
  c_status: 'סטטוס',
  c_supplier: 'ספק',
  c_order: 'מספר הזמנה',
  c_amount: 'סכום',
  c_items: 'פריטים',
  c_jan: 'ינואר',
  c_feb: 'פברואר',
  c_tags: 'תגיות',
};

function he(r: LearnResult): RulesMapModel {
  return describeRules(
    { ...r, input: { ...r.input, columns: r.input.columns.map((c) => ({ ...c, header: HEADERS[c.id] ?? c.header })) } },
    { lang: 'he' },
  );
}

function line(model: RulesMapModel, id: string): string {
  const found = lineTexts(model).find(([lineId]) => lineId === id);
  if (!found) throw new Error(`no line ${id} in ${JSON.stringify(lineTexts(model))}`);
  return found[1];
}

const calc = (expr: Expr, header = 'תוצאה', patch: Patch = {}): string => line(he(withColumn(header, expr, patch)), `col:${header}`);
const mul = (...args: Expr[]): Expr => ({ op: 'mul', args });

describe('sections', () => {
  it('has plain Hebrew titles', () => {
    expect(he(rules()).sections.map((s) => s.title)).toEqual(['שורות', 'עמודות', 'פריסה', 'בדיקות']);
    const withTable = he(rules({ transform: { tables: [{ name: 't', columns: ['k', 'v'], rows: [['a', 1]] }] } }));
    expect(withTable.sections.at(-1)?.title).toBe('פונקציות וטבלאות');
  });
});

describe('columns', () => {
  it('copies, pads and formats dates', () => {
    const model = he(
      rules({
        output: {
          columns: [
            { header: 'שם', from: 'c_name' },
            { header: 'קוד', from: 'c_code' },
            { header: 'מתי', from: 'c_date', format: 'DD/MM/YYYY' },
          ],
        },
      }),
    );
    expect(line(model, 'col:שם')).toBe('שם ← שם');
    expect(line(model, 'col:קוד')).toBe('קוד ← קוד, מרופד באפסים ל-9 ספרות');
    expect(line(model, 'col:מתי')).toBe('מתי ← תאריך, מוצג בתבנית DD/MM/YYYY');
  });

  it('writes calculations', () => {
    expect(calc({ op: 'round', digits: 2, arg: mul(col('c_cost'), num(1.18)) }, 'מחיר')).toBe('מחיר ← עלות × 1.18, מעוגל ל-2 ספרות אחרי הנקודה');
    expect(calc({ op: 'round', digits: 1, arg: col('c_cost') })).toBe('תוצאה ← עלות, מעוגל לספרה אחת אחרי הנקודה');
    expect(calc({ op: 'round', digits: 0, arg: col('c_cost') })).toBe('תוצאה ← עלות, מעוגל למספר שלם');
    expect(calc({ op: 'div', args: [col('c_amount'), col('c_cost')] })).toBe('תוצאה ← סכום ÷ עלות');
    expect(calc({ op: 'padLeft', arg: col('c_order'), length: 9, char: '0' })).toBe('תוצאה ← מספר הזמנה, מרופד באפסים ל-9 ספרות');
  });

  it('writes parts of text and joined text', () => {
    expect(calc({ op: 'substr', arg: col('c_code'), start: 1, length: 3 })).toBe('תוצאה ← 3 התווים הראשונים של קוד');
    expect(calc({ op: 'substr', arg: col('c_code'), start: 1, length: 1 })).toBe('תוצאה ← התו הראשון של קוד');
    expect(calc({ op: 'substr', arg: col('c_code'), start: -2, length: 2 })).toBe('תוצאה ← 2 התווים האחרונים של קוד');
    expect(calc({ op: 'concat', args: [col('c_code'), str(' - '), col('c_name')] })).toBe("תוצאה ← קוד מחובר עם שם, בהפרדה של ' - '");
    expect(calc({ op: 'concat', args: [col('c_code'), str(' '), col('c_name')] })).toBe('תוצאה ← קוד מחובר עם שם, בהפרדה של רווח');
  });

  it('writes fixed values, translations and empty columns', () => {
    expect(calc(str('ILS'), 'מטבע')).toBe("מטבע ← ערך קבוע 'ILS'");
    const map = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`g${i}`, `G${i}`]));
    const translated = he(
      rules({
        transform: { valueMaps: [{ column: 'c_group', map, onMissing: 'flag' }] },
        output: { columns: [{ header: 'קטגוריה', from: 'c_group' }] },
      }),
    );
    expect(line(translated, 'col:קטגוריה')).toBe('קטגוריה ← מתורגם מתוך קבוצה (12 ערכים; ערכים חדשים מסומנים)');
    const empty = he(rules({ output: { columns: [{ header: 'משלוח', from: null }] }, unsupported: [{ outputColumn: 'משלוח', reasonCode: 'externalData' }] }));
    expect(line(empty, 'col:משלוח')).toBe('משלוח ← נשאר ריק (דרוש מידע מכם)');
  });

  it('writes conditions', () => {
    expect(
      calc({ op: 'if', cond: { op: 'eq', args: [col('c_status'), str('VIP')] }, then: mul(col('c_cost'), num(0.9)), else: col('c_cost') }),
    ).toBe("תוצאה ← אם סטטוס שווה ל-'VIP' אז עלות × 0.9, אחרת עלות");
    expect(
      calc({
        op: 'switch',
        cases: [{ when: { op: 'gte', args: [col('c_amount'), num(1000)] }, then: str('גבוה') }],
        else: str('נמוך'),
      }),
    ).toBe("תוצאה ← אם סכום לפחות 1000 אז 'גבוה'; אחרת 'נמוך'");
  });

  it('writes a lookup', () => {
    const model = he(
      withColumn('קצב', { op: 'lookup', table: 'rates', key: col('c_code'), return: 'rate', onMissing: 'flag' }, {
        transform: { tables: [{ name: 'rates', columns: ['code', 'rate'], rows: [['A', 1]] }] },
      }),
    );
    expect(line(model, 'col:קצב')).toBe("קצב ← rate מהטבלה 'rates', לפי קוד (מפתחות חסרים מסומנים)");
  });
});

describe('rows', () => {
  it('writes filters, duplicates and expansion', () => {
    const model = he(
      rules({
        input: {
          rowFilters: [
            { column: 'c_status', op: 'ne', value: 'מבוטל' },
            { column: 'c_amount', op: 'gt', value: 0 },
            { column: 'c_status', op: 'oneOf', value: ['A', 'B', 'C'] },
            { column: 'c_name', op: 'isEmpty' },
          ],
          stopAt: { when: 'firstCellMatches', values: ['סה"כ', 'Total'] },
        },
        transform: {
          dedupe: { keys: ['c_order', 'c_supplier'], keep: 'first', action: 'flag' },
          expand: { mode: 'columnsToRows', columns: ['c_jan', 'c_feb'], labelId: 'x_month', valueId: 'x_amount', valueType: 'decimal', skipEmpty: true },
        },
        output: { columns: [{ header: 'חודש', from: 'x_month' }, { header: 'ערך', from: 'x_amount' }] },
      }),
    );
    expect(line(model, 'input:stopAt')).toBe("עצירת הקריאה בשורה הראשונה שמתחילה ב-'סה\"כ' או 'Total'");
    expect(line(model, 'filter:0')).toBe("שמירת שורות שבהן סטטוס שונה מ-'מבוטל'");
    expect(line(model, 'filter:1')).toBe('שמירת שורות שבהן סכום יותר מ-0');
    expect(line(model, 'filter:2')).toBe("שמירת שורות שבהן סטטוס שווה לאחד מ-'A', 'B' או 'C'");
    expect(line(model, 'filter:3')).toBe('שמירת שורות שבהן שם ללא ערך');
    expect(line(model, 'dedupe')).toBe('שורות עם אותם ערכים בעמודות מספר הזמנה וספק: שמירת הראשונה וסימון האחרות ככפילויות');
    expect(line(model, 'expand')).toBe('הפיכת העמודות ינואר ופברואר לשורות נפרדות: שם העמודה נכנס לעמודה חודש והערך לעמודה ערך (תאים ריקים מדולגים)');
  });

  it('uses the singular for one duplicate key', () => {
    const model = he(rules({ transform: { dedupe: { keys: ['c_order'], keep: 'last', action: 'remove' } } }));
    expect(line(model, 'dedupe')).toBe('שורות עם אותו ערך בעמודה מספר הזמנה: שמירת האחרונה והסרת הקודמות');
  });

  it('says what a column reads as another value (readAs)', () => {
    const columns = INPUT_COLUMNS.map((c) => (c.id === 'c_amount' ? { ...c, readAs: { 'N/A': '', '-': '0' } } : c));
    const model = he(rules({ input: { columns } }));
    expect(line(model, 'readAs:c_amount:N/A')).toBe("בעמודה סכום, 'N/A' נקרא כריק");
    expect(line(model, 'readAs:c_amount:-')).toBe("בעמודה סכום, '-' נקרא כ-'0'");
  });
});

describe('layout', () => {
  const layout = (patch: Patch = {}): LearnResult =>
    rules({
      ...patch,
      output: {
        columns: [
          { header: 'ספק', from: 'c_supplier' },
          { header: 'תאריך', from: 'c_date' },
          { header: 'פריטים', from: 'c_items' },
          { header: 'סכום', from: 'c_amount' },
        ],
        ...patch.output,
      },
    });

  it('sorts, groups and summarizes', () => {
    const model = he(
      layout({
        transform: {
          sort: [{ column: 'c_supplier', dir: 'asc' }, { column: 'c_date', dir: 'desc' }],
          group: {
            by: 'c_supplier',
            showDetailRows: true,
            blankRowsAfter: 1,
            summaryRows: [{ label: 'סה"כ', cells: { פריטים: 'count', סכום: 'sum' } }],
          },
        },
        output: { summaryRows: [{ label: 'סה"כ כללי', bold: true, cells: { סכום: 'sum' } }] },
      }),
    );
    expect(line(model, 'sort')).toBe('מיון לפי ספק, ואז תאריך (מהחדש לישן)');
    expect(line(model, 'group')).toBe('קיבוץ שורות לפי ספק (כל השורות מוצגות)');
    expect(line(model, 'summary:group:0')).toBe("אחרי כל ספק: שורה 'סה\"כ' עם הספירה של פריטים והסכום של סכום");
    expect(line(model, 'blank:group')).toBe('השארת שורה ריקה אחת אחרי כל ספק');
    expect(line(model, 'summary:end:0')).toBe("בסוף: שורה 'סה\"כ כללי' עם הסכום של סכום, מודגשת");
  });

  it('writes titles', () => {
    const model = he(
      layout({
        output: {
          titleRows: [
            { parts: [{ text: 'דוח ל-' }, { agg: 'max', column: 'c_date', format: 'MMMM YYYY' }], bold: true },
            { blank: true },
          ],
        },
      }),
    );
    expect(line(model, 'title:0')).toBe("כותרת: 'דוח ל-' + החודש של הערך המאוחר ביותר בעמודה תאריך (MMMM YYYY), מודגשת");
    expect(line(model, 'title:1')).toBe('שורה ריקה');
  });

  it('writes the output file', () => {
    const file = (f: NonNullable<LearnResult['output']['file']>): string => line(he(rules({ output: { file: f } })), 'file');
    expect(line(he(rules({ output: { direction: 'rtl', sheetName: 'מכירות' } })), 'file')).toBe("קובץ Excel, גיליון 'מכירות', מימין לשמאל");
    expect(file({ type: 'txt', delimiter: '\t', header: false, encoding: 'windows1255' })).toBe('קובץ טקסט מופרד בטאבים, ללא שורת כותרת, Windows-1255');
    expect(file({ type: 'csv' })).toBe('קובץ טקסט מופרד בפסיקים (CSV), עם שורת כותרת, UTF-8 with BOM');
  });
});

describe('checks and functions', () => {
  const check = (v: LearnResult['validations'][number]): string => line(he(rules({ validations: [v] })), 'check:0');

  it('writes checks without depending on the gender of the column name', () => {
    expect(check({ column: 'c_order', rule: 'israeliIdChecksum', severity: 'flag' })).toBe('בדיקה: הערך בעמודה מספר הזמנה הוא מספר זהות ישראלי תקין (לסמן)');
    expect(check({ column: 'c_amount', rule: 'range', min: 0, severity: 'block' })).toBe('בדיקה: הערך בעמודה סכום הוא לפחות 0 (להשמיט)');
    expect(check({ column: 'c_name', rule: 'required', severity: 'flag' })).toBe('בדיקה: הערך בעמודה שם אינו ריק (לסמן)');
    expect(check({ column: 'c_order', rule: 'unique', severity: 'flag' })).toBe('בדיקה: אין ערכים כפולים בעמודה מספר הזמנה (לסמן)');
  });

  it('writes functions and tables', () => {
    const rows = Array.from({ length: 12 }, (_, i) => [`k${i}`, 'x', i]);
    const model = he(
      rules({
        transform: {
          functions: [{ name: 'pct', params: [{ name: 'base', type: 'decimal' }, { name: 'rate', type: 'decimal' }], returns: 'decimal', body: { op: 'round', digits: 2, arg: mul({ param: 'base' }, { param: 'rate' }) } }],
          tables: [{ name: 'rates', columns: ['code', 'category', 'rate'], rows }],
        },
      }),
    );
    expect(line(model, 'fn:pct')).toBe('pct(base, rate) = round(base × rate, 2)');
    expect(line(model, 'table:rates')).toBe("טבלה 'rates': 12 רשומות, חיפוש לפי code להחזרת category ו-rate");
  });
});

it('keeps the fixture ids out of Hebrew sentences too', () => {
  const model = he(rules({ output: { columns: INPUT_COLUMNS.map((c) => ({ header: c.header, from: c.id })) } }));
  for (const [, text] of lineTexts(model)) expect(text).not.toMatch(/\bc_/);
});
