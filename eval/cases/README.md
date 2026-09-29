# Eval cases (SPEC 10)

17 synthetic cases spread across domains (customer lists, supplier price
lists, bank exports, freight invoices, payroll, sales orders, insurance
commissions, purchase orders, warehouse stock, a product catalog, budgets,
expense claims, sales transactions), mixing Hebrew RTL and English LTR, so the
learn prompt doesn't overfit one domain or language. Built deterministically by
`build.ts`; nothing here is hand-copied from a live run.

## Layout

Each `eval/cases/<name>/` holds:

- `input.xlsx|csv|txt` - the source file a user received.
- `output.xlsx|csv|txt` - the "hand-made" example output for that input.
- `next.input.*` + `next.output.*` - a **hold-out pair**: same columns and
  layout as `input`/`output`, but different rows and values (new names,
  amounts, dates, and - where a rule depends on it - at least one value the
  first example never showed). Present only for cases that expect to verify.
  The runner (built later) checks that the rules *learned from* `input`/
  `output` also convert `next.input` into exactly `next.output` - the real
  test of "would this still be right on next month's file" (LEARN_PROMPT.md
  system prompt).
- `reference.rules.json` - a hand-authored, schema-valid rules file (SPEC 8)
  for the cases where one exists at all (see below). `output.*`/`next.output.*`
  for these cases were produced by running the real engine
  (`convertFile`, `packages/engine/src/convert.ts`) with this file, not
  hand-simulated - see "How outputs were produced" below.
- `meta.json` - `{ difficulty, domain, features[], expect, attachTo? }` (field
  reference below).

Two cases have no `reference.rules.json` and no `next.*` pair: their expected
output is something the rules language cannot produce at all (a pivot; a
column from a source outside the input), so it was built by hand exactly as a
person would, and there is no "learned rules" to hold out against.

## meta.json fields

| Field | Meaning |
|---|---|
| `difficulty` | `"easy"` \| `"medium"` \| `"hard"` - a rough hint for the report's difficulty breakdown (SPEC 10), not a guarantee of which engine path (fast/LLM) handles it. |
| `domain` | Short camelCase tag (e.g. `"freightInvoices"`) so the report can break results down by domain (SPEC 10). |
| `features` | Tags for the traps/operations this case exercises (e.g. `"leadingZerosLost"`, `"ddmmVsMmdd"`, `"pivot"`), used to group failures by feature (SPEC 10's report). |
| `expect` | `"verified"` \| `"unsupported:<code>"` \| `"blocked:<reason>"`, or (one case only) `{ masking_on, masking_off }` - see below. Codes match the enums in `packages/shared/src/codes.ts`: `UNSUPPORTED_REASON_CODES` for `unsupported:*`, `PREFLIGHT_BLOCK_REASONS` for `blocked:*`. |
| `attachTo` | Only for the registry cases: the case name whose output defines the shared format (SPEC 8.12). |

### The masking-gap case (`payroll-pension-deposits`)

SPEC 7.2: masking can hide a relation that lives *inside* a word (here, a
"branch code" built from the first two digits of a masked employee id) even
though pair analysis catches the common whole-word relations (prefixes,
suffixes, padding, concatenation) on the real, unmasked data regardless of the
masking switch. To let the eval report the accuracy gap SPEC 10 asks for
("the eval harness measures the accuracy gap between the two masking modes"),
this one case's `expect` is an object instead of a plain string:

```json
"expect": { "masking_on": "unsupported:hiddenByMasking", "masking_off": "verified" }
```

The input/output pair itself is a single, ordinary example (a real user
wouldn't know or care about masking when making it) - only the *expected
classification* differs by mode. The runner should learn this case twice (once
per masking mode) and compare each run's result against the matching key.

## How outputs were produced

For every case that has a `reference.rules.json`, `build.ts` builds `input.*`
first, then calls `convertFile(referenceRules, input.*)` to get `output.*`
- and again on a freshly generated `next.input.*` to get `next.output.*`. The
"hand-made" file is therefore exactly what the real pipeline (SPEC 8.2)
produces from that rules file, byte for byte - not an approximation - while
the rules file itself is the part a human actually wrote by hand.

For `sales-pivot-blocked` (a pivot, which pre-flight must block - SPEC 6.3)
and `fulfillment-external-column` (a column from a system the input never
mentions - SPEC 8.10 `externalData`), no rules file can produce the example
output at all, so both `input.*` and `output.*` are built directly with
`lib/fixtures.ts`, the way a person would have made them by hand.

## Cases

| # | name | difficulty | domain | expect |
|---|---|---|---|---|
| 1 | `crm-rename-reorder` | easy | customerList | verified |
| 2 | `supplier-pricelist-erp-load` | easy | supplierPriceList | verified |
| 3 | `bank-export-reconciliation` | medium | bankExport | verified |
| 4 | `freight-invoices-cost-report` | medium | freightInvoices | verified |
| 5 | `payroll-pension-deposits` | medium | payroll | masking_on/off pair (see above) |
| 6 | `orders-dedupe` | medium | salesOrders | verified |
| 7 | `insurer-commission-control` | hard | insuranceCommissions | verified |
| 8 | `purchase-orders-supplier-summary` | hard | purchaseOrders | verified |
| 9 | `stock-count-warehouse-report` | hard | warehouseStock | verified |
| 10 | `catalog-rtl-mixed` | hard | productCatalog | verified |
| 11 | `budget-columns-to-rows` | medium | budget | verified |
| 12 | `expense-split-cell` | medium | expenseClaims | verified |
| 13 | `sales-pivot-blocked` | hard | salesTransactions | blocked:pivotDetected |
| 14 | `fulfillment-external-column` | medium | purchaseOrders | unsupported:externalData |
| 15 | `registry-supplier-a` | medium | supplierPriceList | verified (registry base) |
| 16 | `registry-supplier-b` | medium | supplierPriceList | verified (attachTo a) |
| 17 | `registry-supplier-c` | medium | supplierPriceList | verified (attachTo a) |

Cases 15-17 are three different suppliers' price lists (different headers,
column orders and number-format quirks - Hebrew, English and Hebrew again)
learned against the same `output` (SPEC 8.12's "format lock"): identical
output columns/format/widths/direction/language/validations across all three,
differing only in `columns[].from` and the input side. `verify-cases.ts`
checks this with `checkFormatLock`.

Output-file variety (SPEC 10's "csv and tab-delimited txt, with and without a
header, UTF-8 and Windows-1255") is folded into the cases above rather than
given its own case: case 1 is csv/header/utf8 (no BOM), case 2 is
txt/no-header/windows1255, case 6 is csv/header/utf8bom (the default). csv,
txt, both header settings and both encodings are all covered.

## Traps, by case

| Trap | Case(s) |
|---|---|
| Leading zeros lost | 2, 9, 15, 17 |
| DD/MM vs MM/DD ambiguity | 3 |
| Numbers stored as text (thousand separators, currency symbols, parentheses) | 3, 4, 16, 17 |
| Prefix-of-ID (masking trap) | 5 |
| Pivot (must block) | 13 |
| Column from another source (must be unsupported) | 14 |
| New value the example never showed, that a filter must still keep (`next.*`) | 4 (`status = "OnHold"`) |

## Rebuilding

```sh
pnpm --filter @formatai/eval exec tsx cases/build.ts     # regenerate every case
pnpm --filter @formatai/eval exec tsx cases/verify-cases.ts   # sanity-check the result
```

Both scripts are deterministic (seeded PRNG, `lib/prng.ts`): re-running
`build.ts` with no code changes reproduces byte-identical files, so a diff
after rebuilding means something about a case actually changed.
