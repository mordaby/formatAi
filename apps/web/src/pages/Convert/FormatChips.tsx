// A label and the names of formats as small chips: "Feeds: Load file, ERP load" under a source (SPEC 8.15), and "Affects: ..." in
// the steps that stop or ask because the file's structure changed - so the user sees every format a change touches.
import { Cell } from '../../components/Cell';
import type { MessageKey } from '../../i18n';
import { useI18n } from '../../i18n';

export interface FormatChipsProps {
  label: MessageKey;
  formats: readonly string[];
  testId?: string;
}

export function FormatChips({ label, formats, testId }: FormatChipsProps) {
  const { t } = useI18n();
  if (formats.length === 0) return null;
  return (
    <div className="src__formats" data-testid={testId}>
      <span className="muted">{t(label)}</span>
      <ul className="chips chips--plain" aria-label={t(label)}>
        {formats.map((name, i) => (
          <li key={`${i}|${name}`}>
            <Cell value={name} />
          </li>
        ))}
      </ul>
    </div>
  );
}
