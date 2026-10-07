// The example pair of the "See what we send" tests (owner, 2026-10-07): an ID column (valid Israeli IDs: hidden by default), a name (text:
// hidden), a quantity (a measure: sent), and an output Size the fast path leaves to the AI (a cut-off on the quantity).

/** The check digit that makes a 9-digit Israeli ID number valid. */
export function withCheckDigit(eight: string): string {
  let sum = 0;
  [...eight].forEach((ch, i) => {
    const n = Number(ch) * (i % 2 === 0 ? 1 : 2);
    sum += n > 9 ? n - 9 : n;
  });
  return eight + String((10 - (sum % 10)) % 10);
}

export const NAMES = ['Kumquat Levi', 'Zeppelin Cohen', 'Marzipan Haddad', 'Quokka Smith', 'Lozenge Taylor', 'Buttress Wilson', 'Gazebo Young', 'Nutmeg Abraham', 'Cobbler Peretz', 'Trestle Golan'];
// (six digits: a hidden value of one or two digits may well get itself as its look-alike)
export const QTY = [130500, 420750, 170250, 250125, 110900, 400300, 190700, 350850, 120400, 300600];
export const IDS = NAMES.map((_, i) => withCheckDigit(String(31234567 + i * 7919)));

/** ID (valid IDs: hidden by default), Name (text: hidden), Qty (a measure: sent) -> ID, Name, Size: a rule on Qty the fast path leaves to the AI. */
export function idPair() {
  return {
    input: 'ID,Name,Qty\n' + NAMES.map((n, i) => `${IDS[i]},${n},${QTY[i]}`).join('\n') + '\n',
    output: 'ID,Name,Size\n' + NAMES.map((n, i) => `${IDS[i]},${n},${QTY[i]! >= 200000 ? 'bulk' : 'single'}`).join('\n') + '\n',
  };
}

