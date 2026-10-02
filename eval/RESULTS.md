# Eval results log

Full per-run reports are written to `eval/reports/` (gitignored). This file keeps the headline numbers.

## 2026-09-29 — first model comparison (M1), prompt learn-v5

- **Provider:** `claude-cli` (dev, the owner's Claude subscription), model **Haiku 4.5**, no escalation, 1 run per masking mode.
- **Cases:** 17 (easy 2, medium 7, hard 5, rows 2, blocked/unsupported 2, registry 3 incl. 2 in attach mode), 12 domains, each verified case with a "next month" hold-out pair.

| | masking off | masking on |
|---|---|---|
| Blocked (pivot) | 6% | 6% |
| Fast path (no LLM) | 41% | 41% |
| Expectation met — first run | 88% | 82% |
| Expectation met — after the two fixes below + re-run of the 3 failing cases | 100% | 100% |
| Hold-out ("next month") correct | 93% → 100% | 100% |
| LLM learns verified on 1st call / after repair (first run) | 67% / 78% | 67% / 78% |
| Formula errors per LLM call | 0 | 0.06 (fixed by repair) |

Fixes made because of this run:
1. Pair analysis explained an externally-filled column with a memorized value map (19 keys over 20 rows) → value maps now need repeated keys; the column is reported as external data before learning.
2. The masking-trap case expected `hiddenByMasking`, but pair analysis finds an id *prefix* on the real data (SPEC 7.2), so the fast path verifies it in both modes → expectation corrected.

Variance: `insurer-commission-control` and `stock-count-warehouse-report` each missed once in the first run and verified (after one repair) in the re-run — hard cases need the repair round; measure with `--runs 3` before choosing the first-try model.

**Usage via the dev CLI is not representative of API cost.** Averages per LLM learn: 1.78 calls, ~48k cached input tokens, ~18k output tokens, ~162 s. Our own prompt + schema + payload is ~12k tokens; the rest is Claude Code's own session overhead and (likely) thinking tokens. Measure real per-learn cost with `--provider anthropic` (API key) before setting budgets.

Next: run Sonnet 5 on the same set (escalation slot), `--runs 3`, and an API-key run for true cost.

## 2026-10-01 — learn-v6: full learn vs "complete what's missing"

- **Provider:** `claude-cli` (dev, subscription), **Haiku 4.5**, masking on, 1 run, no escalation, `--mode both`. 17 cases (8 need the AI step).

| | full | complete |
|---|---|---|
| Expectation met | 94% | 94% |
| AI learns verified 1st call / after repair | 75% / 88% | 75% / 88% |
| Hold-out correct | 100% | 93% |
| Avg AI calls per learn | 1.75 | 1.62 |
| Avg output tokens per learn (CLI, incl. thinking) | 17.5k | 15.3k |

- Completion shines when most columns are already fixed: `budget-columns-to-rows` 1.5k vs 16.3k output tokens, `registry-supplier-a` 1.2k vs 20k, both verified on the 1st call.
- It is the wrong tool when nothing is fixed: `purchase-orders-supplier-summary` (summary output, 0 of 5 columns solved) failed after 3 calls in completion mode and verified in full mode.
- Misses differ by mode (full missed `stock-count-warehouse-report`, completion verified it) — partly run-to-run variance at 1 run per case.
- learn-v6 did not regress full learns (94%, in line with learn-v5).
- **Change made:** "Finish with the AI step" uses completion only when ≥ 50% of the fillable output columns already have a rule (`limits.learn.completionMinFixedShare`), otherwise the full learn.

## 2026-10-02 — learn-v7 (new date/text ops, window functions, function requests, AI's guess)

- **Provider:** `claude-cli`, **Haiku 4.5**, masking on, 1 run, no escalation, `--mode both`. Report `eval/reports/2026-10-02T15-51-21-499Z/`.

| | v6 complete | v7 complete | v6 full | v7 full |
|---|---|---|---|---|
| Expectation met | 94% | **94%** | 94% | **82%** |
| Verified 1st / after repair | 75% / 88% | 67% / 89% | 75% / 88% | 67% / 78% |
| Hold-out correct | 93% | 93% | 100% | 86% |
| Avg output tokens per learn | 15.3k | 14.6k | 17.5k | 18.8k |

- Completion mode (the app's default when ≥ 50% of columns are solved) held steady.
- Full-mode misses: `registry-supplier-c` (the AI marked a derivable column `externalData` and the new "honest unsupported" rule accepted it without repair), `purchase-orders-supplier-summary` (summary output; fails in both modes, verified in v6 full — suspected interference from the new window functions), `stock-count-warehouse-report` (also missed in v6 full: variance).
- Follow-up: repair when the AI gives up despite code's evidence; check window guidance vs summary outputs; re-run the 3 cases.
