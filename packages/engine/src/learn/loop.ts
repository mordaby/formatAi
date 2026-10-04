// The learning loop (SPEC 9.3, docs/proposals/learning-loop.md 3.2): the AI step answers, the browser runs the answer on every row of the
// example, and while rows are still wrong it sends some of them - masked like every sample - for another round, as long as each round
// lowers the number of wrong rows. This module is the loop's one driver: a pure, deterministic step function that `learnFromExamples`
// calls after every verified answer, so the web app and the eval harness (which both run `learnFromExamples`) loop exactly the same way.
//
//   answer -> full verification -> loopStep: done | stop (why) | next round (which rows, which problems) -> repair call -> answer ...
//
// Stop rules, in this order: every row matches -> done; the answer is not better than the best one so far (fewer wrong rows) -> stop
// `noProgress`; `maxRounds` rounds made -> `roundCap`; no row left under `maxRowsTotal` -> `rowCap`; no row fits under the payload byte
// cap -> `payloadCap`; nothing to tell the AI step at all -> `nothingToSend`. The answer kept is the best one: the fewest wrong rows,
// ties keeping the earliest (like the API's `bestOf`).
//
// Which rows (the counterexamples): the wrong rows are grouped by what went wrong - (output column, the example's value, the value the
// rules made); one row from each group, biggest groups first, then a second row from each, and so on until the round is full. A row the
// payload or an earlier round already sent is never sent again (the server checks every answer against all of them anyway).
import type { LearnPayload, PayloadCell, ProfileType, RepairProblem, Sample } from '@formatai/shared';
import { limits, payloadBytes, payloadRowCount, withRows } from '@formatai/shared';
import type { RawCell } from '../types';
import type { PairAnalysis } from './analyze';
import { isoOfSerial } from './analyze/cells';
import type { Masker } from './mask';
import { counterexampleSample } from './payload';
import type { WrongCell, WrongRow } from './verify';

/** LEARN_PROMPT §4: "At most 10 diff problems are sent." */
const MAX_DIFF_PROBLEMS = 10;

/** Why the loop ended without every row matching. */
export const LOOP_STOP_REASONS = ['noProgress', 'roundCap', 'rowCap', 'payloadCap', 'nothingToSend'] as const;
export type LoopStopReason = (typeof LOOP_STOP_REASONS)[number];

/** The loop's caps: `limits.learn.loop` and the payload byte cap. */
export interface LoopCaps {
  maxRounds: number;
  rowsPerRound: number;
  maxRowsTotal: number;
  maxBytes: number;
}

export function loopCaps(): LoopCaps {
  return { ...limits.learn.loop, maxBytes: limits.payload.maxBytes };
}

/** One row of the example sent by the loop: the input row it is (so it is never sent twice) and its sample, masked like the payload's. */
export interface CounterexampleRow {
  inRow: number;
  sample: Sample;
}

export interface LoopState {
  /** Loop rounds made so far (browser-triggered repair calls). */
  rounds: number;
  /** Every counterexample row sent so far, in the order sent. */
  sent: CounterexampleRow[];
  /** Input rows the payload itself already sends (its samples and dropped rows): never sent again. */
  inPayload: number[];
  /** Answers judged so far. */
  answers: number;
  /** The best answer so far (an index into the answers, in the order judged; -1: none yet) and its wrong rows. */
  best: number;
  bestWrong: number;
}

/** The loop before the first answer. `inPayload`: the input rows of the payload's samples and dropped rows (`BuildPayloadResult`). */
export function startLoop(inPayload: readonly number[]): LoopState {
  return { rounds: 0, sent: [], inPayload: [...inPayload], answers: 0, best: -1, bestWrong: Number.POSITIVE_INFINITY };
}

/** The latest answer, as the browser judged it on every row of the example. */
export interface LoopAnswer {
  /** Usable rules came back (false: the call failed, or nothing that parses came back - it can be no better than what came before). */
  rules: boolean;
  /** The answer is good as it is: every row matches (completion mode: everything it answers for, and the fixed lock holds). */
  passes: boolean;
  /** How wrong it is (`wrongCount`): the yardstick of progress. */
  wrong: number;
  /** The rows it got wrong (`VerifyResult.wrongRows`; in completion mode only the cells it answers for). */
  wrongRows: readonly WrongRow[];
  /** What else to tell the AI step about it (the fixed lock, the row count, layout rows, a column given up on): sent with the rows. */
  otherProblems: readonly RepairProblem[];
}

export interface LoopContext {
  analysis: PairAnalysis;
  /** The payload of the learn call (what the rows are added to, for the byte cap and the server's check). */
  payload: LearnPayload;
  masker?: Masker | undefined;
  caps?: LoopCaps;
}

/** What a round's repair call carries besides the payload, the rules and the problems (`LearnFromExamplesOptions.callRepair`). */
export interface LoopRound {
  /** 1-based. */
  round: number;
  maxRounds: number;
  /** Every row the loop sent so far, this round's included, masked: the repair request's `rows` (the server checks the answer on them). */
  rows: Sample[];
  /** How many of `rows` are this round's. */
  newRows: number;
}

/** How a learn's loop went (`LearnFromExamplesResult.loop`): rounds made, rows sent by them, and how it ended. */
export interface LoopSummary {
  rounds: number;
  /** Counterexample rows sent (the first payload's samples and dropped rows not included). */
  rowsSent: number;
  end: 'verified' | LoopStopReason;
}

export type LoopStep =
  | { kind: 'done' }
  | { kind: 'stop'; reason: LoopStopReason }
  /** Another round: `rows` are this round's new rows, `problems` what the repair call says (LEARN_PROMPT §4). */
  | { kind: 'next'; round: number; rows: CounterexampleRow[]; problems: RepairProblem[] };

/**
 * How wrong an answer is: the output rows that differ (`total - matched`, each counted once however many of its cells differ), the rows the
 * rules make that the example does not have, and each layout difference (title, header, summary and blank rows, the file settings, the row
 * count). DECISION: layout differences count one each, so a round that only fixes a title is still progress; a difference no answer can
 * change (output rows that match no input row) is in every answer's count alike, so it never decides progress.
 */
export function wrongCount(wrongRows: readonly WrongRow[], layoutIssues: number): number {
  let n = layoutIssues;
  for (const row of wrongRows) n += new Set(row.cells.map((c) => c.outRow)).size + row.extra.length;
  return n;
}

const cellKey = (c: WrongCell): string => `${c.out}\u0000${JSON.stringify(c.expected)}\u0000${JSON.stringify(c.actual)}`;
/** DECISION: every row the rules make that the example does not have is one kind of mistake, whatever the row holds. */
const EXTRA_KEY = 'extra';

/**
 * The counterexample rows, in the order to send them (see the file header), at most `limit`: grouped by (output column, expected, actual)
 * - a row belongs to every group one of its cells is in - biggest groups first (ties: the group seen first in the file), then one row from
 * each group in turn. Rows in `skip` (already sent) are never chosen. Pure.
 */
export function pickCounterexamples(wrongRows: readonly WrongRow[], skip: ReadonlySet<number>, limit: number): WrongRow[] {
  if (limit <= 0) return [];
  const groups = new Map<string, WrongRow[]>();
  const add = (key: string, row: WrongRow): void => {
    const list = groups.get(key);
    if (!list) groups.set(key, [row]);
    else if (list[list.length - 1] !== row) list.push(row);
  };
  for (const row of wrongRows) {
    if (skip.has(row.inRow)) continue;
    for (const c of row.cells) add(cellKey(c), row);
    if (row.extra.length > 0) add(EXTRA_KEY, row);
  }
  // (A stable sort: equal sizes keep the order the groups were first seen in.)
  const ordered = [...groups.values()].sort((x, y) => y.length - x.length);
  const picked: WrongRow[] = [];
  const taken = new Set<number>();
  const cursor = ordered.map(() => 0);
  for (let more = true; more && picked.length < limit; ) {
    more = false;
    for (let g = 0; g < ordered.length && picked.length < limit; g++) {
      const list = ordered[g]!;
      while (cursor[g]! < list.length && taken.has(list[cursor[g]!]!.inRow)) cursor[g]!++;
      if (cursor[g]! >= list.length) continue;
      const row = list[cursor[g]!++]!;
      taken.add(row.inRow);
      picked.push(row);
      more = true;
    }
  }
  return picked;
}

/** A value as the AI step may see it: masked like the samples' cells of its column, and cut to the payload's cell length. */
function sendable(v: PayloadCell, type: ProfileType | undefined, masker: Masker | undefined): PayloadCell {
  const masked = masker ? masker.maskCell(v, type ?? 'text') : v;
  const maxChars = limits.payload.maxCellChars;
  return typeof masked === 'string' && masked.length > maxChars ? masked.slice(0, maxChars) : masked;
}

/** A sheet row's cells as payload values (numbers as numbers, real dates as ISO text), like the samples'. */
function rowValues(row: readonly (RawCell | null)[] | undefined, count: number, date1904: boolean): PayloadCell[] {
  const out: PayloadCell[] = [];
  for (let c = 0; c < count; c++) {
    const cell = row?.[c];
    if (!cell || cell.v === null) out.push(null);
    else if (typeof cell.v === 'number' && cell.isDate) out.push(isoOfSerial(Math.trunc(cell.v) + (date1904 ? 1462 : 0)));
    else out.push(cell.v);
  }
  return out;
}

function sendableInput(row: WrongRow, ctx: LoopContext): PayloadCell[] {
  const { analysis, masker } = ctx;
  return rowValues(analysis.input.rows[row.inRow], analysis.input.columnCount, analysis.input.date1904).map((v, i) => sendable(v, analysis.input.profile[i]?.type, masker));
}

/** One `diff` problem for a wrong cell, carrying its row (LEARN_PROMPT §4): every value masked like the samples. */
function cellProblem(row: WrongRow, cell: WrongCell, ctx: LoopContext): RepairProblem {
  const { analysis, masker } = ctx;
  const outProfile = analysis.output.profile;
  const sheetRow = analysis.output.dataRows[cell.outRow];
  // (The example output's real dates are read as the 1900 system, as the payload's samples are.)
  const outCells = rowValues(sheetRow !== undefined ? analysis.output.sheet.rows[sheetRow] : undefined, analysis.output.columnCount, false);
  return {
    kind: 'diff',
    out: cell.out,
    row: { in: sendableInput(row, ctx), out: outCells.map((v, i) => sendable(v, outProfile[i]?.type, masker)) },
    expected: sendable(cell.expected, outProfile[cell.out]?.type, masker),
    actual: sendable(cell.actual, outProfile[cell.out]?.type, masker),
  };
}

/** One `diff` problem for a row the rules make that the example does not have (the shape the full verification gives it). */
function extraProblem(row: WrongRow, made: readonly PayloadCell[], ctx: LoopContext): RepairProblem {
  const outProfile = ctx.analysis.output.profile;
  return {
    kind: 'diff',
    out: 0,
    row: { in: sendableInput(row, ctx), out: made.map((v, i) => sendable(v, outProfile[i]?.type, ctx.masker)) },
    expected: null,
    actual: sendable(made[0] ?? null, outProfile[0]?.type, ctx.masker),
  };
}

/**
 * The diff problems of a round, at most 10 (LEARN_PROMPT §4): first one for each new row (the mistake it was chosen for), then the rest of
 * their wrong cells, then - while there is room - one for each row sent earlier that the answer still gets wrong (it is sent already: this
 * only names it again).
 */
function roundDiffs(chosen: readonly WrongRow[], groupOf: ReadonlyMap<number, string>, stillWrong: readonly WrongRow[], ctx: LoopContext): RepairProblem[] {
  const out: RepairProblem[] = [];
  const used = new Set<string>();
  const push = (key: string, make: () => RepairProblem): void => {
    if (out.length >= MAX_DIFF_PROBLEMS || used.has(key)) return;
    used.add(key);
    out.push(make());
  };
  const first = (row: WrongRow): void => {
    const want = groupOf.get(row.inRow);
    const cell = row.cells.find((c) => cellKey(c) === want) ?? row.cells[0];
    if (cell && want !== EXTRA_KEY) push(`${row.inRow}:c:${cell.out}:${cell.outRow}`, () => cellProblem(row, cell, ctx));
    else if (row.extra[0]) push(`${row.inRow}:x:0`, () => extraProblem(row, row.extra[0]!, ctx));
  };
  for (const row of chosen) first(row);
  for (const row of chosen) {
    for (const cell of row.cells) push(`${row.inRow}:c:${cell.out}:${cell.outRow}`, () => cellProblem(row, cell, ctx));
    row.extra.forEach((made, i) => push(`${row.inRow}:x:${i}`, () => extraProblem(row, made, ctx)));
  }
  for (const row of stillWrong) first(row);
  return out;
}

/** The group each chosen row was chosen for: the biggest group it is in (the order `pickCounterexamples` walks them in). */
function chosenFor(wrongRows: readonly WrongRow[], chosen: readonly WrongRow[]): Map<number, string> {
  const size = new Map<string, number>();
  for (const row of wrongRows) {
    for (const key of new Set(row.cells.map(cellKey))) size.set(key, (size.get(key) ?? 0) + 1);
    if (row.extra.length > 0) size.set(EXTRA_KEY, (size.get(EXTRA_KEY) ?? 0) + 1);
  }
  const out = new Map<number, string>();
  for (const row of chosen) {
    const keys = [...new Set(row.cells.map(cellKey)), ...(row.extra.length > 0 ? [EXTRA_KEY] : [])];
    keys.sort((x, y) => (size.get(y) ?? 0) - (size.get(x) ?? 0));
    if (keys[0] !== undefined) out.set(row.inRow, keys[0]);
  }
  return out;
}

/** Today's order of a repair's problems: the fixed lock's first, then the rows, then the rest (row count, layout, a column given up on). */
function orderProblems(diffs: readonly RepairProblem[], other: readonly RepairProblem[]): RepairProblem[] {
  return [...other.filter((p) => p.kind === 'fixedMismatch'), ...diffs, ...other.filter((p) => p.kind !== 'fixedMismatch')];
}

/**
 * The loop's step (see the file header): folds the latest answer into the state and says what comes next. Pure and deterministic (the
 * masker is keyed: the same row always gets the same fake words).
 */
export function loopStep(state: LoopState, latest: LoopAnswer, ctx: LoopContext): { state: LoopState; step: LoopStep } {
  const caps = ctx.caps ?? loopCaps();
  const index = state.answers;
  const better = latest.rules && latest.wrong < state.bestWrong;
  const next: LoopState = { ...state, answers: index + 1, ...(better ? { best: index, bestWrong: latest.wrong } : {}) };
  const stop = (reason: LoopStopReason): { state: LoopState; step: LoopStep } => ({ state: next, step: { kind: 'stop', reason } });

  if (latest.rules && latest.passes) return { state: { ...next, best: index, bestWrong: Math.min(latest.wrong, next.bestWrong) }, step: { kind: 'done' } };
  if (!better) return stop('noProgress');
  if (state.rounds >= caps.maxRounds) return stop('roundCap');

  const sentRows = new Set([...state.inPayload, ...state.sent.map((r) => r.inRow)]);
  const budget = Math.min(caps.rowsPerRound, caps.maxRowsTotal - payloadRowCount(ctx.payload) - state.sent.length);
  const anyNew = pickCounterexamples(latest.wrongRows, sentRows, 1).length > 0;
  if (anyNew && budget <= 0) return stop('rowCap');

  let chosen = pickCounterexamples(latest.wrongRows, sentRows, budget);
  const rows: CounterexampleRow[] = chosen.map((r) => ({ inRow: r.inRow, sample: counterexampleSample(ctx.analysis, r.inRow, ctx.masker) }));
  const sentSamples = state.sent.map((r) => r.sample);
  while (rows.length > 0 && payloadBytes(withRows(ctx.payload, [...sentSamples, ...rows.map((r) => r.sample)])) > caps.maxBytes) rows.pop();
  if (anyNew && rows.length === 0) return stop('payloadCap');
  chosen = chosen.slice(0, rows.length);

  const stillWrong = latest.wrongRows.filter((r) => sentRows.has(r.inRow));
  const problems = orderProblems(roundDiffs(chosen, chosenFor(latest.wrongRows, chosen), stillWrong, ctx), latest.otherProblems);
  if (problems.length === 0) return stop('nothingToSend');

  const round = state.rounds + 1;
  return { state: { ...next, rounds: round, sent: [...state.sent, ...rows] }, step: { kind: 'next', round, rows, problems } };
}
