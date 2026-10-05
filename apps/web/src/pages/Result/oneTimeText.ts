// What a one-time question says, in the rules map's own words (SPEC 8.11, 21 v12 item 20): "Row 54: Discount is 0 instead of <the rest of
// the rule>" - the rest is the column's rule with the part taken out, described as the map describes the column (the part after the arrow),
// so whatever the rule is, the question can say it.
import type { OneTimeQuestion } from '@formatai/engine';
import { withoutRulePart } from '@formatai/shared';
import type { EditableRules } from '../../editor';
import { describeRules, type Part, type RulesTextLang } from '../../rulesText';

/** The column's rule without the question's part, as styled pieces (what follows the arrow of its line); null when the part is not in these rules. */
export function restParts(rules: EditableRules, q: OneTimeQuestion, lang: RulesTextLang): Part[] | null {
  const without = withoutRulePart(rules, q.part);
  if (without === null) return null;
  const line = describeRules(without, { lang })
    .sections.find((s) => s.id === 'columns')
    ?.lines.find((l) => l.target.kind === 'column' && l.target.header === q.header);
  if (!line) return null;
  const arrow = line.parts.findIndex((p) => p.kind === 'arrow');
  if (arrow < 0) return null;
  const body = line.parts.slice(arrow + 1);
  const first = body[0];
  if (first && first.kind === 'text') body[0] = { ...first, text: first.text.replace(/^\s+/, '') };
  return body.filter((p) => !(p.kind === 'text' && p.text === ''));
}
