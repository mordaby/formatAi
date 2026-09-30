# formatAI — design plan (approved 2026-09-30)

Product name (working): **formatAI**. SPEC 16.3 applies; this file pins the approved choices.

## Direction
Calm, like a well-kept paper ledger. Simple (one main action per screen, the journey Upload → Learn → Use always visible), smooth (motion answers what the user does), appealing without decoration (no gradients, no generic SaaS card grid).

## Tokens
| Token | Value | Use |
|---|---|---|
| `--paper` | `#FBFAF7` | page background |
| `--surface` | `#FFFFFF` | drop zones, panels, grid |
| `--line` | `#ECE9E1` / strong `#B9B4A6` | hairlines / dashed drop-zone border |
| `--ink` | `#1F2328` | text |
| `--ink-2` | `#5F5E5A` | secondary text |
| `--brand` | `#0F6E6A` | primary actions, "verified", selected method |
| `--brand-tint` | `#E3F1EE` (text on it `#085041`) | verified badge, selected rule line |
| `--diff` | `#E08A00` (icons `#B86E00`) | differences and flags only |
| `--diff-tint` | `#FFF1D6` row / `#FFE3B0` cell (text on it `#633806`) | changed cells, flagged rows |
| danger | reserved for real errors only (file can't be read) | |

Provide a dark theme from the same roles (dark paper, light ink, teal/amber kept as roles).

## Type
- **IBM Plex Sans Hebrew** (Google Fonts) for everything, Hebrew and Latin; weights 400 and 500 only.
- `font-variant-numeric: tabular-nums` in grids, counts and amounts.
- Sizes: 13px UI small, 15px body, 18px section, 22–28px page title.

## Layout
- CSS logical properties only (`margin-inline-start`, `inset-inline-end`, …), never left/right. `<html dir>` follows the UI language; directional icons mirror.
- Sheet previews follow the sheet's direction, not the UI's; every cell value wrapped in `<bdi>`.
- Home = the tool: header (wordmark "formatAI", language toggle, sign in), step line (1 Upload — 2 Learn — 3 Use), two drop zones side by side (Example input / Example output) that show name + rows + columns once dropped, masking switch + one-line explanation + "What's the difference?", "Your full files never leave your computer · See what we send", one primary button "Learn the format". Short "how it works" below the tool.
- Result: title + status badge; rules map on the inline-start side (sections Rows, Columns, Layout, Checks; each line a sentence with a status icon: teal check = matches, amber = please check / needs your input, pencil = edited by you); editor panel on the inline-end side (full-width sheet on narrow screens) with "How is it made?" method chips, block-built calculations, and the live "Matches X of Y rows in your example"; preview grid below with differences in amber (mismatches first).
- Desktop-first for the work screens; Home and Business must look good on a phone.

## Motion (respect `prefers-reduced-motion`)
- Drop zone reacts while a file is dragged over it; a dropped file settles in with its row/column count.
- The rules map fills in line by line when learning finishes (one orchestrated moment).
- Differences glow briefly once when the preview appears.

## Copy
Plain and short: "format" not "schema", "check" not "validate". Errors say what's wrong and what to do ("Row 1 has cells merged across columns B–D. Unmerge them and upload again."). Sentence case. Hebrew and English from the i18n dictionary only.
