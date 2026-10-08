// What the user already has, checked before a learn (owner decisions 2026-10-07, SPEC 5 A step 2). A format is the OUTPUT; each kind of input
// file that makes it has its own rules (kept as a "source" behind the scenes). When the user has saved formats, code looks - before anything
// is learned - for a saved format with this example's output, and then asks whether this example's input is one it already takes:
//
//   - the input IS one of the format's inputs, and its saved rules make this example exactly: "You already have this format" - nothing is
//     learned, no AI format is spent, no second format is made (`match`);
//   - the input is one of its inputs, but the saved rules make other values (the logic changed): the learn goes on, and Save offers to update
//     the format (`differs`);
//   - the input is NOT one of its inputs: the learn stops before any learning to ask ONE question - "Is this file another input for it?"
//     (`sameOutput`); yes is a learn against that format (attach mode), no is a new format.
//
// Run in the browser's worker on the pair analysis the learn has already made (nothing is read again); the user's saved formats and rules come
// from the API through the main thread (structure and rules only - the example never leaves the browser).
//   1. The OUTPUT structure (`ExampleShape`, from the analysis) is a saved format's: the output headers in order (spaces around and inside a
//      header do not count), the file kind and a header row, the title rows (how many, which are blank - never their text), how many summary
//      rows, and the grouping column - the parts of `sameOutputStructure` an example shows before its rules exist. An output with no header row
//      never matches. This is the cheap part, and the only one that runs when nothing matches.
//   2. The INPUT is one of that format's inputs: the same file-to-source matching and threshold as flow C (`pickExampleSource`: one clear winner
//      over ALL the user's sources, no required column missing), and that source feeds the format.
//   3. Only for those pairs is anything run: that conversion's SAVED rules on the example input, judged by the learn's own full verification
//      (`verifyAgainstExample`: every data row and cell, the row count, the row ORDER, the title / header / blank / summary rows and the file
//      settings).
// Several formats: each in turn, most recently used first.
import { normalizeOutputHeader, outputStructureOf, type Format, type LearnResult, type Rules } from '@formatai/shared';
import { pickExampleSource, type SavedFormatCandidate } from '../registry/matchFormats';
import type { ConversionSignatureInput } from '../registry/matchConversions';
import type { PairAnalysis } from './analyze';
import { verifyAgainstExample } from './verify';

/** What the example looks like, for finding the saved formats worth a look: its structure only (no value). */
export interface ExampleShape {
  /** The example output's headers, in order (as the file has them). */
  outputHeaders: string[];
  fileType: 'xlsx' | 'csv' | 'txt';
  /** The output has a header row (one without never matches: its headers are names code made up). */
  headerRow: boolean;
  /** One entry per title row above the header: blank, or a line (whatever its text). */
  titleRows: ('blank' | 'line')[];
  /** How many summary rows the output ends with. */
  summaryRows: number;
  /** The output column the rows are grouped by (its header), or null. */
  groupBy: string | null;
  /** The example input's headers (what its input kind is matched on). */
  inputHeaders: string[];
}

/** The user's saved formats whose output has the example's headers and file kind, with their conversions, and every source's signature. */
export interface KnownCandidates {
  formats: readonly SavedFormatCandidate[];
  sources: readonly ConversionSignatureInput[];
}

/**
 * Where the user's saved formats come from (the browser: the API, through the main thread). `candidates` is asked once, with the example's
 * shape; `rules` only for a pair whose structure and input both match, one at a time. Either may answer nothing (null / empty): no match.
 */
export interface KnownFormats {
  candidates(example: ExampleShape): Promise<KnownCandidates>;
  rules(conversionId: string): Promise<Rules | LearnResult | null>;
}

/** One saved format / input pair (names and ids only). */
export interface KnownPair {
  formatId: string;
  formatName: string;
  conversionId: string;
  /** The source's name (kept for the record; the screens name the format only). */
  sourceName: string;
}

/** A saved format with this example's output that does not take this example's input yet. */
export interface OutputMatch {
  formatId: string;
  formatName: string;
  /** How many inputs (conversions) it has now - for the plan's limit. */
  sources: number;
  /** When it was last used (most recent first). */
  usedAt: string;
  /** Its output side: the target of a learn for it (attach mode). */
  format: Format;
}

export interface AlreadyLearnedCheck {
  /** The first pair whose saved rules make the example exactly; null when none does (or none was worth running). */
  match: KnownPair | null;
  /** Pairs whose structure and input matched but whose saved rules make something else (the logic changed), in the order tried. */
  differs: KnownPair[];
  /** Formats with this output that this input is not one of the inputs of (most recently used first). */
  sameOutput: OutputMatch[];
  /** The input is one of the inputs of a saved format with this output (then nothing is asked: the learn goes on, or nothing is learned). */
  inputKnown: boolean;
  /** How many saved rules were run on the example (0 when no structure and input matched). */
  ran: number;
}

const NONE: AlreadyLearnedCheck = { match: null, differs: [], sameOutput: [], inputKnown: false, ran: 0 };

/** The example's shape, from the pair analysis. */
export function exampleShapeOf(analysis: PairAnalysis): ExampleShape {
  const group = analysis.layout.groupBy;
  return {
    outputHeaders: [...analysis.output.headers],
    fileType: analysis.layout.file.type,
    headerRow: !analysis.output.headerless,
    titleRows: analysis.layout.titleRows.map((t) => (t.blank ? 'blank' : 'line')),
    summaryRows: analysis.layout.summaryRows.length,
    groupBy: group ? (analysis.output.headers[group.out] ?? null) : null,
    inputHeaders: [...analysis.input.headers],
  };
}

/** The saved format's output has the example's structure (see the file header, step 1). */
export function sameShape(example: ExampleShape, candidate: SavedFormatCandidate): boolean {
  if (!example.headerRow || example.outputHeaders.length === 0) return false;
  const saved = outputStructureOf(candidate.format);
  if (!saved || saved.fileType !== example.fileType || saved.headers.length !== example.outputHeaders.length) return false;
  if (!saved.headers.every((h, i) => h === normalizeOutputHeader(example.outputHeaders[i] ?? ''))) return false;
  if (saved.titleRows.length !== example.titleRows.length || saved.titleRows.some((t, i) => t !== example.titleRows[i])) return false;
  if (saved.summaryRows.length !== example.summaryRows) return false;
  return (saved.group?.by ?? null) === (example.groupBy === null ? null : normalizeOutputHeader(example.groupBy));
}

const recentFirst = (a: SavedFormatCandidate, b: SavedFormatCandidate): number => (a.usedAt > b.usedAt ? -1 : a.usedAt < b.usedAt ? 1 : a.name.localeCompare(b.name));

/** The saved formats with this output, split: the pairs whose input is this one (worth running), and the formats that don't take it yet. */
export function knownMatches(example: ExampleShape, known: KnownCandidates): { pairs: KnownPair[]; sameOutput: OutputMatch[] } {
  const same = known.formats.filter((f) => sameShape(example, f)).sort(recentFirst);
  if (same.length === 0) return { pairs: [], sameOutput: [] };
  const sourceId = pickExampleSource(example.inputHeaders, known.sources);
  const pairs: KnownPair[] = [];
  const sameOutput: OutputMatch[] = [];
  for (const f of same) {
    const c = sourceId === null ? undefined : f.conversions.find((x) => x.sourceId === sourceId);
    if (c) pairs.push({ formatId: f.id, formatName: f.name, conversionId: c.id, sourceName: c.sourceName });
    else sameOutput.push({ formatId: f.id, formatName: f.name, sources: f.conversions.length, usedAt: f.usedAt, format: f.format });
  }
  return { pairs, sameOutput };
}

/** The format / input pairs worth running, most recently used first. */
export function knownPairs(example: ExampleShape, known: KnownCandidates): KnownPair[] {
  return knownMatches(example, known).pairs;
}

/** Runs the check (see the file header). Any failure to read is no match: the learn goes on as if the user had no saved format. */
export async function findAlreadyLearned(analysis: PairAnalysis, known: KnownFormats): Promise<AlreadyLearnedCheck> {
  const example = exampleShapeOf(analysis);
  if (!example.headerRow) return NONE;
  let found: { pairs: KnownPair[]; sameOutput: OutputMatch[] };
  try {
    found = knownMatches(example, await known.candidates(example));
  } catch {
    return NONE;
  }
  const differs: KnownPair[] = [];
  let ran = 0;
  for (const pair of found.pairs) {
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
    if (verified) return { match: pair, differs, sameOutput: found.sameOutput, inputKnown: true, ran };
    differs.push(pair);
  }
  return { match: null, differs, sameOutput: found.sameOutput, inputKnown: found.pairs.length > 0, ran };
}
