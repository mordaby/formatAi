import type { Part } from '../../rulesText';

/**
 * A rules-map sentence (`Line.parts`). Names and values go in `<bdi>` so a Hebrew name inside an English sentence (and
 * the reverse) keeps its own order (SPEC 16.2); a formula is one left-to-right run; the arrow points at the target
 * and mirrors in right-to-left.
 */
export function Sentence({ parts }: { parts: readonly Part[] }) {
  return (
    <span className="sentence">
      {parts.map((p, i) => {
        switch (p.kind) {
          case 'text':
            return p.text;
          case 'name':
            return (
              <bdi key={i} className="sentence__name">
                {p.text}
              </bdi>
            );
          case 'value':
            return (
              <bdi key={i} className="sentence__value">
                {p.text}
              </bdi>
            );
          case 'arrow':
            return (
              <span key={i} className="sentence__arrow" aria-hidden="true">
                {'←'}
              </span>
            );
          case 'formula':
            return (
              <span key={i} className="sentence__formula" dir="ltr">
                {p.parts.map((q, k) =>
                  q.kind === 'text' ? (
                    q.text
                  ) : (
                    <bdi key={k} className={q.kind === 'name' ? 'sentence__name' : 'sentence__value'}>
                      {q.text}
                    </bdi>
                  ),
                )}
              </span>
            );
        }
      })}
    </span>
  );
}
