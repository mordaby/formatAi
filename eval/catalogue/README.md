# Rule catalogue

A catalogue of **kinds of real-world spreadsheet transformation** ("first 3 characters of a code", "running total", "split a cell
into rows", ...), each with synthetic Hebrew or English data, the output a person would have made, and a **reference rule** in our
rules language - or a statement of which capability the language lacks. It measures, per kind:

| Layer | Question | AI? |
|---|---|---|
| **language** | Can the rules language express it? The reference rule (formula text + rules structure) must parse, type-check (`RulesSchema`, `checkRules`, `typeCheck`, paid-tier limits) and reproduce the expected output exactly, on the example file and on the "next month" file. | no |
| **fast** | Does the free code engine (pair analysis + strict fast path, `learnFromExamples` with `ai: 'notAllowed'`) detect it from the example pair alone? Local = built and verified; partial = which columns; blocked. Unsolved columns are classified (`external`, `derived/dependsOn|bands|contains`, or a relation the strict path declined). | no |
| **hold-out** | What the fast engine built converts a second ("next month") file, with different data, exactly. | no |
| **ai** *(later phase)* | Does the AI step learn it, and at what cost? | yes |

Nothing here changes engine behaviour, the rules schema, the prompt or any app code: it is measurement only.

## Run

```
pnpm --filter @formatai/eval exec tsx catalogue/run-catalogue.ts [options]

  --types <list>   comma-separated: full ids, a topic ("extraction") or a prefix ("dates.add-*"). Default: all.
  --seeds <list>   seeds (default 1,2). Every seed generates its own example pair AND its own "next month" pair.
  --list           print the catalogue and exit.
  --dump [dir]     also write every generated file and the rules (reference + learned) under dir (default catalogue/.cache).
  --out <dir>      where the reports go (default: this directory).
  --report-only    re-render the report from the existing results.json (no measuring).
  --ai <model>     reserved for the AI phase; refuses to run today.
```

Generated (git-ignored): `report.md` (the capability map, per-topic summary, prioritized language gaps, detection gaps),
`report.csv` (one row per type x seed), `results.json` (the full records), `.cache/` (`--dump`).
A partial run (`--types`) merges into the existing `results.json` by (type, seed), so the report always covers everything measured so far.

`pnpm test` (in `eval/`) runs `test/catalogue.test.ts`: the catalogue's integrity and the language layer for every expressible type.

## Anatomy of a type

Types live in `topics/<topic>.ts` (one `defineType({...})` each, listed in that file's export; `topics.ts` assembles and validates them).

```ts
const leftN = defineType({
  id: 'extraction.left-n',                 // <topic>.<kebab-name>, unique; what --types takes
  topic: 'extraction',
  title: 'First N characters',
  description: 'The first 3 characters of an item code become a category code.',
  lang: 'en',                              // data, headers and sheet direction: 'he' (RTL) or 'en'
  input: [                                 // input columns, in file order (id = what formulas call it)
    { id: 'code', header: 'Item code', type: 'text' },
    { id: 'price', header: 'Price', type: 'decimal', format: '#,##0.00' },
  ],
  generate: (g) => rowsOf(g, (i) => ({     // seeded; g.rng, g.n (20-40 rows), g.lang, g.variant ('example' | 'next')
    code: `ELC${1000 + i * 13 + randInt(g.rng, 0, 12)}`,
    price: randMoney(g.rng, 5, 900),
  })),
  outputs: [                               // output columns, in file order
    { header: 'Item code', from: 'code' },
    { header: 'Category', formula: 'substr(code, 1, 3)',                 // the reference rule's expression
      value: (r) => String(r.code).slice(0, 3) },                        // the ORACLE: plain TypeScript, independent of the engine
  ],
  rule: {},                                // the reference rule's non-derivable part (see below); null = not expressible
});
```

- **The oracle is the truth.** `value` (and `reshape`, `finalize`, `table`) compute the expected output in plain TypeScript, the way a
  person making the example by hand would. The reference rule is then *checked against it*: a rule that parses but means something else fails
  the language layer. Never derive the expected output from the rule.
- **`rule`** holds what is not derived from `input` and `outputs`: `{ input: { rowFilters }, transform: { dedupe, expand, valueMaps, tables,
  sort, group, functions }, output: { titleRows, summaryRows }, validations }`. Expressions are formula text, exactly as the AI step writes them.
  Input columns, computed columns (from `outputs[].formula`) and output columns are assembled by `kit.ts` (`assembleWire`).
- **`rule: null`** says the language cannot express the type, and `missing` says why: `{ capability, detail, workaround? }`.
  `capability` is an id from `capabilities.ts` (each has the gap and a sketch of what would unlock it; the report groups the gaps by it and
  counts the types each would unlock). `workaround` documents a partial way for a restricted form, when there is one. Types that cannot
  be expressed still get an output (from the oracle), so the fast layer is measured on them too.
- **Across rows** (running total, group total, rank, previous row ...): use the window functions in the formula (`runningSum(amount, by: acct, order: date)`, `groupSum(amount, by: dept)`, `rank(order: sales desc)`); the oracle computes them in plain TypeScript over the rows the output sees, in file order unless the rule says `order:`.
- **Row operations** (filter, dedupe, split, unpivot, group, sort): `reshape(rows)` turns the input rows into the rows the output columns see
  (it must mirror what the rule does); `finalize(out, rows)` adds summary rows; `table(rows)` replaces the column model when the headers come
  from the data (a pivot); `titles(rows)` writes title lines above the header.
- **Trap values.** A rule that generalizes (an else-branch, a threshold) should meet a value the example never showed:
  `pickOrUnseen(g, pool, unseen)` mixes `unseen` into the "next" file only. Open-ended text (names, free text) beats a closed pool of 5 values,
  which a value map would memorize. Include a key column when real files would have one; leave it out when they would not.
- **Keep the claim honest.** "Not expressible" means no rule covers the type *as described, including its stated bounds*. Try to write the
  rule before giving up; if only a bounded form works, add the bounded form as its own type and keep the open one as the gap
  (`extraction.after-first-sep-bounded` / `extraction.after-first-sep-rest`).

### Adding a type

1. Pick the topic file in `topics/` (or add a topic to `TOPICS` in `types.ts` and a file + entry in `topics.ts`).
2. Write the `defineType({...})` as above and add it to the file's exported array.
3. `pnpm --filter @formatai/eval exec tsx catalogue/run-catalogue.ts --types <your.id> --dump` and look at `.cache/<id>/seed1/`: `input.xlsx`,
   `output.xlsx`, `next.*`, `reference.rules.json`, `learned.rules.json` (what the fast engine built).
4. A type whose reference rule is `LANGUAGE BROKEN` in the report has a bug in the oracle or the rule; fix it before trusting anything else about it.
5. `pnpm --filter @formatai/eval test` must stay green.

### Using it as the regression suite for a new function

When the language gains an operation, take the types listed under its capability in `report.md`: replace `rule: null` + `missing` by a rule
(the oracle already exists), run the language layer, and the type moves from gap to expressible; nothing else changes. Add types for
the new function's own edge cases the same way. A new capability is an entry in `capabilities.ts`.

## Records (the AI phase adds a column, not a format)

`results.json` is `CatalogueRecord[]`, one per type x seed (`types.ts`):

```
{ type, topic, title, lang, seed, rowsIn, rowsOut,
  language: { expressible, capability?, missingDetail?, workaround?, valid?, problems?, reproduces?, mismatch? },
  fast:     { path: local|partial|blocked|notReady|error, status: solved|partial|overfit|unverified|none, verified, solvedColumns, totalColumns,
              unsolved: [{ header, cls: derived|related|external, hint, reason, relations }], blockedBy, fastReason, needsAiParts,
              holdOut: pass|fail|n/a, viaPartial?, how?, ms },
  ai?:      { model, path, verified, holdOut, llmCalls, tokensIn, tokensOut, costUsd, latencyMs, error? } }      // reserved
```

The AI phase calls `prepare(type, seed)` (`measure.ts`) to get the very same four files (`input`, `output`, `nextInput`, `nextOutput`), runs its own
learn on them, fills `record.ai`, writes `results.json` and re-renders with `--report-only`. `report.ts` and the CSV already have the AI columns.

`fast.status`: **solved** = local path, verified on the example, and the learned rules convert the next file exactly. **overfit** = verified on
the example but wrong on the next file (the engine's verification is looser than the exact comparison). **unverified** = the local path built rules
that fail the engine's own verification. **partial** = some columns built. **none** = blocked, or nothing built. A *partial* result with no column and no
layout part left for the AI step (the partial builder made the `expand` itself) is judged like a local one (`viaPartial`).
