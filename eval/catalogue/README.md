# Rule catalogue

A catalogue of **kinds of real-world spreadsheet transformation** ("first 3 characters of a code", "running total", "split a cell
into rows", ...), each with synthetic Hebrew or English data, the output a person would have made, and a **reference rule** in our
rules language - or a statement of which capability the language lacks. It measures, per kind:

| Layer | Question | AI? |
|---|---|---|
| **language** | Can the rules language express it? The reference rule (formula text + rules structure) must parse, type-check (`RulesSchema`, `checkRules`, `typeCheck`, paid-tier limits) and reproduce the expected output exactly, on the example file and on the "next month" file. | no |
| **fast** | Does the free code engine (pair analysis + strict fast path, `learnFromExamples` with `ai: 'notAllowed'`) detect it from the example pair alone? Local = built and verified; partial = which columns; blocked. Unsolved columns are classified (`external`, `derived/dependsOn|bands|contains`, or a relation the strict path declined). | no |
| **hold-out** | What the fast engine built converts a second ("next month") file, with different data, exactly. | no |
| **ai** *(`--ai <model>`, see "AI measurement" below)* | Does the AI step learn it, and at what cost? | yes |

Nothing here changes engine behaviour, the rules schema, the prompt or any app code: it is measurement only. Without `--ai` no LLM is ever called.

## Run

```
pnpm --filter @formatai/eval exec tsx catalogue/run-catalogue.ts [options]

  --types <list>   comma-separated: full ids, a topic ("extraction") or a prefix ("dates.add-*"). Default: all.
  --seeds <list>   seeds (default 1,2). Every seed generates its own example pair AND its own "next month" pair.
  --list           print the catalogue and exit.
  --dump [dir]     also write every generated file and the rules (reference + learned) under dir (default catalogue/.cache).
  --out <dir>      where the reports go (default: this directory).
  --report-only    re-render the report from the existing results.json (no measuring).
  --ai <model>     the AI measurement (spends tokens): see "AI measurement" below.
```

Generated (git-ignored): `report.md` (the capability map, per-topic summary, prioritized language gaps, detection gaps),
`report.csv` (one row per type x seed), `results.json` (the full records), `.cache/` (`--dump`).
A partial run (`--types`) merges into the existing `results.json` by (type, seed), so the report always covers everything measured so far. Re-measuring the free layers never discards AI results already in the file.

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

## AI measurement (`--ai <model>`)

For every type the language can express and the free engine does not solve (the **needs-AI set**: today 53 of the 97 types), `--ai` runs the real
learn flow with the AI step allowed - the same `runLearn` the eval runner uses (`eval/lib/runner.ts`) - on the example pair, and checks what it learned
on the "next month" file. A type the free engine already solves is never sent to the AI, and the free layers' records are never touched.

```
pnpm --filter @formatai/eval exec tsx catalogue/run-catalogue.ts --ai <model> [--provider p] [--masking on|off] [--mode full|complete]
                                                                  [--no-escalation] [--seeds 1,2] [--types ...] [--chunk N/M] [--resume] [--plan] [--replace]
```

| Flag | Default | |
|---|---|---|
| `--ai <model>` | - | The first-try model id the provider understands (`haiku`, `claude-haiku-4-5-20251001` ...). `--ai fake` is always the fake provider. |
| `--provider` | `LLM_PROVIDER` from the environment / `.env` | `anthropic`, `openai`, `claude-cli`, `fake`. The run prints `REAL LLM CALLS` and the provider before the first call. |
| `--masking on\|off` | `on` | What the app does. |
| `--mode full\|complete` | `complete` | `complete` = the app's default path: the free engine first, then the AI step only on what it left (the local rules are a fixed part). `full` = the AI step learns everything. |
| `--no-escalation` | escalation on | Skip the escalation model (the first-try model and its repair rounds still run). |
| `--seeds` | `1,2` | One measurement per (type, seed): half the cost with `--seeds 1`. Use the same seeds in every session of one run. |
| `--types` | all | Narrow the types first; the chunk is taken from what is left. |
| `--chunk N/M` | whole set | The N-th of M parts of the needs-AI set. Deterministic: type `i` of the set (catalogue order) is in part `(i mod M) + 1`, so the parts are disjoint, cover the set, differ by at most one type, and each is a spread over the topics. |
| `--resume` | off | Skip every (type, seed) already in `results.json` for the same model / mode / masking / escalation setting. A measurement that **errored** (every call failed: rate limit, timeout) is not an answer and is redone. Without `--resume` the whole chunk is measured again. |
| `--plan` | off | Print the needs-AI set, the chunk and what would run or be skipped, and stop. No LLM call. |
| `--replace` | off | Overwrite AI results recorded under another model/mode/masking. Without it such a run refuses to start (it would destroy paid-for results): use `--out <dir>` instead to keep both. |

### The 3-chunk run

The free layers decide who needs the AI. They come from `results.json` (a (type, seed) it lacks is measured on the spot, for free). Refresh them once, look at
the plan, then run the three parts, in one session or over several. Each command is safe to repeat and to stop with Ctrl-C (it finishes the current
measurement, writes `results.json`, and says how to continue):

```
# once, free: refresh the free layers (results.json, report.md)
pnpm --filter @formatai/eval exec tsx catalogue/run-catalogue.ts

# no LLM: what a chunk would do
env -u ANTHROPIC_API_KEY pnpm --filter @formatai/eval exec tsx catalogue/run-catalogue.ts --ai haiku --provider claude-cli --no-escalation --plan --chunk 1/3

# the three parts (18 + 18 + 17 types; 36 + 36 + 34 measurements at 2 seeds)
env -u ANTHROPIC_API_KEY pnpm --filter @formatai/eval exec tsx catalogue/run-catalogue.ts --ai haiku --provider claude-cli --no-escalation --chunk 1/3 --resume
env -u ANTHROPIC_API_KEY pnpm --filter @formatai/eval exec tsx catalogue/run-catalogue.ts --ai haiku --provider claude-cli --no-escalation --chunk 2/3 --resume
env -u ANTHROPIC_API_KEY pnpm --filter @formatai/eval exec tsx catalogue/run-catalogue.ts --ai haiku --provider claude-cli --no-escalation --chunk 3/3 --resume
```

Every command merges into the same `results.json` (written after **every** measurement, atomically) and re-renders `report.md` / `report.csv` over everything
measured so far, so the report is usable after chunk 1. One measurement is 1 to 3 LLM calls (learn, one server repair round, one browser repair; one more
with escalation on). To compare another model or setting, give it its own directory (the free layers are re-measured there in about a minute):
`... --ai sonnet --out catalogue/out-sonnet`.

### What is recorded (`record.ai`) and what the report shows

One `AiRecord` per (type, seed): counts, codes and names only. Never a value of any file, never a function request's purpose or arguments, never an
explanation's text.

- `model`, `provider`, `mode`, `masking`, `noEscalation`: the configuration (what `--resume` compares, except the provider).
- `path`: `llm`, or `local` when the free engine answered first. `classification`: `verified`, `unsupported:<codes>`, `notVerified`, `failed`, `blocked:<reason>`.
- `verified`: the answer reproduces the example, has no unsupported column and (complete mode) keeps the fixed rules. `holdOut`: the answer converts the next month's file exactly.
- `llmCalls`, `tokensIn`, `tokensOut`, `tokensCached`, `costUsd`, `latencyMs` (sum of the calls'), `formulaErrors` (formula-text parse failures over every call), `callErrors`.
- `unsupported`: the reason codes of the columns the AI reported as unsupported. `functionRequests`: the NAMES of the functions it asked for (read from its answer, before the
  API's value filter; nothing else of the request). `explanation`: whether it explained an unsupported column (a boolean).
- `completion` (complete mode): columns the free engine fixed / left to the AI step. `error`: the measurement itself failed. `at`: when.

The report gains the **AI learns it** column in the capability map: `✓` verified + hold-out, `~` verified only (hold-out fails), `✗` otherwise (with the classification),
`not run` for a needs-AI type not measured yet, `—` where there is nothing for the AI to do. It also gains an **AI step** section: totals, a per-topic table (share learned,
average calls / tokens in / out / cached / latency, formula errors, top unsupported codes, function requests named), a per-type table, and the list of functions the AI asked for.
A type counts by its worst seed. When no record has an AI result, the report and the CSV are exactly the free-run ones.

A type the free engine got **wrong** (`overfit` / `unverified`) is in the needs-AI set, but the real flow takes the free engine's answer first and never reaches the AI:
its record has `path: local`, 0 calls, and shows as `✗ ... (free engine answered)`. That is the app's behaviour, measured as it is.

### Dry run (no LLM)

```
pnpm --filter @formatai/eval exec tsx catalogue/run-catalogue.ts --ai fake --types extraction.nth-word,cleanup.proper-case --masking off --mode full --out <a scratch dir>
```

`--ai fake` (or `--provider fake`) runs the whole pipeline against the fake provider, which answers every call with the type's *reference rule*: a type whose reference rule is
right comes out `✓`, with zero tokens. Always give a scratch `--out`, or the dry run's records land in the real `results.json`. The fake answers in real words (it knows nothing of
masking) and does not keep the free engine's fixed rules, so `--masking off --mode full` is the combination that shows verified results; in `complete` mode the reference answer
breaks the fixed-rules lock and the record says `notVerified`: the plumbing is exercised, nothing more.

## Records

`results.json` is `CatalogueRecord[]`, one per type x seed (`types.ts`):

```
{ type, topic, title, lang, seed, rowsIn, rowsOut,
  language: { expressible, capability?, missingDetail?, workaround?, valid?, problems?, reproduces?, mismatch? },
  fast:     { path: local|partial|blocked|notReady|error, status: solved|partial|overfit|unverified|none, verified, solvedColumns, totalColumns,
              unsolved: [{ header, cls: derived|related|external, hint, reason, relations }], blockedBy, fastReason, needsAiParts,
              holdOut: pass|fail|n/a, viaPartial?, how?, ms },
  ai?:      { model, provider, mode, masking, noEscalation, path, classification, verified, holdOut, llmCalls, tokensIn, tokensOut, tokensCached, costUsd, latencyMs,
              formulaErrors, callErrors, unsupported[], functionRequests[], explanation, completion?, error?, at } }      // --ai only
```

The AI measurement (`ai.ts`) calls `prepare(type, seed)` (`measure.ts`) to get the very same four files (`input`, `output`, `nextInput`, `nextOutput`), runs the real
learn flow on them, fills `record.ai`, writes `results.json` after every measurement and re-renders the report. The pure parts (the needs-AI set, chunks, `--resume`,
merging) are in `aiRecords.ts`, the command line in `args.ts`; `pnpm test` covers them with the fake provider (`test/catalogue-ai.test.ts`).

`fast.status`: **solved** = local path, verified on the example, and the learned rules convert the next file exactly. **overfit** = verified on
the example but wrong on the next file (the engine's verification is looser than the exact comparison). **unverified** = the local path built rules
that fail the engine's own verification. **partial** = some columns built. **none** = blocked, or nothing built. A *partial* result with no column and no
layout part left for the AI step (the partial builder made the `expand` itself) is judged like a local one (`viaPartial`).
