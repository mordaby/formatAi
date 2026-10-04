// The pure half of sources (SPEC 8.15): merging a conversion's input side into a source, writing a source's structure into a
// conversion's `input`, and choosing the source a saved conversion belongs to. No database, no request - unit-tested on their
// own, like `propagate.ts` is for formats.
//
// A source holds STRUCTURE only (headers, aliases, types, shapes, reading options, input checks); nothing here reads or keeps a
// value. The engine never sees any of this: every conversion's rules file stays self-contained, and these functions only
// rewrite that file's `input` section (and its input validations) the way `applyFormat` rewrites its `output` section.
import {
  checkSourceLock,
  columnDifferences,
  compareInputChecks,
  findSourceColumn,
  matchConversions,
  pickConversion,
  readingDifferences,
  sourceHeaderKey,
  sourceOf,
  typeCheck,
  deepEqual,
  type ConversionSignatureInput,
} from '@formatai/engine';
import {
  checkRules,
  type ApiProblem,
  type InputColumn,
  type LearnResult,
  type RepairProblem,
  type Rules,
  type SourceColumn,
  type SourceLockProblem,
  type SourceStructure,
  type Validation,
} from '@formatai/shared';
import type { SourceDoc } from '../models.js';

const cloneColumn = (c: SourceColumn): SourceColumn => ({
  ...c,
  aliases: [...c.aliases],
  ...(c.inputFormats ? { inputFormats: [...c.inputFormats] } : {}),
  ...(c.readAs ? { readAs: { ...c.readAs } } : {}),
});

/** The structural part of a stored source, detached from the document. */
export function structureOfDoc(doc: Pick<SourceDoc, 'inputSignature' | 'inputReading' | 'inputValidations'>): SourceStructure {
  return JSON.parse(
    JSON.stringify({ inputSignature: doc.inputSignature, inputReading: doc.inputReading, inputValidations: doc.inputValidations }),
  ) as SourceStructure;
}

/** Aliases of `into` plus the ones of `add` it doesn't have (order kept; an alias equal to the header is not one). */
function unionAliases(header: string, into: readonly string[], add: readonly string[]): string[] {
  const out = [...into];
  for (const a of add) if (a !== header && !out.includes(a)) out.push(a);
  return out;
}

// ---------------------------------------------------------------------------
// Saving a conversion into an EXISTING source (SPEC 8.15 "Saving": reuse)
// ---------------------------------------------------------------------------

export type ReuseMerge =
  | {
      ok: true;
      /** The source after the conversion's columns and aliases are merged in. */
      structure: SourceStructure;
      /** The merge added a column or an alias (so the source needs a new version). */
      changed: boolean;
    }
  | { ok: false; problems: SourceLockProblem[] };

/**
 * Merges a NEW conversion's input side into an existing source (SPEC 8.15 "Saving"): columns the source doesn't have are
 * added, aliases are unioned (`required` accumulates). Everything else must already agree, because it is the way the
 * file is read and a conversion that read it differently would break the source lock for its siblings:
 * the type, `padLeft` and `inputFormats` of a column both have, the sheet pick, the header row, `stopAt` and the `block`
 * input checks on the columns both have. Otherwise the conversion doesn't fit this source (`ok: false`, with what differs).
 * Input checks are the source's per column (SPEC 8.15 "The source lock", `compareInputChecks`): a check on a column only the
 * conversion reads, and a `flag` check the source lacks on a column both read, are added to the source; a check on a column
 * the conversion doesn't declare is none of its business.
 *
 * DECISION: nothing that differs is "fixed" by taking the source's value over the conversion's: the conversion was
 * verified against its own example with its own types, so silently changing them could change its output.
 */
export function mergeForReuse(source: SourceStructure, rules: LearnResult | Rules): ReuseMerge {
  const own = sourceOf(rules);
  const columns = source.inputSignature.columns.map(cloneColumn);
  const problems: SourceLockProblem[] = [];
  let changed = false;

  own.inputSignature.columns.forEach((c, i) => {
    const at = findSourceColumn(columns, c.header);
    if (at < 0) {
      columns.push(cloneColumn(c));
      changed = true;
      return;
    }
    const s = columns[at]!;
    // `readAs` (SPEC 8.4a) is unioned below, like aliases, not a mismatch: a conversion learned from an example has none of what the source's
    // other formats were told on the Run screen, and it comes to read the column as they do (`applySource`).
    for (const d of columnDifferences(c, s, { ignoreAliases: true })) {
      if (d.field === 'readAs') continue;
      problems.push({ kind: 'sourceMismatch', path: `input.columns[${i}].${d.field}`, message: d.message });
    }
    const aliases = unionAliases(s.header, s.aliases, c.aliases);
    if (aliases.length !== s.aliases.length) {
      s.aliases = aliases;
      changed = true;
    }
    if (c.readAs !== undefined) {
      const merged = { ...s.readAs };
      for (const [from, to] of Object.entries(c.readAs)) {
        if (merged[from] !== undefined && merged[from] !== to) {
          problems.push({ kind: 'sourceMismatch', path: `input.columns[${i}].readAs`, message: `column "${c.header}": "${from}" is read as ${JSON.stringify(to)}, and the source reads it as ${JSON.stringify(merged[from])}` });
        } else if (merged[from] === undefined) {
          merged[from] = to;
          changed = true;
        }
      }
      s.readAs = merged;
    }
    if (c.required) s.required = true;
  });

  // The input checks are compared with each column named as the SOURCE names it (a conversion may spell a header differently); a
  // check on something that is not one of the conversion's columns (a computed one) keeps its id as written.
  const sourceHeaderOf = new Map(own.inputSignature.columns.map((c) => {
    const at = findSourceColumn(source.inputSignature.columns, c.header);
    return [c.header, at < 0 ? c.header : source.inputSignature.columns[at]!.header] as const;
  }));
  const inSourceTerms: SourceStructure = {
    ...own,
    inputSignature: { columns: own.inputSignature.columns.map((c) => ({ ...c, header: sourceHeaderOf.get(c.header)! })) },
    inputValidations: own.inputValidations.map((v) => ({ ...v, column: sourceHeaderOf.get(v.column) ?? v.column }) as Validation),
  };
  problems.push(...readingDifferences(inSourceTerms, source));
  const { additions } = compareInputChecks(inSourceTerms, source);
  if (additions.length > 0) changed = true;

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    changed,
    structure: {
      inputSignature: { columns },
      inputReading: JSON.parse(JSON.stringify(source.inputReading)) as SourceStructure['inputReading'],
      inputValidations: JSON.parse(JSON.stringify([...source.inputValidations, ...additions])) as Validation[],
    },
  };
}

// ---------------------------------------------------------------------------
// An edit made from a conversion's rules map (SPEC 8.15 "Editing a source")
// ---------------------------------------------------------------------------

export interface EditMerge {
  structure: SourceStructure;
  /** Header a source column had -> the header it has now (a rename the edit made), for the other conversions to follow. */
  renames: Map<string, string>;
}

/**
 * Whether an editor save changed the conversion's own input checks (as a set, by header). The source lock lets a `flag` check differ
 * from the source's, so an edit that only adds, drops or changes one would pass it and never reach the source: this says it is still an
 * edit of the source's checks (the editor says "this changes the source" for it), so the source takes it and the conversions that read
 * the column follow.
 */
export function inputChecksEdited(after: LearnResult | Rules, before: LearnResult | Rules | null): boolean {
  const key = (v: Validation): string => JSON.stringify(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)));
  const keys = (r: LearnResult | Rules | null): string => (r ? sourceOf(r).inputValidations.map(key).sort().join('\n') : '');
  return keys(after) !== keys(before);
}

/**
 * The source after a conversion's editor save changed the input side (the analogue of "an edit of the output side is an edit of
 * the format", SPEC 8.12): every column the conversion declares is written to the source (a column the source lacks is added,
 * a renamed one - found through the conversion's OLD rules by id - is renamed, type / padLeft / inputFormats follow the edit,
 * aliases are unioned), and the reading options are the conversion's. The input checks are the conversion's on the columns it
 * declares (they replace the source's there) and the source's own on every other column (SPEC 8.15: input checks are the source's
 * per column, a conversion is held only to those on its columns).
 *
 * DECISION: the replacement is of the whole of the conversion's columns, so a `flag` check that a sibling brought to a column this
 * conversion also reads, and this one lacks, goes when this edit is saved - it is an edit of the source, which every conversion of it
 * follows (the editor says so first when the source feeds several formats), and flags only mark rows, so no output changes. A check on
 * no column of the source (a computed column's) is replaced as a whole, as the lock compares it.
 *
 * DECISION: aliases only ever grow from an editor save (a union). Removing one needs an explicit source edit
 * (PATCH /api/sources/:id): otherwise saving one conversion could quietly drop a name another format's files rely on.
 */
export function mergeFromEdit(source: SourceStructure, after: LearnResult | Rules, before: LearnResult | Rules | null): EditMerge {
  const own = sourceOf(after);
  const oldHeaderOfId = new Map((before?.input.columns ?? []).map((c) => [c.id, c.header] as const));
  const columns = source.inputSignature.columns.map(cloneColumn);
  const renames = new Map<string, string>();
  /** Header the conversion has (its own spelling) -> the header the source has for that column after this edit. */
  const finalHeader = new Map<string, string>();
  /** Every header the source had for a column this conversion declares (before the edit): their checks are the ones replaced. */
  const declared = new Set<string>();

  after.input.columns.forEach((c, i) => {
    const mine = own.inputSignature.columns[i]!;
    let at = findSourceColumn(columns, oldHeaderOfId.get(c.id) ?? mine.header);
    if (at < 0) at = findSourceColumn(columns, mine.header);
    if (at < 0) {
      columns.push(cloneColumn(mine));
      finalHeader.set(mine.header, mine.header);
      return;
    }
    const s = columns[at]!;
    declared.add(s.header);
    // DECISION: a header that differs from the source's only as the engine ignores (case, spacing, quote marks) is the same column
    // spelled another way, not a rename: the source's spelling stays, and the conversion is brought to it (a source is built from
    // conversions that may spell a header differently, and one of them being saved must not re-spell it for the rest).
    const header = sourceHeaderKey(s.header) === sourceHeaderKey(mine.header) ? s.header : mine.header;
    if (s.header !== header) renames.set(s.header, header);
    finalHeader.set(mine.header, header);
    const next: SourceColumn = {
      header,
      aliases: unionAliases(header, s.aliases, mine.aliases),
      type: mine.type,
      required: s.required || mine.required,
    };
    if (mine.padLeft !== undefined) next.padLeft = mine.padLeft;
    if (mine.inputFormats !== undefined) next.inputFormats = [...mine.inputFormats];
    // `readAs` (SPEC 8.4a) follows the edit like the other shapes: what the editing conversion has IS the source's afterwards, so a version
    // restored without a mapping takes it away from the source and from the formats that follow it. (An editor that has not seen a mapping
    // saved since is refused by the version check, `baseVersion`: the source change rewrote every conversion of the source.)
    if (mine.readAs !== undefined) next.readAs = { ...mine.readAs };
    columns[at] = next;
  });

  // The checks of the source on columns this conversion doesn't declare stay; the conversion's own, named as the source now names
  // the columns, take the place of the rest.
  const sourceHeaders = new Set(source.inputSignature.columns.map((c) => c.header));
  const kept = source.inputValidations.filter((v) => sourceHeaders.has(v.column) && !declared.has(v.column));
  const mine = own.inputValidations.map((v) => ({ ...v, column: finalHeader.get(v.column) ?? v.column }) as Validation);

  return {
    renames,
    structure: { inputSignature: { columns }, inputReading: own.inputReading, inputValidations: [...kept, ...mine] },
  };
}

/**
 * The source with the `readAs` (SPEC 8.4a) of every column `rules` declares replaced by the rules' own - set, changed or taken away -
 * and nothing else touched. A restored version (SPEC 8.11) is brought back by this: "Do this every time?" saves a mapping as a new
 * version, and restoring the one before it is how it is undone, for the source and every format that reads it.
 */
export function withReadAsOf(source: SourceStructure, rules: LearnResult | Rules): SourceStructure {
  const columns = source.inputSignature.columns.map(cloneColumn);
  for (const c of sourceOf(rules).inputSignature.columns) {
    const at = findSourceColumn(columns, c.header);
    if (at < 0) continue;
    const next = columns[at]!;
    if (c.readAs !== undefined) next.readAs = { ...c.readAs };
    else delete next.readAs;
  }
  return { ...source, inputSignature: { columns } };
}

// ---------------------------------------------------------------------------
// Writing a source into a conversion
// ---------------------------------------------------------------------------

export interface SourceApplied {
  /** The conversion's rules with `input` (and its input validations) rebuilt from the source. */
  rules: Rules;
  /** The rewrite changed something. */
  changed: boolean;
  /** The rebuilt rules do not resolve (references, types, source lock). */
  needsReview: boolean;
  problems: ApiProblem[];
}

/**
 * Rebuilds `target`'s input side from `source` (SPEC 8.15 "Editing a source": "headers, aliases, types, reading options and
 * input validations are written into every conversion's `input`"):
 *  - each column the conversion declares takes its header, aliases, type, `padLeft`, `inputFormats` and `readAs` from the source column
 *    it stands for (found through `renames`, then the way the engine finds a header). It keeps its id, its `required` and its place;
 *    a column the source no longer has is dropped (what still refers to it then fails `checkRules`: `needsReview`);
 *  - sheet, header row and `stopAt` are the source's; the conversion's input validations are the source's on the columns IT
 *    declares, with each header turned back into this conversion's own id (SPEC 8.15: input checks are the source's per column). Its
 *    output validations, transform, output and row filters are not touched.
 * Never touches what the rules DO with the columns.
 *
 * DECISION: a check of the source on a column the conversion doesn't declare is never written into it: the rules would refer to a
 * column they don't have. A check on no column of the source at all (a computed column's, kept by id, see `sourceOf`) is written as
 * before. After a merge (`mergeForReuse`) the source may hold a `flag` check that another conversion brought, on a column this one
 * also reads: it comes along, and that never changes the conversion's output (flags only mark rows).
 */
export function applySource(target: Rules, source: SourceStructure, renames: ReadonlyMap<string, string> = new Map()): SourceApplied {
  const known = source.inputSignature.columns;
  const columns: InputColumn[] = [];
  for (const c of target.input.columns) {
    const at = findSourceColumn(known, renames.get(c.header) ?? c.header);
    if (at < 0) continue;
    const s = known[at]!;
    const col: InputColumn = { id: c.id, header: s.header, type: s.type };
    if (s.aliases.length > 0) col.aliases = [...s.aliases];
    if (c.required !== undefined) col.required = c.required;
    if (s.padLeft !== undefined) col.padLeft = s.padLeft;
    if (s.inputFormats !== undefined && s.inputFormats.length > 0) col.inputFormats = [...s.inputFormats];
    if (s.readAs !== undefined && Object.keys(s.readAs).length > 0) col.readAs = { ...s.readAs };
    columns.push(col);
  }

  const input: Rules['input'] = {
    ...target.input,
    sheet: { ...source.inputReading.sheet },
    headerRow: source.inputReading.headerRow,
    columns,
  };
  if (source.inputReading.stopAt) input.stopAt = { when: source.inputReading.stopAt.when, values: [...source.inputReading.stopAt.values] };
  else delete input.stopAt;

  const idOfHeader = new Map(columns.map((c) => [c.header, c.id] as const));
  const sourceHeaders = new Set(known.map((c) => c.header));
  const inputValidations = source.inputValidations
    .filter((v) => idOfHeader.has(v.column) || !sourceHeaders.has(v.column))
    .map((v) => ({ ...v, column: idOfHeader.get(v.column) ?? v.column }) as Validation);
  const validations = [...inputValidations, ...target.validations.filter((v) => (v.on ?? 'input') === 'output')];

  const rules: Rules = { ...target, input, validations };
  const problems: ApiProblem[] = [];
  for (const p of checkRules(rules)) problems.push({ kind: 'reference', message: p.path ? `${p.path}: ${p.message}` : p.message } satisfies RepairProblem);
  for (const p of typeCheck(rules)) problems.push({ kind: 'type', path: p.path, message: p.message } satisfies RepairProblem);
  for (const p of checkSourceLock(rules, source)) problems.push(p);

  return { rules, changed: !deepEqual(target, rules), needsReview: problems.length > 0, problems };
}

/**
 * The rules with each declared column's aliases brought to the source's (nothing else is touched): `replace` makes them the source's,
 * `union` only adds what the source has. `replace` brings an OLDER version of a conversion back (SPEC 8.11 restore): aliases are what
 * the source has learned about how files name a column, not part of how the rules behave, so an old version must not be refused
 * for lacking one added since (or for keeping one since removed). `union` is for a source that only gained an alias.
 */
export function withSourceAliases(rules: Rules, source: SourceStructure, mode: 'replace' | 'union' = 'replace'): Rules {
  const known = source.inputSignature.columns;
  return {
    ...rules,
    input: {
      ...rules.input,
      columns: rules.input.columns.map((c) => {
        const at = findSourceColumn(known, c.header);
        if (at < 0 || known[at]!.header !== c.header) return c;
        const { aliases: own, ...rest } = c;
        const aliases = mode === 'replace' ? [...known[at]!.aliases] : unionAliases(c.header, own ?? [], known[at]!.aliases);
        return aliases.length > 0 ? { ...rest, aliases } : rest;
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Which source does a saved conversion belong to?
// ---------------------------------------------------------------------------

/**
 * The source the example input matches, if exactly one clearly does (SPEC 8.15 "Saving": "the same matching and threshold as flow
 * C"): the engine's own `matchConversions` / `pickConversion` over the sources' signatures. Stricter than flow C in one way,
 * on purpose: a source with a required column the file lacks is never reused (wrongly merging two sources is worse than keeping
 * two near-identical ones, which the user can see and tidy). `headers` are the headers of the example input (structure only).
 */
export function pickReusableSource(sources: readonly SourceDoc[], headers: readonly string[]): SourceDoc | null {
  if (sources.length === 0 || headers.length === 0) return null;
  const inputs: ConversionSignatureInput[] = sources.map((s) => ({
    id: s._id!.toHexString(),
    name: s.name,
    columns: s.inputSignature.columns.map((c) => ({ header: c.header, aliases: c.aliases, type: c.type, required: c.required })),
  }));
  const pick = pickConversion(matchConversions(headers, inputs));
  if (pick.kind !== 'auto' || pick.match.missingRequired.length > 0) return null;
  return sources.find((s) => s._id!.toHexString() === pick.match.id) ?? null;
}

/**
 * The source's `required` flags, derived (SPEC 8.15 DECISION): a column is required when at least one of the source's conversions
 * marks it required. A column no conversion declares keeps what it had. `usage` = each conversion's `inputSignature`.
 */
export function withDerivedRequired(
  structure: SourceStructure,
  usage: readonly { columns: readonly { header: string; required: boolean }[] }[],
): SourceStructure {
  return {
    ...structure,
    inputSignature: {
      columns: structure.inputSignature.columns.map((c) => {
        const key = sourceHeaderKey(c.header);
        const users = usage.flatMap((u) => u.columns.filter((x) => sourceHeaderKey(x.header) === key));
        return users.length === 0 ? c : { ...c, required: users.some((u) => u.required) };
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Headers a source needs no "new column" notice for (SPEC 8.15)
// ---------------------------------------------------------------------------

/**
 * The headers of `add` a source does not ignore yet, in order: trimmed, never empty, one per normalized header (`sourceHeaderKey`,
 * the way the engine compares a file's headers), and not one `existing` already holds. Names only.
 */
export function newIgnoredHeaders(existing: readonly string[], add: readonly string[]): string[] {
  const seen = new Set(existing.map(sourceHeaderKey));
  const out: string[] = [];
  for (const raw of add) {
    const header = raw.trim();
    const key = sourceHeaderKey(header);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(header);
  }
  return out;
}

/**
 * The headers of the EXAMPLE input that this kind of file already has no use for (SPEC 8.15 "Saving"): the ones no column of the
 * source's signature (header or alias, found the way the engine reads a file) stands for. Remembered when a source is saved, so the
 * columns the example always had are not announced as new on the first real file.
 */
export function unusedExampleHeaders(source: Pick<SourceStructure['inputSignature'], 'columns'>, exampleHeaders: readonly string[]): string[] {
  return exampleHeaders.filter((h) => h.trim() !== '' && findSourceColumn(source.columns, h) < 0);
}
