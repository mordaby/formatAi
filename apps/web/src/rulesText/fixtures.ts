// Test fixtures for the rules map. Every id starts with "c_" / "p_" / "x_", so a sentence that
// leaks an internal id is easy to catch. Headers are ordinary words.
import type { Expr, LearnResult, RulesInput, RulesOutput, RulesTransform } from '@formatai/shared';

export interface Patch {
  input?: Partial<RulesInput>;
  transform?: Partial<RulesTransform>;
  output?: Partial<RulesOutput>;
  validations?: LearnResult['validations'];
  unsupported?: LearnResult['unsupported'];
  assumptions?: LearnResult['assumptions'];
}

export const INPUT_COLUMNS: RulesInput['columns'] = [
  { id: 'c_cost', header: 'Cost', type: 'decimal' },
  { id: 'c_code', header: 'Code', type: 'idLike', padLeft: 9 },
  { id: 'c_name', header: 'Name', type: 'text' },
  { id: 'c_group', header: 'Group', type: 'text' },
  { id: 'c_date', header: 'Date', type: 'date' },
  { id: 'c_status', header: 'Status', type: 'text' },
  { id: 'c_supplier', header: 'Supplier', type: 'text' },
  { id: 'c_order', header: 'Order number', type: 'idLike' },
  { id: 'c_amount', header: 'Amount', type: 'decimal' },
  { id: 'c_items', header: 'Items', type: 'text' },
  { id: 'c_jan', header: 'Jan', type: 'decimal' },
  { id: 'c_feb', header: 'Feb', type: 'decimal' },
  { id: 'c_tags', header: 'Tags', type: 'text' },
];

/** A valid rules object with one plain column; `patch` replaces whole sections. */
export function rules(patch: Patch = {}): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: INPUT_COLUMNS,
      ...patch.input,
    },
    transform: {
      computed: [],
      valueMaps: [],
      sort: [],
      ...patch.transform,
    },
    output: {
      sheetName: 'Report',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [{ header: 'Name', from: 'c_name' }],
      ...patch.output,
    },
    validations: patch.validations ?? [],
    unsupported: patch.unsupported ?? [],
    assumptions: patch.assumptions ?? [],
  };
}

/** One computed column shown as output column `header`. */
export function withColumn(header: string, expr: Expr, patch: Patch = {}): LearnResult {
  return rules({
    ...patch,
    transform: { ...patch.transform, computed: [{ id: 'p_value', type: 'decimal', expr }] },
    output: { columns: [{ header, from: 'p_value' }], ...patch.output },
  });
}

export const col = (id: string) => ({ col: id });
export const num = (n: number) => ({ const: n });
export const str = (s: string) => ({ const: s });

/** Every line of a model as `[id, text]`. */
export function lineTexts(model: { sections: { lines: { id: string; text: string }[] }[] }): [string, string][] {
  return model.sections.flatMap((s) => s.lines.map((l): [string, string] => [l.id, l.text]));
}
