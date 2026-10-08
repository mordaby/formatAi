# formatAI — product and technical specification

> **2026-10-07 · current state; history in [docs/spec-history.md](docs/spec-history.md).**
>
> - This file says how the system works NOW. When and why each part was decided is in the history; a tag such as "(decided 2026-10-06)" points to that day's entries there.
> - Read this file, and `LEARN_PROMPT.md`, before changing the code. The exact LLM prompt lives in `LEARN_PROMPT.md`; keep the two in sync.
> - **DECISION** marks a choice made while building (the code carries a `// DECISION:` comment). The ones still open are in section 20.
> - A change of behaviour rewrites the section it touches here and appends a dated entry to the history.

## 1. What we're building

A web tool that learns a company's file formats from examples, keeps them in a registry, and converts incoming files into them. Conversion is deterministic and uses no AI at run time.

Companies receive files from other parties (suppliers' price lists, insurers' commission reports, clients' exports, other systems' reports), each in the sender's layout. Someone rebuilds them by hand into the company's own format, or into the exact file their system (Priority, Hashavshevet, SAP B1, a CRM) loads, and checks them. The receiving side usually can't make the sender change its layout. That manual work, and the errors in it, is what this tool replaces.

Three words, used the same way everywhere (code, UI, docs):
- **Format:** the shape of a file the company produces: columns, types, layout, file type and checks. Formats belong to the company (8.12).
- **Source:** one kind of incoming file, e.g. one supplier's price list, or a master file that is updated all the time but keeps its structure. Sources belong to the company too (8.15). A source can feed several formats, and a format can be fed by several sources.
- **Conversion:** the rules that turn one source into one format: a link between a source and a format. A format usually has several conversions, and a source can have several too.

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
- A masking switch, and a per-column choice of what is sent (7.2).
- A rules map with an editor, where users fix or add rules and see a live count of matching rows.
- A preview with a diff against the example, and flagged rows.
- Google and Microsoft sign-in.
- Saved formats and sources, re-running, and batch conversion (mixed sources allowed; the files per run depend on the tier, 11).
- Tier limits, and an AI-learn quota for signed-in users (the AI step needs a sign-in).
- An admin view (14.2).
- A business page with a lead form, the paid waitlist, feedback, and privacy, terms and accessibility pages, all in Hebrew and English.
- A model evaluation harness.
- One Render web service with MongoDB Atlas (4 "Deployment").

**Next, after the MVP:**
- Adding a source from its input file alone (no example output), mapped to the known format.
- A headers-only LLM suggestion when a known source renamed its columns (headers only, never values).
- Ready-made formats (templates) for common systems, e.g. Priority load screens.
- Comparing a run with the previous run of the same conversion (row count, totals) and flagging unusual changes.
- A customer-hosted LLM endpoint (9.6).
- Learn a new format from a known source (the payload carries the source; only the output is new).
- Run all formats of a source in one click after the source file was updated.
- A Sources tab: the company's sources with their columns and the formats each one feeds (8.15); rename, and delete when unused.
- Choosing a saved source as the input of a conversion, instead of dropping a file.
- Learning from an input file plus a text description, and from a description alone.
- A side-by-side, merge-style view for resolving flags.

**Out for now** (design so these can be added later):
- PDF, PowerPoint or Word input.
- Multi-table sheets and multi-row headers.
- Pivots (rows becoming columns), and row expansion that fits none of the three patterns.
- Joining two input files, and file comparison/reconciliation.
- Email intake.
- Storing user data files.
- Payments and on-demand AI (the "Upgrade" button opens the paid waitlist, 11; 20.14).
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
- **Identifier shapes:** validator.js, one file per check (`isIdentityCard` he-IL, `isMobilePhone`, `isEmail`, `isCreditCard`, `isIBAN`), wrapped in shared `identifiers.ts` (7.2, 8.11 "Saving").
- **Other:** JSZip for batch downloads, MongoDB, Cloudflare Turnstile (the public forms only), and `@fastify/static` (the API serves the built web app). The font, IBM Plex Sans Hebrew 400 and 500, is self-hosted (`apps/web/public/fonts`, with its OFL); no third-party font or stylesheet is loaded.

Where each step runs:

| Step | Runs in | Sees real data? | Costs tokens? |
|---|---|---|---|
| Parse, table checks, profile, pair analysis, pre-flight | Browser (worker) | Yes | No |
| Local fast path (simple formats) | Browser | Yes | No |
| Masking and building the payload | Browser | Yes | No |
| Learn call, code checks, engine on the sample | API → LLM | Only if masking is off, and only the sample rows | Yes |
| Unmasking constants, full verification | Browser | Yes | No |
| Converting single files and batches | Browser | Yes | No |

The worker holds the Result screen's example, so cancelling a call never restarts it (a call not begun is dropped, a begun one is told to stop); a call's busy time counts from when the worker begins it, so a check queued behind a round of AI code checks is waiting, not hung, and a worker that hangs is still restarted (decided 2026-10-07).

**Deployment.** One Render web service on its `onrender.com` address, MongoDB Atlas, and nothing else of ours to run. The Node process serves the built web app and `/api` from the same origin, so the session and `anonId` cookies are first-party (httpOnly, Secure, SameSite=Lax) and there is no CORS and no second domain; the OIDC redirect URIs are `<origin>/api/auth/<provider>/callback`, with the origin from `PUBLIC_ORIGIN` or Render's `RENDER_EXTERNAL_URL`. Every secret lives only in Render's environment (never in the repository or a chat); `render.yaml` is the Blueprint and `docs/deploy.md` the owner's checklist. In production the LLM provider is `openai` for now, with no fallback (owner, 2026-10-08); the designed setup, to return to, is `anthropic` with `openai` as the fallback for a call Anthropic cannot serve (the `claude-cli` provider is development only; 9.6), and a process that is missing any required setting exits at start, listing each by name and never a value. The production check also requires `SESSION_SECRET` and `IP_HASH_SECRET` of 32+ characters, both Turnstile keys (unless `TURNSTILE_DISABLED=true`, which turns Turnstile off and warns at every start), one complete sign-in provider, an https origin, the built web app, a price for every configured model (9.4), a valid `LEARN_CHECKS` and, with a fallback, the fallback's key. Hashed assets are cached for a year, `index.html` always revalidates, page routes fall back to `index.html` (never `/api/*`), and every response carries a Content-Security-Policy that allows only what the app loads (`'self'`, Cloudflare Turnstile, the Google avatar; fonts from `'self'` only), `nosniff`, `Referrer-Policy`, `frame-ancestors` and HSTS on https. `render.yaml` runs one instance (the per-IP limiters are in memory) with `TRUST_PROXY=true`; `docs/deploy.md` asks the owner to set it to the measured hop count.

**API surface** (all JSON, all under `/api`; no route accepts a file). Learn: `POST /learn`, `/learn/step` (AI code checks), `/learn/repair` (a loop round), `/learn/:learnId/outcome`, `GET /learn/quota`. Registry: `GET|POST /formats`, `GET|PATCH|DELETE /formats/:id`, `POST /formats/:id/conversions`, `GET|PATCH|DELETE /conversions/:id`, `GET /conversions/:id/versions`, `POST /conversions/:id/restore/:version`, `POST /conversions/:id/runs`, `GET /sources`, `GET|PATCH|DELETE /sources/:id`, `POST /sources/:id/aliases`, `POST /sources/:id/ignored-headers`, `GET /signatures`. Accounts: `GET /auth/providers`, `GET /auth/:provider/start|callback`, `POST /auth/logout`, `GET|PATCH /me`, `POST /me/link/:provider/start`, `GET /session`, `POST /dev/session` (development only, 12). Public forms: `POST /leads`, `/waitlist`, `/feedback`. Admin: `/admin/*` (14.2). `GET /health`.

## 5. Main flows

### A. Learn from two files (MVP)
1. The user drops an example input and an example output. The browser parses both and runs the table checks (6.1).
2. Pair analysis runs on all rows of the real data (6.2). Pre-flight either blocks, warns, or continues (6.3–6.4). A block costs nothing.
   - **What the user already has** (decided 2026-10-07). A format is the OUTPUT; each kind of input file that makes it has its own rules, kept as a "source" behind the scenes (8.12, 8.15). A signed-in user with saved formats who starts a learn on Home (**Learn the format** or **Learn with AI**): before the fast path and any AI step, code looks for a saved format with this example's output - the parts of 8.12 "Same format" an example shows before its rules exist: the headers in order (spaces around and inside a header do not count), the file kind and a header row, the title rows (how many, which are blank), how many summary rows, the grouping column. Only such formats are read in full. Then, for each (most recently used first), whether the example input is one of its inputs (the matching of 8.12 "Same format"):
     - **It is, and the saved rules make this example exactly** - that conversion's saved rules run on the example, in the worker, with the learn's own full verification (every row and cell, the row count and the row order, the title, header, blank and summary rows, the file settings): nothing is learned, no AI format is spent, nothing is saved, and the screen says so once - not an error: "**You already have this format**" / "Your format **X** already makes this output from this file." - with **Convert files with it** (that format's Run screen, the example input already dropped), **Learn again anyway** (the learn the user asked for, without this check) and **Choose other files** (an empty form, the first drop zone focused).
     - **It is, but the saved rules make other values** (the logic changed): the learn goes on as usual; the result says so in one line ("Your format **X** gives different values for this example, so the rules were learned again."), and Save asks whether to update it (step 8).
     - **It is not** (another kind of input file): ONE question, before anything is learned - "**This output matches your format**" / "This output matches your format **X**. Is this file another input for it?" - **Yes, learn it for X** / **No, make a new format** / **Choose other files**. Yes is the learn against that format, exactly as A2 learns a new input (the format's output side locked, `target`; the free engine first, "Finish with AI" on the user's click as the whole learn against it), remembered for the session: Save then adds the file as another input of that format (the attach route: the server reuses or creates the source, 8.15; its plan limit and the format lock hold), with no further question (the lists / identifier popup still asks when it applies, 8.11). No is a learn of its own: Save creates a new format, as ever. Several formats: the same question with a radio list, most recently used first and chosen; the answers follow the one chosen. A format that already takes as many input files as the plan allows (11 "Sources per format"): "**X** already takes N different input files (your plan's limit)." with the upgrade, and only **Make a new format** / **Choose other files**.
     - None of this names a source, and none of it depends on the feature switch (8.12). A visitor, a user with no saved format, an output no saved format has: no change, no extra work and no wait (the headers are compared: well under a millisecond; running one saved conversion on a 20,000-row example takes about a quarter of a second, beside a learn of about 5 seconds). Nothing new leaves the browser: the saved formats and rules are the user's own, read from the API, and the example is compared in the worker. Not on Add a source (A2), "Finish with AI", or a learn after "Learn again anyway", "No" or "Yes".
3. **Fast path** (6.5): if code alone explains every output column, the rules are built locally and the flow jumps to step 7.
   - Otherwise the free result is shown (the columns code solved, verified against the example, and the missing fields), and **the AI step (steps 4-6) is the user's choice** (decided 2026-10-01, one button 2026-10-04): the one **Finish with AI** button on the result screen, or, from the start, Home's **Learn with AI** next to **Learn the format**, which runs this free step first and then the AI step on whatever is missing (nothing missing: no AI call, nothing counted, and the result says so). The AI step completes only the missing fields (completion mode, 7.3 `complete`) when at least `limits.learn.completionMinFixedShare` (0.5) of the output columns already have a rule, and runs the whole learn otherwise, after "This replaces your current rules" when that would replace the user's edits. A visitor who presses Learn with AI is asked to sign in first, and the learn carries on by itself after signing in (5 E).
   - Columns no detector explains are never dropped from the AI step's job: it is asked for every column with no rule, including the ones that may come from another source (decided 2026-10-01).
   - **The AI readiness gate** (no LLM call, nothing counted) blocks only what is certain to fail even with the AI: no output data row can be matched to an input row ("the two files don't seem to come from the same data"), or the payload still exceeds its caps after trimming (it says which part). Few matched rows, some unmatched output rows or partly unreadable values are not blocked.
   - **Honest partial delivery.** When fields still cannot be produced (the language cannot say them, or the AI answered unsupported): "This is the best we can do for now: N fields need a rule we can't build yet." The user can download the file with those fields empty, fill them in the editor, or save with them marked "needs your input". Never shown as an error.
4. The browser builds the payload, masked or not according to the switch and the per-column choices (7). "See what we send" shows the exact rows and request, and lets the user choose per column what is hidden (7.2).
5. `POST /api/learn`. The API:
   - checks the sign-in, the limits and the cache (9.5);
   - makes **one stateless LLM call** (9): the system prompt plus one user message, with no chat history (with the AI code checks on, learn-v9, the call may first ask code a few questions: 9.1; off by default);
   - runs code checks and the engine on the sample (9.2);
   - if the result is still wrong, makes at most one repair call (config) and, if the first-try model still fails, one escalation call (9.4); each is also a single stateless message.
6. The browser unmasks constants in the returned rules (7.2), fills the data parameters from every row (9.2 layer 8), runs the rules on the full real input, and diffs the result against the full real output.
   - If everything matches, the format is **verified**.
   - If not, the learning loop (9.3): up to 3 browser-triggered repair rounds, each sending some of the rows the rules got wrong, while each round lowers the number of wrong rows (all of it one learn, 11). If the loop ends without verifying, show its best answer with the mismatches, name the rows that still differ per column, and let the user fix the rule or leave that column empty for now (8.11).
   - When the kept answer takes a column from a list of fixed values, one more automatic round asks for the rule behind it (9.3 "Lists"). Then the questions code has for the user are asked on the result screen: a column the example fits two readings of, the day/month order of a date, a one-time edit (8.11).
7. Show the rules map with its editor (8.11), the preview and the flagged rows.
   - Anonymous users see 20 rows.
   - Downloading the full file or saving the format requires sign-in.
   - **Try it on another file** (everyone, signed in or not): the user drops one more input file and the CURRENT rules (unsaved edits included) run on it in the browser. It shows the same run result as flow C (rows in and out, flagged rows with the row review before the file is written, missing required columns), one file at a time, with no network call and nothing saved. It is the first taste of using a format; signed-in users use it to check the rules before saving. Anonymous users see the result on screen (20 rows) and sign in to download it.
8. **Saving** creates two things: a **format** (the output side: columns, layout, file type and output checks) and its first **conversion** (this input → that format), and creates or reuses the source (8.15) - unless the learn was for one of the user's formats (step 2: Save adds the file to it as another input, with no question) or its output and input are one of the user's formats' (below). See 8.12.
   - **Save format** only saves (decided 2026-10-04): the user already has the output. **Download the file** is a separate button beside it, before and after saving: it converts the example input with the rules on screen, in the browser (a visitor is asked to sign in; it is off while the rules are blocked or the AI step is working).
   - **Update your format X, or save as a new format?** (decided 2026-10-07; whatever the feature switch says) The same output learned again from the same kind of input file - next month's, with other values - must not make a second format by accident. Before Save creates a new format, the learned output is compared with the user's saved formats (8.12 "Same format"), and the example input with their inputs (the matching and threshold of flow C, 8.12); when this input already feeds one with this output, the Save popup asks first, once, with no "source" in it: "**Update your format X, or save as a new format?**" - **Update X** / **Save as a new format** / **Cancel**. Update saves the learned rules as a new version of that input's conversion through the editor's route (8.11, with the version just read as `baseVersion`); earlier versions are kept. When the rules' output side differs from the format (the format lock), the update changes the format, and the popup says so when other input files feed it: "Updating changes the format for its other N input files too."
     - Several formats: a radio list, the most recently used first (its last run or last change) and chosen; the buttons follow the one chosen.
     - Another input for a format is never asked here (it is asked at Learn, step 2); #75's "Add as a source" at Save is gone.
     - With nothing matching, Save works exactly as before, with no extra click and no wait (the list of formats is read when the result shows). Only formats whose headers and file type agree are read in full, with the sources' signatures; the comparison runs in the browser, on structure only. It is asked on the first Save of a learn only - not by the editor's saves of a saved input, nor by the Run screen's "Do this every time?", nor for a learn that was for a chosen format.
     - After an update, or a save into a chosen format, the screen is the editor of that input's rules, as after any first save.
   - When the rules about to be stored keep a list of fixed values or an identifier-shaped value, one popup asks before anything is sent (8.11 "Saving", decided 2026-10-06) - with the update question above, the same popup (never two dialogs in a row); every other save takes one click.
   - After a successful save the learn page starts empty the next time it shows (no click; decided 2026-10-07). Left without saving, the files stay; a small **Clear** link empties the form, asking once ("Clear the files?") only when an unsaved learned result would be lost.

### A2. Add a source to an existing format (MVP)
A company receives the same kind of file from several parties (suppliers, insurers, clients), each in its own layout, and turns all of them into one format. The first source creates the format (flow A). Every other source is added to it. This screen is part of the explicit source UI ("Formats with several sources", 8.12: while that switch is off there is no "Add a source" anywhere); the same learn is reached from Home whatever the switch says, when the learned output is one of the user's formats and the user answers **Yes, learn it for X** (5 A step 2):
1. The plan's sources per format (11) is said before the user starts: a format at its limit shows "**X** already has N sources (your plan's limit)." with the upgrade on its card, its page and the Add a source screen, instead of a way in (the same count the API checks). Otherwise the user opens a format → **Add a source**, optionally names it (e.g. the supplier; empty, the server names it after the example input file, 8.15), and drops that source's input file and an output they made from it by hand. The output must match the format (same headers in the same order and the same file type); if it doesn't, say which columns differ.
   - Flow A detects this case too, at Learn, before anything is learned (5 A step 2): "This output matches your format X. Is this file another input for it?" - and Yes runs this same learn on the Home's files, with no screen of its own.
2. Everything in flow A runs as before (pair analysis, pre-flight, fast path, masking, verification), with one difference: the payload includes `target` (LEARN_PROMPT section 3) and the output side is fixed by the format lock (8.12). The LLM only decides how this input produces the format's columns.
   - **The free engine first; the AI step only on the user's click** (decided 2026-10-07, like Home and the Result screen). The learn starts with the AI step not allowed: the fast path, else the local partial result, each with the format's output side TAKEN from the format (engine `conformToFormat`): the file settings, sheet name, direction, language and header style, every column's header, number format, width and aggregate (each column keeps its own rule), the summary rows and the output checks; the sort and the grouping translated from the format's headers to the ids that fill them. A part code cannot translate - a sort or group by a column no rule fills yet, a title row that reads a column this source's rules don't declare (title rows keep the ids of the format's first source) - is left for the AI step. The fast path's result is used only when it then matches the example.
   - The result shows what the free engine solved and what is left, as the Result screen does, and **only when something is left** the same deep-analysis panel offers **Finish with AI**, with its quota line, the out-of-AI-formats dialog (11) and "See what we send" once something was sent. Here it is always the whole learn in attach mode, with the AI step allowed (completion mode is not combined with a format target), after "This replaces your current rules" when the result was edited; counted as one AI learn only if it succeeds. A quota refusal at learn time opens the out-of-AI-formats dialog over the form, with the files kept. Nothing left: no panel, and Save adds the source.
3. Output columns this source can't produce are `unsupported` as usual. The format is never changed to fit a source.
4. Saving creates a new conversion under the format.

Adding a source *without* a hand-made output (the input file alone, mapped to the known format) comes after the MVP. Such a conversion can only be `userConfirmed`, never verified.

### B. Learn from a description (after the MVP)
There are two variants:
- **Input file plus description.** The output is confirmed by the user rather than verified.
- **Description only.** This produces a draft whose input columns are guesses. The guesses are mapped to real headers on the first run.

Keep this in mind in the schema (`meta.source`, `meta.status`), but don't build it yet.

### C. Convert a file
The user drops a file on **Run a format** (in the header and on Home, or on a format's page). They don't have to say which source it is:
- code matches the file's headers against every saved **source** (8.15), and either picks the source or asks the user to choose among the top matches. If the source feeds one format, its conversion runs; if it feeds several, the user picks the format(s), or "all" - none is ticked in advance (owner, 2026-10-08: two senders can use the same column names for different things, so every format made is one the user ticked; a single ready format, the others needing attention, is ticked);
- renamed columns are matched through aliases or offered to the user for mapping first, once per source: a required column the file lacks, that a format uses, while the file has columns nothing claimed and the source did not already know (8.15). The step names the formats that use the column. A confirmed mapping is saved once, as a new alias on the source, and holds for every format of it;
- what the file still lacks is then settled **per format** (decided 2026-10-03), never by stopping them all. A format needs a column when it is required, or when its rules use it even though it is optional (a column that had empty cells in the example is optional, and is still used); a declared column nothing uses may be missing. The formats that need none of the missing columns run as usual; each of the others is listed under **Needs attention** with the column names ("Management report uses 'Supplier SKU', which is not in this file") and the user decides: **Open in editor**, **Skip this time**, or - when only optional columns are missing - **Run anyway (leave 'X' empty)**. A missing required column cannot be run anyway. When no format can run, it is the missing-columns stop, naming the columns and every format it affects;
- **same name, different meaning** (decided 2026-10-03): after a format runs, a used column whose values (at least `limits.matching.parseFailShare`, 0.9) mostly failed to parse as the type it was saved with puts that format under Needs attention ("The values in 'X' don't look like before (expected a whole number)") with **Open in editor** and **Run anyway**. Smaller shares are the row review's business, as before. Only counts from the run's flags are used; no value is shown or sent;
- **the row review** (decided 2026-09-30; "Do this every time?" 2026-10-04): the flagged rows are shown before the file is written, and per row the user picks **change the rule** (the editor, then convert again), **fix this row only** (typed values for this file; the saved rules are not touched), **skip** or **keep as is**. **Do this every time?** is one quiet, unticked choice next to a typed fix of ONE cell, with a line that says what it means ("Every 'N/A' in Amount will be read as empty.", how many rows in the list have that exact text, and, when the source feeds more than one format, "This changes the source for N formats."). Yes turns the fix into a rule: the cell's exact original text becomes a key of the input column's `readAs` (8.4a) and the typed value (nothing typed = empty) what it is read as. It is saved at **Create the file** (until then the fix can be undone) as a NEW VERSION of the conversion through the editor's route, with the version the browser just read as `baseVersion` (a conversion changed meanwhile is refused, never overwritten); as an edit of the input side it reaches every format of the source (8.15), and restoring the version before it undoes it for all. The run goes on with the rule (one yes covers every row with the same text) and next month the value is no longer flagged; the screen then says what is now read as what, the version and how to undo it. Only for a typed fix of a cell that IS text in the file, not for skip or keep, not where rules are not saved ("Try it on another file"), not for a conversion that needs review, not for a text or value over `limits.rules.maxValueChars` (300); two rows that keep the same text as different values cannot both be ticked. A fix whose text or value has an identifier shape asks first ("**Qty** keeps an ID number in its fixes.": **Keep it** / **Save without it**, a one-off for this file / **Cancel**, back to the review; decided 2026-10-06). A save that fails does not stop the file: the fix is used for this file and the user is told it was not saved;
- extra columns are ignored. A column the source doesn't know (after names, aliases and the renames just confirmed) is mentioned once, quietly, after the run: "New column in this file: 'X'. No format uses it." with **Add it to a format** (the editor of one of the source's formats, a small choice when there are several) and a dismissal that is remembered per source (header names only, 8.15). It is never added to an output automatically.

The result is a download plus flagged rows. No LLM call. Nothing is changed for the user: they see what still works and what needs a decision, and decide what to fix and how.

### D. Batch
Same as flow C with many files, processed one at a time in the worker. A batch may mix sources: each file is matched on its own, and results are grouped by format. Every file is matched first ("Reading file n of N"); when some matched file's source feeds several formats, the batch asks ONE question before converting (owner, 2026-10-08): the formats the matched files can be made into, each with how many of the files it takes, none ticked, with an "All" toggle - each file is then made into the chosen formats its source feeds, and a file none of whose formats was chosen is **not made** (said so in its result and in the summary sheet). "Back" converts nothing. When every matched source feeds one format (always so on `?format=`), nothing is asked. Each file gets a status: converted, converted with flags, didn't match, or not made - and, per format, **needs attention** (decided 2026-10-03): a format that uses a column the file doesn't have, or whose used column's values mostly didn't parse as before, is not made (withheld from the zip) and says why (the columns or the column and its type) in the file's result and in the summary sheet, while the file's other formats are converted. Beyond the formats question a batch asks nothing, so there is no "Run anyway" or editor trip there: that file can be run on its own. The user downloads a zip plus a summary sheet of flags per file, or any converted file on its own (a Download beside it in the results, owner 2026-10-08). No LLM call. Batch is not paid-only: it is limited by tier (11), up to 5 files per run for registered accounts and up to 50 for paid ones. More files than the plan allows are cut to the first N, with a message (a registered user is also told that paid plans run up to 50).

Flows C and D are one **Run screen** (`/convert`, opened from **Run a format**; `/batch` redirects to it): one dropped file is flow C, several are flow D. `?format=<id>` limits both to that format's conversions. The drop zone takes up to the plan's files per run.

### E. Sign-in wall
Shown when an anonymous user tries to download the full output, save a format, run a saved format (the Run screen), presses **Learn with AI** (the `ai` reason; where the result screen would offer **Finish with AI**, a visitor sees the sign-in prompt instead), or goes over an anonymous limit.
- Copy: "Sign in to save this format and reuse it on next month's file."
- Buttons: **Continue with Google** first, then **Continue with Microsoft**.
- The learned rules survive sign-in, so nothing has to be redone: the two example files and the edits are kept in the browser's IndexedDB for the trip to the provider, and deleted on their hour (read and dropped at every page load, a timer for a fresh one, and an open tab looks every 5 minutes for one another tab kept; decided 2026-10-07). When the wall was opened by Learn with AI, the kept record says so (`deepAnalysis: true`, with the two files and no result) and the learn starts by itself once the app comes back signed in; a visitor who did not sign in after all gets the two files back on Home and nothing starts.
- **An ended session keeps the page** (decided 2026-10-07): a screen of the account (Add a source, a format, the saved-source editor) stays mounted with its work when the session ends; a notice and the sign-in wall stand over it, and signing in from there opens the provider in a new tab, so this one carries on where it was. Signing out on purpose makes the screen a visitor's at once.

## 6. Intake, pair analysis and pre-flight

Everything in this section runs in the browser, on the real data, and costs no tokens. The thresholds quoted here and in 7.1 (the 15-row header search, 2,000 sample rows, 0.9 coverage, 50 value-map entries, 5 breakpoints, the 200-shuffle chance test, the 95% Israeli ID share and the like) live in config, `limits.analysis` (`packages/shared/src/config/limits.ts`), not in code (section 2, item 8); a test pins the values quoted.

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
   - text: `copy`, `normalize` (trim, case, quote marks and geresh), `padLeft` (a pad character other than "0" needs pads of different lengths in the example; with one length it is fixed text in front, a template), `substr` (prefix, suffix, fixed position; on a column of text dates it cuts only at whole parts, never inside a run of digits), `concat` (whole words from 2+ input columns with a separator), `template` (short fixed text around/between at most 2 input columns, e.g. `<id>:"<name>"` — tried only when nothing simpler explains the column, used only when it holds on every row and exactly one template fits; at most `limits.learn.template.maxLiteralChars` (6) characters in one place and `maxTotalLiteralChars` (10) in all), `valueMap` (a consistent correspondence with an input column, at most 50 distinct values, and only with repeated keys confirming at least two of the values it writes; a row that repeats an earlier row in every column confirms nothing), `constant` (one value on every row, reported only when the input cannot also write that value on every row: a column that holds it, the month or year of a date column in any date format the column mixes, a fixed part of a text such as a prefix, or fixed text within the template limits around the one value of an input column ("Area North" with a Group column that is "North" throughout); the example cannot tell a fixed label from a value of the data, and a label built from one month is wrong next month, so such a column is not a `constant`: the user is asked which reading is meant (6.5, 8.11; decided 2026-10-04), the data reading being kept until they answer; only when no reading of the data can be written as a rule (a date column that mixes formats, the template reading) is it left to the AI step, as `derived` with a `dependsOn` hint on the column that can write it, or with the relation that fits it as the hint);
   - formats: `dateFormat` (from → to), `numberFormat`;
   - numbers: `mulConst`, `addConst`, `add`, `sub`, `mul` and `div` between two input columns, and `sum` of several columns, each with rounding detection;
   - summaries: `aggregate` (sum, count, min or max per group);
   - dropped rows: `filter` (an input column whose values separate kept rows from dropped rows: a set of values, emptiness, or a numeric threshold);
   - dropped rows: `dedupe` (the dropped rows are copies of kept rows, either on every column or on a key column; records whether the first or the last copy was kept);
   - anything else: `unknown`. An unknown column is then split: **derived** when its values are determined by input column(s) — a category that always follows one or two input columns (repeated keys), or contiguous bands of a numeric or date column (e.g. `Qty < 10 → single`, `>= 10 → bulk`: at most 5 breakpoints, at least 2 rows per band, the fewest bands win), or text composed from input values (an input column's value of at least 2 characters appears inside the output cell on at least 90% of the rows, `limits.learn.compositionMin*`, e.g. `312345002 - Dana Cohen`) — sent to the LLM with a `dependsOn`, `bands` or `contains` hint; or **external** when nothing in the input determines it (only these are "another source").
     - **Bands on a computed output column** (decided 2026-10-05): a column still external once every relation is known (not in a summary shape or a fan-out position) is tested again, sorted by each other OUTPUT column that an arithmetic relation explains at coverage 1 and that holds numbers (a class by a total that is `Qty × Price`). It is then derived; its `bands` hint carries `onOut` (that output column) and `in` (the input columns behind it). Nothing is built by code.
     - **Bands must beat chance** (decided 2026-10-05): a band rule is reported only when it passes a permutation test - the output values shuffled among the rows 200 times (seeded from the data, so it stays deterministic), the same search run on each over every column it tried, and the rule dropped when a shuffle fits at least as well on more than 1% of them. Skipped above 1,000 rows.
   - across rows: a group's total on every row (`groupSum(x, by: g)`) or a count per group (`groupCount(by: g)`), exact on every aligned row (not a copy of the column, 2+ groups with a group of 2+, never the alignment key as the group; two equally fitting columns build nothing). It outranks a value map or a constant the same cells also fit. The order-dependent patterns (running totals, row numbers, previous / next, fill down, rank, group average / min / max) are never built by code: they are sent as `rel: "window"` hints (`limits.learn.window.hintsEnabled`, on) and left to the AI step and the editor.
   Inside a family, each output row is tested against its source input row, together with the columns the family pattern creates (label, value, part).
5. **Detect layout:**
   - title rows (and whether they contain a date or month);
   - blank-row rules (e.g. one blank row after each change in a column);
   - subtotal rows and what they sum, and the grand total;
   - sort order;
   - number formats and output direction;
   - the header row: an output of one column has a header when its first non-empty cell is text, and in the pair's header check the row the header reading takes as the header decides (explained as a data row, the file has no header) - not row 0, which under a title is the title.

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
- **Some output columns are external** (unknown and not derived, see 6.2 step 4): an informational note only, never a stop, with no Continue/Cancel: "We couldn't find these columns' values in your input file. The AI step will try them; if they come from another source they'll stay empty." They are NOT skipped: they go to the AI step as normal output columns (it may answer `unsupported` with `externalData`), so `skipColumns` holds only columns the user explicitly marks to skip (nothing sets it today). "Code found no relation" is not certainty (decided 2026-10-01).
- **Some rows couldn't be aligned** (output data rows with no input row). Show "We couldn't match rows between the two files. Are they from the same data?" with a **Try anyway** button, which runs the learn as usual (an AI learn still counts only if it succeeds, 11). When no row at all can be matched, the AI readiness gate blocks the AI step (5 A step 3).

### 6.5 Local fast path
If every output column has a hint with coverage 1.0, any dropped rows are explained by a `filter` or `dedupe` hint, no rows expand, and the layout needs nothing beyond constant title rows, the rules are built from the hints in code. They are verified as usual and finished without the LLM.

A column that is one value on every row and that the input could write too (6.2 step 4, `constant`) is never built here as a constant, and is not left to the AI step either (it would see the same rows): the example fits several rules, so the free engine returns the readings (the constant, and each data reading the example proves on every row: a copy, a prefix, a part of a split text, a date format) as ready-to-apply rule fragments, builds the column from the data reading, and adds a check that flags a run-time row where the readings differ. The result screen asks the user once (8.11); the answer is the rule. Where the data has no reading that can be written as a rule (a date column that mixes formats), nothing is built and the column goes to the AI step as before.

This covers renames, reorders, dropped columns, reformatting, padding, value maps, simple calculations, group totals and counts, filters and duplicate removal. Fast-path learns don't count toward any limit, because they cost nothing. (The `learn_completed { path: "local" }` event is defined but not written yet, 14.1.) When the strict fast path cannot finish, the **local partial result** builds the same way every column and layout part it can, and lists the rest as the missing fields the AI step may be asked for (5 A step 3).

What the free engine builds, it builds the way the example's cells are (decided 2026-10-06, 2026-10-07):
- **A copy writes the kind of value the example holds**: in an xlsx output it converts to the kind every cell of the example's column holds (`toNumber`, `toText`).
- **Identifiers stored as numbers:** an `idLike` input column whose cells are all whole numbers stored as numbers is declared `integer` when every output column that copies it holds numbers in the example and nothing else reads it but a row filter or a duplicate key. Zero-padded text output keeps `idLike` with `padLeft`; a column cut, joined, mapped or written as text keeps `idLike`; a numeric ID copied both as a number and padded in one file goes to the AI step.
- **Dates in a csv / txt example** are compared by the text the delimited writer writes for them, and a column of date text copied as it is keeps the example's text form (its output format; `toText(column, form)` into a workbook's text column) when that form is not ambiguous.
- **No value map onto numbers:** a value map writes text, and a number tied to a key may be a figure of the group that changes next month, so none is built onto a column of numbers (`thinEvidence`: the AI step decides). A csv / txt output is judged by its column's profile type or by a cell that is a plain number (no leading zero), since all its cells are strings.
- **An order nothing explains** (neither the input's nor a sort the analysis found) is a layout part the free engine does not build: `sort` is listed among the partial result's missing parts.

## 7. Profile, sample and masking

### 7.1 Column profile
For each column the profile records:
- header, position and type (`text`, `integer`, `decimal`, `currency`, `percent`, `date`, `boolean`, `idLike`, `empty`);
- shape signature, script-agnostic (decided 2026-10-07): D = any digit, H = a Hebrew letter, A = a letter of any other script; a combining mark is dropped and only separators stay as they are. A masked column's shape is sent only when it holds nothing else (`isSafeShape`);
- empty rate and distinct ratio;
- min/max length and min/max value (an identifier column never sends its real range, 7.2);
- `leadingZerosLost`;
- `key` (unique and non-empty);
- `israeliId` (9 digits with a valid check digit on at least 95% of rows, after padding; the check is validator.js's on the 9-digit form).

The column's class for masking (identifier, text, category, measure, date) is decided from the profile, the values' shapes and the column name (7.2).

### 7.2 The masking switch
The switch sits next to the drop zones. It is **on by default** for everyone, and a "What's the difference?" link opens a short panel.

**One column classification decides what is masked** (decided 2026-10-06; engine `learn/classify.ts`). Every input and output column of the example is an `identifier` (ID, customer, account, policy and order numbers, phones, emails, card numbers, IBANs), `text` (names, free text), a `category`, a `measure` (amounts, quantities, rates) or a `date`, decided in this order:
1. **Value shapes:** at least 80% of the non-empty cells (up to 500 read, spread over the column) have one identifier shape - an Israeli ID, a phone, an email, a card number, an IBAN (validator.js, shared `identifiers.ts`; no digit-run rule; a card is 13-19 digits, a phone is written with 0 or +, a number is an ID (9 digits) or a card (13-16) only, all zeros is none) → identifier.
2. **The column name** (`columnNames` config, Hebrew and English, compared as whole words with case, spaces, punctuation and geresh ignored and one Hebrew prefix letter allowed): a measure word (מחיר, סכום, כמות, price, amount, total, qty ...) keeps a numeric column a measure however long its numbers and wins over an identifier word in the same name ("Account balance"); otherwise an identifier word (ת"ז, מספר לקוח, חשבון, טלפון, מספר הזמנה, id, customer no, account, phone, email, order no ...) makes the column an identifier even when its numbers repeat (a date or boolean column keeps its class).
3. **The profile type:** text → text; numbers → measure; dates → date; `idLike` → identifier; booleans → category.

A class follows the relations code verified: when an output column copies an input column (`copy`, `normalize`, `padLeft`, `numberFormat`, `substr`, `split`) and either is an identifier, both are, so a sample's `in` and `out` carry the same fake; a `concat` or `template` with an identifier input makes the output one. The user's per-column choice (below) is applied last. **Documented limit (DECISION):** an integer column with no identifier shape and no identifier word in its name is a measure, sent real (a customer number headed "Ref"). An external classification hook exists (`columnHints`: it may tighten any column, and loosen a text column to a category only when code confirms at most 12 values, each on 2+ rows, no identifier shape or identifier / person word; never an identifier), but nothing passes it yet (20.15).

**Masking on:**
- **An identifier** keeps its leading zeros as they are, plus the fake of its significant digits (the fake never starts with 0), so `12345`, `012345`, `000012345` and the number 12345 share one fake (`83920`, `083920` ...); a run of zeros only is sent as it is. A valid Israeli ID becomes another valid one (in an identifier column at any length, inside text from 5 digits on); a number stays a number and never gains a leading zero.
- **Text:** every word becomes a fake word of the same length and script - split on spaces and punctuation, separators kept; Hebrew, Latin, Arabic, Cyrillic (case kept) and Greek get fakes of their own script, any other letter a Latin letter of its case, another script's digit an ASCII digit; digits stay digits.
- **A category, a measure and a date** are sent as they are: calculations and date formats can't be learned without them. Dates and yes/no values are always sent as they are, whatever the class (#71).
- **The key and consistency:** a keyed HMAC whose key is random per browser session and never leaves the browser. The same real value gets the same fake in both files, in title and label rows and in every request of the learn; two values never share one (on a collision, a walk over every fake of the same shape, then a wider one, takes the first free).
- **Label words:** words in title, subtotal and total labels that appear in no data cell of ANY row of the example (e.g. "דוח", "סה\"כ") are sent as they are; a word of digits only when no data cell holds the same significant digits.
- **Text dates are dates** (decided 2026-10-04): a TEXT cell that reads as a date in any reading the date reader knows ("12 במרץ 2026", "2026-03-07", "March 12, 2026") or has the shape of one (an impossible "31/02/2026" is what a cleanup rule is about) is sent as it is, whatever the column's class.
- **Vocabulary, never masked:** month names in every form the date reader accepts and weekday names (English; Hebrew "יום" with its day word, and "שבת") inside any text; and a cell that is exactly a "no value" placeholder ("N/A", "-", "null", "אין", "לא ידוע"..., case and spaces ignored; `maskingVocabulary.noValueTokens`). Only the whole cell counts ("N/A Cohen" is masked), and a Hebrew day word alone ("שני", also a first name) is masked.
- **Hints:** an identifier column never sends its real `stats.range`; a filter hint on it keeps only its comparison (`droppedWhen: { op }`), and a bands hint on an identifier axis keeps its (masked) values without `lt` / `gte`.
- **Every path that sends cells reads the same classes:** the payload's samples, dropped rows, hint values and label-word check, the loop's rows and every value a repair problem quotes (9.3), the AI code checks' answers (a value computed from a masked column is masked as an identifier), and a completion call's fixed rules - where each constant is masked like the cells of its column (`maskFixedRules`: a filter's value by its column, a comparison's constant by the other side, a branch's value by the output it reaches, a map's keys and values by the mapped and the output column; a label like text), and lookup tables and value maps are sent with their shape only (no rows, no entries: code puts the user's own back with `restoreFixed`).
- **Unmasking:** the browser keeps the fake→real map. A returned constant that is a whole masked value is restored whole; otherwise each fake word in it is restored, except a short number (1-3 digits, no leading zero: the AI's own); a NUMBER constant only when it is the fake of a whole identifier of at least `maskingIdentifiers.minUnmaskDigits` (4) digits. This happens before the rules are shown, saved or run. The map is never sent, and saved rules contain only real words.

**The user's choice per column** (decided 2026-10-07). "See what we send" on Home opens a large dialog (a full-screen sheet on a phone) with the sample rows exactly as the AI step would get them (input and output side by side, the column names, the dropped rows, the full request), built in the worker by the same function the learn uses (`aiRequestOf`, engine `sendPreview`), and a switch on each column header, **Hidden / Sent as is**, preset by the classification (identifier and text hidden; measure, date and category sent). A flip rebuilds the rows at once.
- 'sent' loosens anything; 'hidden' tightens (a column sent real becomes an identifier). Un-hiding a column code takes for identifiers says so ("ID looks like ID numbers; they will be sent as they are."); hiding one sent real warns the AI may then miss rules that need its numbers; a copy moves with its column (hidden wins). The user's choice wins.
- Date and yes/no columns cannot be hidden (the switch is disabled and says so; #71). With masking off every switch shows Sent as is, disabled, with "Turn masking on".
- The choices hold for every request of the learns of these files (first call, repairs, loop rows, checks' answers, a completion's fixed rules), survive the sign-in trip, go with Add a source from the same files, and reset with a new file. A decision about the rules (a list keyed on an identifier, 8.11) reads code's own classes, never the choice. If the computer solves the learn alone, nothing is sent.
- Below the rows, "What else is sent" lists every column as "values hidden" or "values sent as they are" (engine `sentColumns`), with the counts (`limits.payload.maxPairs` pairs first, at most `limits.learn.loop.maxRowsTotal` rows in one learn).

**Masking off:** the sample rows are sent as they are: up to 12 aligned pairs plus up to 5 dropped rows in the first request, and at most `limits.learn.loop.maxRowsTotal` (40) rows in one learn with the learning loop (9.3) and the AI code checks.

**In both modes:**
- The full files never leave the browser.
- Hints are always computed on the real data, locally.

**What masking on can miss:** relations inside a word are invisible in masked samples. Pair analysis finds the common ones on the real data (prefixes, suffixes, padding, whole-word concatenation) and sends them as hints. Anything else comes back as `hiddenByMasking`, and the UI suggests turning masking off or setting that column by hand. The eval harness measures the accuracy gap between the two modes (10).

**UI copy:**

| | English | עברית |
|---|---|---|
| On | Masking on: names, other text and identifier numbers (such as ID, phone, customer and order numbers) in the sample rows are replaced with look-alike values before anything leaves your computer. Other numbers, dates, column names and sheet names are sent as they are. | הסתרת נתונים פועלת: שמות, טקסט אחר ומספרים מזהים (כמו מספרי זהות, טלפון, לקוח והזמנה) בשורות הדוגמה מוחלפים בערכים מדומים לפני שהם יוצאים מהמחשב שלך. מספרים אחרים, תאריכים, שמות העמודות ושמות הגיליונות נשלחים כפי שהם. |
| Off | Masking off: up to {rows} rows of your example are sent as they are in one learn. Learning is more accurate when a column is built from part of a text value, like the first digits of a policy number. | הסתרת נתונים כבויה: בלמידה אחת נשלחות עד {rows} שורות מהדוגמה שלך כפי שהן. הלמידה מדויקת יותר כשעמודה נבנית מחלק של ערך טקסט, למשל הספרות הראשונות של מספר פוליסה. |
| Always | Your full files never leave your computer. | הקבצים המלאים לעולם לא יוצאים מהמחשב שלך. |

(`{rows}` is `limits.learn.loop.maxRowsTotal`, 40: everything one learn may send - the first request's pairs and dropped rows, the learning loop's rows and the AI code checks' rows together.)

### 7.3 What gets sent (the learn payload)
The full field list and an example are in `LEARN_PROMPT.md`. In short:
- the masking flag;
- both profiles;
- the input layout (rows to skip) and the output layout (6.2 step 5);
- up to 12 aligned sample pairs, chosen to cover the first rows, empty cells, extreme values and each kind of layout row; a pair whose input AND output values (the real ones, before masking) repeat a pair already chosen takes no slot (a failing row of a hint is always sent; the same input with another output is kept; decided 2026-10-04). When rows expand, up to 6 whole **families** are sent instead (one input row with all its output rows), including the smallest and the largest;
- up to 5 dropped rows;
- hints;
- `skipColumns`;
- `output.file`, detected by code from the example output (8.13);
- `target`, only when adding a source to an existing format (8.12);
- `complete`, only when the AI step is asked to finish a partial rules file (completion mode, decided 2026-09-30): `{ fixed, columns, parts }` - the user's current rules in wire form (`fixed`, masked by their columns, with lookup tables and value maps sent without their entries: 7.2), the output columns with no rule and the layout parts the local result could not build. Its answer is held to the fixed lock (9.2 layer 5); it is never taken from or put in the structure cache.

Hard caps (config, `limits.payload`): 60 columns, 12 pairs (6 families), 5 dropped rows, 40 characters per cell, 48 KB per payload; when the payload is too large, samples are dropped first, but never below 4 pairs. A column's position `i` is at most 16,383 (Excel's last column) and unique per side. The API checks the payload's shape, its byte cap and every cell's length on every AI route (9.5).

**Rows sent in later rounds (the learning loop, 9.3).** After the full verification the browser may send rows of the example the rules got wrong, in up to 3 more requests: at most 8 new rows a round, never a row already sent (a sample, a dropped row or an earlier round's row), and at most 40 masked rows in one learn, the first payload's samples and dropped rows included. They are built, masked (the same masker and session key, so a value has the same fake word in every round) and cut to 40 characters exactly like the samples; a row the example dropped is sent with no output rows. Every value a round's problems quote - a cell's expected and actual value, a title or summary-row cell in a layout problem, a name - is masked the same way (one that cannot be masked is left out, and only where the difference is is said). The 48 KB cap limits only the new rows a request carries: the payload with every row carried added to it stays under it, and a row that does not fit is named in the round's problems only (as the one browser repair always named its rows), so a payload already near the cap still gets its rounds. "See what we send" lists every round's request.

**What the AI code checks send (learn-v9; off by default, 9.1).** Each step request carries the payload unchanged and every round so far: the checks and the answers the browser computed on every aligned row - counts, cut-off points and runs of a number or date column (sent real, like every number and date), the most common values, and at most a few rows (3 failing rows of a `test`, 2 conflicting pairs of a `dependsOn`, 5 rows of a `rows`), masked like the samples and cut to 40 characters. Those rows count toward the same 40 rows of one learn (a row already sent is shown again without counting; the loop never sends a row a check showed); past the limit an answer gives counts only (`withheld`). The 48 KB cap holds for the whole step request; a round too large is sent with counts only.

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
   - First, a text cell whose exact text is a key of its column's `readAs` is read as the value that key names (8.4a): "N/A" -> empty, so it is no longer a number that failed to parse.
   - Dates are parsed only from the listed formats.
   - Numbers can include thousand separators, ₪ and %, and negatives in parentheses or with a trailing minus.
   - idLike values stay text and are padded.
   - A value that fails to parse is kept as it is and flagged.
3. **Row filters.**
4. **Duplicates** (8.4).
5. **Expand** (8.5).
6. **Computed columns.** These run after expand, so calculations apply to each new row. A column that holds an across-row ("window") function (8.3) is calculated over all the rows that remain (after filters, duplicates and expand), in file order unless the function says otherwise, and before value maps, sort, group and validations; a row a `block` validation later leaves out is still counted in it, and the run summary says how many ("N blocked rows are included in calculated totals", a count only). Columns without a window run row by row exactly as before.
7. **Value maps.**
8. **Sort.** The sort is stable: ties keep the input order, so the rows of one family stay together unless the sort separates them.
9. **Group.** Detail rows, summary rows (8.6, 8.12) and spacing.
10. **Output layout.** Title rows, header, columns, summary rows (8.6, 8.12), direction, language and file type (8.13).
11. **Validations** → flags. Input validations (`on: "input"`, the default) check the normalized input columns; output validations (`on: "output"`) check the final data rows, by output header.

The engine receives no clock. All arithmetic uses decimal.js. `round` rounds half away from zero, like Excel's ROUND.

### 8.3 Expressions, functions and filters
Expressions are an AST that the engine interprets. There is no regex and no code in strings, ever. The language is meant to be rich enough for real reports and still fully checkable by code before anything runs (9.2): a closed set of typed operations, reusable functions and constant tables (8.14), and hard limits.

**Formulas (learn-v5).** The LLM (and, later, the editor's text view) writes every expression as FORMULA TEXT, e.g. `round(amount * 0.17, 2)`, `if(status = "VIP", price * 0.9, price)`, `lookup("rates", code, "rate")` - never the AST directly. A strict parser (`packages/engine/src/formula`) turns that text into the exact same whitelisted AST below; nothing is ever executed as code, and an unknown function or identifier is a parse error. Stored rules, the engine and the type checker work on the JSON trees. Formula text is a plain string on the wire, so no structured-output provider needs a recursive schema for expressions.

**Leaves:** `col`, `const`, and `param` (only inside a function body).

**Operations.** Each has a fixed signature (see Types):
- **Arithmetic:** `add`, `sub`, `mul`, `div` (dividing by zero raises a flag), `neg`, `abs`, `round{digits}`, `floor`, `ceil`, `mod`, `min`, `max`
- **Text:** `concat`, `substr{start,length}`, `trim`, `upper`, `lower`, `replaceText{find,with}` (literal text only), `padLeft{length,char}`, `split{separator,index}` (1-based; negative counts from the end), `length`
- **Conversion:** `toNumber` (a value that doesn't parse raises a flag), `toText{format?}` (number or date format)
- **Dates:** `datePart{year|month|day}`, `dateFormat{format}`, `dateAdd{days|months|years}`, `dateDiff{unit: days|months|years}`, `endOfMonth`
- **Added after learn-v6** (see below): `weekday`, `makeDate`, `toDate{format}`, `dateLiteral{value}` (formula `date("YYYY-MM-DD")`), `keepChars{chars: digits|letters|lettersAndDigits}`, `titleCase`, `find{search}`
- **Logic:** `if{cond,then,else}`, `switch{cases: [{when, then}], else}`, `coalesce`
- **Lookup:** `lookup{table, key, return, onMissing: flag|empty|keep}` against a constant table in `transform.tables` (8.14)
- **Calls:** `call{fn, args}` to a function in `transform.functions` (8.14)
- **Conditions:** `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `isEmpty`, `notEmpty`, `oneOf{values}`, `startsWith{text}`, `endsWith{text}`, `contains{text}`, `and`, `or`, `not`

**Types.** Every value has one type: `text`, `idLike` (text whose leading zeros matter), `integer`, `decimal`, `date` or `boolean`. Every operation declares its argument and result types, e.g. `mul: (decimal, decimal, …) → decimal`, `dateDiff: (date, date) → integer`, `startsWith: (text) → boolean`. The only implicit widenings are `integer → decimal` and `idLike → text`. Anything else needs `toNumber` or `toText`. The signature table lives in `packages/engine` and is the single source for the type checker, the editor and the prompt.

**Limits** (config, `limits.rules`): depth 8 per expression; 200 nodes per output column after expanding function calls; formula text of at most 4,000 characters; 20 functions; 20 tables of up to 500 rows each; the number parameters the engine uses as sizes (decided 2026-10-07): `round` digits within ±15, a `padLeft` length (an expression's, or an input or source column's) and a `lengthEquals` check at most 100, `group.blankRowsAfter` at most 20; and what one saved format may keep (decided 2026-10-06; 11): 500 entries in one value map, 300 characters in one value (a label or constant, a table cell, a value map's key or value, a condition's constant, a filter's or a check's value, a "read as" text, a "stop at" text), 500 characters in a title row's text or a summary row's label, 64 KB for one version's rules (compact JSON). The schema refuses a size parameter over its cap (an AI answer gets a repair, a save is refused); the saved-format caps are checked in the browser (the editor's live check says them on their line) and on every route that stores rules (400 `rulesTooLarge`).

**Added after learn-v6** (formula spelling in brackets). They are in the rules language, the formula parser, the type checker, the engine and the editor's Advanced view, and since learn-v7 (decided 2026-10-01) in the AI prompt too: no op is held back (`inPrompt: false` in `OP_SIGNATURES` is there for the next op added before its prompt version; `promptOpsSync` requires every other op in the prompt).
- `weekday(date)` -> integer, 1 = Sunday ... 7 = Saturday (the Israeli week, Excel's default). Real calendar, so also right before 1900-03-01.
- `makeDate(year, month, day)` -> date. Whole numbers only; an impossible date (month 13, 31 February, a 2-digit year, before 1900 or after 9999) is empty and flagged ("needs a date here"); an empty part is an empty result without a flag.
- `toDate(text, "format")` -> date. The `inputFormats` tokens (`D`, `DD`, `M`, `MM`, `YY`, `YYYY`, literal separators) plus the month-name tokens `MMMM` and `MMM`, in Hebrew or English whichever the text uses (either token takes the full or the short name, English ignores case; Hebrew "מרס" and English "Sept" are accepted). A format with a month and a year but no day means the 1st (`"MMMM YYYY"`: "ינואר 2026" / "January 2026"). The whole text must match; no match, an unknown month name or an impossible date is empty and flagged. Hebrew "in <month>" is a literal: `"D בMMMM YYYY"`. `inputFormats` itself is unchanged (numeric tokens only).
- `date("2026-01-31")` (op `dateLiteral`) -> date. A fixed date, ISO only, checked when the formula is read (a date that does not exist is a parse error). This is how a rule says "days until a fixed date" or "before 2026-06-01"; the engine still has no clock. A text constant never stands in for a date: text where a date is declared stays a type error, and only `makeDate`, `toDate` and `date()` build dates.
- `keepChars(text, "digits" | "letters" | "lettersAndDigits")` -> text. A closed set of named classes, never a pattern (no regex): digits are Unicode decimal digits, letters are Unicode letters (Hebrew letters count; niqqud, punctuation and spaces do not). Nothing left is empty.
- `titleCase(text)` -> text. A word starts at the beginning and after any whitespace or hyphen; its first letter becomes upper case and the rest lower case ("jean-luc PICARD" -> "Jean-Luc Picard", "o'neil" -> "O'neil", "3RD" -> "3rd"). Hebrew is unchanged.
- `find(text, "search")` -> integer. The 1-based position (in characters) of the first occurrence of the literal text, 0 when it is not there; case-sensitive; empty text stays empty; an empty search is not allowed.

**Across rows: window functions** (formula spelling; one AST node `{ op: "window", fn, arg?, by?, order?, ties? }`; `schemaVersion` stays 1). Allowed only in a computed column's formula (`transform.computed[].expr`): a window in a row filter, a fan-out value or a function body is a parse error (and a `checkRules` problem for stored JSON). They are written with **named arguments**, `runningSum(amount, by: account, order: date)`; a positional `by` or `order` is rejected (the lexer has one new token, `:`). The column (`x`), every `by:` column and every `order:` column are plain **column ids** in v1, never expressions: anything calculated goes in a helper computed column first (the formula parser says so, with an offset). `by: g` or `by: (g1, g2)` splits the rows into groups (no `by:` = all rows; an empty group value is a group of its own, as in `group.by`); `order: k`, `order: k desc` or `order: (k1, k2 desc)` sorts each group before the function looks at it (empty keys last, either direction; equal keys keep file order). **Without `order:` a window walks the rows in file order**: the order they have right before step 6 (after filters, duplicates and expand; an expand family's rows in family order), whatever the output `sort` later does. The result is stored per row like any computed value, so sort, group, summary rows, validations and the output see an ordinary column (`last` of a running sum is the closing balance). Value maps run after, so a window reads the values before they are translated. A window raises no flags of its own (a cell that did not parse was flagged where it was read, and is skipped, as `sum` skips it).
- `runningSum(x)`: sum of `x` from the group's first row through this one; empty and non-numeric `x` add nothing; empty until the first number. `groupSum(x)`, `groupAvg(x)` (exact quotient, unrounded, like the `average` summary), `groupMin(x)`, `groupMax(x)` (a number or a date): the whole group's value on every row, empty when it has no number. `groupCount()` / `groupCount(x)`: rows in the group / rows where `x` is not empty (never empty).
- `previous(x)`, `next(x)`: `x` on the row before / after in group order (any type; empty on the first / last row). `fillDown(x)`: the last non-empty `x` up to this row. `rowNumber()`: 1, 2, 3 ... in group order. `rank(order: k)`: position by the order keys, first = 1; equal keys share a rank (`ties: min`, the default, gives 1, 1, 3; `ties: dense` 1, 1, 2); an empty first key gives an empty rank and is not counted.
- `order:` is not allowed on the group functions (it would not change their value) and is required on `rank`; `ties:` is for `rank` only. Types: `runningSum`/`groupSum` need a numeric column (`expected decimal, got text; use toNumber in a computed column first`) and give an integer for an integer column, else a decimal; `groupAvg` a decimal; `groupMin`/`groupMax` a number or a date, of the column's type; `previous`/`next`/`fillDown` any type, the column's; `groupCount`/`rowNumber`/`rank` an integer. A share of the total is not a function: `round(amount / groupSum(amount, by: dept) * 100, 1)` (division keeps its divide-by-zero flag).
- **Limits** (config): at most 8 window functions per file (`limits.rules.maxWindowOps`) and 3 columns in one `by:` or `order:` (`maxWindowKeys`); each window counts as one rule (like sort and group), and its `by:`/`order:` columns follow the computed chain into the node budget. A function named like one of the eleven (`rank`, `next`, `previous` ...) is refused when a rules file is made (it would be read as the built-in); a stored file is never refused for it. The prompt documents the eleven (learn-v7), and the `rel: "window"` hint is sent (6.2).
- **Determinism and cost:** decimal.js only, summed strictly in walk order; groups by the same identity dedupe and group use; one group map per distinct `by` and one sorted index per distinct (`by`, `order`), cached for the run, then one pass per window (about 20 ms for four windows at 5,000 rows, 0.1-0.2 s at 20,000).

**Row filters:** `{ column, op, value? }` for simple cases, or `{ expr }` where expr is any condition. op is one of `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `isEmpty`, `notEmpty`, `oneOf` or `notOneOf` (value is an array). Several filters are ANDed.

**Date format tokens:** `D`, `DD`, `M`, `MM`, `MMMM`, `YY`, `YYYY`. `MMMM` is the month name in `output.language`, e.g. ספטמבר or September. `MMM` is the short month name. Added after learn-v6: `ddd` and `dddd` (short and full weekday name in `output.language`: Thu / Thursday, "יום ה'" / "יום חמישי"; Saturday is שבת). In an output column's Excel number format `ddd`/`dddd` stay Excel's own weekday codes (with the Hebrew locale prefix for Hebrew).

### 8.4 Duplicates
`transform.dedupe: { keys: [ids] | "all", keep: "first" | "last", action: "remove" | "flag" }`

- **Where it comes from:** either the example (pair analysis found that the dropped rows are copies of kept rows) or the user, who adds it in the editor.
- **How rows are compared:** values are compared after type normalization: trimmed, padded, and with quote marks and geresh unified. There is no fuzzy matching.
- **`remove`:** the extra copies are left out. With `keep: "first"` the later copies go; with `keep: "last"`, the earlier ones. Every removed row is listed in the run summary with its row number, so nothing disappears silently.
- **`flag`:** all rows stay, and every extra copy is flagged, e.g. "duplicate of row 12". In reconciliation-type work a duplicate is often the error itself (an item billed or paid twice), so the editor offers both actions.

### 8.4a Reading a cell's text another way (`readAs`)
`input.columns[].readAs: { "<exact cell text>": "<text it is read as>" }`, optional (absent = none; `schemaVersion` stays 1).

- **What it does.** At the start of step 2 (8.2), a cell of that column that is TEXT and whose text equals a key exactly (case, spaces and punctuation as they are) is read as the value of the key. An empty value means an empty cell. The value is then read by the column's type like any cell of the file ("0" in a number column is 0; "none" in a number column is flagged as any text would be, with the value it was read as). Exact match only: nothing is trimmed, case-folded or chained; a number, a date or an empty cell is never matched; a per-run fix of that very cell (5 C) wins. Everything after step 2 (filters, duplicates, computed columns, checks) sees the value it names.
- **Why a new rule.** `transform.valueMaps` (step 7) run after the computed columns, on output values: they can neither stop "N/A" from being flagged as a number nor change what a calculation reads. `readAs` is the smallest addition that does (DECISION).
- **Who writes it.** The Run screen's "Do this every time?" (5 C) and nobody else: the AI never writes it, is never shown it (the wire schema and `toWire` / `fromWire` leave it out; the schema sent to the provider is unchanged) and the learn never builds one. It holds the user's own text.
- **In the rules map** (8.11; decided 2026-10-04): one line per text in the Rows section, before the filters (it is applied before them): "In Amount, 'N/A' is read as empty" / "In Amount, '-' is read as '0'". Its editor shows the sentence and **Remove this rule** (the editor action `removeReadAs`); a text is not edited in place, it is removed.
- **It is part of the SOURCE** (8.15), like `padLeft` and `inputFormats`: it is how the file is read, so every conversion of a source carries the same `readAs` on a column it declares (the source lock compares it as a dictionary). A conversion saved into an existing source takes the union of the two (the same text read two ways is a mismatch); an editor save replaces the source's `readAs` on the columns it declares; restoring an older version without it is an edit of the source that takes it away from the source and from every format it feeds.
- **Limits** (config): at most `limits.rules.maxReadAsPerColumn` (100) texts per input column; a key is never empty. They are not counted as rules for the tier limit (value maps are not either).

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
Generic summary rows (they replaced the sum-only `output.grandTotal` and `transform.group.subtotal`, which stored rules files still load and run byte-identical; the AI step only writes `summaryRows`):
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
- **`cutoffRange{low, high, value, includes}`** (decided 2026-10-04): a cut-off the example did not settle. Only code writes it, never the AI step (its wire schema does not offer it): when a rule compares an input (or computed) column with one constant (`amount >= 5000`) and code finds from every row of the example only that the line lies between two neighbouring values of the column (9.2 layer 8), the range becomes this check. It reads "Your example shows the cut-off is above `low` and at most `high`; we used `value`" (`includes: "high"`, for `>=` and `<`; "at least `low` and below `high`" for `includes: "low"`, `>` and `<=`). At run time a value strictly between `low` and `high` is flagged ("Your example did not settle which side of the cut-off this value is on"); the edges themselves are settled. Numbers on a numeric column, ISO dates on a date column; `low` < `high` and `value` inside (checked). The edges are values of the user's rows: they are stored only as this visible check the user approves, like any constant a rule uses, are never sent to the AI step (completion mode leaves the check out of `complete.fixed` and puts it back; a cut-off check an AI answer wrote is dropped), and the user can delete it or edit its edges in the rules editor's Checks section. It is the conversion's own, like a row filter: never part of the source (8.15).
- **`sameAs{expr, oneTime?}`** (decided 2026-10-05): the marker of an open one-time question (8.11). Only code writes it, never the AI step (its wire schema does not offer it), and today only with `oneTime: true`: the answer "Not sure" to a one-time question keeps the part of the rule the example has on one row only, with this check. `column` is the input or computed id the output column reads; `expr` is the column's rule WITHOUT that part, written out as one expression over the columns there are when input checks run (its own computed columns put in place). At run time a row where `expr`, read as the column's type, gives a different value than the column holds is flagged in its own words ("This row gets a part of the rule that your example had on one row only; without it the rule gives X", key `flag.validation.sameAs.oneTime`); a row where `expr` cannot be worked out passes. Severity `flag`. DECISION: an input-side check (on the id, like `cutoffRange`), not an output one (the header): an output check belongs to the format and would be copied to every source of it (8.12), while `expr` reads this source's columns. So it is the conversion's own - never part of the source (8.15) or the format - holds the rule's constants (never sent: completion mode leaves it out of `complete.fixed` and puts it back, like `cutoffRange`), and is visible and deletable in the rules editor's Checks section (it says the rule as a formula; it is not edited there). A plain `sameAs` (no `oneTime`; written by the alternative rules of learn-v8, removed 2026-10-07) still loads, runs and shows, with the flag "Your example fits two rules for this column, and here they differ: the other rule gives X".
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
  - `crossRowCalculation` (only for what the window functions of 8.3 cannot say: values over rows a filter removes, a rolling N-row window, anything across files; a running total, a group total, a rank, a row number or the previous row's value are expressible)
  - `hiddenByMasking`
  - `ambiguous`
  - `other`
  - `overfit` - written by CODE only, never offered to the AI step (9.2 layer 6; decided 2026-10-05): the only rule the AI step found for the column copied particular rows of the example (a condition on a row's position, a long list of one-row cases, a lookup or value map keyed on an amount), and still did after its one repair; also the reason of a list of fixed values the user saved without (8.11 "Saving"). "The only rule we found for this column copies particular rows of your example, so it would be wrong on your next file. Please set this column yourself."
  - `savedWithout` - written by CODE only (decided 2026-10-06): the user saved the format without this column's rule because it kept an identifier-shaped value (8.11 "Saving").

  Those columns have `"from": null`. The format can't become verified until each one is resolved, either in the rules map or by learning again with masking off.
- **`assumptions: [{ outputColumn?, reasonCode }]`** (outputColumn is omitted for row-level guesses such as filters). reasonCode is one of:
  - `rateGuessed`
  - `roundingGuessed`
  - `filterGuessed`
  - `sortGuessed`
  - `formatGuessed`
  - `titleGuessed`
  - `overfitSuspected` - added by CODE only, from the overfitting lint (9.2 layer 6)
  - `other`

  They are shown as "Please check" items next to the column in the rules map.
- Log all codes. They are the roadmap for which operations to add next.

**Function requests and explanations (learn-v7, issue #40).** An unsupported entry may carry two optional extras, both written by the AI step, neither ever part of the rules:
- **`functionRequest: { name, purpose, args: [{ name, type }], returns }`** - set when the missing piece is a FUNCTION the language lacks. `name` and the argument names are camelCase (at most 40 characters), `purpose` is one neutral sentence (at most 160), at most 6 arguments, `type` / `returns` a value type (8.3). It carries NO example and no value of any kind (not even a made-up one). The strict schema enforces the limits; the wire schema omits the `pattern` / `maxLength` / `maxItems` keywords (not every structured-output provider accepts them), so a request that breaks a limit is dropped by the API, never a reason to fail or repair a learn. **Value filter before it is stored:** a request is rejected - counted, not stored, and removed from the answer - when its name, purpose or argument names contain anything that occurs in the payload: a sample or dropped-row cell, a hint value (masked fakes or real, as sent), a word of an input or output header or of a sheet name (sent real; decided 2026-10-07); words of 3 or more characters are compared case-insensitively, numbers (also those inside text cells) exactly. What passes is recorded in `function_requests` (13): deduplicated on the normalized name plus the signature, counted per distinct HASHED owner, with a best-effort catalogue topic. Nothing here opens a GitHub issue; the admin (M4) adds the threshold and the "open an issue" click (issue #41 builds approved functions through a gated PR). The user is told "This needs a function we don't have yet - we've recorded it." only when the request was kept.
- **`explanation`** (at most 200 characters, in the language of the output headers) - one short plain-language description of the rule the AI sees, for a column it could not build. It may mention values (it arrives masked, like the payload) and is shown ONLY to the user, in the session: "The AI's guess (not applied): ..." next to "Fill in" on the map line and in the Deep analysis panel. It is never executed, never applied, never stored, cached or logged, and never saved with a format (15). Supported columns keep their deterministic rules text; only unsupported columns can carry a guess.
### 8.11 The rules map and its editor
The rules map is where users read, fix and add rules. It is generated from the JSON in the UI language, and every change is written back to the JSON.

**Layout.** The list sits on the inline-start side and the editor panel on the inline-end side. On narrow screens the editor opens as a full-width sheet. The list has four sections:
- **Rows:** how the file is read (the sheet, the header row, where it stops, and what a column's text is read as, 8.4a), filters, duplicates, expand.
- **Columns:** one line per output column, in output order, written as a sentence, e.g. "עמלה ← פרמיה × 0.17, rounded to 2 decimals". Dates are said in words: "Order Date read as year-month-day", "Date written as day/month/year", and a chain over a column that mixes formats as one sentence ("... read as year-month-day when it contains '-', otherwise as day/month/year"). Users can reorder columns (drag), add them and remove them.
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
- **Join text:** pick the columns, a separator, and optional fixed text before and after (e.g. an ID and a name: `ID: 012345678 - Dana`).
- **Part of text:** the first or last N characters.
- **Translate values:** a two-column table (value in the input → value in the output). For values not in the list, the user chooses between flagging them and keeping them as they are.
- **Fixed value.**
- **Running total** ("סכום מצטבר"): the column to add up (a number), optionally "start again for each [column]", and how the rows are added up, a required choice: "File order" (as the rows appear in your file) or a column with a direction (lowest first / highest first). When the rules remove duplicates (`dedupe` with `action: "remove"`) it says "Duplicates are removed before the total is calculated." It writes `runningSum(...)` (8.3) into a generated computed column typed from the source column, and reads back as this choice only for exactly that shape (one column, at most one group and one order column); every other across-row function (group total, rank, row number, previous / next, fill down), and any running total written differently, is written in Advanced and shows as "Formula". The rules map describes every window function in a plain sentence, e.g. "running total of Amount per Agent, in file order".
- **Leave empty.**

Every column also has an output number or date format, with a preview.

**Source dropdowns list every input column.** A learned rules file declares only the input columns some rule reads, so the columns of the example INPUT that no rule uses (an ID number, say) would be missing from every dropdown that picks an input column (copy, calculate, join, part of text, translate, filters, duplicate keys, sort, group, checks, title month). So:
- The worker returns the example input's columns with the learn result (and with `loadExample`): header plus profile facts (type, `israeliId`, `leadingZerosLost`, `serialDates`, longest length, date format). Headers only, never values.
- Every such dropdown lists the columns no input column declares yet, after the declared ones, labelled by the header. Choosing one declares it (`input.columns`: a fresh camelCase id, the header exactly as in the file, the type from the profile - an id with lost leading zeros keeps `idLike` with `padLeft`, a serial date gets `excelSerial` among its `inputFormats`) **in the same undoable edit** that uses it.
- A saved source has no example files: the dropdown offers "Another column from your input file…", a small form for the header (exactly as in the file) and what the column holds. The column is declared the same way, and the next conversion reads it by that header. Dropping the example files instead offers their columns as above.
- "Add a column" is on the Columns section in every result state (verified, differences, the partial result, the saved-source editor).

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

**Rows the rules don't reproduce.** Where the rules don't reproduce the example, the map and the preview say so plainly per column — "N rows in your example don't match this rule (rows 12, 57, …)" or, when a column mostly fails, "The rule for <column> doesn't reproduce your example yet" — each with "Fix the rule", and the differing cells are amber. The user fixes the rule (or saves with N differences). (Decided 2026-09-30: there is no "This row was fixed by hand" exception in the UI, as too confusing; `exampleExceptions` stays in the data model, 13, and may return inside the column editor for outlier rows only.) The order of the data rows is compared too (decided 2026-10-07): where the example has an order and the rules write another, "The rows are in a different order than in your example." (9.2 layer 8).

**An ambiguous column (the question).** Where the example fits more than one rule for a column - one value on every row that the input could write too (6.2 step 4, 6.5): "00", or the first 2 digits of Employee number; "03/2026", or the month of Date - the Columns section asks ONE short question on that column's own line, in the rules map's own words (each reading is applied to the rules and the column described as the map describes it): "[column]: which one is it?" with a button per reading ("fixed value '00'", "the first 2 characters of Employee number") and **Not sure yet**. It is quiet (no amber: nothing differs yet) and not a modal.
- Each answer is the column's rule (one undoable edit) and takes the check below out. No AI call: the column is built, so it is not one of the fields the AI step is asked for and is not counted as unsolved.
- Until it is answered, the column is read from the data (what next month's rows say), with a check on the output column (`oneOf` the constant, severity `flag`) that flags a run-time row where the data reading differs from the constant. The check is visible in the Checks section and deletable, and it is the question's marker: delete it and the question closes. **Not sure yet** keeps it and folds the question into one line ("Not sure yet. For now: ... We flag a row where ... would give a different value."), which can be opened again.
- The question is asked whatever path built the rules; after a whole AI learn the AI step's own rule for the column is replaced by the same default (both readings fit every row, and the AI step saw the same rows).
- **The day/month order of a text date** that no value of the example settles (decided 2026-10-04) is the same question, asked on the first output column whose rule the other order would change (a date column only a filter or a sort reads is not asked), with two differences: its two readings are the date's two orders, each button saying its order with a date that shows it ("[date column]: day/month or month/day?" - "day/month (31/01)", "month/day (01/31)"), and it has no check (no kind of check says "this date reads both ways"), so it is open while the rules read the AI's order, and **Not sure yet** says only what is kept for now ("Not sure yet. For now: day/month (31/01).").

**A one-time edit or a rule? (the second kind of question, decided 2026-10-05).** After an AI learn, a part of a column's rule that explains exactly one row of the example and applies to no other - singled out by its ID, an exact amount or date no other row has, or its place in the file (9.2 "One-time parts") - is asked about on the column's line, with the same look as the ambiguity question (quiet, no amber, no modal), one question per row: "Row 54: Discount is 0.00 instead of Amount × 0.1, rounded to 2 decimals. A one-time change, or a rule we missed?" The value is the example's, formatted like the column; the part after "instead of" is the column's rule without the part, in the map's own words. Under it, what singles the row out ("it picks the row by its Order ID (ORD-03053)", "... by its place in your file (row 54)") and the row's real values ("Your example has 0.00 in this row; the rest of the rule gives 252.61"), read from the learn on this computer - nothing is sent. Three answers, each one undoable edit (none of them an AI call):
- **A one-time change:** the part is taken out of the rules (`withoutRulePart`: an `if` becomes its else, a `switch` loses the case, a list loses the value, a lookup table its row, a value map its entry), so the column's remaining rule applies to every row. The row becomes a **one-time cell** of the session (the example row in that column only): the example comparison leaves that cell out - the row still counts, and its other columns are compared - and the "rows that don't follow" panel lists it ("Rows that don't follow the rule": "Row 54 (Discount): your example has 0.00; the rule gives 252.61"; a short panel of its own when nothing else differs). Nothing about it is saved: not in the rules, not in `exampleExceptions` (DECISION: the one-time cells live in the editor's state beside the rules - undo takes them back with the part - and a later editor that checks the example again compares that cell like any other).
- **A rule:** the part stays as it is; the question closes for this screen (it changes nothing, so it adds no undo step).
- **Not sure:** the part stays, with a check that flags a later row it applies to (8.8 `sameAs` with `oneTime`), visible and deletable in the Checks section; the question folds into one line ("Row 54 of Discount: not sure yet. For now the rule keeps this part, and we flag a row of a later file where it applies."), which can be opened again. The check is that answer's marker: deleting it, or undo, opens the question again. A part no check can say (the rest of the rule reads other rows, a value map changes the column, a value-map entry) folds with "For now the rule keeps this part." only.
A question whose part is no longer in the rules (answered, or the column changed or emptied) is not asked. Questions from a completion's answer are asked like the learn's (the asked columns only).

**Rows the AI step could not make match.** When the learning loop stops without every row matching (`noProgress`, `roundCap`, `rowCap`, `payloadCap`, `nothingToSend`, `timeBudget`, 9.3), or an AI answer is kept with differences for another reason, a short panel above the map names the rows that still differ, grouped per column: "N rows don't follow the rule we found for [column]: rows 38, 89, 132, 140, 151 and 2 more" (up to 5 row numbers), with the real values of the first three ("Row 38: your example has X; this rule gives Y"), read locally from the live check - nothing is sent; the preview below shows the same rows in amber. Per column, two choices: **Fix the rule** (the editor opens on that column) and **Leave it empty for now** (the column becomes "needs your input": today's best-we-can-do path). "Keep these rows as they are" is not offered: it is the owner's open question (`docs/proposals/learning-loop.md` 6.3; 20.17). The panel goes with the first save, or once every group is fixed or emptied.

**What code filled.** After an AI learn, one quiet line (no amber) under the learn-path note says what code filled from the example (9.2 layer 8), kinds and counts only, never a value: "Completed from your example: 40 lookup entries, 1 cut-off (please confirm the check)" - each kind in its own words (lookup entries, translated values, values in conditions, cut-offs, band boundaries, the day/month order of N dates, which duplicate is kept, values in filters), "(please confirm the check)" when a check was added. Nothing when code filled nothing or the result is local, and not after the first save. A completion's applied answer says its own.

**Saving.**
- **Status:**
  - **Verified:** every row matches (a one-time cell is left out of its column's comparison).
  - Otherwise the user can "Save with N differences". The status becomes `differencesAccepted`, and the badge shows N.
  - **Columns that need your input** (`from: null`, or unsupported) are left out of the comparison, so they never count as differences: the badge says "N columns need your input" and the format saves as `userConfirmed`. Once every column has a rule, all columns are compared again.
- **Versions:**
  - Undo and redo work within the session.
  - Every save creates a new version, and old versions can be restored from the history.
- **Anonymous users** can view the map; editing requires sign-in.

**What a saved format may keep: the Save popup** (decided 2026-10-06). A format is stored on our server, so whatever its rules hold is stored there. Raw values placed somewhere and logic on the input (cut-offs, rates, labels) save silently; a **list of fixed values** nobody can deduce, and an **identifier-shaped value**, are kept only if the user says so.
- **A list of fixed values** (engine `copiedLists`): an output column whose value comes from a lookup, a value map or a chain of cases whose entries are fixed values keyed on input columns (one entry per key or grouped by label), with at least `limits.learn.lists.minEntries` (6) entries the example uses; also a chain of constants whose every atom tests ONE input column that differs on every row. The key is judged by the columns its value is made of (`keyColumnsOf`); an amount among them is the guards' (9.2 layer 6). **Not a list:** a small vocabulary - at most 12 entries, each on 2+ rows, keyed on no identifier column (code's classes, 7.2) - and fewer than 6 entries (the one-time question). Completion mode looks at the asked columns only. Before Save, one automatic round asks the AI step for the rule behind it (9.3 "Lists").
- **An identifier-shaped value** (shared `identifiers.ts`, `rules/savedContents.ts`): any value a format would save - a label or constant, a table or value-map key or value, a condition's, a filter's or a check's value, a "Do this every time?" fix - with a shape code recognizes with certainty (an Israeli ID, a phone, an email, a card number, an IBAN; the whole value, then each word of a longer label; a number as an ID or a card only). Ledger accounts, item codes and barcodes are not (no digit-run rule); a person's name used as a label cannot be detected, and the privacy page says so.
- **The popup**, on Save only, and only for findings the server does not hold yet (compared value by value in the browser, on the rules as the save sends them): "**Save this format?**", a line per finding ("**{Column}** is a list of {n} fixed values taken from your example (one for each {key})." / "**{Column}** keeps {an ID number / a phone number / an email address / a card number / a bank account number} in its rules."), then **Keep them** / **Save without them** / **Cancel** (one finding: Keep it / Save without it; neither styled as the main answer). **Keep** saves as is. **Save without** takes each listed column out in one undoable edit ("needs your input", reason `overfit` for a list, `savedWithout` for an identifier, 8.10), with what nothing reads any more, and removes a fix, filter or check that holds an identifier. **Cancel** saves nothing. It runs on every save from a learn (Save format, Save changes, Add a source) and in the saved source's editor; the Run screen's fixes have their own form of it (5 C). A save with no finding takes one click. On the first Save of a learn whose output is one of the user's saved formats (5 A step 8) it is still ONE dialog: the format question first, these lines below it, their question answered with a radio (Keep / Save without, neither chosen in advance) before the save buttons can be used; the save then goes where the format question said.
- **Unread lists are never saved:** every save's rules lose the lookup tables and value maps nothing reads any more (shared `withoutUnreadLists`), with the AI's notes (8.10).

The raw JSON stays behind an "Advanced" toggle and is validated on save.

### 8.12 Formats and conversions (the registry)

The product keeps two kinds of objects:

- **Format:** the shape of a file the company produces, owned by the company and named by the user (e.g. "Priority catalog load", "Monthly commission control"). It holds:
  - `output` (columns, headers, number formats, widths, title rows, summary rows, direction, language, `file`);
  - the layout parts that live in `transform`, normalized to output headers: `sort`, and `group` (by, summary rows, blank rows, showDetailRows, per-column agg);
  - output validations (`on: "output"`).
  - Summary rows (8.6) are already keyed by output header, so - unlike `sort`/`group.by` - they need no id translation to belong to the format.
- **Conversion:** how one kind of input file (a **source**: one supplier's price list, one insurer's report, one client's export) becomes that format. It is a full, self-contained rules file (8.1) plus `formatId` and `sourceId` (8.15). The engine only ever runs a conversion; it never needs the format object at run time.

A format usually has several conversions. That is the point of the registry: the company defines its format once, and each new source is attached to it.

**The format lock.** When a conversion belongs to a format:
- its `output` section must equal the format's `output`, except `columns[].from`;
- its `sort` and `group`, after code maps ids to output headers, must equal the format's;
- its output validations must equal the format's.

Code enforces this after every learn and every edit (9.2). A conversion that breaks the lock is rejected, and a repair call receives it as a `formatMismatch` problem.

**Editing a format.** A change to the output side made from any conversion's rules map is a change to the format. The editor says so ("This changes the format for all N sources"), and on save the change is written to every conversion of that format. Conversions whose `from` references still resolve keep their status; the others become `needsReview`. Every other conversion is rebuilt first and the edit is refused, nothing written, when one of them would break a cap as a save would (`rulesTooLarge`, `rulesPerFormat`, `invalidRules`; decided 2026-10-07). Example files are not stored, so re-verification happens on each conversion's next run: its flags and summary are shown with a "format changed since last run" notice.

**Matching a file to a source** (flow C, and detection in A and A2): code compares the file's headers with each source's input signature (8.15) (exact, then aliases, then normalized headers, as in 8.2 step 1). Score = share of required columns found, minus a penalty of 0.01 per extra unknown column, at most 0.05 (`limits.matching`; a header in the source's `ignoredHeaders` is known, so it costs nothing). One conversion with a score ≥ 0.9 and at least 0.1 above the next is selected automatically; otherwise the user picks from the top 3. Never run automatically on a guess below the threshold (DECISION 10).

**Same format** (decided 2026-10-07: "new format or new source" is decided by the OUTPUT only; the input's names never count). A learned output is a saved format when the STRUCTURE of the two outputs is equal (shared `sameOutputStructure`, on `formatOf` of the learned rules and the stored format):
- the output headers, in order (spaces around a header and runs of spaces inside it do not count; nothing else is loosened);
- the file kind (xlsx / csv / txt) and whether it has a header row;
- the title rows: how many, and which of them is blank - never their text, which changes from month to month ("Report for March");
- the summary rows, in order: which columns they fill and with which aggregate (not the label);
- the grouping: by which column, with or without the detail rows, the per-column aggregates and the group's summary rows.

Not compared: number and date formats, widths, sheet name, direction, language, header style, sort, delimiter / encoding / quoting, the summary rows' labels, and the output checks. DECISION: the output checks are not required to match; those differences are the format lock's, which decides whether the file can be added as a source (5 A step 8). An output with no header row never matches (its headers are names code made up). A csv or txt output has no sheet, widths, header style or direction in its file (8.13), and code names its "sheet" after the file ("orders 2026-09"): before the lock check, and in what an update or an add saves, those take the format's (shared `withUnwrittenOutputOf`; the file written is the same), so another file name is no difference. Then, for each matching format, the example input is matched to the user's sources as above, with the server's stricter reuse rule (8.15: one clear winner, no required column missing): when that source feeds the format, Save offers an update of its conversion (5 A step 8; engine `findFormatMatches`, run in the browser's worker on the rules, the example input's headers and the API's formats and signatures - structure only). Before the learn, the same matching on what the example shows (5 A step 2; engine `findAlreadyLearned`) decides "You already have this format" and "Is this file another input for it?".

**Formats with several sources** (the feature switch, decided 2026-10-07; `config/features.ts` `formatSources`, the API's `FEATURE_FORMAT_SOURCES=on|off`, **off by default**). A format is the output; each kind of input file has its own rules, kept as a "source" behind the scenes. The switch hides only the EXPLICIT source UI: the "Add a source" buttons and screen (A2; an old `/formats/:id/add-source` link lands on the format) and the source counts and names on My formats' cards ("← N sources" and the list under it). And the word: while it is off, users never meet "source" - the app says "input file" (web `i18n/inputWording.ts`, over the dictionaries and the shared codes' texts): the format page lists its **Input files** by their saved names, with no rename and **Remove this input file** (with a confirm, and not for the format's last one - the format itself is deleted from My formats); the saved editor says "An input file of **X**"; the Run screen, the messages and errors, the result screen and the public pages say the same. A test holds that every message that says "source" is reworded or shown only by the explicit source UI. Everything the learn does with formats and inputs works whatever it says: "You already have this format", "This output matches your format - is this file another input for it?" (saved through the attach route, which the switch therefore does not close: its plan limit and the format and source locks still hold), and Save's "Update your format X?" (5 A steps 2 and 8). The API tells the web app the value it runs with (`GET /api/session` `features`), so turning it on is a configuration change, not a new build. On: the explicit source UI too.

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
- **Filled from the example** (decided 2026-10-04): the AI step writes the lookup with the entries its samples showed; code then adds every key → value pair the WHOLE example shows (the key read by the rule's own key expression, the value from the aligned output row; for a lookup inside a condition, only the rows where its branch is the one taken). A key whose rows give two different values is not filled (those rows go to the learning loop or the user); the AI's own entries are never changed; keys the example never had are flagged next month (`onMissing: "flag"`); a table that would pass 500 rows, or a cell over the 300-character value cap, is not filled. Value maps are filled the same way (never past 500 entries or the value cap). The pairs are reference data the user approves with the rules, like a table they type; they are never sent to the AI step.

**In the rules map**, a **Functions and tables** section lists each one as a sentence with its signature. Each has a test panel: enter arguments or a key, see the result. Every function, table, output column, filter, dedupe, expand, sort, group and validation counts as one **rule** for tier limits (11).

### 8.15 Sources

A **source** is one kind of incoming file the company receives or keeps: one supplier's price list, one insurer's report, or a master file (e.g. an analyst's balances file) that is updated all the time but keeps its structure. Like formats, sources belong to the company and are named by the user.

- **Fields:** name; `inputSignature` (columns: header, aliases, type, required, and the shapes `padLeft`, `inputFormats` and `readAs`); `inputReading` (sheet pick, header row, stopAt); input validations; versions; `ignoredHeaders` (13). **Structure only:** headers, types and shapes. Never values, min/max, samples or anything read from data cells. DECISION: `readAs` (8.4a) holds texts, but they are the rule's own parameters, typed or confirmed by the user on the Run screen (like the bounds of an input check), not anything code read from the data.
- **A conversion links a source to a format.** The registry is a graph: a format can be fed by several sources (many suppliers → one load file), and a source can feed several formats (one master file → several reports). The engine still runs only a conversion's self-contained rules file; it never needs the Source or Format object.
- **The source lock.** A conversion's `input` section must match its source: every input column it declares exists in the source with the same header, aliases (as a set), type, padLeft, date formats (`inputFormats`: they are how the column is read) and `readAs` (8.4a, as a dictionary; a conversion may use a subset of the source's columns), and its sheet pick, header row and stopAt equal the source's. `required` is not locked: a source's flag is derived (required by at least one conversion), since one conversion may need a column another doesn't. Row filters and the checks only code writes (`cutoffRange`, `sameAs`) are not part of a source: they say which rows a format wants. **Input validations are compared per column, on the columns the conversion declares** (decided 2026-10-03): a check on a column it doesn't declare is ignored for it; a `flag` check that only one side has on a column both have is no mismatch (it only marks rows, never changes an output), and a source merges them; a `block` check (it leaves rows out) must agree. Code enforces it wherever the format lock runs (after a learn, on every editor save); a conversion that breaks it is rejected like a `formatMismatch`.
- **Editing a source** propagates to all its conversions, like a format edit (8.12; refused, nothing written, when a rebuilt conversion would break a cap): headers, aliases, types, `readAs`, reading options and input validations (each conversion gets those on the columns it declares) are written into every conversion's `input`; a conversion whose rules no longer resolve becomes `needsReview`. Only when the source feeds **more than one** format, an edit in the editor that changes the input side says "This changes the source for N formats" before saving (like the format-change warning); with one format there is nothing extra to say.
- **A structural change in an incoming file** (a column renamed, missing or added) is detected at RUN time, when the new file is dropped (flow C, and per file in D); sources stay invisible - no fingerprints, versions or Sources page. The user is shown which formats still work and which need attention, and decides what to fix and how: nothing is changed automatically (decided 2026-10-03).
  - **Renamed:** a required column the file lacks, while it has columns nothing claimed that the source did not already know (`ignoredHeaders`), is offered as a rename once per source, and only when a format uses the column; the step lists the formats that do. A confirmed mapping is saved once, as an alias on the source (at most 20 per column), and fixes every format. Renames are offered for required columns only: a used optional column that was renamed shows under "Needs attention", where "Open in editor" can add the alias.
  - **Missing:** what is still missing is settled **per format**. Code works out, for each conversion, the input columns its rules actually use (output columns through computed columns and across-row functions; row filters; duplicate keys; expand; sort and group; title rows; input-side checks). A required column that is missing, or a used column that is missing though optional (`required` is only set when the example had no empty cell in it), puts that format under "Needs attention" with the column names. A declared column nothing uses may be missing and changes nothing.
  - **New:** a column the source's signature doesn't know (after headers, aliases and the user's rename answers), that no rename answer used and that is not among the source's `ignoredHeaders`, gets one quiet notice after the run, with "Add it to a format". Dismissing it adds the header names to the source's `ignoredHeaders` (13), so it doesn't come back every month. The example's columns that no rule reads are remembered there when the source is saved: they are not "new". The notice is for single-file runs; a batch only reports what a format lacks.
  - **Same name, different meaning:** see 5 C: a used column whose values mostly don't parse as before puts the format under "Needs attention".
- **Saving:** flow A creates a source, a format and the conversion between them; flow A2 creates a source and a conversion. A flow A learn whose output is one of the user's saved formats is asked at Learn whether its file is another input of it (5 A step 2: yes adds a conversion to that format at Save, as A2 does), and, when its input already feeds that format, at Save whether to update it (5 A step 8: a new version of that conversion). When the example input matches an existing source (the same matching and threshold as flow C), that source is reused, merging in its new columns, aliases and input checks (see the source lock). A source with a required column the file lacks is never reused, nor (flow A2) one that already feeds the format; a reused source's `readAs` union holds to `maxReadAsPerColumn`. Two formats learned from the same file share its source even when they read different columns. A new source's name is the one typed (`newSource`, or the add-source screen's `sourceName`: refused with `nameTaken` when taken), else the example input's file name without folder, extension, digit runs and the separators left over ("orders 2026-09.xlsx" is "orders"; `suggestedSourceName`, made in the browser from the name only; " (2)", " (3)" when taken), else the first free "Input N" (neutral, since the name shows while the source UI is off). Source names are unique per owner, case-insensitively. Every conversion has a source (`sourceId` is required; the source's name is the only name, and `meta.sourceName` inside the rules is informational and follows a rename); there is no migration path for data written without one. Deleting a conversion or a format keeps its source; a source with no conversion can be deleted.
- **MVP:** sources are created or reused automatically and silently when a format is saved - also when a learn's "Yes, learn it for X" (5 A step 2) adds another input to a format, whatever the feature switch says (8.12: it hides only the explicit source UI); there is no source UI yet (a Sources tab and choosing a source as the input come after the MVP). One source feeding several formats is supported by the model, and Convert and Batch handle it, but nothing advertises it.

## 9. LLM layer

### 9.1 One stateless call
Every LLM call is a single request with no chat history:
- **`system`:** the fixed system prompt from `LEARN_PROMPT.md`, marked for prompt caching;
- **`messages`:** exactly one user message containing the payload JSON;
- **output:** constrained to the rules JSON Schema with the provider's structured-output feature. For Claude, that's JSON outputs via `output_config.format`, or strict tool use; confirm support for each model in the registry against the current docs.

The model writes no prose. `max_tokens` is `limits.llm.maxTokens` (4,000), and temperature is 0 where the model supports it.

**The prompt version** (`config/prompts.ts`). The code can send two: **learn-v7**, the default `promptVersion`, and **learn-v9** (learn-v7 plus one section, "Checking with code"), sent only where `LEARN_CHECKS` turns it on (below; off by default) and by the eval (`--prompt learn-v7|learn-v9`). (learn-v8 and learn-v8.1 were measured against learn-v7 and rejected on 2026-10-05, and their code removed on 2026-10-07; a stored `promptVersion` naming one still reads, as plain text.) The version a learn is actually sent travels with it everywhere (decided 2026-10-07): the cache key, the learnId's group, the ledger (cache hits included), every answer and the saved format.

**AI code checks: a learn in steps (learn-v9; decided 2026-10-05). Off by default.** `LEARN_CHECKS=off|admin|all` (`limits.learn.checks.mode`, default `off`; admin = the admin accounts, 12); an invalid value stops a production start. The code stays, switched off, until it is re-evaluated by 2026-11-15 (20.16). When on:
- **Five checks, a closed list** (`packages/shared/src/checks.ts`): `test { column, rule }` - how many rows the rule gives the output column's exact value, up to 3 failing rows; `ranges { column, by }` - the runs of one value along a number or date column, or `clean: false` and the run count (a tie, or more than 12 runs); `dependsOn { column, on: 1-2 }` - keys, agreeing rows, conflicting keys, up to 2 conflicting pairs; `values { column }` - distinct and empty counts, the 10 most common values, min and max; `rows { where, limit 1-5 }`. Any check may add `let` (up to 3 helper columns) and `where`. An input column is `in<i>`, an output column its header (`out<i>` inside a formula), and in completion mode the ids of `complete.fixed` too. Errors are answers (`{ error }`), including a check past its 5 s time budget.
- **The protocol.** Every call of the learn is constrained to ONE answer schema, `{ checks, rules }`, exactly one non-null, so the provider's cached prefix holds across calls. The first call may answer with up to 4 checks; the browser answers them on every row (engine `learn/checks.ts`: each runs as a small rules file through the engine's own runtime, its constants unmasked first, every value that leaves masked like the sample, 7.3) and calls `POST /api/learn/step` with the payload, then one block per round so far (`{ round, checks, answers, dropped? }`, the newest with a cache breakpoint), at most 3 rounds; after the last, a block says to answer with the rules now. The API keeps only the checks it accepts (`acceptChecks`) and tells the next round about the rest; an answer with rules and checks is taken as its rules; checks where rules are due are a schema problem for the repair round. The server keeps nothing between steps: a step counter per signed learnId (`step:<uuid>`) and each request's size (`stepFits`). The learn's repairs and escalation carry the rounds; loop rounds carry none. The fresh learn that stands in for a loop round after a cached result is sent `rulesNow`.
- **The quota:** still one learn, counted on success: the unit reserved for a call that answers with checks is put back at once and each step reserves it again, so an abandoned learn costs nothing. A learn with rounds is never cached.

**Thinking is off where the model allows it** (decided 2026-10-04): thinking tokens count toward `max_tokens`. Haiku 4.5, Opus 4.x and Sonnet 4.6 are sent nothing (they do not think unless asked); Sonnet 5 and Opus 5 `thinking: { type: "disabled" }`; Sonnet 5.5 `{ type: "between_tools" }`, its lowest; a model whose thinking cannot be turned off (Opus 5.5, Fable, Mythos) is sent nothing and gets `limits.llm.maxTokensThinking` (16,000). DECISION: nothing in the eval shows thinking makes the one schema-constrained answer better, and it would cost tokens and latency on every escalation (20.19).

**OpenAI requests** (the fallback, 9.6; checked against OpenAI's docs 2026-10-05). gpt-5 and gpt-5-mini are reasoning models (`providers/openai.ts`): `reasoning.effort: "low"` (DECISION 2026-10-05: at `"minimal"` gpt-5-mini wrote a price cut-off as value-map keys; at `"low"` it verified first time, for less), never `temperature`, `top_p` or `top_logprobs`, and `max_output_tokens` of 16,000; a model the table does not know gets no sampling parameter and no effort. The answer is constrained with `text.format` (`json_schema`, `strict: true`): the wire schema rewritten into OpenAI's strict subset with the same meaning (every property required, an optional one `anyOf [it, null]`, `oneOf` and type lists as `anyOf`, `minLength` as `pattern`, `$schema` dropped), the nulls taken back off the answer so it parses with the same zod schema. `instructions` is the system prompt, then one user message (payload block, then a repair block); caching is implicit, keyed by a stable `prompt_cache_key` per prompt text. `store: false`. `incomplete` with `max_output_tokens` is a cut-off; a `refusal` part a refusal.

**A cut-off answer is its own outcome.** An answer stopped at the output-token limit (Anthropic `max_tokens` or `model_context_window_exceeded`, OpenAI `incomplete`, the dev CLI's `stop_reason`) is recorded with its usage and cost as outcome `truncated` (`problemCounts.truncated`), never as invalid JSON or a schema error; the repair round asks for the whole answer again, shorter (9.3). An attempt with no rules never beats one with rules when the best attempt is kept.

**A dev CLI call that hangs is stopped** (decided 2026-10-05). The dev provider `claude-cli` (the developer's own subscription; refused in production) spawns one CLI process per call; after `limits.llm.cliTimeoutMs` (5 minutes) THAT child is stopped through its own handle (never a process looked up by name), and the call fails as `error:timeout`, counted, with no usage; the learn goes on as after any failed call.


### 9.2 Checking what the LLM wrote
A rules file is accepted only after it passes these layers, in order. Every failure becomes a precise problem for the repair call (9.3). Nothing is judged by another LLM.
1. **Structure:** zod against the schema. Unknown fields, operations and enum values are rejected.
2. **References:** every column id, table, function and param exists; ids created by expand and by computed columns don't collide; every input header exists in the input profile; `from` is null exactly for `skipColumns` plus `unsupported`; output validations name existing output headers.
3. **Types:** a static type check of every expression, filter and function body against the declared column types and the operation signatures (8.3). Each output column's result type must fit its output type (for a summary output, the type after the column's `agg`: a count is an integer whatever it counts).
4. **Limits and safety:** depth and node budgets, function and table counts, an acyclic call graph, unique table keys, and a rule count within the user's tier (11).
5. **Format lock,** when the conversion belongs to a format (8.12); in completion mode the **fixed lock** instead: every element of the rules the user already had must come back unchanged. An answer that changed or dropped a fixed part has it **put back by code** from the fixed rules first (`restoreFixed`), and every layer runs again on the result; only what code cannot put back (a new value map on a column a fixed output column reads, a listed column with no rule) is a `fixedMismatch` for the repair round. The checks still decide.
6. **Overfitting: the guards drive one repair, the lint stays a "Please check" line** (decided 2026-10-05; engine `learn/overfit.ts`).
   - **The guards** find a rule that copies particular rows of the example instead of stating a rule, whatever the prompt says:
     - **position:** a condition comparing a whole-file row position (`rowNumber()`, `rank(...)` with no `by:`) with a constant, also through a computed column or `oneOf`. `rowNumber()` as a VALUE, and a position within a group (`rowNumber(by: customer) = 1`), stay allowed;
     - **memorized case list:** a chain of cases (`switch`, or `if` nested in the else) giving constants to the rows that equalities or ranges of two or more input columns pick, counted by **atoms** (decided 2026-10-06: a case's top-level `or` disjuncts and each `oneOf` value; an `and` is one atom): a finding when at least `limits.learn.overfit.minCases` (6) atoms each pin 1 to `maxRowsPerCase` (2) rows and are at least half of all the atoms, or at least 6 cases each hold for at most 2 rows. A band table or a value map written as a `switch` reads one column and is never one;
     - **a list keyed on a measure:** a lookup or a value map whose key is made of a decimal, currency or percent column (`keyColumnsOf`: through computed columns and functions of the value, not through a condition or a lookup's result), however it reads it. An amount is no category: such a table only holds this file's rows. An integer key may be a code, a date a calendar.
   The API counts on the samples and a loop round's rows, the browser on every row; in completion mode only the asked columns count. A position condition that names exact rows (`rowNumber() = 54`; `rowExact`) and a case list only the atoms show are the browser's alone (whether a row was hand-edited once is the user's question, below). A finding asks for **one repair per learn** (an `overfit` problem per column, naming the shape found), sent by the server repair or a loop round, whichever comes first (`overfitRepaired` travels between the two). **The honest fallback:** an answer that still has the finding after it, or one no call can repair any more, gets the column reported unsupported by code, reason `overfit` ("needs your input", 8.10), its rule taken out with the computed columns, tables and value maps nothing reads any more (`withColumnsTakenOut`): a copy of the example is never counted as verified. When the best attempt is kept, one that copies rows never beats one that does not. Counted in `problemCounts.overfit` / `overfitFallback` and the eval's "Copies rows". DECISION: the thresholds come from the 2026-10-05 measurement, where they found exactly the memorized answers and no correct rule.
   - **The lint** is never a rejection or a repair: each finding is a "Please check" line, assumption `overfitSuspected` (DECISION: each kind also fires on correct rules) - a constant equal to a value in only one input row (never a cut-off's constant), a condition true for exactly one sample row, a `switch`, value map or table with one entry per sample row, an expression far larger than any other column's.
7. **Run on the samples** in the API, and diff - in a loop round on the samples PLUS every row the browser sent since the learn, so a later round cannot break a row an earlier one fixed. Cells are compared exactly as the browser compares them (engine `cellsMatch`, typed: a csv / txt example's "12.50" equals the rules' 12.5; decided 2026-10-07). A column honestly reported `unsupported` is "needs your input", not a mismatch, here and in layer 8 - unless the pair analysis found how it is built (the payload has a hint for it): giving up is then an `unsupportedDespiteEvidence` problem for the repair round (a model that stands by it after the repair is accepted). An answer that produces no column at all is a failure. A column that reads other rows (a summary output's aggregates, a window function) is left to layer 8.
8. **Full verification** in the browser on every row of the real example (5 A step 6): the hold-out test - rules that only memorized the samples fail here, and the rows they fail on are what the learning loop sends next (9.3). In completion mode the browser puts back the fixed parts first. Besides every cell (a date in a csv / txt example compared by the text the delimited writer writes), it compares the row count, the title, header, blank and summary rows, and **the order of the data rows** (decided 2026-10-07; problem `rowOrder`, row numbers only): adjacent pairs of the example's order count, except rows equal in every compared column, and, when no sort explains the example's order, rows the rules' own sort keys tie. An answer that reports a column `unsupported` is still checked on the whole layout, that column's cells left out (`skipColumns`); an answer with no rule at all is never verified. (The local partial result is compared on its built columns only.)
   **Before it, code fills the data parameters from every row** (decided 2026-10-04; `learn/fillParams.ts`): the AI step writes the logic, code fills the data, on the unmasked answer, for the first answer and every round, in the browser and the eval alike. Only these shapes: (1) lookup tables and value maps - every key → value pair of the example (8.14); (2) value lists in conditions (`oneOf`, an or-chain of `=`, a single `=`) - a value is added when every row holding it is right with the condition true and some are wrong now; (3) cut-offs - one numeric or date column compared with one constant: each gap between neighbouring values is scored exactly with the comparison forced true and false; the AI's value is kept when it is inside the best range, else the roundest number inside (fewest significant digits, then nearest the middle; for dates a 1 January, then a 1st of a month); a range of more than one value becomes a `cutoffRange` check (8.8); a range open on one side is left as written; (4) band tables - each boundary a cut-off; (5) the day/month order of text dates - a part above 12 proves it; unproven, the AI's choice is kept and reported (`ambiguities`) for the question (8.11); (6) which duplicate is kept and which values an `ne` / `notOneOf` filter drops - the other choice when it makes fewer rows wrong. At most `limits.learn.fill.maxConditions` (24) conditions per answer, never past the saved-format caps (8.3); the user's own parts are never changed in completion mode; a fill that would make the example worse is dropped; rules with a window function keep their conditions. Nothing filled is ever sent (a round's `previousRules` is the answer as the AI wrote it); the result reports kinds and counts (`filled`) for the UI's note and the eval.
   **One-time parts, after the guards and the fill** (decided 2026-10-05; `learn/oneTimers.ts`). A row of an example output is sometimes edited by hand once, and the AI step then writes a part of a rule only to reproduce it. Code counts on every row how many rows each part explains - each branch of an `if` / `switch`, each entry of a lookup table or value map, each value of a value list in a condition (only parts an output column shows; a value-map entry that writes what it reads is none). A part that explains exactly one row and applies to no other is a **question for the user** (8.11) when something unique to that row singles it out: an **ID** (an input column that is a key of the example), an **exact amount or date** no other row has, or its **position** (a whole-file `rowNumber()` / `rank()` equal to a constant, or a list of row numbers). DECISION (questions must stay rare): nothing else - a categorical value seen once, a threshold that picks one row, or a combination is a plausible real rule; a part whose row the rest of the rule gives the same value is not asked; one question per row of a column. **At most `limits.learn.oneTimer.maxQuestions` (3) per learn**, in output order; a column with more such parts asks nothing and is handed to the guards (a memorized list or a table of amounts falls back there; a column no guard finds keeps its rule). DECISION: the one guard a question replaces is `position`, for a column whose every position finding goes once its asked parts are taken out. The questions travel with the learn result (`oneTimers`; real values, the browser's and the eval's only, never sent). The free engine never writes such a part.
   **A time budget per AI answer** (decided 2026-10-07): the fill, the guards and the full verification run the rules on every row (up to 100,000 on the paid tier), so each answer is bounded by `limits.learn.judge.timeBudgetMs` (20 s), read between steps. Past it the fill settles nothing more (`filled.stopped`) and the learn makes no further round and no list round: it ends with the best answer so far (loop end `timeBudget`), verified only when every row matches, otherwise its differences are the user's. The questions at the end are still asked.

The same layers 1–6 run in the browser on every save from the editor.

### 9.3 Repair (optional, also stateless)
If checks or the diff fail, send one more single message. It has two content blocks:
1. the same payload, with a cache breakpoint so it's read from cache;
2. `{ mode: "repair", previousRules, problems[] }`.

The model changes only what the problems require. The instruction appended to the repair block is versioned with the prompt (`LEARN_PROMPT.md` section 4, `prompts/repair.ts`): learn-v7's is "Fix only what the problems require. Keep everything else identical."; learn-v9's adds "Answer with the rules".

A row in a problem always means one thing: `row.in` is its input and `row.out` the example's own output row for it - `[]` when the example has none (a row it dropped, or one row more than it made from that input row). A row the rules made that the example does not have (`expected: null`) is carried whole in `made`. This holds for the browser's verification, the learning loop's rounds and the API's sample run alike. A `truncated` problem (9.1) has no `previousRules`.

- **Server repair rounds:** `limits.llm.serverRepairRounds`, 1 (0 makes exactly one call per learn); every loop round gets the same for its own check problems. A call with no answer (the provider failed, or nothing was sent) gets none.
- **Browser-triggered repairs: the learning loop** (decided 2026-10-04; `limits.learn.loop`, `limits.llm.browserRepairCalls`). After the full verification (9.2 layer 8), while rows are still wrong, the browser sends another round:
  - **Which rows:** the wrong rows are grouped by (output column, the example's value, the value the rules made); one row from each group, biggest groups first, then a second from each, up to 8 new rows a round, never a row already sent, masked like every sample (7.3). Each is a `diff` problem carrying the row (at most 10 a round; a row sent earlier that is still wrong may be named again), beside the fixed lock's findings, the row count and layout problems; the request also carries `rows`, every row sent so far. With masking on, every value a problem quotes (a cell's `expected` and `actual`, a title or summary cell, a header the answer wrote, the fixed lock's findings) is masked like the samples, or left out when it cannot be; the UI's own messages stay real.
  - **The server:** `POST /api/learn/repair` under the learn's signed `learnId`, at most 3 per learn, within `limits.protection.learnIdTtlMinutes` (60) of it. Refused before a round is counted: rows past the loop's caps (`invalidRows`), problems of an unknown kind or more than `limits.learn.loop.maxProblems` (100; `invalidProblems`), a payload whose structure group is not the learnId's (`invalidLearnId`). The answer is checked on the samples plus every row sent (9.2 layer 7) and gets its own server repair; no escalation (9.4).
  - **When it stops:** every row matches; a round that does not lower the number of wrong rows below the best so far; 3 rounds; 40 rows; not even a round with no new row fits the payload cap (rows over the cap are named in the problems only, 7.3); nothing left to tell; the time budget (9.2). Wrong rows count each differing output row once, each row the rules make that the example lacks, each layout difference and each fixed-lock finding (in completion mode, only what the answer is answerable for).
  - **What is kept:** the best answer (fewest wrong rows; ties keep the earliest). Unverified, it is shown with its mismatches and the panel of rows that still differ (8.11); for completion, the user's rules stay unless the answer passes the fixed lock and matches.
  - **One driver:** the loop's step is one pure engine function (`learn/loop.ts`) that `learnFromExamples` runs, in the browser and the eval alike. After a cached result fails the full verification there is no learnId to repair: the browser makes a fresh learn instead (sent `rulesNow` under learn-v9) with the rows sent since.
- **Lists: one automatic round for the rule behind a list** (decided 2026-10-06). When the kept answer takes a column from a list of fixed values (8.11 "Saving"), the browser sends ONE more round, with no click, within the loop's caps: a problem of kind `list` per column - `Column "{column}" is a list of {n} fixed values, one per {key}. Find the rule behind it from the other columns. Only if no rule exists - the value depends on each {key} itself, or comes from outside the file - keep the list.` - never a value, and no new row. Under learn-v9 that round may ask checks first (`RepairRequest.rounds`). An answer without the list replaces the kept one when it is no worse; otherwise the list stays, is used for the file, and is asked about at Save. One per learn; none for a cached answer or past the time budget; the guards' own repair never rides in it. The result carries `listRetry` (`logic` / `kept` / `worse` / `noAnswer`).
- **A learn-v9 learn** (off by default, 9.1): its repairs are sent learn-v9 too, with the payload, the learn's rounds of checks (a loop round carries none, except the list round's own) and the repair block; a repair that asks checks has a schema problem.

The formats are in `LEARN_PROMPT.md`.

### 9.4 Model choice
The model registry lives in config (`packages/shared/src/config/models.ts`), two slots per provider - candidates the eval benchmarks, not settled choices (20.19):
- `anthropic` (production): first try `claude-haiku-4-5-20251001`, escalation `claude-sonnet-5`;
- `openai` (the fallback, 9.6): `gpt-5-mini`, `gpt-5`;
- `claude-cli` (development): `haiku`, `sonnet`; `fake` (tests).

If the first-try model still fails after its repair round, make one attempt with the escalation model. The evaluation harness (10) decides which model fills each slot. The rounds of the learning loop (9.3) use the first-try model and are never escalated.

Prices per million tokens are in config (`config/prices.ts`), copied from the provider's pricing page, and used to compute the cost of every call: Haiku 4.5 $1 in / $5 out, Sonnet 5 $2 / $10 (cache read 0.1x and write 1.25x of the input price); gpt-5-mini $0.25 / $2 and gpt-5 $1.25 / $10 (cached input 0.1x, no cache-write surcharge), the dated snapshots OpenAI reports (`gpt-5-mini-2025-08-07`, `gpt-5-2025-08-07`) priced too; `claude-cli` calls cost $0 (the developer's subscription). A model with no price is costed at the highest configured price (never $0, so the budget sees it), and a production start refuses any configured model - the defaults, the overrides, the fallback's - without a price (decided 2026-10-07).

### 9.5 Cost controls
- **Code first.** Pre-flight blocks, the fast path and hints (section 6) are the biggest savings.
- **Server-side limits per tier.** A "learn" is one user action that reaches the LLM, however many calls it takes.
- **Sign-in is the gate.** Only a signed-in user reaches the AI (decided 2026-09-30; the anonymous leftovers removed 2026-10-07): `POST /api/learn` answers a visitor 403 `signInForAi`; there is no anonymous AI step, so there is no Turnstile on a learn and no anonymous budget. A user's AI learns count against the tier's quota (11); every request that calls the AI (`/learn`, `/learn/step`, `/learn/repair`, whatever it ends in; a cache hit calls no AI and is not counted) against a daily cap, `limits.protection.aiRequestsPerDay` (registered 40, paid 400; 429 `limitHit` `aiRequestsPerDay`); and the learn routes are rate-limited per IP (10 a minute, in memory). (Turnstile guards the public forms only, 13.)
- **One admission for the AI routes** (decided 2026-10-07): `/learn`, `/step` and `/repair` share one `admit()` - signed in, the payload's shape, its byte cap and every cell within `maxCellChars`, the rest of the body, the learnId, the cache, the failed-pair cap, the budget, the follow-up's counter, the quota reservation; a loop round's rows are held to the cell length too.
- **The outcome report.** The browser reports a learn's final verdict to `POST /api/learn/:learnId/outcome`; a `failed` report gives the learn back, at most `limits.protection.failedRefundsPerDay` (10) times a day per user (past it the report still evicts the result from the cache, but the learn stays counted).
- **Budget.** A daily overall budget, in USD in config (`limits.budgets.dailyOverallUsd`, 50): the kill switch.
  - Also set a monthly spend limit in the provider's console (each provider's: Anthropic, and OpenAI for the fallback, 9.6).
- **Cache.** The key is a hash of the structure: headers, types, layout and masking mode. If the same structure comes in again, the saved rules are returned without an LLM call, and verification runs as usual. Only learns made with masking ON are cached (decided 2026-10-05): with masking off the rules' constants are real values from the example, and the cache is not worth holding them for a format the user may never save. An entry is returned only to the same owner, holds only rules without text constants, expires after `limits.cache.ttlDays` (30), and is keyed with the prompt version sent; a completion answer, an answer made after rounds of checks and the AI's notes are never cached (13 `learn_cache`).
- **Ledger.** Every call is logged in `llm_calls`.

### 9.6 One LLM interface
All LLM calls go through one function in `apps/api`, e.g. `complete({ system, content[], schema, model }) → { json, usage }`. No provider SDK is imported anywhere else, and the provider is chosen in config.

This keeps two later options cheap: switching providers, and a customer running learns on their own model endpoint, with their key never reaching our server. Design for it; don't build the customer endpoint in the MVP.

**Providers.** `anthropic` (production), `openai` (the production fallback), `claude-cli` (development only: the developer's own subscription, refused in production) and `fake` (tests and the eval's dry run). `LLM_PROVIDER` picks the primary; `LLM_MODEL_FIRST_TRY` / `LLM_MODEL_ESCALATION` override its two slots. Each adapter maps its SDK's errors to one `LlmError`, and marks the ones where the provider could not serve the call at all (`unavailable`: `network`, `timeout`, `rateLimited`, `overloaded`, `serverError`, `auth`).

**Fallback** (decided 2026-10-05; `apps/api/src/llm/fallback.ts`). With `LLM_FALLBACK_PROVIDER` set (production: `openai`; in production any provider but `claude-cli` and `fake`, and its key is required), a call the primary cannot serve is made once more, at once, on the fallback: the same request (purpose, system prompt, content blocks, schema) in the same slot - a learn or repair call on the fallback's first-try model, an escalation on its escalation model (`models.openai`: gpt-5-mini and gpt-5; `LLM_FALLBACK_MODEL_FIRST_TRY` / `LLM_FALLBACK_MODEL_ESCALATION` override them).
- **It fails over on** a provider-level failure of the primary: a network error, a timeout, HTTP 429, any 5xx, Anthropic's overloaded error (529), and 401 / 403. DECISION (a bad or revoked key): it fails over AND logs an error each time the primary is tried - a misconfigured key must not take the product down, and the breaker keeps the log to one line per cool-down.
- **Never on** a wrong answer (the checks' problems go to repair as before), a cut-off answer (repair), a refusal or invalid JSON (the provider answered), or a 400 / 404 / 413 (the request's fault, our bug: it fails loudly). The fallback is tried once; when it fails too, the call fails as before, recorded as the fallback's error (a learn whose calls all errored is never counted against the user, 11).
- **Circuit breaker** (in memory: one instance): after `limits.llm.fallback.tripAfter` (3) consecutive primary failures, each within `windowMs` (5 minutes) of the latest, every call goes straight to the fallback (reason `circuitOpen`) for `coolDownMs` (5 minutes); then the primary is tried again, and one more failure trips it again. Any answer from the primary resets the count.
- **Timeouts.** While a fallback is configured the primary's SDK client waits `primaryTimeoutMs` (2 minutes) per attempt and retries once (`primaryMaxRetries`), instead of the SDKs' 10 minutes and 2 retries, so a hung primary reaches the fallback within minutes; the fallback's own client gets the same, `fallbackTimeoutMs` (2 minutes) and `fallbackMaxRetries` (1) (decided 2026-10-07).
- **Unchanged:** the quota, the budgets and the learn sequence - a fallback call is one more call of the same learn, checked, repaired and escalated like any other, priced at the fallback model's own prices (9.4); the same learn prompt goes to both providers. The ledger says which provider and model answered and why (13); the admin overview counts the fallback's calls (14.2).
- **A real check:** `pnpm --filter @formatai/api llm-check -- --provider anthropic|openai` makes one real learn call on a bundled synthetic case (`crm-rename-reorder`, masking on), straight to that provider, runs the API's checks and prints the model, latency, tokens, whether the answer was cut off or verified, and any provider error - never the key.

## 10. Model evaluation harness

Built in M1, before the UI: prompt quality decides everything else. Results and the history of runs are in `eval/RESULTS.md`.

- **Case format.** Each case lives in `eval/cases/<name>/` with `input.xlsx`, `output.xlsx` and `meta.json` (`difficulty`, `features`, `expect`: verified | unsupported:<code> | blocked:<reason>, and optional `attachTo`: another case whose output defines the format). A case may also carry a next month's pair (`next.input.xlsx`, `next.output.xlsx`: the hold-out the kept rules are run on), `reference.rules.json` (hand-written rules; `cases/verify-cases.ts` checks that each reproduces its example, row order included) and `meta.answers` (the user's answers the runner applies before scoring: `copiedList: "oneTime" | "rule"` for "Save without it" / "Keep it", `identifier: "keep"`).
- **Cases.** 38 today (`eval/cases`, built by `cases/build*.ts`):
  - **Easy:** rename, reorder, drop columns. These should hit the fast path.
  - **Medium:** date formats, padding, value maps, filters, calculations.
  - **Hard:** subtotals and spacer rows, a title with the month, a summary output, a totals footer in the input, Hebrew RTL output.
  - **Rows:** duplicates removed on all columns and on a key; columns to rows (months); split cell; fixed fan-out (debit/credit); an expansion with no pattern (must be blocked).
  - **Traps:** leading zeros, DD/MM vs MM/DD, numbers stored as text, prefix-of-ID columns (masking), a pivot (must be blocked), a column from another source (must be skipped).
  - **Registry:** 3 different sources → the same format (e.g. three suppliers' price lists → one load file). The 2nd and 3rd are learned in attach mode; expect verified with the format lock intact.
  - **Output files:** csv and tab-delimited txt, with and without a header row, in UTF-8 and Windows-1255.
  - **English LTR cases** alongside the Hebrew ones.
- **Data.** Synthetic, spread across domains so the prompt doesn't overfit one of them: an importer's supplier price lists → an ERP catalog load file (tab-delimited, no header); freight invoices → a cost report; insurer commission reports → a commission control report; a payroll export → a pension deposits sheet; a customer list → a CRM import CSV; a bank export → a reconciliation sheet. The report also breaks results down by domain.
- **Runner.** `pnpm eval --models <a>,<b> --masking on,off --runs 3` runs the full production pipeline, pre-flight included, with the learning loop, code's fill, the guards and the questions in-process (the same engine functions as the browser). Options: `--provider anthropic|openai|claude-cli|fake`, `--mode full|complete|both` (a whole learn, completion mode, or both), `--prompt learn-v7|learn-v9`, `--no-pattern-hints` (the payload without the `bands`, `dependsOn` and `contains` hints, to measure the AI code checks against them), `--no-escalation`, `--cases`, `--out`. A real single call: `pnpm --filter @formatai/api llm-check -- --provider anthropic|openai` (9.6).
- **Report.** Markdown plus CSV, per model and masking mode:
  - share blocked, share fast path, share schema-valid;
  - verified on the first call, and verified after repair;
  - tokens, cost per learn, latency;
  - per learn: the loop's rounds, rows sent and how it ended; "Filled by code"; "Ambiguous"; "Copies rows" (the `overfit` findings and fallbacks); "One-time" (the questions asked and the columns handed off, and the list asked at Save); "Saved contents" (lists and identifier findings); check rounds and checks asked (learn-v9); hinted columns given up on, unsupported reasons, problem kinds, calls cut off or failed, lint findings;
  - the rules each AI learn kept (`rules/`), and the hold-out on the next month's pair;
  - failures grouped by feature and code.
- **Stress test** (`pnpm --filter @formatai/eval stress`, `eval/STRESS.md`): seeded generated messy example pairs through the free engine (no AI step), with a fair hold-out and invariants - every payload field that can hold cell text is checked for leaks (`maskLeak`); fixed seeds of every finding stay in the set.
- **Initial decision rule.**
  - First-try model: the cheapest model with at least 90% verified-after-repair on easy and medium.
  - Escalation model: the cheapest model that handles most hard cases.
- **Regression.** Re-run on every prompt, schema or pre-flight change, and bump `promptVersion`.

## 11. Tiers and limits

All numbers are placeholders in `packages/shared/src/config/tiers.ts` and `limits.ts`, to be tuned (20.4).

| | Free (not signed in) | Registered | Paid |
|---|---|---|---|
| What it's for | try it on one small file | a person's own recurring formats | a company's work |
| Max file size | 5 MB | 25 MB | 100 MB |
| Max rows per file | 300 | 5,000 | 100,000 |
| Max columns | 20 | 50 | 150 |
| Files per run | 1 (the rules just learned, nothing saved) | up to 5 | up to 50 |
| Converted output | first 20 rows on screen; sign in to download | full download | full download |
| Saved formats | none | up to 3 | up to 50 new per month (DECISION 9) |
| Sources per format | none | 3 | unlimited |
| Rules per format (8.14) | 30 | 30 | 300 |
| AI learns (reach the LLM; counted once, on success) | none — sign in to use AI (the local result is shown first) | 3 per month (config: a count and a period - lifetime, month, day or unlimited) | 150 per month |
| Requests that call the AI, per UTC day (9.5) | none | 40 | 400 |
| Fast-path learns | unlimited | unlimited | unlimited |
| Edit rules | view only | yes | yes |

- **One AI learn, however many rounds.** The server repair rounds, the escalation and every round of the learning loop (9.3) belong to the learn that started them: all of it counts as ONE AI learn, and only if it succeeds: the result verifies against the example, or the user saves it with accepted differences. A loop that ends without verifying counts nothing and is one failed attempt on the example pair. After `limits.learn.maxFailedAiAttempts` (3) failed attempts on the same example pair (same owner, same structure) within `failedAttemptsWindowHours` (24), the app stops calling the AI for that pair, counts it as one learn, and tells the user plainly what was tried and what to change. A learn whose calls all errored (the provider failed) is never counted against the user. How it is kept (`protection/aiLearns.ts`, atomic counters): one unit is reserved before the LLM is called (concurrent learns cannot pass the quota; a refused learn costs nothing); it stays when the server's checks pass - DECISION: counted at once, so a browser that never reports gets nothing for free - and is given back when the browser reports that the full verification failed (the outcome report, 9.5), which records a failed attempt on the pair instead. A quota's period is a UTC month or day; its count is the plan's, or the admin's per-user override (14.2): every quota answer and the 429 `limitHit aiLearns` body carry that `limit`, and the web says "Your account includes N" when it is not the plan's.
- **Sources per format, said up front** (decided 2026-10-07). The web app knows each format's input count (`GET /api/formats` `sources`) and the plan's number, and checks it the way the API does (shared `canAddSource`, the 403 `limitHit sourcesPerFormat` count), so it never offers an add that would fail: at Learn, "This output matches your format" says "**X** already takes N different input files (your plan's limit)." with the upgrade, and offers only a new format or other files (5 A step 2); with the explicit source UI on (8.12), a format's card, its page and the Add a source screen say "**X** already has N sources (your plan's limit)." before the user starts. "Update your format X?" adds no input and is offered whatever the count. Registered: 3; paid: no limit.
- **Upgrade button.** It opens the **paid-waitlist form** (decided 2026-10-05): an email (filled in for a signed-in user) and an optional message, stored in `leads` with `kind: 'waitlist'` and the `trigger` that opened it - the limit that was hit (a `LimitCode`), `batch` (the hint on the Run screen) or `other` (13). There is no payment code in the MVP; paid tiers are assigned by an admin (14.2).
- **Out of AI formats** (decided 2026-10-07). With none left, "Learn with AI" (Home) stays clickable and opens one dialog - "You've used your AI formats for this month" (or today / in total): what the plan includes, the date they come back (the next UTC month or day, where the server's counter starts again), that the free engine and saved formats keep working - with "Join the paid waitlist" (trigger `aiLearns`; not on a paid plan), "Learn without AI" and "Close"; the hint under the buttons and the line of the deep-analysis panel (the Result screen's and Add a source's) become an amber notice ("No AI formats left this month · back on 1 November" + the waitlist), the account menu says "0 · back on 1 November", and a 429 `limitHit aiLearns` at learn time opens the same dialog instead of an error screen.
- **Limit tracking.** Every stop answers with its `LimitCode` (429 `limitHit`), and the paid waitlist records the one that opened it; the `limit_hit { limit }` event is defined but not written yet (14.1). A learn whose result needs more rules than the tier allows is still shown in full, but saving it hits the limit. Saved formats hold under a race: a new format is counted again once inserted and taken back when over the plan's number (racing saves may all be refused; never one too many).
- **Deleting formats.** Deleting a saved format frees a slot but doesn't give back learns.
- **Description character limits** (for after the MVP): 300 / 1,000 / 4,000.
- **What one saved format may keep** (decided 2026-10-06, the same for every tier; `limits.rules`, 8.3): 500 entries in one value map, 300 characters in one value (500 in a title or a summary row's label), 64 KB for one version's rules, next to the other caps (20 tables of 500 rows, 200 nodes per output column, depth 8, formula text 4,000 characters, 100 "Do this every time?" fixes per column, 30 versions per format). The browser checks them first (the editor's live check); the server refuses a save over any of them with 400 `rulesTooLarge` (he/en text), on every route that stores rules.

## 12. Sign-in

**Providers:** Google and Microsoft, both in the MVP. Google comes first in the UI, because the first goal is demand from individual users. Microsoft is there for people signing in with a work account.

**Implementation:**
- One OpenID Connect implementation (openid-client), using the authorization-code flow with PKCE. Adding a provider later is config only.
- Scopes: openid, email, profile.
- Microsoft uses the `common` endpoint, which accepts both personal and work/school accounts.
- The session is kept in an httpOnly, Secure, SameSite=Lax cookie. It lasts `limits.auth.sessionDays` (30) after its last renewal, renewed at most hourly; the provider's answer is accepted within 10 minutes of "Continue with ..." (the state / nonce / PKCE cookie).

**Identity:**
- A user is identified by provider plus subject. For Microsoft that's the tenant id plus the object id (`tid` + `oid`). **Never merge accounts automatically by email:** Microsoft's email claim isn't guaranteed to be verified, and merging on it is a known account-takeover risk.
- A signed-in user can link the second provider from their settings.

**Anonymous visitors:**
- Each visitor gets a random `anonId` in a first-party cookie (365 days).
- On sign-in, the anonId is attached to the user (the 50 most recent are kept) and its past events get the `userId` (the sign-in records, which keep the anonId; the usage events of 14.1 carry no anonId, so there is nothing to attach). The learn in progress comes back from the browser's own kept copy (5 E); saving it is the user's click.

**Development sign-in:** `POST /api/dev/session` signs in a test user only when the web app and the API run on this machine, or with `DEV_SIGN_IN=true`; never in production (decided 2026-10-07).

**Admin:** access is controlled by an `ADMIN_EMAILS` allowlist, checked against verified Google emails or a configured Microsoft `oid` (`MICROSOFT_ADMIN_OIDS`: the `oid`, or `tid:oid`; the owner finds it in `users.identities[].subject` after one sign-in, `docs/deploy.md`). It is evaluated from the user's identities on every request (nothing about "admin" is stored), and the SERVER enforces it: every `/api/admin/*` route answers 401 `signInRequired` to a visitor and 403 `forbidden` to a signed-in user who is not an admin (14.2). The web app shows the "Admin" link (header and account menu) only when `GET /api/me` says `isAdmin`, which is a courtesy and never the check.

**Before approaching companies:** many company Microsoft tenants only let employees sign in to apps from verified publishers. Complete Microsoft publisher verification before the business outreach. Personal Microsoft accounts aren't affected.

## 13. Data (MongoDB)

- **`users`:** identities[`{ provider, subject, tenantId?, email, emailVerified }`], name, avatarUrl, uiLanguage, tier, createdAt, lastSeenAt, anonIds[], limitOverrides?
- **`formats`:** ownerId, name, schemaVersion, output, layout (sort and group normalized to output headers), outputValidations, origin (`learned` | `template`), versions[`{ format, editedBy, at }`], createdAt.
- **`sources`:** ownerId, name, inputSignature `{ columns: [{ header, aliases, type, required, padLeft?, inputFormats?, readAs? }] }`, inputReading `{ sheet, headerRow, stopAt }`, inputValidations, versions[`{ source, editedBy, at }`], createdAt; the name is unique per owner, case-insensitively. Structure only (8.15): headers, types and shapes, never values, ranges or samples.
  - `ignoredHeaders` (optional): file header names the "new column" notice must not mention - the example's columns no rule reads (remembered when the source is saved) and the ones the user dismissed. Names only, deduplicated by normalized header, capped (`limits.registry.maxIgnoredHeaders`: the oldest are dropped, so a dismissal just made holds). Not part of the versioned structure and never written to conversions: it is about files, not about how a format reads one. Appended through `POST /api/sources/:id/ignored-headers` (owner-scoped like the other source routes); `GET /api/signatures` carries it.
- **`conversions`:**
  - ownerId, sourceId (required; the source's own name is the only name), formatId, schemaVersion, rules (the full self-contained rules file);
  - inputSignature `{ columns: [{ header, aliases, type, required }] }` (the columns this conversion uses; the source holds the full signature);
  - source, status (`verified` | `differencesAccepted` | `userConfirmed` | `draft` | `needsReview`), acceptedDifferences (count);
  - exampleExceptions: example row numbers the user marked as fixed by hand. They are used only when checking the example, never on future runs;
  - learnPath (`local` | `llm` | `cache`), masking, model, promptVersion;
  - versions[`{ rules, editedBy, at }`], runCount, lastRunAt, createdAt.

  Rules contain only real constants (after unmasking) such as labels and value-map entries. They never contain data rows.
- **`events`:** ts, userId?, anonId?, type, props. `ts` is the SERVER's time (a client time is never read). Props hold counts, ids and codes only: a number in a small range, a boolean, a value from a closed list, a score rounded to two decimals, at most a format id - never a cell value, a file name, a column or header name or any free string. Each type's props are whitelisted by a strict schema (shared `events.ts`, `EVENT_PROPS`): anything not listed makes the event invalid and it is dropped. Two kinds of record (14.1): the sign-in records `signed_up` / `signed_in` (they keep `anonId`: it is how a visitor's history joins their account at sign-in, 12) and the beta usage events, which carry `userId` for a signed-in user and NO id at all for a visitor - no `anonId`, no IP, nothing that links two events to one browser (decided 2026-10-08, with the privacy stance of 20.18). Indexes: (`type`, `ts`), `userId`, `anonId`. TTL-expired `limits.retention.eventsMonths` (12) after `ts` (2026-10-07; the usage events share it, 2026-10-08).
- **`llm_calls`:** ts, userId?, anonId?, learnId, purpose (learn | repair | escalation | check: a call whose answer asked AI code checks, 9.1), model (the one that answered - on a fallback call the fallback's, e.g. `gpt-5-mini-2025-08-07`; a failed call's: the one tried last), provider (the same: `anthropic`, `openai`, ...; absent on a cache hit and on older documents), fallback? (`true` on a call the fallback provider made, 9.6), fallbackReason? (the primary's failure: `network` | `timeout` | `rateLimited` | `overloaded` | `serverError` | `auth`, or `circuitOpen` when the primary was not tried), promptVersion, masking, tokensIn, tokensOut, tokensCached, costUsd, estimate (our own token count priced with the published prices - inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, costUsd or null; numbers only), latencyMs, outcome (`verified`, a problem summary, `checks`, `truncated`, `error:<kind>`), cacheHit, problemCounts (per repair-problem kind - `truncated`, `overfit`, `overfitFallback`, `list` among them - counts only, never text), checks? (`{ asked, dropped }` on a `check` call). promptVersion is the version the call was sent. TTL-expired `limits.retention.aiCallRecordsMonths` (12) after `ts` (2026-10-07: the privacy page's "up to 12 months").
- **`usage_counters`:**
  - keys (`apps/api/src/protection/keys.ts`): `user:<id>:aiLearns:<yyyy-mm>` (or `:<yyyy-mm-dd>`, or no date for a `lifetime` quota), `user:<id>:aiRequests:<yyyy-mm-dd>`, `user:<id>:failedRefunds:<yyyy-mm-dd>`, `user:<id>:newFormats:<yyyy-mm>`, `aiFail:<owner>:<group>` (failed attempts on one example pair), `aiLearn:<learnId>` (where one learn stands: open, counted, failed or ended by the failure cap), `repair:<learnId>` (the learning loop's rounds of one learn, at most 3), `step:<learnId>` (its steps of AI code checks), `ip:<hash>:contact:<yyyy-mm-dd>` (HMAC of the IP; IPv6 by /64) and `fnreq:recorded|rejected:<yyyy-mm>`;
  - updates use atomic `$inc`; EVERY counter is written with `expiresAt` - the end of the day or month it counts plus `limits.protection.counterGraceHours` (48), or the end of its own window (a learn's, a failure window) - and expires through the TTL index (2026-10-07). A counter from before then gets one at the next start (`backfillCounterExpiry`).
- **`budgets`:** the overall spend per UTC day (`spendUsd`). (A document written before 2026-10-07 may also hold `anonSpendUsd`, the anonymous AI step's part, which nothing reads any more.)
- **`learn_cache`:** owner (`user:<id>`: only signed-in users reach the AI), key (hash of the structure only, with the prompt version sent), rules, promptVersion, createdAt; unique (owner, key), TTL `limits.cache.ttlDays` (30). A completion answer and an answer made after rounds of checks are never written. A cache entry is only ever returned to the same owner — never across users — and only learns made with masking on are cached, and of those only rules without text constants (their fake words belong to an earlier session key); with masking off nothing is cached (2026-10-05), and an older masking-off entry is never served (the read re-checks the rule). The AI's `explanation` and `functionRequest` are stripped before an entry is written.
- **`function_requests`** (learn-v7, 8.10): key (normalized name + signature, unique), name, purpose and args (as first seen), returns, topic (a catalogue topic guessed from the purpose words, or `unknown`), count, distinctOwners, ownerHashes (HMAC of the owner id under the server secret, truncated, capped by config: the raw id is never stored), firstSeen, lastSeen, status (`new`). Written by one atomic upsert after the value filter (15); holds nothing from any user's data. Indexes: key (unique), (status, distinctOwners, count), (topic, distinctOwners). Counts of requests kept and rejected go to `usage_counters` (`fnreq:recorded:<yyyy-mm>`, `fnreq:rejected:<yyyy-mm>`).
- **`admin_audit`** (M4, 14.2): ts, adminId, adminEmail? (the admin's own, as it was then), action (`user.tier` | `user.limitOverrides` | `functionRequest.status`), targetKind (`user` | `functionRequest`), targetId, before, after. One document per change an admin made, written BEFORE the change (and taken back if the change then fails); append-only: nothing edits or deletes a row. Ids and the changed values only (a tier, numbers, a status): no name or email of the target (the list reads them from the target when it is shown). Index: ts descending.
- **`users.limitOverrides`** (M4): the keys an admin may set are listed in `limits.admin.overrideKeys` - only `aiLearns` today (the count that replaces the tier's `aiLearns.count`, 11), whole numbers from 0 to `limits.admin.maxOverride`. A key is only added there together with the code that reads it.
- **`leads`** (M4; the public forms, written by `POST /api/leads` and `POST /api/waitlist`): two kinds in one collection, told apart by `kind`.
  - `{ createdAt, kind: 'lead', name, email, company?, message?, page, anonId? }`: the "For business" form (16.1 screen 7).
  - `{ createdAt, kind: 'waitlist', email, message?, trigger, page, userId?, anonId? }`: the paid waitlist (11 "Upgrade button").
  - `page` is the path the form was sent from (a pathname: a query or a fragment is cut off); `anonId` is the visitor's cookie, `userId` the signed-in user (waitlist). Never the IP, a file name, a rule or a value. Indexes: `createdAt` (TTL: `limits.retention.formsMonths`, 24, 2026-10-07), (`kind`, `createdAt`). The old `waitlist` collection is gone.
- **`feedback`** (M4; `POST /api/feedback`): `{ createdAt, kind: 'feedback', message, email?, page, userId? }`. The email only when the sender wants an answer; the page path, never file data or rules. (The earlier `formatId` / `rating` / `text` fields were never written.) TTL-expired `limits.retention.formsMonths` (24) after `createdAt`, like `leads`.
  - **Caps and checks** (`limits.contact`, the same code in the API and the web: `packages/shared/src/contact.ts`): name 120, email 254, company 160, lead message 4,000, waitlist message 1,000, feedback message 2,000, page path 200 characters; text trimmed, control characters dropped, an email checked for its shape and lower-cased, only the whitelisted fields kept (anything else in the body is ignored, never stored).
  - **Protection.** A visitor must pass Turnstile (`turnstileFailed` otherwise; a signed-in user is not asked); every caller is rate-limited per IP (5 requests a minute in memory, `rateLimited`) and by a durable cap of 20 stored forms per IP per UTC day, counted in `usage_counters` under a keyed hash of the IP (`ip:<hash>:contact:<day>`, TTL like the other daily counters), and by a global cap of `limits.contact.globalPerDay` (200) stored forms a UTC day from all addresses together (decided 2026-10-07), past which every form answers 429 `rateLimited` until the next day. The body is checked before Cloudflare is called.
- **Not stored: user data files** (non-negotiable 2).

## 14. Events and admin dashboard

### 14.1 Events
The event vocabulary (`events`, 13). The sign-in records and the **beta usage events** (decided 2026-10-08, built for the first testers) are written now; the rest of the vocabulary below is defined for when the app emits it, and nothing may read it as if it were recorded (14.2 shows "n/a" for a group with no row in the period).

**Privacy (non-negotiable, 15).** Counts, codes and ids only. Every usage event's props are whitelisted per type by a strict zod schema in `packages/shared/src/events.ts` (enums, booleans, small bounded integers, a rounded score; no free string, no file name, no column name or header, no cell value); the browser's emitter and the server both run it, so a prop nobody listed never leaves the browser and is never stored. **Whose they are (DECISION, the owner's privacy stance; 20.18 - no banner, only strictly necessary cookies):** an event of a signed-in user carries their `userId`; an event of a visitor who is not signed in is stored with NO id at all - no `anonId`, no IP, nothing linking two of them; they are counts. The time is the server's. (The sign-in records keep their `anonId`, as before.)

**Written by the sign-in routes since M4:** `signed_up {provider}`, `signed_in {provider}` - with the browser's `anonId` and the `userId`.

**Written by the API where the action happens** (the client is not trusted for these; `POST /api/events` refuses them):
- `format_saved {kind: new | anotherInput | update | edit}` - `new`: `POST /api/formats`; `anotherInput`: `POST /api/formats/:id/conversions`; `edit`: a rules save, `PATCH /api/conversions/:id`. DECISION: Save's "Update your format" (a new version from the Learn flow) and the rules editor's save are the same route with the same body, and nothing the server knows tells them apart, so both are `edit`; `update` is in the vocabulary for when the web app can say it, and is not written yet. A rename, a restore and a refused save write nothing.
- `format_run {daysSinceCreated, rows, flagged}` - `POST /api/conversions/:id/runs` (the web posts the counts after a conversion). `daysSinceCreated` = whole days since the FORMAT was created (never below 0): the key "returning use" metric (a run 7+ days later).
- `limit_hit {limit}` - written in ONE place, an `onSend` hook that sees every `limitHit` answer (a 403 or 429 whose body says `limitHit` with a limit on the shared list), whichever route sent it.
- `feedback_given {replyRequested}`, `lead_submitted {kind: contact | waitlist}`, `upgrade_intent {trigger}` - after a form is stored (`/api/feedback`; `/api/leads`; `/api/waitlist`, which writes both `lead_submitted` and `upgrade_intent` with the waitlist's trigger). DECISION: the feedback form has no rating (13), so `feedback_given` says only whether the sender asked for an answer (gave an email), never the message or the address.

**Sent by the browser** through `POST /api/events` (body `{ events: [{ type, props }] }`; per-IP rate limit `limits.events.perIpPerWindow` a minute, at most `limits.events.maxPerRequest` (20) events and `limits.events.maxBodyBytes` per request - the surplus is dropped, a longer body is a 413; an invalid event is dropped, not the batch; a cross-site `Origin` is refused (403); no Turnstile; always 204; the route never sets the anonymous-id cookie):
- `page_view {page}` - the route NAME (home, learn, formats, format, convert, business, privacy, terms, accessibility, admin, other), never the path or the query.
- `file_uploaded {role: input | output | run, fileType, rows?, cols?}` - the type is from the extension; rows and columns are the worker's counts (left out when no table was found, not 0). `file_rejected {reason}` - `type`, `size`, `unreadable`, `noTable` and the engine's table checks that reject a file at Learn (6.1).
- `learn_completed {path: local | llm | cache, status, masking, aiClicked}` - the browser's FINAL verdict of each learn run (the free engine's local learns are invisible to the server otherwise). `status`: `verified` (the browser's own full verification passed; a completion's answer must also hold the user's fixed rules and match), `failed`, `partial` (the free engine's partial result, before the AI step), `blocked` (pre-flight, 6.3), `notReady` (the AI readiness gate), `error`. `aiClicked`: this run is the AI step's, the user's click. Not reported: a "known" or "matches your format" stop (their answers are `known_format`), a "rows couldn't be aligned" pause, a cancelled run, or a run that only puts a result back after a sign-in.
- `known_format {kind: same | anotherInput, answer}` - the Learn-time questions "You already have this format" (answers `convert`, `learnAnyway`, `chooseOther`) and "This output matches your format" (`yes`, `no`, `chooseOther`), reported when answered.
- `signin_wall_shown {trigger}` - the wall opens (`save`, `download`, `keepGoing`, `ai`, `formats`, `expired`); the visitor's page of an account screen is the `formats` wall.
- `file_matched {result: auto | choose | none, score?}` - the Run screen's matching of one file; the clear winner's score, or the best option's, to two decimals (none: omitted).
- `formats_chosen {offered, chosen, all, batch}` - the Run screen's "which formats?" step and the batch's one question, when answered (Continue / Convert): nothing is pre-ticked (owner, 2026-10-08), so this is what people really choose.
- `download {kind: single | zip | summary | batchFile | learnResult}`, `batch_run {files, converted, needsAttention, noMatch, notChosen}` (in FILES, a file by its best outcome; reported when the batch's files are done).

**Still only defined:**
- **Visits and files:** `language_changed {lang}`
- **Pre-flight and learning:** `preflight {status, reason?, skipColumns}`, `masking_toggled {on}`, `dedupe_found {action}`, `expand_found {mode}`, `unsupported_found {codes}`, `assumptions_found {codes}`, `preview_shown`
- **Registry:** `format_created {origin}`, `source_added {formatId, sources}`, `format_edited {sources}`
- **Using formats:** `rule_editor_opened {section, method}`, `exception_marked`, `rules_edited {field}`, `flag_resolved {accepted}`

### 14.2 Dashboard (`/admin`)
**The target** (what the dashboard should show once the 14.1 events are written): headline numbers (registered users and their growth, active users, anonymous uses, LLM spend); returning use, the key metric (users who ran a saved format again 7+ days after creating it, runs per active user, sources per format); the funnel over 30 days (visited → uploaded → passed pre-flight → learned → saw the sign-in wall → signed up → downloaded → ran a saved format again); learning (learns by path, verified rate per model and masking mode, calls per learn, unsupported and assumption codes); editor use; cost per day, per learn and per tier, and today's remaining budget; breakdowns (pre-flight blocks, rejected files, limits hit, upgrade intents, sign-ups by provider, UI language, masking); the latest sign-ups, leads and feedback; setting a user's tier and overrides; 7, 30 or 90 days.

**What is built (M4, decided 2026-10-05).** The page at `/admin` has four tabs - Overview, Function requests, Users, Leads and feedback - and is served by `/api/admin/*`. Only what the product already records is shown, and a number the server cannot know is "n/a", never 0 (the headline numbers, the editor use and the breakdowns of events nothing writes yet are not computable: they are not built; the Usage section below is computed from the beta usage events of 14.1).
- **Access (server-enforced, every route):** per-IP rate limit (`limits.admin.requestsPerIpPerMinute`, 429), then a sign-in (401 `signInRequired`), then `isAdmin` from the session (403 `forbidden`), then the database (503 `unavailable`); a change (PATCH) whose `Origin` names another site is refused (403). Responses are `no-store`. Nothing exposes a file's contents (the server has none), a masked payload, a secret, an `llm_calls` row's text or a hashed owner: the overview is counts and sums, `llm_calls` rows are only ever aggregated.
- **Overview** (`GET /api/admin/overview?days=7|30|90`, UTC days, today included): users by tier, new sign-ups (`createdAt`), seen in the period (`lastSeenAt`); learns - AI learns = distinct `learnId` with a real call, split into passed the server's checks (a call ended `verified`), answered but not passed, and provider errors only (never counted against the user, 11), and cache hits (`cacheHit`, no model); learns solved in the browser: the count of `learn_completed` events with path `local` and status `verified` (2026-10-08), "n/a" when the period has no `learn_completed` at all; saved formats, conversions that ran in the period (`lastRunAt`) and runs all time (`runCount`: not dated); AI calls and the ESTIMATED cost (`llm_calls.estimate.costUsd`, our own count at published prices, 9.5) per UTC day and per model - a day or model with no priced call is n/a, a model with no price is never guessed - as one inline SVG bar row (no chart library; the same numbers in a table), and the calls the fallback provider made (`llm_calls.fallback`, 9.6); the most frequent problem kinds (`problemCounts`); function requests (groups, times, at the threshold, issue opened, new); events by type; and **Usage** ("How the product is used", decided 2026-10-08), computed ONLY from the usage events of the period, each group "n/a" when its event type has no row in the period (never 0 for "not recorded"): learns by path × status (`learn_completed`); matching auto / choose / none (`file_matched`); the formats step - times answered, the share where every format was ticked, the average offered and chosen, single vs batch (`formats_chosen`); limits hit, by limit (`limit_hit`); saves by kind (`format_saved`); **returning use** - distinct signed-in users with a `format_run` whose `daysSinceCreated` ≥ `limits.admin.returningAfterDays` (7), the runs, the distinct signed-in users who ran anything, and runs per active user; and a signed-in funnel of distinct `userId`s per step - dropped a file (`file_uploaded`) → finished a learn (`learn_completed`) → saved a format (`format_saved`) → ran a saved format (`format_run`) → ran one 7+ days after creating it. A visitor's events carry no id, so they are in the event counts and never in a count of people; a funnel step with rows but no signed-in user is 0, one with no rows is n/a.
- **Function requests** (`GET /api/admin/function-requests`, `PATCH .../:id`): one row per name + signature (the collection's `key`) with times, distinct owners, first and last seen, topic and status. A new group with `distinctOwners >=` `limits.learn.functionRequests.issueThreshold` (5) carries `issueUrl`: GitHub's new-issue form (`limits.admin.githubNewIssueUrl`) with the title and body filled in from the request's name, purpose, signature, topic and counts - nothing else; no token, no GitHub call (the admin submits it; issue #41 builds approved functions through a gated PR). "Mark as opened" sets `status: issueOpened` (so it is not offered twice) and can be taken back; `approved` / `declined` belong to that pipeline and are never touched here (409).
- **Users** (`GET /api/admin/users?q=&page=`, `PATCH /api/admin/users/:id`): search by a part of an email or a name (escaped: text, never a pattern), newest first, 25 per page; per user the tier, joined date, AI learns used this period against the effective limit (the override, else the tier's), and the formats count. A change sets `tier` (`registered` or `paid`: anonymous has no user) and/or replaces `limitOverrides` (13); every change is written to `admin_audit` first, and a request that changes nothing writes nothing. No user can be deleted. The audit log (`GET /api/admin/audit`) is shown under the list.
- **Leads and feedback** (`GET /api/admin/contacts`): read-only, newest first, through a whitelist of fields (`createdAt` or `ts`, kind, email, name, company, role, message or `text`, page, rating, language); anything else a form stores is never passed on.

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
- **Formula injection.** When writing csv or txt, a cell that starts with `=`, `+`, `-` or `@` gets an apostrophe in front, in every column, a numeric one too (its header, title and summary-label cells are text); text that is a plain number (`-?digits(.digits)?`, "-123") is exempt everywhere - it cannot be a formula - and a real number is never guarded; anything else ("-5 units", "+972-50-...", "-1e5", "=SUM(A1:A9)") is guarded (decided 2026-10-06, 2026-10-07). When writing xlsx, write values, not formulas.
- **LLM data retention.** The business page states the LLM provider's data-retention terms accurately (check the provider's current policy).
- **Logs** never contain cell values, file names or payloads. A finding about an identifier-shaped value is said by column and kind, never the value, in the UI and in every log (8.11 "Saving").
- **Retention is config, and the database keeps it** (decided 2026-10-07): `limits.retention` - AI call records 12 months, form messages 24, sign-in and usage records (`events`) 12, a month counted as 30 days so a record goes a little before the page's limit, never after; usage counters until the end of their day or month plus `counterGraceHours` (48), or their own window. The privacy page's numbers (`legalParams`) and the API's TTL indexes (`ensureIndexes`) read the same config; an index an older deploy made without an expiry gets it in place (`collMod`).
- **No third party the privacy page does not name** (decided 2026-10-07): the font is self-hosted (4), and the Content-Security-Policy allows only the app's own origin, Cloudflare Turnstile and the Google avatar.
- **AI code checks (learn-v9; off by default, 9.1).** The browser answers on every row, masked like the sample and within the learn's 40 rows (7.3); the server passes the rounds to the provider and keeps nothing but counts (purpose `check`). A formula in a check is read by the same strict parser and run by the same whitelisted interpreter as the rules: nothing the AI writes is ever executed as code.
- **The AI's notes on an unsupported column (learn-v7, 8.10).** The `explanation` may mention values: it is NEVER stored, cached, logged or saved (stripped from the cache, the ledger and every saved rules file, by the browser and the API, never sent back in `complete.fixed`); the browser keeps it in memory only, unmasked, for the session. The `functionRequest` is STORED only after the value filter (8.10); who asked is kept only as a keyed hash of the owner id.
- **Legal pages.** Privacy policy and terms, in Hebrew and English, go live before launch, along with a cookie notice. Check what Israeli privacy law requires.
  - **Built in M4 as DRAFTS** (`/privacy`, `/terms`, `/accessibility`; `apps/web/src/i18n/legal.ts`, filled from config): they say what the product really does (7, 13, 15), they are NOT legal advice, and **the owner or a lawyer must review and complete them before launch** - every name, address, court, hosting provider and the accessibility coordinator is a visible `[placeholder]` in `webConfig.legal` until filled, and each page has its own "last updated" date (`webConfig.legal.updated`).
  - **The promise** (privacy page, summary, and "What we store"; decided 2026-10-06): "Your full files never leave your computer. Saved formats keep the column names and the rules you approved, including the fixed values those rules use - such as labels, codes and lookup lists, and values you typed into your example output. Before saving, we ask you about lists copied from your example and about ID numbers, phone numbers, emails and card or bank numbers we recognize in them. Please don't use other personal details, such as a person's name, as a label in a rule you save. Never rows from your files." It also covers: the masked sample AI learning sends (the numbers are the config's: up to 12 pairs and 5 dropped rows, at most 40 rows in one learn), what masking replaces and what it sends as it is (names, other text and identifier numbers - ID, phone, customer, account, policy and order numbers, card and bank account numbers, by the value's shape or the column's name - are replaced, in every script; other numbers, dates, column and sheet names are sent), that the exact rows can be seen before learning with a choice per column of whether it is hidden (7.2), what answering an AI code check sends, that AI is opt-in and needs a sign-in, what is stored (account, formats, usage counts, sign-in records, usage records - counts and codes only, linked to the account when signed in and to nothing otherwise - AI call records with counts only, the form messages), the cookies (session, anonymous id, language; accessibility choices in localStorage), Turnstile, the processors (Anthropic and OpenAI, Google and Microsoft, Cloudflare, hosting), retention, rights and contact.
  - **The cookie notice**: DECISION (for the owner or the lawyer to confirm) - only strictly necessary cookies are used, so this build shows no banner and the privacy page's "Cookies and local storage" section is the notice.
  - **LLM retention** (the business page and the privacy page): checked against Anthropic's and OpenAI's own pages on 2026-10-05 - API inputs and outputs are deleted within 30 days (Anthropic) / abuse-monitoring logs are kept up to 30 days (OpenAI), and neither trains on API data by default. Re-check before launch: they change.

## 16. Screens, languages and design

### 16.1 Screens
1. **Home is the tool.**
   - Two drop zones: Example input and Example output.
   - The masking switch, with its one-line explanation and a "What's the difference?" link.
   - The line "Your full files never leave your computer" and a "See what we send" link, which opens the dialog of the exact rows and the per-column choice (7.2). A small **Clear** link next to the chosen files (5 A step 8).
   - Two buttons, both disabled until both files are added: the primary **Learn the format** (the free engine) and, secondary, **Learn with AI** (the free engine, then the AI step on what it leaves unsolved), with one line under them saying what it uses ("Uses 1 AI format (N left this month), and only if it succeeds"). A visitor sees both; Learn with AI asks them to sign in (5 A step 3; decided 2026-10-04). With no AI formats left, the line becomes the amber out-of-AI notice and Learn with AI opens its dialog (11).
   - Nothing sits above the tool; a short "how it works" (learn once → use every month) sits below it.
2. **Pre-flight result.** Shown only when there's a warning or a block: what was found and what the user can do. **You already have this format** and **This output matches your format** (5 A step 2) are shown the same way, in place of the learn: the title, one line naming the format (a radio list when several match), and the answers - **Convert files with it** / **Learn again anyway** / **Choose other files**, and **Yes, learn it for X** / **No, make a new format** / **Choose other files**.
3. **Learning progress.** Reading files → Checking the files → Learning the format → Checking against your example. Show real progress, and skip steps that don't happen (e.g. on the fast path). The AI rounds say what they do, here and in the Finish with AI panel: "Checking every row of your example: sending N rows the rules got wrong (round 2 of 3)", "The AI is checking an idea on your rows (round n of 3)" (learn-v9), "Looking for the rule behind a list of fixed values (round n of 3)". "See what we send" lists every request, round and step with the rows it carried (and, before anything is sent, says rounds may follow).
4. **Result.**
   - The rules map and its editor (8.11).
   - The preview grid, with differences from the example highlighted.
   - The flagged rows.
   - On a column the example fits more than one rule for, one quiet question next to it (8.11): "always '00', or the first 2 digits of Employee number?"; the day/month order of a date the example does not settle; after an AI learn, a part of a rule that explains one row only ("A one-time change, or a rule we missed?"). The answer is the rule; no AI call.
   - After an AI learn, one quiet line says what code filled from the example (8.11 "What code filled").
   - When the AI step could not finish (the learning loop stopped without every row matching): a short panel naming the rows that still differ, per column, with **Fix the rule** and **Leave it empty for now** (8.11).
   - A status badge: Verified, "N columns need your input", or "N differences accepted".
   - When fields are missing, the deep-analysis panel with **one** AI button, **Finish with AI** (the free engine's missing fields, each ticked: the AI step completes the ticked ones, or runs the whole learn when too little is solved to complete - after asking, when that would replace the user's edits). A visitor sees the sign-in prompt instead. There is no second "re-run" button; **Start over** drops the edits and the files (decided 2026-10-04). A completion keeps running when the user leaves the Result screen: its answer is merged into the session's rules when they come back, and is reported as `verified` or `failed` only once its use is decided (decided 2026-10-07).
   - Primary button: "Save format" ("Save with N differences"; it only saves, and may ask the Save popup's questions - whether to update one of the user's formats this input already feeds, or save a new format (5 A step 8; a learn for a chosen format is saved into it with no question), then the lists and identifier values (8.11 "Saving") - in one dialog); next to it "Download the file" (a visitor is asked to sign in). **Try it on another file** is here too. (The "this looks like your format" banner and its "Add to a format" button are gone: another input for a format is asked at Learn, 5 A step 2.)
5. **My formats.** Each format with its sources underneath ("Priority catalog load ← 4 sources"; hidden while "Formats with several sources" is off, 8.12). Actions: Run this format (the Run screen, flows C and D), Add a source (flow A2: the free engine first, "Finish with AI" on the user's click for what it leaves; at the plan's sources per format, the limit and the upgrade instead, 11; hidden while the switch is off), Edit rules, Rename, Delete. For a signed-in user who has formats, Home's first action becomes "Run a format", with "Teach a new format" next to it.
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
   - **Built in M4:** after "how it's different", a short note on the AI step (opt-in; what it sends; the providers' retention terms, 15), the **plans** (11: a table of the tiers - rows, columns, files per run, saved formats, sources, AI formats, download - with every number read from the tier config, and one block per plan on a phone) with a "Join the paid waitlist" button (11), and the **lead form**.
   - **The lead form** (`/business#contact`): name and email (required), company and message (optional); Turnstile for a visitor, a rate limit for everyone; `POST /api/leads` stores `{ createdAt, kind: 'lead', name, email, company?, message?, page, anonId? }` in `leads` (13); a thank-you takes the form's place and the focus. Hebrew and English.
8. **Privacy, Terms, Accessibility statement** (`/privacy`, `/terms`, `/accessibility`; 15 "Legal pages", 16.4) and **Admin** (14.2).
9. **Feedback**. "Feedback" in the footer, and in the signed-in account menu, opens a short dialog: a message, an optional email and the current page path (never file data or rules). Stored in `feedback` (13); Turnstile for a visitor, a rate limit for everyone.
10. **The footer**: Business, Privacy, Terms, Accessibility, Feedback. **The accessibility button** (16.4) floats on every page.

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
The approved design plan (palette, type, layout) is `docs/design-plan.md` (M2).
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
  - One typeface family that covers Hebrew and Latin well, IBM Plex Sans Hebrew (self-hosted, 4), with tabular numbers in grids.
  - It must look equally good in RTL and LTR.
  - Avoid the generic SaaS card grid and gradient decoration.
- **Tone.** Errors say exactly what's wrong and what to do, in the interface's voice, e.g. "Row 1 has cells merged across columns B–D. Unmerge them and upload again."
- **Devices.** The work happens on desktop. The home page and the business page must also look good on a phone.

### 16.4 Accessibility (M4; decided 2026-10-05)
Israeli websites must meet **IS 5568**, which is based on **WCAG 2.1 level AA**, and publish an accessibility statement (the Equal Rights for Persons with Disabilities Regulations (Service Accessibility Adjustments), 2013).
- **The statement** (`/accessibility`, "הצהרת נגישות", Hebrew and English, linked from the footer and the panel): the standard aimed at, what was done, the known limitations (the spreadsheet previews, the many-control rules editor, no screen-reader pass yet, files that are the user's own, the third-party sign-in and anti-bot pages), the date, and the **accessibility coordinator's** name, email and phone - placeholders in `webConfig.legal.accessibility` for the owner to fill. It says only what was done and tested (own review, keyboard, the automated checks below); **no external audit has been made**.
- **The accessibility button and panel** (every page, last in the reading order; at the inline-end bottom corner - left in Hebrew, right in English; the footer keeps 64px under its last line so the button never covers content; `z-index` 30, below the editor sheet and every dialog). A dialog that takes the focus, keeps it (Tab and Shift+Tab wrap) and closes with Escape, a click outside or its button, giving the focus back to the button. Settings: **text size** (three: normal, 125%, 150%), **high contrast**, **underline links**, a **readable font** (Arial-first), **stop animations** (on top of `prefers-reduced-motion`, which is always honoured), a **strong focus highlight** (4px ring with a gap in the page colour), **line and letter spacing** (WCAG 1.4.12), **reset**, and the link to the statement.
- **How it works.** Each setting is a class on `<html>` (`a11y-text-1`, `a11y-text-2`, `a11y-contrast`, `a11y-links`, `a11y-font`, `a11y-motion`, `a11y-focus`, `a11y-spacing`), so dialogs and menus in a portal are covered, in both themes and both languages; `styles/a11y.css` is the one place that says what each means. Text size is one CSS variable, `--text-scale`: every font size is `N px x --text-scale` (a test refuses a plain-pixel font size). The choices are kept per browser in `localStorage` (key `formatai.a11y`), every read and write in try/catch (a missing, blocked or throwing storage changes nothing but persistence), and applied before the first paint.
- **The pages themselves** (a manual pass, 2026-10-05; no axe-style tool): one `<title>` per screen and language (WCAG 2.4.2), the focus moves to the new `<main>` on a change of page, fields and switches have 3:1 outlines (`--control-line`) and an invalid field the icon amber, every font size follows the text-size setting, every preview table has a name. The brand colours pass (brand on paper 5.8:1, ink-2 6.2:1, white on brand 6.1:1).
- **The editor's static checks** say their problems in the UI's language (only the checker's own quoted words stay English, marked `lang="en"`), keep the last answer while an edit is checked, and announce changes through one polite live region (decided 2026-10-07).
- **Automated checks** (`apps/web/test`): `a11yStyles.test.ts` computes the contrast of every colour role in the light, dark and high-contrast themes (4.5:1 text, 3:1 outlines, 7:1 in high contrast); `a11yAudit.test.tsx` runs a structural audit over the real screens (one `<main id="main">`, a name for every control, button, link and dialog, unique ids, references that exist, headings that do not skip a level, a title and `lang` / `dir`); `accessibility.test.tsx` covers the panel (each toggle's class, persistence, reset, the focus trap, Escape, throwing storage), the titles and the statement.

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
- **CSV encodings:** UTF-8 with or without BOM, and Windows-1255. Detect the encoding when reading; write the encoding of the example output (`output.file.encoding`, DECISION 8), UTF-8 with a BOM when none is set.
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
- **Privacy regressions:** every path that sends cells follows the column classes and the user's choices (samples, checks' answers, the loop's rows and problems, a completion's fixed rules); the send preview equals the learn's first payload; the stress test checks every payload field that can hold cell text (10).
- **Accessibility:** contrast, structure and panel tests (16.4).
- **Hygiene:** `pnpm test` is hermetic (it never reads `.env`). API database tests run on their own `formatai_test_*` databases: a vitest global setup drops `formatai_test` / `formatai_test_*` on a local MongoDB before and after the run, every teardown drops its database first, a route test that leaves a usage counter without an expiry fails, and `testTimeout` is 15 s; `pnpm --filter @formatai/api db:drop-test` clears them by hand (local MongoDB only).

## 19. Milestones

M0 to M4 are built (2026-10-07); the product is in its beta with real testers. The lists below say what each milestone holds.

- **M0: Engine without AI.** (Built.)
  - monorepo setup;
  - rules schema (zod + JSON Schema);
  - table detection and the engine pipeline with decimal math, including duplicates and the three expand modes;
  - xlsx/csv read and write, including RTL;
  - 5 hand-written rules files with golden tests.
- **M1: Learning.** (Built.)
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
- **M2: Web tool.** (Built.)
  - design plan first;
  - Hebrew/English + RTL/LTR shell;
  - upload → pre-flight → learn → rules map, preview and diff → full verification;
  - the rules editor (8.11), with the live match counter;
  - the masking switch with its explanation, and "See what we send";
  - anonymous limits, budgets and cache.
- **M3: Accounts.** (Built, with the AI step for signed-in users only, the AI-learn quota and the row review.)
  - Google and Microsoft sign-in, and the sign-in wall;
  - the registry: formats with their sources, add a source (flow A2), convert a file with automatic matching (flow C), format edits that propagate (8.12);
  - tier config and usage counters;
  - batch conversion.
- **M4: Launch pieces.** (Built.)
  - the admin view (14.2; the beta usage events of 14.1 are emitted since 2026-10-08, the rest of the vocabulary is not);
  - business page with leads;
  - upgrade/waitlist and feedback;
  - privacy and terms pages, and accessibility (the panel and the statement, 16.4);
  - deploy.
- **After the MVP:**
  - adding a source without an example output;
  - the headers-only LLM suggestion for renamed columns;
  - ready-made formats (templates) for common systems;
  - comparison with the previous run of the same conversion;
  - a customer-hosted LLM endpoint;
  - description modes;
  - a merge-style view for flags;
  - payments and on-demand AI (20.14);
  - the AI column classification through the existing hook (20.15);
  - Microsoft publisher verification before the business outreach.

## 20. Open decisions (defaults in bold)

The decisions still open, each with the default the code uses now. They keep their numbers, because code comments cite them ("SPEC 20.4", "DECISION 9", "DECISION 10"). The resolved ones - 20.1 the stack, 20.2 storing user files, 20.3 batch for registered users, 20.7 hosting - and the old "Settled in this version" list are in [docs/spec-history.md](docs/spec-history.md) (2026-10-07, "SPEC split"); 20.13 (Add a source: AI only on the user's click) was decided and built on 2026-10-07 (5 A2; the history's entry of that day).

- **20.4 Tier numbers and other placeholder limits.** Default: **the placeholders in config** (`tiers.ts`, `limits.ts`: rows, files, formats, AI learns, daily AI requests, budgets, rate limits, form caps), to be tuned from real use once usage events are recorded. `limit_hit` is recorded since 2026-10-08 (14.1; the admin Overview's Usage section shows it): with the waitlist's triggers and the ledger, that is the data.
- **20.5 Server repair rounds.** Default: **1** (`limits.llm.serverRepairRounds`); 0 makes exactly one LLM call per learn.
- **20.6 Domain.** The product is **formatAI**. It runs on Render's default `onrender.com` address; no custom domain is chosen yet.
- **20.8 Encoding of text outputs (DECISION 8).** Default: **reproduce the example's encoding.** Which encoding each ERP load screen really needs must be confirmed with real load files from design partners before any templates are built.
- **20.9 Paid format limit (DECISION 9).** Default: **50 new formats per calendar month** (`newSavedFormatsPerMonth`), as stated in the business model. The alternative is 50 saved in total. Sources per format are counted separately (11).
- **20.10 Auto-match threshold (DECISION 10).** Default: **score ≥ 0.9 with a 0.1 margin** (`limits.matching`), to be tuned from real matches: the `file_matched` event (14.1; auto / choose / none and the score) has been recorded since 2026-10-08.
- **20.11 Hideable dates and yes/no values** (issue #71, parked 2026-10-07). Today the masker always sends dates and booleans as they are, so their switch in "See what we send" is disabled, and a birth date cannot be hidden. A change needs a date masker that keeps what rules need (format, order, ranges, month and weekday names) - for example one secret shift per column and session - unmasked in rule constants, and a decision on what the AI can still learn from a hidden date column. Default: **not hideable**.
- **20.12 Short-value look-alikes** (issue #72, parked 2026-10-07). A hidden value of 1-2 digits often gets itself as its look-alike (few fakes of that length keep the shape), so hiding a column of small numbers can look as if it did nothing. Options: say so in the dialog, widen the fake for short values (at the cost of the shape rule), or accept it. Default: **as is**.
- **20.14 Payments and on-demand AI after the MVP.** Default: **no payment code**: paid tiers are assigned by an admin (14.2), and "Upgrade" opens the paid waitlist (11).
- **20.15 The AI column classifier.** The hook exists (`columnHints`, 7.2): a small call that would classify the columns from their NAMES only, before the learn, its answer passed as hints, the value shapes always winning. Nothing passes it yet; decide after the beta. When it ships, the privacy page needs a line about loosening a column to a category. Default: **code's classification only**.
- **20.16 AI code checks (learn-v9).** Built and switched off (`LEARN_CHECKS=off`, 9.1). Re-evaluate by **2026-11-15**, after the beta with real testers' files, with the eval (`--prompt learn-v9`, and `--no-pattern-hints` to see whether the checks can replace the `bands`, `dependsOn` and `contains` hints). Default: **off**.
- **20.17 "Keep these rows as they are"** after the learning loop (`docs/proposals/learning-loop.md` 6.3): bringing back exceptions for named rows. Default: **not offered** (8.11).
- **20.18 Before launch** (the owner, or a lawyer for the legal texts): every `[placeholder]` of the legal pages (operator, court, hosting, the accessibility coordinator); the cookie notice (default: **no banner** - only strictly necessary cookies are used, and the privacy page's "Cookies and local storage" section is the notice); whether the accessibility button belongs at the start of the tab order (default: **last**); the LLM providers' retention terms re-checked; `TRUST_PROXY` set to the measured hop count and Turnstile turned back on (`docs/deploy.md`); Microsoft publisher verification before the business outreach.
- **20.19 Models and their settings.** Which model fills each slot (9.4), OpenAI's reasoning effort (default **`low`**; whether `medium` or the gpt-5 escalation pays for itself) and whether thinking earns its place (default **off where the model allows it**, 9.1) are the eval's to decide (10 "Initial decision rule").
