# Engine stress test

A generated stress test of the FREE engine (owner, 2026-10-06: "make sure the engine is robust"). It throws many random, messy,
realistic example pairs at the pair analysis, the fast path and the local partial result, and checks invariants on each. No AI
step and no network: the learn runs with `ai: 'notAllowed'` and a `callLearn` that throws.

Code: `eval/stress/` - `gen.ts` (one case from a seed), `data.ts` (columns and values), `files.ts` (xlsx / csv / txt writers),
`check.ts` (the invariants), `open.ts` (the open findings), `run-stress.ts` (the CLI). Tests: `eval/test/stressSeeds.test.ts`.

## Running it

```
pnpm --filter ./eval stress --n 500 --seed 1            # mixed sizes: 2 to 20,000 rows, 2 to 40 columns
pnpm --filter ./eval stress --n 200 --profile small     # small files only (2-120 rows, 2-12 columns): about 15 s
pnpm --filter ./eval stress --n 4 --profile timing      # 20,000 rows x 20 columns, timed
pnpm --filter ./eval stress --only 17,42                # re-run some seeds (with the same --profile)
```

Flags: `--quiet` prints only the failing seeds and the summary; `--no-mask` skips the masking check; `--dump-findings` also writes
the repro of a seed with findings only; `--out <dir>` (default `eval/reports/stress/`, not committed). Each failing seed gets a folder
`seed-N/` with the four files, the reference rules, the learned rules, `failure.json` and a readable `preview.txt`; the run writes
`summary.md` and `summary.json`.

Keep each command short: a 100-seed `mixed` chunk takes 1-2 minutes, a `timing` case 20-60 s (most of it generating the files).
Run 500 seeds as five chunks (`--seed 1`, `101`, ...).

The eval tests run a fixed set: the first 30 seeds of the small profile and the 18 seeds that found the bugs fixed so far, about
8 s (`pnpm --filter ./eval test`).

## What a case is

From a seed: a language (Hebrew, English, mixed), columns of 18 kinds (names, companies, cities, categories, free and long text,
text and numeric IDs, Israeli IDs as text or numbers that lost their leading zero, codes, phones, emails, multi-value cells, cells
that start like a formula, integers, decimals, money with currency signs and grouping, real dates, text dates in five formats, bare
serials), mess (empties, stray and non-breaking spaces, direction marks, emoji, other scripts, injected `= + - @` cells), a layout
(xlsx / csv / txt, encodings and delimiters, title rows, a totals row, duplicate rows), and reference rules built from the rules
language's real operations (copy, rename, template, concat, substr, split, case changes, padLeft, value maps, bands, number and
date formats, date parts, arithmetic, group totals, filters, sort, dedupe, title and summary rows, groups, csv / txt output with or
without a header). The example output and a hold-out pair ("next month": fresh rows, the same rules) are made by the real
`convertFile`. The reference conversion is the truth; the learn never sees the reference rules.

**Fair hold-outs.** Next month may bring values the example never showed, except where the example cannot say what the rule does
with them. The generator keeps, per column: a filter's values (and no number between the example's nearest values on each side of
a cut-off), each kind of stray character (direction mark, NBSP, a space at an end) only when the example shows that kind, value-map
keys the example shows, a column empty on every example row empty, and an Israeli ID column whose example has only 9-digit IDs
without a short one. Row parts the example does not show (a sort the input is already in, a filter that drops nothing, a dedupe
that removes nothing) are taken out of the reference rules. No row is blank in every column (it splits the table in two).

## The invariants (check.ts)

1. **Analysis and the free learn never throw.** They end in `local`, `partial`, `blocked` (with a block or warning stated) or
   `notReady` (with a readiness issue).
2. **No silent wrong values.** Every data row of the file is read. What the free engine reports as verified reproduces the example
   exactly (every row kind and cell; csv / txt compared as the text the file shows), and the columns it built are right on the
   hold-out or the row is flagged. A column the engine's own verification already reports wrong, a column it asks about (the
   example fits two rules: `ambiguousColumns`) and a result whose rules state an assumption are findings, not failures.
3. **Unsolved columns are reported, never guessed.** A partial result's unsolved column is empty (`from: null`) and listed as
   needing the AI step.
4. **Masking.** With masking on, the AI payload (samples, dropped rows, hints, layout, column stats and shapes - every field that can
   hold cell text, only enum words skipped), the learning loop's next rows and a repair round's problems hold no checkable real word
   (4+ letters or digits) of a sensitive column, and no ID number of a column masked as an ID.
5. **No live formula in an output file.** No `<f>` in an xlsx; no csv / txt field that starts with `= + - @` unless it is a plain
   number. Checked on the reference outputs and on the learned outputs (example and hold-out).
6. **Time.** Learn and convert within 10 s on a file of 15,000 rows and 15 columns or more.

**Findings** (counted, not failures): `localNotVerified` (the fast path's rules do not verify: reported to the user),
`partialMismatchReported` (a built column the verification reports wrong), `holdoutAssumed` (wrong next month under a stated
assumption), `holdoutAsked` (wrong next month in a column the engine asks about), `idNumberSentReal` (a generated ID column -
customer or order numbers, Israeli IDs - with no identifier word in its name and no identifier shape in its values: the column
classification makes it a measure, sent real - `classify.ts`, the documented limit the AI classification is for; an identifier column
sent real is a failure), `fakeEqualsReal` (a fake that happens to equal another row's real
value: the masker checks fakes only against the words it has seen), `csvLeadingControl`, `payloadNotBuilt`.

## Results (2026-10-06, branch engine-stress)

| Run | Cases | New failures | Open findings reproduced | Learn p50 / p95 / max | Convert p50 / p95 / max |
|---|---|---|---|---|---|
| mixed, seeds 1-500 | 500 (2-19,960 rows, 2-40 columns; 102 of 1,000+ rows) | 0 | O1 on 14, O3 on 1 | 35 / 764 / 7,041 ms | 11 / 231 / 3,293 ms |
| small, seeds 1-500 | 500 | 0 | O1 on 10, O2 on 1 | 10 / 39 / 74 ms | 7 / 24 / 56 ms |
| timing, seeds 1-10 | 10 (20,000-22,059 rows x 20) | 0 | O4 on 2, O1 on 1 | 7.2 / 14.3 / 14.3 s | 3.5 / 12.6 / 12.6 s |

Paths (mixed): partial 286, blocked 103, local 111; no generator error. Findings (mixed): idNumberSentReal 26, partialMismatchReported
25, fakeEqualsReal 20, localNotVerified 7, holdoutAssumed 5.

Timing, 20,000 x 20: csv / txt input learns in 1.8-6.1 s and converts in 0.4-3.5 s; xlsx input learns in 7.5-14.3 s (reading the
two workbooks is about 9 s of it) and converts in 4.7-12.6 s with xlsx in and out (O4). Times vary with the machine's load.

## Results (2026-10-06, branch column-classification)

The column classification (SPEC 21, its amendment) and every script masked. The same seeds as above:

| Run | Cases | New failures | Open findings reproduced | Learn p50 / p95 / max | Convert p50 / p95 / max |
|---|---|---|---|---|---|
| mixed, seeds 1-500 (five chunks of 100) | 500 (2-19,960 rows, 2-40 columns; 102 of 1,000+ rows) | 0 | O3 on 1 | 33 / 758 / 6,676 ms | 10 / 253 / 4,102 ms |
| small, seeds 1-500 | 500 | 0 | O2 on 1 | 12 / 43 / 97 ms | 7 / 29 / 53 ms |

O1 is gone (it was on 14 mixed and 10 small cases). Paths (mixed) are unchanged: partial 286, blocked 103, local 111. Findings
(mixed): partialMismatchReported 29, fakeEqualsReal 20, idNumberSentReal 17 (was 26), localNotVerified 7, holdoutAssumed 5. Every
`idNumberSentReal` is now an "Order No" / "מספר הזמנה" column - no identifier word in the name, so a measure, sent real (the documented
limit); "Customer No" / "מספר לקוח" and the Israeli ID columns are identifiers by their names and masked.

## Open findings

Design questions the run reproduces, not fixed in passing (`open.ts`; the summary lists them apart from new failures).

- **O2 - csv / txt: a plain negative number held as text in a text column** (small 231). The formula guard prefixes text that
  starts with `-` with an apostrophe unless the column is numeric (SPEC 15), so rules that build "-1192964702.4" as a text constant
  write "'-1192964702.4" where the example shows the number; the verification compares values and passes. Question: exempt a plain
  number from the guard in every column (it cannot be a formula), or type such a constant as a number.
- **O3 - the window search in wide files** (mixed 69). The across-row search tries the first 10 numeric columns (`MAX_X`); a group
  total of a later column is not found, and a value map from the group column to last month's totals explains the example (each
  group repeats). Next month every total is wrong, unflagged. Question: the caps of the window search, or no value map onto
  numbers when the search was capped.
- **O4 - time on 20,000 x 20 with an xlsx input** (timing 4, 7, 8, 9). Over 10 s on 2 of 10 runs: reading a 20,000-row workbook
  is about 4 s (SheetJS about 2.5 s, then the ExcelJS overlay for bold, direction and hidden rows about 2 s), and the learn reads
  two. Question: a lighter overlay (only the parts it reads), or a larger budget for xlsx.
- **O5 - an Israeli ID that lost its leading zero, when the example has none** (small 184, 275 before the fair hold-out). Copied
  as it is ("85827186") and not flagged: the checksum check pads it. The example cannot show the padding, so the generator no
  longer makes such hold-outs. Question: pad an Israeli ID column by what it is, or flag a length the example never showed.

## Fixed (each with a unit test; the seed is in the fixed set)

| Commit | Fix | Seed |
|---|---|---|
| CSV/TXT formula guard | text in a numeric column is guarded too (only a plain number is exempt) | small 23 |
| Typed copy | a copy writes the kind of value the example output holds (numbers / text) | small 28, 36, 40, 53 |
| Delimited dates | a date in a csv / txt example is compared by the text it is written as | small 15, 37, 75, 88 |
| Date text copy | date text copied as it is keeps the example's text form | small 88 |
| Constant guard (d) | fixed text around a value the input holds on every row is a template as likely as a constant | small 50, 54, 135, 137 |
| padLeft evidence | padding with a character other than "0" needs pads of different lengths | small profile |
| Value map, two values | the repeats must confirm at least two of the values a map writes | small 9 |
| One-column output | its first text cell is the header | small 60 |
| Masking a copied ID | a copy of an ID column is masked as an ID whatever its profile type | small 60 |
| Unexplained order | rows in an order no sort explains are a "sort" part, not "verified" | small 102 |
| Substr on text dates | only whole parts of a date written as text | small 300 |
| Header check | the header reading's header row decides, not row 0 | small 220 |
| normalizeCase speed | rows skipped on cached normalized texts (a 15,000-row learn 15 s -> 7 s) | mixed 134 |
| Lazy repair problems | only the 10 kept repair problems are built and masked (32 s -> 0.8 s) | mixed 134 |
| Value map, duplicates | an exact duplicate row confirms nothing | mixed 153 |
| Every script masked (O1; column classification) | Arabic and Cyrillic get same-script fakes; a letter of any other script is never sent real | small 10, 23, 73; mixed 5, 68 |
| Script-agnostic shape (engine audit) | a column's `shape` holds shape letters, `D` and separators only; the mask check reads every field that can hold cell text | small 23, 128 |

Harness fixes on the way (no engine change): a column the engine asks about is reported; digits as text in a column masked as a
number are the `idNumberSentReal` finding; a fake that equals another real value is `fakeEqualsReal`; and the fair hold-out rules
above (seeds small 125, 184, 193, 235, 275, 357 mixed, 458, 476, 500).

The free engine's result on the 38 eval cases (path, solved columns, verified, parts left to the AI step, columns asked about) is
the same before and after these fixes.

## Triage

A new failure is one of three things. A real engine bug, contained and clear: fix it with a focused unit test, in its own commit,
and add the seed to `REGRESSIONS` in `eval/test/stressSeeds.test.ts`. A generator bug or an unfair hold-out (the example cannot
show the rule): fix the generator. A design question or a big change: record it in `open.ts` and here, with its seeds.
