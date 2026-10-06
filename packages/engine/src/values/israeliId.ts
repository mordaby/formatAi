// Israeli ID (teudat zehut) check digit. The check itself is the library's, through the shared package (`isValidIsraeliId`,
// `identifiers.ts`: validator.js), which the Save popup on the browser's main thread uses too. Pure.
import { isValidIsraeliId } from '@formatai/shared';

export { isValidIsraeliId };

/** Appends the check digit to 8 seed digits, producing a valid 9-digit Israeli ID: the one digit the check accepts (one always does). */
export function makeValidIsraeliId(seed8: string): string {
  if (!/^\d{8}$/.test(seed8)) throw new Error('makeValidIsraeliId: seed8 must be exactly 8 digits');
  for (let d = 0; d <= 9; d++) if (isValidIsraeliId(seed8 + d)) return seed8 + d;
  throw new Error('makeValidIsraeliId: no check digit fits');
}
