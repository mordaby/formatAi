// Static-check problems (SPEC 9.2 layers 1-5) in plain words, each tied to the line of the rules map it is about,
// so a blocked save can say "Column "Total": ..." and the map can mark that line.
//
// Each problem is also said as message keys (`message`: the sentence, `place`: the line it is about), so the UI says it in its own
// language (he/en, `problemText` in pages/Result/LiveCheckStrip.tsx); only the checker's own words a sentence quotes (`message.detail`,
// English: the engine's checkers speak no other) stay English, and are marked so. `where` and `text` are the English sentence.
import type { MessageKey, MessageParams } from '../i18n';
import type { StaticProblem } from '../worker/editorApi';
import { lineIds } from './lines';
import type { EditableRules, LineId } from './types';

/** A sentence (or a place) as an i18n key and its params; `terms`: params that are words of the UI themselves (said in its language). */
export interface ProblemWords {
  key: MessageKey;
  params?: MessageParams;
  terms?: Record<string, MessageKey>;
}

export interface ExplainedProblem {
  layer: StaticProblem['layer'];
  /** Stable code for the UI's own wording: `<layer>.<kind>`. */
  code: string;
  /** The line of the rules map it is about, when it can be told. */
  lineId?: LineId;
  /** What that line is called, e.g. `Column "Total"`. */
  where: string;
  /** One sentence in plain words. */
  text: string;
  /** The checker's own message, for a details view. */
  detail: string;
  path?: string;
  /** The line it is about, in the UI's words (`where`). */
  place: ProblemWords;
  /** The sentence in the UI's words (`text`): `{where}` is the place; `detail`, when the sentence quotes the checker, its own (English) words. */
  message: ProblemWords & { detail?: string };
}

const COMPUTED = /^transform\.computed\[(\d+)\]/;

/** A place: the line it is about, in English (`where`) and as a message key (`place`). */
interface Place {
  lineId?: LineId;
  where: string;
  place: ProblemWords;
}

const placeOf = (where: string, key: MessageKey, params?: MessageParams, lineId?: LineId): Place => ({
  ...(lineId === undefined ? {} : { lineId }),
  where,
  place: params ? { key, params } : { key },
});

function locate(rules: EditableRules, path: string | undefined): Place {
  if (path === undefined || path === '') return placeOf('The rules', 'static.where.rules');
  let m: RegExpMatchArray | null;
  const column = (header: string): Place => placeOf(`Column "${header}"`, 'static.where.column', { name: header }, lineIds.col(header));

  if ((m = path.match(/^output\.columns\[(\d+)\]/))) {
    const col = rules.output.columns[Number(m[1])];
    if (col) return column(col.header);
  }
  if ((m = path.match(COMPUTED))) {
    const c = rules.transform.computed[Number(m[1])];
    const col = c ? rules.output.columns.find((o) => o.from === c.id) : undefined;
    if (col) return column(col.header);
    return c ? placeOf(`The helper "${c.id}"`, 'static.where.helper', { name: c.id }) : placeOf('A helper column', 'static.where.aHelper');
  }
  if ((m = path.match(/^input\.rowFilters\[(\d+)\]/))) return placeOf(`Filter ${Number(m[1]) + 1}`, 'static.where.filter', { n: Number(m[1]) + 1 }, lineIds.filter(Number(m[1])));
  if (path.startsWith('transform.dedupe')) return placeOf('Duplicates', 'static.where.dedupe', undefined, lineIds.dedupe);
  if (path.startsWith('transform.expand')) return placeOf('One row becomes several', 'static.where.expand', undefined, lineIds.expand);
  if (path.startsWith('transform.sort') || path.startsWith('layout.sort')) return placeOf('Sort', 'static.where.sort', undefined, lineIds.sort);
  if ((m = path.match(/^transform\.group\.summaryRows\[(\d+)\]/)))
    return placeOf(`Group summary row ${Number(m[1]) + 1}`, 'static.where.groupSummary', { n: Number(m[1]) + 1 }, lineIds.summaryGroup(Number(m[1])));
  if (path.startsWith('transform.group') || path.startsWith('layout.group')) return placeOf('Groups', 'static.where.groups', undefined, lineIds.group);
  if ((m = path.match(/^output\.summaryRows\[(\d+)\]/))) return placeOf(`Summary row ${Number(m[1]) + 1}`, 'static.where.summary', { n: Number(m[1]) + 1 }, lineIds.summaryEnd(Number(m[1])));
  if ((m = path.match(/^output\.titleRows\[(\d+)\]/))) return placeOf(`Title row ${Number(m[1]) + 1}`, 'static.where.title', { n: Number(m[1]) + 1 }, lineIds.title(Number(m[1])));
  if (path.startsWith('output.titleRows')) return placeOf('The title rows', 'static.where.titles');
  if ((m = path.match(/^validations\[(\d+)\]/))) return placeOf(`Check ${Number(m[1]) + 1}`, 'static.where.check', { n: Number(m[1]) + 1 }, lineIds.check(Number(m[1])));
  if ((m = path.match(/^transform\.functions\[(\d+)\]/))) {
    const fn = rules.transform.functions?.[Number(m[1])];
    if (fn) return placeOf(`Function "${fn.name}"`, 'static.where.function', { name: fn.name }, lineIds.fn(fn.name));
  }
  // (a value map, docs/proposals/saved-format-contents.md section 7: the column that shows it)
  if ((m = path.match(/^transform\.valueMaps\[(\d+)\]/))) {
    const map = rules.transform.valueMaps[Number(m[1])];
    const col = map ? rules.output.columns.find((o) => o.from === map.column) : undefined;
    if (col) return column(col.header);
  }
  if ((m = path.match(/^transform\.tables\[(\d+)\]/))) {
    const t = rules.transform.tables?.[Number(m[1])];
    if (t) return placeOf(`Table "${t.name}"`, 'static.where.table', { name: t.name }, lineIds.table(t.name));
  }
  if (path.startsWith('output.')) return placeOf('The output file', 'static.where.output');
  // (the source lock, SPEC 8.15: a column the file has, as the conversion declares it)
  if ((m = path.match(/^input\.columns\[(\d+)\]/))) {
    const col = rules.input.columns[Number(m[1])];
    if (col) return placeOf(`Input column "${col.header}"`, 'static.where.inputColumn', { name: col.header });
  }
  if (path.startsWith('input.')) return placeOf('The input', 'static.where.input');
  return placeOf('The rules', 'static.where.rules');
}

/** The sentence, in English and as a message key: `{where}` is the place; `detail` the checker's words, quoted as they are. */
function sentence(p: StaticProblem, where: string): { text: string; message: ExplainedProblem['message'] } {
  const m = p.message;
  const quoting = (text: string, key: MessageKey, params?: MessageParams): { text: string; message: ExplainedProblem['message'] } => ({
    text,
    message: { key, ...(params ? { params } : {}), detail: m },
  });
  const saying = (text: string, key: MessageKey, params?: MessageParams): { text: string; message: ExplainedProblem['message'] } => ({
    text,
    message: { key, ...(params ? { params } : {}) },
  });
  switch (p.layer) {
    case 'structure':
      return quoting(`${where} is not valid: ${m}.`, 'static.invalid');
    case 'references': {
      const name = /"(.+)"/.exec(m)?.[1] ?? '';
      if (/unknown column id "(.+)"/.test(m)) return saying(`${where} uses a column ("${name}") that does not exist.`, 'static.unknownColumn', { name });
      if (/unknown output header/.test(m)) return saying(`${where} names a column of the file ("${name}") that does not exist.`, 'static.unknownHeader', { name });
      if (/collides/.test(m)) return saying(`${where} reuses a name that is already taken.`, 'static.collides');
      return quoting(`${where}: ${m}.`, 'static.other');
    }
    case 'types': {
      const mismatch = /^expected (\w+), got (\w+)/.exec(m);
      const need = mismatch ? kindOf(mismatch[1]!) : undefined;
      const got = mismatch ? kindOf(mismatch[2]!) : undefined;
      const text = mismatch ? `${where} mixes up kinds of values: it needs ${article(mismatch[1]!)} but gets ${article(mismatch[2]!)}.` : `${where}: ${m}.`;
      if (need && got) return { text, message: { key: 'static.types', terms: { need: KIND_WORDS[need], got: KIND_WORDS[got] } } };
      return quoting(text, 'static.other');
    }
    case 'limits':
      if (/rules exceeds/.test(m)) return quoting(`${m[0]!.toUpperCase()}${m.slice(1)}. Remove some rules or upgrade.`, 'static.limits.rules');
      // (what one saved format may keep, docs/proposals/saved-format-contents.md section 7: the whole rules file)
      if (/^the rules take/.test(m)) return quoting(`The rules are too big to save: ${m}.`, 'static.limits.save');
      return quoting(`${where} is too big: ${m}.`, 'static.limits');
    case 'formatLock':
      return quoting(`${where} no longer matches the format this source belongs to: ${m}.`, 'static.formatLock');
    case 'sourceLock':
      return quoting(`${where} doesn't match the source you chose: ${m}.`, 'static.sourceLock');
  }
}

const KIND_WORDS = { number: 'static.kind.number', text: 'static.kind.text', date: 'static.kind.date', boolean: 'static.kind.boolean' } as const satisfies Record<string, MessageKey>;

/** The kind of value a type is, as the sentences say it (none: a type they do not name). */
function kindOf(type: string): 'number' | 'text' | 'date' | 'boolean' | undefined {
  switch (type) {
    case 'decimal':
    case 'integer':
      return 'number';
    case 'text':
    case 'idLike':
      return 'text';
    case 'date':
      return 'date';
    case 'boolean':
      return 'boolean';
    default:
      return undefined;
  }
}

function article(type: string): string {
  switch (kindOf(type)) {
    case 'number':
      return 'a number';
    case 'text':
      return 'text';
    case 'date':
      return 'a date';
    case 'boolean':
      return 'a yes/no value';
    default:
      return type;
  }
}

export function explainStaticProblems(rules: EditableRules, problems: readonly StaticProblem[]): ExplainedProblem[] {
  return problems.map((p) => {
    const { lineId, where, place } = locate(rules, p.path);
    const { text, message } = sentence(p, where);
    return {
      layer: p.layer,
      code: `${p.layer}.${p.kind}`,
      ...(lineId === undefined ? {} : { lineId }),
      where,
      text,
      detail: p.message,
      ...(p.path === undefined ? {} : { path: p.path }),
      place,
      message,
    };
  });
}
