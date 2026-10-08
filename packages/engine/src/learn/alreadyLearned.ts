// "You already have this format" (owner decision 2026-10-07, SPEC 5 A step 2a): before a learn, when the user has saved formats, code checks
// whether the rules they already have make THIS example - so nothing is learned, no AI format is spent and no second format is made. Run in the
// browser's worker on the pair analysis the learn has already made (nothing is read again); the user's saved rules come from their own
// formats (the main thread reads them from the API: structure and rules only, the example never leaves the browser).
//
//   1. The example's OUTPUT structure is the saved format's (`ExampleShape`, from the analysis: the output headers in order - spaces around and
//      inside a header do not count, as in `sameOutputStructure` - the file kind and a header row). An output with no header row never matches.
//      This is the cheap part, and the only one that runs when nothing matches.
//   2. The example's INPUT is one of that format's sources: the same file-to-source matching and threshold as the Save check and flow C
//      (`pickExampleSource`: one clear winner over ALL the user's sources, no required column missing), and that source feeds the format.
//   3. Only then is anything run: that conversion's SAVED rules on the example input, judged by the learn's own full verification
//      (`verifyAgainstExample`: every data row and cell, the row count, the row ORDER, the title / header / blank / summary rows and the file
//      settings). An output those rules make exactly has the format's structure (titles, summary rows, grouping) by construction.
// Several formats: each format / source pair in turn, most recently used first; the first whose rules make the example is the answer. A pair
// whose rules do not (the logic changed) is reported in `differs`: the learn goes on as usual and may say so.
import { normalizeOutputHeader, outputStructureOf, type LearnResult, type Rules } from '@formatai/shared';
import { pickExampleSource, type SavedFormatCandidate } from '../registry/matchFormats';
import type { ConversionSignatureInput } from '../registry/matchConversions';
import type { PairAnalysis } from './analyze';
import { verifyAgainstExample } from './verify';

/** What the example looks like, for finding the saved formats worth a look: headers and file kind only (no value). */
export interface ExampleShape {
  /** The example output's headers, in order (as the file has them). */
  outputHeaders: string[];
  fileType: 'xlsx' | 'csv' | 'txt';
  /** The output has a header row (one without never matches: its headers are names code made up). */
  headerRow: boolean;
  /** The example input's headers (what its source is matched on). */
  inputHeaders: string[];
}

/** The user's saved formats whose output has the example's headers and file kind, with their conversions, and every source's signature. */
export interface KnownCandidates {
  formats: readonly SavedFormatCandidate[];
  sources: readonly ConversionSignatureInput[];
}

/**
 * Where the user's saved formats come from (the browser: the API, through the main thread). `candidates` is asked once, with the example's
 * shape; `rules` only for a pair whose structure and source both match, one at a time. Either may answer nothing (null / empty): no match.
 */
export interface KnownFormats {
  candidates(example: ExampleShape): Promise<KnownCandidates>;
  rules(conversionId: string): Promise<Rules | LearnResult | null>;
}

/** One saved format / source pair (names and ids only). */
export interface KnownPair {
  formatId: string;
  formatName: string;
  conversionId: string;
  /** The source's name (kept for the record; the screen does not name sources unless "Formats with several sources" is on). */
  sourceName: string;
}

export interface AlreadyLearnedCheck {
  /** The first pair whose saved rules make the example exactly; null when none does (or none was worth running). */
  match: KnownPair | null;
  /** Pairs whose structure and source matched but whose saved rules make something else (the logic changed), in the order tried. */
  differs: KnownPair[];
  /** How many saved rules were run on the example (0 when no structure and source matched). */
  ran: number;
}

const NONE: AlreadyLearnedCheck = { match: null, differs: [], ran: 0 };

/** The example's shape, from the pair analysis. */
export function exampleShapeOf(analysis: PairAnalysis): ExampleShape {
  return {
    outputHeaders: [...analysis.output.headers],
    fileType: analysis.layout.file.type,
    headerRow: !analysis.output.headerless,
    inputHeaders: [...analysis.input.headers],
  };
}

/** The saved format's output has the example's headers (in order, spaces not counted), file kind and a header row. */
export function sameShape(example: ExampleShape, candidate: SavedFormatCandidate): boolean {
  if (!example.headerRow || example.outputHeaders.length === 0) return false;
  const saved = outputStructureOf(candidate.format);
  if (!saved || saved.fileType !== example.fileType || saved.headers.length !== example.outputHeaders.length) return false;
  return saved.headers.every((h, i) => h === normalizeOutputHeader(example.outputHeaders[i] ?? ''));
}

/** The format / source pairs worth running, most recently used first: the format's shape is the example's, and the example input is its source. */
export function knownPairs(example: ExampleShape, known: KnownCandidates): KnownPair[] {
  const same = known.formats.filter((f) => sameShape(example, f));
  if (same.length === 0) return [];
  const sourceId = pickExampleSource(example.inputHeaders, known.sources);
  if (sourceId === null) return [];
  return [...same]
    .sort((a, b) => (a.usedAt > b.usedAt ? -1 : a.usedAt < b.usedAt ? 1 : a.name.localeCompare(b.name)))
    .flatMap((f) => {
      const c = f.conversions.find((x) => x.sourceId === sourceId);
      return c ? [{ formatId: f.id, formatName: f.name, conversionId: c.id, sourceName: c.sourceName }] : [];
    });
}

/** Runs the check (see the file header). Any failure to read is no match: the learn goes on as if the user had no saved format. */
export async function findAlreadyLearned(analysis: PairAnalysis, known: KnownFormats): Promise<AlreadyLearnedCheck> {
  const example = exampleShapeOf(analysis);
  if (!example.headerRow) return NONE;
  let pairs: KnownPair[];
  try {
    pairs = knownPairs(example, await known.candidates(example));
  } catch {
    return NONE;
  }
  const differs: KnownPair[] = [];
  let ran = 0;
  for (const pair of pairs) {
    let rules: Rules | LearnResult | null;
    try {
      rules = await known.rules(pair.conversionId);
    } catch {
      rules = null;
    }
    if (!rules) continue;
    ran++;
    let verified: boolean;
    try {
      verified = verifyAgainstExample(rules, analysis).verified;
    } catch {
      continue; // (saved rules this engine cannot run: no answer either way)
    }
    if (verified) return { match: pair, differs, ran };
    differs.push(pair);
  }
  return { match: null, differs, ran };
}
