# Apple-like Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply a focused "macOS-app-chrome" polish pass on top of the shipped UI refresh: heavier corners, frosted sidebar+header, soft layered shadows, body gradient, refined Kbd chips, accent-bar on active sidebar nav, app-icon tile, larger page h1, and an eyebrow on the "Capacity forecast" section.

**Architecture:** Token-driven. Add four CSS custom properties (two radii, one shadow, one gradient stop) and one body background rule. Components consume the new tokens via Tailwind v4 arbitrary-value utilities (`shadow-[var(--shadow-card)]`) or by direct class swaps (`rounded-lg` → `rounded-xl`). No new dependencies, no behavior changes, no test additions.

**Tech Stack:** React 19, Tailwind v4, existing shadcn-style primitives, Lucide icons.

**Spec:** [`docs/superpowers/specs/2026-05-23-apple-polish-design.md`](../specs/2026-05-23-apple-polish-design.md)

**Branch:** `apple-polish` (already checked out; spec committed as `f66ddf0`).

**Project conventions:**

- Husky pre-commit runs Prettier + `pnpm -r typecheck`. Don't bypass.
- Path alias `@/` resolves to `apps/web/src/`.
- Single quotes, named exports, React 19 `React.JSX.Element` return types.

---

## File Structure

**Modified (10 files):**

```
apps/web/src/
├─ styles.css                                       new tokens + body gradient
├─ components/
│  ├─ ui/
│  │  ├─ card.tsx                                   rounded-xl + new shadow
│  │  └─ kbd.tsx                                    chunkier key cap
│  ├─ layout/
│  │  ├─ app-shell.tsx                              transparent header + app-icon tile
│  │  └─ sidebar.tsx                                frosted bg + accent bar
│  ├─ command/
│  │  ├─ command-palette.tsx                        rounded-2xl + 680px max
│  │  └─ shortcuts-dialog.tsx                       rounded-2xl
│  └─ clusters/
│     └─ cluster-table.tsx                          hover tone bump
└─ routes/
   ├─ index.tsx                                     h1 26px
   └─ clusters.$id.tsx                              h1 26px + eyebrow above forecast
```

**Untouched:** all tests (19 unit + 1 e2e), all API code, Prisma, `packages/shared`, Docker, CI, ThemeProvider, useChartColors, all chart files, Badge, Button, Toaster, Tooltip, all route logic.

---

## Task 1 — Tokens + body gradient

**Files:**

- Modify: `apps/web/src/styles.css`

**Goal:** Add three new tokens (`--radius-card`, `--radius-modal`, `--shadow-card`, `--bg-gradient-bottom`) and switch the body background to a subtle vertical gradient. After this task, the page background should read as a barely-perceptible top-to-bottom gradient in both modes, and `shadow-[var(--shadow-card)]` should work as a Tailwind utility.

- [ ] **Step 1: Open `apps/web/src/styles.css` and locate the `:root { ... }` block.**

Inside the existing `:root` block (currently ends with `--radius: 0.5rem;`), insert immediately before the closing brace:

```css
--radius-card: 0.75rem;
--radius-modal: 1rem;
--shadow-card: 0 1px 2px rgba(0, 0, 0, 0.04), 0 4px 12px rgba(0, 0, 0, 0.04);
--bg-gradient-bottom: oklch(97% 0.005 257);
```

- [ ] **Step 2: Locate the `html.dark { ... }` block.**

Inside the existing `html.dark` block (currently ends with `--destructive-foreground: oklch(13% 0.01 257);`), insert immediately before the closing brace:

```css
--shadow-card: none;
--bg-gradient-bottom: oklch(11% 0.01 257);
```

(Dark mode does NOT redefine `--radius-card` or `--radius-modal` — corners stay the same in both modes.)

- [ ] **Step 3: Locate the `@theme { ... }` block.**

Inside the existing `@theme` block (currently has `--radius: var(--radius);` near the end), insert immediately after the `--radius:` line:

```css
--radius-card: var(--radius-card);
--radius-modal: var(--radius-modal);
--shadow-card: var(--shadow-card);
```

Tailwind v4 will now emit utilities like `rounded-card`, `rounded-modal`, and `shadow-card`. We won't use those utility names in code (we'll use arbitrary values via `var()`), but exposing them in `@theme` is how the variables become available to the build pipeline.

- [ ] **Step 4: Update the body background rule.**

Find the existing `body { font-family: var(--font-sans); ... }` block at the bottom of the file. Replace it with:

```css
body {
  background: linear-gradient(180deg, var(--background) 0%, var(--bg-gradient-bottom) 100%);
  background-attachment: fixed;
  font-family: var(--font-sans);
  font-feature-settings: 'cv02', 'cv03', 'cv04', 'cv11';
}
```

This anchors the gradient to the viewport so it doesn't drift on scroll. The body's own `bg-background text-foreground` classes in `index.html` are now overridden by the more-specific `background` rule — that's intentional.

- [ ] **Step 5: Verify build**

```bash
pnpm --filter @lcm/web build
```

Expected: build succeeds, no CSS errors. (Husky-style mid-edit checks aren't needed since this commit will trigger them anyway.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/styles.css
git commit -m "feat(web): add radius/shadow/gradient tokens; body gradient

Introduces --radius-card (12px), --radius-modal (16px), --shadow-card
(soft layered, none in dark), and --bg-gradient-bottom for the body
window-material gradient. Body now uses a fixed-attachment vertical
gradient between --background and --bg-gradient-bottom."
```

---

## Task 2 — Card, Kbd, app-shell (header + logo)

**Files:**

- Modify: `apps/web/src/components/ui/card.tsx`
- Modify: `apps/web/src/components/ui/kbd.tsx`
- Modify: `apps/web/src/components/layout/app-shell.tsx`

**Goal:** Three primitive/chrome surfaces lean into the new tokens.

- [ ] **Step 1: Update `Card` to use new corner + shadow tokens.**

In `apps/web/src/components/ui/card.tsx`, replace ONLY the `Card` forwardRef definition's class string (the first `cn(...)` call). The current code looks like:

```tsx
export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-lg border border-border bg-card text-card-foreground shadow-xs dark:shadow-none',
        className,
      )}
      {...props}
    />
  ),
);
```

Change to:

```tsx
export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-xl border border-border bg-card text-card-foreground shadow-[var(--shadow-card)]',
        className,
      )}
      {...props}
    />
  ),
);
```

Two changes: `rounded-lg` → `rounded-xl`, and `shadow-xs dark:shadow-none` → `shadow-[var(--shadow-card)]` (the token already resolves to `none` in dark mode). Leave `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` untouched.

- [ ] **Step 2: Update `Kbd` to chunkier key-cap.**

Replace the entire contents of `apps/web/src/components/ui/kbd.tsx` with:

```tsx
import * as React from 'react';

import { cn } from '@/lib/utils';

export function Kbd({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement>): React.JSX.Element {
  return (
    <kbd
      className={cn(
        'inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-md',
        'border border-border bg-gradient-to-b from-muted to-muted/60',
        'px-1.5 font-mono text-[11px] font-medium text-muted-foreground',
        'shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] dark:shadow-[inset_0_-1px_0_rgba(255,255,255,0.04)]',
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}
```

Differences from current: `h-5 min-w-[1.25rem]` → `h-6 min-w-[1.5rem]`, single `bg-muted` → vertical gradient, text-[10px] → text-[11px], added inset shadow that flips polarity between modes.

- [ ] **Step 3: Update `app-shell.tsx` header transparency + logo tile.**

Open `apps/web/src/components/layout/app-shell.tsx`. Find the `Header()` function's outer `<header>` element. The current class string starts with `'sticky top-0 z-30 flex h-14 shrink-0 items-center gap-4 border-b border-border bg-card/95 px-4 backdrop-blur'`. Replace `bg-card/95 ... backdrop-blur` with `bg-card/70 ... backdrop-blur-xl`. The full updated string:

```tsx
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-4 border-b border-border bg-card/70 px-4 backdrop-blur-xl">
```

Then find the logo `<Link>`:

```tsx
<Link to="/" className="flex items-center gap-2 font-semibold">
  <Activity className="h-5 w-5 text-primary" aria-hidden />
  <span className="hidden sm:inline">Capacity Forecast</span>
</Link>
```

Replace with:

```tsx
<Link to="/" className="flex items-center gap-2.5 font-semibold">
  <span
    aria-hidden
    className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/70 shadow-[var(--shadow-card)]"
  >
    <Activity className="h-4 w-4 text-primary-foreground" />
  </span>
  <span className="hidden sm:inline">Capacity Forecast</span>
</Link>
```

The icon is now visually wrapped in a 28×28 indigo-gradient tile; gap between icon and text grew slightly (`gap-2` → `gap-2.5`).

- [ ] **Step 4: Verify build + typecheck**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web build
```

Expected: both pass cleanly.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/card.tsx apps/web/src/components/ui/kbd.tsx apps/web/src/components/layout/app-shell.tsx
git commit -m "feat(web): chunkier Kbd, 12px Card corners, frosted header + app-icon tile

Card uses new --shadow-card token (none in dark) and rounded-xl. Kbd
becomes a real-looking key cap (h-6, vertical gradient, inset depth
shadow). Header lifts to bg-card/70 + backdrop-blur-xl so the body
gradient reads through it. The Activity logo is now wrapped in a
28×28 indigo-gradient rounded-square tile."
```

---

## Task 3 — Sidebar, dialogs, routes, table hover

**Files:**

- Modify: `apps/web/src/components/layout/sidebar.tsx`
- Modify: `apps/web/src/components/command/command-palette.tsx`
- Modify: `apps/web/src/components/command/shortcuts-dialog.tsx`
- Modify: `apps/web/src/routes/index.tsx`
- Modify: `apps/web/src/routes/clusters.$id.tsx`
- Modify: `apps/web/src/components/clusters/cluster-table.tsx`

**Goal:** Sidebar becomes frosted with a primary-color accent bar on the active item; dialogs go `rounded-2xl`; page titles bump to 26px; "Capacity forecast" gets an eyebrow; table row hover tightens.

- [ ] **Step 1: Update `sidebar.tsx` background + active accent.**

Open `apps/web/src/components/layout/sidebar.tsx`. Find the `<aside>` element. Current outer class includes `bg-card`. Replace `bg-card` with `bg-card/60 backdrop-blur-xl`. The full `cn(...)` call becomes:

```tsx
    <aside
      className={cn(
        'flex shrink-0 flex-col border-r border-border bg-card/60 backdrop-blur-xl transition-[width] duration-150 ease-out',
        collapsed ? 'w-16' : 'w-60',
      )}
      aria-label="Primary navigation"
    >
```

Then find the `<Link>` `activeProps`:

```tsx
                activeProps={{
                  className: 'bg-muted text-foreground',
                }}
```

Replace with:

```tsx
                activeProps={{
                  className:
                    'bg-muted text-foreground shadow-[inset_3px_0_0_0_var(--primary)]',
                }}
```

The inset box-shadow paints a 3px primary-color stripe on the left edge of active items without changing their box geometry — collapsed-mode items still respect the same indent.

- [ ] **Step 2: Update `command-palette.tsx` dialog content classes.**

Open `apps/web/src/components/command/command-palette.tsx`. Find the `Dialog.Content` element. Its current `cn(...)` includes:

```tsx
            'fixed left-[50%] top-[20%] z-50 grid w-[92vw] max-w-[640px] translate-x-[-50%] gap-0',
            'overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl',
```

Change to:

```tsx
            'fixed left-[50%] top-[20%] z-50 grid w-[92vw] max-w-[680px] translate-x-[-50%] gap-0',
            'overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-xl',
```

Two changes on those two lines: `max-w-[640px]` → `max-w-[680px]`, `rounded-lg` → `rounded-2xl`. Everything else in the file unchanged.

- [ ] **Step 3: Update `shortcuts-dialog.tsx` dialog content classes.**

Open `apps/web/src/components/command/shortcuts-dialog.tsx`. Find the `Dialog.Content` element. Its current class includes `rounded-lg`. Change to `rounded-2xl`. The full line becomes:

```tsx
        <Dialog.Content className="fixed left-[50%] top-[50%] z-50 w-[92vw] max-w-md translate-x-[-50%] translate-y-[-50%] rounded-2xl border border-border bg-popover p-5 text-popover-foreground shadow-xl">
```

Only `rounded-lg` → `rounded-2xl`. Everything else unchanged.

- [ ] **Step 4: Update `routes/index.tsx` h1 size.**

Open `apps/web/src/routes/index.tsx`. Find the dashboard's `<h1>`:

```tsx
<h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
```

Replace with:

```tsx
<h1 className="text-[1.625rem] font-semibold tracking-tight">Dashboard</h1>
```

`text-2xl` (24px) → `text-[1.625rem]` (26px). Nothing else in the file changes.

- [ ] **Step 5: Update `routes/clusters.$id.tsx` h1 size + add eyebrow above forecast.**

Open `apps/web/src/routes/clusters.$id.tsx`. First, find the cluster detail `<h1>`:

```tsx
<h1 className="text-2xl font-semibold tracking-tight">{clusterQuery.data.name}</h1>
```

Replace with:

```tsx
<h1 className="text-[1.625rem] font-semibold tracking-tight">{clusterQuery.data.name}</h1>
```

Then find the "Capacity forecast" h2 block. The current code looks like:

```tsx
<div className="flex items-center justify-between">
  <h2 className="text-lg font-semibold">Capacity forecast</h2>
  <WindowControls value={windowSelection} onChange={setWindowSelection} />
</div>
```

Replace with:

```tsx
<div className="flex items-center justify-between">
  <div className="space-y-1">
    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      Forecast
    </p>
    <h2 className="text-lg font-semibold">Capacity forecast</h2>
  </div>
  <WindowControls value={windowSelection} onChange={setWindowSelection} />
</div>
```

The h2 is now nested under a small "FORECAST" eyebrow. WindowControls placement unchanged (they still right-align relative to the h2 row because the outer flex is unchanged).

- [ ] **Step 6: Update `cluster-table.tsx` row hover.**

Open `apps/web/src/components/clusters/cluster-table.tsx`. Find the cluster data row:

```tsx
              <TableRow key={cluster.id} className="hover:bg-muted/50">
```

Change to:

```tsx
              <TableRow key={cluster.id} className="hover:bg-muted/60">
```

One character: `/50` → `/60`.

- [ ] **Step 7: Verify build + typecheck + tests + lint**

```bash
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web test
pnpm --filter @lcm/web build
```

Expected: all pass. The Playwright golden-path test (`pnpm --filter @lcm/web test:e2e`) is not strictly required for this polish pass — its only theme/UI assertions are based on `aria-label` (theme toggle) and `html.dark` class. None of the visual changes here affect either. Skip running e2e here to save time; the regular test suite is sufficient.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/layout/sidebar.tsx apps/web/src/components/command/command-palette.tsx apps/web/src/components/command/shortcuts-dialog.tsx apps/web/src/routes/index.tsx 'apps/web/src/routes/clusters.$id.tsx' apps/web/src/components/clusters/cluster-table.tsx
git commit -m "feat(web): frosted sidebar w/ accent, rounded dialogs, larger h1, eyebrow

Sidebar uses bg-card/60 + backdrop-blur-xl so the body gradient reads
through it; active nav item gains a 3px primary-color inset accent
bar (no geometry change). Command palette + shortcuts dialog go
rounded-2xl (palette also +40px wider). Page h1 bumps from 24px to
26px. \"Capacity forecast\" sub-section now has a small uppercase
'Forecast' eyebrow above it. Cluster-table row hover tone bumps
from bg-muted/50 to bg-muted/60."
```

---

## Acceptance verification

After Task 3 commits, walk the running app once in each mode (light + dark):

```bash
pnpm --filter @lcm/web dev
```

Confirm in browser:

1. ☐ Page background has a subtle top-to-bottom gradient (move your eye between the very top and very bottom of the viewport — you should sense a slight tonal shift)
2. ☐ Cards have 12px corners and a soft, diffused shadow in light mode (no harsh edge); no shadow in dark
3. ☐ Sidebar feels frosted — the body gradient is visible through it
4. ☐ Header is more transparent than before; gradient is also visible through it
5. ☐ Active sidebar item (Dashboard on /) shows a 3px primary-color bar on its left edge
6. ☐ Logo is wrapped in a small indigo-gradient rounded square
7. ☐ Press ⌘K or Ctrl+K — palette opens with 16px corners and slightly wider (680px)
8. ☐ Press ? — shortcuts dialog opens with 16px corners; Kbd chips look chunkier with a subtle gradient and depth
9. ☐ Page `h1` reads slightly larger (26px) on both Dashboard and the cluster detail page
10. ☐ On the cluster detail page, a small "FORECAST" eyebrow sits above "Capacity forecast"
11. ☐ Table rows: hover affordance is a touch more visible than before
12. ☐ No console errors; no layout shift between theme toggles
13. ☐ `git diff main --stat` confirms only the 10 files in the file map plus `pnpm-lock.yaml` (which shouldn't change — no new deps) are touched. The plan and design spec under `docs/` are also part of the branch.

---

## Notes for the executor

- **All changes are class swaps or single-line CSS additions.** No new components, no new hooks, no new dependencies.
- **No new tests required.** The visual changes don't alter behavior; all 19 existing unit tests + 1 e2e remain green.
- **Husky pre-commit** runs Prettier + `pnpm -r typecheck`. If something fails, fix the underlying issue and re-stage; don't `--amend`.
- **Cmd+K key in the palette test** — the palette's `max-w` change from 640px → 680px doesn't affect the placeholder-text selector the test uses, so `command-palette.test.tsx` stays green.
- **Where to look if a token isn't generated** — Tailwind v4 emits `--color-*`, `--radius-*`, and `--shadow-*` utilities from `@theme` entries. If `shadow-[var(--shadow-card)]` produces no shadow, double-check the `@theme` block has `--shadow-card: var(--shadow-card);`.
- **The body gradient uses `background-attachment: fixed`.** This is intentional. If you find scroll-perf weird on long pages, this is the cause — but the LCM dashboard isn't a long page, so it should be fine.
