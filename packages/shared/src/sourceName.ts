// The default name of a new source (SPEC 8.15 "Saving", 21 v11 item 9): the example input file's name, as the user knows it, with what changes from
// one file to the next taken out - "orders 2026-09.xlsx" and "orders 2026-10.xlsx" are the same kind of file, so both give "orders". Pure; the
// browser derives it when a format is saved and the server only makes it unique. Only the file's NAME is read, never a cell.
import { limits } from './config/limits';

/**
 * Month names that go with a number ("Sales Sep 2026", "15 September"), English (full and short) and Hebrew. DECISION: they are taken out
 * only NEXT TO a number: on their own they may be a word of the name ("March Madness", a person called May).
 */
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sept', 'sep', 'oct', 'nov', 'dec',
  'ינואר', 'פברואר', 'מרץ', 'מרס', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
].join('|');
const GAP = String.raw`[\s._\-,]*`;
const MONTH_THEN_NUMBER = new RegExp(String.raw`(^|[^\p{L}\p{M}])(?:${MONTHS})(?![\p{L}\p{M}])(?=${GAP}\p{Nd})`, 'giu');
const NUMBER_THEN_MONTH = new RegExp(String.raw`(\p{Nd}${GAP})(?:${MONTHS})(?![\p{L}\p{M}])`, 'giu');

/** A name ends where its letters and digits do: separators, quotes and a bracket that held only a number are left over, not part of it. */
const LEADING_LEFTOVER = /^[^\p{L}\p{M}\p{N}(\[{]+/u;
const TRAILING_LEFTOVER = /[^\p{L}\p{M}\p{N})\]}]+$/u;

/** Room kept for " (2)" ... " (99999)", which the server adds when another source already has the name. */
const MAX_CHARS = limits.registry.maxNameChars - 8;

/**
 * The name for a source learned from this example input file: the file name without its folder and extension, with every digit run (dates in
 * any order - "2026-09-15", "15.09.2026", "20260915" -, months, counters such as "(1)") and the separators and brackets they leave behind taken
 * out. What was between two digit runs stays as separate words ("orders_2026_items" gives "orders items"); separators inside a word stay.
 * An empty string when nothing is left ("2026-09.xlsx", ".xlsx"): the caller then lets the server name it ("Source N"). Hebrew and any other
 * script work like Latin.
 *
 * DECISION: digits are removed wherever they are, so "Q3 sales" gives "Q sales". A name that keeps a number cannot be told from one that
 * carries the month or the counter of this file, and the user can rename the source (SPEC 8.15).
 */
export function defaultSourceName(fileName: string): string {
  const stem = (fileName.split(/[/\\]/).pop() ?? '')
    .normalize('NFC')
    .replace(/\.[\p{L}\p{N}]{1,8}$/u, '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  const words = stem
    .replace(MONTH_THEN_NUMBER, '$1 ')
    .replace(NUMBER_THEN_MONTH, '$1')
    .split(/\p{Nd}+/u)
    .map((part) => part.replace(LEADING_LEFTOVER, '').replace(TRAILING_LEFTOVER, '').replace(/\s+/g, ' '))
    .filter((part) => part !== '');
  return clip(words.join(' '));
}

/** At most `MAX_CHARS` UTF-16 units, never cutting a character in two, and not ending on a separator. */
function clip(name: string): string {
  if (name.length <= MAX_CHARS) return name;
  let out = '';
  for (const ch of name) {
    if (out.length + ch.length > MAX_CHARS) break;
    out += ch;
  }
  return out.replace(TRAILING_LEFTOVER, '');
}
