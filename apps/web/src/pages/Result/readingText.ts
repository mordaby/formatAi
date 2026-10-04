// What a reading says, in the rules map's own words (SPEC 8.11): the reading's fragment is applied to the rules and the column is described
// as the map describes it - "fixed value '00'", "the first 2 characters of Employee number" - and the part after the arrow is the reading.
// So a new kind of reading needs no copy here: whatever its rule says, the map can say.
import type { AmbiguousColumn } from '@formatai/engine';
import { applyReading, type EditableRules } from '../../editor';
import { describeRules, type Part, type RulesTextLang } from '../../rulesText';

/** The reading's rule as styled pieces (what follows the arrow of the column's line), or null when the reading cannot be applied to these rules. */
export function readingParts(rules: EditableRules, column: AmbiguousColumn, index: number, lang: RulesTextLang): Part[] | null {
  const applied = applyReading(rules, column, index, false);
  if (applied === null) return null;
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
