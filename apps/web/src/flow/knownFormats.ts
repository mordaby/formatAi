// "You already have this format" (owner decision 2026-10-07): what the main thread reads for the worker's check (engine `findAlreadyLearned`)
// - the user's OWN saved formats, from the API, structure and rules only. Nothing of the example leaves the browser: the comparison and the
// run of the saved rules are the worker's.
//
//   knownCandidates: the list of formats (GET /api/formats), and only for the ones whose output headers (in order, spaces not counted) and file
//                    kind are the example's: their output side and conversions (GET /api/formats/:id) and every source's signature
//                    (GET /api/signatures). No such format: nothing more is read.
//   knownRules:      one conversion's saved rules (GET /api/conversions/:id), asked only for a format whose source the example input is.
// Any failure is no match: the learn goes on as if the user had no saved format.
import { normalizeOutputHeader, type FormatSummary } from '@formatai/shared';
import type { ExampleShape, KnownCandidates, SavedFormatCandidate } from '@formatai/engine';
import type { RegistryApi } from '../api/registry';
import { signatureOf } from '../pages/Convert/logic';
import type { LearnHost } from '../worker/engineApi';

/** The saved formats worth reading in full: the example's output headers in order, its file kind, and a header row. */
export function knownSummaries(formats: readonly FormatSummary[], example: ExampleShape): FormatSummary[] {
  if (!example.headerRow || example.outputHeaders.length === 0) return [];
  const headers = example.outputHeaders.map(normalizeOutputHeader);
  return formats.filter(
    (f) => f.fileType === example.fileType && f.outputHeaders.length === headers.length && f.outputHeaders.every((h, i) => normalizeOutputHeader(h) === headers[i]),
  );
}

/** "Most recently used": its last run or its last change, whichever is later. */
function usedAt(f: FormatSummary): string {
  return f.lastRunAt && f.lastRunAt > f.updatedAt ? f.lastRunAt : f.updatedAt;
}

const NONE: KnownCandidates = { formats: [], sources: [] };

/** The two host functions of the check, on the user's registry. `signal`: the learn's own (a cancelled learn reads no more). */
export function knownFormatsHost(registry: RegistryApi, signal?: AbortSignal): Required<Pick<LearnHost, 'knownCandidates' | 'knownRules'>> {
  return {
    knownCandidates: async (example) => {
      try {
        const worth = knownSummaries(await registry.listFormats(signal), example);
        if (worth.length === 0) return NONE;
        const [details, signatures] = await Promise.all([Promise.all(worth.map((f) => registry.getFormat(f.id, signal))), registry.signatures(signal)]);
        const formats: SavedFormatCandidate[] = details.map((d, i) => ({
          id: d.format.id,
          name: d.format.name,
          format: { output: d.format.output, layout: d.format.layout, outputValidations: d.format.outputValidations } as SavedFormatCandidate['format'],
          usedAt: usedAt(worth[i]!),
          conversions: d.conversions.map((c) => ({ id: c.id, sourceId: c.sourceId, sourceName: c.sourceName, version: c.version })),
        }));
        return { formats, sources: signatures.map(signatureOf) };
      } catch {
        return NONE;
      }
    },
    knownRules: async (conversionId) => {
      try {
        return (await registry.getConversion(conversionId, signal)).rules;
      } catch {
        return null;
      }
    },
  };
}
