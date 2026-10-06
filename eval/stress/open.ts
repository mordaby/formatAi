// The stress test's open findings (eval/STRESS.md "Open findings"): failures the run reproduces that are design questions, not bugs to
// fix in passing. The summary lists them apart from new failures, so a run is "clean apart from the open findings" when nothing else
// fails. Each is matched on what the failure says, or on the seeds it was recorded with when nothing in the failure tells it apart.
import type { CaseResult, Failure } from './check';

export interface OpenFinding {
  id: string;
  title: string;
  /** The seeds it was recorded with, as "profile:seed". */
  seeds: string[];
  matches: (f: Failure, r: CaseResult) => boolean;
}

const seedOf = (r: CaseResult): string => `${r.profile}:${r.seed}`;

export const OPEN_FINDINGS: OpenFinding[] = [
  {
    id: 'O1',
    title: 'Masking: letters of a script the masker has no fake alphabet for (Cyrillic, Arabic, ...) are sent real',
    seeds: ['small:10', 'small:23', 'small:73', 'mixed:5', 'mixed:68'],
    matches: (f) => f.kind === 'maskLeakScript',
  },
  {
    id: 'O2',
    title: 'CSV/TXT: a plain negative number held as TEXT in a text column gets the formula guard\'s apostrophe; the verification compares values and passes',
    seeds: ['small:231'],
    matches: (f) => ['verifiedButDiffers', 'solvedColumnWrong', 'holdoutSilent'].includes(f.kind) && /expected (-[\d.]+), got "\1"/.test(f.detail),
  },
  {
    id: 'O3',
    title: 'Wide files: the window search tries 10 numeric columns; a group total of another column is "explained" by a value map of last month\'s totals',
    seeds: ['mixed:69'],
    matches: (f, r) => f.kind === 'holdoutSilent' && ['mixed:69'].includes(seedOf(r)),
  },
  {
    id: 'O4',
    title: 'Time: 20,000 x 20 with an xlsx input: learn 7-14 s, convert 5-13 s with an xlsx output (reading a 20,000-row workbook is about 4 s: SheetJS, then the ExcelJS overlay)',
    seeds: ['timing:4', 'timing:7', 'timing:8', 'timing:9'],
    matches: (f, r) => f.kind === 'slow' && r.fileType === 'xlsx',
  },
];

/** The open finding a failure is, or undefined for a new failure. */
export function openFindingOf(f: Failure, r: CaseResult): OpenFinding | undefined {
  return OPEN_FINDINGS.find((o) => o.matches(f, r));
}

/** The failures of a case that are no open finding. */
export function newFailures(r: CaseResult): Failure[] {
  return r.failures.filter((f) => openFindingOf(f, r) === undefined);
}
