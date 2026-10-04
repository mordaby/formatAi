# Proposal: the learning loop (the AI writes the logic, code checks it on every row)

Status: **partly built; MVP scope decided** (2026-10-04). Built: step 1 (the token/cost measurement and the baseline), step 2 (the loop, 3.2, with its small fixes - SPEC 21 "v12 changes"), the one AI button (3.6 - SPEC 21 v11 item 12), the constant guard (a constant the input could write is not built locally - v12 item 10). Owner decisions: (1) loop caps 3 rounds, 8 rows per round, 40 rows in total; (2) cut-off ranges become a visible check the user approves, shown and editable in the rules editor; (5) one AI button plus "Learn with AI" from the start; (6) the MVP takes the three mechanisms of section 7 (A, B, C); the AI asking code for rows (7.4) waits for after the MVP.

**In one paragraph.** Today the AI sees at most 12 masked rows, writes the rules, and gets one repair if the browser's check on the full example finds wrong rows. 12 rows can't show a rare case, an exact cut-off or a lookup with 50 values, so the AI guesses, and one repair is often not enough. Instead: (1) the browser keeps sending the rows the AI got wrong, round after round, while the number of wrong rows keeps going down; (2) code does the data part of a rule on ALL rows (it fills lookup tables and finds the range a cut-off can be in), so the AI only has to get the logic right; (3) what the example cannot settle is said, and flagged on next month's rows, never guessed silently. When the loop can't finish, the user sees the rows that still don't fit and decides.

## 1. What goes wrong today (measured on 2026-10-04)

Synthetic pair, 240 orders, `local-samples/synthetic/`: `Priority` = "Blocked" if On hold, "Urgent" if Open and Amount >= 5000, "Normal" if Open, else "Done"; 5 "Urgent" rows.

- **Complete the missing column (the AI fills 1 of 5 columns): learned.** The sample held one Urgent row (6,323) and Normal rows up to 4,435, so any cut-off between them fit the 12 rows; the AI chose one above 5,944. The full check found 3 wrong rows (5,299 / 5,745 / 5,944), the one browser repair chose 5,000: verified 240/240. 4 calls.
- **Re-run all with AI (the AI writes all 5 columns): failed.** Haiku called Priority unsupported despite the evidence, its repair was wrong, the escalation (Sonnet) also gave up, the browser repair was wrong: 4 calls, nothing learned.
- **The owner's own file (2026-10-04):** the first answer passed the sample but not the full file; the one browser repair changed a column it was told to keep (`fixedMismatch`), so it was thrown away.

The 12 rows are not the real problem. The problem is that the AI must get everything right from the rows it happened to see, with one retry.

## 2. The principle

| Who | Sees | Does |
|---|---|---|
| The AI | a few masked rows, chosen well, and later the rows it got wrong | writes the **logic**: which columns, which conditions, which functions |
| Code, in the browser | **every row** of the example, real values | runs the logic on all rows; fills in the **data parts** (lookup tables, cut-off ranges); picks the rows to send next; decides when to stop |

The browser drives the loop because only it has the full files. The server keeps the caps (it already signs each learn and counts its repairs).

## 3. The design

### 3.1 A better first sample (no extra calls)

Today: exception rows of hints, the first 3 rows, rows with an empty cell, rows with the min/max of each numeric output column, then file order, up to 12 (SPEC 7.3).

Add, for each output column the AI is asked about (completion mode) or that no detector explained (whole learn), before the filler:
- one row for each distinct value of that column, rarest first (so "Urgent" is always there);
- the edges: for each value of that column, the rows with the smallest and largest value of each numeric input column ("the smallest Urgent amount, the largest Normal amount").

The cap stays 12 for the first call; the edges go first, the filler last. With 50 distinct values not all fit: that is what 3.3 and the loop are for.

### 3.2 The loop (counterexamples)

1. The AI answers; the server checks it (layers 1-7, as today).
2. The browser runs it on every row of the example (as today).
3. All rows match: done.
4. Otherwise the browser groups the wrong rows by (column, expected value, value we produced) and sends **up to 8 rows**, one or two from each group, biggest groups first, masked like every sample, with the previous rules.
5. The server checks the new answer against the first sample **plus every row sent so far**, so a later round cannot break a row an earlier round fixed.
6. Repeat from 2.

**Stop when:** every row matches; or a round does not lower the number of wrong rows (no progress); or 3 loop rounds were used; or 40 masked rows were sent in total; or the request would pass the payload cap (48 KB). The best answer so far is kept (fewest wrong rows, as `bestOf` does today).

**Small fixes that come with it:**
- **Fixed columns are put back by code.** In completion mode the AI may only add what it was asked for. If it changes a column it was told to keep, code restores that column from the fixed rules and checks again, instead of throwing the answer away. The checks still decide.
- **Every round gets the server's one repair round** for its own check problems (a formula error, a type error), like the first call does today.
- **"Re-run all with AI" that fails says so**, and keeps the previous rules (today the screen silently shows the previous result). *(Gone with the button itself: SPEC 21 v11 item 11, see 3.6.)*

### 3.3 Code fills the data parts, from all rows

- **Lookup tables.** When the AI writes `lookup(table, key)` (SPEC 8.14), it only needs to show the pattern with the entries it saw. Code fills the table from every row, when each key always gives the same value. A key that gives two different values is not filled: those rows go back into the loop, or to the user (3.5). Keys the example never had are flagged next month (`onMissing: flag`, already the default).
- **Cut-offs.** When a rule compares a numeric input column with a constant (`amount >= 5000`), code tests the cut-off at every gap between neighbouring values of that column in the example, and keeps the range where every row matches ("above 4,800 and at most 5,299"). It keeps the AI's value when it is inside the range, otherwise the roundest number inside it. Comparisons of one column with one constant only; anything more complex is left to the loop. Capped work (at most a few hundred candidate cut-offs).

### 3.4 Say what the example cannot settle

- A cut-off chosen from a range gets the note "Your example shows the cut-off is above 4,800 and at most 5,299; we used 5,000. Please confirm" (one note, not today's doubled "Please check it").
- Next month, an amount inside that range is flagged on its row: "Your example did not settle whether this is Urgent or Normal." **Privacy point for the owner:** the two edges are amounts from the user's rows. They would be stored only as a visible check the user approves (like any constant a rule uses), and the user can delete it. If that's not acceptable, we keep only the note and drop the flag.
- A lookup value the example never had is flagged (as today).

### 3.5 When the loop can't finish: show the rows, ask the user

The rows that still don't fit are shown in the browser (real values, nothing sent), grouped: "3 rows don't follow the rule we found for Priority: rows 38, 89, 132." For each group the user chooses:
- **Fix the rule** (the rules editor, the column highlighted);
- **Keep them as they are**: these rows were edited by hand in the example, and the rule is right for the rest. This brings back exceptions, but only here, for named rows, after the loop gave up;
- **Leave the column empty for now** (today's "best we can do").

Next month (later, not in this step): a flagged row the user corrects in the row review can become one more example row for the loop: "teach from this row".

### 3.6 One AI button

With the loop, "Re-run all with AI" has no job left. What the free engine built is verified on every row, so the AI never needs to redo it; and when the free result can't be completed (too few columns solved, rows that change shape, a summary output), the button already runs the whole learn by itself. So one button, "Finish with AI": code picks completion or the whole learn, the user can still untick fields, "Start over" drops the user's edits, and what the loop can't finish goes to the user (3.5) instead of to a second, harder AI run.

### 3.7 Guards

- **Overfitting.** More rounds tempt the AI to write row-specific rules (`if order = "ORD-1037"`). An answer that uses an ID-like value of a counterexample row as a constant is rejected as overfitting; those rows go to the user (3.5). The existing lint keeps running. The next-month hold-out in the eval measures it.
- **Privacy.** Only masked rows, one masking key per learn session (the same fake value in every round), at most 40 rows in total, and "See what we send" lists every round.
- **Quota.** All rounds of one learn count as **one** AI learn, and only if it succeeds (as today). A failed learn costs nothing and counts towards the 3-failure stop. A per-learn token cap on the server ends the loop if a learn gets expensive.
- **Server restarts.** Today the quota unit is reserved before the call; a restart in the middle loses it (seen in testing). An open reservation older than the request timeout is released.

## 4. Token usage: what we measure

The per-round estimate is: the system prompt (about 10k tokens, cached after the first call, so billed at the cache-read rate), plus the new part (previous rules and up to 8 rows, about 2-4k tokens), plus the answer (about 1-2k tokens). A learn that verifies on the first call costs exactly what it costs today. These are estimates; the measurement decides.

**How we measure.** The eval harness already records every call (`llm_calls`: tokens in, cached, out, latency, outcome). We add per learn: rounds, rows sent, cost in USD, and the result (verified on the example; passes next month's file).

- **Data:** the 17 eval cases, the catalogue's AI chunk, and new synthetic hard cases: a rare category, a cut-off, a lookup with 50 values, two-column conditions, an example with 3 rows edited by hand.
- **Before and after**, the same model. No API key needed (owner decision): the dev CLI's own token numbers include Claude Code's overhead and thinking tokens (about 15k output tokens per call), so we count our own instead - the system prompt, the payload and the previous rules we send (input; the system prompt counted at the cache-read rate after the first call), and the answer we get back (output) - and price them with the providers' published per-token prices (Anthropic and OpenAI, read from their pricing pages when the measurement is built, never from memory). The numbers are estimates; their purpose is the comparison before and after each step.
- **Report:** a table per step in `eval/RESULTS.md`: success rate, calls per learn, tokens per learn (in / cached / out), cost per learn, time per learn, overfitting cases.

## 5. Order of work (each step measured before the next)

1. **Baseline** on today's code, with the token counting of section 4.
2. **The loop** (3.2), with its small fixes. *Built (SPEC 21 v12).*
3. **The better first sample** (3.1).
4. **Code-filled lookup tables** (3.3).
5. **Cut-off ranges**, the note and the run-time flag (3.3, 3.4).
6. **"Show the rows, ask the user"** (3.5).

## 6. Open questions for the owner

1. ~~Loop caps~~ - decided: 3 rounds, 8 rows per round, 40 rows in total.
2. ~~Cut-off ranges~~ - decided: a visible check the user approves, shown and editable in the rules editor.
3. "Keep these rows as they are" (3.5): bring exceptions back in this narrow form?
4. A per-learn token cap: what is the most one learn may cost (decided after the baseline)?
5. ~~One AI button instead of two~~ - decided and built: "Finish with AI" (SPEC 21 v11 item 11; see 3.6).

## 7. After the measurements: three kinds of break, one mechanism each (owner decisions, 2026-10-04)

**Measured.** The loop on the 20 eval cases (Haiku, one run per case, `eval/reports/baseline-2026-10-04` vs `loop-2026-10-04`): verified on the example unchanged within noise (completion 8/12 -> 8/12, whole learn 8/12 -> 7/12); est. cost per AI learn $0.019 -> $0.020 (worst learn 8 calls, $0.042); no overfitting. Round 1 (the old single browser repair) rescued 2 wrong first answers; rounds 2-3 ran only where no round can help (50 lookup names, hand-edited rows). Six stress cases (`eval/cases/buildStress.ts`, `reports/stress-ai-2026-10-04`): 4 learned in both modes with next month right (running balance, cancel + dedupe, Hebrew messy layout - free engine, region report with subtotals); `dates-mixed-formats` failed (masking hid date text: 7.5); `broken-values` learned the cleanup in one mode, next month's new broken kinds not as expected.

Every break found falls into one of three kinds:

| Kind | Found | The mechanism (MVP) |
|---|---|---|
| **A. Ambiguous:** several rules fit every example row | "00" = constant or the ID's first 2 digits; "03/2026" = constant or the month of Date; a cut-off anywhere in a range | Code knows the competing explanations: the result screen asks ONE question ("always '00', or the first 2 digits of Employee number?"). Unanswered: the data rule is kept and a run-time check flags a row where the explanations differ. Sending such a column to the AI is pointless (it sees the same rows): the AI is not asked. |
| **B. Hidden data:** more values than a sample shows | 50 branch names; the exact cut-off | The AI writes the logic, code fills the data from every row (7.1). |
| **C. Not a rule** | rows edited by hand, data from outside the file, a gap in the language | Show the rows that don't fit and let the user decide (3.5); the honest "best we can do"; a function request. |

### 7.1 B: the AI says what, code fills the data (MVP)

The AI decides the structure from the rows it sees; code fills every data parameter from all rows, exactly. Parameters code fills:
1. **Lookup tables and value maps** (code -> name): every pair from the example; a key with two values is not filled (those rows go to the loop or the user); unseen keys next month are flagged.
2. **Value lists in conditions** ("Active" if Status is A, B or C): the list completed from all rows.
3. **Cut-offs** (amount >= X): the range that fits every row; a round value inside it; a visible, deletable check "the example shows the cut-off is above 4,800 and at most 5,299", editable in the rules editor; next month a value inside the range is flagged.
4. **Band tables** (ranges -> labels): every boundary's range, as for a cut-off.
5. **Day/month order of text dates**: decided from all rows (any value with a part > 12 proves it); none proves it -> kind A (ask).
6. **Which duplicate is kept** (first/last) and **which values a filter drops**: decided from all rows.
Code fills only these well-defined shapes, never "any constant"; the check on every row still decides. Whether the AI needs one prompt sentence to write a lookup (rather than an if-chain or "external data") is decided by the eval, with and without it (learn-v8 only if it earns its place).

### 7.2 A: the ambiguity question (MVP)
Where the free engine finds that a value is a constant AND derivable from the input (v12 item 10), or more than one relation fits every row, the result screen asks once, naming both readings in the user's terms. The answer is the rule; no AI call. *Built (SPEC 21 v12 item 11): the readings come back as rule fragments; the data reading is built with a deletable check until the user answers. A date column that mixes formats has no reading code can write, so such a column still goes to the AI step (7.1 item 5 is where it belongs).*

### 7.3 C: show the rows, ask the user (MVP)
3.5 as written, without "keep these rows as they are" for now (open). *The Result-screen part is built (SPEC 21 v12 item 12).* Plus, on the Run screen's row review: after the user fixes a value by hand ("N/A" -> empty), "Do this every time?" turns it into a rule of the format (a new version, visible and undoable in the editor).

### 7.4 After the MVP: the AI asks code for rows
A small, whitelisted query the AI can send ("rows where Amount is between 5,000 and 5,500", "rows where Status is empty"), answered by code with up to a few masked rows, in the same learn. Useful where a fitted range or a lookup isn't enough; not needed where code can compute the answer itself (a cut-off's range) or where no such row exists (then the user is asked). Its own design (query language, caps, privacy, cost) comes after the MVP.

### 7.5 Fix found by the stress cases (MVP)
Masking hid text dates ("12 במרץ 2026", "2026-03-07" in a text column), so a learnable date column came back "hidden by masking". Dates are sent real (7.2): a text cell that reads as a date is sent as it is, and month and weekday names are never masked (vocabulary, not personal data).
