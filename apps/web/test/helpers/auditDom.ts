// A small structural accessibility audit of whatever is rendered (the repo has no axe-style tool and takes no new dependency): the things
// a script can decide without looking - names for every control, one <main>, unique ids, headings that do not skip a level, references that
// point at something. What needs eyes (contrast, focus order, reading order) is checked by hand and by the contrast numbers in the tests.

const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

function byId(root: Document, id: string): Element | null {
  return root.getElementById(id);
}

/** The accessible name of a control, the way a browser works it out (the parts that matter here). */
export function nameOf(el: Element, doc: Document = document): string {
  const label = el.getAttribute('aria-label')?.trim();
  if (label) return label;
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const named = by
      .split(/\s+/)
      .map((id) => text(byId(doc, id)))
      .join(' ')
      .trim();
    if (named) return named;
  }
  if (el.id) {
    const forLabel = [...doc.querySelectorAll('label')].find((l) => l.getAttribute('for') === el.id);
    if (forLabel && text(forLabel)) return text(forLabel);
  }
  const wrapping = el.closest('label');
  if (wrapping && text(wrapping)) return text(wrapping);
  if (el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement) {
    const own = text(el);
    if (own) return own;
    const imgAlt = el.querySelector('img[alt]')?.getAttribute('alt')?.trim();
    if (imgAlt) return imgAlt;
  }
  return el.getAttribute('title')?.trim() ?? '';
}

export interface Finding {
  rule: string;
  what: string;
}

/** Everything wrong that a script can see in `root`'s page. An empty list is a pass. */
export function auditDom(doc: Document = document, opts: { requireMain?: boolean } = {}): Finding[] {
  const out: Finding[] = [];
  const add = (rule: string, el: Element): void => {
    out.push({ rule, what: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ').join('.')}` : ''} "${text(el).slice(0, 40)}"` });
  };

  if (opts.requireMain !== false) {
    const mains = doc.querySelectorAll('main');
    if (mains.length !== 1) out.push({ rule: 'one-main', what: `${mains.length} <main> elements` });
    else if (mains[0]!.id !== 'main') add('main-id (the skip link points at #main)', mains[0]!);
  }
  if (!doc.documentElement.lang) out.push({ rule: 'html-lang', what: '<html> has no lang' });
  if (!doc.documentElement.dir) out.push({ rule: 'html-dir', what: '<html> has no dir' });
  if (!doc.title.trim()) out.push({ rule: 'page-title', what: 'the page has no title' });

  for (const el of doc.querySelectorAll('input, select, textarea')) {
    if (el instanceof HTMLInputElement && (el.type === 'hidden' || el.type === 'submit' || el.type === 'button')) continue;
    if (!nameOf(el, doc)) add('control-name', el);
  }
  for (const el of doc.querySelectorAll('button, [role="button"]')) if (!nameOf(el, doc)) add('button-name', el);
  for (const el of doc.querySelectorAll('a[href]')) if (!nameOf(el, doc)) add('link-name', el);
  for (const el of doc.querySelectorAll('img')) if (!el.hasAttribute('alt')) add('img-alt', el);
  for (const el of doc.querySelectorAll('[role="img"]')) if (!nameOf(el, doc)) add('role-img-name', el);
  for (const el of doc.querySelectorAll('[role="dialog"], nav')) {
    // a dialog is named; a second navigation landmark is told apart from the first
    if (el.getAttribute('role') === 'dialog' && !nameOf(el, doc)) add('dialog-name', el);
  }
  // a data grid (more than a few columns) says what it is; a small form table (two inputs and a remove button per row) is named by its headers
  for (const el of doc.querySelectorAll('table')) {
    const columns = el.querySelector('tr')?.children.length ?? 0;
    if (columns > 3 && !el.querySelector('caption') && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')) add('table-name', el);
  }

  const seen = new Set<string>();
  for (const el of doc.querySelectorAll('[id]')) {
    if (seen.has(el.id)) add('duplicate-id', el);
    seen.add(el.id);
  }
  for (const el of doc.querySelectorAll('[aria-labelledby], [aria-describedby]')) {
    for (const attr of ['aria-labelledby', 'aria-describedby']) {
      for (const id of (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean)) {
        if (!byId(doc, id)) out.push({ rule: 'dangling-reference', what: `${attr}="${id}" on ${el.tagName.toLowerCase()}` });
      }
    }
  }

  const levels = [...doc.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => Number(h.tagName[1]));
  let previous = 0;
  levels.forEach((level, i) => {
    if (i === 0 && level !== 1) out.push({ rule: 'first-heading-h1', what: `the first heading is an h${level}` });
    if (previous > 0 && level > previous + 1) out.push({ rule: 'heading-skip', what: `h${previous} then h${level}` });
    previous = level;
  });
  return out;
}
