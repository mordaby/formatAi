// describeRules: the rules JSON -> the rules map (SPEC 8.11) as sentences in he or en.
// Pure; no React, no DOM, no engine barrel (only the formula printer, via ./expr).
import {
  assumptionMessages,
  unsupportedMessages,
  type Assumption,
  type ColumnType,
  type Expand,
  type LearnResult,
  type RowFilter,
  type Rules,
  type SummaryRow,
  type TitleRow,
  type Unsupported,
  type ValueMap,
  type Validation,
} from '@formatai/shared';
import {
  conditionParts,
  constPart,
  describeExpr,
  formulaPart,
  formulaPieces,
  idPart,
  namePart,
  outPart,
  type Ctx,
} from './expr';
import { buildNames } from './names';
import { joinWith, nm, normalize, partsText, quoted, txt, val, arrow } from './parts';
import { phrasebook, type PhraseKey } from './phrases';
import { endSummaryRows, groupSummaryRows } from './summaryRows';
import type {
  DescribeOptions,
  Line,
  LineStatus,
  LineTarget,
  Note,
  Part,
  RulesMapModel,
  Section,
  SectionId,
  SimplePart,
  VerificationLike,
} from './types';

// ---------------------------------------------------------------------------
// Drafts: a line before its status is settled
// ---------------------------------------------------------------------------

interface Draft {
  id: string;
  parts: Part[];
  target: LineTarget;
  /** Things the user should look at ("please check"): assumptions, mismatches. */
  reasons: string[];
  /** Set when the line can't work until the user decides something. */
  needsInput?: string;
}

const draft = (id: string, parts: Part[], target: LineTarget): Draft => ({ id, parts, target, reasons: [] });

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const NUMERIC_TYPES: ReadonlySet<ColumnType> = new Set(['integer', 'decimal', 'currency', 'percent']);

/** D, M, Y tokens and separators only: "DD/MM/YYYY", "MMMM YYYY". Number formats never match. */
const DATE_FORMAT = /^[DMY][DMY\s/.\-,:]*$/;

function descendingKind(type: ColumnType | undefined): 'date' | 'number' | 'text' | 'plain' {
  if (type === 'date') return 'date';
  if (type !== undefined && NUMERIC_TYPES.has(type)) return 'number';
  if (type === 'text' || type === 'idLike') return 'text';
  return 'plain';
}

function isoToDisplay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function withSuffix(parts: readonly Part[], ctx: Ctx, key: PhraseKey): Part[] {
  return normalize([...parts, txt(', '), ...ctx.book.t(key)]);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function filterCondition(f: RowFilter, ctx: Ctx): Part[] {
  const { t, or } = ctx.book;
  if ('expr' in f) return conditionParts(f.expr, ctx);
  const a = idPart(ctx, f.column);
  switch (f.op) {
    case 'isEmpty':
    case 'notEmpty':
      return t(`cond.${f.op}`, { a });
    case 'oneOf':
    case 'notOneOf':
      return t(`cond.${f.op}`, { a, values: or(f.value.map((v) => [constPart(v, ctx)])) });
    default:
      return t(`cond.${f.op}`, { a, b: constPart(f.value, ctx) });
  }
}

/** `main (extra; extra)`; just `main` when there is nothing extra. */
function inParens(main: Part[], extras: readonly Part[][]): Part[] {
  if (extras.length === 0) return main;
  return joinWith([main, [txt('('), ...joinWith(extras, '; '), txt(')')]], ' ');
}

function describeExpand(expand: Expand, ctx: Ctx): Part[] {
  const { t, tn, and } = ctx.book;
  switch (expand.mode) {
    case 'columnsToRows': {
      const main = t('expand.columnsToRows', {
        cols: and(expand.columns.map((c) => [idPart(ctx, c)])),
        label: idPart(ctx, expand.labelId),
        value: idPart(ctx, expand.valueId),
      });
      const extras: Part[][] = [];
      if (expand.skipEmpty) extras.push(t('expand.skipEmptyCells'));
      if (expand.labels && Object.keys(expand.labels).length > 0) extras.push(t('expand.customLabels'));
      return inParens(main, extras);
    }
    case 'splitCell': {
      const clauses: Part[][] = [
        t('expand.splitCell', {
          col: idPart(ctx, expand.column),
          sep: val(quoted(expand.separator)),
          part: idPart(ctx, expand.partId),
        }),
      ];
      const details: Part[][] = [];
      // Only when an output column shows them; a calculation that uses them says so itself.
      if (expand.indexId && ctx.names.made(expand.indexId) === undefined) {
        details.push(t('expand.splitIndex', { idx: idPart(ctx, expand.indexId) }));
      }
      if (expand.countId && ctx.names.made(expand.countId) === undefined) {
        details.push(t('expand.splitCount', { cnt: idPart(ctx, expand.countId) }));
      }
      const extras: Part[][] = [];
      if (expand.trim) extras.push(t('expand.trimmed'));
      if (expand.skipEmpty) extras.push(t('expand.skipEmptyParts'));
      return inParens(joinWith([...clauses, ...details], '; '), extras);
    }
    case 'fixedFanOut': {
      const rows = expand.rows.map((row, i) =>
        t('expand.fanRow', {
          n: String(i + 1),
          cells: joinWith(
            Object.entries(row.set).map(([id, expr]) =>
              t('expand.fanCell', { col: idPart(ctx, id), expr: describeExpr(expr, ctx, false) }),
            ),
            ', ',
          ),
        }),
      );
      return t('expand.fan', { count: tn('rows', expand.rows.length), rows: joinWith(rows, '; ') });
    }
  }
}

/** How an id made by the expand step is filled (an output column can point at one). */
function describeExpandId(id: string, expand: Expand | undefined, ctx: Ctx): Part[] | undefined {
  const { t, and } = ctx.book;
  if (!expand) return undefined;
  switch (expand.mode) {
    case 'columnsToRows':
      if (id === expand.labelId) return t('expand.labelValue', { cols: and(expand.columns.map((c) => [idPart(ctx, c)])) });
      if (id === expand.valueId) return t('expand.valueValue');
      return undefined;
    case 'splitCell':
      if (id === expand.partId) return t('expand.partValue', { col: idPart(ctx, expand.column) });
      if (id === expand.indexId) return t('expand.indexValue');
      if (id === expand.countId) return t('expand.countValue');
      return undefined;
    case 'fixedFanOut': {
      const cells: Part[][] = [];
      expand.rows.forEach((row, i) => {
        const expr = row.set[id];
        if (expr !== undefined) cells.push(t('expand.fanValue', { n: String(i + 1), expr: describeExpr(expr, ctx, false) }));
      });
      return cells.length > 0 ? joinWith(cells, '; ') : undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Layout pieces
// ---------------------------------------------------------------------------

function describeSummaryRow(row: SummaryRow, ctx: Ctx): Part[] {
  const { t, and } = ctx.book;
  const cells = Object.entries(row.cells).map(([header, agg]) => t(`summary.${agg}`, { col: namePart(ctx, header) }));
  const label = row.label ? val(quoted(row.label)) : undefined;
  let main: Part[];
  if (label && cells.length > 0) main = t('summary.row', { label, cells: and(cells) });
  else if (label) main = t('summary.rowOnlyLabel', { label });
  else if (cells.length > 0) main = t('summary.rowNoLabel', { cells: and(cells) });
  else main = t('summary.rowEmpty');
  return row.bold ? withSuffix(main, ctx, 'summary.bold') : main;
}

function describeTitle(row: TitleRow, ctx: Ctx): Part[] {
  const { t } = ctx.book;
  if ('blank' in row) return t('title.blank');
  let text: Part[];
  if ('parts' in row) {
    const items = row.parts.map((p): Part[] => {
      if ('text' in p) return [val(quoted(p.text))];
      const kind = /D/.test(p.format) ? 'date' : /M/.test(p.format) ? 'month' : /Y/.test(p.format) ? 'year' : 'date';
      return t(`title.${p.agg}.${kind}`, { col: outPart(ctx, p.column), f: val(p.format) });
    });
    text = joinWith(items, ' + ');
  } else {
    text = [val(quoted(row.text))];
  }
  const line = t('title.text', { text });
  return row.bold ? withSuffix(line, ctx, 'title.bold') : line;
}

function describeFile(rules: LearnResult | Rules, ctx: Ctx): Part[] {
  const { t, raw } = ctx.book;
  const f = rules.output.file ?? { type: 'xlsx' as const };
  if (f.type === 'xlsx') {
    return t('file.xlsx', {
      sheet: nm(quoted(rules.output.sheetName)),
      dir: t(rules.output.direction === 'rtl' ? 'dir.rtl' : 'dir.ltr'),
    });
  }
  const delimiter = f.delimiter ?? (f.type === 'txt' ? '\t' : ',');
  const kind = delimiter === '\t' ? 'tab' : delimiter === ';' ? 'semicolon' : delimiter === '|' ? 'pipe' : 'comma';
  const items: Part[][] = [
    t(`file.kind.${kind}`),
    t((f.header ?? true) ? 'file.header' : 'file.noHeader'),
    [val(raw(`file.enc.${f.encoding ?? 'utf8bom'}`))],
  ];
  if (f.quote === 'all') items.push(t('file.quote.all'));
  if (f.quote === 'none') items.push(t('file.quote.none'));
  return joinWith(items, ', ');
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function describeValidation(v: Validation, ctx: Ctx): Part[] {
  const { t, tn, or } = ctx.book;
  const col = (v.on ?? 'input') === 'output' ? namePart(ctx, v.column) : idPart(ctx, v.column);
  let rule: Part[];
  switch (v.rule) {
    case 'required':
      rule = t('check.required', { col });
      break;
    case 'israeliIdChecksum':
      rule = t('check.israeliId', { col });
      break;
    case 'range':
      if (v.min !== undefined && v.max !== undefined) {
        rule = t('check.range.both', { col, min: val(String(v.min)), max: val(String(v.max)) });
      } else if (v.min !== undefined) {
        rule = t('check.range.min', { col, min: val(String(v.min)) });
      } else if (v.max !== undefined) {
        rule = t('check.range.max', { col, max: val(String(v.max)) });
      } else {
        rule = t('check.range.none', { col });
      }
      break;
    case 'lengthEquals':
      rule = tn('check.length', v.length, { col });
      break;
    case 'oneOf': {
      const shown = v.values.slice(0, 6).map((x): Part[] => [val(quoted(x))]);
      const values =
        v.values.length > 6
          ? joinWith([...shown, t('more', { n: String(v.values.length - 6) })], ', ')
          : or(shown);
      rule = t('check.oneOf', { col, values });
      break;
    }
    case 'unique':
      rule = t('check.unique', { col });
      break;
    case 'dateRange':
      rule = t('check.dateRange', { col, from: val(isoToDisplay(v.from)), to: val(isoToDisplay(v.to)) });
      break;
  }
  return t('check.line', { rule, severity: t(v.severity === 'flag' ? 'check.severity.flag' : 'check.severity.block') });
}

// ---------------------------------------------------------------------------
// Verification -> which lines to look at
// ---------------------------------------------------------------------------

type LayoutArea = 'rows' | 'file' | 'title' | 'summary' | 'blank';

/** Which part of the layout each layout difference (`VerifyResult.layoutIssues`) is about, read from its code. */
function layoutAreas(issues: VerificationLike['layoutIssues']): Set<LayoutArea> {
  const areas = new Set<LayoutArea>();
  for (const { code } of issues) {
    if (code === 'rowCount' || code === 'unalignedRows') areas.add('rows');
    else if (code === 'fileSettings') areas.add('file');
    else if (code === 'titleRow') areas.add('title');
    else if (code === 'summaryRow') areas.add('summary');
    else if (code === 'blankRow') areas.add('blank');
  }
  return areas;
}

function mismatchCounts(v: VerificationLike | undefined): Map<string, number> {
  const rowsByColumn = new Map<string, Set<number>>();
  for (const m of v?.mismatches ?? []) {
    const rows = rowsByColumn.get(m.column) ?? new Set<number>();
    rows.add(m.exampleRow);
    rowsByColumn.set(m.column, rows);
  }
  return new Map([...rowsByColumn].map(([column, rows]) => [column, rows.size]));
}

// ---------------------------------------------------------------------------
// describeRules
// ---------------------------------------------------------------------------

export function describeRules(rules: LearnResult | Rules, opts: DescribeOptions): RulesMapModel {
  const book = phrasebook(opts.lang);
  const ctx: Ctx = { book, names: buildNames(rules) };
  const { t, tn, and } = book;
  const plain = (key: PhraseKey, args?: Record<string, string>): string => partsText(t(key, args));

  const unsupported: readonly Unsupported[] = opts.unsupported ?? rules.unsupported;
  const assumptions: readonly Assumption[] = opts.assumptions ?? rules.assumptions;
  const verification = opts.verification;
  const edited = opts.edited ?? new Set<string>();
  const { transform, output, input } = rules;
  const group = transform.group;

  const inputById = new Map(input.columns.map((c) => [c.id, c]));
  const computedById = new Map(transform.computed.map((c) => [c.id, c]));
  const valueMapById = new Map<string, ValueMap>();
  for (const vm of transform.valueMaps) if (!valueMapById.has(vm.column)) valueMapById.set(vm.column, vm);
  const textFile = (output.file?.type ?? 'xlsx') !== 'xlsx';

  // ---- Rows ---------------------------------------------------------------
  const rows: Draft[] = [];
  const filterLines: Draft[] = [];

  if (input.sheet.pick === 'name') {
    rows.push(draft('input:sheet', t('input.sheetName', { name: nm(quoted(input.sheet.name)) }), { kind: 'input' }));
  } else if (input.sheet.pick === 'index') {
    rows.push(draft('input:sheet', t('input.sheetIndex', { n: String(input.sheet.index + 1) }), { kind: 'input' }));
  }
  if (typeof input.headerRow === 'number') {
    rows.push(draft('input:headerRow', t('input.headerRow', { n: String(input.headerRow + 1) }), { kind: 'input' }));
  }
  if (input.stopAt) {
    const values = book.or(input.stopAt.values.map((v): Part[] => [val(quoted(v))]));
    rows.push(draft('input:stopAt', t('input.stopAt', { values }), { kind: 'input' }));
  }
  (input.rowFilters ?? []).forEach((f, i) => {
    const d = draft(`filter:${i}`, t('filter.keep', { cond: filterCondition(f, ctx) }), { kind: 'filter', index: i });
    filterLines.push(d);
    rows.push(d);
  });
  if (transform.dedupe) {
    const dd = transform.dedupe;
    const same =
      dd.keys === 'all'
        ? t('dedupe.identical')
        : tn('dedupe.same', dd.keys.length, { keys: and(dd.keys.map((k) => [idPart(ctx, k)])) });
    const key = `dedupe.${dd.action}${dd.keep === 'first' ? 'First' : 'Last'}` as PhraseKey;
    rows.push(draft('dedupe', t(key, { same }), { kind: 'dedupe' }));
  }
  if (transform.expand) {
    rows.push(draft('expand', describeExpand(transform.expand, ctx), { kind: 'expand' }));
  }

  // ---- Columns ------------------------------------------------------------
  const columnLines: { header: string; d: Draft }[] = [];
  const usedColumnIds = new Set<string>();
  const inSummaryMode = group !== undefined && group.showDetailRows === false;

  output.columns.forEach((col, i) => {
    let id = `col:${col.header}`;
    if (usedColumnIds.has(id)) id = `col:${col.header}#${i}`;
    usedColumnIds.add(id);

    let body: Part[];
    const mods: Part[][] = [];
    let needsInput: string | undefined;

    if (col.from === null) {
      body = t('col.emptyNeedsInput');
      needsInput = plain('reason.noSource');
    } else {
      const from = col.from;
      const inputCol = inputById.get(from);
      const computed = computedById.get(from);
      const valueMap = valueMapById.get(from);
      const translation = (asModifier: boolean): Part[] | undefined =>
        valueMap
          ? t(asModifier ? 'col.thenTranslated' : 'col.translated', {
              src: inputCol ? namePart(ctx, inputCol.header) : [],
              count: tn('values', Object.keys(valueMap.map).length),
              missing: t(valueMap.onMissing === 'flag' ? 'translate.missingFlag' : 'translate.missingKeep'),
            })
          : undefined;

      if (inputCol) {
        body = [namePart(ctx, inputCol.header)];
        if (inputCol.padLeft) mods.push(t('mod.padDigits', { n: String(inputCol.padLeft) }));
        const tr = translation(mods.length > 0);
        if (tr) {
          if (mods.length > 0) mods.push(tr);
          else body = tr;
        }
      } else if (computed) {
        body = describeExpr(computed.expr, ctx, true);
        const tr = translation(true);
        if (tr) mods.push(tr);
      } else {
        const made = describeExpandId(from, transform.expand, ctx);
        if (made) {
          body = made;
          const tr = translation(true);
          if (tr) mods.push(tr);
        } else {
          body = t('col.missing');
          needsInput = plain('reason.dangling');
        }
      }
      if (col.format !== undefined && DATE_FORMAT.test(col.format)) mods.push(t('mod.dateShown', { f: val(col.format) }));
      if (inSummaryMode && col.agg !== undefined && !(col.agg === 'first' && from === group?.by)) {
        mods.push(t(`agg.${col.agg}`, { by: outPart(ctx, group?.by ?? '') }));
      }
    }

    const parts = normalize([
      namePart(ctx, col.header),
      txt(' '),
      arrow(),
      txt(' '),
      ...body,
      ...mods.flatMap((m) => [txt(', '), ...m]),
    ]);
    const d = draft(id, parts, { kind: 'column', index: i, header: col.header });
    if (needsInput !== undefined) d.needsInput = needsInput;
    columnLines.push({ header: col.header, d });
  });

  // ---- Layout -------------------------------------------------------------
  const layout: Draft[] = [];
  const titleLines: Draft[] = [];
  const summaryLines: Draft[] = [];
  const sortLines: Draft[] = [];
  const blankTitleLines: Draft[] = [];
  let blankLine: Draft | undefined;

  output.titleRows.forEach((row, i) => {
    const d = draft(`title:${i}`, describeTitle(row, ctx), { kind: 'title', index: i });
    titleLines.push(d);
    if ('blank' in row) blankTitleLines.push(d);
    layout.push(d);
  });
  if (transform.sort.length > 0) {
    const keys = transform.sort.map((k): Part[] => {
      const name = outPart(ctx, k.column);
      if (k.dir === 'asc') return [name];
      const kind = descendingKind(ctx.names.typeOf(k.column));
      return [name, txt(' '), ...t(`sort.desc.${kind}`)];
    });
    const d = draft('sort', t('sort.by', { keys: joinWith(keys, book.raw('sort.then')) }), { kind: 'sort' });
    sortLines.push(d);
    layout.push(d);
  }
  if (group) {
    const by = outPart(ctx, group.by);
    layout.push(
      draft('group', t(group.showDetailRows ? 'group.detail' : 'group.summaryOnly', { by }), { kind: 'group' }),
    );
    groupSummaryRows(rules).forEach((row, i) => {
      const d = draft(`summary:group:${i}`, t('summary.afterGroup', { by, row: describeSummaryRow(row, ctx) }), {
        kind: 'summaryGroup',
        index: i,
      });
      summaryLines.push(d);
      layout.push(d);
    });
    if (group.blankRowsAfter !== undefined && group.blankRowsAfter > 0) {
      blankLine = draft('blank:group', tn('blank.after', group.blankRowsAfter, { by }), { kind: 'blankRows' });
      layout.push(blankLine);
    }
  }
  endSummaryRows(rules).forEach((row, i) => {
    const d = draft(`summary:end:${i}`, t('summary.atEnd', { row: describeSummaryRow(row, ctx) }), {
      kind: 'summaryEnd',
      index: i,
    });
    summaryLines.push(d);
    layout.push(d);
  });
  const fileLine = draft('file', describeFile(rules, ctx), { kind: 'file' });
  layout.push(fileLine);

  if (textFile) {
    // SPEC 8.13: title, blank and summary rows are allowed in a text file but worth a second look.
    for (const d of [...titleLines, ...summaryLines, ...(blankLine ? [blankLine] : [])]) {
      d.reasons.push(plain('reason.textFileLayout'));
    }
  }

  // ---- Checks -------------------------------------------------------------
  const checks = rules.validations.map((v, i) => draft(`check:${i}`, describeValidation(v, ctx), { kind: 'validation', index: i }));

  // ---- Functions and tables -----------------------------------------------
  const functions: Draft[] = [];
  (transform.functions ?? []).forEach((fn, i) => {
    const body = formulaPieces(fn.body, ctx);
    const pieces: SimplePart[] = [nm(fn.name), txt('(')];
    fn.params.forEach((p, k) => pieces.push(...(k > 0 ? [txt(', ')] : []), nm(p.name)));
    pieces.push(txt(') = '), ...(body ?? [txt(plain('expr.custom'))]));
    functions.push(draft(`fn:${fn.name}`, [formulaPart(mergeText(pieces))], { kind: 'function', index: i, name: fn.name }));
  });
  (transform.tables ?? []).forEach((table, i) => {
    const [key, ...rest] = table.columns;
    const keyName = namePart(ctx, key ?? '');
    const count = tn('entries', table.rows.length);
    const parts =
      rest.length > 0
        ? t('table.line', { name: nm(quoted(table.name)), count, key: keyName, cols: and(rest.map((c) => [namePart(ctx, c)])) })
        : t('table.single', { name: nm(quoted(table.name)), count, key: keyName });
    functions.push(draft(`table:${table.name}`, parts, { kind: 'table', index: i, name: table.name }));
  });

  // ---- Statuses -----------------------------------------------------------
  const notes: Note[] = [];
  const columnsByHeader = (header: string): Draft[] => columnLines.filter((c) => c.header === header).map((c) => c.d);

  for (const u of unsupported) {
    const message = unsupportedMessages[u.reasonCode][opts.lang];
    const targets = columnsByHeader(u.outputColumn);
    if (targets.length === 0) notes.push({ kind: 'unsupported', code: u.reasonCode, column: u.outputColumn, message });
    for (const d of targets) d.needsInput = message;
  }

  for (const a of assumptions) {
    const message = assumptionMessages[a.reasonCode][opts.lang];
    let targets: Draft[];
    if (a.outputColumn !== undefined) targets = columnsByHeader(a.outputColumn);
    else if (a.reasonCode === 'filterGuessed') targets = filterLines;
    else if (a.reasonCode === 'sortGuessed') targets = sortLines;
    else if (a.reasonCode === 'titleGuessed') targets = titleLines;
    else if (a.reasonCode === 'formatGuessed') targets = [fileLine];
    else targets = [];
    if (targets.length === 0) {
      const note: Note = { kind: 'assumption', code: a.reasonCode, message };
      if (a.outputColumn !== undefined) note.column = a.outputColumn;
      notes.push(note);
    }
    for (const d of targets) if (!d.reasons.includes(message)) d.reasons.push(message);
  }

  if (verification) {
    const counts = mismatchCounts(verification);
    for (const { header, d } of columnLines) {
      const n = counts.get(header);
      if (n !== undefined && n > 0) {
        d.reasons.push(partsText(tn('reason.mismatch', verification.total, { n: String(n), total: String(verification.total) })));
      }
    }
    const areas = layoutAreas(verification.layoutIssues);
    const flag = (targets: readonly Draft[], key: PhraseKey): void => {
      for (const d of targets) d.reasons.push(plain(key));
    };
    if (areas.has('rows')) {
      flag(rows.filter((d) => d.target.kind !== 'input' || d.id === 'input:stopAt'), 'reason.rowsDiffer');
    }
    if (areas.has('title')) flag(titleLines, 'reason.layoutDiffers');
    if (areas.has('summary')) flag(summaryLines, 'reason.layoutDiffers');
    if (areas.has('blank')) flag([...(blankLine ? [blankLine] : []), ...blankTitleLines], 'reason.layoutDiffers');
    if (areas.has('file')) flag([fileLine], 'reason.layoutDiffers');
  }

  // ---- Assemble -----------------------------------------------------------
  const finish = (d: Draft): Line => {
    const parts = normalize(d.parts);
    let status: LineStatus = 'matches';
    let statusReason: string | undefined;
    if (edited.has(d.id)) {
      status = 'edited';
      statusReason = plain('reason.edited');
    } else if (d.needsInput !== undefined) {
      status = 'needsInput';
      statusReason = d.needsInput;
    } else if (d.reasons.length > 0) {
      status = 'check';
      statusReason = d.reasons.join(' ');
    }
    const line: Line = { id: d.id, text: partsText(parts), parts, status, target: d.target };
    if (statusReason !== undefined) line.statusReason = statusReason;
    return line;
  };
  const section = (id: SectionId, list: readonly Draft[]): Section => ({
    id,
    title: book.raw(`section.${id}`),
    lines: list.map(finish),
  });

  const sections: Section[] = [
    section('rows', rows),
    section('columns', columnLines.map((c) => c.d)),
    section('layout', layout),
    section('checks', checks),
  ];
  if (functions.length > 0) sections.push(section('functions', functions));
  return { sections, notes };
}

/** Joins neighbouring plain-text pieces of a formula. */
function mergeText(pieces: readonly SimplePart[]): SimplePart[] {
  const out: SimplePart[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (p.kind === 'text' && last && last.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text + p.text };
    else out.push(p);
  }
  return out;
}
