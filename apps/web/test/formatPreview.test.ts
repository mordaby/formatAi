import { describe, expect, it } from 'vitest';
import { formatPreview, isDateFormat } from '../src/pages/Result/formatPreview';

describe('formatPreview (the column editor\'s preview of a number or date format)', () => {
  it('formats numbers the way Excel would', () => {
    expect(formatPreview('#,##0.00', 1234.5)).toBe('1,234.50');
    expect(formatPreview('#,##0', 1234.5)).toBe('1,235');
    expect(formatPreview('0.00', 0.5)).toBe('0.50');
    expect(formatPreview('0', 41.6)).toBe('42');
    expect(formatPreview('0.00%', 0.256)).toBe('25.60%');
    expect(formatPreview('"₪"#,##0.00', 99)).toBe('₪99.00');
  });

  it('formats an ISO date with the tokens of the rules language, month names in the output language', () => {
    expect(formatPreview('DD/MM/YYYY', '2024-03-05')).toBe('05/03/2024');
    expect(formatPreview('D.M.YY', '2024-03-05')).toBe('5.3.24');
    expect(formatPreview('MMMM YYYY', '2024-03-05', 'en')).toBe('March 2024');
    expect(formatPreview('MMMM YYYY', '2024-03-05', 'he')).toBe('מרץ 2024');
  });

  it('shows what it cannot format as it is, and empty values as nothing', () => {
    expect(formatPreview(undefined, 12.5)).toBe('12.5');
    expect(formatPreview(undefined, 'text')).toBe('text');
    expect(formatPreview('DD/MM/YYYY', 'not a date')).toBe('not a date');
    expect(formatPreview('0.00', null)).toBe('');
    expect(formatPreview('0.00', '')).toBe('');
    expect(formatPreview(undefined, true)).toBe('TRUE');
  });

  it('tells a date format from a number format', () => {
    expect(isDateFormat('DD/MM/YYYY')).toBe(true);
    expect(isDateFormat('MMMM YYYY')).toBe(true);
    expect(isDateFormat('#,##0.00')).toBe(false);
    expect(isDateFormat(undefined)).toBe(false);
  });
});
