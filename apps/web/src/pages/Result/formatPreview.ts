// A small preview of an Excel-style number or date format (SPEC 8.11 "Every column also has an output number or
// date format, with a preview"). Enough for what the rules language writes (`#,##0.00`, `0.00%`, `DD/MM/YYYY`,
// `MMMM YYYY`), not a full Excel formatter: anything it can't read is shown as it is.
import type { PayloadCell } from '@formatai/shared';

type Language = 'he' | 'en';

const MONTHS: Record<Language, readonly string[]> = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  he: ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'],
};

/** D, M, Y tokens and separators only ("DD/MM/YYYY", "MMMM YYYY"). Number formats never match. */
export const DATE_FORMAT = /^[DMY][DMY\s/.\-,:]*$/;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateFormat(format: string | undefined): boolean {
  return format !== undefined && DATE_FORMAT.test(format);
}

function formatDate(format: string, iso: RegExpExecArray, language: Language): string {
  const year = Number(iso[1]);
  const month = Number(iso[2]);
  const day = Number(iso[3]);
  return format.replace(/YYYY|YY|MMMM|MM|M|DD|D/g, (token) => {
    switch (token) {
      case 'YYYY':
        return String(year);
      case 'YY':
        return String(year % 100).padStart(2, '0');
      case 'MMMM':
        return MONTHS[language][month - 1] ?? String(month);
      case 'MM':
        return String(month).padStart(2, '0');
      case 'M':
        return String(month);
      case 'DD':
        return String(day).padStart(2, '0');
      default:
        return String(day);
    }
  });
}

const NUMBER_CORE = /([#0,]*0[#0,]*)(?:\.([0#]+))?|(#[#,]*)(?:\.([0#]+))?/;

function unquote(text: string): string {
  return text.replace(/"([^"]*)"/g, '$1').replace(/\\(.)/g, '$1');
}

function formatNumber(format: string, value: number): string {
  const m = NUMBER_CORE.exec(format);
  if (!m) return String(value);
  const integerPart = m[1] ?? m[3] ?? '';
  const fraction = m[2] ?? m[4] ?? '';
  const prefix = unquote(format.slice(0, m.index));
  const suffixRaw = format.slice(m.index + m[0].length);
  const percent = suffixRaw.includes('%');
  const suffix = unquote(suffixRaw);
  const zeros = (fraction.match(/0/g) ?? []).length;
  const digits = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: zeros,
    maximumFractionDigits: fraction.length,
    useGrouping: integerPart.includes(','),
  }).format(percent ? value * 100 : value);
  return `${prefix}${digits}${suffix}`;
}

/**
 * How `value` looks with `format`. A date is an ISO `YYYY-MM-DD` text (that is how the check reports dates);
 * `language` is the output's language, which decides the month names. Without a format, numbers and text show as they are.
 */
export function formatPreview(format: string | undefined, value: PayloadCell | undefined, language: Language = 'en'): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (format !== undefined && format !== '') {
    if (typeof value === 'string') {
      const iso = ISO_DATE.exec(value);
      if (iso && isDateFormat(format)) return formatDate(format, iso, language);
      return value;
    }
    if (!isDateFormat(format)) return formatNumber(format, value);
  }
  return typeof value === 'number' ? String(Math.round(value * 1e9) / 1e9) : value;
}
