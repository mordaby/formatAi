import type { ReactNode } from 'react';

export type CellValue = string | number | boolean | null | undefined;

export interface CellProps {
  value: CellValue;
  /** Rendered when the value is empty (null, undefined or ''). Default: nothing. */
  empty?: ReactNode;
}

/**
 * Renders one cell value or header inside `<bdi>` (SPEC 16.2 "Mixed text"): the value is
 * isolated from the text around it and picks its own direction from its first strong
 * character, so numbers, dates and English inside a Hebrew sheet (and the reverse)
 * display in the right order, and a Hebrew value never reorders its neighbours.
 *
 * Use it for every user-supplied string: cell values, headers, file names, and labels.
 */
export function Cell({ value, empty = null }: CellProps) {
  if (value === null || value === undefined || value === '') return <>{empty}</>;
  return <bdi>{typeof value === 'string' ? value : String(value)}</bdi>;
}
