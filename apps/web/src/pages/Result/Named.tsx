import { Fragment, type ReactNode } from 'react';
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

/** A message with several placeholders, each filled with a piece of the page (a rules-map sentence, a name in its own `<bdi>`): `{rule}` -> `nodes.rule`. */
export function Marked({ id, nodes }: { id: MessageKey; nodes: Readonly<Record<string, ReactNode>> }) {
  const { t } = useI18n();
  const text = t(id, Object.fromEntries(Object.keys(nodes).map((k) => [k, `${MARK}${k}${MARK}`])));
  return (
    <>
      {text.split(MARK).map((piece, i) => (
        // (the odd pieces are the names of placeholders: the text around them is the even ones)
        <Fragment key={i}>{i % 2 === 1 ? nodes[piece] : piece}</Fragment>
      ))}
    </>
  );
}
