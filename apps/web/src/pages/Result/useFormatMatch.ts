// Flow A for a signed-in user (SPEC 5 A2): "This looks like your format X. Add this file as a new source for it?" - found by
// comparing the learned output's headers (in order) and file type with the user's saved formats.
import type { FormatSummary } from '@formatai/shared';
import { useEffect, useMemo, useState } from 'react';
import type { EditableRules } from '../../editor';
import { outputFileType } from '../../flow/download';
import { useServices } from '../../services';
import { compareOutput } from './matchFormat';

/** The first saved format the rules' output looks like, or undefined. A header-less output (SPEC 8.13) has no headers to compare. */
export function findMatchingFormat(formats: readonly FormatSummary[], rules: EditableRules): FormatSummary | undefined {
  if (rules.output.file?.header === false) return undefined;
  const headers = rules.output.columns.map((c) => c.header);
  const fileType = outputFileType(rules);
  return formats.find((f) => compareOutput({ headers: f.outputHeaders ?? [], fileType: f.fileType as 'xlsx' | 'csv' | 'txt' }, { headers, fileType }).length === 0 && headers.length > 0);
}

export function useFormatMatch(enabled: boolean, rules: EditableRules): { format: FormatSummary | undefined; dismissed: boolean; dismiss(): void } {
  const { api } = useServices();
  const [formats, setFormats] = useState<FormatSummary[] | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api.registry
      .listFormats()
      .then((list) => {
        if (live) setFormats(list);
      })
      .catch(() => undefined); // no offer, no harm
    return () => {
      live = false;
    };
  }, [enabled, api]);

  const format = useMemo(() => (enabled && formats ? findMatchingFormat(formats, rules) : undefined), [enabled, formats, rules]);
  return { format, dismissed, dismiss: () => setDismissed(true) };
}
