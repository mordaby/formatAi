// What became of the fixes the user kept as rules in the row review ("Do this every time?", SPEC 5 C, 8.4a), told once the file is made:
// each text and what it is now read as, the version it was saved as (visible in the editor's versions; restoring the one before it undoes
// it), how many other formats of the source got it - or that it could not be saved, and the fix was still used for this file.
import { useI18n } from '../../i18n';
import { InlineMessage } from '../../ui';
import { isolate } from './logic';
import type { KeptRules } from './useConvertFlow';

export function KeptRulesNotice({ kept }: { kept: readonly KeptRules[] }) {
  const { t } = useI18n();
  if (kept.length === 0) return null;
  return (
    <div data-testid="kept-rules">
      {kept.map((k, i) =>
        k.saved ? (
          <InlineMessage key={i} tone="info" title={t('conv.kept.title')}>
            <ul>
              {k.fixes.map((f) => (
                <li key={`${f.columnId}|${f.from}`} data-testid="kept-fix">
                  {t(f.to === '' ? 'conv.kept.empty' : 'conv.kept.value', { from: isolate(f.from), column: isolate(f.header), to: isolate(f.to) })}
                </li>
              ))}
            </ul>
            <p className="muted">{t('conv.kept.version', { version: k.saved.version, format: isolate(k.formatName) })}</p>
            {k.saved.others > 0 ? <p className="muted">{t(k.saved.others === 1 ? 'edit.sourceChange.done.one' : 'edit.sourceChange.done.other', { n: k.saved.others })}</p> : null}
          </InlineMessage>
        ) : (
          <InlineMessage key={i} tone="warn" title={t('conv.kept.failed.title')}>
            {t('conv.kept.failed')}
          </InlineMessage>
        ),
      )}
    </div>
  );
}
