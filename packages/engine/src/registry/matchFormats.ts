// A learned example that matches a saved format (owner decision 2026-10-07, SPEC 5 A step 8, 8.12): before "Save format" creates a NEW format,
// the browser asks whether the example is one the user already has. Pure: the browser's worker runs it on the rules on screen, the example
// input's HEADERS and what the API says about the user's formats and sources (structure only - never a value, never a file).
//
//   1. "Same format" is decided by the OUTPUT only (`sameOutputStructure` on `formatOf` of the rules): the input's names never count.
//   2. For each such format: does the example INPUT match one of its sources? The same file-to-source matching and threshold as flow C and
//      the server's source reuse (SPEC 8.15 "Saving", `pickReusableSource`): `matchConversions` over ALL the user's sources, one clear winner
//      (`pickConversion` auto) with no required column missing. When that source feeds the format, saving is an UPDATE of that conversion (a new
//      version of its rules); otherwise the file is a new source of the format (ATTACH) - the source the server will then reuse or create.
//   3. The format lock (`checkFormatLock`) of the rules against the format: an attach whose rules break it is not offered (the server would
//      refuse it); for an update it says the save changes the format (for all its sources).
// The matches come most recently used first.
import { sameOutputStructure, withUnwrittenOutputOf, type Format, type LearnResult, type Rules } from '@formatai/shared';
import { checkFormatLock, type FormatProblem } from './checkFormatLock';
import { formatOf } from './formatOf';
import { matchConversions, pickConversion, type ConversionSignatureInput } from './matchConversions';

export interface SavedFormatConversion {
  id: string;
  sourceId: string;
  sourceName: string;
  version: number;
}

export interface SavedFormatCandidate {
  id: string;
  name: string;
  format: Format;
  /** When it was last used (an ISO date: its last run, else its last change): the most recent comes first. */
  usedAt: string;
  conversions: SavedFormatConversion[];
}

export interface FormatMatch {
  formatId: string;
  formatName: string;
  /** How many sources (conversions) the format has. */
  sources: number;
  /** The example input is this conversion's source: saving updates it. Absent: the file would be a new source of the format. */
  same?: SavedFormatConversion;
  /** The rules against the format (SPEC 8.12). Empty: they can be attached (or an update leaves the format as it is). */
  lock: FormatProblem[];
}

export interface FindFormatMatchesArgs {
  rules: LearnResult | Rules;
  /** The example input's headers (structure only); the rules' declared input headers when they are not known. */
  inputHeaders?: readonly string[] | undefined;
  candidates: readonly SavedFormatCandidate[];
  /** Every saved SOURCE's signature (its id is the source's). */
  sources: readonly ConversionSignatureInput[];
}

/** The source the example input clearly is, if one is (see the file header, step 2). */
export function pickExampleSource(headers: readonly string[], sources: readonly ConversionSignatureInput[]): string | null {
  if (headers.length === 0 || sources.length === 0) return null;
  const pick = pickConversion(matchConversions(headers, sources));
  return pick.kind === 'auto' && pick.match.missingRequired.length === 0 ? pick.match.id : null;
}

export function findFormatMatches(args: FindFormatMatchesArgs): FormatMatch[] {
  const learned = formatOf(args.rules);
  const same = args.candidates.filter((c) => sameOutputStructure(learned, c.format));
  if (same.length === 0) return [];
  const headers = args.inputHeaders && args.inputHeaders.length > 0 ? args.inputHeaders : args.rules.input.columns.map((c) => c.header);
  const sourceId = pickExampleSource(headers, args.sources);
  return [...same]
    .sort((a, b) => (a.usedAt > b.usedAt ? -1 : a.usedAt < b.usedAt ? 1 : a.name.localeCompare(b.name)))
    .map((c) => {
      const conversion = sourceId === null ? undefined : c.conversions.find((x) => x.sourceId === sourceId);
      return {
        formatId: c.id,
        formatName: c.name,
        sources: c.conversions.length,
        ...(conversion ? { same: conversion } : {}),
        // (a csv's or txt's sheet name, widths, header style and direction are not in the file: the format's are taken first)
        lock: checkFormatLock(withUnwrittenOutputOf(args.rules, c.format), c.format),
      };
    });
}
