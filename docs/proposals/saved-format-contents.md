# Proposal: what a saved format may keep

Status: **approved, built** (2026-10-06; SPEC 21 v15). It writes down the model agreed in chat on 2026-10-06; the owner took every
recommendation of section 9 (the bold options). It generalizes the copied-list question built in #55 and builds on the identifier
masking of #56.

**In one paragraph.** A format is saved on our server, so whatever its rules contain is stored there. A good rule contains almost
nothing from the user's files: it names columns, and holds a few cut-offs, rates and labels. Data reaches the database only when a rule
stores values instead of logic: a list "this key -> that value", or a label that is itself personal data. So every output column is one
of three kinds - a raw value placed somewhere (code), logic on the input (the AI), or a list of fixed values (nobody can deduce it). The
first two save silently. A list is accepted only after the AI has tried to find logic and shown with code checks that none fits, and it
is saved only if the user says so, in one popup at Save. The same popup catches identifier-shaped values (ID, phone, email, card, IBAN)
anywhere in the rules. Size limits, checked on the server, keep any one format small.

## 1. Why

- **A memorized list (2026-10-05, the owner's file).** gpt-5 "learned" a class column as an or-list of ~37 ID numbers per class. It
  verified on all 100 rows; the real rule was bands on the total. After unmasking, the rules held the real IDs, and saving would have
  stored them. Fixed for that shape by the `caseList` atoms guard (#55).
- **A copied list (eval `external-agent-column`).** A lookup "account -> manager", one entry per row, filled by code from all rows.
  Handled by the copied-list question at Save (#55) - but only when the key is unique per row.
- **What is still open:** a list whose keys repeat (customer -> manager, product -> category) saves silently, even when a much simpler
  logic rule exists; and a logic rule whose LABEL is personal data ("amount > 1000 -> target customer 123456789") saves silently too.
- **Limits:** tables are capped (20 x 500 rows), but a value map's entries, the length of a label and the total size of a format's rules
  are not.

## 2. Three kinds of output column

| Kind | Example | How code knows | Who writes it | Saved |
|---|---|---|---|---|
| **1. A raw value placed** | copy the ID; `cos-{id}`; `{id}-{name}` | the output cell holds the input value (the pair analysis: copy, template, composition, on every row) | code | silently: the rule names columns, never their values |
| **2. Logic on the input** | `total < 1000 -> קטנה`; `qty * price`; a late flag | a rule on input columns explains every row | the AI | silently: only cut-offs, rates and labels |
| **3. A list of fixed values** | product -> category; customer -> manager | each value is decided by WHICH key it is, and no logic fits | nobody can deduce it | only if the user says so (section 6) |

**Labels are part of logic.** קטנה / בינונית / גדולה appear first in the output, but logic chooses them; they are the names of the
outcomes, the user's own words, and a rule cannot work without them. They are never asked about (section 5 is the exception: a label
that is an identifier).

**What decides is the test, not whether constants are stored:** logic on the row, or the identity of a key.

## 3. What makes a list (kind 3)

A kept rule's output column is a **list** when its value comes from a lookup, a value map or a chain of cases whose entries are fixed
values keyed on an input column - whatever the shape the AI wrote (one entry per key, or grouped by label: `product in (card, computer,
screen) -> Electronics`). Code finds this in the rules and counts the entries the example uses.

**Not a list: a small vocabulary.** A translation of a category column with few values (`Open -> פתוח`, 4 region codes -> names) is
vocabulary, saved silently: at most 12 entries, each used by at least 2 rows of the example. Anything bigger, keyed on an identifier
column (#56's classification), or with an entry used by a single row, is a list.

**Not a list: one-time edits.** A rule part that explains one row singled out by something unique stays the existing one-time question.

## 4. Logic first: one automatic retry

A list is a last resort. When the kept answer has a list column (and the learn has not retried it yet), the browser sends ONE automatic
repair round for that column, with no click:

> Column "{column}" is a list of {n} fixed values, one per {key}. Find the rule behind it from the other columns. Only if no rule exists -
> the value depends on each {key} itself, or comes from outside the file - keep the list.

- With learn-v9 the AI can prove it: `ranges` / `test` of a logic rule (a band on the total fits -> logic), `dependsOn` on the key (every
  key always gives the same value, and no logic fits -> a list). Code then checks the answer on every row, as always.
- Logic found: the list is gone, nothing to ask. The owner's file is this case.
- The AI keeps the list: it is used for this conversion and the download, and asked about at Save.
- Cost: one extra call, only for an answer that has a list column. It replaces nothing else: the overfit guards keep their own repair.

## 5. Identifier-shaped values anywhere in the rules

A value the format would save - a label, a table key or value, a condition's constant, a "Do this every time?" fix - is checked against
shapes code recognizes with certainty:

- an Israeli ID number (9 digits, valid check digit);
- a phone number (Israeli 05x / 0x / +972 forms, and an international `+` form);
- an email address;
- a card number (13-19 digits, Luhn);
- an IBAN (country code + mod-97 check).

A match goes to the same popup (section 6), whatever kind the rule is. This catches "amount > 1000 -> target customer 123456789".

**Changed from the chat:** NOT "any run of 7 or more digits". Accounting formats map to ledger account numbers, item codes and barcodes as
labels all the time (`expense -> 61000100`); a digit-run rule would put a popup on the bookkeepers' most common format. Only shapes with a
check digit or a fixed format count. (A 9-digit code passes the ID check digit 1 time in 10: then the popup asks once, and Keep keeps it.)

**Not detectable: a person's name used as a label** ("Dana Cohen"). It looks like any other word. The privacy wording (section 8) says so
plainly; this is the one remaining gap, and it needs the user to type a person's name into the output as a rule's outcome.

## 6. The Save popup

One popup, on Save only, only when the rules being saved hold a list (section 3, after the retry) or an identifier-shaped value
(section 5); every other save is unchanged, with zero extra clicks (owner, 2026-10-06: fewer clicks; nothing is stored before Save).

> **Save this format?**
> **Category** is a list of 200 fixed values taken from your example (one for each product code).
> **Target customer** keeps an ID number in its rules.
> Keep these in the saved format? **[Keep them] [Save without them] [Cancel]**

- **Keep:** saved as is. A list's new keys are flagged on the Run screen as today ("no category for 'tablet'"); "Do this every time?"
  adds them.
- **Save without:** each listed column is taken out ("needs your input", the existing take-out), its values dropped.
- **Cancel:** nothing is saved.
- Asked once per list or value: one the server already holds is not asked again (as in #55).

## 7. Limits (checked in the browser AND on the server)

| What | Today | Proposed |
|---|---|---|
| Tables / rows per table | 20 / 500 | keep |
| Expression nodes / depth / formula text | 200 / 8 / 4,000 chars | keep |
| "Do this every time?" fixes per column | 100 | keep |
| Entries in one value map | no cap | **500** |
| One label, table cell or condition constant | no cap | **200 characters** |
| One version of a format's rules (JSON) | the request cap only (256 KB) | **64 KB** |
| Versions per format / formats per user | 30 / per plan | keep |

The server refuses a save over any cap with a plain error (the browser checks first, so a user never sees it in normal use). Labels are
already escaped on screen and guarded against formula injection in the output files.

## 8. Privacy wording (en; he in the same style)

Replace the saved-formats line of the privacy page with:

> Saved formats keep the column names and the rules you approved, including the fixed values those rules use - such as labels, codes and
> lookup lists, and values you typed into your example output. Before saving, we ask you about lists copied from your example and about
> ID numbers, phone numbers, emails and card or bank numbers we recognize in them. Please don't use other personal details, such as a
> person's name, as a label in a rule you save. Never rows from your files.

## 9. What it touches, and decisions

**Touches:** engine (list detection in the kept rules, generalizing `copiedLists`; the identifier-shape checks; the retry round in
`learn/flow.ts`); shared (the detectors, the new limits, the take-out); api (the server-side limits on every save route); web (the popup's
lines for both reasons, the privacy text en/he); eval (cases: a 200-entry catalog -> asked; a small vocabulary -> silent; class by total
written as a list -> the retry finds the bands; a label that is an ID -> asked; ledger-account labels -> silent); SPEC and LEARN_PROMPT
(the retry message only; no prompt text change).

**Decisions (my recommendation in bold):**
1. Small vocabulary: **at most 12 entries, each used by at least 2 rows** / other numbers.
2. Identifier shapes: **the five with a check digit or a fixed format, no digit-run rule** / add digit runs.
3. The retry: **one round, only for an answer with a list column** / none (ask at Save straight away).
4. Limits: **500 value-map entries, 200 characters per value, 64 KB per version, enforced on the server** / other numbers.
5. Privacy wording: **as in section 8** / changes.
