// "Update your format X, or save as a new format?" at Save (owner decisions 2026-10-07, SPEC 5 A step 8, 8.12): learning the same output from
// the same kind of input file again - next month's, with other values - must not make a second format by accident. Before "Save format" creates
// a NEW format, the learned output is compared with the user's saved formats, by the OUTPUT (the engine's `findFormatMatches`, in the worker:
// the same structure, then whether the example input is one of that format's inputs, then the format lock); only a format this input already
// feeds is offered - an update of its rules. (Another input for a format is asked at Learn, before anything is learned: "This output matches
// your format" - see the learn flow's `matchesFormat`.) Nothing is asked when nothing matches: Save goes on at once. It does not depend on the
// feature switch.
//
// What is read: the list of formats (fetched when the result is shown, so a Save with no match waits for nothing), and - only for the formats
// whose headers and file type already agree - their output side and conversions, and the sources' signatures. Structure only: no value of
// the example is sent anywhere, and the comparison runs in the browser. Any failure is no offer: Save goes on as before.
import { normalizeOutputHeader, type Format, type FormatSummary, type LearnResult, type Rules, type SignatureEntry } from '@formatai/shared';
import type { FormatMatch, FormatProblem, SavedFormatCandidate } from '@formatai/engine';
import { useCallback, useEffect, useRef } from 'react';
import type { EditableRules } from '../../editor';
import { outputFileType } from '../../flow/download';
import { useServices } from '../../services';
import { signatureOf } from '../Convert/logic';

/** Why the rules cannot be added to the format as they are: the format lock's problems, in the words the dialog uses. */
export type LockReason =
  | { kind: 'title' | 'width' | 'file' | 'sheet' | 'direction' | 'language' | 'headerStyle' | 'summaryRows' | 'sort' | 'group' | 'checks' | 'columns' }
  | { kind: 'numberFormat'; column: string };

/** One saved format the learned rules are saved into (see the file header). */
export interface FormatOffer {
  formatId: string;
  formatName: string;
  /** How many inputs (sources) it has now. */
  sources: number;
  /**
   * `update`: the example input is one of its inputs - saving writes a new version of that conversion (Save asks first). `attach`: the file
   * becomes another input of it - the learn was for that format ("Yes, learn it for X" at Learn), so Save adds it with no question.
   */
  kind: 'update' | 'attach';
  /** `update`: the conversion, its version (the save's `baseVersion`), its source's name and how many formats that source feeds. */
  conversion?: { id: string; version: number; sourceName: string; sourceFormats: number };
  /** `update`: what the update changes in the format (for all its inputs); empty when nothing. */
  reasons: LockReason[];
  /** The format's output side as stored: what a csv's rules take before they are saved into it (`withUnwrittenOutputOf`). */
  format: Format;
}

/** The format lock's problems as reasons: one per kind, in order (a column's number format names the column). */
export function lockReasons(problems: readonly FormatProblem[], headers: readonly string[]): LockReason[] {
  const out: LockReason[] = [];
  const add = (r: LockReason): void => {
    if (!out.some((x) => x.kind === r.kind)) out.push(r);
  };
  for (const p of problems) {
    const column = /^output\.columns\[(\d+)\](?:\.(\w+))?$/.exec(p.path);
    if (column) {
      const field = column[2];
      if (field === 'format') add({ kind: 'numberFormat', column: headers[Number(column[1])] ?? '' });
      else if (field === 'width') add({ kind: 'width' });
      else if (field === 'agg') add({ kind: 'group' });
      else add({ kind: 'columns' });
    } else if (p.path === 'output.titleRows') add({ kind: 'title' });
    else if (p.path === 'output.file') add({ kind: 'file' });
    else if (p.path === 'output.sheetName') add({ kind: 'sheet' });
    else if (p.path === 'output.direction') add({ kind: 'direction' });
    else if (p.path === 'output.language') add({ kind: 'language' });
    else if (p.path === 'output.headerStyle') add({ kind: 'headerStyle' });
    else if (p.path === 'output.summaryRows') add({ kind: 'summaryRows' });
    else if (p.path.startsWith('layout.sort')) add({ kind: 'sort' });
    else if (p.path.startsWith('layout.group')) add({ kind: 'group' });
    else if (p.path === 'validations') add({ kind: 'checks' });
    else add({ kind: 'columns' });
  }
  return out;
}

/**
 * The engine's matches as offers: only the formats this input already feeds (an update). `signatures`: how many formats each source feeds;
 * `formats`: each candidate's stored output side, by id.
 */
export function offersOf(matches: readonly FormatMatch[], rules: LearnResult | Rules, signatures: readonly SignatureEntry[], formats: ReadonlyMap<string, Format>): FormatOffer[] {
  const headers = rules.output.columns.map((c) => c.header);
  return matches.flatMap((m): FormatOffer[] => {
    const format = formats.get(m.formatId);
    if (!format) return [];
    const reasons = lockReasons(m.lock, headers);
    if (m.same) {
      const entry = signatures.find((s) => s.sourceId === m.same!.sourceId);
      const sourceFormats = entry ? new Set(entry.conversions.map((c) => c.formatId)).size : 1;
      return [
        {
          formatId: m.formatId,
          formatName: m.formatName,
          sources: m.sources,
          kind: 'update',
          conversion: { id: m.same.id, version: m.same.version, sourceName: m.same.sourceName, sourceFormats: Math.max(1, sourceFormats) },
          reasons,
          format,
        },
      ];
    }
    // (another input for the format is not offered here: it is asked at Learn, before the learn)
    return [];
  });
}

/** The saved formats whose headers (in order) and file type are the rules' own: the only ones worth reading in full. */
export function candidateSummaries(formats: readonly FormatSummary[], rules: EditableRules): FormatSummary[] {
  if (rules.output.file?.header === false) return [];
  const headers = rules.output.columns.map((c) => normalizeOutputHeader(c.header));
  if (headers.length === 0) return [];
  const fileType = outputFileType(rules);
  return formats.filter(
    (f) => f.fileType === fileType && f.outputHeaders.length === headers.length && f.outputHeaders.every((h, i) => normalizeOutputHeader(h) === headers[i]),
  );
}

/** "Most recently used": its last run or its last change, whichever is later. */
function usedAt(f: FormatSummary): string {
  return f.lastRunAt && f.lastRunAt > f.updatedAt ? f.lastRunAt : f.updatedAt;
}

export interface UseFormatMatch {
  /** Known right now, with nothing to wait for: no saved format has these headers and this file type (the save goes at once). */
  surelyNone(rules: EditableRules): boolean;
  /** The saved formats the learned output is, most recently used first; none when nothing matches (or anything failed). */
  find(rules: EditableRules, inputHeaders: readonly string[] | undefined): Promise<FormatOffer[]>;
}

/** `enabled`: a signed-in user with a learn not saved yet, not learned for a chosen format (the list is read once, in the background, as soon as it is). */
export function useFormatMatch(enabled: boolean): UseFormatMatch {
  const { api, engine } = useServices();
  const list = useRef<Promise<FormatSummary[]> | null>(null);
  const loaded = useRef<FormatSummary[] | null>(null);
  const read = useCallback((): Promise<FormatSummary[]> => {
    list.current ??= api.registry
      .listFormats()
      .catch((): FormatSummary[] => [])
      .then((formats) => {
        loaded.current = formats;
        return formats;
      });
    return list.current;
  }, [api]);

  useEffect(() => {
    if (enabled) void read();
  }, [enabled, read]);

  const surelyNone = useCallback((rules: EditableRules): boolean => loaded.current !== null && candidateSummaries(loaded.current, rules).length === 0, []);

  const find = useCallback(
    async (rules: EditableRules, inputHeaders: readonly string[] | undefined): Promise<FormatOffer[]> => {
      try {
        const candidates = candidateSummaries(await read(), rules);
        if (candidates.length === 0) return [];
        const [details, signatures] = await Promise.all([Promise.all(candidates.map((f) => api.registry.getFormat(f.id))), api.registry.signatures()]);
        const saved: SavedFormatCandidate[] = details.map((d, i) => ({
          id: d.format.id,
          name: d.format.name,
          format: { output: d.format.output, layout: d.format.layout, outputValidations: d.format.outputValidations } as SavedFormatCandidate['format'],
          usedAt: usedAt(candidates[i]!),
          conversions: d.conversions.map((c) => ({ id: c.id, sourceId: c.sourceId, sourceName: c.sourceName, version: c.version })),
        }));
        const matches = await engine.formatMatches({
          rules,
          ...(inputHeaders && inputHeaders.length > 0 ? { inputHeaders: [...inputHeaders] } : {}),
          candidates: saved,
          sources: signatures.map(signatureOf),
        });
        return offersOf(matches, rules, signatures, new Map(saved.map((c) => [c.id, c.format] as const)));
      } catch {
        return []; // no offer, no harm: Save goes on as before
      }
    },
    [api, engine, read],
  );
  return { surelyNone, find };
}
