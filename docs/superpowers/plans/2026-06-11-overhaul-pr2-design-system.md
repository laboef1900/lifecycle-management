# Overhaul PR 2 — Design System Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land Phase 1's foundation (spec: `docs/superpowers/specs/2026-06-10-app-overhaul-design.md`): Refined Premium tokens, working overlay animations, motion infrastructure, sonner 2, the monolithic `radix-ui` migration, restyled core primitives, and the new primitives later PRs build on. App shell + screen redesigns are PR 3+.

**Architecture:** All work in `apps/web` (plus one line in `packages/shared/package.json`). Token values change inside existing CSS variable names, so most components restyle "for free"; component code changes are surgical. New primitives are standalone files under `src/components/ui/`.

**Tech Stack:** Tailwind v4 (CSS-first `@theme`), `tw-animate-css`, monolithic `radix-ui@^1.5`, `motion@^12` (LazyMotion + `domAnimation`), `sonner@^2`, cva.

**Branch:** `feat/overhaul-2-design-system` off `main`.

**Ground-truth notes (verified against the codebase on 2026-06-11):**

- The ui kit is ALREADY half-Radix: dialog, select, tabs, tooltip, sheet (via Dialog), and button's Slot use individual `@radix-ui/react-*` packages; `cva`/`clsx`/`tailwind-merge`/`cmdk` are present.
- `toaster.tsx` already wraps sonner 1.x (5 lines, mounted in `app.tsx`); the task is bump-to-2 + theming, NOT a replacement (the spec's original wording is amended alongside this plan).
- **The `animate-in`/`fade-in-0`/`zoom-in-95`/`slide-in-from-*` classes in dialog/select/tooltip/sheet are currently INERT** — no animate plugin exists in the repo, Tailwind v4 ignores them. Task 2 makes them real.
- Spec deviation (deliberate): `ProgressRing` stays `utilization-gauge.tsx` (restyled in place); rename deferred until a second consumer needs a generic ring.
- 42 existing `toast.*` call sites must keep working unchanged (sonner 2 keeps the API).

**Verification before completion (every task):** run the listed commands and paste actual output before checking the box. `pnpm --filter @lcm/web test -- --run` denotes the full web suite (35 files / 201 tests at branch point).

---

### Task 1: Dependencies — monolithic radix-ui, motion, tw-animate-css, sonner 2

**Files:**

- Modify: `apps/web/package.json`
- Modify: `packages/shared/package.json`
- Modify: `apps/web/src/components/ui/button.tsx:1`
- Modify: `apps/web/src/components/ui/dialog.tsx:1`
- Modify: `apps/web/src/components/ui/select.tsx:1`
- Modify: `apps/web/src/components/ui/sheet.tsx:1`
- Modify: `apps/web/src/components/ui/tabs.tsx:1`
- Modify: `apps/web/src/components/ui/tooltip.tsx:1`
- Modify: `apps/web/src/components/command/command-palette.tsx` (import line)
- Modify: `apps/web/src/components/command/shortcuts-dialog.tsx` (import line)

- [ ] **Step 1: Swap dependencies in `apps/web/package.json`**

Remove these five lines from `dependencies`:

```json
    "@radix-ui/react-dialog": "^1.1.4",
    "@radix-ui/react-select": "^2.1.4",
    "@radix-ui/react-slot": "^1.1.1",
    "@radix-ui/react-tabs": "^1.1.2",
    "@radix-ui/react-tooltip": "^1.2.8",
```

Add (keeping alphabetical order):

```json
    "motion": "^12.0.0",
    "radix-ui": "^1.5.0",
```

Change `"sonner": "^1.7.1"` → `"sonner": "^2.0.0"`.

Add to `devDependencies`:

```json
    "tw-animate-css": "^1.0.0",
```

- [ ] **Step 2: Tree-shaking signal for the shared package**

In `packages/shared/package.json`, add at the top level (PR 1 review follow-up):

```json
  "sideEffects": false,
```

- [ ] **Step 3: Install**

Run: `pnpm install`
Expected: clean resolve. If sonner 2's peer range complains about anything, report it — do not force.

- [ ] **Step 4: Rewrite the eight import sites to the monolithic package**

Each file currently imports a namespace from an individual package; the monolithic package exports the same namespaces. Exact replacements (one line each):

| File                           | Old line                                                       | New line                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/button.tsx`                | `import { Slot } from '@radix-ui/react-slot';`                 | `import { Slot as SlotPrimitive } from 'radix-ui';` — and change the two usages: `const Comp = asChild ? SlotPrimitive.Root : 'button';` |
| `ui/dialog.tsx`                | `import * as DialogPrimitive from '@radix-ui/react-dialog';`   | `import { Dialog as DialogPrimitive } from 'radix-ui';`                                                                                  |
| `ui/sheet.tsx`                 | `import * as DialogPrimitive from '@radix-ui/react-dialog';`   | `import { Dialog as DialogPrimitive } from 'radix-ui';`                                                                                  |
| `ui/select.tsx`                | `import * as SelectPrimitive from '@radix-ui/react-select';`   | `import { Select as SelectPrimitive } from 'radix-ui';`                                                                                  |
| `ui/tabs.tsx`                  | `import * as TabsPrimitive from '@radix-ui/react-tabs';`       | `import { Tabs as TabsPrimitive } from 'radix-ui';`                                                                                      |
| `ui/tooltip.tsx`               | `import * as TooltipPrimitive from '@radix-ui/react-tooltip';` | `import { Tooltip as TooltipPrimitive } from 'radix-ui';`                                                                                |
| `command/command-palette.tsx`  | (find its `@radix-ui/react-dialog` import)                     | same `{ Dialog as DialogPrimitive }` form, keep local usage names                                                                        |
| `command/shortcuts-dialog.tsx` | (same)                                                         | (same)                                                                                                                                   |

Note: `React.ElementRef<typeof DialogPrimitive.Overlay>` etc. keep compiling unchanged because the namespace shape is identical. If a type error appears, paste it in your report before improvising.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @lcm/web exec tsc --noEmit && pnpm --filter @lcm/web test -- --run && pnpm --filter @lcm/web build`
Expected: all green (201 tests). The sonner 2 bump must not change any of the 42 `toast.*` call sites — if one breaks, report it.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json packages/shared/package.json pnpm-lock.yaml apps/web/src/components/ui apps/web/src/components/command
git commit -m "chore(web): monolithic radix-ui, motion, tw-animate-css, sonner 2; shared sideEffects flag"
```

---

### Task 2: Refined Premium tokens (full styles.css replacement)

**Files:**

- Modify: `apps/web/src/styles.css` (entire file)

- [ ] **Step 1: Replace `apps/web/src/styles.css` with:**

```css
@import 'tailwindcss';
@import 'tw-animate-css';
@import '@fontsource/ibm-plex-sans/400.css';
@import '@fontsource/ibm-plex-sans/500.css';
@import '@fontsource/ibm-plex-sans/600.css';
@import '@fontsource/ibm-plex-mono/400.css';
@import '@fontsource/ibm-plex-mono/500.css';

:root {
  --background: #fafaf9;
  --foreground: #1c1917;
  --card: #ffffff;
  --card-foreground: #1c1917;
  --card-hover: #f5f5f4;
  --popover: #ffffff;
  --popover-foreground: #1c1917;
  --muted: #f5f5f4;
  --fg-muted: #78716c;
  --muted-foreground: var(--fg-muted);
  --fg-subtle: #a8a29e;
  --sidebar: #fcfcfb;
  --border: #eeedec;
  --border-strong: #e7e5e4;
  --input: #e7e5e4;
  --ring: #a16207;
  --accent: #a16207;
  --accent-foreground: #ffffff;
  --accent-soft: color-mix(in oklab, var(--accent) 10%, transparent);
  --accent-gradient: linear-gradient(135deg, #a16207, #854d0e);
  --success: #16a34a;
  --success-foreground: #ffffff;
  --warning: #d97706;
  --warning-foreground: #ffffff;
  --destructive: #dc2626;
  --destructive-foreground: #ffffff;
  --radius: 8px;
  --radius-card: 12px;
  --radius-modal: 16px;
  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.04), 0 4px 12px rgba(0, 0, 0, 0.025);
  --shadow-card-hover: 0 2px 4px rgba(0, 0, 0, 0.05), 0 8px 24px rgba(0, 0, 0, 0.05);
  --overlay-shadow: 0 2px 4px rgba(0, 0, 0, 0.04), 0 12px 32px rgba(0, 0, 0, 0.1);
}

html.dark {
  --background: #171514;
  --foreground: #fafaf9;
  --card: #1f1d1b;
  --card-foreground: #fafaf9;
  --card-hover: #262321;
  --popover: #262321;
  --popover-foreground: #fafaf9;
  --muted: #2c2926;
  --fg-muted: #a8a29e;
  --muted-foreground: var(--fg-muted);
  --fg-subtle: #8a8580;
  --sidebar: #1b1918;
  --border: #2c2926;
  --border-strong: #3a3633;
  --input: #3a3633;
  --ring: #fbbf24;
  --accent: #fbbf24;
  --accent-foreground: #1c1917;
  --accent-soft: color-mix(in oklab, var(--accent) 15%, transparent);
  --accent-gradient: linear-gradient(135deg, #fbbf24, #d97706);
  --success: #4ade80;
  --success-foreground: #052e16;
  --warning: #f59e0b;
  --warning-foreground: #1c1917;
  --destructive: #f87171;
  --destructive-foreground: #450a0a;
  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.3), 0 4px 12px rgba(0, 0, 0, 0.2);
  --shadow-card-hover: 0 2px 4px rgba(0, 0, 0, 0.35), 0 8px 24px rgba(0, 0, 0, 0.3);
  --overlay-shadow: 0 2px 4px rgba(0, 0, 0, 0.3), 0 16px 40px rgba(0, 0, 0, 0.45);
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
  --color-sidebar: var(--sidebar);
  --color-border: var(--border);
  --color-border-strong: var(--border-strong);
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
  /* Radius/shadow tokens live in :root and are consumed via arbitrary values
     (rounded-[var(--radius-card)] etc.) — no @theme re-export, since
     `--x: var(--x)` inside @theme is a circular reference that invalidates
     the :root token. */
  /* Alias: exposed as shadow-overlay utility; the raw var is --overlay-shadow. */
  --shadow-overlay: var(--overlay-shadow);
  --font-sans: 'IBM Plex Sans', system-ui, sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, monospace;
  --text-display: 28px;
  --text-display--line-height: 1.1;
  --text-display--letter-spacing: -0.025em;
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
  --animate-shimmer: shimmer 1.8s ease-in-out infinite;

  @keyframes shimmer {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -200% 0;
    }
  }
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
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0s !important;
    /* Without this, infinite animations (e.g. Skeleton pulse) still loop at
       0s duration and can repaint every frame. */
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
  }
}
```

Key facts for review: all PRE-EXISTING variable names are kept (only values changed) so no component breaks; new names: `--sidebar`, `--border-strong`, `--accent-gradient`, `--shadow-card`, `--shadow-card-hover`, shimmer. `tw-animate-css` makes the kit's existing `animate-in/out` classes work for the first time.

- [ ] **Step 2: Verify**

Run: `pnpm --filter @lcm/web test -- --run && pnpm --filter @lcm/web build`
Expected: green. Then `pnpm dev`, open http://localhost:5173 in light AND dark: warm neutrals, gold accent, dialogs/selects/tooltips now visibly animate in/out (open the create-cluster dialog and the scenario select). Stop the dev server.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/styles.css
git commit -m "feat(web): Refined Premium design tokens + live overlay animations"
```

---

### Task 3: Motion infrastructure

**Files:**

- Modify: `apps/web/src/app.tsx`

- [ ] **Step 1: Wrap the app in LazyMotion + MotionConfig**

In `apps/web/src/app.tsx`, add to imports:

```tsx
import { LazyMotion, MotionConfig, domAnimation } from 'motion/react';
```

Replace the `App` body (current structure: ThemeProvider > QueryClientProvider > TooltipProvider > RouterProvider + Toaster):

```tsx
export function App(): React.JSX.Element {
  return (
    <ThemeProvider>
      <LazyMotion features={domAnimation} strict>
        <MotionConfig reducedMotion="user">
          <QueryClientProvider client={queryClient}>
            <TooltipProvider delayDuration={200}>
              <RouterProvider router={router} />
              <Toaster />
            </TooltipProvider>
          </QueryClientProvider>
        </MotionConfig>
      </LazyMotion>
    </ThemeProvider>
  );
}
```

(`strict` makes any accidental full `motion.*` import throw in dev — keeps the bundle on the ~5 kB path. All motion components in this codebase must use `motion/react-m`.)

- [ ] **Step 2: Verify**

Run: `pnpm --filter @lcm/web exec tsc --noEmit && pnpm --filter @lcm/web test -- --run && pnpm --filter @lcm/web build`
Expected: green; note the build's gzip delta in your report (should be ≈ +5-7 kB on the entry chunk).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app.tsx
git commit -m "feat(web): LazyMotion (domAnimation, strict) + MotionConfig reducedMotion=user"
```

---

### Task 4: Sonner 2 themed Toaster

**Files:**

- Modify: `apps/web/src/components/ui/toaster.tsx` (entire file)

- [ ] **Step 1: Replace `toaster.tsx` with:**

```tsx
import { Toaster as SonnerToaster } from 'sonner';

import { useTheme } from '@/components/theme/use-theme';

export function Toaster(): React.JSX.Element {
  const { resolvedTheme } = useTheme();
  return (
    <SonnerToaster
      position="bottom-right"
      theme={resolvedTheme}
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast:
            'rounded-[var(--radius-card)] border-border shadow-[var(--overlay-shadow)] font-sans',
        },
      }}
    />
  );
}
```

If `useTheme`'s return shape differs (check `apps/web/src/components/theme/use-theme.ts` — expected `{ theme, resolvedTheme, setTheme }` with `resolvedTheme: 'light' | 'dark'`), adapt the property name and report.

- [ ] **Step 2: Verify**

Run: `pnpm --filter @lcm/web test -- --run && pnpm --filter @lcm/web exec tsc --noEmit`
Expected: green. Manual: `pnpm dev`, delete+undo a category in Settings (fires toasts) in light and dark — toast follows theme, rounded 12px, soft shadow. Stop dev server.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/toaster.tsx
git commit -m "feat(web): theme-aware sonner 2 toaster styled by tokens"
```

---

### Task 5: Restyle core primitives (badge, button, card, input)

**Files:**

- Modify: `apps/web/src/components/ui/badge.tsx`
- Modify: `apps/web/src/components/ui/button.tsx`
- Modify: `apps/web/src/components/ui/card.tsx`
- Modify: `apps/web/src/components/ui/input.tsx`

All exported names and props are UNCHANGED — these are class-string edits only. Existing tests must stay green unmodified.

- [ ] **Step 1: badge.tsx — pill shape + halo dot**

Replace the `badgeVariants` base string (first arg of `cva`) with:

```
'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'
```

Replace the `dot` span line (line 52) with a halo version:

```tsx
<span
  aria-hidden
  className={cn(
    'h-1.5 w-1.5 rounded-full shadow-[0_0_0_3px_color-mix(in_oklab,currentColor_18%,transparent)]',
    dotColor[resolvedVariant],
  )}
/>
```

- [ ] **Step 2: button.tsx — tactile press + soft elevation**

Replace the `buttonVariants` base string with:

```
'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50'
```

And these two variant lines:

```
        default: 'bg-foreground text-background shadow-[var(--shadow-card)] hover:bg-foreground/90',
        accent: 'bg-accent text-accent-foreground shadow-[var(--shadow-card)] hover:bg-accent/90',
```

(`destructive`/`outline`/`ghost`/`link` and all sizes unchanged.)

- [ ] **Step 3: card.tsx — elevation + smooth hover**

In `Card`, replace the class string:

```tsx
        'rounded-[var(--radius-card)] border border-border bg-card text-card-foreground shadow-[var(--shadow-card)] transition-shadow duration-200',
```

(Consumers that want lift add `hover:shadow-[var(--shadow-card-hover)]` themselves — screen PRs do that.)

- [ ] **Step 4: input.tsx — stronger focus, hover affordance**

Replace the class string:

```tsx
        'flex h-8 w-full rounded-[var(--radius)] border border-input bg-background px-2.5 py-1 text-sm transition-colors hover:border-border-strong file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:border-transparent disabled:cursor-not-allowed disabled:opacity-50',
```

- [ ] **Step 5: Verify**

Run: `pnpm --filter @lcm/web test -- --run`
Expected: 201 green with NO test edits. If a test asserts a removed class (e.g. `rounded-[var(--radius)]` on Badge), report it before changing the test.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ui/badge.tsx apps/web/src/components/ui/button.tsx apps/web/src/components/ui/card.tsx apps/web/src/components/ui/input.tsx
git commit -m "feat(web): restyle badge/button/card/input to Refined Premium tokens"
```

---

### Task 6: Restyle overlays (dialog, sheet) + animated tabs indicator

`select.tsx` and `tooltip.tsx` need NO code change — their classes already reference the vars whose values Task 2 updated, and Task 2 activated their animations.

**Files:**

- Modify: `apps/web/src/components/ui/dialog.tsx`
- Modify: `apps/web/src/components/ui/sheet.tsx`
- Modify: `apps/web/src/components/ui/tabs.tsx`

- [ ] **Step 1: dialog.tsx — frosted overlay, calmer entry**

`DialogOverlay` class string becomes:

```tsx
      'fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
```

In `DialogContent`'s class string, change only these fragments: `gap-4` stays; `duration-200` → `duration-150`; `zoom-in-95`/`zoom-out-95` → `zoom-in-[0.97]`/`zoom-out-[0.97]` (subtler scale). Leave everything else identical.

- [ ] **Step 2: sheet.tsx — matching overlay**

Apply the same `bg-black/40 backdrop-blur-[2px]` change to `SheetOverlay` (line 19). Content unchanged.

- [ ] **Step 3: tabs.tsx — animated underline indicator**

Replace `TabsTrigger`'s class string with:

```tsx
      'relative inline-flex h-9 items-center justify-center whitespace-nowrap px-1 text-sm font-medium text-fg-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-50 after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent after:origin-center after:scale-x-0 after:transition-transform after:duration-200 after:ease-out data-[state=active]:text-foreground data-[state=active]:after:scale-x-100',
```

(`TabsList` and `TabsContent` unchanged — the list's `border-b` remains the track under the animated underline.)

- [ ] **Step 4: Verify**

Run: `pnpm --filter @lcm/web test -- --run`
Expected: green, no test edits. Manual: `pnpm dev` — open a dialog (blurred overlay, soft zoom), switch tabs on a cluster page (underline slides via scale). Stop dev server.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/dialog.tsx apps/web/src/components/ui/sheet.tsx apps/web/src/components/ui/tabs.tsx
git commit -m "feat(web): frosted overlays + animated tabs indicator"
```

---

### Task 7: New static primitives — Skeleton, StatusDot, EmptyState, SegmentedControl

**Files:**

- Create: `apps/web/src/components/ui/skeleton.tsx`
- Create: `apps/web/src/components/ui/status-dot.tsx`
- Create: `apps/web/src/components/ui/empty-state.tsx`
- Create: `apps/web/src/components/ui/segmented-control.tsx`
- Create: `apps/web/src/components/ui/segmented-control.test.tsx`
- Create: `apps/web/src/components/ui/status-dot.test.tsx`

- [ ] **Step 1: Write the failing tests**

`segmented-control.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SegmentedControl } from './segmented-control';

const options = [
  { value: '12mo', label: '12 mo' },
  { value: '24mo', label: '24 mo' },
  { value: 'all', label: 'All' },
] as const;

describe('<SegmentedControl>', () => {
  it('renders a group with one pressed option', () => {
    render(
      <SegmentedControl
        ariaLabel="Forecast window"
        value="24mo"
        onValueChange={() => {}}
        options={[...options]}
      />,
    );
    expect(screen.getByRole('group', { name: 'Forecast window' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '24 mo' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '12 mo' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports selection changes', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <SegmentedControl
        ariaLabel="Forecast window"
        value="24mo"
        onValueChange={onValueChange}
        options={[...options]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(onValueChange).toHaveBeenCalledWith('all');
  });
});
```

`status-dot.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatusDot } from './status-dot';

describe('<StatusDot>', () => {
  it('is hidden from AT and tinted by tone', () => {
    const { container } = render(<StatusDot tone="crit" />);
    const dot = container.firstElementChild!;
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(dot.className).toContain('text-destructive');
  });

  it('paints the dot from currentColor so the halo tracks the tone', () => {
    const { container } = render(<StatusDot tone="ok" />);
    const dot = container.firstElementChild!;
    expect(dot.className).toContain('text-success');
    expect(dot.className).toContain('bg-current');
  });
});
```

- [ ] **Step 2: Run to verify both fail (module not found)**

Run: `pnpm --filter @lcm/web test -- --run src/components/ui/segmented-control.test.tsx src/components/ui/status-dot.test.tsx`

- [ ] **Step 3: Implement the four components**

`skeleton.tsx`:

```tsx
import * as React from 'react';

import { cn } from '@/lib/utils';

/** Shimmering placeholder block; size it via className (h-*, w-*). */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      aria-hidden
      className={cn(
        'animate-shimmer rounded-[var(--radius)] bg-[linear-gradient(90deg,var(--muted)_25%,var(--card-hover)_37%,var(--muted)_63%)] bg-[length:400%_100%]',
        className,
      )}
      {...props}
    />
  );
}
```

`status-dot.tsx`:

```tsx
import * as React from 'react';

import { cn } from '@/lib/utils';

// Tones set the TEXT color; the dot paints from bg-current so the
// currentColor halo below stays in sync with the tone.
const toneClass = {
  ok: 'text-success',
  warn: 'text-warning',
  crit: 'text-destructive',
  neutral: 'text-fg-subtle',
} as const;

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: keyof typeof toneClass;
}

/** Soft-halo status indicator (decorative — pair with visible/aria text). */
export function StatusDot({ tone, className, ...props }: StatusDotProps): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block h-1.5 w-1.5 rounded-full bg-current shadow-[0_0_0_3px_color-mix(in_oklab,currentColor_15%,transparent)]',
        toneClass[tone],
        className,
      )}
      {...props}
    />
  );
}
```

`empty-state.tsx`:

```tsx
import * as React from 'react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps): React.JSX.Element {
  return (
    <Card
      className={cn(
        'flex flex-col items-center justify-center gap-2 border-dashed p-8 text-center shadow-none',
        className,
      )}
    >
      {icon ? (
        <div aria-hidden className="mb-1 text-fg-subtle [&>svg]:h-8 [&>svg]:w-8">
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="max-w-sm text-xs text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </Card>
  );
}
```

`segmented-control.tsx`:

```tsx
import * as React from 'react';

import { cn } from '@/lib/utils';

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: SegmentedControlOption<T>[];
  ariaLabel: string;
  className?: string;
}

export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  ariaLabel,
  className,
}: SegmentedControlProps<T>): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn('inline-flex gap-0.5 rounded-[var(--radius)] bg-muted p-0.5', className)}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onValueChange(option.value)}
            className={cn(
              'rounded-[6px] px-2.5 py-1 text-xs font-medium transition-colors duration-150',
              active
                ? 'bg-card text-foreground shadow-[var(--shadow-card)]'
                : 'text-fg-muted hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @lcm/web test -- --run src/components/ui/segmented-control.test.tsx src/components/ui/status-dot.test.tsx`
Expected: 3 passing. Then full suite once: `pnpm --filter @lcm/web test -- --run`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/skeleton.tsx apps/web/src/components/ui/status-dot.tsx apps/web/src/components/ui/empty-state.tsx apps/web/src/components/ui/segmented-control.tsx apps/web/src/components/ui/segmented-control.test.tsx apps/web/src/components/ui/status-dot.test.tsx
git commit -m "feat(web): Skeleton, StatusDot, EmptyState, SegmentedControl primitives"
```

---

### Task 8: New data primitives — Sparkline + AnimatedNumber

**Files:**

- Create: `apps/web/src/components/ui/sparkline.tsx`
- Create: `apps/web/src/components/ui/sparkline.test.tsx`
- Create: `apps/web/src/components/ui/animated-number.tsx`
- Create: `apps/web/src/components/ui/animated-number.test.tsx`

- [ ] **Step 1: Write the failing tests**

`sparkline.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Sparkline } from './sparkline';

describe('<Sparkline>', () => {
  it('maps values to a polyline spanning the viewBox', () => {
    const { container } = render(<Sparkline values={[0, 5, 10]} width={60} height={20} />);
    const polyline = container.querySelector('polyline')!;
    const points = polyline
      .getAttribute('points')!
      .split(' ')
      .map((p) => p.split(',').map(Number));
    expect(points).toHaveLength(3);
    expect(points[0]![0]).toBe(0); // first x at left edge
    expect(points[2]![0]).toBe(60); // last x at right edge
    expect(points[0]![1]).toBeGreaterThan(points[2]![1]!); // min renders lower than max
  });

  it('renders an empty placeholder for fewer than two values', () => {
    const { container } = render(<Sparkline values={[7]} />);
    expect(container.querySelector('polyline')).toBeNull();
  });
});
```

`animated-number.test.tsx` (jsdom has no rAF-driven springs in tests; assert the reduced-motion/static path and the formatted output):

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: () => true };
});

import { AnimatedNumber } from './animated-number';

describe('<AnimatedNumber>', () => {
  it('renders the formatted final value when reduced motion is preferred', () => {
    render(<AnimatedNumber value={78.4} format={(v) => `${v.toFixed(1)}%`} />);
    expect(screen.getByText('78.4%')).toBeInTheDocument();
  });

  it('defaults to a locale-rounded integer', () => {
    render(<AnimatedNumber value={4302.4} />);
    expect(screen.getByText('4,302')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify they fail (module not found)**

Run: `pnpm --filter @lcm/web test -- --run src/components/ui/sparkline.test.tsx src/components/ui/animated-number.test.tsx`

- [ ] **Step 3: Implement**

`sparkline.tsx`:

```tsx
import * as React from 'react';

import { cn } from '@/lib/utils';

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  /** Stroke uses currentColor — set text color on the parent or via className. */
  className?: string;
}

export function Sparkline({
  values,
  width = 64,
  height = 20,
  className,
}: SparklineProps): React.JSX.Element {
  if (values.length < 2) {
    return <span aria-hidden className="inline-block" style={{ width, height }} />;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = width / (values.length - 1);
  const pad = 2;
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = height - pad - ((v - min) / range) * (height - pad * 2);
      return `${Number(x.toFixed(2))},${Number(y.toFixed(2))}`;
    })
    .join(' ');
  return (
    <svg
      aria-hidden
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('shrink-0', className)}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
```

`animated-number.tsx`:

```tsx
import { useEffect } from 'react';
import { useReducedMotion, useSpring, useTransform } from 'motion/react';
import * as m from 'motion/react-m';

export interface AnimatedNumberProps {
  value: number;
  /** Formats the in-flight value each frame; defaults to locale-rounded integer. */
  format?: (value: number) => string;
  className?: string;
}

const defaultFormat = (v: number): string => Math.round(v).toLocaleString('en-US');

export function AnimatedNumber({
  value,
  format = defaultFormat,
  className,
}: AnimatedNumberProps): React.JSX.Element {
  const reduced = useReducedMotion();
  const spring = useSpring(value, { stiffness: 140, damping: 24 });
  useEffect(() => {
    spring.set(value);
  }, [spring, value]);
  const text = useTransform(spring, format);
  if (reduced) {
    return <span className={className}>{format(value)}</span>;
  }
  return <m.span className={className}>{text}</m.span>;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @lcm/web test -- --run src/components/ui/sparkline.test.tsx src/components/ui/animated-number.test.tsx`
Expected: 4 passing. Then the full suite + typecheck + build: `pnpm --filter @lcm/web exec tsc --noEmit && pnpm --filter @lcm/web test -- --run && pnpm --filter @lcm/web build`
(`strict` LazyMotion check: `motion/react-m` is the lazy-safe import — if the build warns about a full motion import, that's a bug in this task.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/sparkline.tsx apps/web/src/components/ui/sparkline.test.tsx apps/web/src/components/ui/animated-number.tsx apps/web/src/components/ui/animated-number.test.tsx
git commit -m "feat(web): Sparkline + AnimatedNumber primitives"
```

---

### Task 9: DropdownMenu + Popover wrappers

**Files:**

- Create: `apps/web/src/components/ui/dropdown-menu.tsx`
- Create: `apps/web/src/components/ui/popover.tsx`
- Create: `apps/web/src/components/ui/dropdown-menu.test.tsx`

- [ ] **Step 1: Write the failing test**

`dropdown-menu.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';

describe('<DropdownMenu>', () => {
  it('opens on trigger click and renders items with menu semantics', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
          <DropdownMenuItem>Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails (module not found)**

Run: `pnpm --filter @lcm/web test -- --run src/components/ui/dropdown-menu.test.tsx`

- [ ] **Step 3: Implement**

`dropdown-menu.tsx`:

```tsx
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import * as React from 'react';

import { cn } from '@/lib/utils';

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;

export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 min-w-[9rem] overflow-hidden rounded-[var(--radius-card)] border border-border bg-popover p-1 text-popover-foreground shadow-[var(--overlay-shadow)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2',
        className,
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = 'DropdownMenuContent';

export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex cursor-default select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-sm outline-none transition-colors focus:bg-card-hover focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      destructive && 'text-destructive focus:text-destructive',
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = 'DropdownMenuItem';

export const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn('-mx-1 my-1 h-px bg-border', className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator';

export const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn('px-2 py-1.5 text-xs font-medium text-fg-subtle', className)}
    {...props}
  />
));
DropdownMenuLabel.displayName = 'DropdownMenuLabel';
```

`popover.tsx`:

```tsx
import { Popover as PopoverPrimitive } from 'radix-ui';
import * as React from 'react';

import { cn } from '@/lib/utils';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'center', sideOffset = 6, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'z-50 w-72 rounded-[var(--radius-card)] border border-border bg-popover p-4 text-popover-foreground shadow-[var(--overlay-shadow)] outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2',
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = 'PopoverContent';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @lcm/web test -- --run src/components/ui/dropdown-menu.test.tsx`
Expected: 1 passing. Then full suite + typecheck.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/dropdown-menu.tsx apps/web/src/components/ui/popover.tsx apps/web/src/components/ui/dropdown-menu.test.tsx
git commit -m "feat(web): DropdownMenu + Popover primitives on monolithic radix-ui"
```

---

### Task 10: Final gate, visual review, PR

- [ ] **Step 1: Full monorepo gate**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all green (web count grows to ~209 with the 8 new tests). Paste summary lines.

- [ ] **Step 2: Visual review (controller-driven)**

`pnpm dev`, then in light AND dark: overview page (tokens, cards, shadows), cluster detail (dialog open animation, tabs underline, select), Settings (toast theming). While the dialog/sheet is open, confirm the frosted overlay's `backdrop-blur` opens smoothly (no jank while the open animation runs — blur + animate-in is the expensive combination; if it stutters, drop the blur to `backdrop-blur-[1px]` or remove it and report back). Compare against spec §Phase 1. Capture two screenshots for the PR description if the harness allows. Stop the dev server.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin feat/overhaul-2-design-system
gh pr create --base main --title "Overhaul PR 2: design-system core (Phase 1a)" --body "$(cat <<'EOF'
Phase 1 foundation of the app overhaul (spec: docs/superpowers/specs/2026-06-10-app-overhaul-design.md).

- Refined Premium tokens (warm stone neutrals, evolved gold, layered shadows, 8/12/16 radii) — variable names unchanged, app restyles globally
- tw-animate-css: the kit's existing Radix animation classes were inert (no plugin); overlays now actually animate
- monolithic radix-ui migration (replaces 5 individual @radix-ui packages); sideEffects:false on @lcm/shared
- LazyMotion (domAnimation, strict) + MotionConfig reducedMotion=user
- sonner 2, theme-aware + token-styled
- restyled badge/button/card/input; frosted dialog/sheet overlays; animated tabs indicator
- new primitives: Skeleton, StatusDot, EmptyState, SegmentedControl, Sparkline, AnimatedNumber, DropdownMenu, Popover

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes (already applied)

- Spec Phase 1 coverage: tokens ✓ (T2), kit-on-radix ✓ (already true + T1 consolidation + T9 additions), sonner ✓ (T4, amended wording), motion ✓ (T3, T8), new primitives ✓ (T7-T9; ProgressRing deviation documented in header). App shell is deliberately PR 3 (spec rollout).
- Type consistency: `SegmentedControlOption<T>`/`StatusDotProps`/`SparklineProps`/`AnimatedNumberProps` defined where used; `radix-ui` namespace import shape consistent across T1/T9.
- No-placeholder check: every changed file shows the exact code or an exact one-line replacement table; the only "adapt" instructions are guarded with report-back conditions.
- Risk note: T1's monolithic migration is the only task touching many files at once — it is intentionally FIRST so any breakage surfaces before restyling begins.
