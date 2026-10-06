// Israeli ID (teudat zehut) check digit. The check itself lives in the shared package (`isValidIsraeliId`, `identifiers.ts`): the Save
// popup's identifier detectors run on the browser's main thread, which never loads the engine. Pure, no dependencies.
import { isValidIsraeliId } from '@formatai/shared';

export { isValidIsraeliId };

/** Appends a valid check digit to 8 seed digits, producing a valid 9-digit Israeli ID. */
export function makeValidIsraeliId(seed8: string): string {
  if (!/^\d{8}$/.test(seed8)) throw new Error('makeValidIsraeliId: seed8 must be exactly 8 digits');
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const weight = (i % 2) + 1;
    let digit = Number(seed8[i]) * weight;
    if (digit > 9) digit -= 9;
    sum += digit;
  }
  const check = (10 - (sum % 10)) % 10;
  return seed8 + String(check);
}
