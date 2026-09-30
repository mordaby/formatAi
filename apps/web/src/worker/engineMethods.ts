// The engine methods the worker exposes (SPEC 2, 4 "where each step runs"). Everything
// here runs on real data, in the worker; the only thing that leaves is what the main
// thread sends over HTTP on the worker's behalf via `ctx.host` (the learn payload, which
// the engine itself builds - masked unless the user turned masking off).
import {
  analyzePair,
  convertFile,
  learnFromExamples,
  readWorkbook,
  sniffDelimitedText,
  verifyAgainstExample,
  type LearnCallResult,
} from '@formatai/engine';
import type { AnalysisProgress } from '@formatai/engine';
import type { ConvertArgs, ConvertOutput, LearnArgs, LearnOutput, LearnProgress, VerifyArgs, VerifyOutput } from './engineApi';
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
  return learnFromExamples({
    input: { bytes: new Uint8Array(args.input.bytes), name: args.input.name },
    output: { bytes: new Uint8Array(args.output.bytes), name: args.output.name },
    masking: args.masking,
    ...(args.masking ? { key: maskingKey() } : {}),
    tier: args.tier,
    ...(args.target ? { target: args.target } : {}),
    ...(args.tryAnyway ? { tryAnyway: true } : {}),
    onProgress: (p: AnalysisProgress) => emit({ phase: 'checking', stage: p.stage, fraction: p.fraction }),
    callLearn: async (payload) => {
      emit({ phase: 'learning', attempt: 'learn' });
      const out = await ctx.host<LearnCallResult>('callLearn', payload);
      emit({ phase: 'verifying' });
      return out;
    },
    callRepair: async (payload, previousRules, problems) => {
      emit({ phase: 'learning', attempt: 'repair' });
      const out = await ctx.host<LearnCallResult>('callRepair', payload, previousRules, problems);
      emit({ phase: 'verifying' });
      return out;
    },
  });
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

export const engineMethods = { learn, convert, verify } satisfies MethodMap;
