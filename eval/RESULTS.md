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
