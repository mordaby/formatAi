// "An honest unsupported is not a mismatch" has one exception: the answer gives up on a column the app's own pair analysis already traced to
// the input. The payload's hints are that analysis (relations tested on ALL rows of the real data, every one at or above the minimum
// coverage), so a hint for an output column the answer reports as unsupported is positive evidence that it can be produced:
// `unsupportedDespiteEvidence` turns it into a problem for the repair round - one more call, with the columns and the kind of relation
// named, never a value. A column with NO hint stays an honest unsupported (it needs no repair and is never compared).
//
// Pure, and shared by the API's checks (the server repair round) and the engine's browser flow (the browser-triggered repair).
import { columnsReportedUnsupported } from './completion';
import type { ColumnHint, Hint, LearnPayload, RepairProblem } from './payload';
import type { LearnResult, Rules } from './rules/schema';

/** What the pair analysis found about one output column: the kind of relation, and the input columns (positions) it reads. */
export interface ColumnEvidence {
  kind: string;
  inputs: number[];
}

/** The input columns a column hint reads: `in`, plus a window's group (`by`) and order columns. No duplicates, in order. */
function inputsOf(h: ColumnHint): number[] {
  const cols: number[] = [...(h.in ?? [])];
  if (h.rel === 'window') {
    cols.push(...(h.by ?? []));
    if (Array.isArray(h.order)) cols.push(...h.order.map((k) => k.in));
  }
  return [...new Set(cols)];
}

function kindOf(h: ColumnHint): string {
  return h.rel === 'window' ? `window ${h.fn}` : h.rel;
}

/**
 * The evidence the hints hold for each output column position: the first hint that names the column. A hint for an output column is a
 * column hint (`out`), or one of the expand hints that create output columns (`labelOut` / `valueOut`, a split's `out`, the per-position
 * hints of a fixed fan-out). Row hints (a filter, a dedupe) say nothing about a column.
 */
export function evidenceByOutput(hints: readonly Hint[]): Map<number, ColumnEvidence> {
  const found = new Map<number, ColumnEvidence>();
  const add = (out: number, kind: string, inputs: number[]): void => {
    if (!found.has(out)) found.set(out, { kind, inputs });
  };
  for (const h of hints) {
    if (h.rel === 'filter' || h.rel === 'dedupe') continue;
    if (h.rel === 'expand') {
      if (h.mode === 'columnsToRows') {
        add(h.labelOut, 'expand', h.in);
        add(h.valueOut, 'expand', h.in);
      } else if (h.mode === 'splitCell') {
        add(h.out, 'expand', h.in);
      } else {
        for (const position of h.positions) for (const p of position) add(p.out, kindOf(p), inputsOf(p));
      }
      continue;
    }
    add(h.out, kindOf(h), inputsOf(h));
  }
  return found;
}

const quoted = (names: readonly string[]): string => names.map((n) => `"${n}"`).join(', ');

/**
 * One `unsupportedDespiteEvidence` problem for every output column that `rules` reports as unsupported (`from: null` plus an entry, any reason
 * code) although `payload.hints` hold evidence for it. Completion mode: only the columns the AI step was asked for (`complete.columns`) - an
 * unsupported entry of the user's own rules is theirs, the answer must copy it.
 */
export function unsupportedDespiteEvidence(
  rules: LearnResult | Rules,
  payload: Pick<LearnPayload, 'input' | 'output' | 'hints' | 'complete'>,
): RepairProblem[] {
  const reported = columnsReportedUnsupported(rules);
  if (reported.length === 0) return [];
  const evidence = evidenceByOutput(payload.hints);
  if (evidence.size === 0) return [];

  const inputHeader = new Map(payload.input.columns.map((c) => [c.i, c.header] as const));
  const outputAt = new Map(payload.output.columns.map((c) => [c.header, c.i] as const));
  const asked = payload.complete ? new Set(payload.complete.columns) : undefined;

  const problems: RepairProblem[] = [];
  for (const position of reported) {
    const header = rules.output.columns[position]!.header;
    const out = outputAt.get(header) ?? position;
    if (asked && !asked.has(out)) continue;
    const found = evidence.get(out);
    if (!found) continue;
    const names = found.inputs.map((i) => inputHeader.get(i)).filter((n): n is string => n !== undefined);
    const message =
      names.length > 0
        ? `Column "${header}": the app found it is built from ${quoted(names)} (${found.kind}); write a rule for it.`
        : `Column "${header}": the app found a rule for it (${found.kind}); write a rule for it.`;
    problems.push({ kind: 'unsupportedDespiteEvidence', out, message });
  }
  return problems;
}
