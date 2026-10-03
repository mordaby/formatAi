# Proposal: across-row "window" operations

Status: **built** (branch `m3`, 2026-10-01). Decisions: (1) the free engine builds only the order-independent patterns, `groupSum(x, by: g)` and `groupCount(by: g)`, never running sums, row numbers, previous / next, fill down or rank; (2) a row later left out by a `block` validation still counts, and the run summary says how many (counts only); (3) hints for the patterns the free engine does not build: detection and the `rel: "window"` hint shape are built behind `limits.learn.window.hintsEnabled`, OFF until learn-v7 (prompt and `promptVersion` unchanged, all window ops `inPrompt: false`); (4) `x`, `by` and `order` items are plain column ids in v1; (5) the editor offers only "Running total" (file order or a column + direction required, a note when the rules remove duplicates), the rest through Advanced; default order without `order:` is file order. Sections 5 and 6 below describe the original draft: where they say the free engine builds running totals and row numbers, decision (1) overrides; where they list hints for the AI, decision (3) applies. Spec: SPEC 8.2, 8.3, 8.10, 8.11 and the v9 note in section 21.

**In one paragraph.** One new expression node, `window`, written in formulas as a call with named arguments: `runningSum(amount, by: account, order: date)`. It is allowed only inside a computed column and evaluated in step 6 over the rows that survived filters, duplicates and expand, in file order. The result is stored per row like any computed value, so sort, group, validations, summary rows and the output see an ordinary column. Eleven function names cover all 9 `acrossRows` catalogue types. The free engine builds 4 simple patterns; everything else reaches the AI with a code-verified hint (learn-v7).

Changes from the draft list: (1) `rank` has no value argument, `order:` says what is ranked; (2) no `pctOfGroup`: write `x / groupSum(x, by: g) * 100`, which reuses division and its divide-by-zero flag; (3) `x`, `by`, `order` are column ids, never expressions (an expression goes in a helper computed column first).

## 1. Operations and formula syntax

`x` is a column id. "Partition" = rows with the same `by` values (all rows without `by:`); an empty group value is a partition of its own, as in `group.by`.

| Function | Returns | Meaning | Empty values, first row, ties |
|---|---|---|---|
| `runningSum(x)` | decimal (integer if x is) | sum of x from the partition's first row through this one | empty/non-numeric x adds nothing; empty until the first number |
| `groupSum(x)` | same | partition sum on every row | empty if no number |
| `groupAvg(x)` | decimal | exact sum / count, unrounded (like the `average` summary) | empty if no number |
| `groupMin(x)`, `groupMax(x)` | x's type (number or date) | typed, ordered like `sort` | empties skipped; empty if none |
| `groupCount()`, `groupCount(x)` | integer | rows in the partition / rows with non-empty x | never empty |
| `previous(x)`, `next(x)` | x's type (any) | x on the row before / after, in partition order | empty on the first / last row |
| `fillDown(x)` | x's type (any) | last non-empty x up to this row | empty until the first non-empty |
| `rowNumber()` | integer | 1, 2, 3 ... in partition order | `order:` ties keep file order: always unique |
| `rank(order: k)` | integer | position by the order keys, first = 1 | equal keys share a rank: `ties: min` (default) 1,1,3; `dense` 1,1,2. Empty first key: empty rank, row not counted |

Optional named arguments: `by:`, `order:` (not on `group*`; required on `rank`), `ties:` (`rank` only). Examples: `runningSum(amount, by: account, order: (date, txnId desc))`, `groupCount(by: customer)`, `round(amount / groupSum(amount) * 100, 1)`, `if(rowNumber(by: invoice) > 1, "Duplicate", null)`, `rank(order: sales desc, ties: dense)`.

**Grammar.** Hand-parsed like `switch`/`call` (`formula: { form: 'special' }`), driven by one new `WINDOW_SIGNATURES` table beside `OP_SIGNATURES`; the lexer gains one token, `:` (an error today, so nothing existing changes).
```
windowCall := FN '(' [ IDENT ] { ',' name ':' value } ')'
by: IDENT | '(' IDENT {',' IDENT} ')'      order: key | '(' key {',' key} ')'   key := IDENT [asc|desc]
```
The first argument must come out as a bare column, else a parse error with offset ("make a computed column first"), the same `formula`-kind repair problem as today. Positional `runningSum(amount, account, date)` is rejected: with two optional keys it cannot say which is group and which order, cannot omit one, and has no place for `desc`.

**AST** (stored rules stay JSON, `schemaVersion` stays 1, old files unchanged): `{ op: 'window', fn, arg?: Expr, by?: string[], order?: { column, dir }[], ties?: 'min'|'dense' }`. `arg` is an `Expr` (v1: must be a `{col}`) so generic walkers treat it normally and relaxing later is compatible. Order items use `column`, **not** `col`: `limits.ts`'s generic walker treats any object with `col`/`const`/`param`/`op` as an Expr child. The learn wire schema does not change (formulas are strings).

**Prompt gating.** Registered like the ops added after learn-v6 (`weekday`, `makeDate`, ...): `inPrompt: false` on the `window` entry. Parser, Advanced view and engine support it at once; the API's LLM-answer parse (`promptOpsOnly`) treats the 11 names as unknown functions, and the sync test skips them, until learn-v7 documents them and the flag is deleted.

## 2. Semantics and where they run

**Placement: step 6, computed columns.** A computed column containing a window is evaluated column-major: each window node (post-order) is computed over all current rows into a hidden per-row slot (numbered after the declared slots, not addressable by id), then the column's expression runs per row and reads it. Columns without a window run today's row-major loop unchanged, so rules without windows behave and serialize identically. Windows may read earlier computed columns, including window columns (`rank` of a `runningSum`), so no cycle is possible.

**Only in `transform.computed[].expr`.** Filters and fan-out `set` run before step 6 and function bodies are pure: a window there is a parse error (new `allowWindows` on the parse context, set only by `computedFromWire`) and a `checkRules` problem for stored JSON.

**File order and `order:`.** File order = the rows' order right before step 6 (input order after filters, dedupe, expand; families in family order). Without `order:` a window walks it, whatever the output sort. `order:` sorts the partition with `sort.ts`'s `keyPart`/`cmpKeyPart` (typed, text by code point, empties last either way), ties by file index. The output `sort` runs later and only moves rows with their values, so sorting by a window column works and a running balance on a date-sorted report is `order: date`. Format-owned `sort`/`group` and conversion-owned windows are not linked.

| Row | In the window? |
|---|---|
| Filtered, duplicate `remove`, user `skip` for this run | No: gone before step 6 |
| Duplicate `flag`, expand-created rows, user `keep` | Yes, one row each |
| User `override` for this run | Yes, with the edited values |
| Later left out by a `block` validation | Yes (validations run after step 6); the run summary adds a notice "N blocked rows are included in running/group values" (question 2) |
| Summary and title rows | Never; they see window columns as ordinary output columns (`last` of a running sum = closing balance) |

Value maps run after step 6, so windows read pre-map values. Windows raise no flags of their own (an unparseable cell is already flagged and skipped, as in `sum`). Stays `crossRowCalculation`: values over rows a filter removes, rolling N-row windows, anything across files.

## 3. Determinism and performance

- decimal.js only, strictly in partition order; `groupAvg` at the default precision of the `average` summary. No clock, locale or randomness.
- Partitions by `canonicalKey` (the identity of `group.by` and dedupe); order by an index sort with explicit `i - j` tie-break, as `sort.ts`.
- One partition map per distinct `by`, one sorted index per distinct (`by`, `order`), cached within the run; each window is then O(n). Estimate, to confirm in `perf.test.ts`: 10-25 ms per window at 5,000 rows (live-check budget 300 ms), about 0.3 s at 100,000 (paid cap).
- Config: `limits.rules.maxWindowOps: 8` (window nodes per file), `maxWindowKeys: 3` (columns in one `by:` / `order:`).

## 4. Type checking and limits

- **Structure:** zod `strictObject`, `fn` enum; per-function shape (required/forbidden args) from `WINDOW_SIGNATURES`, at parse time and for stored JSON.
- **References** (`shared/rules/check.ts`): `arg`, each `by` and `order[].column` must exist at that column's position (input, expand-created or earlier computed). The exhaustive switches (shared `check.ts`, engine `expr.ts`, `typeCheck.ts`, `canonicalize.ts`, `printFormula.ts`) gain a `window` case.
- **Types** (`typeCheck.ts`): `runningSum/groupSum/groupAvg` need a numeric column (`expected decimal, got text; use toNumber in a computed column first`); `groupMin/Max` number or date; `previous/next/fillDown` any, result = the column's type; `rowNumber/rank/groupCount` integer. Result must fit the computed column's declared type. `by`/`order` accept any type.
- **Limits:** a window costs 2 nodes (itself, its `{col}`) and 1 depth level; `limits.ts` also follows `by`/`order` references into computed chains, which a plain Expr walk misses. `countRules` adds **1 rule per window node** (like sort/group), on top of its output column. `maxWindowOps` / `maxWindowKeys` fail with precise messages for the repair call.
- **Reserved names:** the 11 names become built-ins; a user function named `rank`/`next`/`previous` would be shadowed when printed and re-parsed (latent today for `round`, unguarded). Add a `checkRules` rejection of function names equal to a built-in, for new rules; stored `call` nodes keep running.

## 5. Free-engine detection (new `analyze/windows.ts`, relation `window`)

Only for 1:1 alignment (method `key`/`position`, no families, not a summary output), at least `limits.learn.window.minRows` (4) aligned rows, numeric output column. Tested on all aligned rows with exact decimal equality (as `aggHolds`), over kept rows in input order (what the engine will run). Built only at coverage 1.0. Candidates: `x` = numeric input columns; `by` = at most 3 text/id/integer columns with 2+ distinct values and a repeated one, never the alignment key.

| Pattern | Holds when | Built as |
|---|---|---|
| running total | cell = sum of x over earlier-or-equal rows (global; per group only if global fails) | `runningSum(x[, by: g])` |
| group total per row | cell = sum of x over rows with the same g (2+ groups, a group of 2+) | `groupSum(x, by: g)` |
| count per group | cell = rows with the same g (sizes not all 1) | `groupCount(by: g)` |
| row number | cell = 1..n in file order (global, or per group) | `rowNumber([by: g])` |

Guards: at least one row where the result differs from `x` (not a copy); global beats `by` when both hold. **Ambiguity** (two `x`, or two `by` columns exact on every row, e.g. a code and its name) builds nothing and goes to the AI with `alt`. **Precedence:** the window relation ranks above `valueMap`, `constant` and `dependsOn`/`bands`; the catalogue today shows `group-total-each-row` and `count-per-group` as fast "wrong", memorized as `map(department, 4 values)`. Coverage 0.9-0.99 is a hint only (`failsOn`). If only the output-order reading is exact, the hint says `order: 'output'`, never built.

**Sequencing:** the fast-path build ships before learn-v7 (it writes JSON rules; no prompt involved). `window` hints are **not** put in the payload until learn-v7 documents them.

## 6. Prompt draft (learn-v7) and hints

The AI cannot find these alone: samples are up to 12 random pairs, so neighbours are invisible. Without a verified hint it answers `crossRowCalculation`. Hint shape (positions as in other hints):
```
{ out: 3, rel: 'window', fn: 'runningSum', in: [2], by: [1], order: 'file', coverage: 1 }   // a fact
{ out: 2, rel: 'window', fn: 'rank', order: [{ in: 1, dir: 'desc' }], ties: 'min', coverage: 0.97, failsOn: [4] }
{ out: 0, rel: 'window', fn: 'rowNumber', by: [1], order: 'output', coverage: 1, alt: [{ by: [5] }] }  // alt: max 3
```
`order`: `'file'` = no `order:`; `'output'` = the example numbers rows in the order the output shows (copy `output.layout.sort` into `order:`); or the verified keys.

Text for `LEARN_PROMPT.md`:

> **Pipeline sentence:** `... → expand → computed (window functions run here, over the rows that remain, in file order) → valueMaps → ...`
>
> **Operations:** Across rows, only inside a computed column's formula. Arguments are column ids, never expressions (make a helper computed column first). `runningSum(x)`: running sum including this row. `groupSum(x)`, `groupAvg(x)`, `groupMin(x)`, `groupMax(x)`, `groupCount()` or `groupCount(x)`: the whole group's value on every row. `previous(x)`, `next(x)`: x on the row before/after (empty at the ends). `fillDown(x)`: last non-empty x so far. `rowNumber()`: 1, 2, 3 ... `rank(order: k)`: position by k, equal values share a rank (`ties: min` gives 1,1,3; `ties: dense` 1,1,2). Optional named arguments: `by: g` or `by: (g1, g2)` restarts per group (none = all rows); `order: k`, `order: k desc` or `order: (k1, k2 desc)` (none = file order; not for group*; required for rank). Examples: `runningSum(amount, by: account)`, `groupCount(by: customer)`, `round(amount / groupSum(amount) * 100, 1)`, `rank(order: sales desc)`, `if(rowNumber(by: invoice) > 1, "Duplicate", null)`. At most 8 window functions per file; at most 3 columns in by and in order.
>
> **How to work:** A hint with rel "window" is a fact checked on all rows: write that function with its in/by/order. order "file" means no order:; "output" means the example numbers rows in the order the output shows, so copy that sort into order:. If alt is present, pick the column that is a real key or amount and add assumption `other`; if order or ties were not forced, add `sortGuessed`.
>
> **Can't do:** `crossRowCalculation`: needs other rows in a way the window functions cannot say (rows a filter removes, a moving average of N rows).

On release, delete `inPrompt: false`; `promptOpsSync.test.ts` then also asserts every `WINDOW_SIGNATURES` name appears as `name(` in the Operations section.

## 7. Editor (SPEC 8.11)

One new method chip, **Running total**: `ColumnMethod { kind: 'runningSum', column, groupBy?, orderBy?: { column, dir } }`. Fields: "Add up [numeric column]", optional "Start again for each [column]", optional "In the order of [column] [lowest / highest first]" (default: as the rows appear in your file). It writes `{ op: 'window', fn: 'runningSum', ... }` into a generated computed column typed from the source column. `readColumnMethod` shows the chip only for exactly that shape (whole expression, at most one `by`, one `order` key); every other window, including the AI's, reads as `formula` (Advanced), whose text field accepts the new syntax once the parser does. The rules map still describes each column as a sentence, so `rulesText` needs en and he phrases for all 11 functions (e.g. "Balance: running total of Amount, restarting for each Account, in order of Date"); its exhaustive switch forces it.

## 8. Test plan

- **Engine:** per function, table-driven against plain-TS oracles (the catalogue's `value` functions) and an O(n²) oracle on random tables: first row, empty x / group / order key, ties (`min`, `dense`), `desc`, multi-key order, typed min/max on dates, text `previous`, exact decimals (0.1 + 0.2), integer vs decimal results.
- **Formula and checks:** round-trip property test extended; error offsets (expression as `x`, unknown/duplicate name, `order` on `groupSum`, `rank` without `order`, window in a filter or function body, a column named `desc`); reference, type, node, rule-count and `maxWindowOps` tests; a regression that `order` items are not read as Expr leaves by `limits.ts`; `promptOpsOnly` rejects the names.
- **Pipeline placement:** filtered, deduped and skipped rows not counted; expand families in order; `override`/`keep` decisions; blocked rows counted plus notice; value map after windows; sort by a window column; group with `last` of a running sum; **no-window rules byte-identical** (the existing golden suite proves it).
- **Golden cases** (cell by cell): running balance per account; department share of total; rank and row number (he, rtl); fill-down from CSV. **Determinism:** run twice and byte-compare each, plus a case with many equal order keys. **Performance:** 4 windows at 5,000 rows; 10,000 vs 100,000 scaling ratio under about 15.
- **Free engine:** per pattern positive and negative (single group, equals a copy, two equally fitting `by` columns gives `alt`, coverage 0.95 gives a hint only, dropped rows excluded, output order differing from file order gives `order: 'output'`, precedence over `valueMap`/`constant`); no `window` hint in the payload before learn-v7.
- **Catalogue:** flip all 9 `acrossRows` types from `rule: null` to reference rules and delete the five capabilities (`windowAggregate`, `rowLookback`, `runningAggregate`, `rank`, `rowIndex`): `runningSum(amount)`, `rank(order: sales desc)`, `previous(reading)`, `fillDown(cat)`, `groupSum(amount, by: dept)`, `groupCount(by: customer)`, `round(amount / groupSum(amount) * 100, 1)`, `rowNumber()`, `if(rowNumber(by: inv) > 1, "Duplicate", null)`. Expected report: language 76 to 85 of 93, gaps 17 to 8; the fast engine solves running total, group total, count per group and row number, and the two across-rows "wrong" cases disappear; the other five show as expressible, needs the AI step. Add types for `ties`, `by` + `order`, output order differing from file order, an unseen group in the next-month file.
- **UI:** model tests for the Running total method (build, read, round trip, fallback to `formula`); `describe` golden sentences en/he for all 11.

**SPEC edits when built:** 6.2 step 4 (`window` relation), 8.2 (step 6 note), 8.3 (Window operations, limits), 8.10 (`crossRowCalculation` narrowed), 8.11 (Running total), 21 (v9 note). **Build order:** parser and AST, engine step, checks and limits, catalogue flip, free-engine patterns, editor, then prompt and hints with learn-v7. The working tree already has uncommitted edits to `signatures.ts`, `parseFormula.ts`, `schema.ts`, `check.ts` (the date/text ops) and to `learn/analyze/relations.ts`, `fastPath.ts`: build after those land.

## 9. Open questions

1. **Default order is file order (before the output sort).** Alternative: output order, which means running windows after sort (no sorting by a window column) and a changed report sort silently changes balances. Recommended: file order plus explicit `order:`. Confirm?
2. **Do rows later blocked by a validation count in windows?** Recommended yes, with a run-summary notice, because validations may read window columns and so must run after. Alternative: re-evaluate windows over the surviving rows after blocking, so values reconcile with visible rows like summary rows do, at the price of validations having judged the earlier values.
3. **Hints for the functions the free engine does not build** (`previous`, `next`, `fillDown`, `rank`, `groupAvg/Min/Max`)? Recommended yes, hint only, in learn-v7. Without them the AI answers `crossRowCalculation` and these exist only for hand-written formulas.
4. **Column ids only for `x`, `by`, `order` in v1** (helper computed column for expressions)? Recommended yes: simpler flags, node counts and hints; relaxing later is schema-compatible.
