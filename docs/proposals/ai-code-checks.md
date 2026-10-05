# Proposal: the AI checks its ideas with code before it answers

Status: **proposal, for the owner's review** (2026-10-05). Nothing built. It is the after-MVP item "the AI asks code for rows" of
`learning-loop.md` (7.4), made concrete. Decisions to take are in section 9, my recommendation in bold.

**In one paragraph.** Today the AI gets one fixed picture of the example - about 12 masked rows plus the hints code chose for it -
and must answer from that. If the answer is wrong, code shows it the rows it got wrong (the learning loop). That works when the
answer is *almost* right, but the AI can never test a hunch: it cannot ask "does this column follow the total?" before it commits.
And code has to guess in advance which facts to hint, and a wrong hint misleads. Instead, let the AI **ask code a few closed,
typed questions** about the full example first ("test this rule on every row", "sort by this column: where does the output change?",
"does the same key always give the same value?"). The browser computes the answers on every row and sends back counts, cut-off
points and a few masked rows - never more than the privacy limits allow. The AI answers when it is sure. Everything after that
(the server's checks, verification on every row, the learning loop) stays as it is: the safety net.

## 1. Why (measured on 2026-10-05)

The owner's file: output column "סיווג עסקה" = קטנה / בינונית / גדולה by "סך הכל" (below 1000, below 5000, else), where "סך הכל"
is itself an output column (qty x price). Completion mode, masking on:

| Model | Hint for the column | Result |
|---|---|---|
| gpt-5-mini (effort `minimal`) | none | 3 calls, wrote the bands as value-map keys (`"<200"`), nothing usable |
| gpt-5-mini + gpt-5 (effort `low`) | none | 4 calls, $0.072: "needs outside data", then a guess on the quantity, then "ambiguous" |
| gpt-5-mini (effort `low`) | bands on the total (PR #53) | 1 call, verified on all 100 rows, $0.006 |
| Claude Haiku (CLI) | with or without the hint | 1 call, verified |

And the hints themselves: before PR #53's chance check, a label column of **random** values got a bands hint on up to 29% of
small examples (8-30 rows). The chance check brought that to 0-3%, at the price of sometimes not hinting a real rule on a small
example.

What this says:
1. **Facts beat guessing.** With the one fact "the class follows ranges of the total", the weaker model was right at once.
2. **Code cannot know in advance which facts the AI needs.** Every hint kind is a detector someone wrote for a pattern someone
   foresaw (bands, dependencies, compositions, windows ...), and each one can be wrong on small data. The owner's question -
   "if the code knew the rule, why the AI?" - is exactly this.
3. **The learning loop can't help when nothing is produced.** When the AI gave the column up, there were no wrong rows to send:
   the loop ended with nothing to say. It only corrects answers; it cannot help form one.
4. **Fixing row by row invites memorizing.** Each loop round rewrites the whole answer (about 2,000 output tokens) to fix the rows
   shown - the pressure that made learn-v8 copy rows.

## 2. The principle

| Who | Sees | Does |
|---|---|---|
| The AI | the masked sample, the column names, the answers to its own questions | forms ideas, **asks code to test them**, writes the rules |
| Code, in the browser | **every row** of the example, real values | answers each question on every row, masked; keeps the limits |
| The server | the masked sample and the questions and answers | passes them to the AI provider, keeps the caps, keeps nothing |

The browser answers because only it has the files (they are never uploaded). This is how a person would do it with 1,000 rows:
guess from a few, test the guess with a script on all of them, look closely only at what doesn't fit.

## 3. The flow

1. The browser sends the learn payload, as today (`POST /api/learn`).
2. The AI answers with **either** the rules (as today) **or** up to 4 checks.
3. Checks: the server returns them to the browser with the signed learn token. The browser computes the answers on every row
   (the engine, in the worker), masks them, and sends them back (`POST /api/learn/step`, the payload + every round of checks
   and answers so far). The server calls the AI again with all of it.
4. At most 3 rounds of checks. After the third, the AI must answer with the rules.
5. From the rules on, nothing changes: the server's checks and its repair, the escalation (it gets the checks and answers too), the
   browser's verification on every row, the learning loop, code filling cut-offs and lookups, the overfit guards.

An AI that needs no check answers at once: no extra call, as today.

## 4. The checks (a closed list)

Every check names columns the way the rules do (input column ids, output headers) and may take a `where` condition in formula text
(the same language as the rules, e.g. `status = "Open"`), so a two-column rule can be tested one slice at a time.

| Check | Asks | Code answers |
|---|---|---|
| `test` | "Does this rule give this output column?" `{ column, rule, let? }` - `rule` is formula text, `let` optional helper columns (`total = qty * price`) | how many rows match, of how many; up to 3 failing rows (input and output, masked) |
| `ranges` | "Sort by this number or date column: where does the output change?" `{ column, by, where? }` - `by` an input id, an output header or a `let` | the runs in order: from-to of `by` (real numbers or dates), the output value (masked), rows per run; or "no clean ranges" (more than 12 runs) |
| `dependsOn` | "Does the same value of these columns always give the same output?" `{ column, on (1-2), where? }` | distinct keys, rows that agree, conflicts; up to 2 conflicting pairs (masked) |
| `values` | "What values does this column have?" `{ column, where? }` | distinct count, empty count, the 10 most common values (masked) with counts; for numbers: min, max |
| `rows` | "Show me rows where ..." `{ where, limit <= 5 }` | the matching rows (input and output, masked), first by file order |

Example, the owner's file: the AI asks `ranges { column: "סיווג עסקה", by: "סך הכל" }` and gets three clean runs - up to
878.05 one value, 1019.36 to 4986.48 another, from 5157.24 a third, with 31 / 55 / 14 rows. It writes the `if`; code settles
the exact cut-offs as it does today. For eval `orders-priority` (Priority by status AND amount, which gpt-5-mini fails today): `dependsOn
{ column: "Priority", on: ["status"] }` shows one status that does not settle it, and `ranges { column: "Priority", by: "amount",
where: 'status = "..."' }` shows the cut-off inside it.

All five are thin wrappers over engine code that exists: the formula parser and the verification run (`test`), the bands search
(`ranges`), the category fit (`dependsOn`), the column profile (`values`), the masker (every value that leaves).

**Never answered:** a check not on the list, a column that does not exist, a rule that does not parse (the answer is the parser's
message, as a repair problem is today), anything that would pass the row limit (section 5). An answer is computed with a time budget
in the worker; a check that runs out says so.

## 5. Privacy

What leaves the computer, beyond today:
- **Counts and ranges computed on every row** (how many rows match, where a column's output changes, how many distinct values).
  Today's hints are already this kind of fact ("what your computer has already worked out" on the privacy page); checks only
  make the AI choose which ones.
- **A few more masked rows** (failing rows, conflicts, `rows`), masked exactly like the sample, with the same key. **They count
  toward the 40-row limit of one learn** (`limits.learn.loop.maxRowsTotal`, the sample and the loop's rows included). When the limit
  is reached, checks answer with counts only.
- Numbers, dates, column names and "no value" placeholders are sent as they are, as in the sample. Text values are masked. With
  masking off, the sample rules apply: real values.

What does not change: the files never leave the computer; the server keeps nothing (no sample, no question, no answer); the
ledger (`llm_calls`) keeps counts only, with a new purpose `check`. The privacy page gets one line (en/he): "If the AI asks to
check an idea, your computer answers with counts and ranges from your example, and at most a few more rows, masked, within the
same limit."

## 6. How it talks to the AI (provider-neutral)

**Recommended: JSON steps through the one LLM interface we have** (SPEC 9.6, `complete()`: one system prompt, one user message of
content blocks, one structured answer). Each step is a normal call:
- One answer schema for every step: `{ checks: Check[] | null, rules: Rules | null }`, exactly one of them filled. One schema keeps
  the prompt cache working across steps (OpenAI caches system prompt, schema and input in that order; a schema that changed
  between steps would make every step pay the full input again).
- The content blocks: the payload, then one block per round ("your checks / the answers"). The prefix repeats, so it is cached.
- Works on every provider we have: Anthropic, OpenAI (its strict schema rewrite already handles it) and **the Claude CLI**, so
  development and the eval with Claude cost nothing.

The alternative, native tool calling (Anthropic `tool_use`, OpenAI function calls): parallel calls and a provider-native loop, but
two provider-specific multi-turn protocols and no CLI. Not worth it for a closed list of five checks.

**The server stays stateless.** The browser resends the payload and the rounds so far with each step, like the learning loop sends
its rows. The server enforces the caps by the signed learn token: a step counter, as it counts browser repairs today. A tampered
round only changes the user's own learn; the payload byte cap (48 KB) applies to every request.

## 7. Cost and time (estimates, to measure)

- A check step's output is short: a few checks, or "I'm ready". Its input is the cached payload plus the new answers. Estimate:
  **$0.002-0.005 per step** at today's prices (gpt-5-mini, Haiku), so up to 3 rounds add **about $0.01-0.015** to a learn that
  costs $0.006-0.07 today. It can save money where today the loop runs 3 full rewrites, or an escalation to gpt-5 ($0.05) that
  still fails.
- Time: each round adds one browser -> server -> AI round trip, about 5-15 s on the API models (about 45 s on the CLI). The screen
  says what is happening: "The AI is checking an idea on your rows (round 1 of 3)".
- Quota: a learn with checks is still one learn, counted on success, as today.

## 8. Hints, the prompt, the eval, the rollout

**Hints.** Keep the facts that hold on every row (a copy, a template, `mul`, a window at coverage 1): free, certain, and they save
checks. The pattern-guessing hints (bands, dependencies, compositions) are what checks can replace. The eval runs both ways - hints
as today, and checks without the pattern hints - and if checks alone do as well, those hints are dropped (and with them the wrong-hint
risk).

**The prompt.** A new version, `learn-v9` = learn-v7 + one short section "Checking with code": the five checks, the limits, "check
when the sample does not settle it; answer at once when it does; never use checks to collect rows to copy". learn-v7 stays the
default until the eval passes (the lesson of learn-v8: measure before switching).

**The eval.** The harness computes the answers directly (Node has the full example; the same engine functions), so a run needs no
browser. Cases: the 26 cases, the class-by-total synthetic pair, and the owner's file (no longer blind: it was used to debug PR
#53). Models: Haiku via the CLI (free), gpt-5-mini (about $0.5-1 per full run). Measured per case: verified, calls and check rounds,
tokens and cost (our own estimate x published prices, as today), time, overfit flags, "unsupported" answers. **Pass:** verified
at least as often as learn-v7 on both models, no new overfit, the owner's file and orders-priority verified on gpt-5-mini, cost per
learn at most +30%.

**Rollout.** Behind a flag (`limits.learn.checks.enabled`): (1) the eval only; (2) the app, for the admin account only; (3) every
AI learn.

**What it touches** (after approval): shared - the check types and schema, the step answer schema, learn-v9; engine - `learn/checks.ts`
(compute one check on the full example, masked, within the row limit); api - `POST /api/learn/step`, `learn()` accepts a checks answer,
the step counter, the `check` purpose; web - the flow handles a checks answer (answer, resend, progress line); eval - the runner answers
checks; LEARN_PROMPT.md and SPEC (9.x, 7.3, 15); privacy page (en/he); tests for each check, the caps, the row limit, masking, and
the protocol.

**Not in it:** checks during the learning loop's rounds (the loop stays as it is; later, if the eval shows it would help);
checks that change anything (all five only read); free-form code from the AI (only the closed list - no script the AI writes
ever runs).

## 9. Decisions for the owner

1. **Protocol:** **JSON steps through the one LLM interface (works with the CLI)** / native tool calling per provider.
2. **Limits:** **3 rounds of checks, 4 checks per round; rows shown by checks count toward the 40-row limit** / other numbers.
3. **The checks:** **the five above** / fewer to start (`test` and `ranges` only) / more.
4. **Hints:** **keep the facts that hold on every row; measure the pattern hints against checks and drop them if checks do as well**
   / keep all hints / drop the pattern hints now.
5. **Server state:** **stateless, the browser resends each step** / the server keeps the rounds for a few minutes.
6. **Prompt:** **learn-v9 = learn-v7 + one section, default only after the eval passes** / change learn-v7 itself.
7. **Who gets it:** **everyone with AI, after the eval, admin first** / paid tier only.
8. **Eval budget:** **Claude via the CLI as much as needed; gpt-5-mini up to about $5 in total** / other.
