import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../../i18n';
import { legalDocs, type LegalBlock, type LegalPageId } from '../../i18n/legal';
import { fillLegal, legalParams } from './params';

// `[text](/path)` is an internal link, `[text](https://...)` an outside one; a bare email address becomes a mailto link.
const INLINE = /\[([^\]]+)\]\(([^)\s]+)\)|([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g;

/** A paragraph's text with its links. Emails are left-to-right inside a right-to-left sentence (`<bdi>`). */
export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (m[3]) {
      out.push(
        <a key={key++} href={`mailto:${m[3]}`}>
          <bdi>{m[3]}</bdi>
        </a>,
      );
    } else if (m[2]!.startsWith('/')) {
      out.push(
        <Link key={key++} to={m[2]!}>
          {m[1]}
        </Link>,
      );
    } else {
      out.push(
        <a key={key++} href={m[2]} rel="noreferrer">
          {m[1]}
        </a>,
      );
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.map((node, i) => <Fragment key={i}>{node}</Fragment>);
}

/**
 * A legal page (SPEC 15 "Legal pages", 16.1 screen 8): the privacy policy, the terms, the accessibility statement. The text is in
 * `i18n/legal.ts` (DRAFTS that need the owner's or a lawyer's review, see there); this only lays it out: the title and when it changed, a
 * contents list that jumps to each section, and the sections.
 */
export function LegalPage({ id }: { id: LegalPageId }) {
  const { t, lang } = useI18n();
  const doc = legalDocs[id][lang];
  const params = legalParams(lang, id);
  const fill = (text: string): ReactNode[] => renderInline(fillLegal(text, params));

  const block = (b: LegalBlock, i: number): ReactNode => {
    if ('promise' in b) {
      return (
        <p className="legal__promise" key={i}>
          {fill(b.promise)}
        </p>
      );
    }
    if ('ul' in b) {
      return (
        <ul className="bullets" key={i}>
          {b.ul.map((item, j) => (
            <li key={j}>{fill(item)}</li>
          ))}
        </ul>
      );
    }
    return <p key={i}>{fill(b.p)}</p>;
  };

  return (
    <main id="main" className="page legal" tabIndex={-1}>
      <article className="view legal__article">
        <header className="tool__head">
          <h1>{doc.title}</h1>
          <p className="lead">{fill(doc.intro)}</p>
          <p className="muted">{t('legal.updated', { date: String(params.date) })}</p>
        </header>

        <nav className="legal__toc" aria-labelledby="legal-toc">
          <h2 id="legal-toc" className="legal__toc-title">
            {t('legal.contents')}
          </h2>
          <ol>
            {doc.sections.map((s) => (
              <li key={s.id}>
                <a href={`#legal-${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ol>
        </nav>

        {doc.sections.map((s) => (
          <section className="legal__section" id={`legal-${s.id}`} key={s.id} aria-labelledby={`legal-${s.id}-title`}>
            <h2 id={`legal-${s.id}-title`}>{s.title}</h2>
            {s.blocks.map(block)}
          </section>
        ))}
      </article>
    </main>
  );
}
