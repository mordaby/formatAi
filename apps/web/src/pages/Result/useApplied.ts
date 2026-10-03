// "Applied · now matches 25 of 30 rows": after an edit, the lines it changed say so for a few seconds, with what the live check now
// says, so the user sees that the change landed (there is no Apply button to press) and what it did. Nothing here is saved by it:
// saving is the header's button, and "Unsaved changes" sits next to it while the rules differ from the saved ones.
import { useEffect, useRef, useState } from 'react';
import { editedLines, type EditableRules, type UseLiveCheck } from '../../editor';
import { useI18n } from '../../i18n';

/** How long the confirmation stays, and how much of that is the fade (no fade for reduced motion: the CSS turns transitions off). */
export const APPLIED_MS = 4500;
export const APPLIED_FADE_MS = 500;

export interface AppliedNote {
  /** The lines the edit changed. */
  ids: ReadonlySet<string>;
  text: string;
  fading: boolean;
}

interface Pending {
  ids: Set<string>;
  /** The revision of the rules right after the edit: a check for this revision or a later one tells what the edit did. */
  rev: number;
}

export function useApplied({ rules, rev, check, hasExample }: { rules: EditableRules; rev: number; check: UseLiveCheck; hasExample: boolean }): AppliedNote | null {
  const { t, lang } = useI18n();
  const previous = useRef<EditableRules | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [fading, setFading] = useState(false);

  // Any change of the rules (an edit, an undo, a redo) - not a change of the rows marked "by hand", which has its own line.
  useEffect(() => {
    const before = previous.current;
    previous.current = rules;
    if (before === null || before === rules) return;
    setFading(false);
    setPending({ ids: editedLines(before, rules), rev });
    // `rev` is read for the same render as `rules`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules]);

  const s = check.state;
  const answered = pending !== null && (hasExample ? s.liveRev !== null && s.liveRev >= pending.rev : s.staticRev !== null && s.staticRev >= pending.rev);
  // A change that broke a rule is answered by the problems the strip lists, not by "Applied".
  const ready = answered && check.problems.length === 0 && (!hasExample || s.live !== null);
  const key = ready && pending ? pending.rev : null;

  useEffect(() => {
    if (key === null) return;
    const fade = setTimeout(() => setFading(true), APPLIED_MS - APPLIED_FADE_MS);
    const end = setTimeout(() => {
      setPending(null);
      setFading(false);
    }, APPLIED_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(end);
    };
  }, [key]);

  if (!ready || !pending || pending.ids.size === 0) return null;
  const live = s.live;
  const number = (n: number): string => n.toLocaleString(lang === 'he' ? 'he-IL' : 'en-US');
  let text: string;
  if (!hasExample || !live) text = t('applied.noExample');
  else if (live.partial) text = t('applied.sample', { matched: number(live.matched), total: number(live.total) });
  else if (live.matched >= live.total && live.differences > 0) text = t(live.differences === 1 ? 'applied.differences.one' : 'applied.differences.other', { n: number(live.differences) });
  else text = t('applied.matches', { matched: number(live.matched), total: number(live.total) });
  return { ids: pending.ids, text, fading };
}
