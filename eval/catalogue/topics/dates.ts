// Dates: calendar arithmetic, parts and the things the language cannot do with a date.
import { pick, randInt } from '../../cases/lib/prng';
import {
  WEEKDAYS_EN,
  addDays,
  addMonths,
  daysBetween,
  endOfMonthOf,
  randDate,
  rowsOf,
  seqId,
  weekdayOf,
  yearsBetween,
} from '../data';
import { defineType, type CatalogueType, type Ymd } from '../types';

const DMY = 'DD/MM/YYYY';
const d = (v: unknown): Ymd => v as Ymd;

const addMonthsType = defineType({
  id: 'dates.add-months',
  topic: 'dates',
  title: 'Add months to a date',
  description: 'A contract ends 6 months after it starts (end of month days clamp: 31 Aug + 6 months = 28 Feb).',
  lang: 'en',
  input: [
    { id: 'contract', header: 'Contract', type: 'text' },
    { id: 'start', header: 'Start date', type: 'date' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ contract: seqId('CT-', 100 + i, 4), start: randDate(g.rng, 2024, 2026, true) })),
  outputs: [
    { header: 'Contract', from: 'contract' },
    { header: 'Start date', from: 'start', format: DMY },
    { header: 'End date', formula: 'dateAdd(start, 6, "months")', type: 'date', format: DMY, value: (r) => addMonths(d(r.start), 6) },
  ],
  rule: {},
});

const addDaysType = defineType({
  id: 'dates.add-days',
  topic: 'dates',
  title: 'Add days to a date',
  description: 'The due date is the invoice date plus 30 days.',
  lang: 'he',
  input: [
    { id: 'inv', header: 'חשבונית', type: 'text' },
    { id: 'date', header: 'תאריך חשבונית', type: 'date' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ inv: seqId('H-', 100 + i, 4), date: randDate(g.rng, 2025, 2026, true) })),
  outputs: [
    { header: 'חשבונית', from: 'inv' },
    { header: 'תאריך חשבונית', from: 'date', format: DMY },
    { header: 'תאריך פירעון', formula: 'dateAdd(date, 30, "days")', type: 'date', format: DMY, value: (r) => addDays(d(r.date), 30) },
  ],
  rule: {},
});

const daysBetweenType = defineType({
  id: 'dates.days-between',
  topic: 'dates',
  title: 'Days between two dates',
  description: 'The duration of a project in days, from its start date to its end date.',
  lang: 'en',
  input: [
    { id: 'project', header: 'Project', type: 'text' },
    { id: 'start', header: 'Start', type: 'date' },
    { id: 'end', header: 'End', type: 'date' },
  ],
  generate: (g) =>
    rowsOf(g, (i) => {
      const start = randDate(g.rng, 2025, 2026, true);
      return { project: seqId('PR-', 10 + i, 3), start, end: addDays(start, randInt(g.rng, 1, 400)) };
    }),
  outputs: [
    { header: 'Project', from: 'project' },
    { header: 'Start', from: 'start', format: DMY },
    { header: 'End', from: 'end', format: DMY },
    { header: 'Days', formula: 'dateDiff(start, end, "days")', type: 'integer', value: (r) => daysBetween(d(r.start), d(r.end)) },
  ],
  rule: {},
});

const endOfMonthType = defineType({
  id: 'dates.end-of-month',
  topic: 'dates',
  title: 'End of month',
  description: 'Payment terms "end of month": the due date is the last day of the invoice month.',
  lang: 'en',
  input: [
    { id: 'inv', header: 'Invoice', type: 'text' },
    { id: 'date', header: 'Invoice date', type: 'date' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ inv: seqId('INV-', 300 + i, 4), date: randDate(g.rng, 2025, 2026, true) })),
  outputs: [
    { header: 'Invoice', from: 'inv' },
    { header: 'Invoice date', from: 'date', format: DMY },
    { header: 'Due date', formula: 'endOfMonth(date)', type: 'date', format: DMY, value: (r) => endOfMonthOf(d(r.date)) },
  ],
  rule: {},
});

const partsType = defineType({
  id: 'dates.year-month-day-parts',
  topic: 'dates',
  title: 'Year, month and day as separate columns',
  description: 'A date is split into three number columns: year, month, day.',
  lang: 'he',
  input: [
    { id: 'doc', header: 'מסמך', type: 'text' },
    { id: 'date', header: 'תאריך', type: 'date' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ doc: seqId('D-', 100 + i, 4), date: randDate(g.rng, 2024, 2026, true) })),
  outputs: [
    { header: 'מסמך', from: 'doc' },
    { header: 'שנה', formula: 'datePart(date, "year")', type: 'integer', value: (r) => d(r.date).y },
    { header: 'חודש', formula: 'datePart(date, "month")', type: 'integer', value: (r) => d(r.date).m },
    { header: 'יום', formula: 'datePart(date, "day")', type: 'integer', value: (r) => d(r.date).d },
  ],
  rule: {},
});

const fiscalQuarter = defineType({
  id: 'dates.fiscal-quarter',
  topic: 'dates',
  title: 'Fiscal quarter (year starts in April)',
  description: 'The quarter label of a date in a fiscal year that starts in April (April-June = Q1). The inline arithmetic version needs expression depth 10 (the limit is 8), so the reference rule uses a month table.',
  lang: 'en',
  input: [
    { id: 'txn', header: 'Transaction', type: 'text' },
    { id: 'date', header: 'Date', type: 'date' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ txn: seqId('T', 100 + i, 4), date: randDate(g.rng, 2025, 2026, true) })),
  outputs: [
    { header: 'Transaction', from: 'txn' },
    { header: 'Date', from: 'date', format: DMY },
    {
      header: 'Fiscal quarter',
      formula: 'lookup("fiscal", datePart(date, "month"), "quarter")',
      value: (r) => `Q${Math.floor(((d(r.date).m - 4 + 12) % 12) / 3) + 1}`,
    },
  ],
  rule: { transform: { tables: [{ name: 'fiscal', columns: ['month', 'quarter'], rows: Array.from({ length: 12 }, (_, i) => [i + 1, `Q${Math.floor(((i + 1 - 4 + 12) % 12) / 3) + 1}`]) }] } },
});

const ageYears = defineType({
  id: 'dates.age-in-years',
  topic: 'dates',
  title: 'Age in whole years between two date columns',
  description: 'The age of a customer in complete years, from the birth date to the statement date column.',
  lang: 'he',
  input: [
    { id: 'name', header: 'שם', type: 'text' },
    { id: 'birth', header: 'תאריך לידה', type: 'date' },
    { id: 'asof', header: 'תאריך דוח', type: 'date' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ name: `${pick(g.rng, ['דנה', 'יוסי', 'מאיה', 'עומר', 'שירה'])} ${i + 1}`, birth: randDate(g.rng, 1950, 2005, true), asof: { y: 2026, m: 9, d: 30 } })),
  outputs: [
    { header: 'שם', from: 'name' },
    { header: 'תאריך לידה', from: 'birth', format: DMY },
    { header: 'גיל', formula: 'dateDiff(birth, asof, "years")', type: 'integer', value: (r) => yearsBetween(d(r.birth), d(r.asof)) },
  ],
  rule: {},
});

const weekdayName = defineType({
  id: 'dates.weekday-name',
  topic: 'dates',
  title: 'Weekday name of a date',
  description: 'The weekday ("Monday") of each delivery date.',
  lang: 'en',
  input: [
    { id: 'delivery', header: 'Delivery', type: 'text' },
    { id: 'date', header: 'Date', type: 'date' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ delivery: seqId('DL', 100 + i, 4), date: randDate(g.rng, 2025, 2026, true) })),
  outputs: [
    { header: 'Delivery', from: 'delivery' },
    { header: 'Date', from: 'date', format: DMY },
    { header: 'Weekday', value: (r) => WEEKDAYS_EN[weekdayOf(d(r.date))] ?? null },
  ],
  rule: null,
  missing: { capability: 'weekday', detail: 'datePart has year/month/day only; counting days from a known Sunday needs a date constant, which expressions cannot hold' },
});

const daysToFixed = defineType({
  id: 'dates.days-to-fixed-date',
  topic: 'dates',
  title: 'Days until a fixed date',
  description: 'How many days remain from each invoice date to the fiscal year end, 31/12/2026.',
  lang: 'he',
  input: [
    { id: 'inv', header: 'חשבונית', type: 'text' },
    { id: 'date', header: 'תאריך', type: 'date' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ inv: seqId('H-', 500 + i, 4), date: randDate(g.rng, 2026, 2026, true) })),
  outputs: [
    { header: 'חשבונית', from: 'inv' },
    { header: 'תאריך', from: 'date', format: DMY },
    { header: 'ימים לסוף שנה', value: (r) => daysBetween(d(r.date), { y: 2026, m: 12, d: 31 }) },
  ],
  rule: null,
  missing: {
    capability: 'dateLiteral',
    detail: 'dateDiff needs two date operands; a constant is a string, number, boolean or null, never a date, and there is no clock',
    workaround: 'when the fixed date is also a column of the input file, dateDiff against that column',
  },
});

const parseMonthName = defineType({
  id: 'dates.parse-month-name',
  topic: 'dates',
  title: 'Parse a date written with a month name',
  description: 'Dates typed as text with the month in words ("5 September 2026") become real dates.',
  lang: 'en',
  input: [
    { id: 'event', header: 'Event', type: 'text' },
    { id: 'date', header: 'Event date', type: 'date', dateAs: 'D MMMM YYYY' },
  ],
  generate: (g) => rowsOf(g, (i) => ({ event: seqId('EV', 10 + i, 3), date: randDate(g.rng, 2025, 2026) })),
  outputs: [
    { header: 'Event', from: 'event' },
    { header: 'Event date', from: 'date', format: DMY },
  ],
  rule: null,
  missing: {
    capability: 'monthNameParse',
    detail: 'input date formats are numeric tokens (D, M, YYYY ...); "September" is never read as a month (checked: inputFormats ["D MMMM YYYY"] leaves the text unparsed and flags it)',
    workaround: 'a value map from the month name to its number, then concat into ISO text (text, not a date value)',
  },
});

const dateFromParts = defineType({
  id: 'dates.date-from-parts',
  topic: 'dates',
  title: 'Build a date from day, month and year columns',
  description: 'Three number columns (day, month, year) become one real date.',
  lang: 'he',
  input: [
    { id: 'doc', header: 'מסמך', type: 'text' },
    { id: 'day', header: 'יום', type: 'integer' },
    { id: 'month', header: 'חודש', type: 'integer' },
    { id: 'year', header: 'שנה', type: 'integer' },
  ],
  generate: (g) =>
    rowsOf(g, (i) => {
      const x = randDate(g.rng, 2024, 2026);
      return { doc: seqId('D-', 700 + i, 4), day: x.d, month: x.m, year: x.y };
    }),
  outputs: [
    { header: 'מסמך', from: 'doc' },
    { header: 'תאריך', format: DMY, value: (r) => ({ y: r.year as number, m: r.month as number, d: r.day as number }) },
  ],
  rule: null,
  missing: {
    capability: 'makeDate',
    detail: 'three numbers can be joined into ISO text, but typeCheck rejects text where a date is declared (the runtime itself would coerce it: checked with typeCheck bypassed)',
    workaround: 'concat(year, "-", padLeft(month, 2, "0"), "-", padLeft(day, 2, "0")) as TEXT',
  },
});

export const DATES: CatalogueType[] = [addMonthsType, addDaysType, daysBetweenType, endOfMonthType, partsType, fiscalQuarter, ageYears, weekdayName, daysToFixed, parseMonthName, dateFromParts];
