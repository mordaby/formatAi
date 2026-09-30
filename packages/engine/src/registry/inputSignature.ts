// The input signature of a conversion (SPEC 8.12 "Matching a file to a conversion"): what a file must look
// like to be run by it - the headers of the input columns it reads, their aliases, types, and which are
// required. The registry stores it next to the conversion so the browser can match a new file against
// every conversion of a user without loading their whole rules (`matchConversions`).
import type { ColumnType, LearnResult, Rules } from '@formatai/shared';

export interface InputSignatureColumn {
  /** The header as the conversion's rules declare it. */
  header: string;
  aliases: string[];
  type: ColumnType;
  /** The conversion can't run without this column (`input.columns[].required`). */
  required: boolean;
}

export interface InputSignature {
  columns: InputSignatureColumn[];
}

/** Pure: the columns of `rules.input`, in declaration order. Headers, aliases, types and `required` only -
 * no ids, formats or padding, which don't decide whether a file "looks like" the source. */
export function inputSignatureOf(rules: LearnResult | Rules): InputSignature {
  return {
    columns: rules.input.columns.map((c) => ({
      header: c.header,
      aliases: c.aliases ? [...c.aliases] : [],
      type: c.type,
      required: c.required === true,
    })),
  };
}
