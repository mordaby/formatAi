# SPEC: Format Learner (working name)

> Build spec for Claude Code. Read this whole file, and `LEARN_PROMPT.md`, before writing any code.
>
> - Build one milestone at a time (section 19).
> - After each milestone, stop and report what was built, what was skipped, and any decision you had to make.
> - Items marked **DECISION** are listed in section 20. They are not settled: use the default given there and leave a `// DECISION:` comment in the code.
> - The exact LLM prompt lives in `LEARN_PROMPT.md`. Keep that file and this spec in sync.
> - This is **v3**. Section 21 lists what changed since v1 and the amendments to the M0 code that was already built.

## 1. What we're building

A web tool that learns a company's file formats from examples, keeps them in a registry, and converts incoming files into them. Conversion is deterministic and uses no AI at run time.

Companies receive files from other parties (suppliers' price lists, insurers' commission reports, clients' exports, other systems' reports), each in the sender's layout. Someone rebuilds them by hand into the company's own format, or into the exact file their system (Priority, Hashavshevet, SAP B1, a CRM) loads, and checks them. The receiving side usually can't make the sender change its layout. That manual work, and the errors in it, is what this tool replaces.

Three words, used the same way everywhere (code, UI, docs):
- **Format:** the shape of a file the company produces: columns, types, layout, file type and checks. Formats belong to the company (8.12).
- **Source:** one kind of incoming file, e.g. one supplier's price list.
- **Conversion:** the rules that turn one source into one format. A format usually has several conversions.

How it works:
1. The user provides an example input file and the output file they make from it by hand.
2. Code on the user's computer analyzes both files.
3. An LLM receives a small, masked summary once and writes a **rules file** (JSON). Simple cases are solved by code alone, with no LLM at all.
4. Saving creates the format and its first conversion. Each further source is taught the same way and attached to the existing format, which stays fixed.
5. From then on, a deterministic engine applies the rules to any number of new files, picking the right conversion for each file by its columns.

**The core is one pipeline:** two files → deduce the differences → a rules file in the format language (8) → the conversion engine. Everything else (the registry, the editor, tiers, accounts) exists to serve it. Nothing in it depends on a domain, a system or a file's meaning; it only learns how one table becomes another.

**Audience:** non-technical office staff (operations, back office, procurement, finance) who spend much of their day converting, reformatting and checking files received from others. The product is domain-neutral. Early design partners will likely come from insurance agencies (commission control), pension operations and importers loading supplier files into their ERP, but no part of the engine, the prompt or the UI may assume one of them (non-negotiable 9).

**Business model:** B2B is the business. The public app (free → registered → paid, section 11) is a proof of concept and a demand funnel: people use the real product on real files, and usage data shows which formats and features matter. Paid accounts in the MVP are companies we onboard by hand; an admin assigns their tier (no payment code yet). A separate business page explains the value to companies.

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
9. **Domain-neutral.** Nothing in the engine, the prompt, UI copy or default examples is specific to one industry. Domain knowledge enters only through formats, value maps and validations that users create.

## 3. Scope

**In the MVP:**
- Single-sheet Excel, CSV and delimited-text tables.
- Learning from an example pair (two files).
- The registry: formats with several sources; adding a source to an existing format (with an example output); converting a file with automatic matching to its conversion.
- Output as xlsx, csv or delimited text, with or without a header row, so system load files are covered.
- Pair analysis, pre-flight checks and a local fast path.
- Removing or flagging duplicate rows.
- One input row becoming several output rows: columns to rows, splitting a cell, and fixed fan-out.
- A masking switch.
- A rules map with an editor, where users fix or add rules and see a live count of matching rows.
- A preview with a diff against the example, and flagged rows.
- Google and Microsoft sign-in.
- Saved formats and sources, re-running, and batch conversion for paid accounts (mixed sources allowed).
- Tier limits.
- Usage events and an admin dashboard.
- A business page with a lead form, plus privacy and terms pages, all in Hebrew and English.
- A model evaluation harness.

**Next, after the MVP:**
- Adding a source from its input file alone (no example output), mapped to the known format.
- A headers-only LLM suggestion when a known source renamed its columns (headers only, never values).
- Ready-made formats (templates) for common systems, e.g. Priority load screens.
- Comparing a run with the previous run of the same conversion (row count, totals) and flagging unusual changes.
- A customer-hosted LLM endpoint (9.6).
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
    shared/        rules schema (zod) + generated JSON Schema, format/conversion types, config (tiers, models, prices),
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
- **Writing:** CSV and delimited text are written by the engine's own writer (delimiter, header on/off, quoting, encoding; iconv-lite for Windows-1255, since it runs in the browser). ExcelJS for xlsx: styles, number formats, widths, the right-to-left sheet view and merged title cells. Use ExcelJS when you need to read sheet-view settings (e.g. the RTL flag) from xlsx files.
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
8. **Saving** creates two things: a **format** (the output side: columns, layout, file type and output checks) and its first **conversion** (this source → that format). See 8.12.

### A2. Add a source to an existing format (MVP)
A company receives the same kind of file from several parties (suppliers, insurers, clients), each in its own layout, and turns all of them into one format. The first source creates the format (flow A). Every other source is added to it:
1. The user opens a format → **Add a source**, names it (e.g. the supplier), and drops that source's input file and an output they made from it by hand. The output must match the format (same headers in the same order and the same file type); if it doesn't, say which columns differ.
   - Flow A detects this case too: if an example output matches a saved format, offer "This looks like your format *X*. Add this file as a new source for it?"
2. Everything in flow A runs as before (pair analysis, pre-flight, fast path, masking, verification), with one difference: the payload includes `target` (LEARN_PROMPT section 3) and the output side is fixed by the format lock (8.12). The LLM only decides how this input produces the format's columns.
3. Output columns this source can't produce are `unsupported` as usual. The format is never changed to fit a source.
4. Saving creates a new conversion under the format.

Adding a source *without* a hand-made output (the input file alone, mapped to the known format) comes after the MVP. Such a conversion can only be `userConfirmed`, never verified.

### B. Learn from a description (after the MVP)
There are two variants:
- **Input file plus description.** The output is confirmed by the user rather than verified.
- **Description only.** This produces a draft whose input columns are guesses. The guesses are mapped to real headers on the first run.

Keep this in mind in the schema (`meta.source`, `meta.status`), but don't build it yet.

### C. Convert a file
The user drops a file on **Convert a file** (on Home, or on a format's page). They don't have to say which source it is:
- code matches the file's headers against the input signature of every saved conversion (8.12), and either picks the conversion or asks the user to choose among the top matches;
- missing required columns stop the run with a clear message;
- extra columns are ignored;
- renamed columns are matched through aliases or offered to the user for mapping. A confirmed mapping is saved as a new alias.

The result is a download plus flagged rows. No LLM call.

### D. Batch
Same as flow C with many files, processed one at a time in the worker. A batch may mix sources: each file is matched on its own, and results are grouped by format. Each file gets a status: converted, converted with flags, or didn't match. The user downloads a zip plus a summary sheet of flags per file. No LLM call. Batch is a paid feature; the number of files is limited by tier.

### E. Sign-in wall
Shown when an anonymous user tries to download the full output, save a format, run another file, or goes over an anonymous limit.
- Copy: "Sign in to save this format and reuse it on next month's file."
- Buttons: **Continue with Google** first, then **Continue with Microsoft**.
- The learned rules survive sign-in, so nothing has to be redone.

## 6. Intake, pair analysis and pre-flight

Everything in this section runs in the browser, on the real data, and costs no tokens.

### 6.1 File checks
Accepted types: .xlsx, .xls, .csv, and .txt (delimited). The maximum size depends on the tier. Formulas are read as their last calculated values, and macros are ignored.

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
- `skipColumns`;
- `output.file`, detected by code from the example output (8.13);
- `target`, only when adding a source to an existing format (8.12).

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

This example comes from commission control, one of many domains. Nothing in the language is domain-specific.

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
      "summaryRows": [
        { "labelColumn": "פוליסה", "label": "סה\"כ לסוכן", "cells": { "פרמיה": "sum", "עמלה": "sum" } }
      ],
      "blankRowsAfter": 1
    }
  },
  "output": {
    "file": { "type": "xlsx" },
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
    "summaryRows": [
      { "labelColumn": "פוליסה", "label": "סה\"כ", "cells": { "פרמיה": "sum", "עמלה": "sum" } }
    ]
  },
  "validations": [
    { "column": "insuredId", "rule": "israeliIdChecksum", "severity": "flag" },
    { "column": "premium",   "rule": "range", "min": 0,   "severity": "flag" },
    { "on": "output", "column": "עמלה", "rule": "range", "min": 0, "severity": "flag" }
  ],
  "unsupported": [],
  "assumptions": [ { "outputColumn": "עמלה", "reasonCode": "roundingGuessed" } ],
  "meta": { "formatId": "...", "sourceName": "...", "source": "examplePair", "status": "verified", "model": "...", "promptVersion": "...", "masking": true, "createdAt": "..." }
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
9. **Group.** Detail rows, summary rows (8.6, 8.12) and spacing.
10. **Output layout.** Title rows, header, columns, summary rows (8.6, 8.12), direction, language and file type (8.13).
11. **Validations** → flags. Input validations (`on: "input"`, the default) check the normalized input columns; output validations (`on: "output"`) check the final data rows, by output header.

The engine receives no clock. All arithmetic uses decimal.js. `round` rounds half away from zero, like Excel's ROUND.

### 8.3 Expressions, functions and filters
Expressions are an AST that the engine interprets. There is no regex and no code in strings, ever. The language is meant to be rich enough for real reports and still fully checkable by code before anything runs (9.2): a closed set of typed operations, reusable functions and constant tables (8.14), and hard limits.

**Formulas (learn-v5).** The LLM (and, later, the editor's text view) writes every expression as FORMULA TEXT, e.g. `round(amount * 0.17, 2)`, `if(status = "VIP", price * 0.9, price)`, `lookup("rates", code, "rate")` - never the AST directly. A strict parser (`packages/engine/src/formula`) turns that text into the exact same whitelisted AST below; nothing is ever executed as code, and an unknown function or identifier is a parse error. Stored rules, the engine, the type checker and every saved/golden rules file are unchanged: still JSON trees. This also sidesteps structured-output providers that can't express a recursive schema (see below) without spelling every op out at a fixed depth, and keeps the wire schema small enough to pass on a command line.

**Leaves:** `col`, `const`, and `param` (only inside a function body).

**Operations.** Each has a fixed signature (see Types):
- **Arithmetic:** `add`, `sub`, `mul`, `div` (dividing by zero raises a flag), `neg`, `abs`, `round{digits}`, `floor`, `ceil`, `mod`, `min`, `max`
- **Text:** `concat`, `substr{start,length}`, `trim`, `upper`, `lower`, `replaceText{find,with}` (literal text only), `padLeft{length,char}`, `split{separator,index}` (1-based; negative counts from the end), `length`
- **Conversion:** `toNumber` (a value that doesn't parse raises a flag), `toText{format?}` (number or date format)
- **Dates:** `datePart{year|month|day}`, `dateFormat{format}`, `dateAdd{days|months|years}`, `dateDiff{unit: days|months|years}`, `endOfMonth`
- **Logic:** `if{cond,then,else}`, `switch{cases: [{when, then}], else}`, `coalesce`
- **Lookup:** `lookup{table, key, return, onMissing: flag|empty|keep}` against a constant table in `transform.tables` (8.14)
- **Calls:** `call{fn, args}` to a function in `transform.functions` (8.14)
- **Conditions:** `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `isEmpty`, `notEmpty`, `oneOf{values}`, `startsWith{text}`, `endsWith{text}`, `contains{text}`, `and`, `or`, `not`

**Types.** Every value has one type: `text`, `idLike` (text whose leading zeros matter), `integer`, `decimal`, `date` or `boolean`. Every operation declares its argument and result types, e.g. `mul: (decimal, decimal, …) → decimal`, `dateDiff: (date, date) → integer`, `startsWith: (text) → boolean`. The only implicit widenings are `integer → decimal` and `idLike → text`. Anything else needs `toNumber` or `toText`. The signature table lives in `packages/engine` and is the single source for the type checker, the editor and the prompt.

**Limits** (config): depth 8 per expression; 200 nodes per output column after expanding function calls; 20 functions; 20 tables of up to 500 rows each.

If the provider's structured output doesn't support recursive schemas: since learn-v5, this no longer applies to expressions at all - they're formula text (a plain string) on the wire, not a nested schema of any depth. It would still apply to any other genuinely recursive field the rules language might grow later.

**Row filters:** `{ column, op, value? }` for simple cases, or `{ expr }` where expr is any condition. op is one of `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `isEmpty`, `notEmpty`, `oneOf` or `notOneOf` (value is an array). Several filters are ANDed.

**Date format tokens:** `D`, `DD`, `M`, `MM`, `MMMM`, `YY`, `YYYY`. `MMMM` is the month name in `output.language`, e.g. ספטמבר or September.

### 8.4 Duplicates
`transform.dedupe: { keys: [ids] | "all", keep: "first" | "last", action: "remove" | "flag" }`

- **Where it comes from:** either the example (pair analysis found that the dropped rows are copies of kept rows) or the user, who adds it in the editor.
- **How rows are compared:** values are compared after type normalization: trimmed, padded, and with quote marks and geresh unified. There is no fuzzy matching.
- **`remove`:** the extra copies are left out. With `keep: "first"` the later copies go; with `keep: "last"`, the earlier ones. Every removed row is listed in the run summary with its row number, so nothing disappears silently.
- **`flag`:** all rows stay, and every extra copy is flagged, e.g. "duplicate of row 12". In reconciliation-type work a duplicate is often the error itself (an item billed or paid twice), so the editor offers both actions.

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
Generic summary rows (v4, 8.21):
```
summaryRow = { label?: string, labelColumn?: <output header>, bold?: boolean,
               cells: { <output header>: "sum" | "count" | "min" | "max" | "average" | "first" | "last" } }
output.summaryRows?: summaryRow[]                   // after all data rows, in order
transform.group.summaryRows?: summaryRow[]          // after each group, in order, before blankRowsAfter
```
`labelColumn` and the keys of `cells` name OUTPUT HEADERS, never ids, so a summary row belongs to the format and is identical across every source of that format (8.12). Without `labelColumn`, `label` goes in the first output column that has no entry in `cells` (falling back to the first column). `count` counts non-empty cells (a row a `block` validation left out never counts); `min`/`max` work on numbers and dates; `sum`/`average` need a numeric column, in exact decimal; `first`/`last` are the first/last non-empty value of the rows the row summarizes.

If the output has one row per group and no detail rows, the LLM sets `group.showDetailRows: false`, and each output column gets `agg`: `sum`, `count`, `min`, `max`, `average`, `first` or `last` (the group key uses `first`).

### 8.7 Title rows
A title row is one of three kinds:
- `{ text, bold? }`
- `{ blank: true }`
- `{ parts: [ { text } | { agg: "min"|"max", column, format } ], bold? }`

Use `parts` when a title contains a period (e.g. a month). The title is then built from the data, so next month's file gets next month's title, and determinism is kept (no clock).

### 8.8 Validations
- `on`: `input` (default) or `output`. A check that describes the format itself (a valid ID number in an output column, a non-negative output amount, a required output column) uses `on: "output"`, names the output header in `column`, and belongs to the format, so every source converted into it gets the check. A check about one source's input stays on the conversion.
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

### 8.12 Formats and conversions (the registry)

The product keeps two kinds of objects:

- **Format:** the shape of a file the company produces, owned by the company and named by the user (e.g. "Priority catalog load", "Monthly commission control"). It holds:
  - `output` (columns, headers, number formats, widths, title rows, summary rows, direction, language, `file`);
  - the layout parts that live in `transform`, normalized to output headers: `sort`, and `group` (by, summary rows, blank rows, showDetailRows, per-column agg);
  - output validations (`on: "output"`).
  - Summary rows (8.6) are already keyed by output header, so - unlike `sort`/`group.by` - they need no id translation to belong to the format.
- **Conversion:** how one kind of input file (a **source**: one supplier's price list, one insurer's report, one client's export) becomes that format. It is a full, self-contained rules file (8.1) plus `formatId` and `sourceName`. The engine only ever runs a conversion; it never needs the format object at run time.

A format usually has several conversions. That is the point of the registry: the company defines its format once, and each new source is attached to it.

**The format lock.** When a conversion belongs to a format:
- its `output` section must equal the format's `output`, except `columns[].from`;
- its `sort` and `group`, after code maps ids to output headers, must equal the format's;
- its output validations must equal the format's.

Code enforces this after every learn and every edit (9.2). A conversion that breaks the lock is rejected, and a repair call receives it as a `formatMismatch` problem.

**Editing a format.** A change to the output side made from any conversion's rules map is a change to the format. The editor says so ("This changes the format for all N sources"), and on save the change is written to every conversion of that format. Conversions whose `from` references still resolve keep their status; the others become `needsReview`. Example files are not stored, so re-verification happens on each conversion's next run: its flags and summary are shown with a "format changed since last run" notice.

**Matching a file to a conversion** (flow C, and detection in A2): code compares the file's headers with each conversion's input signature (exact, then aliases, then normalized headers, as in 8.2 step 1). Score = share of required columns found, minus a penalty for extra unknown columns. One conversion with a score ≥ 0.9 and at least 0.1 above the next is selected automatically; otherwise the user picks from the top 3. Never run automatically on a guess below the threshold (DECISION 10).

**Ready-made formats (after the MVP).** A format doesn't have to come from an example. Known system formats (e.g. Priority load screens) can ship as templates: a format object with no conversions yet. Adding a source to it is flow A2. Nothing in the data model may assume that a format was learned.

### 8.13 Output file types

```json
"file": { "type": "xlsx" | "csv" | "txt", "delimiter": "," | "\t" | ";" | "|", "header": true | false,
          "encoding": "utf8bom" | "utf8" | "windows1255", "quote": "minimal" | "all" | "none" }
```

- The default is `{ "type": "xlsx" }`. Many system load files (ERP import screens) are delimited text with no header row and a fixed column order, which is why csv and txt are first-class outputs and not an export option.
- Code detects `file` from the example output: extension, delimiter, whether the first row is a header (compared with the data types below it; when the types give no evidence, e.g. an all-text file, the pair decides: row 0 is the header if it is not explained as a data row while the rows below are), and encoding. The LLM copies it.
- `header: false`: output columns still have a `header`, used in the UI and for matching; it is written nowhere in the file. Pair analysis aligns such output columns by position.
- csv and txt ignore styles, widths, bold and direction. Title rows, blank rows and subtotals are allowed but show a warning in the rules map, since load files rarely have them.
- Encoding: by default the writer reproduces the example's encoding (DECISION 8).
- Formula-injection protection (15) applies to csv and txt.

### 8.14 Functions and tables
Reusable logic lives in the rules file itself, so it is saved, versioned and checked together with the conversion.

`transform.functions: [{ name, params: [{ name, type }], returns: type, body: expr }]`
- Example: `netOf(gross, rate) = round(gross ÷ (1 + rate), 2)`, used by three output columns.
- A body may use its params, constants, operations and other functions, but never `col`: a function sees only what it is given, so it can be tested on its own.
- A function may call only functions defined above it. That makes recursion impossible by construction; code still checks that the call graph is acyclic.
- Functions are pure: no row context, no clock, no state.
- The LLM defines a function only when the same logic is needed in two or more places. Users can define and name their own in the editor.

`transform.tables: [{ name, columns: [names], rows: [[values]] }]`
- Constant reference data used by `lookup`, e.g. a product code → category and rate. Keys must be unique (checked).
- Like value maps, tables hold real constants after unmasking and never data rows from the user's files.

**In the rules map**, a **Functions and tables** section lists each one as a sentence with its signature. Each has a test panel: enter arguments or a key, see the result. Every function, table, output column, filter, dedupe, expand, sort, group and validation counts as one **rule** for tier limits (11).

## 9. LLM layer

### 9.1 One stateless call
Every LLM call is a single request with no chat history:
- **`system`:** the fixed system prompt from `LEARN_PROMPT.md`, marked for prompt caching;
- **`messages`:** exactly one user message containing the payload JSON;
- **output:** constrained to the rules JSON Schema with the provider's structured-output feature. For Claude, that's JSON outputs via `output_config.format`, or strict tool use; confirm support for each model in the registry against the current docs.

The model writes no prose. `max_tokens` is capped in config (start at 4,000), and temperature is 0 if the model supports it.

The prompt text is versioned (`promptVersion`) and logged with every call.

### 9.2 Checking what the LLM wrote
A rules file is accepted only after it passes these layers, in order. Every failure becomes a precise problem for the repair call (9.3). Nothing is judged by another LLM.
1. **Structure:** zod against the schema. Unknown fields, operations and enum values are rejected.
2. **References:** every column id, table, function and param exists; ids created by expand and by computed columns don't collide; every input header exists in the input profile; `from` is null exactly for `skipColumns` plus `unsupported`; output validations name existing output headers.
3. **Types:** a static type check of every expression, filter and function body against the declared column types and the operation signatures (8.3). Each output column's result type must fit its output type.
4. **Limits and safety:** depth and node budgets, function and table counts, an acyclic call graph, unique table keys, and a rule count within the user's tier (11).
5. **Format lock,** when the conversion belongs to a format (8.12).
6. **Overfitting lint.** Never a rejection; each finding becomes a "Please check" line with assumption code `overfitSuspected`:
   - a constant equal to a value that appears in only one input row;
   - a condition that is true for exactly one sample row;
   - a `switch`, value map or table with one entry per sample row;
   - an expression far larger than needed by any other column.
7. **Run on the samples** in the API, and diff.
8. **Full verification** in the browser on every row of the real example (5 A step 6). The LLM saw at most 12 rows, so this is the hold-out test: rules that only memorized the samples fail here.

The same layers 1–6 run in the browser on every save from the editor.

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

### 9.6 One LLM interface
All LLM calls go through one function in `apps/api`, e.g. `complete({ system, content[], schema, model }) → { json, usage }`. No provider SDK is imported anywhere else, and the provider is chosen in config.

This keeps two later options cheap: switching providers, and a customer running learns on their own model endpoint, with their key never reaching our server. Design for it; don't build the customer endpoint in the MVP.

## 10. Model evaluation harness

Build this in milestone 1, before the UI. Prompt quality decides everything else.

- **Case format.** Each case lives in `eval/cases/<name>/` with `input.xlsx`, `output.xlsx` and `meta.json` (`difficulty`, `features`, `expect`: verified | unsupported:<code> | blocked:<reason>, and optional `attachTo`: another case whose output defines the format).
- **Cases.** Start with 10 cases and grow to 25 or more:
  - **Easy:** rename, reorder, drop columns. These should hit the fast path.
  - **Medium:** date formats, padding, value maps, filters, calculations.
  - **Hard:** subtotals and spacer rows, a title with the month, a summary output, a totals footer in the input, Hebrew RTL output.
  - **Rows:** duplicates removed on all columns and on a key; columns to rows (months); split cell; fixed fan-out (debit/credit); an expansion with no pattern (must be blocked).
  - **Traps:** leading zeros, DD/MM vs MM/DD, numbers stored as text, prefix-of-ID columns (masking), a pivot (must be blocked), a column from another source (must be skipped).
  - **Registry:** 3 different sources → the same format (e.g. three suppliers' price lists → one load file). The 2nd and 3rd are learned in attach mode; expect verified with the format lock intact.
  - **Output files:** csv and tab-delimited txt, with and without a header row, in UTF-8 and Windows-1255.
  - **English LTR cases** alongside the Hebrew ones.
- **Data.** Synthetic, spread across domains so the prompt doesn't overfit one of them: an importer's supplier price lists → an ERP catalog load file (tab-delimited, no header); freight invoices → a cost report; insurer commission reports → a commission control report; a payroll export → a pension deposits sheet; a customer list → a CRM import CSV; a bank export → a reconciliation sheet. The report also breaks results down by domain.
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

All numbers are placeholders in `packages/shared/config/tiers.ts`.

| | Free (not signed in) | Registered | Paid |
|---|---|---|---|
| What it's for | try it on one small file | a person's own recurring formats | a company's work |
| Max rows per file | 300 | 5,000 | 100,000 |
| Max columns | 20 | 50 | 150 |
| Files per run | 1 | 1 | batch, up to 50 |
| Converted output | first 20 rows on screen; sign in to download | full download | full download |
| Saved formats | none | up to 3 | up to 50 new per month (DECISION 9) |
| Sources per format | none | 3 | unlimited |
| Rules per format (8.14) | 30 | 30 | 300 |
| AI learns (reach the LLM; count only when they succeed, see 21 v5) | none — sign in to use AI (the local result is shown first) | 3 per month (config: count + period lifetime | month | day) | 150 per month |
| Fast-path learns | unlimited | unlimited | unlimited |
| Edit rules | view only | yes | yes |

- **Upgrade button.** It opens a short form and records `upgrade_intent` with the limit that triggered it. There is no payment code in the MVP; paid tiers are assigned by an admin (14.2).
- **Limit tracking.** Every stop is recorded as `limit_hit { limit }`. A learn whose result needs more rules than the tier allows is still shown in full, but saving it hits the limit.
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
- **`formats`:** ownerId, name, schemaVersion, output, layout (sort and group normalized to output headers), outputValidations, origin (`learned` | `template`), versions[`{ format, editedBy, at }`], createdAt.
- **`conversions`:**
  - ownerId, formatId, sourceName, schemaVersion, rules (the full self-contained rules file);
  - inputSignature `{ columns: [{ header, aliases, type, required }] }`;
  - source, status (`verified` | `differencesAccepted` | `userConfirmed` | `draft` | `needsReview`), acceptedDifferences (count);
  - exampleExceptions: example row numbers the user marked as fixed by hand. They are used only when checking the example, never on future runs;
  - learnPath (`local` | `llm` | `cache`), masking, model, promptVersion;
  - versions[`{ rules, editedBy, at }`], runCount, lastRunAt, createdAt.

  Rules contain only real constants (after unmasking) such as labels and value-map entries. They never contain data rows.
- **`events`:** ts, anonId, userId?, type, props. Props hold counts, ids and codes only, never cell values or file names.
- **`llm_calls`:** ts, userId?, anonId?, learnId, purpose (learn | repair | escalation), model, promptVersion, masking, tokensIn, tokensOut, tokensCached, costUsd, latencyMs, outcome, cacheHit.
- **`usage_counters`:**
  - keys look like `user:<id>:<yyyy-mm>`, `anon:<id>:<yyyy-mm-dd>`, `ip:<hash>:<yyyy-mm-dd>` (HMAC of the IP; IPv6 by /64) or `repair:<learnId>` (one browser repair per learn);
  - updates use atomic `$inc`, and anon/ip keys expire through a TTL index.
- **`budgets`:** spend totals per day (overall and anonymous: `spendUsd`, `anonSpendUsd`).
- **`learn_cache`:** owner (`anon:<id>` / `user:<id>`), key (hash of the structure only), rules, promptVersion, createdAt; unique (owner, key), TTL in config. A cache entry is only ever returned to the same owner — never across users — and with masking on only rules without text constants are cached (their fake words belong to an earlier session key).
- **`leads`:** name, email, company, role, message, language, ts.
- **`waitlist`:** userId, email, trigger, message, ts.
- **`feedback`:** formatId?, userId?, rating, text, ts.
- **Not stored in the MVP: user data files** (DECISION, see section 20).

## 14. Events and admin dashboard

### 14.1 Events
- **Visits and files:** `page_view {path}`, `language_changed {lang}`, `file_uploaded {role, rows, cols, fileType, direction}`, `file_rejected {reason}`
- **Pre-flight and learning:** `preflight {status, reason?, skipColumns}`, `masking_toggled {on}`, `learn_completed {path: local|llm|cache, status, rounds, model, masking}`, `dedupe_found {action}`, `expand_found {mode}`, `unsupported_found {codes}`, `assumptions_found {codes}`, `preview_shown`
- **Accounts:** `signin_wall_shown {trigger}`, `signed_up {provider}`, `signed_in {provider}`
- **Registry:** `format_created {origin}`, `source_added {formatId, sources}`, `file_matched {auto, score}`, `format_edited {sources}`
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
  - runs per active user;
  - sources per format (distribution), and the share of formats with 2 or more sources.
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
- **Users:** set a user's tier and limit overrides. Paid customers are assigned here in the MVP.
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
5. **My formats.** Each format with its sources underneath ("Priority catalog load ← 4 sources"). Actions: Convert a file (flow C), Add a source (flow A2), Run a batch, Edit rules, Rename, Delete. For a signed-in user who has formats, Home's first action becomes "Convert a file", with "Teach a new format" next to it.
6. **Run result.** Download (file or zip), a summary (rows in, rows out, rows filtered, duplicates removed or flagged), and the flags with accept/reject.
7. **For business (`/business`).**
   - The problem: files arrive from suppliers, insurers, clients and other systems in their own layout; someone rebuilds them by hand into the company's format, or the file its system loads, every month, and errors slip through.
   - The idea: teach each format once, add each new source in minutes, and every file is checked.
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

- **M0: Engine without AI.** (Built. Apply the amendments in section 21 before starting M1.)
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
  - `output.file` detection from the example output;
  - attach mode in the payload builder, the prompt and the code checks (the format lock);
  - the eval harness with 10 cases plus 2 registry cases, in both masking modes;
  - a first model comparison report.
- **M2: Web tool.**
  - design plan first;
  - Hebrew/English + RTL/LTR shell;
  - upload → pre-flight → learn → rules map, preview and diff → full verification;
  - the rules editor (8.11), with the live match counter and one-off exceptions;
  - the masking switch with its explanation, and "See what we send";
  - anonymous limits, Turnstile, budgets and cache.
- **M3: Accounts.** (Also build the v5 changes in section 21.)
  - Google and Microsoft sign-in, and the sign-in wall;
  - the registry: formats with their sources, add a source (flow A2), convert a file with automatic matching (flow C), format edits that propagate (8.12);
  - tier config and usage counters;
  - batch conversion.
- **M4: Launch pieces.**
  - events and the admin dashboard;
  - business page with leads;
  - upgrade/waitlist and feedback;
  - privacy and terms pages;
  - deploy.
- **After the MVP:**
  - adding a source without an example output;
  - the headers-only LLM suggestion for renamed columns;
  - ready-made formats (templates) for common systems;
  - comparison with the previous run of the same conversion;
  - a customer-hosted LLM endpoint;
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
3. **Batch for registered users.** Settled: **none.** Batch is paid.
4. **Tier numbers.** Default: **placeholders**, to be tuned from `limit_hit` data.
5. **Server repair rounds.** Default: **1**. Set it to 0 for exactly one LLM call per learn.
6. **Product name and domain.** Currently a working name.
7. **Hosting.** For example: static web on Vercel or Cloudflare Pages, the API on Render or Fly, and MongoDB Atlas.
8. **Encoding of text outputs.** Default: **reproduce the example's encoding.** Which encoding each ERP load screen really needs must be confirmed with real load files from design partners before any templates are built.
9. **Paid format limit.** Default: **50 new formats per calendar month**, as stated in the business model. The alternative is 50 saved in total. Sources per format are counted separately (11).
10. **Auto-match threshold.** Default: **score ≥ 0.9 with a 0.1 margin**, tuned from `file_matched` events.

Settled in this version:
- Masking switch, on by default.
- Hebrew and English UI, with the default taken from the browser.
- Two-file learning only in the MVP.
- Google and Microsoft sign-in.
- Duplicates (remove or flag), row expansion in three patterns, and the rules editor are in the MVP.
- Formats and conversions are separate objects; a format has many sources.
- csv and delimited text outputs are first-class.
- The product is domain-neutral.
- Tiers: free (one small file, sign in to download), registered (3 formats, downloads), paid (50 formats a month, many rules, batch).
- The rules language has typed operations, functions and constant tables, all checked by code (8.3, 8.14, 9.2).

## 21. Changes in v2 and impact on the built M0

v1 treated each learned result as one independent "format" and was written around commission control. v2 keeps everything that was built and adds the registry model the product is actually about: a company's formats, each fed by many sources.

What changed:
1. Positioning (1) and non-negotiable 9: domain-neutral. Commission control is one design-partner domain, not the product.
2. Formats and conversions are separate objects (8.12). A learned result is a conversion; saving the first one also creates its format.
3. Attach mode: learning a new source into an existing format, under the format lock (5 A2, 8.12, `LEARN_PROMPT.md` learn-v2).
4. Convert a file with automatic matching to its conversion (5 C), and mixed-source batches (5 D).
5. Output file types (8.13): csv and delimited text, with or without a header row, in several encodings, for system load files.
6. Validations get `on: input | output`; output validations belong to the format (8.8).
7. One LLM interface (9.6).
8. Eval data spread across domains, plus registry and output-file cases (10).
9. Data model: separate `formats` and `conversions` collections (13).

**M0 amendments** (do these before M1):
- **Schema:** add `output.file` (8.13) with default `{ type: "xlsx" }`; add `validations[].on` with default `"input"`; add optional `meta.formatId` and `meta.sourceName`. Keep `schemaVersion: 1`: every new field is optional, with a default that reproduces v1 behavior, so rules files written in M0 load and run exactly as before. Add a test that proves it on the existing golden files.
- **Engine:** run output validations after the layout step, on the final data rows, by output header.
- **Writer:** csv and txt with delimiter, header on/off, quoting and encoding (UTF-8 with BOM, UTF-8, Windows-1255); formula-injection protection; a byte-identical determinism test for each variant.
- **Reader:** detect the delimiter, header presence and encoding of csv/txt files. M1 needs this to detect `output.file` from an example output.
- **Registry helpers:** a pure function `formatOf(rules)` that extracts the format side (output, sort and group normalized to output headers, output validations), and `checkFormatLock(rules, format)` that returns problems. Unit-test both.
- **Golden tests:** add at least 2 rules files outside insurance (a supplier price list → tab-delimited load file with no header; a customer export → CSV), and one pair of conversions that share a format and pass `checkFormatLock`.
- **Naming:** rename domain-specific names in code and test titles wherever they describe the product rather than one test case (e.g. nothing called `commission*` outside fixtures).

### v3 changes

1. The core pipeline is stated explicitly (1): two files → deduce → rules file → engine.
2. B2B is the business; the public app is a proof of concept and demand funnel. Paid tiers are assigned by an admin in the MVP (1, 11, 14.2).
3. Tiers rewritten (11): free, registered, paid; batch is paid only; a rules-per-format limit.
4. A richer rules language (8.3): more operations, `switch`, `lookup`, typed signatures; functions and constant tables (8.14).
5. Layered checking of LLM output (9.2): structure, references, static types, limits, format lock, overfitting lint, sample run, full verification.

**M0 amendments for v3** (together with the v2 list above, before M1):
- **Engine:** the new operations in 8.3, with decimal.js arithmetic and flags on failure; `switch`, `lookup`, `call`, `param`; `rowFilters` with `{ expr }`.
- **Schema:** `transform.functions` and `transform.tables`, both optional; still `schemaVersion: 1`.
- **Type checker:** one signature table for all operations, and `typeCheck(rules, inputProfile?) → problems[]`, pure and usable in the browser and the API. Unit-test each operation's signature, the widenings, and rejection of mismatches.
- **Limits:** `checkLimits(rules, tier) → problems[]` for depth, node budget (after expanding calls), function and table counts, call-graph cycles, table key uniqueness and the rule count.
- **Golden tests:** one rules file that uses a function in three columns, one that uses a lookup table, and one that uses `switch`.
- M1 adds the overfitting lint and learn-v3.

### v4 change: generic summary rows

`output.grandTotal` and `transform.group.subtotal` (8.1: sum-only, one label, ids) are replaced by generic `summaryRows` (8.6, 8.12): any number of rows, each naming, by OUTPUT HEADER, the aggregate (`sum`, `count`, `min`, `max`, `average`, `first`, `last`) that fills each cell - so a summary row belongs to the format like the rest of `output`, with no id translation (8.12). A summary-output column's own `agg` (8.6) gains `average`/`last` too, for the same set either way. Each `summaryRows` entry counts as one rule (8.14). Stored rules files keep `grandTotal`/`subtotal` loading and running byte-identical; the LLM (`learn-v4`) only ever writes `summaryRows`.

### v5 changes (owner decisions, 2026-09-30) — build in M3

1. **AI only for signed-in users.** Free (not signed in) users get everything that runs locally — pair analysis, pre-flight, the fast path, the editor, converting — but never an LLM call. When their example needs the AI step, show the **local result first**: the rules map with every column code could explain (verified against the example) and the columns that need the AI step marked "Needs the AI step", with a popup: "We worked out N of M columns on your computer. K need the AI step — sign in free to finish (3 AI formats a month included)." The learned local rules survive sign-in (5 E). `POST /api/learn` answers 403 `{ error: 'signInForAi' }` for anonymous callers.
2. **AI learn quota in config** per tier: `aiLearns: { count, period: 'lifetime' | 'month' | 'day' | 'unlimited' }` (registered default 3 per month, paid 150 per month; anonymous 0). Changing the numbers or the period is config only.
3. **What counts as one AI learn:** a learn counts **once, when it succeeds** (the result verifies against the example, or the user saves it with accepted differences). A failed attempt doesn't count — but after **3 failed attempts on the same example pair** (config `maxFailedAiAttempts`) the app stops, counts it as one learn, and tells the user plainly what was tried and what to change. Repairs inside a learn never count separately.
4. **AI readiness gate before any LLM call.** The AI step is the critical, costly path, so code must first be confident the call can succeed. In addition to 6.3, stop before the LLM — with a specific message and what to fix — when: rows between the two files can't be aligned (no "try anyway" into the LLM); fewer than 3 aligned data rows; more than 10% of output data rows can't be matched to an input row; a column's values mostly fail to read as its detected type (e.g. dates in two formats); every column the code couldn't explain is external data (the AI can't help — finish locally with those columns marked "needs your input", no LLM call); or the payload still exceeds its caps after trimming. None of these consume a learn.
5. **Conversion-time review of unmatched rows (flow C/D, issue #36).** When a new file converts with flagged rows, show them before the output is written; per row the user picks: change the rule (opens the editor, converts again), fix this row only (a one-off value edit, not saved to the rules), skip the row, or keep it as is. The engine takes these per-run row decisions without modifying the saved rules, and lists them in the run summary.
