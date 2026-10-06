// What a saved format keeps (docs/proposals/saved-format-contents.md; owner, 2026-10-06; SPEC 21 v15). A format is saved on our server, so
// whatever its rules contain is stored there. A good rule holds almost nothing from the user's files: it names columns, and keeps a few
// cut-offs, rates and labels. This module walks every VALUE a rules file keeps - not its ids, headers, formats or names - and says where each
// one sits (`savedValues`), for two uses:
//   - identifier-shaped values (section 5, `identifierFindings`): an ID number, a phone, an email, a card or an IBAN anywhere in the rules
//     goes to the one popup at Save - "Target customer keeps an ID number in its rules" - whatever kind the rule is. Keep saves it as it is;
//     "Save without them" takes it out (`withoutIdentifiers`). One the server already holds is not asked again (`identifiersToConfirm`).
//   - the size caps (section 7, `contentLimitProblems`): entries in one value map, characters of one value, bytes of one version's rules.
//     The engine's `checkLimits` reports them (the browser's live check), and the server refuses a save over any of them (400 `rulesTooLarge`).
//
// Where a value sits, and so which column a popup line names:
//   - `output`: in what output columns show - a computed column one of them reaches (through helpers and functions), a table one of them looks
//     up, a value map on a column one of them shows, a fan-out's value or a label of a columns-to-rows expand one of them reads. The line names
//     each such output column; "Save without" takes it out (`withColumnsTakenOut`: "needs your input", reason `savedWithout`).
//   - `readAs`: a "Do this every time?" fix (its text or what it is read as) - the line names the input column; "Save without" removes the fix.
//   - `filter` / `check`: a row filter's or a check's value - the line names the column it reads; "Save without" removes the filter or check.
//   - `layout`: a title row, a summary row's label, the "stop at" texts - counted for the size caps only (no column to name; DECISION: a
//     title holds the format's own words, and the proposal's detectors are for the values a RULE keeps).
// DECISION (numbers): a number in an expression, a table or a filter is a value (an ID stored as a number is the owner's incident); a check's
// bounds and cut-off edges (`range`, `cutoffRange`, `dateRange`, `lengthEquals`) are thresholds and are not.
//
// Real values: this runs in the browser (the main thread, before a save), the server (the caps) and the eval; no value ever leaves a
// function here except inside the rules themselves. Pure.
import { limits } from '../config/limits';
import { identifierKindOf, type IdentifierKind } from '../identifiers';
import { withColumnsTakenOut, withoutUnreadLists } from './copiedList';
import type { UnsupportedReasonCode } from '../codes';
import type { Expr, LearnResult, Rules } from './schema';

type AnyRules = LearnResult | Rules;

/** Where a value of the rules sits (see the file header). */
export type SavedPlace =
  | { kind: 'output'; headers: string[] }
  | { kind: 'readAs'; column: string; header: string; text: string }
  | { kind: 'filter'; index: number; header: string | null }
  | { kind: 'check'; index: number; header: string | null }
  | { kind: 'layout' };

export interface SavedValue {
  value: string | number;
  place: SavedPlace;
  /** Where in the rules (a dotted path, like the checkers' problems), so a size problem can name its line in the editor. */
  path: string;
}

/** The reason a column saved without its identifier is reported with ("needs your input"). */
export const SAVED_WITHOUT_REASON: UnsupportedReasonCode = 'savedWithout';

const isValue = (v: unknown): v is string | number => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

/**
 * The values an expression keeps: its constants, the values of a `oneOf`, the text a `startsWith` / `endsWith` / `contains` / `find` looks
 * for, and what a `replaceText` finds and writes. Not a format, a separator, a padding character or a fixed date (the format's own words).
 */
function exprValues(e: unknown, out: (string | number)[]): (string | number)[] {
  if (Array.isArray(e)) {
    for (const x of e) exprValues(x, out);
    return out;
  }
  if (typeof e !== 'object' || e === null) return out;
  const o = e as Record<string, unknown>;
  if ('const' in o) {
    if (isValue(o.const)) out.push(o.const);
    return out;
  }
  switch (o.op) {
    case 'oneOf':
      for (const v of (o.values as unknown[] | undefined) ?? []) if (isValue(v)) out.push(v);
      break;
    case 'startsWith':
    case 'endsWith':
    case 'contains':
      if (isValue(o.text)) out.push(o.text);
      break;
    case 'find':
      if (isValue(o.search)) out.push(o.search);
      break;
    case 'replaceText':
      if (isValue(o.find)) out.push(o.find);
      if (isValue(o.with)) out.push(o.with);
      break;
  }
  for (const [k, v] of Object.entries(o)) if (k !== 'values' && typeof v === 'object' && v !== null) exprValues(v, out);
  return out;
}

/** What an expression refers to: column ids (a window's `by` / `order` too), functions called, tables looked up. */
interface Refs {
  ids: Set<string>;
  fns: Set<string>;
  tables: Set<string>;
}

function refsOf(e: unknown, out: Refs): Refs {
  if (Array.isArray(e)) {
    for (const x of e) refsOf(x, out);
    return out;
  }
  if (typeof e !== 'object' || e === null) return out;
  const o = e as Record<string, unknown>;
  if (typeof o.col === 'string') out.ids.add(o.col);
  if (o.op === 'call' && typeof o.fn === 'string') out.fns.add(o.fn);
  if (o.op === 'lookup' && typeof o.table === 'string') out.tables.add(o.table);
  if (o.op === 'window') {
    for (const id of (o.by as string[] | undefined) ?? []) out.ids.add(id);
    for (const k of (o.order as { column: string }[] | undefined) ?? []) out.ids.add(k.column);
  }
  for (const v of Object.values(o)) if (typeof v === 'object' && v !== null) refsOf(v, out);
  return out;
}

const emptyRefs = (): Refs => ({ ids: new Set(), fns: new Set(), tables: new Set() });

/**
 * What each output column reaches: the ids it reads (its `from`, and every id the computed columns, fan-out values and functions on the way
 * read), the functions they call and the tables they look up.
 */
function reachOf(rules: AnyRules): Refs[] {
  const computed = new Map(rules.transform.computed.map((c) => [c.id, c.expr] as const));
  const functions = new Map((rules.transform.functions ?? []).map((f) => [f.name, f.body] as const));
  const expand = rules.transform.expand;
  const fanOut = new Map<string, Expr[]>();
  if (expand?.mode === 'fixedFanOut') {
    for (const row of expand.rows) for (const [id, e] of Object.entries(row.set)) fanOut.set(id, [...(fanOut.get(id) ?? []), e]);
  }
  return rules.output.columns.map((col) => {
    const reach = emptyRefs();
    if (col.from === null) return reach;
    const ids = [col.from];
    const fns: string[] = [];
    const visit = (e: unknown): void => {
      const r = refsOf(e, emptyRefs());
      for (const t of r.tables) reach.tables.add(t);
      for (const f of r.fns) if (!reach.fns.has(f)) fns.push(f);
      for (const id of r.ids) if (!reach.ids.has(id)) ids.push(id);
    };
    while (ids.length > 0 || fns.length > 0) {
      const id = ids.pop();
      if (id !== undefined) {
        if (reach.ids.has(id)) continue;
        reach.ids.add(id);
        if (computed.has(id)) visit(computed.get(id));
        for (const e of fanOut.get(id) ?? []) visit(e);
        continue;
      }
      const fn = fns.pop()!;
      if (reach.fns.has(fn)) continue;
      reach.fns.add(fn);
      if (functions.has(fn)) visit(functions.get(fn));
    }
    return reach;
  });
}

/**
 * Every value the rules keep, with where it sits (see the file header), in the rules' own order: the computed columns, the functions, the
 * tables, the value maps, an expand's labels and fan-out values, the "read as" fixes, the filters, "stop at", the checks, the title rows and
 * the summary rows' labels.
 */
export function savedValues(rules: AnyRules): SavedValue[] {
  // (defensive, like `withoutUnreadLists`: something that is not rules-shaped keeps nothing)
  if (typeof rules !== 'object' || rules === null || typeof rules.transform !== 'object' || rules.transform === null) return [];
  const out: SavedValue[] = [];
  const reach = reachOf(rules);
  const headersWhere = (test: (r: Refs, i: number) => boolean): string[] => rules.output.columns.flatMap((c, i) => (test(reach[i]!, i) ? [c.header] : []));
  const push = (values: readonly unknown[], place: SavedPlace, path: string): void => {
    for (const v of values) if (isValue(v)) out.push({ value: v, place, path });
  };
  const inputHeader = new Map(rules.input.columns.map((c) => [c.id, c.header] as const));
  /** The column a filter or a check reads, as the user knows it: an input column's header, or the output column that shows a computed one. */
  const headerOfId = (id: string | undefined): string | null => {
    if (id === undefined) return null;
    return inputHeader.get(id) ?? rules.output.columns.find((c) => c.from === id)?.header ?? null;
  };

  rules.transform.computed.forEach((c, i) => push(exprValues(c.expr, []), { kind: 'output', headers: headersWhere((r) => r.ids.has(c.id)) }, `transform.computed[${i}].expr`));
  (rules.transform.functions ?? []).forEach((f, i) => push(exprValues(f.body, []), { kind: 'output', headers: headersWhere((r) => r.fns.has(f.name)) }, `transform.functions[${i}].body`));
  (rules.transform.tables ?? []).forEach((t, i) => push(t.rows.flat(), { kind: 'output', headers: headersWhere((r) => r.tables.has(t.name)) }, `transform.tables[${i}]`));
  rules.transform.valueMaps.forEach((m, i) => {
    // A value map changes the values of the column it is on, as the output columns that show it see them (it runs after the computed columns).
    const shown = headersWhere((_, k) => rules.output.columns[k]!.from === m.column);
    const headers = shown.length > 0 ? shown : headersWhere((r) => r.ids.has(m.column));
    push(Object.entries(m.map).flat(), { kind: 'output', headers }, `transform.valueMaps[${i}]`);
  });
  const expand = rules.transform.expand;
  if (expand?.mode === 'columnsToRows' && expand.labels) push(Object.values(expand.labels), { kind: 'output', headers: headersWhere((r) => r.ids.has(expand.labelId)) }, 'transform.expand.labels');
  if (expand?.mode === 'fixedFanOut') {
    expand.rows.forEach((row, ri) => {
      for (const [id, e] of Object.entries(row.set)) push(exprValues(e, []), { kind: 'output', headers: headersWhere((r) => r.ids.has(id)) }, `transform.expand.rows[${ri}].set.${id}`);
    });
  }

  rules.input.columns.forEach((c, i) => {
    for (const [text, readAs] of Object.entries(c.readAs ?? {})) push([text, readAs], { kind: 'readAs', column: c.id, header: c.header, text }, `input.columns[${i}].readAs`);
  });
  (rules.input.rowFilters ?? []).forEach((f, i) => {
    const path = `input.rowFilters[${i}]`;
    if ('expr' in f) {
      const [first] = refsOf(f.expr, emptyRefs()).ids;
      push(exprValues(f.expr, []), { kind: 'filter', index: i, header: headerOfId(first) }, path);
    } else if ('value' in f) {
      push(Array.isArray(f.value) ? f.value : [f.value], { kind: 'filter', index: i, header: headerOfId(f.column) }, path);
    }
  });
  push(rules.input.stopAt?.values ?? [], { kind: 'layout' }, 'input.stopAt');

  rules.validations.forEach((v, i) => {
    const header = v.on === 'output' ? v.column : headerOfId(v.column);
    const place: SavedPlace = { kind: 'check', index: i, header };
    if (v.rule === 'oneOf') push(v.values, place, `validations[${i}]`);
    else if (v.rule === 'sameAs') push(exprValues(v.expr, []), place, `validations[${i}]`);
  });

  rules.output.titleRows.forEach((t, i) => {
    if ('text' in t) push([t.text], { kind: 'layout' }, `output.titleRows[${i}]`);
    else if ('parts' in t) push(t.parts.flatMap((p) => ('text' in p ? [p.text] : [])), { kind: 'layout' }, `output.titleRows[${i}]`);
  });
  (rules.output.summaryRows ?? []).forEach((s, i) => push(s.label === undefined ? [] : [s.label], { kind: 'layout' }, `output.summaryRows[${i}]`));
  (rules.transform.group?.summaryRows ?? []).forEach((s, i) => push(s.label === undefined ? [] : [s.label], { kind: 'layout' }, `transform.group.summaryRows[${i}]`));
  const legacy = rules as { output: { grandTotal?: { label: string } }; transform: { group?: { subtotal?: { label: string } } } };
  if (legacy.output.grandTotal) push([legacy.output.grandTotal.label], { kind: 'layout' }, 'output.grandTotal');
  if (legacy.transform.group?.subtotal) push([legacy.transform.group.subtotal.label], { kind: 'layout' }, 'transform.group.subtotal');
  return out;
}

// ---------------------------------------------------------------------------
// Identifier-shaped values (section 5)
// ---------------------------------------------------------------------------

/**
 * One line of the Save popup for an identifier-shaped value: "<header> keeps <an ID number> in its rules" (proposal section 6). No value:
 * the line says the column and the kind found, and so does every log.
 */
export interface IdentifierFinding {
  kind: 'identifier';
  /** The column the line names: an output column whose rule holds the value, or the input column a fix, a filter or a check is on. */
  header: string;
  idKind: IdentifierKind;
  /** The output column's position when the line names one (the popup lists its lines in output order). */
  out?: number;
}

/** The lines a place's value belongs to: one per output column it reaches, or the column of a fix, a filter or a check. */
function lineHeadersOf(place: SavedPlace): string[] {
  switch (place.kind) {
    case 'output':
      return place.headers;
    case 'readAs':
      return [place.header];
    case 'filter':
    case 'check':
      return place.header === null ? [] : [place.header];
    case 'layout':
      return [];
  }
}

const lineKey = (header: string, idKind: IdentifierKind): string => `${header}\u0000${idKind}`;
const valueKey = (v: string | number): string => `${typeof v}:${typeof v === 'string' ? v.trim() : String(v)}`;

/** Each line's values (as text keys), in first-seen order of the lines. */
function identifierLines(rules: AnyRules): Map<string, { finding: IdentifierFinding; values: Set<string> }> {
  const lines = new Map<string, { finding: IdentifierFinding; values: Set<string> }>();
  for (const v of savedValues(rules)) {
    const idKind = identifierKindOf(v.value);
    if (!idKind) continue;
    for (const header of lineHeadersOf(v.place)) {
      const key = lineKey(header, idKind);
      let line = lines.get(key);
      if (!line) {
        const out = v.place.kind === 'output' ? rules.output.columns.findIndex((c) => c.header === header) : -1;
        line = { finding: { kind: 'identifier', header, idKind, ...(out >= 0 ? { out } : {}) }, values: new Set() };
        lines.set(key, line);
      }
      line.values.add(valueKey(v.value));
    }
  }
  return lines;
}

/** Output lines first, in output order, then the others as found (a stable sort). */
const byOutput = (a: IdentifierFinding, b: IdentifierFinding): number => (a.out ?? Number.MAX_SAFE_INTEGER) - (b.out ?? Number.MAX_SAFE_INTEGER);

/** The identifier-shaped values the rules keep, one line per column and kind (see the file header). */
export function identifierFindings(rules: AnyRules): IdentifierFinding[] {
  return [...identifierLines(rules).values()].map((l) => l.finding).sort(byOutput);
}

/**
 * The lines to ask about before `rules` are stored: those with a value the server does not hold yet in the same line (`stored`: the rules it
 * holds now - a later save of the same source). DECISION: compared value by value, in the browser, so a value asked about once (and kept) is
 * not asked again, and a new one in the same column is; nothing about the values leaves this function.
 */
export function identifiersToConfirm(rules: AnyRules, stored?: AnyRules): IdentifierFinding[] {
  const held = stored ? identifierLines(stored) : new Map<string, { values: Set<string> }>();
  return [...identifierLines(rules).entries()]
    .filter(([key, line]) => [...line.values].some((v) => !held.get(key)?.values.has(v)))
    .map(([, line]) => line.finding)
    .sort(byOutput);
}

/**
 * "Save without them" for identifier-shaped values: every value of the lines asked about is taken out of the rules - an output column whose
 * rule holds one is taken out ("needs your input", reason `savedWithout`: `withColumnsTakenOut`, which takes the helpers and tables nothing
 * reads any more with it), a "Do this every time?" fix holding one is removed, and so is a filter or a check holding one; then the value maps
 * and tables nothing reads (`withoutUnreadLists`). The lines are found again on `rules` as they are now, so it applies to rules changed since
 * (a line no longer there is skipped).
 */
export function withoutIdentifiers<R extends AnyRules>(rules: R, lines: readonly Pick<IdentifierFinding, 'header' | 'idKind'>[]): R {
  const asked = new Set(lines.map((l) => lineKey(l.header, l.idKind)));
  const columns = new Set<string>();
  const readAs = new Map<string, Set<string>>();
  const filters = new Set<number>();
  const checks = new Set<number>();
  for (const v of savedValues(rules)) {
    const idKind = identifierKindOf(v.value);
    if (!idKind) continue;
    const hit = lineHeadersOf(v.place).filter((h) => asked.has(lineKey(h, idKind)));
    if (hit.length === 0) continue;
    switch (v.place.kind) {
      case 'output':
        for (const h of hit) columns.add(h);
        break;
      case 'readAs':
        readAs.set(v.place.column, new Set([...(readAs.get(v.place.column) ?? []), v.place.text]));
        break;
      case 'filter':
        filters.add(v.place.index);
        break;
      case 'check':
        checks.add(v.place.index);
        break;
      case 'layout':
        break;
    }
  }
  let next: R = rules;
  if (readAs.size > 0) {
    const inputColumns = next.input.columns.map((c) => {
      const drop = readAs.get(c.id);
      if (!drop || !c.readAs) return c;
      const kept = Object.fromEntries(Object.entries(c.readAs).filter(([text]) => !drop.has(text)));
      const { readAs: _readAs, ...rest } = c;
      return Object.keys(kept).length > 0 ? { ...rest, readAs: kept } : rest;
    });
    next = { ...next, input: { ...next.input, columns: inputColumns } };
  }
  if (filters.size > 0 && next.input.rowFilters) {
    const rowFilters = next.input.rowFilters.filter((_, i) => !filters.has(i));
    const { rowFilters: _rowFilters, ...input } = next.input;
    next = { ...next, input: rowFilters.length > 0 ? { ...input, rowFilters } : input };
  }
  if (checks.size > 0) next = { ...next, validations: next.validations.filter((_, i) => !checks.has(i)) };
  if (columns.size > 0) {
    const freed = next.output.columns.flatMap((c) => (columns.has(c.header) && c.from !== null ? [c.from] : []));
    next = withColumnsTakenOut(next, columns, SAVED_WITHOUT_REASON, freed);
  }
  return withoutUnreadLists(next);
}

// ---------------------------------------------------------------------------
// The size caps (section 7)
// ---------------------------------------------------------------------------

/** One cap a rules file is over (`limits.rules`): a value map's entries, a value's characters, the rules' bytes. */
export type ContentLimitProblem =
  | { code: 'valueMapEntries'; path: string; column: string; entries: number; max: number }
  | { code: 'valueChars'; path: string; chars: number; max: number }
  | { code: 'rulesBytes'; bytes: number; max: number };

/** The UTF-8 length of a text, without encoding it. */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** The UTF-8 bytes of a rules file as it is stored (compact JSON). */
export function rulesBytes(rules: unknown): number {
  return utf8Length(JSON.stringify(rules) ?? '');
}

/**
 * The caps a rules file is over (`limits.rules.maxValueMapEntries`, `maxValueChars`, `maxRulesBytes`): each value map with more entries, each
 * place with a longer value (one problem per path: its longest value), and the whole file when it is larger. [] when it is within them.
 */
export function contentLimitProblems(rules: AnyRules): ContentLimitProblem[] {
  const { maxValueMapEntries, maxValueChars, maxRulesBytes } = limits.rules;
  const problems: ContentLimitProblem[] = [];
  const maps = rules?.transform?.valueMaps;
  if (Array.isArray(maps)) {
    maps.forEach((m, i) => {
      const entries = Object.keys(m.map ?? {}).length;
      if (entries > maxValueMapEntries) problems.push({ code: 'valueMapEntries', path: `transform.valueMaps[${i}]`, column: m.column, entries, max: maxValueMapEntries });
    });
  }
  const longest = new Map<string, number>();
  for (const v of savedValues(rules)) {
    if (typeof v.value !== 'string' || v.value.length <= maxValueChars) continue;
    longest.set(v.path, Math.max(longest.get(v.path) ?? 0, v.value.length));
  }
  for (const [path, chars] of longest) problems.push({ code: 'valueChars', path, chars, max: maxValueChars });
  const bytes = rulesBytes(rules);
  if (bytes > maxRulesBytes) problems.push({ code: 'rulesBytes', bytes, max: maxRulesBytes });
  return problems;
}

/** A cap problem in the checkers' words (the engine's `checkLimits` and the API's problems): names and counts, never a value. */
export function contentLimitMessage(p: ContentLimitProblem): string {
  switch (p.code) {
    case 'valueMapEntries':
      return `the value map on "${p.column}" has ${p.entries} entries, exceeding the maximum of ${p.max}`;
    case 'valueChars':
      return `a value of ${p.chars} characters, exceeding the maximum of ${p.max} characters for one value`;
    case 'rulesBytes':
      return `the rules take ${p.bytes} bytes, exceeding the maximum of ${p.max} bytes for one format`;
  }
}
