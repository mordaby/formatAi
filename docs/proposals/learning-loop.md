# Proposal: the learning loop (the AI writes the logic, code checks it on every row)

Status: **draft, partly decided** (2026-10-04). Nothing here is built yet. Owner decisions: (1) loop caps 3 rounds, 8 rows per round, 40 rows in total; (2) cut-off ranges become a visible check the user approves, shown and editable in the rules editor. Spec sections it would change: SPEC 7.3 (samples), 9.2-9.4 (checks, repair, escalation), 8.11 (notes), 11 (quota), 21.

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
- **"Re-run all with AI" that fails says so**, and keeps the previous rules (today the screen silently shows the previous result).

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

### 3.7 One AI button

With the loop, "Re-run all with AI" has no job left. What the free engine built is verified on every row, so the AI never needs to redo it; and when the free result can't be completed (too few columns solved, rows that change shape, a summary output), the button already runs the whole learn by itself. So one button, "Finish with AI": code picks completion or the whole learn, the user can still untick fields, "Start over" drops the user's edits, and what the loop can't finish goes to the user (3.5) instead of to a second, harder AI run.

### 3.6 Guards

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
2. **The loop** (3.2), with its small fixes.
3. **The better first sample** (3.1).
4. **Code-filled lookup tables** (3.3).
5. **Cut-off ranges**, the note and the run-time flag (3.3, 3.4).
6. **"Show the rows, ask the user"** (3.5).

## 6. Open questions for the owner

1. ~~Loop caps~~ - decided: 3 rounds, 8 rows per round, 40 rows in total.
2. ~~Cut-off ranges~~ - decided: a visible check the user approves, shown and editable in the rules editor.
3. "Keep these rows as they are" (3.5): bring exceptions back in this narrow form?
4. A per-learn token cap: what is the most one learn may cost (decided after the baseline)?
5. One AI button instead of two ("Run deep analysis with AI" and "Re-run all with AI"): proposed in the reply of 2026-10-04, see 3.7.
