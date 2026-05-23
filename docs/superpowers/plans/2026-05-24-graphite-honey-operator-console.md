# Graphite + Honey Operator Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current "graphite + blue" visual system with an operator-console aesthetic on pure-neutral surfaces with a honey accent (`#F9C74F` dark / `#8A6016` light), monospace numerals on data, flat surfaces with razor-thin borders, no shadows on cards, and a strictly-rationed accent that only marks the headline metric per view, the focused chart series, the active nav item, and primary CTAs.

**Architecture:** Token-driven cascade. A single `styles.css` rewrite swaps the entire design system; every UI primitive consumes the new tokens via Tailwind utility classes (no per-component theme files). One small type change (`KpiStatus = UtilStatus | 'attention'`) and one branch in `routes/index.tsx` introduce the headline-metric rule. Chart palette becomes grayscale-with-honey-on-focus via a full rewrite of `use-chart-colors.ts`. No new dependencies. No new files.

**Tech Stack:** Tailwind v4 (CSS custom properties via `@theme`), shadcn-style UI primitives in `apps/web/src/components/ui/`, Recharts for visualization, Vitest + Testing Library for unit tests, Playwright for e2e.

**Spec:** [`docs/superpowers/specs/2026-05-24-graphite-honey-operator-console-design.md`](../specs/2026-05-24-graphite-honey-operator-console-design.md)

---

## File map

**Foundation (cascade source)**

- `apps/web/src/styles.css` — full token rewrite. Drops `oklch()` neutrals + blue primary + body gradient + `--shadow-card`. Adds hex tokens, `--card-hover`, `--fg-muted`, `--fg-subtle`, `--accent-soft`. New radii (6/8/12px). Inter + JetBrains Mono font-size tokens.

**Lib / logic**

- `apps/web/src/lib/forecast-summary.ts` — add `KpiStatus = UtilStatus | 'attention'`.
- `apps/web/src/lib/use-chart-colors.ts` — full rewrite. Grayscale cluster palette, honey for focused series, monochrome event markers, hex values aligned with the token palette.

**UI primitives** (`apps/web/src/components/ui/`)

- `button.tsx` — replace `default` (was bg-primary) with neutral; add `accent` (honey fill); drop `secondary`; new heights (28/32/36).
- `card.tsx` — drop `shadow-[var(--shadow-card)]`; new radius (8px).
- `badge.tsx` — drop dependencies on `*-strong` tokens; rework success/warning/danger to use soft fills + accent variant.
- `input.tsx` — flat, 6px radius, no focus shadow (honey ring instead).
- `select.tsx` — same flat treatment; popover gets overlay shadow.
- `table.tsx` — 36px row height, 1px dividers, `--card-hover` on row hover.
- `tabs.tsx` — active tab = 2px honey underline.
- `tooltip.tsx` — solid `--popover` background + overlay shadow + 12px radius.
- `dialog.tsx` — modal radius (12px), overlay shadow.
- `sheet.tsx` — same overlay treatment.
- `runway-pill.tsx` — use `accent` badge variant for no-breach case; tests updated.
- `utilization-gauge.tsx` — adopt new `--warning` / `--destructive`; `ok` ring uses `--fg-muted` (gray) so healthy state goes quiet.

**Feature components**

- `apps/web/src/components/overview/kpi-tile.tsx` — accept `KpiStatus`; `numeric-lg` mono value; left 2px accent bar for `attention/warn/crit`; 14px padding.
- `apps/web/src/components/overview/cluster-tile.tsx` — flatten + tighten.
- `apps/web/src/components/overview/fleet-capacity-chart.tsx` — hover-to-focus interaction; grayscale lines; one honey line at a time; dashed border reference lines.
- `apps/web/src/components/clusters/forecast-chart.tsx` — single-series re-theme (honey forecast, dashed refs).
- `apps/web/src/components/clusters/utilization-panel.tsx` — re-skin panel surfaces.

**Layout shell**

- `apps/web/src/components/layout/app-shell.tsx` — drop gradient logo (replace with flat honey square + dark icon); drop `bg-card/70 backdrop-blur-xl` header → solid `--background` + bottom border.
- `apps/web/src/components/layout/sidebar.tsx` — drop `bg-card/60 backdrop-blur-xl` → solid + right border; active item = 2px honey left border (replaces inset shadow + muted bg).

**Routes**

- `apps/web/src/routes/index.tsx` — H1 uses `display` token; eyebrow label "Capacity Forecast"; runway tile gets `attention` status when no breach.
- `apps/web/src/routes/clusters.index.tsx`, `clusters.$id.tsx`, `clusters.new.tsx`, `settings.tsx` — token cascade; no structural changes.

---

## Branch + worktree convention

Use a feature branch — recent precedent is `graphite-polish`. Recommended name: `honey-operator-console`.

```bash
git checkout -b honey-operator-console
```

If executing via `superpowers:using-git-worktrees`, the worktree is created up-front. All commits in this plan stay on this branch; PR comes at the end (Task 15).

---

## Task 1: Token rewrite in `styles.css`

**Files:**

- Modify: `apps/web/src/styles.css` (full rewrite)

This task is a single-file replacement. Every downstream task assumes these tokens exist. After this lands, the app will look broken in places (consumers of `--primary`, `--secondary`, `--shadow-card`, `--*-strong`) — those get fixed in Tasks 4–14. Type/lint/test pass at this step; the visual breakage is expected.

- [ ] **Step 1: Replace `apps/web/src/styles.css` in full**

Replace the entire file contents with:

```css
@import 'tailwindcss';
@import '@fontsource/inter/400.css';
@import '@fontsource/inter/500.css';
@import '@fontsource/inter/600.css';
@import '@fontsource/inter/700.css';
@import '@fontsource/jetbrains-mono/400.css';
@import '@fontsource/jetbrains-mono/500.css';

:root {
  --background: #fafafa;
  --foreground: #0a0a0a;
  --card: #ffffff;
  --card-foreground: #0a0a0a;
  --card-hover: #f7f7f7;
  --popover: #ffffff;
  --popover-foreground: #0a0a0a;
  --muted: #f5f5f5;
  --muted-foreground: #525252;
  --fg-muted: #525252;
  --fg-subtle: #737373;
  --border: #e5e5e5;
  --input: #e5e5e5;
  --ring: #8a6016;
  --accent: #8a6016;
  --accent-foreground: #ffffff;
  --accent-soft: rgba(138, 96, 22, 0.1);
  --success: #15803d;
  --success-foreground: #ffffff;
  --warning: #b45309;
  --warning-foreground: #ffffff;
  --destructive: #b91c1c;
  --destructive-foreground: #ffffff;
  --radius: 6px;
  --radius-card: 8px;
  --radius-modal: 12px;
  --overlay-shadow: 0 8px 24px rgba(0, 0, 0, 0.08), 0 2px 4px rgba(0, 0, 0, 0.04);
}

html.dark {
  --background: #0a0a0a;
  --foreground: #fafafa;
  --card: #111111;
  --card-foreground: #fafafa;
  --card-hover: #161616;
  --popover: #161616;
  --popover-foreground: #fafafa;
  --muted: #1a1a1a;
  --muted-foreground: #a3a3a3;
  --fg-muted: #a3a3a3;
  --fg-subtle: #737373;
  --border: #262626;
  --input: #262626;
  --ring: #f9c74f;
  --accent: #f9c74f;
  --accent-foreground: #0a0a0a;
  --accent-soft: rgba(249, 199, 79, 0.15);
  --success: #4ade80;
  --success-foreground: #0a0a0a;
  --warning: #f59e0b;
  --warning-foreground: #0a0a0a;
  --destructive: #f87171;
  --destructive-foreground: #0a0a0a;
  --overlay-shadow: 0 8px 24px rgba(0, 0, 0, 0.32), 0 2px 4px rgba(0, 0, 0, 0.2);
}

@theme {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-card-hover: var(--card-hover);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-fg-muted: var(--fg-muted);
  --color-fg-subtle: var(--fg-subtle);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-accent-soft: var(--accent-soft);
  --color-success: var(--success);
  --color-success-foreground: var(--success-foreground);
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --radius: var(--radius);
  --radius-card: var(--radius-card);
  --radius-modal: var(--radius-modal);
  --font-sans: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
  --text-display: 26px;
  --text-display--line-height: 1.1;
  --text-display--letter-spacing: -0.02em;
  --text-display--font-weight: 600;
  --text-h1: 20px;
  --text-h1--line-height: 1.2;
  --text-h1--letter-spacing: -0.015em;
  --text-h1--font-weight: 600;
  --text-h2: 16px;
  --text-h2--line-height: 1.3;
  --text-h2--letter-spacing: -0.01em;
  --text-h2--font-weight: 600;
  --text-body: 14px;
  --text-body--line-height: 1.5;
  --text-label: 10px;
  --text-label--line-height: 1;
  --text-label--letter-spacing: 0.12em;
  --text-label--font-weight: 500;
  --text-caption: 11px;
  --text-caption--line-height: 1.3;
  --text-caption--font-weight: 500;
  --text-numeric-lg: 20px;
  --text-numeric-lg--font-weight: 500;
  --text-numeric: 14px;
  --text-numeric--font-weight: 500;
  --text-code: 12px;
}

html,
body,
#root {
  height: 100%;
}

body {
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
  font-feature-settings: 'cv02', 'cv03', 'cv04', 'cv11';
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0s !important;
    transition-duration: 0s !important;
  }
}
```

- [ ] **Step 2: Run typecheck + lint**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
```

Expected: both PASS. CSS changes don't affect TS types or ESLint rules. If lint fails on an unrelated rule, fix it inline.

- [ ] **Step 3: Run unit tests**

```bash
pnpm --filter @lcm/web test
```

Expected: PASS. Token rewrite doesn't change class names that tests assert on (tests inspect `success`/`warning`/`danger` substrings in className).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/styles.css
git commit -m "feat(web): token rewrite — graphite + honey operator console palette"
```

---

## Task 2: Add `KpiStatus` type + headline-metric branch

**Files:**

- Modify: `apps/web/src/lib/forecast-summary.ts`
- Modify: `apps/web/src/routes/index.tsx`
- Create: `apps/web/src/lib/__tests__/forecast-summary.test.ts` (only if missing)

The functional change: a new presentational status `'attention'` that the overview page applies to the fleet-runway tile whenever no breach is forecast. Existing `UtilStatus` and `utilStatus()` are unchanged.

- [ ] **Step 1: Check whether a forecast-summary test file exists**

```bash
ls apps/web/src/lib/__tests__/ apps/web/src/__tests__/ 2>/dev/null
find apps/web/src -name "forecast-summary.test.*"
```

If a test file exists, edit it; otherwise create one. Subsequent steps assume `apps/web/src/lib/forecast-summary.test.ts` colocated with the source (vitest default).

- [ ] **Step 2: Write a failing test for `KpiStatus` type usage**

Create or extend `apps/web/src/lib/forecast-summary.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { type KpiStatus, type UtilStatus, utilStatus } from './forecast-summary';

describe('utilStatus', () => {
  it('returns ok when utilization is below the warn threshold', () => {
    expect(utilStatus(0.5)).toBe('ok');
  });
  it('returns warn when utilization is between warn and crit', () => {
    expect(utilStatus(0.75)).toBe('warn');
  });
  it('returns crit when utilization is at or above the crit threshold', () => {
    expect(utilStatus(0.95)).toBe('crit');
  });
});

describe('KpiStatus type', () => {
  it('extends UtilStatus with an attention variant', () => {
    const attention: KpiStatus = 'attention';
    const ok: KpiStatus = 'ok';
    const fromUtil: KpiStatus = 'warn' satisfies UtilStatus;
    expect(attention).toBe('attention');
    expect(ok).toBe('ok');
    expect(fromUtil).toBe('warn');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm --filter @lcm/web test forecast-summary
```

Expected: FAIL with a TypeScript error — `KpiStatus` is not exported from `./forecast-summary`.

- [ ] **Step 4: Add `KpiStatus` type to `forecast-summary.ts`**

In `apps/web/src/lib/forecast-summary.ts`, at the bottom of the file (after `utilStatus`), add:

```ts
/**
 * KPI tile status. Extends `UtilStatus` with a presentational `'attention'`
 * marker that callers apply to the single headline metric per view (e.g. the
 * fleet runway tile on the overview page). `utilStatus()` never returns
 * 'attention' — it is chosen by the caller, not derived from a threshold.
 */
export type KpiStatus = UtilStatus | 'attention';
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @lcm/web test forecast-summary
```

Expected: PASS.

- [ ] **Step 6: Update `routes/index.tsx` to apply `'attention'` on the runway tile**

In `apps/web/src/routes/index.tsx`, locate the `runwayStatus` computation (currently a `let runwayStatus: 'ok' | 'warn' | 'crit'` block). Change its declared type and the no-breach branch:

Find:

```ts
let runwayValue: string;
let runwayCaption: string;
let runwayStatus: 'ok' | 'warn' | 'crit';
```

Replace with:

```ts
import type { KpiStatus } from '@/lib/forecast-summary';
// (add this import at the top, alongside the existing imports)

let runwayValue: string;
let runwayCaption: string;
let runwayStatus: KpiStatus;
```

Find the "no breach" branch:

```ts
} else if (fleetRunway.months === null) {
    runwayValue = horizonMonths > 0 ? `${horizonMonths}+ mo` : '—';
    runwayCaption = 'no projected breach';
    runwayStatus = 'ok';
  }
```

Replace with:

```ts
} else if (fleetRunway.months === null) {
    runwayValue = horizonMonths > 0 ? `${horizonMonths}+ mo` : '—';
    runwayCaption = 'no projected breach';
    runwayStatus = 'attention';
  }
```

Leave the `warn`/`crit` branches unchanged — they still return real threshold statuses.

- [ ] **Step 7: Run typecheck**

```bash
pnpm --filter @lcm/web typecheck
```

Expected: FAIL — `KpiTile` doesn't accept `'attention'` yet (Task 11 widens that). Two options:

1. Skip ahead to widen `KpiTile`'s prop type now (one-line change), OR
2. Cast at the call site temporarily and let Task 11 clean it up.

Pick option 1: in `apps/web/src/components/overview/kpi-tile.tsx`, widen the `status` variant union now. Find:

```ts
const dotVariants = cva('h-1.5 w-1.5 rounded-full', {
  variants: {
    status: {
      ok: 'bg-success',
      warn: 'bg-warning',
      crit: 'bg-destructive',
    },
  },
});
```

Add the `attention` entry (it will be re-styled properly in Task 11):

```ts
const dotVariants = cva('h-1.5 w-1.5 rounded-full', {
  variants: {
    status: {
      ok: 'bg-success',
      warn: 'bg-warning',
      crit: 'bg-destructive',
      attention: 'bg-accent',
    },
  },
});
```

- [ ] **Step 8: Run typecheck + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web test
```

Expected: both PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/lib/forecast-summary.ts apps/web/src/lib/forecast-summary.test.ts apps/web/src/routes/index.tsx apps/web/src/components/overview/kpi-tile.tsx
git commit -m "feat(web): add KpiStatus 'attention' marker for headline metric"
```

---

## Task 3: Rewrite `use-chart-colors.ts` for grayscale + honey

**Files:**

- Modify: `apps/web/src/lib/use-chart-colors.ts` (full rewrite)

Keeps the same exported `ChartColors` interface shape so consumers in `fleet-capacity-chart.tsx`, `forecast-chart.tsx`, and `utilization-panel.tsx` don't need to change yet — they pick up new colors automatically. The 6-step rainbow `clusterPalette` becomes a 5-step grayscale; the "consumption" line becomes honey.

- [ ] **Step 1: Replace `apps/web/src/lib/use-chart-colors.ts` in full**

```ts
import type { EventCategory } from '@lcm/shared';
import { useMemo } from 'react';

import { useTheme } from '@/components/theme/use-theme';

export interface ChartColors {
  consumption: string;
  consumptionFill: string;
  capacity: string;
  grid: string;
  axis: string;
  utilizationOk: string;
  utilizationWarn: string;
  utilizationCrit: string;
  event: Record<EventCategory, string>;
  clusterPalette: string[];
}

// Honey is the focused/consumption color. Grayscale palette is used for
// non-focused series in multi-cluster charts — one honey line at a time.
const LIGHT: ChartColors = {
  consumption: '#8a6016',
  consumptionFill: 'rgba(138, 96, 22, 0.10)',
  capacity: '#b91c1c',
  grid: '#e5e5e5',
  axis: '#737373',
  utilizationOk: '#525252',
  utilizationWarn: '#b45309',
  utilizationCrit: '#b91c1c',
  event: {
    growth: '#171717',
    hardware_change: '#525252',
    openshift: '#737373',
    note: '#a3a3a3',
  },
  clusterPalette: ['#171717', '#404040', '#525252', '#737373', '#a3a3a3'],
};

const DARK: ChartColors = {
  consumption: '#f9c74f',
  consumptionFill: 'rgba(249, 199, 79, 0.15)',
  capacity: '#f87171',
  grid: '#262626',
  axis: '#737373',
  utilizationOk: '#a3a3a3',
  utilizationWarn: '#f59e0b',
  utilizationCrit: '#f87171',
  event: {
    growth: '#e5e5e5',
    hardware_change: '#a3a3a3',
    openshift: '#737373',
    note: '#525252',
  },
  clusterPalette: ['#e5e5e5', '#a3a3a3', '#737373', '#525252', '#404040'],
};

export function useChartColors(): ChartColors {
  const { resolvedTheme } = useTheme();
  return useMemo(() => (resolvedTheme === 'dark' ? DARK : LIGHT), [resolvedTheme]);
}
```

- [ ] **Step 2: Run typecheck + lint + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web test
```

Expected: all PASS. The interface didn't change; only the values.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/use-chart-colors.ts
git commit -m "feat(web): rewrite chart palette — honey focused + grayscale series"
```

---

## Task 4: Re-skin `Button` with `accent` variant + new heights

**Files:**

- Modify: `apps/web/src/components/ui/button.tsx`
- Audit + update: any file using `<Button variant="secondary" />` (likely 0; `secondary` is being removed)

The current `default` variant uses `bg-primary` (which no longer exists). Replace `default` with a neutral foreground-on-background style; add `accent` for honey-filled primary CTAs; drop `secondary` (the token is gone).

- [ ] **Step 1: Replace `apps/web/src/components/ui/button.tsx` in full**

```tsx
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] text-sm font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-foreground text-background hover:bg-foreground/90',
        accent: 'bg-accent text-accent-foreground hover:bg-accent/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-input bg-background hover:bg-card-hover hover:text-foreground',
        ghost: 'hover:bg-card-hover hover:text-foreground',
        link: 'text-accent underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-7 rounded-[var(--radius)] px-2.5 text-xs',
        default: 'h-8 px-3 py-1.5',
        lg: 'h-9 rounded-[var(--radius)] px-4',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
```

- [ ] **Step 2: Find consumers using `variant="secondary"` and migrate**

```bash
grep -rn 'variant="secondary"' apps/web/src --include="*.tsx" | grep -i button
```

For each match (if any), replace `variant="secondary"` with `variant="outline"` — the visual outcome is similar (subtle button) and `outline` survives the re-skin.

- [ ] **Step 3: Find consumers relying on the old `default` blue button**

```bash
grep -rn '<Button' apps/web/src --include="*.tsx" | grep -v 'variant='
```

These use the default variant. The new `default` is neutral (high-contrast foreground fill). For the primary "+ Add cluster" CTA and similar, switch to `accent`:

```bash
grep -rn '<Button' apps/web/src --include="*.tsx" -A 2 | grep -B 1 -i 'add cluster\|create\|save\|submit'
```

Audit each result. Convert the primary CTA on each page to `<Button variant="accent">…</Button>`. Examples expected:

- `apps/web/src/routes/clusters.index.tsx` — "+ Add cluster" → `accent`
- `apps/web/src/routes/clusters.new.tsx` — submit/save buttons → `accent`
- `apps/web/src/components/form/confirm-dialog.tsx` — primary confirm → `accent` (or `destructive` if it's a delete confirm — preserve existing semantics)

There should be one `accent` button per view at most.

- [ ] **Step 4: Run typecheck + lint + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web test
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/button.tsx apps/web/src/routes apps/web/src/components/form
git commit -m "feat(web): button — drop primary, add accent (honey) variant, tighter heights"
```

---

## Task 5: Re-skin `Card` (drop shadow, new radius)

**Files:**

- Modify: `apps/web/src/components/ui/card.tsx`

- [ ] **Step 1: Replace `apps/web/src/components/ui/card.tsx` in full**

```tsx
import * as React from 'react';

import { cn } from '@/lib/utils';

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-[var(--radius-card)] border border-border bg-card text-card-foreground',
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col gap-1 p-3.5', className)} {...props} />
  ),
);
CardHeader.displayName = 'CardHeader';

export const CardTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn('text-sm font-semibold leading-none tracking-tight', className)}
    {...props}
  />
));
CardTitle.displayName = 'CardTitle';

export const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn('text-xs text-fg-muted', className)} {...props} />
));
CardDescription.displayName = 'CardDescription';

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('p-3.5 pt-0', className)} {...props} />
  ),
);
CardContent.displayName = 'CardContent';

export const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center p-3.5 pt-0', className)} {...props} />
  ),
);
CardFooter.displayName = 'CardFooter';
```

Changes: drop `shadow-[var(--shadow-card)]`, swap `rounded-xl` → `rounded-[var(--radius-card)]` (8px), drop `text-muted-foreground` in favor of `text-fg-muted`, tighten header/content/footer padding from `p-4` to `p-3.5` (14px).

- [ ] **Step 2: Run typecheck + lint + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web test
```

Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/card.tsx
git commit -m "feat(web): card — flat surface, 8px radius, 14px padding"
```

---

## Task 6: Re-skin `Badge` (drop `*-strong` tokens; rationed variants)

**Files:**

- Modify: `apps/web/src/components/ui/badge.tsx`

The new Badge has five variants: `default` (neutral solid), `accent` (honey soft), `success`/`warning`/`danger` (soft fills using `--accent-soft`-style alpha tints), and `outline`. Drops `primary`/`secondary`/`destructive` solid variants (no consumers after Task 4).

- [ ] **Step 1: Replace `apps/web/src/components/ui/badge.tsx` in full**

```tsx
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-[var(--radius)] border px-2 py-0.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  {
    variants: {
      variant: {
        default: 'border-border bg-muted text-foreground',
        accent: 'border-transparent bg-accent-soft text-accent',
        outline: 'border-border text-fg-muted',
        success: 'border-success/30 bg-success/10 text-success',
        warning: 'border-warning/30 bg-warning/10 text-warning',
        danger: 'border-destructive/30 bg-destructive/10 text-destructive',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

const dotColor: Record<NonNullable<VariantProps<typeof badgeVariants>['variant']>, string> = {
  default: 'bg-fg-muted',
  accent: 'bg-accent',
  outline: 'bg-fg-subtle',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
};

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  dot?: boolean;
}

export function Badge({
  className,
  variant,
  dot,
  children,
  ...props
}: BadgeProps): React.JSX.Element {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot ? (
        <span
          aria-hidden
          className={cn('h-1.5 w-1.5 rounded-full', dotColor[variant ?? 'default'])}
        />
      ) : null}
      {children}
    </span>
  );
}
```

- [ ] **Step 2: Find consumers using removed `Badge variant="secondary"` or `"destructive"`**

```bash
grep -rn '<Badge[^>]*variant="\(secondary\|destructive\)"' apps/web/src --include="*.tsx"
```

For each match: `variant="secondary"` → `variant="default"`; `variant="destructive"` → `variant="danger"`.

- [ ] **Step 3: Run typecheck + lint + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web test
```

Expected: PASS. The `runway-pill.test.tsx` asserts that the className matches `/success/`, `/warning/`, `/destructive/` — `success` and `warning` still match (variant names unchanged); `destructive` becomes `danger`, so the test substring still matches because `bg-destructive/10` is in the className for the `danger` variant.

If the runway-pill test fails on the `/destructive/` assertion, update the assertion to `/danger/` (the variant name is the source of truth, not the class).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ui/badge.tsx apps/web/src
git commit -m "feat(web): badge — soft fills, rationed accent variant, drop legacy primary/secondary"
```

---

## Task 7: Re-skin `Input` + `Select`

**Files:**

- Modify: `apps/web/src/components/ui/input.tsx`
- Modify: `apps/web/src/components/ui/select.tsx`

- [ ] **Step 1: Read both files to capture the current API**

```bash
cat apps/web/src/components/ui/input.tsx
cat apps/web/src/components/ui/select.tsx
```

The API surface (props, exports, forwardRef pattern) must not change — only Tailwind classes do.

- [ ] **Step 2: Update `Input`**

Open `apps/web/src/components/ui/input.tsx`. In the className string passed to `<input>`, swap to:

```
flex h-8 w-full rounded-[var(--radius)] border border-input bg-background px-2.5 py-1 text-sm transition-colors placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50
```

Notable changes: height `h-8` (was likely `h-9` or `h-10`), radius via custom property, `ring-1` instead of `ring-2` for a tighter focus ring (1px honey).

- [ ] **Step 3: Update `Select`**

Open `apps/web/src/components/ui/select.tsx`. Update:

- `SelectTrigger` className → match the new `Input` shell (`h-8 rounded-[var(--radius)] border border-input bg-background px-2.5 py-1 text-sm ring-1 focus:ring-ring`).
- `SelectContent` className → `rounded-[var(--radius-card)] border border-border bg-popover shadow-[var(--overlay-shadow)]` (popover gets the overlay shadow).
- `SelectItem` hover → `focus:bg-card-hover focus:text-foreground` (was `focus:bg-accent`).

- [ ] **Step 4: Run typecheck + lint + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/input.tsx apps/web/src/components/ui/select.tsx
git commit -m "feat(web): inputs + select — flat, 6px radius, 1px honey focus ring"
```

---

## Task 8: Re-skin `Table` + `Tabs`

**Files:**

- Modify: `apps/web/src/components/ui/table.tsx`
- Modify: `apps/web/src/components/ui/tabs.tsx`

- [ ] **Step 1: Update `Table`**

Open `apps/web/src/components/ui/table.tsx`. Set:

- `Table`: keep the outer wrapper but ensure `w-full text-sm caption-bottom`.
- `TableHeader`: `border-b border-border text-xs uppercase tracking-wider text-fg-subtle font-medium`.
- `TableRow`: `border-b border-border h-9 transition-colors hover:bg-card-hover data-[state=selected]:bg-muted`.
- `TableHead`: `h-9 px-3 text-left align-middle text-xs font-medium text-fg-subtle`.
- `TableCell`: `px-3 py-2 align-middle text-sm`.

(`h-9` ≈ 36px row height.)

- [ ] **Step 2: Update `Tabs`**

Open `apps/web/src/components/ui/tabs.tsx`. Change `TabsList` and `TabsTrigger`:

- `TabsList`: `inline-flex h-9 items-center justify-center gap-4 border-b border-border` (drop background pill; tabs become an underline group).
- `TabsTrigger`: `inline-flex h-9 items-center justify-center whitespace-nowrap border-b-2 border-transparent px-1 text-sm font-medium text-fg-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:text-foreground data-[state=active]:border-accent data-[state=active]:text-foreground`.

(Active tab gets 2px honey underline + full-contrast text; inactive tabs are muted.)

- [ ] **Step 3: Run typecheck + lint + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ui/table.tsx apps/web/src/components/ui/tabs.tsx
git commit -m "feat(web): table 36px rows, tabs underline-active"
```

---

## Task 9: Re-skin overlay primitives (`Tooltip`, `Dialog`, `Sheet`)

**Files:**

- Modify: `apps/web/src/components/ui/tooltip.tsx`
- Modify: `apps/web/src/components/ui/dialog.tsx`
- Modify: `apps/web/src/components/ui/sheet.tsx`

Overlays are the ONLY surfaces that keep a shadow in the new system. All three consume `--overlay-shadow` from styles.css.

- [ ] **Step 1: Update `Tooltip`**

Open `apps/web/src/components/ui/tooltip.tsx`. In the `TooltipContent` className, set:

```
z-50 overflow-hidden rounded-[var(--radius-card)] border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-[var(--overlay-shadow)] animate-in fade-in-0 zoom-in-95
```

Drop any `backdrop-blur` or `bg-popover/N` opacity (solid only).

- [ ] **Step 2: Update `Dialog`**

Open `apps/web/src/components/ui/dialog.tsx`. In `DialogContent` className, set:

```
fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border border-border bg-popover p-6 shadow-[var(--overlay-shadow)] duration-200 rounded-[var(--radius-modal)]
```

In `DialogOverlay`: `fixed inset-0 z-50 bg-black/50 backdrop-blur-none` (drop any blur; use a solid scrim).

- [ ] **Step 3: Update `Sheet`**

Open `apps/web/src/components/ui/sheet.tsx`. In `SheetContent` className, set the surface to:

```
fixed z-50 gap-4 bg-popover border-r border-border shadow-[var(--overlay-shadow)] transition ease-in-out
```

(Adapt the side variants — left/right/top/bottom — that already exist in the file; only the surface, border, and shadow tokens change.)

In `SheetOverlay` (if present): `fixed inset-0 z-50 bg-black/50`.

- [ ] **Step 4: Run typecheck + lint + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web test
```

Expected: PASS. `sheet.test.tsx` asserts structural behavior (open/close), not styling.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/tooltip.tsx apps/web/src/components/ui/dialog.tsx apps/web/src/components/ui/sheet.tsx
git commit -m "feat(web): overlays — solid surfaces with overlay shadow, modal radius"
```

---

## Task 10: Re-skin `RunwayPill` + `UtilizationGauge`

**Files:**

- Modify: `apps/web/src/components/ui/runway-pill.tsx`
- Modify: `apps/web/src/components/ui/runway-pill.test.tsx`
- Modify: `apps/web/src/components/ui/utilization-gauge.tsx`

`RunwayPill` swaps its no-breach `success` variant to `accent` (honey), reflecting the headline-metric rule. `UtilizationGauge` keeps its threshold logic but `ok` band uses `--fg-muted` (gray) instead of `--success` (green) — the "healthy = quiet" rule.

- [ ] **Step 1: Update `runway-pill.test.tsx` to assert the new accent variant on no-breach**

Find:

```ts
it('renders months until warn with a success variant when >= 12', () => {
    render(<RunwayPill summary={{ months: 18, alreadyBreached: false }} />);
    const pill = screen.getByText(/18 mo to 70%/i);
    expect(pill).toBeInTheDocument();
    expect(pill.parentElement?.className).toMatch(/success/);
  });
```

Replace with:

```ts
it('renders months until warn with an accent variant when >= 12', () => {
    render(<RunwayPill summary={{ months: 18, alreadyBreached: false }} />);
    const pill = screen.getByText(/18 mo to 70%/i);
    expect(pill).toBeInTheDocument();
    expect(pill.parentElement?.className).toMatch(/accent/);
  });
```

Find:

```ts
it('shows the horizon hint with a "+" when there is no projected breach', () => {
    render(<RunwayPill summary={{ months: null, alreadyBreached: false }} horizonMonths={24} />);
    expect(screen.getByText(/24\+ mo/i)).toBeInTheDocument();
  });
```

Add an assertion that the badge class matches `/accent/`:

```ts
it('shows the horizon hint with a "+" and accent variant when there is no projected breach', () => {
    render(<RunwayPill summary={{ months: null, alreadyBreached: false }} horizonMonths={24} />);
    const pill = screen.getByText(/24\+ mo/i);
    expect(pill).toBeInTheDocument();
    expect(pill.parentElement?.className).toMatch(/accent/);
  });
```

Find:

```ts
it('uses the red variant when months < 3', () => {
    render(<RunwayPill summary={{ months: 2, alreadyBreached: false }} />);
    const pill = screen.getByText(/2 mo to 70%/i);
    expect(pill.parentElement?.className).toMatch(/destructive/);
  });
```

Update the regex match because Task 6 renamed the variant from `destructive` to `danger`:

```ts
it('uses the danger variant when months < 3', () => {
    render(<RunwayPill summary={{ months: 2, alreadyBreached: false }} />);
    const pill = screen.getByText(/2 mo to 70%/i);
    expect(pill.parentElement?.className).toMatch(/danger/);
  });
```

Apply the same `/destructive/` → `/danger/` fix in any other `RunwayPill` assertion in the file.

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @lcm/web test runway-pill
```

Expected: FAIL — `RunwayPill` still uses `variant="success"` for the no-breach branch.

- [ ] **Step 3: Update `RunwayPill` source**

In `apps/web/src/components/ui/runway-pill.tsx`, find:

```tsx
if (summary.months === null) {
  return (
    <Badge variant="success">
      <span>
        {horizonMonths !== undefined && horizonMonths > 0
          ? `${horizonMonths}+ mo`
          : 'No breach in horizon'}
      </span>
    </Badge>
  );
}
const variant = summary.months < 3 ? 'danger' : summary.months < 12 ? 'warning' : 'success';
```

Replace with:

```tsx
if (summary.months === null) {
  return (
    <Badge variant="accent">
      <span>
        {horizonMonths !== undefined && horizonMonths > 0
          ? `${horizonMonths}+ mo`
          : 'No breach in horizon'}
      </span>
    </Badge>
  );
}
const variant = summary.months < 3 ? 'danger' : summary.months < 12 ? 'warning' : 'accent';
```

(Both the no-breach branch and the `>= 12 months` branch get the honey accent — they mean "no concern within the forecast horizon," which is exactly the attention/headline case.)

Also update the `alreadyBreached === 'crit'` branch:

```tsx
if (summary.alreadyBreached === 'crit') {
  return (
    <Badge variant="danger">
      <span>Over 90%</span>
    </Badge>
  );
}
```

This is already correct (Badge variant `danger` exists per Task 6).

- [ ] **Step 4: Update `UtilizationGauge`**

In `apps/web/src/components/ui/utilization-gauge.tsx`, find:

```ts
const FILL: Record<'ok' | 'warning' | 'critical', string> = {
  ok: 'var(--success)',
  warning: 'var(--warning)',
  critical: 'var(--destructive)',
};
```

Replace with:

```ts
const FILL: Record<'ok' | 'warning' | 'critical', string> = {
  ok: 'var(--fg-muted)',
  warning: 'var(--warning)',
  critical: 'var(--destructive)',
};
```

The healthy state goes gray, not green — only color when something needs attention.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @lcm/web test runway-pill
pnpm --filter @lcm/web test utilization-gauge
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ui/runway-pill.tsx apps/web/src/components/ui/runway-pill.test.tsx apps/web/src/components/ui/utilization-gauge.tsx
git commit -m "feat(web): runway pill uses honey accent for no-breach; gauge ok state goes quiet"
```

---

## Task 11: Re-skin `KpiTile` (mono numerals, left accent bar, attention status)

**Files:**

- Modify: `apps/web/src/components/overview/kpi-tile.tsx`
- Create or modify: `apps/web/src/components/overview/kpi-tile.test.tsx`

Numeric value renders in JetBrains Mono. The tile gains a 2px left accent bar when status is `attention/warn/crit` — visually marks the headline metric without needing a separate component.

- [ ] **Step 1: Add (or extend) `kpi-tile.test.tsx`**

If `apps/web/src/components/overview/kpi-tile.test.tsx` doesn't exist, create it:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { KpiTile } from './kpi-tile';

describe('<KpiTile>', () => {
  it('renders the value in monospace and shows an accent bar for attention status', () => {
    const { container } = render(
      <KpiTile
        label="Fleet runway"
        value="14 mo"
        status="attention"
        caption="no projected breach"
      />,
    );
    expect(screen.getByText('14 mo')).toHaveClass('font-mono');
    const root = container.firstChild as HTMLElement;
    expect(root.className).toMatch(/border-l/);
    expect(root.className).toMatch(/border-accent/);
  });

  it('omits the accent bar for ok status', () => {
    const { container } = render(<KpiTile label="Clusters" value="8" status="ok" />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).not.toMatch(/border-l-2/);
  });

  it('uses the warning accent bar for warn status', () => {
    const { container } = render(<KpiTile label="Util" value="78%" status="warn" />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toMatch(/border-warning/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @lcm/web test kpi-tile
```

Expected: FAIL — current `KpiTile` doesn't render in mono and doesn't add a left border.

- [ ] **Step 3: Replace `apps/web/src/components/overview/kpi-tile.tsx` in full**

```tsx
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const tileVariants = cva('p-3.5 transition-colors', {
  variants: {
    status: {
      ok: '',
      attention: 'border-l-2 border-l-accent',
      warn: 'border-l-2 border-l-warning',
      crit: 'border-l-2 border-l-destructive',
    },
  },
  defaultVariants: { status: 'ok' },
});

export interface KpiTileProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof tileVariants> {
  label: string;
  value: string;
  caption?: string;
}

export function KpiTile({
  label,
  value,
  caption,
  status,
  className,
  ...props
}: KpiTileProps): React.JSX.Element {
  return (
    <Card className={cn(tileVariants({ status }), className)} {...props}>
      <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">{label}</p>
      <p className="mt-2 font-mono text-xl font-medium tracking-tight tabular-nums text-foreground [overflow-wrap:anywhere] sm:text-2xl">
        {value}
      </p>
      {caption ? (
        <p className="mt-1.5 text-[11px] text-fg-muted [overflow-wrap:anywhere]">{caption}</p>
      ) : null}
    </Card>
  );
}
```

Changes:

- `Card` now provides the surface (flat per Task 5); tile adds the left accent bar via CVA based on `status`.
- Label uses 10px uppercase tracked (matches the `label` token).
- Value uses `font-mono` + `tabular-nums` for aligned numerals.
- Caption uses 11px (matches the `caption` token).
- Drops the `dotVariants` import — the left bar replaces the dot.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @lcm/web test kpi-tile
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/overview/kpi-tile.tsx apps/web/src/components/overview/kpi-tile.test.tsx
git commit -m "feat(web): KpiTile — mono numerals, left accent bar for headline metric"
```

---

## Task 12: Re-skin `ClusterTile` + `FleetCapacityChart`

**Files:**

- Modify: `apps/web/src/components/overview/cluster-tile.tsx`
- Modify: `apps/web/src/components/overview/fleet-capacity-chart.tsx`

ClusterTile becomes a flat compact card (mono numerals on the used/cap pair). FleetCapacityChart re-themes via the rewritten `useChartColors` and adds a hover-to-focus interaction: hovering a cluster line promotes it to honey (`--accent`), while the others stay in the grayscale palette.

- [ ] **Step 1: Update `ClusterTile`**

Open `apps/web/src/components/overview/cluster-tile.tsx`. Key changes:

- The "used / capacity" label should use `font-mono tabular-nums text-foreground` instead of generic body text.
- Drop any `shadow-` classes.
- Reduce inner padding to match the new card scale (`p-3.5`).
- Use `text-fg-subtle` for the cluster name eyebrow if present, `text-h2` (16px) weight 600 for the cluster name itself, mono for the gauge numerals (already mono via `UtilizationGauge`).

Read the existing file first:

```bash
cat apps/web/src/components/overview/cluster-tile.tsx
```

Adjust class strings inline. The component shape and exports don't change.

- [ ] **Step 2: Run the cluster-tile test (snapshot of structural behavior)**

```bash
pnpm --filter @lcm/web test cluster-tile
```

Expected: PASS. The test asserts text content (`"400 / 1,000 GB"`, role `img`, link href), not styling, so visual changes don't break it.

- [ ] **Step 3: Update `FleetCapacityChart` — re-theme + hover-to-focus**

Open `apps/web/src/components/overview/fleet-capacity-chart.tsx`. The component renders a multi-cluster chart using Recharts. Two changes:

(a) Wire `useChartColors()` output to series colors. Each cluster's `<Line>` should pick its color from `colors.clusterPalette[i % colors.clusterPalette.length]`.

(b) Add hover-to-focus: track which cluster is hovered (component state `const [focusedCluster, setFocusedCluster] = useState<string | null>(null)`). Use Recharts' `onMouseEnter`/`onMouseLeave` on each `<Line>`. When a cluster is focused, override that line's `stroke` to `colors.consumption` (honey) and bump `strokeWidth` by 1; non-focused lines stay in palette gray. The chart's `<Legend onMouseEnter onMouseLeave>` should mirror the same behavior.

Add reference lines for the 70% warn and 90% crit thresholds using Recharts' `<ReferenceLine>` component with `stroke={colors.grid}` and `strokeDasharray="4 4"`:

```tsx
<ReferenceLine y={0.7} stroke={colors.grid} strokeDasharray="4 4" />
<ReferenceLine y={0.9} stroke={colors.grid} strokeDasharray="4 4" />
```

(Only render if the chart's Y axis is in utilization units; if it's in absolute consumption units, drop these — they don't apply.)

- [ ] **Step 4: Run typecheck + lint + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/overview/cluster-tile.tsx apps/web/src/components/overview/fleet-capacity-chart.tsx
git commit -m "feat(web): overview chart — grayscale series, hover-to-focus honey, dashed thresholds"
```

---

## Task 13: Re-skin cluster-detail charts

**Files:**

- Modify: `apps/web/src/components/clusters/forecast-chart.tsx`
- Modify: `apps/web/src/components/clusters/utilization-panel.tsx`

These are single-series charts (per-cluster). The single series picks up honey automatically via `colors.consumption` (rewritten in Task 3). Surrounding panel surfaces flatten via the new `Card` (Task 5). The work in this task is verifying the existing components consume the new colors cleanly and adding any reference-line touches.

- [ ] **Step 1: Read both files**

```bash
cat apps/web/src/components/clusters/forecast-chart.tsx
cat apps/web/src/components/clusters/utilization-panel.tsx
```

- [ ] **Step 2: Update `forecast-chart.tsx`**

The chart already consumes `useChartColors()`. After Task 3's rewrite, `colors.consumption` is honey and `colors.capacity` is red. Verify:

- The consumption line uses `stroke={colors.consumption}`.
- The capacity ceiling uses `stroke={colors.capacity}`.
- Axes use `stroke={colors.axis}`.
- Grid uses `stroke={colors.grid}`.

Add (if missing) reference lines at the 70% warn and 90% crit thresholds when the chart is in utilization view:

```tsx
<ReferenceLine y={0.7} stroke={colors.grid} strokeDasharray="4 4" />
<ReferenceLine y={0.9} stroke={colors.grid} strokeDasharray="4 4" />
```

- [ ] **Step 3: Update `utilization-panel.tsx`**

Flatten any nested cards/panels. Drop `shadow-` classes. Use `text-fg-muted` and `text-fg-subtle` instead of `text-muted-foreground` where the new tokens read better. Replace any hard-coded threshold colors with `colors.utilizationOk/Warn/Crit`.

- [ ] **Step 4: Run typecheck + lint + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/clusters/forecast-chart.tsx apps/web/src/components/clusters/utilization-panel.tsx
git commit -m "feat(web): cluster detail charts — honey forecast, dashed thresholds"
```

---

## Task 14: Re-skin `app-shell` (header) + `sidebar`

**Files:**

- Modify: `apps/web/src/components/layout/app-shell.tsx`
- Modify: `apps/web/src/components/layout/sidebar.tsx`

The shell drops the gradient logo, drops `backdrop-blur-xl` from header and sidebar (solid surfaces with borders only), and switches the active sidebar item to a 2px honey left border.

- [ ] **Step 1: Update the header logo + remove backdrop blur in `app-shell.tsx`**

Open `apps/web/src/components/layout/app-shell.tsx`. Find:

```tsx
<header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-card/70 px-4 backdrop-blur-xl sm:gap-4">
```

Replace with:

```tsx
<header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-4 sm:gap-4">
```

Find:

```tsx
<span
  aria-hidden
  className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/70 shadow-[var(--shadow-card)]"
>
  <Activity className="h-4 w-4 text-primary-foreground" />
</span>
```

Replace with:

```tsx
<span
  aria-hidden
  className="flex h-7 w-7 items-center justify-center rounded-[var(--radius)] bg-accent"
>
  <Activity className="h-4 w-4 text-accent-foreground" />
</span>
```

- [ ] **Step 2: Update sidebar in `sidebar.tsx`**

Open `apps/web/src/components/layout/sidebar.tsx`. Find:

```tsx
<aside
      className={cn(
        'hidden shrink-0 flex-col border-r border-border bg-card/60 backdrop-blur-xl transition-[width] duration-150 ease-out lg:flex',
        collapsed ? 'w-16' : 'w-60',
      )}
      aria-label="Primary navigation"
    >
```

Replace with:

```tsx
<aside
      className={cn(
        'hidden shrink-0 flex-col border-r border-border bg-background transition-[width] duration-150 ease-out lg:flex',
        collapsed ? 'w-16' : 'w-60',
      )}
      aria-label="Primary navigation"
    >
```

Find the active-route className:

```tsx
activeProps={{
                className: 'bg-muted text-foreground shadow-[inset_3px_0_0_0_var(--primary)]',
              }}
```

Replace with:

```tsx
activeProps={{
                className: 'text-foreground border-l-2 border-l-accent bg-card-hover',
              }}
```

Drop the inset shadow approach; the active item now has a flat 2px honey left border + subtle hover-state background tint for emphasis.

- [ ] **Step 3: Update mobile sheet sidebar in `mobile-nav.tsx` (if it inherits styles)**

```bash
cat apps/web/src/components/layout/mobile-nav.tsx
```

The sheet wraps `SidebarNav` (from `sidebar.tsx`) — so the active-item style fix in Step 2 applies automatically. No further changes unless the file references `bg-card/N` or `backdrop-blur` directly.

- [ ] **Step 4: Run typecheck + lint + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web test
```

Expected: PASS. `mobile-nav.test.tsx` asserts the trigger button presence + open/close behavior; styling doesn't affect those.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/layout/app-shell.tsx apps/web/src/components/layout/sidebar.tsx apps/web/src/components/layout/mobile-nav.tsx
git commit -m "feat(web): shell — solid surfaces, flat honey logo, 2px honey active nav"
```

---

## Task 15: Route-level token cascade + final visual verification

**Files:**

- Modify: `apps/web/src/routes/index.tsx` (eyebrow + display H1)
- Audit + light-touch: `apps/web/src/routes/clusters.index.tsx`, `clusters.$id.tsx`, `clusters.new.tsx`, `settings.tsx`
- Audit + light-touch: `apps/web/src/components/clusters/cluster-list-card.tsx`, `cluster-table.tsx`

This task locks in route-level type consistency (eyebrow labels, display H1) and walks every page in Playwright to catch leftover `bg-card/N`, `backdrop-blur`, `--primary`, `--shadow-card`, or `bg-primary` references that the earlier tasks missed.

- [ ] **Step 1: Update `routes/index.tsx` header**

Find:

```tsx
<header>
  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
    Overview
  </p>
  <h1 className="text-[1.625rem] font-semibold tracking-tight">Fleet</h1>
</header>
```

Replace with:

```tsx
<header>
  <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
    Capacity Forecast
  </p>
  <h1 className="mt-1 text-[26px] font-semibold leading-[1.1] tracking-[-0.02em]">Fleet</h1>
</header>
```

(Eyebrow label updated per spec; H1 keeps the 26px display size.)

- [ ] **Step 2: Apply the same eyebrow + display H1 pattern to `clusters.index.tsx`**

Find the page header (whatever it is) and use the same pattern:

```tsx
<header>
  <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
    Capacity Forecast
  </p>
  <h1 className="mt-1 text-[26px] font-semibold leading-[1.1] tracking-[-0.02em]">Clusters</h1>
</header>
```

Repeat for `clusters.$id.tsx` (eyebrow: "Cluster"), `clusters.new.tsx` (eyebrow: "Cluster", H1: "Add cluster"), and `settings.tsx` (eyebrow: "Configuration", H1: "Settings").

- [ ] **Step 3: Audit for leftover dropped tokens**

```bash
grep -rn 'bg-card/[0-9]\|backdrop-blur\|var(--shadow-card)\|var(--primary)\|bg-primary\|text-primary\|--success-strong\|--warning-strong\|--destructive-strong' apps/web/src --include="*.tsx" --include="*.ts" --include="*.css"
```

Expected output: **zero matches** in `*.tsx`/`*.ts`, only the original `styles.css` line in Task 1 (which removed all of these). If the grep returns hits, fix each one:

- `bg-card/N` → `bg-background` (header/sidebar) or `bg-card` (regular cards)
- `backdrop-blur*` → remove the class
- `var(--shadow-card)` → remove; if it was on a card, drop the shadow entirely; if it was on an overlay, switch to `shadow-[var(--overlay-shadow)]`
- `bg-primary` / `text-primary` → `bg-accent` / `text-accent` if it was a CTA / focused state; otherwise `bg-foreground` / `text-foreground`
- `*-strong` tokens → drop the `-strong` suffix; the new badges use soft fills directly

- [ ] **Step 4: Tighten the overview grid gap (per spec §3 density)**

In `apps/web/src/routes/index.tsx`, find:

```tsx
<div className="grid grid-cols-12 gap-4">
```

Replace with:

```tsx
<div className="grid grid-cols-12 gap-2">
```

(8px gap — tiles read as a continuous data surface.)

Repeat for the loading-skeleton grid in the same file.

- [ ] **Step 5: Run full test suite + typecheck + lint**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web test
```

Expected: all PASS.

- [ ] **Step 6: Run e2e tests**

```bash
pnpm --filter @lcm/web test:e2e
```

Expected: PASS. Playwright tests verify structure and key interactions, not pixel color, so the re-skin shouldn't break them.

- [ ] **Step 7: Visual verification in Playwright (manual)**

Start the dev server and walk each route in both themes at 1440×900 and 390×844:

```bash
pnpm --filter @lcm/web dev
```

Open `http://localhost:5173` and verify on each route:

- **Header:** flat honey square logo (no gradient), no `backdrop-blur` haze, solid background, bottom border visible.
- **Sidebar (desktop):** solid background, no haze, active nav item has 2px honey left border + subtle hover-tint background.
- **Sidebar (mobile drawer):** opens via `<MobileNavTrigger>`, same active-state styling as desktop, overlay scrim is solid (no blur).
- **Overview page:** eyebrow "Capacity Forecast" in 10px uppercase tracked; H1 "Fleet" at 26px; three KPI tiles in a tight 8px-gap grid; fleet runway tile has a 2px honey left bar (`attention` status); other tiles have no left bar; fleet chart shows grayscale cluster lines with one honey line on hover; dashed reference lines at 70%/90% if utilization view.
- **Clusters list:** dense rows (~36px tall), no card shadow, hover row background visible.
- **Cluster detail:** forecast chart line is honey; capacity ceiling line is red; dashed grid reference lines visible; gauge ring goes gray when healthy.
- **Cluster create form:** inputs are flat with 1px honey focus ring; submit button is honey (`accent` variant).
- **Settings:** form inputs render under new tokens without layout breakage.
- **Toggle theme:** every page works in both light and dark; honey reads correctly in both (light = darker `#8a6016`, dark = vibrant `#f9c74f`).
- **Reduced motion:** in browser DevTools, enable "prefers-reduced-motion: reduce" — confirm no transitions fire.

If anything's broken visually, fix it inline and re-verify.

- [ ] **Step 8: Take screenshots for the PR description**

```bash
mkdir -p .superpowers/screenshots
```

Take Playwright screenshots (via the browser's Page → Save) at each viewport+theme combo:

- `overview-light-desktop.png` (1440×900)
- `overview-dark-desktop.png`
- `overview-mobile.png` (390×844)
- `clusters-list-dark-desktop.png`
- `cluster-detail-dark-desktop.png`

(These don't need to be committed — they're for the PR body.)

- [ ] **Step 9: Final commit + PR**

```bash
git add apps/web/src/routes
git commit -m "feat(web): route headers — eyebrow labels + display H1; tighten overview grid"
git push -u origin honey-operator-console
```

Open a PR with the spec link and the screenshots attached.

```bash
gh pr create --title "feat(web): graphite + honey operator console" --body "$(cat <<'EOF'
## Summary
- Operator-console redesign: pure-neutral surfaces, honey accent rationed to headline metric / focused chart / active nav / primary CTAs, monospace numerals on all data, flat surfaces with razor-thin borders, no shadows on cards.
- Drops generic blue primary, gradient logo, header/sidebar backdrop blur, `oklch()` neutrals.
- Adds `KpiStatus = UtilStatus | 'attention'` for the headline-metric marker.
- Rewrites chart palette to grayscale-with-honey-on-focus.

Spec: `docs/superpowers/specs/2026-05-24-graphite-honey-operator-console-design.md`

## Test plan
- [ ] `pnpm --filter @lcm/web typecheck` green
- [ ] `pnpm --filter @lcm/web lint` green
- [ ] `pnpm --filter @lcm/web test` green (includes snapshot updates for runway-pill + kpi-tile)
- [ ] `pnpm --filter @lcm/web test:e2e` green
- [ ] Manual visual check at 1440×900 and 390×844 in both light and dark themes — every page from spec §5 verified
- [ ] Reduced-motion preference disables all transitions

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Definition of done

- All 15 tasks complete and committed.
- `pnpm --filter @lcm/web typecheck`, `lint`, `test`, and `test:e2e` all green.
- Manual visual verification per Task 15 Step 7 confirms every spec checklist item.
- PR open with the spec link and screenshots in the body.
- Grep audit (Task 15 Step 3) returns zero matches for dropped tokens in `*.tsx`/`*.ts` files.
- The fleet runway tile on the overview reads in honey (`attention`) when there's no breach, amber (`warn`) within forecast horizon, red (`crit`) when breached — only ONE honey accent visible on the page at a time.
