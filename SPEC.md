# SPEC: Format Learner (working name)

> Build spec for Claude Code. Read this whole file, and `LEARN_PROMPT.md`, before writing any code.
>
> - Build one milestone at a time (section 19).
> - After each milestone, stop and report what was built, what was skipped, and any decision you had to make.
> - Items marked **DECISION** are listed in section 20. They are not settled: use the default given there and leave a `// DECISION:` comment in the code.
> - The exact LLM prompt lives in `LEARN_PROMPT.md`. Keep that file and this spec in sync.

## 1. What we're building

A web tool that learns an Excel report format from one example and then converts new files into that format. Conversion is deterministic and uses no AI at run time.

1. The user provides an example input file and the output file they make from it by hand.
2. Code on the user's computer analyzes both files.
3. An LLM receives a small, masked summary once and writes a **rules file** (JSON). Simple cases are solved by code alone, with no LLM at all.
4. From then on, a deterministic engine applies those rules to any number of new files.

**Audience:** non-technical office staff who spend much of their day converting, reformatting and checking Excel reports. The first focus is commission control in Israeli insurance agencies and pension-operations firms.

**Business model:** the public tool is self-serve (anonymous → registered → paid) and doubles as a demand test. A separate business page explains the value to companies.

## 2. Non-negotiables

1. **Determinism.** The same rules and the same input file always produce the same output file. The engine uses no LLM, no randomness, and nothing that depends on the current time or on locale.
2. **Data stays in the browser.**
   - Files are parsed, analyzed, converted and verified in the user's browser, in a Web Worker.
   - The API has no endpoint that accepts files and rejects bodies over 256 KB.
   - The only things sent are a column profile, a small sample (masked by default) and relations computed locally.
3. **The LLM writes rules, never data.** It returns a rules file in a closed, schema-validated language. It cannot run code, and every rule is checked by code and verified against the example.
4. **Honest failure over wrong output.** A partial, correct rules file beats a complete, wrong one. Anything that can't be expressed is reported as `unsupported`. Uncertain rows are flagged, and the human decides.
5. **Code before tokens.** Anything code can detect or solve is done before the LLM step:
   - unsupported cases are blocked;
   - simple cases are solved locally;
   - relations are handed to the LLM as facts instead of being left for it to discover.
6. **Spend is controlled on the server.** LLM usage is limited server-side. Free limits such as rows, preview size and batch size are enforced in the client, and it's acceptable if they can be bypassed.
7. **Hebrew and English, right-to-left and left-to-right, from day one.** This applies to the UI, the previews and the Excel files the tool reads and writes.
8. **All limits, prices, model choices and prompt versions live in config**, never in code.

## 3. Scope

**In the MVP:**
- Single-sheet Excel/CSV tables.
- Learning from an example pair (two files).
- Pair analysis, pre-flight checks and a local fast path.
- Removing or flagging duplicate rows.
- One input row becoming several output rows: columns to rows, splitting a cell, and fixed fan-out.
- A masking switch.
- A rules map with an editor, where users fix or add rules and see a live count of matching rows.
- A preview with a diff against the example, and flagged rows.
- Google and Microsoft sign-in.
- Saved formats, re-running a format, and batch conversion.
- Tier limits.
- Usage events and an admin dashboard.
- A business page with a lead form, plus privacy and terms pages, all in Hebrew and English.
- A model evaluation harness.

**Next, after the MVP:**
- Learning from an input file plus a text description, and from a description alone.
- A side-by-side, merge-style view for resolving flags.

**Out for now** (design so these can be added later):
- PDF, PowerPoint or Word input.
- Multi-table sheets and multi-row headers.
- Pivots (rows becoming columns), and row expansion that fits none of the three patterns.
- Joining two input files, and file comparison/reconciliation.
- Email intake.
- Storing user data files.
- Payments (the "Upgrade" button only records intent).
- Team accounts.
- Editing rules by chatting with the LLM.

## 4. Architecture

A TypeScript monorepo (pnpm workspaces). The engine is one package that runs unchanged in the browser and in Node. That is the main reason for choosing Node over Flask.

```
repo/
  packages/
    engine/        pure TS: parse → detect table → profile → pair analysis → mask/unmask
                   → apply rules → validate → diff → write
                   no DOM and no Node-only APIs; used by web (Web Worker), api and eval
    shared/        rules schema (zod) + generated JSON Schema, config (tiers, models, prices),
                   prompts/ (loaded from LEARN_PROMPT.md content), event types, API types, i18n keys
  apps/
    web/           React + Vite + TS, i18n (he/en), RTL/LTR
    api/           Node + TS (Fastify), MongoDB, LLM provider, OpenID Connect sign-in
  eval/
    cases/         example pairs used to compare models, prompts and masking modes
    run.ts         evaluation runner
```

Libraries:
- **Reading:** SheetJS (xlsx, xls, csv). Install it from the SheetJS CDN tarball as their docs describe. The `xlsx` package on the npm registry is years out of date and has known vulnerabilities.
- **Writing:** ExcelJS, for styles, number formats, widths, the right-to-left sheet view and merged title cells. Use ExcelJS when you need to read sheet-view settings (e.g. the RTL flag) from xlsx files.
- **Numbers:** decimal.js for all arithmetic. Never use floating point for amounts.
- **Schema:** zod, with a JSON Schema export for the LLM call.
- **Sign-in:** openid-client, one implementation serving both Google and Microsoft.
- **Other:** JSZip for batch downloads, MongoDB, and Cloudflare Turnstile.

Where each step runs:

| Step | Runs in | Sees real data? | Costs tokens? |
|---|---|---|---|
| Parse, table checks, profile, pair analysis, pre-flight | Browser (worker) | Yes | No |
| Local fast path (simple formats) | Browser | Yes | No |
| Masking and building the payload | Browser | Yes | No |
| Learn call, code checks, engine on the sample | API → LLM | Only if masking is off, and only the sample rows | Yes |
| Unmasking constants, full verification | Browser | Yes | No |
| Converting single files and batches | Browser | Yes | No |

## 5. Main flows

### A. Learn from two files (MVP)
1. The user drops an example input and an example output. The browser parses both and runs the table checks (6.1).
2. Pair analysis runs on all rows of the real data (6.2). Pre-flight either blocks, warns, or continues (6.3–6.4). A block costs nothing.
3. **Fast path** (6.5): if code alone explains every output column, the rules are built locally and the flow jumps to step 7.
4. The browser builds the payload, masked or not according to the switch (7). "See what we send" shows the exact payload.
5. `POST /api/learn`. The API:
   - checks limits and the cache;
   - makes **one stateless LLM call** (9): the system prompt plus one user message, with no chat history;
   - runs code checks and the engine on the sample;
   - if the result is still wrong, makes at most one repair call (config), which is also a single stateless message.
6. The browser unmasks constants in the returned rules (7.2), runs them on the full real input, and diffs the result against the full real output.
   - If everything matches, the format is **verified**.
   - If not, one browser-triggered repair call is allowed (it counts toward limits). If that still fails, show the mismatches and let the user fix them in the rules map.
7. Show the rules map with its editor (8.11), the preview and the flagged rows.
   - Anonymous users see 20 rows.
   - Downloading the full file or saving the format requires sign-in.

### B. Learn from a description (after the MVP)
There are two variants:
- **Input file plus description.** The output is confirmed by the user rather than verified.
- **Description only.** This produces a draft whose input columns are guesses. The guesses are mapped to real headers on the first run.

Keep this in mind in the schema (`meta.source`, `meta.status`), but don't build it yet.

### C. Run a saved format
The user opens My formats → Run on a file. The engine checks the file against the format's input signature:
- missing required columns stop the run with a clear message;
- extra columns are ignored;
- renamed columns are matched through aliases or offered to the user for mapping.

The result is a download plus flagged rows. No LLM call.

### D. Batch
Same as flow C with many files, processed one at a time in the worker. Each file gets a status: converted, converted with flags, or didn't match. The user downloads a zip plus a summary sheet of flags per file. No LLM call. The number of files is limited by tier.

### E. Sign-in wall
Shown when an anonymous user tries to download the full output, save a format, run another file, or goes over an anonymous limit.
- Copy: "Sign in to save this format and reuse it on next month's file."
- Buttons: **Continue with Google** first, then **Continue with Microsoft**.
- The learned rules survive sign-in, so nothing has to be redone.

## 6. Intake, pair analysis and pre-flight

Everything in this section runs in the browser, on the real data, and costs no tokens.

### 6.1 File checks
Accepted types: .xlsx, .xls, .csv. The maximum size depends on the tier. Formulas are read as their last calculated values, and macros are ignored.

`detectTable(sheet)` returns `{ ok, headerRow, dataStart, dataEnd, titleRows, footerRows, direction, issues[] }`:
- **Several non-empty sheets:** ask the user which one to use.
- **Header row:** search the first 15 rows for a row that is mostly non-empty text with distinct values, followed by at least 3 rows of consistently typed data. The user can override the choice.
- **Title and footer rows:** title rows above the header and footer rows below the data are excluded. A footer row starts with "סה\"כ" or "Total", or contains sums of the column above.
- **Direction:** take it from the sheet's right-to-left view flag. If the flag isn't available, infer it from the script of the headers (mostly Hebrew → rtl).
- **Rejections:** reject with a specific reason when:
  - no header row is found;
  - the sheet has two or more tables;
  - the header has merged cells or is split over two rows;
  - there are fewer than 2 data rows;
  - the sheet has only charts or images.

The example output is checked more loosely, because a report may contain title, spacer and subtotal rows. Those are classified in 6.2 rather than rejected.

### 6.2 Pair analysis
1. **Classify output rows** as title, header, data, blank, subtotal or grand total.
2. **Align rows.**
   - Find a key: an output column whose values match an input column one-to-one after normalization. If no single column works, try a key made of 2 columns.
   - Match every output data row to its input row. Several output rows can point to the same input row: together they form a **family** (see step 3).
   - Input rows with no match are **dropped rows**.
3. **Detect the output shape:**
   - **summary:** data rows = the distinct values of an input column, with sums next to them;
   - **pivot:** 3 or more output headers equal values of a single input column;
   - **families:** some input rows produced several output rows. Classify the pattern, tested on every family:
     - **columns to rows:** an output column's values are input headers (e.g. months), and another output column holds the matching input cell. The family size equals the number of non-empty cells in those input columns.
     - **split cell:** the family size equals the number of parts in one input text cell, split by a common separator (`;` `,` `/` `|` or a line break), and an output column holds the parts.
     - **fixed fan-out:** every family has the same size (2–5), and each position in the family follows its own pattern (e.g. position 1 = "חובה" with the amount, position 2 = "זכות" with the negative amount).
     - Families that fit none of these are **row expansion**, which isn't supported.
4. **Test relations** for every output data column, on every aligned row. Each relation gets a **coverage** (the share of rows where it holds):
   - text: `copy`, `normalize` (trim, case, quote marks and geresh), `padLeft`, `substr` (prefix, suffix, fixed position), `concat` (whole words from 2+ input columns with a separator), `valueMap` (a consistent correspondence with an input column, at most 50 distinct values), `constant`;
   - formats: `dateFormat` (from → to), `numberFormat`;
   - numbers: `mulConst`, `addConst`, `add`, `sub`, `mul` and `div` between two input columns, and `sum` of several columns, each with rounding detection;
   - summaries: `aggregate` (sum, count, min or max per group);
   - dropped rows: `filter` (an input column whose values separate kept rows from dropped rows: a set of values, emptiness, or a numeric threshold);
   - dropped rows: `dedupe` (the dropped rows are copies of kept rows, either on every column or on a key column; records whether the first or the last copy was kept);
   - anything else: `unknown`.
   Inside a family, each output row is tested against its source input row, together with the columns the family pattern creates (label, value, part).
5. **Detect layout:**
   - title rows (and whether they contain a date or month);
   - blank-row rules (e.g. one blank row after each change in a column);
   - subtotal rows and what they sum, and the grand total;
   - sort order;
   - number formats and output direction.

The result is `{ status: ok | warn | block, issues[], hints[], skipColumns[], layout }`.
- Relations with coverage 1.0 become hints.
- Relations with coverage of 0.9 or more are sent as partial hints, with their coverage and the sample indices where they fail. The sample selector makes sure at least one failing row is among the samples.

**Speed on large files:** test candidate relations on a random 2,000 aligned rows first, then confirm the survivors on all rows. The whole analysis runs in the worker, with a progress indicator.

### 6.3 Block before learning (no LLM call)
Pre-flight blocks the learn when any of these is true:
- a 6.1 rejection;
- row expansion that fits none of the three family patterns;
- pivot;
- no output column can be traced to the input at all;
- the two files are identical;
- the files are over the tier's limits.

Each block shows a specific message in the UI language and records `preflight { status: "block", reason }`.

### 6.4 Warn and continue
- **Some output columns are `unknown`.** Show them before learning: "These columns have values that don't appear in your input file. They probably come from another source, which isn't supported yet. We'll learn everything else and leave these empty." If the user continues, they are sent as `skipColumns`, so the LLM spends nothing on them.
- **Rows couldn't be aligned.** Show "We couldn't match rows between the two files. Are they from the same data?" with a **Try anyway** button. Trying anyway counts as a learn.

### 6.5 Local fast path
If every output column has a hint with coverage 1.0, any dropped rows are explained by a `filter` or `dedupe` hint, no rows expand, and the layout needs nothing beyond constant title rows, the rules are built from the hints in code. They are verified as usual and finished without the LLM.

This covers renames, reorders, dropped columns, reformatting, padding, value maps, simple calculations, filters and duplicate removal. Record `learn_completed { path: "local" }`. Fast-path learns don't count toward the learn limit, because they cost nothing.

## 7. Profile, sample and masking

### 7.1 Column profile
For each column the profile records:
- header, position and type (`text`, `integer`, `decimal`, `currency`, `percent`, `date`, `boolean`, `idLike`, `empty`);
- shape signature, using D = digit, A = Latin letter, H = Hebrew letter;
- empty rate and distinct ratio;
- min/max length and min/max value;
- `leadingZerosLost`;
- `key` (unique and non-empty);
- `israeliId` (9 digits with a valid check digit on at least 95% of rows, after padding).

### 7.2 The masking switch
The switch sits next to the drop zones. It is **on by default** for everyone, and a "What's the difference?" link opens a short panel.

**Masking on:**
- **What gets replaced:** every word in text and ID-like columns becomes a fake word of the same shape.
  - Words are split on spaces and punctuation, and the separators are kept.
  - A fake word has the same script and the same length, and digits stay digits.
  - The replacement uses a keyed HMAC. The key is random per browser session and never leaves the browser.
- **Consistency:** the same real word becomes the same fake word in both files and in title/label rows.
- **Label words:** words in title, subtotal and total labels that don't appear in any data cell (e.g. "דוח", "סה\"כ") are sent as they are.
- **ID numbers:** Israeli ID numbers are replaced with other valid ID numbers.
- **Sent real:** numbers, dates and headers. On their own they don't identify anyone, and calculations and date formats can't be learned without them.
- **Unmasking:** the browser keeps the fake→real map. When rules come back, every fake word inside a constant (value maps, filter values, labels) is turned back into the real word before the rules are shown, saved or run. The map is never sent, and saved rules contain only real words.

**Masking off:** the sample rows are sent as they are: up to 12 aligned pairs plus up to 5 dropped rows.

**In both modes:**
- The full files never leave the browser.
- Hints are always computed on the real data, locally.

**What masking on can miss:** relations inside a word are invisible in masked samples. Pair analysis finds the common ones on the real data (prefixes, suffixes, padding, whole-word concatenation) and sends them as hints. Anything else comes back as `hiddenByMasking`, and the UI suggests turning masking off or setting that column by hand. The eval harness measures the accuracy gap between the two modes (10).

**UI copy:**

| | English | עברית |
|---|---|---|
| On | Masking on: names, ID numbers and other text in the sample rows are replaced with look-alike values before anything leaves your computer. Numbers, dates and column names are sent as they are. | הסתרת נתונים פועלת: שמות, מספרי זהות וטקסט בשורות הדוגמה מוחלפים בערכים מדומים לפני שהם יוצאים מהמחשב שלך. מספרים, תאריכים ושמות העמודות נשלחים כפי שהם. |
| Off | Masking off: up to 12 sample rows are sent as they are. Learning is more accurate when a column is built from part of a text value, like the first digits of a policy number. | הסתרת נתונים כבויה: עד 12 שורות דוגמה נשלחות כפי שהן. הלמידה מדויקת יותר כשעמודה נבנית מחלק של ערך טקסט, למשל הספרות הראשונות של מספר פוליסה. |
| Always | Your full files never leave your computer. | הקבצים המלאים לעולם לא יוצאים מהמחשב שלך. |

### 7.3 What gets sent (the learn payload)
The full field list and an example are in `LEARN_PROMPT.md`. In short:
- the masking flag;
- both profiles;
- the input layout (rows to skip) and the output layout (6.2 step 5);
- up to 12 aligned sample pairs, chosen to cover the first rows, empty cells, extreme values and each kind of layout row. When rows expand, up to 6 whole **families** are sent instead (one input row with all its output rows), including the smallest and the largest;
- up to 5 dropped rows;
- hints;
- `skipColumns`.

Hard caps (config): 60 columns, 12 pairs, 5 dropped rows, 40 characters per cell, 48 KB per payload.

### 7.4 File size doesn't drive cost
The payload grows with the number of columns, not rows. A 1,000-row pair and a 100,000-row pair produce payloads of the same size.

A typical learn is:
- the fixed system prompt, which is cached after the first call and billed at a reduced rate;
- a few thousand tokens of payload;
- 1–2 thousand tokens of output.

Hebrew text uses more tokens per word than English, which is one more reason for the 40-character cell cap. Row count only affects how long the browser takes. The eval harness reports the real cost per learn.

## 8. Rules language (schema v1)

The rules language has a closed set of operations. The LLM returns the whole object except `name` and `meta`, which the app fills in. The name defaults to the example output's file name, and the user can rename it. Every rules file carries a `schemaVersion`, and the engine must keep supporting old versions for good, because saved formats live on.

### 8.1 Example

```json
{
  "schemaVersion": 1,
  "name": "עמלות חודשיות → דוח בקרה",
  "input": {
    "sheet": { "pick": "first" },
    "headerRow": "auto",
    "stopAt": { "when": "firstCellMatches", "values": ["סה\"כ", "Total"] },
    "columns": [
      { "id": "agent",     "header": "מספר סוכן",   "aliases": ["סוכן"], "type": "idLike", "required": true },
      { "id": "policy",    "header": "מס' פוליסה",  "type": "idLike", "padLeft": 9, "required": true },
      { "id": "insuredId", "header": "ת.ז. מבוטח",  "type": "idLike", "padLeft": 9 },
      { "id": "product",   "header": "מוצר",        "type": "text" },
      { "id": "status",    "header": "סטטוס",       "type": "text" },
      { "id": "premium",   "header": "פרמיה",       "type": "decimal", "required": true },
      { "id": "startDate", "header": "תאריך תחילה", "type": "date", "inputFormats": ["DD/MM/YYYY", "excelSerial"] }
    ],
    "rowFilters": [ { "column": "status", "op": "ne", "value": "מבוטל" } ]
  },
  "transform": {
    "dedupe": { "keys": ["policy"], "keep": "first", "action": "flag" },
    "computed": [
      { "id": "commission", "type": "decimal",
        "expr": { "op": "round", "digits": 2,
                  "arg": { "op": "mul", "args": [ { "col": "premium" }, { "const": 0.17 } ] } } }
    ],
    "valueMaps": [
      { "column": "product", "map": { "חיים": "LIFE", "בריאות": "HEALTH" }, "onMissing": "flag" }
    ],
    "sort": [ { "column": "agent", "dir": "asc" }, { "column": "startDate", "dir": "asc" } ],
    "group": {
      "by": "agent",
      "showDetailRows": true,
      "subtotal": { "labelColumn": "policy", "label": "סה\"כ לסוכן", "sum": ["premium", "commission"] },
      "blankRowsAfter": 1
    }
  },
  "output": {
    "sheetName": "דוח עמלות",
    "direction": "rtl",
    "language": "he",
    "titleRows": [
      { "parts": [ { "text": "דוח עמלות " }, { "agg": "max", "column": "startDate", "format": "MMMM YYYY" } ], "bold": true },
      { "blank": true }
    ],
    "columns": [
      { "header": "סוכן",        "from": "agent",      "width": 10 },
      { "header": "פוליסה",      "from": "policy",     "width": 12 },
      { "header": "מוצר",        "from": "product" },
      { "header": "תאריך תחילה", "from": "startDate",  "format": "DD/MM/YYYY" },
      { "header": "פרמיה",       "from": "premium",    "format": "#,##0.00" },
      { "header": "עמלה",        "from": "commission", "format": "#,##0.00" }
    ],
    "headerStyle": { "bold": true },
    "grandTotal": { "labelColumn": "policy", "label": "סה\"כ", "sum": ["premium", "commission"] }
  },
  "validations": [
    { "column": "insuredId", "rule": "israeliIdChecksum", "severity": "flag" },
    { "column": "premium",   "rule": "range", "min": 0,   "severity": "flag" }
  ],
  "unsupported": [],
  "assumptions": [ { "outputColumn": "עמלה", "reasonCode": "roundingGuessed" } ],
  "meta": { "source": "examplePair", "status": "verified", "model": "...", "promptVersion": "...", "masking": true, "createdAt": "..." }
}
```

### 8.2 Engine pipeline (fixed order)
1. **Read.** Pick the sheet, find the header row, and read data rows until `stopAt`. Map headers to ids: exact match first, then aliases, then a normalized match (trimmed, collapsed spaces, quote marks and geresh unified).
2. **Normalize types.**
   - Dates are parsed only from the listed formats.
   - Numbers can include thousand separators, ₪ and %, and negatives in parentheses or with a trailing minus.
   - idLike values stay text and are padded.
   - A value that fails to parse is kept as it is and flagged.
3. **Row filters.**
4. **Duplicates** (8.4).
5. **Expand** (8.5).
6. **Computed columns.** These run after expand, so calculations apply to each new row.
7. **Value maps.**
8. **Sort.** The sort is stable: ties keep the input order, so the rows of one family stay together unless the sort separates them.
9. **Group.** Detail rows, subtotals and spacing.
10. **Output layout.** Title rows, header, columns, grand total, direction and language.
11. **Validations** → flags.

The engine receives no clock. All arithmetic uses decimal.js. `round` rounds half away from zero, like Excel's ROUND.

### 8.3 Expressions and filters
Expressions are an AST that the engine interprets. There is no regex and no code in strings, ever.

- **Values:** `col`, `const`
- **Arithmetic:** `add`, `sub`, `mul`, `div` (dividing by zero raises a flag), `neg`, `abs`, `round{digits}`
- **Text:** `concat`, `substr{start,length}`, `trim`, `upper`, `lower`, `replaceText{find,with}` (literal text only), `padLeft{length,char}`
- **Dates:** `datePart{year|month|day}`, `dateFormat{format}`
- **Logic:** `if{cond,then,else}`, `coalesce`
- **Conditions:** `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `isEmpty`, `notEmpty`, `and`, `or`, `not`

Maximum nesting depth is 6. If the provider's structured output doesn't support recursive schemas, spell out expressions to a fixed depth in the schema and validate the rest in code.

**Row filters:** `{ column, op, value? }`, where op is one of `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `isEmpty`, `notEmpty`, `oneOf` or `notOneOf` (value is an array). Several filters are ANDed.

**Date format tokens:** `D`, `DD`, `M`, `MM`, `MMMM`, `YY`, `YYYY`. `MMMM` is the month name in `output.language`, e.g. ספטמבר or September.

### 8.4 Duplicates
`transform.dedupe: { keys: [ids] | "all", keep: "first" | "last", action: "remove" | "flag" }`

- **Where it comes from:** either the example (pair analysis found that the dropped rows are copies of kept rows) or the user, who adds it in the editor.
- **How rows are compared:** values are compared after type normalization: trimmed, padded, and with quote marks and geresh unified. There is no fuzzy matching.
- **`remove`:** the extra copies are left out. With `keep: "first"` the later copies go; with `keep: "last"`, the earlier ones. Every removed row is listed in the run summary with its row number, so nothing disappears silently.
- **`flag`:** all rows stay, and every extra copy is flagged, e.g. "duplicate of row 12". In commission control a duplicate is often the error itself (a commission paid twice), so the editor offers both actions.

### 8.5 Expand: one input row → several output rows
`transform.expand` has three modes:

- **Columns to rows:** `{ mode: "columnsToRows", columns: [ids], labelId, labels?, valueId, valueType, skipEmpty }`.
  - Example: Jan/Feb/Mar columns become three rows, each with a month label and an amount.
  - Labels default to the input headers.
  - The listed columns aren't available after this step.
- **Split cell:** `{ mode: "splitCell", column, separator, trim, partId, indexId?, countId?, skipEmpty }`.
  - Example: "חיים; בריאות" becomes two rows.
  - `indexId` (1-based) and `countId` let a calculation use the part's position or the number of parts, e.g. amount ÷ number of parts.
- **Fixed fan-out:** `{ mode: "fixedFanOut", rows: [ { set: { id: expr } } ] }`.
  - Every input row becomes the same number of rows, in order.
  - Example: a debit row with the amount and a credit row with the negative amount.

**In all three modes:**
- All other columns are copied to every new row.
- Computed columns run after expand, once per new row.
- The rows of one family stay together, in family order, unless a sort separates them.

Families that fit none of these modes are blocked in pre-flight (6.3).

### 8.6 Summary outputs
If the output has one row per group and no detail rows, the LLM sets `group.showDetailRows: false`, and each output column gets `agg`: `sum`, `count`, `min`, `max` or `first` (the group key uses `first`).

### 8.7 Title rows
A title row is one of three kinds:
- `{ text, bold? }`
- `{ blank: true }`
- `{ parts: [ { text } | { agg: "min"|"max", column, format } ], bold? }`

Use `parts` when a title contains a period (e.g. a month). The title is then built from the data, so next month's file gets next month's title, and determinism is kept (no clock).

### 8.8 Validations
- `type` runs automatically for every declared column.
- The others are `required`, `israeliIdChecksum`, `range{min,max}`, `lengthEquals`, `oneOf{values}`, `unique` and `dateRange{from,to}`. `dateRange` takes fixed dates only.
- Severity is either `flag` (the row is written but highlighted) or `block` (the row is left out and listed).

### 8.9 Flags
A flag has this shape: `{ fileName, rowNumber (1-based, as shown in Excel), column, rule, value, messageKey, suggestion? }`.
- Suggestions appear only when a fix is mechanical and safe: padding, or swapping day and month in an impossible date.
- In the MVP UI, the user accepts or rejects suggestions in a list.

### 8.10 Unsupported and assumptions
The LLM writes **codes, not prose**. The UI turns every code into Hebrew or English text from the i18n dictionary.

- **`unsupported: [{ outputColumn, reasonCode }]`**. reasonCode is one of:
  - `externalData`
  - `pivot`
  - `rowExpansion`
  - `crossRowCalculation`
  - `hiddenByMasking`
  - `ambiguous`
  - `other`

  Those columns have `"from": null`. The format can't become verified until each one is resolved, either in the rules map or by learning again with masking off.
- **`assumptions: [{ outputColumn?, reasonCode }]`** (outputColumn is omitted for row-level guesses such as filters). reasonCode is one of:
  - `rateGuessed`
  - `roundingGuessed`
  - `filterGuessed`
  - `sortGuessed`
  - `formatGuessed`
  - `titleGuessed`
  - `other`

  They are shown as "Please check" items next to the column in the rules map.
- Log all codes. They are the roadmap for which operations to add next.

### 8.11 The rules map and its editor
The rules map is where users read, fix and add rules. It is generated from the JSON in the UI language, and every change is written back to the JSON.

**Layout.** The list sits on the inline-start side and the editor panel on the inline-end side. On narrow screens the editor opens as a full-width sheet. The list has four sections:
- **Rows:** filters, duplicates, expand.
- **Columns:** one line per output column, in output order, written as a sentence, e.g. "עמלה ← פרמיה × 0.17, rounded to 2 decimals". Users can reorder columns (drag), add them and remove them.
- **Layout:** title, sort, groups and subtotals, blank rows, grand total.
- **Checks:** validations.

**Line status.** Each line shows one of four states:
- **Matches the example:** a check mark.
- **Please check:** an assumption. The user can Keep it or Change it.
- **Needs your input:** unsupported. The reason is shown in plain words, e.g. "The values in this column don't appear in your input file".
- **Edited by you.**

**Column editor.** A header name field, then "How is it made?" with one of these choices:
- **Copy a column:** a source dropdown, plus optional padding to N digits, trimming, and an output format.
- **Calculate:** built from blocks, not typed.
  - Each term is a column or a number, joined by an operator (+ − × ÷), with up to 3 terms and optional rounding.
  - In the MVP, conditions (if … then … otherwise) and text functions are available only in the Advanced JSON view.
- **Join text:** pick the columns and a separator.
- **Part of text:** the first or last N characters.
- **Translate values:** a two-column table (value in the input → value in the output). For values not in the list, the user chooses between flagging them and keeping them as they are.
- **Fixed value.**
- **Leave empty.**

Every column also has an output number or date format, with a preview.

**Row editors.**
- **Filters** read as sentences: "Keep rows where [column] [is / is not / is one of / is empty / is greater than …] [value]".
- **Duplicates:**
  - on or off;
  - which columns decide that two rows are the same (all columns, or chosen ones);
  - keep first or last;
  - remove or flag.
- **Expand:** the mode and its fields.

**Layout editors.**
- **Title:** text with an "Insert month from [date column]" button, which builds `parts`.
- **Sort:** the sort list.
- **Groups:** group by, with subtotal columns and blank rows.
- **Grand total:** its columns.

**Live check.**
- Every change re-runs the engine on the example in the worker, debounced by about 150 ms.
- The panel shows "Matches X of Y rows in your example", plus a preview table with mismatches first: row number, source values, your example, this rule.
- The live check must stay under 300 ms for 5,000 rows. Above that size, run it live on a 2,000-row subset, and on all rows when the user presses Apply.
- For a column that needs input, the "your example" values show the user exactly what they're aiming for.

**One-off exceptions.** A mismatched row in the preview offers "This row was fixed by hand". Once chosen, the row is left out of the example's match count and stored in `format.exampleExceptions`. Exceptions only affect checking the example; they are never applied to future files.

**Saving.**
- **Status:**
  - **Verified:** every row matches, not counting exceptions.
  - Otherwise the user can "Save with N differences". The status becomes `differencesAccepted`, and the badge shows N.
- **Versions:**
  - Undo and redo work within the session.
  - Every save creates a new version, and old versions can be restored from the history.
- **Anonymous users** can view the map; editing requires sign-in.

The raw JSON stays behind an "Advanced" toggle and is validated on save.

## 9. LLM layer

### 9.1 One stateless call
Every LLM call is a single request with no chat history:
- **`system`:** the fixed system prompt from `LEARN_PROMPT.md`, marked for prompt caching;
- **`messages`:** exactly one user message containing the payload JSON;
- **output:** constrained to the rules JSON Schema with the provider's structured-output feature. For Claude, that's JSON outputs via `output_config.format`, or strict tool use; confirm support for each model in the registry against the current docs.

The model writes no prose. `max_tokens` is capped in config (start at 4,000), and temperature is 0 if the model supports it.

The prompt text is versioned (`promptVersion`) and logged with every call.

### 9.2 Code checks after the call
Validate with zod, then check that:
- every referenced column id exists;
- dedupe and expand reference existing columns, and the ids that expand creates don't collide with others;
- every input header exists in the input profile;
- `from` is null exactly for `skipColumns` plus `unsupported`;
- no operation, field or id was invented.

After that, run the engine on the sample and diff.

### 9.3 Repair (optional, also stateless)
If checks or the diff fail, send one more single message. It has two content blocks:
1. the same payload, with a cache breakpoint so it's read from cache;
2. `{ mode: "repair", previousRules, problems[] }`.

The model changes only what the problems require.

- **Server repair rounds:** config, default 1. Set it to 0 to make exactly one call per learn.
- **Browser-triggered repair:** at most 1 extra call after full verification.

The formats are in `LEARN_PROMPT.md`.

### 9.4 Model choice
The model registry lives in config. Starting candidates to benchmark (not decisions yet):
- `firstTry: claude-haiku-4-5-20251001`
- `escalation: claude-sonnet-5-5`

If the first-try model still fails after its repair round, make one attempt with the escalation model. The evaluation harness (10) decides which model fills each slot.

Prices per million tokens are in config, copied from the provider's pricing page, and used to compute the cost of every call.

### 9.5 Cost controls
- **Code first.** Pre-flight blocks, the fast path, `skipColumns` and hints (section 6) are the biggest savings.
- **Server-side limits per tier.** A "learn" is one user action that reaches the LLM, however many calls it takes.
- **Anonymous users.** Turnstile is required, and limits apply per anonymous id AND per IP.
- **Budgets.** A daily anonymous budget and a daily overall budget, in USD in config.
  - When the anonymous budget runs out, anonymous learning pauses with "Sign in to keep going".
  - The overall budget is the kill switch.
  - Also set a monthly spend limit in the provider's console.
- **Cache.** The key is a hash of the structure: headers, types, layout and masking mode. If the same structure comes in again, the saved rules are returned without an LLM call, and verification runs as usual.
- **Ledger.** Every call is logged in `llm_calls`.

## 10. Model evaluation harness

Build this in milestone 1, before the UI. Prompt quality decides everything else.

- **Case format.** Each case lives in `eval/cases/<name>/` with `input.xlsx`, `output.xlsx` and `meta.json` (`difficulty`, `features`, `expect`: verified | unsupported:<code> | blocked:<reason>).
- **Cases.** Start with 10 cases and grow to 25 or more:
  - **Easy:** rename, reorder, drop columns. These should hit the fast path.
  - **Medium:** date formats, padding, value maps, filters, calculations.
  - **Hard:** subtotals and spacer rows, a title with the month, a summary output, a totals footer in the input, Hebrew RTL output.
  - **Rows:** duplicates removed on all columns and on a key; columns to rows (months); split cell; fixed fan-out (debit/credit); an expansion with no pattern (must be blocked).
  - **Traps:** leading zeros, DD/MM vs MM/DD, numbers stored as text, prefix-of-ID columns (masking), a pivot (must be blocked), a column from another source (must be skipped).
  - **English LTR cases** alongside the Hebrew ones.
- **Data.** Synthetic, modeled on insurance-commission and pension reports.
- **Runner.** `pnpm eval --models <a>,<b> --masking on,off --runs 3` runs the full production pipeline, pre-flight included.
- **Report.** Markdown plus CSV, per model and masking mode:
  - share blocked, share fast path, share schema-valid;
  - verified on the first call, and verified after repair;
  - tokens, cost per learn, latency;
  - failures grouped by feature and code.
- **Initial decision rule.**
  - First-try model: the cheapest model with at least 90% verified-after-repair on easy and medium.
  - Escalation model: the cheapest model that handles most hard cases.
- **Regression.** Re-run on every prompt, schema or pre-flight change, and bump `promptVersion`.

## 11. Tiers and limits

All numbers are starting placeholders in `packages/shared/config/tiers.ts`.

| | Anonymous | Registered (free) | Paid (MVP: waitlist only) |
|---|---|---|---|
| Max rows per file | 300 | 5,000 | 100,000 |
| Max columns | 20 | 50 | 150 |
| Converted output | first 20 rows on screen | full download | full download |
| Learns that reach the LLM | 2 per day | 10 per month | 100 per month |
| Fast-path learns | unlimited | unlimited | unlimited |
| Saved formats | none | 3 | unlimited (soft cap 100) |
| Batch | none | up to 3 files (DECISION) | up to 50 files |
| Edit rules | view only | yes | yes |

- **Upgrade button.** It opens a short form and records `upgrade_intent` with the limit that triggered it. There is no payment code in the MVP.
- **Limit tracking.** Every stop is recorded as `limit_hit { limit }`.
- **Deleting formats.** Deleting a saved format frees a slot but doesn't give back learns.
- **Description character limits** (for after the MVP): 300 / 1,000 / 4,000.

## 12. Sign-in

**Providers:** Google and Microsoft, both in the MVP. Google comes first in the UI, because the first goal is demand from individual users. Microsoft is there for people signing in with a work account.

**Implementation:**
- One OpenID Connect implementation (openid-client), using the authorization-code flow with PKCE. Adding a provider later is config only.
- Scopes: openid, email, profile.
- Microsoft uses the `common` endpoint, which accepts both personal and work/school accounts.
- The session is kept in an httpOnly, Secure, SameSite=Lax cookie.

**Identity:**
- A user is identified by provider plus subject. For Microsoft that's the tenant id plus the object id (`tid` + `oid`). **Never merge accounts automatically by email:** Microsoft's email claim isn't guaranteed to be verified, and merging on it is a known account-takeover risk.
- A signed-in user can link the second provider from their settings.

**Anonymous visitors:**
- Each visitor gets a random `anonId` in a first-party cookie.
- On sign-in, the anonId is attached to the user, its past events get the `userId`, and the format learned just before sign-in is saved to the account.

**Admin:** access is controlled by an `ADMIN_EMAILS` allowlist, checked against verified Google emails or a configured Microsoft `oid`.

**Before approaching companies:** many company Microsoft tenants only let employees sign in to apps from verified publishers. Complete Microsoft publisher verification before the business outreach. Personal Microsoft accounts aren't affected.

## 13. Data (MongoDB)

- **`users`:** identities[`{ provider, subject, tenantId?, email, emailVerified }`], name, avatarUrl, uiLanguage, tier, createdAt, lastSeenAt, anonIds[], limitOverrides?
- **`formats`:**
  - ownerId, name, schemaVersion, rules;
  - inputSignature `{ columns: [{ header, type, required }] }`;
  - source, status (`verified` | `differencesAccepted` | `userConfirmed` | `draft`), acceptedDifferences (count);
  - exampleExceptions: example row numbers the user marked as fixed by hand. They are used only when checking the example, never on future runs;
  - learnPath (`local` | `llm`), masking, model, promptVersion;
  - versions[`{ rules, editedBy, at }`], runCount, lastRunAt, createdAt.

  Rules contain only real constants (after unmasking) such as labels and value-map entries. They never contain data rows.
- **`events`:** ts, anonId, userId?, type, props. Props hold counts, ids and codes only, never cell values or file names.
- **`llm_calls`:** ts, userId?, anonId?, learnId, purpose (learn | repair | escalation), model, promptVersion, masking, tokensIn, tokensOut, tokensCached, costUsd, latencyMs, outcome, cacheHit.
- **`usage_counters`:**
  - keys look like `user:<id>:<yyyy-mm>`, `anon:<id>:<yyyy-mm-dd>` or `ip:<hash>:<yyyy-mm-dd>`;
  - updates use atomic `$inc`, and anon/ip keys expire through a TTL index.
- **`budgets`:** spend totals per day.
- **`leads`:** name, email, company, role, message, language, ts.
- **`waitlist`:** userId, email, trigger, message, ts.
- **`feedback`:** formatId?, userId?, rating, text, ts.
- **Not stored in the MVP: user data files** (DECISION, see section 20).

## 14. Events and admin dashboard

### 14.1 Events
- **Visits and files:** `page_view {path}`, `language_changed {lang}`, `file_uploaded {role, rows, cols, fileType, direction}`, `file_rejected {reason}`
- **Pre-flight and learning:** `preflight {status, reason?, skipColumns}`, `masking_toggled {on}`, `learn_completed {path: local|llm|cache, status, rounds, model, masking}`, `dedupe_found {action}`, `expand_found {mode}`, `unsupported_found {codes}`, `assumptions_found {codes}`, `preview_shown`
- **Accounts:** `signin_wall_shown {trigger}`, `signed_up {provider}`, `signed_in {provider}`
- **Using formats:** `rule_editor_opened {section, method}`, `exception_marked`, `download {rows}`, `format_saved`, `format_run {formatId, daysSinceCreated}`, `batch_run {files, rows, flaggedRows, mismatchedFiles, duplicatesRemoved, duplicatesFlagged}`, `rules_edited {field}`, `flag_resolved {accepted}`
- **Demand signals:** `limit_hit {limit}`, `upgrade_intent {trigger}`, `lead_submitted`, `feedback_given {rating}`

### 14.2 Dashboard (`/admin`)
- **Headline numbers:**
  - registered users: total, new this month, month-over-month growth;
  - active users this month;
  - anonymous uses this month;
  - LLM spend this month.
- **Returning use (the key metric):**
  - users who ran a saved format again 7 or more days after creating it;
  - runs per active user.
- **Funnel, last 30 days:** visited → uploaded → passed pre-flight → learned → saw the sign-in wall → signed up → downloaded → ran a saved format again.
- **Learning:**
  - share of learns by path: blocked, local, cache, LLM;
  - verified rate, overall and per model and per masking mode;
  - average calls per learn;
  - unsupported and assumption codes.
- **Editor use:** share of formats edited before saving, edits per format, which methods are used, and exceptions marked.
- **Cost:** spend per day, per LLM learn and per tier; today's remaining budget.
- **Breakdowns:**
  - pre-flight blocks by reason;
  - rejected files by reason;
  - limits hit;
  - upgrade intents by trigger;
  - sign-ups by provider;
  - UI language split;
  - masking on/off split.
- **Tables:** latest sign-ups, leads and feedback.
- **Time range picker:** 7, 30 or 90 days, grouped by day or month.

## 15. Security and privacy

- **No file uploads.** The API has no multipart endpoints, and JSON bodies are capped at 256 KB. This is what makes "your files never leave your computer" true.
- **The masking map stays local.** It never leaves the browser, and saved rules contain only real constants.
- **"See what we send."** This panel shows the exact JSON payload, in either masking mode.
- **Untrusted text.** Headers and cell values are treated as untrusted. The protections:
  - the LLM has no tools;
  - its output is schema-constrained and code-validated;
  - the engine only interprets a whitelisted AST;
  - the system prompt says all payload text is data, not instructions.

  So the worst case is a bad rules file, and verification catches that.
- **No code execution.** Never execute macros or evaluate anything as code. Enforce a maximum file size, and parse in a worker with a timeout.
- **Formula injection.** When writing CSV, prefix cells that start with `=`, `+`, `-` or `@` with an apostrophe, except in numeric columns. When writing xlsx, write values, not formulas.
- **LLM data retention.** The business page states the LLM provider's data-retention terms accurately (check the provider's current policy).
- **Logs** never contain cell values, file names or payloads.
- **Legal pages.** Privacy policy and terms, in Hebrew and English, go live before launch, along with a cookie notice. Check what Israeli privacy law requires.

## 16. Screens, languages and design

### 16.1 Screens
1. **Home is the tool.**
   - Two drop zones: Example input and Example output.
   - The masking switch, with its one-line explanation and a "What's the difference?" link.
   - The line "Your full files never leave your computer" and a "See what we send" link.
   - Nothing sits above the tool; a short "how it works" (learn once → use every month) sits below it.
2. **Pre-flight result.** Shown only when there's a warning or a block: what was found and what the user can do.
3. **Learning progress.** Reading files → Checking the files → Learning the format → Checking against your example. Show real progress, and skip steps that don't happen (e.g. on the fast path).
4. **Result.**
   - The rules map and its editor (8.11).
   - The preview grid, with differences from the example highlighted.
   - The flagged rows.
   - A status badge: Verified, "N columns need your input", or "N differences accepted".
   - Primary button: "Save format and download".
5. **My formats.** A list with Run on a file, Run a batch, Edit rules, Rename and Delete.
6. **Run result.** Download (file or zip), a summary (rows in, rows out, rows filtered, duplicates removed or flagged), and the flags with accept/reject.
7. **For business (`/business`).**
   - The problem: hours of manual Excel work, and human errors.
   - How it's different:
     - readable rules;
     - the same file always gives the same result;
     - your data stays on your computer;
     - every value is checked;
     - batch conversion;
     - team formats (later).
   - A lead form.
8. **Admin, Privacy, Terms.**

### 16.2 Languages and direction
- **Languages.** The whole UI is in Hebrew and English from day one.
  - The default comes from the browser language.
  - A language toggle sits in the header.
  - The choice is saved in a cookie, and in the user profile for signed-in users.
- **Layout direction.**
  - `<html dir>` follows the UI language.
  - Use CSS logical properties only (`margin-inline-start`, `padding-inline-end`, `inset-inline-start`), never left/right.
  - Mirror directional icons.
- **Sheet direction.** The preview grid follows the sheet's direction, not the UI language: a Hebrew sheet shows right-to-left even in the English UI.
- **Mixed text.** Wrap cell values and headers in bidi isolation (`<bdi>` or `unicode-bidi: isolate`), so numbers, dates and English inside Hebrew (and the reverse) display correctly.
- **Excel output.** Direction comes from `output.direction`: ExcelJS `views: [{ rightToLeft: true }]` for RTL. Month names come from `output.language`.
- **Translated text.** Every user-facing message (file rejections, pre-flight reasons, unsupported and assumption codes, flags, emails) comes from the i18n dictionary in both languages. The LLM never writes UI text.

### 16.3 Design direction: smooth, simple, appealing
Follow the frontend-design skill's process. Present the design plan (palette, type, layout sketch) before building the M2 UI.
- **Simple.**
  - One main action per screen.
  - The journey is visibly three steps: Upload → Learn → Use.
  - Generous space and short, plain copy, with no jargon ("format", not "schema"; "check", not "validate").
- **Smooth.** Motion answers what the user does:
  - drop zones react while a file is dragged over them;
  - a dropped file settles into place with its row and column count;
  - the rules map fills in line by line when learning finishes;
  - differences glow briefly when the preview appears.
  - One orchestrated moment beats many small effects. Respect `prefers-reduced-motion`.
- **Appealing.**
  - A calm base with one distinctive brand color for primary actions, plus one separate color reserved for differences and flags.
  - One typeface family that covers Hebrew and Latin well (e.g. IBM Plex Sans Hebrew or Assistant), with tabular numbers in grids.
  - It must look equally good in RTL and LTR.
  - Avoid the generic SaaS card grid and gradient decoration.
- **Tone.** Errors say exactly what's wrong and what to do, in the interface's voice, e.g. "Row 1 has cells merged across columns B–D. Unmerge them and upload again."
- **Devices.** The work happens on desktop. The home page and the business page must also look good on a phone.

## 17. Excel and Hebrew traps the engine must handle

- **Leading zeros** in IDs and policy numbers: restore them by padding.
- **Dates:**
  - Excel serial numbers vs text dates.
  - DD/MM vs MM/DD: default to DD/MM for Hebrew files, and flag impossible dates.
- **Numbers:**
  - numbers stored as text;
  - thousand separators, ₪ and %;
  - negatives in parentheses or with a trailing minus;
  - exact decimal arithmetic and Excel-style rounding.
- **CSV encodings:** UTF-8 with or without BOM, and Windows-1255. Detect the encoding when reading; always write UTF-8 with a BOM.
- **Direction:** RTL and LTR sheets, and cells that mix Hebrew and English.
- **Header text differences:** extra spaces, and different quote characters (״ vs " vs '') and geresh (׳ vs ').
- **Rows to exclude:** a totals row at the bottom of the input, and title rows above the header.
- **Hidden rows and columns:** included by default, with a notice.
- **Merged cells:** fine in title rows; rejected in the header in the MVP.

## 18. Testing

- **Engine:**
  - unit tests for each operation;
  - golden-file tests, cell by cell, formats and direction included;
  - a determinism test (run twice, byte-compare);
  - decimal and rounding tests against Excel results;
  - duplicates (remove and flag, keep first and keep last), and each expand mode, including empty cells and families of uneven size.
- **Pair analysis:**
  - every relation type, including coverage below 1.0;
  - every block reason;
  - family detection for each pattern, and duplicate detection;
  - the fast path produces verified rules for easy cases.
- **Masking:**
  - consistent across files and labels;
  - shape preserved;
  - Israeli ID checksum preserved;
  - the unmask pass restores every constant;
  - the key and map never appear in any request.
- **API:** limits, budgets, cache, schema rejection, repair-round cap, stateless calls (one user message).
- **Sign-in:** both providers mocked; no merging by email; anonymous → user merge.
- **UI:** RTL and LTR snapshots of the main screens; bidi rendering of mixed cells; the editor's live check stays under 300 ms on 5,000 rows.
- **Prompts:** the eval harness is the regression suite.
- **End to end:** flow A with a fake LLM client, in both masking modes.

## 19. Milestones

Stop after each milestone and report.

- **M0: Engine without AI.**
  - monorepo setup;
  - rules schema (zod + JSON Schema);
  - table detection and the engine pipeline with decimal math, including duplicates and the three expand modes;
  - xlsx/csv read and write, including RTL;
  - 5 hand-written rules files with golden tests.
- **M1: Learning.**
  - profile and pair analysis, including families and duplicate detection;
  - pre-flight and the fast path;
  - masking and unmasking;
  - the payload builder;
  - the prompt from `LEARN_PROMPT.md`;
  - the LLM client with structured output, and the repair call;
  - the eval harness with 10 cases, in both masking modes;
  - a first model comparison report.
- **M2: Web tool.**
  - design plan first;
  - Hebrew/English + RTL/LTR shell;
  - upload → pre-flight → learn → rules map, preview and diff → full verification;
  - the rules editor (8.11), with the live match counter and one-off exceptions;
  - the masking switch with its explanation, and "See what we send";
  - anonymous limits, Turnstile, budgets and cache.
- **M3: Accounts.**
  - Google and Microsoft sign-in, and the sign-in wall;
  - save, list, run and edit formats;
  - tier config and usage counters;
  - batch conversion.
- **M4: Launch pieces.**
  - events and the admin dashboard;
  - business page with leads;
  - upgrade/waitlist and feedback;
  - privacy and terms pages;
  - deploy.
- **After the MVP:**
  - description modes;
  - a merge-style view for flags;
  - eval grown to 25+ cases;
  - Microsoft publisher verification before the business outreach.

M0–M4 is roughly 1.5–2 weeks of focused work. Bilingual UI, two sign-in providers, pre-flight, the rules editor, duplicates and row expansion each add a little on top of the original one-week target. If time runs short, cut split cell first: it's the least common expand mode.

## 20. Open decisions (defaults in bold)

1. **Stack.** Default: **Node + TypeScript** rather than Python/Flask. With Node, one engine package runs in both the browser and the server.
2. **Storing user files.** Default: **don't store them in the MVP.**
   - Storing them contradicts "your files never leave your computer".
   - Large files don't fit in MongoDB documents (16 MB limit).
   - If this is added later: make it opt-in, use encrypted object storage, delete files automatically, and update the privacy statement.
3. **Batch for registered users.** Default: **up to 3 files**, as a taste. The alternative is none.
4. **Tier numbers.** Default: **placeholders**, to be tuned from `limit_hit` data.
5. **Server repair rounds.** Default: **1**. Set it to 0 for exactly one LLM call per learn.
6. **Product name and domain.** Currently a working name.
7. **Hosting.** For example: static web on Vercel or Cloudflare Pages, the API on Render or Fly, and MongoDB Atlas.

Settled in this version:
- Masking switch, on by default.
- Hebrew and English UI, with the default taken from the browser.
- Two-file learning only in the MVP.
- Google and Microsoft sign-in.
- Duplicates (remove or flag), row expansion in three patterns, and the rules editor are in the MVP.
