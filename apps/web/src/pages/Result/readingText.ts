// What a reading says, in the rules map's own words (SPEC 8.11): the reading's fragment is applied to the rules and the column is described
// as the map describes it - "fixed value '00'", "the first 2 characters of Employee number" - and the part after the arrow is the reading.
// So a new kind of reading needs no copy here: whatever its rule says, the map can say. The one exception is a reading that only changes the
// format a date column is read with (the day/month order, SPEC 21 v12 item 16): the map's sentence for the column is the same either way, so
// it is said from the format - "day/month (31/01)" - with an example that shows which part is the day.
import type { AmbiguousColumn } from '@formatai/engine';
import { applyReading, type EditableRules } from '../../editor';
import { translate, type Lang } from '../../i18n';
import { describeRules, type Part, type RulesTextLang } from '../../rulesText';

/**
 * A day/month format said as its order and a date that shows it: "DD/MM/YYYY" is day/month (31/01), "MM/DD/YYYY" month/day (01/31), "D.M.YY"
 * day/month (31.1). Null for a format that does not have one numeric day and one numeric month.
 */
export function dayMonthParts(format: string, lang: Lang): Part[] | null {
  const tokens = [...format.matchAll(/D{1,2}|M{1,2}/g)];
  if (tokens.length !== 2) return null;
  const [first, second] = tokens as [RegExpMatchArray, RegExpMatchArray];
  if (first[0][0] === second[0][0]) return null;
  const example = format.slice(first.index!, second.index! + second[0].length).replace(/D{1,2}|M{1,2}/g, (token) => (token[0] === 'D' ? '31' : token.length === 2 ? '01' : '1'));
  const order = translate(lang, first[0][0] === 'D' ? 'ask.order.dayMonth' : 'ask.order.monthDay');
  return [
    { kind: 'text', text: `${order} ` },
    { kind: 'value', text: `(${example})` },
  ];
}

/** The reading's rule as styled pieces (what follows the arrow of the column's line), or null when the reading cannot be applied to these rules. */
export function readingParts(rules: EditableRules, column: AmbiguousColumn, index: number, lang: RulesTextLang): Part[] | null {
  const applied = applyReading(rules, column, index, false);
  if (applied === null) return null;
  const change = column.readings[index]?.fragment.dateFormats?.[0];
  if (change) return dayMonthParts(change.to, lang) ?? [{ kind: 'value', text: change.to }];
  const line = describeRules(applied, { lang })
    .sections.find((s) => s.id === 'columns')
    ?.lines.find((l) => l.target.kind === 'column' && l.target.header === column.header);
  if (!line) return null;
  const arrow = line.parts.findIndex((p) => p.kind === 'arrow');
  if (arrow < 0) return null;
  const body = line.parts.slice(arrow + 1);
  const first = body[0];
  if (first && first.kind === 'text') body[0] = { ...first, text: first.text.replace(/^\s+/, '') };
  return body.filter((p) => !(p.kind === 'text' && p.text === ''));
}
