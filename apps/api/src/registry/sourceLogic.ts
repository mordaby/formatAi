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

const cloneColumn = (c: SourceColumn): SourceColumn => ({ ...c, aliases: [...c.aliases], ...(c.inputFormats ? { inputFormats: [...c.inputFormats] } : {}) });

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
 * the type, `padLeft` and `inputFormats` of a column both have, the sheet pick, the header row, `stopAt` and the input
 * checks. Otherwise the conversion doesn't fit this source (`ok: false`, with what differs).
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
    for (const d of columnDifferences(c, s, { ignoreAliases: true })) {
      problems.push({ kind: 'sourceMismatch', path: `input.columns[${i}].${d.field}`, message: d.message });
    }
    const aliases = unionAliases(s.header, s.aliases, c.aliases);
    if (aliases.length !== s.aliases.length) {
      s.aliases = aliases;
      changed = true;
    }
    if (c.required) s.required = true;
  });

  // The input checks are compared with each column named as the SOURCE names it (a conversion may spell a header differently).
  const inSourceTerms: Validation[] = own.inputValidations.map((v) => {
    const at = findSourceColumn(source.inputSignature.columns, v.column);
    return at < 0 ? v : ({ ...v, column: source.inputSignature.columns[at]!.header } as Validation);
  });
  problems.push(...readingDifferences({ ...own, inputValidations: inSourceTerms }, source));

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    changed,
    structure: {
      inputSignature: { columns },
      inputReading: JSON.parse(JSON.stringify(source.inputReading)) as SourceStructure['inputReading'],
      inputValidations: JSON.parse(JSON.stringify(source.inputValidations)) as Validation[],
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
 * The source after a conversion's editor save changed the input side (the analogue of "an edit of the output side is an edit of
 * the format", SPEC 8.12): every column the conversion declares is written to the source (a column the source lacks is added,
 * a renamed one - found through the conversion's OLD rules by id - is renamed, type / padLeft / inputFormats follow the edit,
 * aliases are unioned), and the reading options and input checks are the conversion's.
 *
 * DECISION: aliases only ever grow from an editor save (a union). Removing one needs an explicit source edit
 * (PATCH /api/sources/:id): otherwise saving one conversion could quietly drop a name another format's files rely on.
 */
export function mergeFromEdit(source: SourceStructure, after: LearnResult | Rules, before: LearnResult | Rules | null): EditMerge {
  const own = sourceOf(after);
  const oldHeaderOfId = new Map((before?.input.columns ?? []).map((c) => [c.id, c.header] as const));
  const columns = source.inputSignature.columns.map(cloneColumn);
  const renames = new Map<string, string>();

  after.input.columns.forEach((c, i) => {
    const mine = own.inputSignature.columns[i]!;
    let at = findSourceColumn(columns, oldHeaderOfId.get(c.id) ?? mine.header);
    if (at < 0) at = findSourceColumn(columns, mine.header);
    if (at < 0) {
      columns.push(cloneColumn(mine));
      return;
    }
    const s = columns[at]!;
    // DECISION: a header that differs from the source's only as the engine ignores (case, spacing, quote marks) is the same column
    // spelled another way, not a rename: the source's spelling stays, and the conversion is brought to it (a source is built from
    // conversions that may spell a header differently, and one of them being saved must not re-spell it for the rest).
    const header = sourceHeaderKey(s.header) === sourceHeaderKey(mine.header) ? s.header : mine.header;
    if (s.header !== header) renames.set(s.header, header);
    const next: SourceColumn = {
      header,
      aliases: unionAliases(header, s.aliases, mine.aliases),
      type: mine.type,
      required: s.required || mine.required,
    };
    if (mine.padLeft !== undefined) next.padLeft = mine.padLeft;
    if (mine.inputFormats !== undefined) next.inputFormats = [...mine.inputFormats];
    columns[at] = next;
  });

  return {
    renames,
    structure: { inputSignature: { columns }, inputReading: own.inputReading, inputValidations: own.inputValidations },
  };
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
 *  - each column the conversion declares takes its header, aliases, type, `padLeft` and `inputFormats` from the source column
 *    it stands for (found through `renames`, then the way the engine finds a header). It keeps its id, its `required` and its place;
 *    a column the source no longer has is dropped (what still refers to it then fails `checkRules`: `needsReview`);
 *  - sheet, header row and `stopAt` are the source's; the conversion's input validations are the source's, with each header turned
 *    back into this conversion's own id. Its output validations, transform, output and row filters are not touched.
 * Never touches what the rules DO with the columns.
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
  const inputValidations = source.inputValidations.map((v) => ({ ...v, column: idOfHeader.get(v.column) ?? v.column }) as Validation);
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
