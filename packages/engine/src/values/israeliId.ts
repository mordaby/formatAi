// Israeli ID (teudat zehut) check-digit validation. Pure, no dependencies.

/**
 * True when `s` is 1-9 digits that, once left-padded to 9 digits, pass the
 * standard Israeli ID check-digit algorithm (alternating weights 1/2, digits
 * of a weighted product >= 10 are summed, total must be a multiple of 10).
 */
export function isValidIsraeliId(s: string): boolean {
  if (!/^\d{1,9}$/.test(s)) return false;
  const id = s.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const weight = (i % 2) + 1;
    let digit = Number(id[i]) * weight;
    if (digit > 9) digit -= 9;
    sum += digit;
  }
  return sum % 10 === 0;
}

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
