import { useI18n, type MessageKey } from '../../i18n';

const MARK = '\u0001';

/**
 * A message that names a column ("The rule for {column} doesn't reproduce your example yet."), with the name in its own `<bdi>` so a
 * Hebrew header inside an English sentence (and the reverse) keeps its order (SPEC 16.2).
 */
export function Named({ id, name, param = 'column' }: { id: MessageKey; name: string; param?: string }) {
  const { t } = useI18n();
  const [before = '', after = ''] = t(id, { [param]: MARK }).split(MARK);
  return (
    <>
      {before}
      <bdi className="sentence__name">{name}</bdi>
      {after}
    </>
  );
}
