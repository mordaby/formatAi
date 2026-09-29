// SPEC 8.12 "The format lock": "When a conversion belongs to a format: its `output`
// section must equal the format's `output`, except `columns[].from`; its `sort` and
// `group`, after code maps ids to output headers, must equal the format's; its output
// validations must equal the format's. Code enforces this after every learn and every
// edit (9.2). A conversion that breaks the lock is rejected, and a repair call
// receives it as a `formatMismatch` problem."
import type {
  Format,
  FormatGroup,
  FormatOutput,
  FormatSortKey,
  LearnResult,
  Rules,
  Validation,
} from '@formatai/shared';
import { formatOf } from './formatOf';

export interface FormatProblem {
  kind: 'formatMismatch';
  /** Dotted/bracketed path to the offending field, e.g. "output.columns[3].format". */
  path: string;
  message: string;
}

/** Deep-equal that treats an absent key the same as an explicit `undefined` (so e.g. a
 * missing `width` and `width: undefined` compare equal - SPEC 8.12's lock is a content
 * comparison, not a JSON-shape comparison). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

function compareOutput(a: FormatOutput, b: FormatOutput, problems: FormatProblem[]): void {
  if (!deepEqual(a.file, b.file)) {
    problems.push({
      kind: 'formatMismatch',
      path: 'output.file',
      message: `must equal the format's file ${JSON.stringify(b.file)}, got ${JSON.stringify(a.file)}`,
    });
  }
  if (a.sheetName !== b.sheetName) {
    problems.push({ kind: 'formatMismatch', path: 'output.sheetName', message: `must equal the format's sheetName "${b.sheetName}", got "${a.sheetName}"` });
  }
  if (a.direction !== b.direction) {
    problems.push({ kind: 'formatMismatch', path: 'output.direction', message: `must equal the format's direction "${b.direction}", got "${a.direction}"` });
  }
  if (a.language !== b.language) {
    problems.push({ kind: 'formatMismatch', path: 'output.language', message: `must equal the format's language "${b.language}", got "${a.language}"` });
  }
  if (!deepEqual(a.titleRows, b.titleRows)) {
    problems.push({ kind: 'formatMismatch', path: 'output.titleRows', message: "must equal the format's title rows" });
  }
  if (!deepEqual(a.headerStyle, b.headerStyle)) {
    problems.push({ kind: 'formatMismatch', path: 'output.headerStyle', message: "must equal the format's header style" });
  }
  if (!deepEqual(a.summaryRows, b.summaryRows)) {
    problems.push({ kind: 'formatMismatch', path: 'output.summaryRows', message: "must equal the format's summary rows" });
  }

  // SPEC 8.12: "except columns[].from" - every other column field (header, format,
  // width, agg) must match, in the same order, so a reordering surfaces as a header
  // mismatch at the index where the sequences first diverge.
  const maxLen = Math.max(a.columns.length, b.columns.length);
  for (let i = 0; i < maxLen; i++) {
    const ac = a.columns[i];
    const bc = b.columns[i];
    if (!ac || !bc) {
      problems.push({
        kind: 'formatMismatch',
        path: `output.columns[${i}]`,
        message: bc ? `missing output column "${bc.header}"` : `extra output column "${ac?.header}"; the format has no such column`,
      });
      continue;
    }
    if (ac.header !== bc.header) {
      problems.push({ kind: 'formatMismatch', path: `output.columns[${i}].header`, message: `must equal the format's header "${bc.header}", got "${ac.header}"` });
    }
    if (ac.format !== bc.format) {
      problems.push({ kind: 'formatMismatch', path: `output.columns[${i}].format`, message: `must equal the format's format ${JSON.stringify(bc.format)}, got ${JSON.stringify(ac.format)}` });
    }
    if (ac.width !== bc.width) {
      problems.push({ kind: 'formatMismatch', path: `output.columns[${i}].width`, message: `must equal the format's width ${JSON.stringify(bc.width)}, got ${JSON.stringify(ac.width)}` });
    }
    if (ac.agg !== bc.agg) {
      problems.push({ kind: 'formatMismatch', path: `output.columns[${i}].agg`, message: `must equal the format's agg ${JSON.stringify(bc.agg)}, got ${JSON.stringify(ac.agg)}` });
    }
  }
}

function compareSort(a: readonly FormatSortKey[], b: readonly FormatSortKey[], problems: FormatProblem[]): void {
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    const ak = a[i];
    const bk = b[i];
    if (!deepEqual(ak, bk)) {
      problems.push({
        kind: 'formatMismatch',
        path: `layout.sort[${i}]`,
        message: `must equal the format's sort key ${JSON.stringify(bk)}, got ${JSON.stringify(ak)}`,
      });
    }
  }
}

function compareGroup(a: FormatGroup | undefined, b: FormatGroup | undefined, problems: FormatProblem[]): void {
  if (!deepEqual(a, b)) {
    problems.push({
      kind: 'formatMismatch',
      path: 'layout.group',
      message: `must equal the format's group ${JSON.stringify(b)}, got ${JSON.stringify(a)}`,
    });
  }
}

/** SPEC 8.12/DECISION: output validations are compared as a set, not a sequence - the
 * spec says they "must equal the format's" without saying order matters, and the rules
 * map editor (8.11) lets a user reorder checks freely. */
function canonicalValidationKey(v: Validation): string {
  return JSON.stringify(v, Object.keys(v).sort());
}

function compareValidations(a: readonly Validation[], b: readonly Validation[], problems: FormatProblem[]): void {
  const aKeys = a.map(canonicalValidationKey).sort();
  const bKeys = b.map(canonicalValidationKey).sort();
  if (JSON.stringify(aKeys) !== JSON.stringify(bKeys)) {
    problems.push({
      kind: 'formatMismatch',
      path: 'validations',
      message: "output validations must equal the format's",
    });
  }
}

/**
 * Checks a conversion's rules against the format it belongs to (SPEC 8.12). Reuses
 * `formatOf` to normalize `rules` the same way the stored `format` itself was built, so
 * the two sides are always compared on equal terms (ids -> output headers, `file`
 * defaulted, `columns[].from` stripped) before the field-by-field comparison below.
 */
export function checkFormatLock(rules: LearnResult | Rules, format: Format): FormatProblem[] {
  const problems: FormatProblem[] = [];
  const ruleFormat = formatOf(rules);

  compareOutput(ruleFormat.output, format.output, problems);
  compareSort(ruleFormat.layout.sort, format.layout.sort, problems);
  compareGroup(ruleFormat.layout.group, format.layout.group, problems);
  compareValidations(ruleFormat.outputValidations, format.outputValidations, problems);

  return problems;
}
