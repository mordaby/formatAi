// The engine methods the worker exposes (SPEC 2, 4 "where each step runs"). Everything
// here runs on real data, in the worker; the only thing that leaves is what the main
// thread sends over HTTP on the worker's behalf via `ctx.host` (the learn payload, which
// the engine itself builds - masked unless the user turned masking off).
import {
  ambiguousColumns,
  analyzePair,
  convertFile,
  dayMonthQuestions,
  detectTable,
  isExternalColumn,
  learnFromExamples,
  nonEmptySheets,
  readWorkbook,
  sentColumns,
  sniffDelimitedText,
  verifyAgainstExample,
  type LearnCallResult,
} from '@formatai/engine';
import { limits } from '@formatai/shared';
import type { AnalysisProgress, PairAnalysis } from '@formatai/engine';
import type { ConvertArgs, ConvertOutput, InspectArgs, InspectOutput, LearnArgs, LearnOutput, LearnProgress, VerifyArgs, VerifyOutput } from './engineApi';
import type { LiveCheckArgs, LiveCheckResult, LoadExampleArgs, LoadExampleOutput, StaticChecksArgs, StaticProblem } from './editorApi';
import { checkExample, exampleInputOf, getExample, rememberExample, runStaticChecks } from './liveCheck';
import { convertMethods } from './convertMethods';
import { Transfer, type MethodContext, type MethodMap } from './runtime';

/**
 * SPEC 7.2: "the key is random per browser session and never leaves the browser". It is
 * generated once, on first use, and lives only in this module's memory - inside the
 * worker. It is never an argument, a result, or a message. (If the main thread has to
 * restart a hung worker, the new worker gets a new key; masked fake words of the old
 * session are simply never seen again, which is harmless.)
 */
let sessionKey: Uint8Array | undefined;
function maskingKey(): Uint8Array {
  return (sessionKey ??= crypto.getRandomValues(new Uint8Array(32)));
}

/** A detached-safe ArrayBuffer holding exactly `bytes` (a view is copied; a whole buffer is moved). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = bytes.buffer as ArrayBuffer;
  if (bytes.byteOffset === 0 && bytes.byteLength === buf.byteLength) return buf;
  return buf.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function learn(args: LearnArgs, ctx: MethodContext): Promise<LearnOutput> {
  const emit = (p: LearnProgress): void => ctx.progress(p);
  emit({ phase: 'reading' });
  let analysis: PairAnalysis | undefined;
  const maxCheckRounds = limits.learn.checks.maxRounds;
  /**
   * The first try's progress: SPEC 6.4, the columns code found no trace of in the input are said while the AI step works on them (in completion
   * mode the user has seen them on the map); with `checkRound`, the round of AI code checks it is in.
   */
  const firstTry = (checkRound?: number): LearnProgress => {
    const unexplained = analysis && !args.complete ? analysis.columns.filter(isExternalColumn).map((c) => c.header || `#${c.out + 1}`) : [];
    return {
      phase: 'learning',
      attempt: 'learn',
      ...(unexplained.length > 0 ? { unexplained } : {}),
      ...(checkRound !== undefined ? { checkRound: { n: checkRound, of: maxCheckRounds } } : {}),
    };
  };
  const result = await learnFromExamples({
    input: { bytes: new Uint8Array(args.input.bytes), name: args.input.name },
    output: { bytes: new Uint8Array(args.output.bytes), name: args.output.name },
    masking: args.masking,
    ...(args.masking ? { key: maskingKey() } : {}),
    tier: args.tier,
    ...(args.target ? { target: args.target } : {}),
    ...(args.tryAnyway ? { tryAnyway: true } : {}),
    ...(args.ai ? { ai: args.ai } : {}),
    ...(args.complete ? { complete: args.complete } : {}),
    onProgress: (p: AnalysisProgress) => emit({ phase: 'checking', stage: p.stage, fraction: p.fraction }),
    onAnalysis: (a) => {
      analysis = a;
    },
    callLearn: async (payload) => {
      emit(firstTry());
      // "See what we send": which columns masking hides (the main thread shows it beside the payload; it is never sent).
      const out = await ctx.host<LearnCallResult>('callLearn', payload, analysis ? sentColumns(analysis, args.masking) : undefined);
      // AI code checks: an answer with checks has no rules to verify yet - code answers them on every row now (round 1), then the step goes.
      emit(asksChecks(out) ? firstTry(1) : { phase: 'verifying' });
      return out;
    },
    callStep: async (payload, rounds) => {
      // AI code checks (learn-v9): the answers of round `rounds.length` go to the AI step with every round before it.
      const n = rounds.length;
      emit(firstTry(n));
      const out = await ctx.host<LearnCallResult>('callStep', payload, rounds);
      // More checks while rounds are left (the engine stops at the cap: past it the answer is no answer); otherwise the rules are verified.
      emit(asksChecks(out) && n < maxCheckRounds ? firstTry(n + 1) : { phase: 'verifying' });
      return out;
    },
    callRepair: async (payload, previousRules, problems, round) => {
      // The learning loop: which round, and how many rows the rules got wrong it sends (the rows themselves go to the main thread with it).
      emit({ phase: 'learning', attempt: 'repair', round: { n: round.round, of: round.maxRounds, rows: round.newRows, ...(round.list ? { list: true as const } : {}) } });
      const out = await ctx.host<LearnCallResult>('callRepair', payload, previousRules, problems, round);
      emit({ phase: 'verifying' });
      return out;
    },
  });
  // The rules editor's live check (SPEC 8.11) re-runs rules on this example; it stays in the worker.
  // Its input's columns come with it: the editor offers the ones no rule uses yet (headers only; the file stays here).
  if (!analysis || !result.rules) return result;
  // The columns the example fits more than one rule for are a question for the user, whatever path built the rules (the free engine's, or the AI step's):
  // a constant the input could write too, and - after an AI answer - a second rule the AI step gave that also fits every row (learn-v8, SPEC 21 v12
  // item 17; its check is already in the rules) and the day/month order of a text date that no value settles (SPEC 21 v12 item 16).
  // A column asks one question: the first one stands (the engine adds no alternative question on a column the free engine asks about).
  const alternatives = (result.alternatives ?? []).flatMap((a) => (a.question ? [a.question] : []));
  const ambiguous = [...ambiguousColumns(analysis), ...alternatives, ...dayMonthQuestions(result.rules, result.ambiguities ?? [])].filter((q, i, all) => all.findIndex((x) => x.header === q.header) === i);
  return {
    ...result,
    exampleId: rememberExample(analysis, args.keepExampleId),
    exampleInput: exampleInputOf(analysis),
    exampleOutputColumns: analysis.output.columnCount,
    ...(ambiguous.length > 0 ? { ambiguous } : {}),
  };
}

/** The AI step asked checks instead of answering (AI code checks, `LearnResponse.checks`): there are no rules yet. */
function asksChecks(out: LearnCallResult): boolean {
  return out.checks !== undefined && !out.rules;
}

async function convert(args: ConvertArgs): Promise<Transfer<ConvertOutput> | ConvertOutput> {
  const res = await convertFile(args.rules, new Uint8Array(args.file.bytes), args.file.name);
  if (!res.ok) return { ok: false, error: res.error };
  const bytes = toArrayBuffer(res.bytes);
  const out: ConvertOutput = {
    ok: true,
    bytes,
    flags: res.flags,
    summary: res.summary,
    preview: { ...res.sheet, rows: res.sheet.rows.slice(0, args.previewRows) },
    totalRows: res.sheet.rows.length,
  };
  return new Transfer(out, [bytes]);
}

async function verify(args: VerifyArgs): Promise<VerifyOutput> {
  const inputWb = await readWorkbook(new Uint8Array(args.input.bytes), args.input.name);
  const outputWb = await readWorkbook(new Uint8Array(args.output.bytes), args.output.name);
  const outputSniff =
    outputWb.fileType === 'csv' || outputWb.fileType === 'txt' ? sniffDelimitedText(new Uint8Array(args.output.bytes)) : undefined;
  const analysis = analyzePair(inputWb, outputWb, outputSniff ? { outputSniff } : {});
  if (!analysis.ok) return { ok: false, reason: 'analysisFailed' };
  return { ok: true, verification: verifyAgainstExample(args.rules, analysis, args.exceptions ? { exceptions: args.exceptions } : {}) };
}

/**
 * A cheap look at one dropped file: does it open, and how big is its table (first non-empty sheet).
 * Only counts: whether the file is acceptable is the pre-flight's decision when the user goes on.
 */
async function inspect(args: InspectArgs): Promise<InspectOutput> {
  let wb;
  try {
    wb = await readWorkbook(new Uint8Array(args.file.bytes), args.file.name);
  } catch {
    return { readable: false };
  }
  const sheet = wb.sheets[nonEmptySheets(wb)[0] ?? 0];
  if (!sheet) return { readable: true, rows: null, columns: null, direction: 'ltr' };
  const detection = detectTable(sheet, { mode: args.side });
  if (detection.headerRow < 0) return { readable: true, rows: null, columns: null, direction: detection.direction };
  const header = sheet.rows[detection.headerRow] ?? [];
  const columns = header.filter((c) => c && c.v !== null && !(typeof c.v === 'string' && c.v.trim() === '')).length;
  const rows = Math.max(0, detection.dataEnd - detection.dataStart + 1);
  return { readable: true, rows, columns, direction: detection.direction };
}

// ---------- the rules editor (SPEC 8.11) ----------

/** Reads the example pair again and keeps it, for the live check of a saved conversion (example files are never stored). */
async function loadExample(args: LoadExampleArgs): Promise<LoadExampleOutput> {
  const inputWb = await readWorkbook(new Uint8Array(args.input.bytes), args.input.name);
  const outputWb = await readWorkbook(new Uint8Array(args.output.bytes), args.output.name);
  const outputSniff =
    outputWb.fileType === 'csv' || outputWb.fileType === 'txt' ? sniffDelimitedText(new Uint8Array(args.output.bytes)) : undefined;
  const analysis = analyzePair(inputWb, outputWb, {
    ...(outputSniff ? { outputSniff } : {}),
    ...(args.target ? { outputFileSpec: args.target.output.file } : {}),
  });
  if (!analysis.ok) return { ok: false, reason: 'analysisFailed' };
  return {
    ok: true,
    exampleId: rememberExample(analysis),
    exampleInput: exampleInputOf(analysis),
    inputRows: analysis.input.rows.length,
    outputRows: analysis.output.dataRows.length,
  };
}

/** Runs the rules on the example in memory (a subset above 5,000 rows, unless `subset: false`). */
function liveCheck(args: LiveCheckArgs): LiveCheckResult {
  return checkExample(getExample(args.exampleId), args.rules, {
    ...(args.exceptions ? { exceptions: args.exceptions } : {}),
    ...(args.oneTime ? { oneTime: args.oneTime } : {}),
    ...(args.onlyColumns ? { onlyColumns: args.onlyColumns } : {}),
    subset: args.subset !== false,
  });
}

/** The same check on every row (the editor's Apply). */
function fullCheck(args: Omit<LiveCheckArgs, 'subset'>): LiveCheckResult {
  return checkExample(getExample(args.exampleId), args.rules, {
    ...(args.exceptions ? { exceptions: args.exceptions } : {}),
    ...(args.oneTime ? { oneTime: args.oneTime } : {}),
    ...(args.onlyColumns ? { onlyColumns: args.onlyColumns } : {}),
    subset: false,
  });
}

/** SPEC 9.2 layers 1-5: structure, references, types, limits, and the format lock inside a format. */
function staticChecks(args: StaticChecksArgs): StaticProblem[] {
  return runStaticChecks(args.rules, { tier: args.tier, ...(args.format ? { format: args.format } : {}) });
}

export const engineMethods = { learn, convert, verify, inspect, loadExample, liveCheck, fullCheck, staticChecks, ...convertMethods } satisfies MethodMap;
