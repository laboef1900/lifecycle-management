# Graphite Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shift dark mode neutrals to cool graphite, calm the brand-blue accent across both modes, remove the body gradient.

**Architecture:** Single-file CSS token swap inside `apps/web/src/styles.css`. No new files. No code changes. No test fixtures need updating — the change is purely a visual recolor of existing CSS custom properties consumed by Tailwind via the `@theme` block.

**Tech Stack:** Tailwind v4 with CSS custom properties. OKLCH color space.

**Spec:** [`docs/superpowers/specs/2026-05-23-graphite-polish-design.md`](../specs/2026-05-23-graphite-polish-design.md)

---

## File map

**Modified files**

- `apps/web/src/styles.css` — only file touched. Edits:
  - 8 token values inside `html.dark { ... }` (hue + chroma swap).
  - 2 token values inside `:root { ... }` (primary + ring).
  - 2 token values inside `html.dark { ... }` (primary + ring).
  - 1 token value deleted from `:root` (`--bg-gradient-bottom`).
  - 1 token value deleted from `html.dark` (`--bg-gradient-bottom`).
  - 1 `body` rule changed from gradient to flat background.

---

## Task 1: Apply the full graphite + polish recolor

**Files:**

- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Edit `:root` — calm the primary accent**

In `apps/web/src/styles.css`, inside the `:root { ... }` block, find:

```css
--ring: oklch(50% 0.22 262);
--primary: oklch(50% 0.22 262);
```

Replace with:

```css
--ring: oklch(50% 0.13 262);
--primary: oklch(50% 0.13 262);
```

- [ ] **Step 2: Edit `:root` — drop the gradient bottom token**

Inside the same `:root` block, find:

```css
--bg-gradient-bottom: oklch(97% 0.005 257);
```

Delete the entire line.

- [ ] **Step 3: Edit `html.dark` — graphite neutrals**

Inside the `html.dark { ... }` block, replace the existing neutral token values. Find each of the lines on the left and replace with the value on the right:

| Existing line (find verbatim)                | Replacement                                  |
| -------------------------------------------- | -------------------------------------------- |
| `  --background: oklch(13% 0.01 257);`       | `  --background: oklch(13% 0.005 280);`      |
| `  --card: oklch(18% 0.01 257);`             | `  --card: oklch(16% 0.005 280);`            |
| `  --popover: oklch(22% 0.01 257);`          | `  --popover: oklch(20% 0.005 280);`         |
| `  --muted: oklch(22% 0.01 257);`            | `  --muted: oklch(20% 0.005 280);`           |
| `  --muted-foreground: oklch(68% 0.02 257);` | `  --muted-foreground: oklch(68% 0.01 280);` |
| `  --border: oklch(28% 0.01 257);`           | `  --border: oklch(26% 0.005 280);`          |
| `  --input: oklch(28% 0.01 257);`            | `  --input: oklch(26% 0.005 280);`           |
| `  --secondary: oklch(24% 0.01 257);`        | `  --secondary: oklch(22% 0.005 280);`       |
| `  --accent: oklch(28% 0.02 250);`           | `  --accent: oklch(26% 0.01 280);`           |

- [ ] **Step 4: Edit `html.dark` — calm the primary accent**

In the same `html.dark { ... }` block, find:

```css
--ring: oklch(68% 0.18 262);
--primary: oklch(68% 0.18 262);
```

Replace with:

```css
--ring: oklch(68% 0.13 262);
--primary: oklch(68% 0.13 262);
```

- [ ] **Step 5: Edit `html.dark` — drop the gradient bottom token**

In the same `html.dark { ... }` block, find:

```css
--bg-gradient-bottom: oklch(11% 0.01 257);
```

Delete the entire line.

- [ ] **Step 6: Edit `body` — flat background instead of gradient**

Find the `body { ... }` rule:

```css
body {
  background: linear-gradient(180deg, var(--background) 0%, var(--bg-gradient-bottom) 100%);
  background-attachment: fixed;
  font-family: var(--font-sans);
  font-feature-settings: 'cv02', 'cv03', 'cv04', 'cv11';
}
```

Replace with:

```css
body {
  background: var(--background);
  font-family: var(--font-sans);
  font-feature-settings: 'cv02', 'cv03', 'cv04', 'cv11';
}
```

(Drop both `background: linear-gradient(...)` and `background-attachment: fixed` — the flat fill no longer needs the attachment hint.)

- [ ] **Step 7: Verify nothing broke**

Run:

- `pnpm --filter @lcm/web test` — full suite still green (no behavior change expected).
- `pnpm --filter @lcm/web typecheck` — clean.
- `pnpm --filter @lcm/web lint` — clean.

- [ ] **Step 8: Confirm no stale references to `--bg-gradient-bottom`**

Run:

```bash
grep -rn "bg-gradient-bottom" apps/web/src
```

Expected: no matches. (The token is no longer declared and is no longer consumed.)

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/styles.css
git commit -m "feat(web): graphite dark mode, calmer accent, flat body"
```

---

## Task 2: Manual visual verification

This task produces evidence; it is not committed.

- [ ] **Step 1: Rebuild docker stack so it serves the branch code**

```bash
docker compose build web
docker compose up -d web
until curl -sf http://localhost:8082 -o /dev/null; do sleep 1; done; echo UP
```

- [ ] **Step 2: Compare light mode at 1440 × 900**

Open `http://localhost:8082/` in light mode and confirm:

- The body has no top-to-bottom gradient (flat fill).
- The "+ Add cluster" primary button and active sidebar indicator are a calmer blue (less saturated).
- KPI tiles, cluster cards, charts, badges, gauges all render correctly.

- [ ] **Step 3: Compare dark mode at 1440 × 900**

Switch the theme to Dark and confirm:

- Backgrounds read as graphite — neutral with a slight cool/violet undertone, NOT the prior blue-slate tint.
- Cards have a subtle 3-pt lift over the background instead of the prior 5-pt lift.
- The primary accent (active sidebar inset, primary button) is a calmer blue.
- KPI tiles, cluster cards, charts, badges, gauges all render correctly; the chart consumption line is intentionally unchanged (still bright blue — out of scope).

- [ ] **Step 4: Spot-check at 390 × 844**

Open `/clusters` at phone width and confirm the new palette holds: card stack renders, hamburger trigger works, KPI banner stacks correctly. Same visual checks apply in both light and dark.

- [ ] **Step 5: If any regression, file a follow-up task**

Do not amend the commit — file a follow-up.

---

## Definition of done

- `apps/web/src/styles.css` updated per the tables in the spec.
- `pnpm --filter @lcm/web test`, `pnpm --filter @lcm/web typecheck`, `pnpm --filter @lcm/web lint` all clean.
- Manual visual verification confirms graphite dark mode, calmer primary, flat body in both modes.
- No regression in cards, charts, badges, gauges, or any consumer of CSS tokens.
