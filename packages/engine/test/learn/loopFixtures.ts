// The learning loop's test pair (docs/proposals/learning-loop.md section 1, made small): orders with a Priority the rules must work out -
// "Blocked" when on hold, "Urgent" when open and the amount is at least 5,000, "Normal" when open, else "Done". A rules file with the
// wrong cut-off gets exactly the open orders between the right cut-off and its own wrong (Urgent expected, Normal made), which is what
// the loop sends back, round after round.
import type { Expr, LearnResult } from '@formatai/shared';
import type { V } from './analyze/helpers';
import type { Pair } from './v5fixtures';

export const CUTOFF = 5000;
const NAMES = ['Dana Levi', 'Yossi Cohen', 'Noa Peretz', 'Omer Biton', 'Maya Golan', 'Tal Mizrahi', 'Roni Katz', 'Gal Amar'];
const STATUSES = ['Open', 'Done', 'Open', 'On hold', 'Open'];

export function priorityOf(status: string, amount: number): string {
  if (status === 'On hold') return 'Blocked';
  if (status === 'Open') return amount >= CUTOFF ? 'Urgent' : 'Normal';
  return 'Done';
}

/** `n` orders: Order (a unique id), Customer (a name: masked when masking is on), Status, Amount -> Order, Customer, Priority. */
export function priorityPair(n = 60): Pair {
  const input: V[][] = [['Order', 'Customer', 'Status', 'Amount']];
  const output: V[][] = [['Order', 'Customer', 'Priority']];
  for (let i = 0; i < n; i++) {
    const order = `ORD-${1000 + i}`;
    const customer = NAMES[i % NAMES.length]!;
    const status = STATUSES[i % STATUSES.length]!;
    const amount = 500 + ((i * 1733) % 9500);
    input.push([order, customer, status, amount]);
    output.push([order, customer, priorityOf(status, amount)]);
  }
  return { input, output };
}

/** The input rows (0-based, as `analysis.input.rows` counts them) that rules with cut-off `cut` get wrong. */
export function wrongWithCutoff(pair: Pair, cut: number): number[] {
  const wrong: number[] = [];
  pair.input.slice(1).forEach((row, i) => {
    const [, , status, amount] = row as [string, string, string, number];
    const made = status === 'On hold' ? 'Blocked' : status === 'Open' ? (amount >= cut ? 'Urgent' : 'Normal') : 'Done';
    if (made !== priorityOf(status, amount)) wrong.push(i);
  });
  return wrong;
}

const col = (id: string): Expr => ({ col: id });
const text = (s: string): Expr => ({ const: s });

/** The rules for the pair, with the given cut-off (`CUTOFF` is right). */
export function priorityRules(cut: number): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'order', header: 'Order', type: 'idLike' },
        { id: 'customer', header: 'Customer', type: 'text' },
        { id: 'status', header: 'Status', type: 'text' },
        { id: 'amount', header: 'Amount', type: 'decimal' },
      ],
    },
    transform: {
      computed: [
        {
          id: 'priority',
          type: 'text',
          expr: {
            op: 'if',
            cond: { op: 'eq', args: [col('status'), text('On hold')] },
            then: text('Blocked'),
            else: {
              op: 'if',
              cond: { op: 'eq', args: [col('status'), text('Open')] },
              then: { op: 'if', cond: { op: 'gte', args: [col('amount'), { const: cut }] }, then: text('Urgent'), else: text('Normal') },
              else: text('Done'),
            },
          },
        },
      ],
      valueMaps: [],
      sort: [],
    },
    output: {
      sheetName: 'Sheet1',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [
        { header: 'Order', from: 'order' },
        { header: 'Customer', from: 'customer' },
        { header: 'Priority', from: 'priority' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}
