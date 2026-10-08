// What a format that "needs attention" says (SPEC 8.15, 21 v11 items 4-7), in plain words: why it cannot simply be made from this file, and the
// label of the one action that depends on it ("Run anyway (leave 'X' empty)"). Shared by the formats step, the results screen and the
// batch's result and summary, so a format is described the same way wherever it shows up. Pure: no React.
import type { I18n } from '../../i18n';
import { canRunAnyway, isolate, quoteNames, sizeColumnsOf, type Attention } from './logic';
import { fileSizePhrase, savedSizePhrase } from './sizeWords';

/** "Total" in this file is mostly in the tens; this format was learned on thousands to tens of thousands. It says the file LOOKS different, nothing more. */
function sizeLines(i18n: I18n, attention: Attention): string[] {
  return sizeColumnsOf(attention).map((c) => i18n.t('conv.attention.size', { column: quoteNames([c.header]), file: fileSizePhrase(i18n, c.median), saved: savedSizePhrase(i18n, c.saved) }));
}

/** The sentences for one format: why it needs attention, one per line (a format may have several columns whose values changed). */
export function attentionLines(i18n: I18n, formatName: string, attention: Attention): string[] {
  const { t } = i18n;
  if (attention.kind === 'values') {
    return attention.columns.map((c) => t('conv.attention.values', { column: quoteNames([c.header]), type: t(`conv.type.${c.type}` as const) }));
  }
  if (attention.kind === 'size') return sizeLines(i18n, attention);
  const lines = [t(attention.columns.length === 1 ? 'conv.attention.missing.one' : 'conv.attention.missing.other', { format: isolate(formatName), columns: quoteNames(attention.columns) })];
  // A required column is the engine's refusal: say so, so the missing "Run anyway" is no mystery.
  if (attention.required.length > 0) lines.push(t('conv.attention.cannot', { columns: quoteNames(attention.required) }));
  return [...lines, ...sizeLines(i18n, attention)];
}

/** The label of "Run anyway" for this attention; null when the format cannot run without what is missing. */
export function runAnywayLabel(i18n: I18n, attention: Attention): string | null {
  if (!canRunAnyway(attention)) return null;
  if (attention.kind !== 'missing') return i18n.t('conv.attention.anyway');
  return i18n.t(attention.columns.length === 1 ? 'conv.attention.anyway.missing.one' : 'conv.attention.anyway.missing.other', { columns: quoteNames(attention.columns) });
}

/** What a format the user chose to run anyway will do ("Will be made, leaving 'X' empty"). */
export function willRunText(i18n: I18n, attention: Attention): string {
  if (attention.kind !== 'missing') return i18n.t('conv.attention.willRun');
  return i18n.t(attention.columns.length === 1 ? 'conv.attention.willRun.missing.one' : 'conv.attention.willRun.missing.other', { columns: quoteNames(attention.columns) });
}
