# Graphite polish — design spec

**Date:** 2026-05-23
**Status:** Approved, ready for implementation plan
**Scope:** Refine the visual palette to feel more professional. Shift dark
mode neutrals from blue-tinted to cool graphite, calm the brand-blue
accent across both modes, and remove the body gradient. Single-file CSS
change.

## Why

Dark mode currently reads as "blue-tinted slate" because all neutral
tokens use chroma 0.01 at hue 257. The user requested an actual graphite
feel (cooler hue, lower chroma) and a more enterprise/professional
overall character. Combined with a calmer accent and a flatter
background, the app should read less "marketing landing page" and more
"infrastructure dashboard".

## What changes

### 1. Dark mode neutrals → cool graphite

Shift the dark neutral palette from blue-tinted (hue 257, chroma 0.01)
to cool graphite (hue 280, chroma 0.005). The hue shift moves from
azure-blue toward a violet-grey that matches actual pencil graphite.
Chroma drops by half so the tint is much subtler.

| Token                | Current               | New                    |
| -------------------- | --------------------- | ---------------------- |
| `--background`       | `oklch(13% 0.01 257)` | `oklch(13% 0.005 280)` |
| `--card`             | `oklch(18% 0.01 257)` | `oklch(16% 0.005 280)` |
| `--popover`          | `oklch(22% 0.01 257)` | `oklch(20% 0.005 280)` |
| `--muted`            | `oklch(22% 0.01 257)` | `oklch(20% 0.005 280)` |
| `--muted-foreground` | `oklch(68% 0.02 257)` | `oklch(68% 0.01 280)`  |
| `--border`           | `oklch(28% 0.01 257)` | `oklch(26% 0.005 280)` |
| `--input`            | `oklch(28% 0.01 257)` | `oklch(26% 0.005 280)` |
| `--secondary`        | `oklch(24% 0.01 257)` | `oklch(22% 0.005 280)` |
| `--accent`           | `oklch(28% 0.02 250)` | `oklch(26% 0.01 280)`  |

The `--card` lift over `--background` drops from 5 percentage points to
3, so cards integrate more with the surface instead of floating above
it. This is a deliberate move away from the "card-as-feature" treatment
toward a calmer enterprise look.

### 2. Calm the primary accent (both modes)

Reduce the brand-blue chroma from `0.22` (light) and `0.18` (dark) down
to `0.13` in both modes. The hue stays at 262 so the color identity is
preserved; the accent just stops shouting.

| Token                 | Current               | New                   |
| --------------------- | --------------------- | --------------------- |
| `:root --primary`     | `oklch(50% 0.22 262)` | `oklch(50% 0.13 262)` |
| `:root --ring`        | `oklch(50% 0.22 262)` | `oklch(50% 0.13 262)` |
| `html.dark --primary` | `oklch(68% 0.18 262)` | `oklch(68% 0.13 262)` |
| `html.dark --ring`    | `oklch(68% 0.18 262)` | `oklch(68% 0.13 262)` |

Affects: focus rings, the active-route inset shadow on the sidebar, the
"+ Add cluster" primary button, badge defaults, and any other consumer
of `--primary` / `--ring`.

### 3. Remove body gradient (both modes)

The current `<body>` uses
`linear-gradient(180deg, var(--background) 0%, var(--bg-gradient-bottom) 100%)`.
Drop the gradient and the two `--bg-gradient-bottom` token declarations.
The body simply uses `var(--background)` as a flat fill. This
contributes the largest perceived shift toward "professional" because it
removes the soft top-to-bottom warmth gradient and lets the cards
provide visual hierarchy on their own.

### 4. Tighten dark card lift

Already folded into section 1: `--card` moves from 18% lightness to 16%,
so the lift above the 13% background is 3pt instead of 5pt.

## Out of scope

- Chart line colors in `apps/web/src/lib/use-chart-colors.ts`. The
  consumption line is hard-coded at chroma 0.22 / 0.18 and remains
  unchanged. (Charts are a separate visual concern; consistency-pass for
  charts is deferred.)
- Light mode neutral tokens. The user asked for dark mode to feel
  graphite; light mode keeps its current near-white surface palette.
- Typography, spacing, radius, shadow tokens. No changes.
- Gauge ring / status badge colors (those use `--success`, `--warning`,
  `--destructive` — unaffected by this change).

## Files

**Modified**

- `apps/web/src/styles.css` — only file touched. Approximately 12 token
  lines change inside `:root` and `html.dark` blocks, plus the `body`
  rule.

**No new files.**

## Testing

The visual change is a CSS token swap. Existing unit/e2e tests verify
that nothing breaks structurally; visual correctness is verified
manually via Playwright at light + dark, 1440 × 900.

**Verification checklist (manual):**

- `pnpm --filter @lcm/web test` still green (no behavior change
  expected).
- `pnpm --filter @lcm/web typecheck` and `pnpm --filter @lcm/web lint`
  clean.
- Visual check at 1440 × 900:
  - Dark mode: backgrounds read as graphite (no blue undertone), cards
    sit subtly on the surface, primary button + active sidebar item are
    a calmer blue.
  - Light mode: primary accent is calmer; body is flat (no gradient).
  - Charts still render correctly (the consumption line stays its
    current saturation; this is intentional).

## Definition of done

- `apps/web/src/styles.css` updated per the tables above.
- Tests + typecheck + lint clean.
- Visual verification confirms dark mode reads as graphite, primary is
  calmer, body is flat in both modes, no regression in cards, charts,
  badges, or gauges.
