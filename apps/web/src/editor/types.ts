// Types of the rules-editor model (SPEC 8.11). Pure data: no React, no engine, no worker.
import type {
  ColumnType,
  Dedupe,
  Expand,
  FilterScalar,
  LearnResult,
  OutputColumnAgg,
  OutputFile,
  ProfileType,
  RowFilterOp,
  Rules,
  RulesTable,
  SortKey,
  SummaryRow,
  TitleRow,
  Validation,
  ValueType,
} from '@formatai/shared';

/** What the editor edits: a saved conversion, or the fresh result of a learn (no name/meta yet). */
export type EditableRules = LearnResult | Rules;

/**
 * A line of the rules map (SPEC 8.11). These ids are the contract with the rules map:
 * `col:<output header>`, `filter:<i>`, `dedupe`, `expand`, `sort`, `group`, `summary:end:<i>`,
 * `summary:group:<i>`, `title:<i>`, `check:<i>`, `fn:<name>`, `table:<name>`.
 */
export type LineId = string;

// ---------- Column methods (SPEC 8.11 "Column editor: How is it made?") ----------

export type CalcOp = '+' | '-' | '*' | '/';

/** A term of a calculation: a column (or a number). `toNumber` reads a text column's value as a number. */
export type CalcTerm = { column: string; toNumber?: boolean } | { number: number };

export interface TranslatePair {
  /** The value in the input. */
  from: string;
  /** The value in the output (an empty text leaves the cell empty). */
  to: string;
}

export type ColumnMethod =
  | { kind: 'copy'; source: string; padLeft?: number; trim?: boolean }
  | { kind: 'calculate'; terms: CalcTerm[]; ops: CalcOp[]; round?: number }
  /** `before`/`after` are optional fixed text at the start and end (e.g. "ID: "); `separator` goes between the columns. */
  | { kind: 'join'; columns: string[]; separator: string; before?: string; after?: string }
  | { kind: 'partOfText'; source: string; part: 'first' | 'last'; n: number }
  | { kind: 'translate'; source: string; pairs: TranslatePair[]; onMissing: 'flag' | 'keep' }
  | { kind: 'fixed'; value: string | number | boolean }
  | { kind: 'empty' }
  /** Advanced: any formula text (`round(amount * 0.17, 2)`, `if(...)`). `type` is the result type of the column. */
  | { kind: 'formula'; formula: string; type?: ColumnType };

// ---------- Problems (typed, so the UI can say them in the user's language) ----------

export type EditProblemCode =
  | 'unknownColumn'
  | 'noSuchItem'
  | 'emptyHeader'
  | 'duplicateHeader'
  | 'typeMismatch'
  | 'tooManyTerms'
  | 'tooFewTerms'
  | 'badOperators'
  | 'badValue'
  | 'duplicateKey'
  | 'noGroup'
  | 'formula'
  | 'json'
  | 'schema'
  | 'reference'
  | 'rule';

export interface EditProblem {
  code: EditProblemCode;
  /** A short English sentence, in the wording of the engine's own type checker where one exists. */
  message: string;
  /** Dotted path into the rules (or into the action), when there is one. */
  path?: string;
  /** The output column (header) or input column (id) the problem is about. */
  column?: string;
  /** Formula problems: the character offset in the text. */
  offset?: number;
}

export type ActionResult = { ok: true; changed: boolean } | { ok: false; problems: EditProblem[] };

// ---------- Actions ----------

export interface FilterInput {
  column: string;
  op: RowFilterOp;
  /** Not for isEmpty/notEmpty; an array for oneOf/notOneOf. A text for a numeric column is read as a number. */
  value?: FilterScalar | FilterScalar[];
}

/** Like `Expand`, but a fixed fan-out's `set` values are formula text (parsed by the model). */
export type ExpandInput =
  | Extract<Expand, { mode: 'columnsToRows' }>
  | Extract<Expand, { mode: 'splitCell' }>
  | { mode: 'fixedFanOut'; rows: { set: Record<string, string> }[] };

export interface GroupInput {
  by: string;
  showDetailRows: boolean;
  blankRowsAfter?: number;
}

export type SummaryScope = 'end' | 'group';

export interface OutputOptionsPatch {
  sheetName?: string;
  direction?: 'rtl' | 'ltr';
  language?: 'he' | 'en';
  headerBold?: boolean;
  file?: OutputFile;
}

export interface FunctionInput {
  name: string;
  params: { name: string; type: ValueType }[];
  returns: ValueType;
  /** Formula text; may use the params and other functions defined above, never a column. */
  body: string;
}

export type EditAction =
  // Columns
  | { type: 'setColumnHeader'; index: number; header: string }
  | { type: 'reorderColumns'; from: number; to: number }
  | { type: 'addColumn'; header?: string; at?: number; method?: ColumnMethod }
  | { type: 'removeColumn'; index: number }
  | { type: 'setColumnMethod'; index: number; method: ColumnMethod }
  | { type: 'setColumnFormat'; index: number; format?: string | null; width?: number | null }
  | { type: 'setColumnAgg'; index: number; agg: OutputColumnAgg | null }
  // Rows
  | { type: 'addFilter'; filter: FilterInput; at?: number }
  | { type: 'updateFilter'; index: number; filter: FilterInput }
  | { type: 'removeFilter'; index: number }
  | { type: 'setDedupe'; enabled: boolean; keys?: 'all' | string[]; keep?: Dedupe['keep']; action?: Dedupe['action'] }
  | { type: 'setExpand'; expand: ExpandInput | null }
  // Layout
  | { type: 'setTitleRows'; rows: TitleRow[] }
  | { type: 'addTitleRow'; row: TitleRow; at?: number }
  | { type: 'removeTitleRow'; index: number }
  | { type: 'setTitleText'; index: number; text: string; bold?: boolean }
  /** "Insert month from [date column]": builds `parts` (SPEC 8.7). */
  | { type: 'insertMonthFromDate'; index: number; column: string; agg?: 'min' | 'max'; format?: string }
  | { type: 'setSort'; keys: SortKey[] }
  | { type: 'setGroup'; group: GroupInput | null }
  | { type: 'setSummaryRows'; scope: SummaryScope; rows: SummaryRow[] }
  | { type: 'addSummaryRow'; scope: SummaryScope; row: SummaryRow; at?: number }
  | { type: 'updateSummaryRow'; scope: SummaryScope; index: number; row: SummaryRow }
  | { type: 'removeSummaryRow'; scope: SummaryScope; index: number }
  | { type: 'setOutputOptions'; patch: OutputOptionsPatch }
  // Checks
  | { type: 'addValidation'; validation: Validation; at?: number }
  | { type: 'updateValidation'; index: number; validation: Validation }
  | { type: 'removeValidation'; index: number }
  // "Please check" items: Keep
  | { type: 'dismissAssumption'; index: number }
  // Functions and tables (SPEC 8.14)
  | { type: 'setFunction'; fn: FunctionInput }
  | { type: 'removeFunction'; name: string }
  | { type: 'setTable'; table: RulesTable }
  | { type: 'removeTable'; name: string }
  // One-off exceptions: 1-based rows of the example output, stored beside the rules (SPEC 8.11)
  | { type: 'markException'; row: number }
  | { type: 'unmarkException'; row: number }
  // Advanced view
  | { type: 'setAdvancedJson'; text: string };

export type EditActionType = EditAction['type'];

// ---------- State ----------

export interface Snapshot {
  rules: EditableRules;
  exceptions: number[];
}

export interface FormatInfo {
  /** "This changes the format for all N sources" (SPEC 8.12). */
  sourceCount: number;
}

/** What the editor knows about the SOURCE the conversion reads (SPEC 8.15). */
export interface SourceInfo {
  /** How many formats the source feeds (this conversion's included): "This changes the source for N formats" is said only when it is more than 1. */
  formats: number;
}

export interface EditorState {
  rules: EditableRules;
  history: { past: Snapshot[]; future: Snapshot[] };
  /** Lines the user changed (against the rules as opened), for the "Edited by you" status. */
  edited: ReadonlySet<LineId>;
  /** 1-based example-output rows marked "fixed by hand". They only affect checking the example. */
  exceptions: number[];
  /** Differs from what was last saved (or opened). */
  dirty: boolean;
  /** The conversion belongs to a format and the output side has changed (SPEC 8.12). */
  formatChange: boolean;
  /** Set when the conversion belongs to a format. */
  format: FormatInfo | null;
  /** Set when the conversion's source is known (a saved conversion). */
  source: SourceInfo | null;
  /** The source is known and the input side has changed (SPEC 8.15): an edit of it is an edit of the source, for every format it feeds. */
  sourceChange: boolean;
  /** Bumped by every change of rules or exceptions: a cheap "is this result still current" key. */
  rev: number;
  // ----- bookkeeping -----
  /** The rules as opened: the "edited by you" comparison and the format-change comparison start here. */
  baseline: EditableRules;
  /** Edited lines carried over from an earlier session. */
  baseEdited: readonly LineId[];
  /** What is saved. */
  saved: Snapshot;
  historyCap: number;
}

export interface EditorOptions {
  exceptions?: number[];
  /** The format this conversion belongs to. Default: `{ sourceCount: 1 }` when `rules.meta.formatId` is set, else none. */
  format?: FormatInfo | null;
  /** The source this conversion reads (SPEC 8.15). Default: none known. */
  source?: SourceInfo | null;
  /** Lines already known to be edited (from an earlier session). */
  edited?: readonly LineId[];
  historyCap?: number;
}

// ---------- Column method reading (what the editor shows for an existing column) ----------

export type ReadMethod = ColumnMethod;

/**
 * One column of the example INPUT file, as the editor needs it (headers and facts about the values, never the values
 * themselves). The worker builds these from the kept analysis; the file is the user's own and stays in the browser.
 */
export interface ExampleInputColumn {
  header: string;
  type: ProfileType;
  israeliId?: boolean;
  leadingZerosLost?: boolean;
  serialDates?: boolean;
  /** Longest text length of the values (ids), so a padded id can be declared with the right width. */
  maxLength?: number;
  /** Date columns: the token format of text dates ("DD/MM/YYYY"), or "excel" for real date cells. */
  dateFormat?: string;
}

/** One choice in a "source column" dropdown. */
export interface SourceOption {
  id: string;
  /** What to show: the input header, or the output header of the computed column that feeds it. */
  label: string;
  type: ValueType | undefined;
  /**
   * `available`: a column of the example input file that no rule declares yet. Choosing it declares it (in the same edit
   * that uses it), so the id is the one it will have once declared.
   */
  kind: 'input' | 'expand' | 'computed' | 'available';
}
