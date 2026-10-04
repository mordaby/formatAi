// The one quiet line after an AI learn about what code filled in the answer from every row of the example (SPEC 21 v12 item 16; item 15):
// "Completed from your example: 40 lookup entries, 1 cut-off (please confirm the check)". The learn result carries kinds and counts only
// (`FillSummary`), never a value, so this is all the screen can say - and it says no more than that.
import type { FillSummary } from '@formatai/engine';
import type { MessageKey } from '../../i18n';

type Say = (key: MessageKey, params?: Record<string, string | number>) => string;

/** The line, or null when code filled nothing. Each kind in its own words ("40 lookup entries", "1 cut-off"), the order the engine lists them in. */
export function filledNote(filled: FillSummary | undefined, t: Say): string | null {
  const items = (filled?.filled ?? []).filter((f) => f.count > 0).map((f) => t(`filled.${f.kind}.${f.count === 1 ? 'one' : 'other'}` as MessageKey, { n: f.count }));
  if (!filled || items.length === 0) return null;
  const line = t('filled.lead', { items: items.join(', ') });
  // A cut-off the example did not settle became a check the user approves (SPEC 8.8): said, so it is not missed.
  return filled.checks > 0 ? `${line} ${t(filled.checks === 1 ? 'filled.checks.one' : 'filled.checks.other', { n: filled.checks })}` : line;
}
