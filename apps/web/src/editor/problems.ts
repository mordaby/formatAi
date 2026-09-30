// A rules-editing step either produces rules or a list of typed problems.
import type { EditProblem } from './types';

export type Problems = EditProblem[];

export function fail(problem: EditProblem | EditProblem[]): EditProblem[] {
  return Array.isArray(problem) ? problem : [problem];
}

/** Rules are objects, problems are arrays: one `Array.isArray` tells them apart. */
export function isProblems<T>(x: T | EditProblem[]): x is EditProblem[] {
  return Array.isArray(x);
}
