// The AI code checks' test pair (docs/proposals/ai-code-checks.md section 1, made synthetic): orders whose output has `Total` (Qty x Price)
// and `Class`, a class BY THAT TOTAL - "Small" below 1,000, "Medium" below 5,000, "Big" from 5,000 - where the total is itself an output
// column. The owner's file had exactly this shape; a weak model could not see the class follows the total until code told it so.
import type { Expr, LearnResult } from '@formatai/shared';
import type { V } from './analyze/helpers';
import type { Pair } from './v5fixtures';

const ITEMS = ['Bolt', 'Nut', 'Gear', 'Shaft', 'Valve', 'Pump', 'Hinge', 'Spring'];
const CUSTOMERS = ['Dana Levi', 'Yossi Cohen', 'Noa Peretz', 'Omer Biton', 'Maya Golan'];
const STATUSES = ['Open', 'Closed', 'Open'];

export function classOf(total: number, low = 1000, high = 5000): string {
  return total < low ? 'Small' : total < high ? 'Medium' : 'Big';
}

/** `n` orders: Item, Customer (a name: masked when masking is on), Qty, Price, Status -> Item, Customer, Total, Class. */
export function classPair(n = 60): Pair {
  const input: V[][] = [['Item', 'Customer', 'Qty', 'Price', 'Status']];
  const output: V[][] = [['Item', 'Customer', 'Total', 'Class']];
  for (let i = 0; i < n; i++) {
    const item = `${ITEMS[i % ITEMS.length]} ${100 + i}`;
    const customer = CUSTOMERS[i % CUSTOMERS.length]!;
    const qty = 1 + ((i * 7) % 20);
    const price = 10 + ((i * 37) % 400) + 0.5 * (i % 2);
    const total = Math.round(qty * price * 100) / 100;
    input.push([item, customer, qty, price, STATUSES[i % STATUSES.length]!]);
    output.push([item, customer, total, classOf(total)]);
  }
  return { input, output };
}

/** The totals of the pair, in row order. */
export function totalsOf(pair: Pair): number[] {
  return pair.output.slice(1).map((row) => row[2] as number);
}

const col = (id: string): Expr => ({ col: id });
const text = (s: string): Expr => ({ const: s });

/**
 * The rules for the pair: Item and Customer copied, `value2` = Qty x Price (the total), and - unless `withoutClass` (the user's rules the AI
 * step completes) - the class with cut-offs `low` and `high` (1,000 and 5,000 are right).
 */
export function classRules(opts: { low?: number; high?: number; withoutClass?: boolean } = {}): LearnResult {
  const { low = 1000, high = 5000 } = opts;
  const total: Expr = { op: 'round', arg: { op: 'mul', args: [col('qty'), col('price')] }, digits: 2 };
  const klass: Expr = {
    op: 'if',
    cond: { op: 'lt', args: [col('value2'), { const: low }] },
    then: text('Small'),
    else: { op: 'if', cond: { op: 'lt', args: [col('value2'), { const: high }] }, then: text('Medium'), else: text('Big') },
  };
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'item', header: 'Item', type: 'text' },
        { id: 'customer', header: 'Customer', type: 'text' },
        { id: 'qty', header: 'Qty', type: 'integer' },
        { id: 'price', header: 'Price', type: 'decimal' },
      ],
    },
    transform: {
      computed: [{ id: 'value2', type: 'decimal', expr: total }, ...(opts.withoutClass ? [] : [{ id: 'value3', type: 'text' as const, expr: klass }])],
      valueMaps: [],
      sort: [],
    },
    output: {
      sheetName: 'Sheet1',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [
        { header: 'Item', from: 'item' },
        { header: 'Customer', from: 'customer' },
        { header: 'Total', from: 'value2' },
        { header: 'Class', from: opts.withoutClass ? null : 'value3' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}
