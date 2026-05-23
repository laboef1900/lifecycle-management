# UI Refresh — Enterprise Polish & Dark Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the LCM web UI with a Linear/Vercel-sleek aesthetic, first-class dark mode, sidebar navigation with breadcrumbs, theme-aware Recharts, and a ⌘K command palette — all presentation-layer, all inside `apps/web/**`.

**Architecture:** A two-tier color system — semantic CSS variables on `:root` (light) and `html.dark` (dark), mapped through Tailwind v4 `@theme`. A React `ThemeProvider` + `useTheme` hook drives toggling, persisted in `localStorage`, with an inline pre-mount script preventing flash. A new sidebar app shell, refreshed primitives (`Card`, `Tooltip`, `Kbd`, `Badge`, `Button`), and a `useChartColors()` hook give Recharts theme awareness. `cmdk` powers the command palette; a single `keyboard-shortcuts.tsx` handles global keys.

**Tech Stack:** React 19, TypeScript, Vite 6, Tailwind v4, TanStack Router/Query, Radix UI, Recharts 2, Lucide, `cmdk`, `@fontsource/inter`, `@fontsource/jetbrains-mono`, Vitest + Testing Library, Playwright.

**Spec:** [`docs/superpowers/specs/2026-05-23-ui-refresh-enterprise-dark-mode-design.md`](../specs/2026-05-23-ui-refresh-enterprise-dark-mode-design.md)

**Branch:** `ui-refresh-design` (already in use; design spec committed on it). Continue committing on this branch.

**Project conventions to follow:**

- Pre-commit hooks (Husky + lint-staged) run Prettier on staged files and `pnpm -r typecheck` on commit. A commit that fails typecheck does **not** create the commit — fix and re-run `git commit`, do not `--amend`.
- Strings use single quotes; React components use named exports; types use `interface` where extensible, `type` for unions.
- Path alias `@/` resolves to `apps/web/src/`.

---

## File Structure

**New files (in order created):**

```
apps/web/src/
├─ components/
│  ├─ theme/
│  │  ├─ theme-provider.tsx       Context + storage effects
│  │  ├─ use-theme.ts             Hook reading the context
│  │  └─ theme-toggle.tsx         Header icon button (cycles system→light→dark)
│  ├─ layout/
│  │  ├─ sidebar.tsx              Collapsible left nav (state persisted)
│  │  └─ breadcrumbs.tsx          Route-driven breadcrumb trail
│  ├─ command/
│  │  ├─ command-palette.tsx      ⌘K palette (cmdk + Radix Dialog)
│  │  ├─ shortcuts-dialog.tsx     "?" help dialog
│  │  └─ keyboard-shortcuts.tsx   Global key handler (⌘K, ?, g d, g s)
│  └─ ui/
│     ├─ card.tsx                 Card primitive + sub-parts
│     ├─ tooltip.tsx              Radix tooltip wrapper
│     └─ kbd.tsx                  <kbd> key-cap style
├─ lib/
│  └─ use-chart-colors.ts         Reads CSS vars; refreshes on theme change
└─ __tests__/
   ├─ use-theme.test.ts
   └─ command-palette.test.tsx
```

**Modified files:**

```
apps/web/
├─ index.html                                    + inline pre-mount theme script
├─ package.json                                  + cmdk, @radix-ui/react-tooltip,
│                                                 @fontsource/inter, @fontsource/jetbrains-mono
├─ src/
│  ├─ main.tsx                                   wrap with ThemeProvider; mount palette + keys
│  ├─ styles.css                                 full token rewrite + fonts
│  ├─ __tests__/setup.ts                         add ThemeProvider helper for tests
│  ├─ components/
│  │  ├─ layout/app-shell.tsx                    two-column layout w/ sidebar + new header
│  │  ├─ sparkline.tsx                           use useChartColors()
│  │  ├─ ui/badge.tsx                            token-based variants + `dot` prop
│  │  ├─ ui/button.tsx                           focus-ring offset against background
│  │  └─ clusters/
│  │     ├─ cluster-table.tsx                    wrap in Card; mono on tabular cells
│  │     ├─ empty-state.tsx                      Card + Database icon
│  │     ├─ forecast-chart.tsx                   useChartColors()
│  │     ├─ utilization-badge.tsx                pass `dot`
│  │     └─ utilization-panel.tsx                useChartColors() + Card
│  └─ routes/
│     ├─ index.tsx                               error card uses Card primitive
│     └─ clusters.$id.tsx                        error card + breadcrumb-aware header
└─ playwright/
   └─ golden-path.spec.ts                        + theme toggle assertion
```

**Untouched:** `apps/api/**`, `packages/shared/**`, Prisma, all Dockerfiles, `docker-compose*.yml`, CI workflows.

---

## Task 1 — Dependencies, design tokens, fonts, pre-mount script

**Files:**

- Modify: `apps/web/package.json`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/index.html`

**Goal:** Get the foundational color/font tokens and the pre-mount script in place. The app should build and run after this task, in light mode only — toggling `<html class="dark">` manually in DevTools should already flip every color in the existing UI.

- [ ] **Step 1: Install runtime dependencies**

Run from the repo root:

```bash
pnpm --filter @lcm/web add cmdk@^1.0.0 @radix-ui/react-tooltip@^1.1.4 @fontsource/inter@^5.1.0 @fontsource/jetbrains-mono@^5.1.0
```

Expected: `apps/web/package.json` and `pnpm-lock.yaml` update; no errors.

- [ ] **Step 2: Rewrite `apps/web/src/styles.css` with the token system**

Replace the entire contents of `apps/web/src/styles.css` with:

```css
@import 'tailwindcss';
@import '@fontsource/inter/400.css';
@import '@fontsource/inter/500.css';
@import '@fontsource/inter/600.css';
@import '@fontsource/inter/700.css';
@import '@fontsource/jetbrains-mono/400.css';
@import '@fontsource/jetbrains-mono/600.css';

:root {
  --background: oklch(99% 0.005 257);
  --foreground: oklch(15% 0.02 0);
  --card: oklch(100% 0 0);
  --card-foreground: oklch(15% 0.02 0);
  --popover: oklch(100% 0 0);
  --popover-foreground: oklch(15% 0.02 0);
  --muted: oklch(96% 0.005 257);
  --muted-foreground: oklch(50% 0.02 257);
  --border: oklch(90% 0.01 257);
  --input: oklch(90% 0.01 257);
  --ring: oklch(50% 0.22 262);
  --primary: oklch(50% 0.22 262);
  --primary-foreground: oklch(99% 0.005 257);
  --secondary: oklch(94% 0.01 257);
  --secondary-foreground: oklch(15% 0.02 0);
  --accent: oklch(94% 0.02 250);
  --accent-foreground: oklch(15% 0.02 0);
  --success: oklch(60% 0.18 142);
  --success-foreground: oklch(99% 0.005 257);
  --warning: oklch(70% 0.2 80);
  --warning-foreground: oklch(15% 0.02 0);
  --destructive: oklch(58% 0.22 25);
  --destructive-foreground: oklch(99% 0.005 257);
  --radius: 0.5rem;
}

html.dark {
  --background: oklch(13% 0.01 257);
  --foreground: oklch(96% 0.005 257);
  --card: oklch(18% 0.01 257);
  --card-foreground: oklch(96% 0.005 257);
  --popover: oklch(22% 0.01 257);
  --popover-foreground: oklch(96% 0.005 257);
  --muted: oklch(22% 0.01 257);
  --muted-foreground: oklch(68% 0.02 257);
  --border: oklch(28% 0.01 257);
  --input: oklch(28% 0.01 257);
  --ring: oklch(68% 0.18 262);
  --primary: oklch(68% 0.18 262);
  --primary-foreground: oklch(13% 0.01 257);
  --secondary: oklch(24% 0.01 257);
  --secondary-foreground: oklch(96% 0.005 257);
  --accent: oklch(28% 0.02 250);
  --accent-foreground: oklch(96% 0.005 257);
  --success: oklch(72% 0.12 142);
  --success-foreground: oklch(13% 0.01 257);
  --warning: oklch(78% 0.14 80);
  --warning-foreground: oklch(13% 0.01 257);
  --destructive: oklch(70% 0.18 25);
  --destructive-foreground: oklch(13% 0.01 257);
}

@theme {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-success: var(--success);
  --color-success-foreground: var(--success-foreground);
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --radius: var(--radius);
  --font-sans: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
}

html,
body,
#root {
  height: 100%;
}

body {
  font-family: var(--font-sans);
  font-feature-settings: 'cv02', 'cv03', 'cv04', 'cv11';
}
```

The OpenType feature flags (`cv02`–`cv11`) enable Inter's slashed-zero and unambiguous-letter alternates — the typographic detail that makes a UI font feel "enterprise."

- [ ] **Step 3: Add the pre-mount theme script to `apps/web/index.html`**

Replace the contents of `apps/web/index.html` with:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Capacity Forecast — LCM</title>
    <script>
      (function () {
        try {
          var stored = localStorage.getItem('theme');
          var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
          var dark = stored === 'dark' || ((!stored || stored === 'system') && prefersDark);
          if (dark) document.documentElement.classList.add('dark');
        } catch (e) {}
      })();
    </script>
  </head>
  <body class="min-h-screen bg-background text-foreground antialiased">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Verify build + dev server start**

Run:

```bash
pnpm --filter @lcm/web build
```

Expected: build succeeds, no Tailwind/CSS errors, no missing-module errors.

Then start the dev server in a separate terminal and visit `http://localhost:5173`:

```bash
pnpm --filter @lcm/web dev
```

Manually flip `<html>` to `<html class="dark">` in DevTools. Expected: background, text, borders, badges all flip to the dark palette. Some hardcoded chart colors will remain wrong — that's Task 5's job. Close the dev server when done.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/web/pnpm-lock.yaml apps/web/src/styles.css apps/web/index.html
git commit -m "feat(web): introduce theme tokens, fonts, pre-mount script

Adds cmdk, @radix-ui/react-tooltip, Inter, and JetBrains Mono. Rewrites
styles.css with a two-tier OKLCH token system (:root for light, html.dark
for dark) wired through Tailwind v4's @theme block. Pre-mount script in
index.html prevents flash-of-wrong-theme."
```

Note: husky will run prettier + typecheck. If typecheck fails, fix and re-stage; do not `--amend`.

---

## Task 2 — Theme provider, hook, and toggle

**Files:**

- Create: `apps/web/src/components/theme/theme-provider.tsx`
- Create: `apps/web/src/components/theme/use-theme.ts`
- Create: `apps/web/src/components/theme/theme-toggle.tsx`
- Create: `apps/web/src/__tests__/use-theme.test.tsx`
- Modify: `apps/web/src/__tests__/setup.ts`
- Modify: `apps/web/src/app.tsx`

**Goal:** Working `ThemeProvider` with `useTheme()` consumed by a header `ThemeToggle` button. Tests cover system detection, manual override, persistence, and OS-change tracking.

- [ ] **Step 1: Write the failing test for `useTheme`**

Create `apps/web/src/__tests__/use-theme.test.tsx`:

```tsx
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ThemeProvider } from '@/components/theme/theme-provider';
import { useTheme } from '@/components/theme/use-theme';

interface MediaQueryListenerSet {
  matches: boolean;
  listener: ((event: MediaQueryListEvent) => void) | null;
}

function stubMatchMedia(initial: boolean): MediaQueryListenerSet {
  const state: MediaQueryListenerSet = { matches: initial, listener: null };
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: state.matches,
      media: query,
      onchange: null,
      addEventListener: (_event: string, cb: (e: MediaQueryListEvent) => void) => {
        state.listener = cb;
      },
      removeEventListener: () => {
        state.listener = null;
      },
      dispatchEvent: () => false,
    })),
  );
  return state;
}

function Probe(): React.JSX.Element {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button onClick={() => setTheme('dark')}>set-dark</button>
      <button onClick={() => setTheme('light')}>set-light</button>
      <button onClick={() => setTheme('system')}>set-system</button>
    </div>
  );
}

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('defaults to system, resolves to light when OS prefers light', () => {
    stubMatchMedia(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('system');
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  test('defaults to system, resolves to dark when OS prefers dark', () => {
    stubMatchMedia(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  test('reads persisted theme from localStorage on mount', () => {
    localStorage.setItem('theme', 'dark');
    stubMatchMedia(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  test('setTheme(light) persists and removes dark class', async () => {
    const user = userEvent.setup();
    stubMatchMedia(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await user.click(screen.getByText('set-light'));
    expect(localStorage.getItem('theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  test('system mode tracks OS changes live', () => {
    const media = stubMatchMedia(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    act(() => {
      media.matches = true;
      media.listener?.({ matches: true } as MediaQueryListEvent);
    });
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @lcm/web test -- use-theme
```

Expected: FAIL with "Cannot find module '@/components/theme/theme-provider'" or similar.

- [ ] **Step 3: Implement `use-theme.ts`**

Create `apps/web/src/components/theme/use-theme.ts`:

```ts
import { createContext, useContext } from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error('useTheme must be used inside <ThemeProvider />');
  }
  return value;
}
```

- [ ] **Step 4: Implement `theme-provider.tsx`**

Create `apps/web/src/components/theme/theme-provider.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ThemeContext, type ResolvedTheme, type Theme } from './use-theme';

const STORAGE_KEY = 'theme';

function readStoredTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    // localStorage may throw in private modes; fall through to default
  }
  return 'system';
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyResolved(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  if (resolved === 'dark') document.documentElement.classList.add('dark');
  else document.documentElement.classList.remove('dark');
}

interface ThemeProviderProps {
  children: React.ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps): React.JSX.Element {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => getSystemTheme());

  // Subscribe to OS-level preference changes.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (event: MediaQueryListEvent): void => {
      setSystemTheme(event.matches ? 'dark' : 'light');
    };
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, []);

  const resolvedTheme: ResolvedTheme = theme === 'system' ? systemTheme : theme;

  // Apply the resolved theme to <html>.
  useEffect(() => {
    applyResolved(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore — feature degrades to non-persistent
    }
    setThemeState(next);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @lcm/web test -- use-theme
```

Expected: PASS, all 5 tests green.

- [ ] **Step 6: Implement `theme-toggle.tsx`**

Create `apps/web/src/components/theme/theme-toggle.tsx`:

```tsx
import { Monitor, Moon, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { useTheme, type Theme } from './use-theme';

const ORDER: Theme[] = ['system', 'light', 'dark'];

function nextTheme(current: Theme): Theme {
  const idx = ORDER.indexOf(current);
  return ORDER[(idx + 1) % ORDER.length] ?? 'system';
}

function labelFor(theme: Theme): string {
  switch (theme) {
    case 'system':
      return 'Theme: System';
    case 'light':
      return 'Theme: Light';
    case 'dark':
      return 'Theme: Dark';
  }
}

export function ThemeToggle(): React.JSX.Element {
  const { theme, setTheme } = useTheme();
  const Icon = theme === 'system' ? Monitor : theme === 'light' ? Sun : Moon;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={labelFor(theme)}
      title={labelFor(theme)}
      onClick={() => setTheme(nextTheme(theme))}
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}
```

- [ ] **Step 7: Update the test setup to mock `matchMedia` globally**

Many other tests render components that descend from `ThemeProvider` once we wrap the app. Provide a benign default so they don't break.

Replace `apps/web/src/__tests__/setup.ts` with:

```ts
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

// Recharts uses ResizeObserver which jsdom doesn't ship.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// Default matchMedia stub — tests can override with vi.stubGlobal.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
```

- [ ] **Step 8: Wrap the app with `ThemeProvider`**

Edit `apps/web/src/app.tsx` — add the import and wrap the router:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter } from '@tanstack/react-router';

import { ThemeProvider } from '@/components/theme/theme-provider';
import { Toaster } from '@/components/ui/toaster';

import { routeTree } from './routeTree.gen';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function App(): React.JSX.Element {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
```

- [ ] **Step 9: Run the full web test suite**

```bash
pnpm --filter @lcm/web test
```

Expected: all tests pass, including the new `use-theme` suite. Existing component tests (`cluster-table.test.tsx`, `create-cluster-dialog.test.tsx`, `forecast-chart.test.tsx`) should be unaffected — they don't consume `useTheme` yet.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/theme/ apps/web/src/__tests__/use-theme.test.tsx apps/web/src/__tests__/setup.ts apps/web/src/app.tsx
git commit -m "feat(web): add ThemeProvider, useTheme hook, header toggle

Wraps the app in a context that resolves theme = system|light|dark
against prefers-color-scheme and persists the choice in localStorage.
Includes a header ThemeToggle that cycles system → light → dark with
appropriate Lucide icons and aria-label."
```

---

## Task 3 — Card, Tooltip, and Kbd primitives

**Files:**

- Create: `apps/web/src/components/ui/card.tsx`
- Create: `apps/web/src/components/ui/tooltip.tsx`
- Create: `apps/web/src/components/ui/kbd.tsx`

**Goal:** Three small primitives we'll consume in the next several tasks. No tests required — they're trivial pass-through components, and downstream tests will exercise them.

- [ ] **Step 1: Create `card.tsx`**

```tsx
import * as React from 'react';

import { cn } from '@/lib/utils';

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
Card.displayName = 'Card';

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col gap-1 p-4', className)} {...props} />
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
  <p ref={ref} className={cn('text-xs text-muted-foreground', className)} {...props} />
));
CardDescription.displayName = 'CardDescription';

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('p-4 pt-0', className)} {...props} />
  ),
);
CardContent.displayName = 'CardContent';

export const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center p-4 pt-0', className)} {...props} />
  ),
);
CardFooter.displayName = 'CardFooter';
```

- [ ] **Step 2: Create `tooltip.tsx`**

```tsx
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as React from 'react';

import { cn } from '@/lib/utils';

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Content
    ref={ref}
    sideOffset={sideOffset}
    className={cn(
      'z-50 overflow-hidden rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md',
      'animate-in fade-in-0 zoom-in-95',
      className,
    )}
    {...props}
  />
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;
```

- [ ] **Step 3: Create `kbd.tsx`**

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
        'inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}
```

- [ ] **Step 4: Verify build + lint**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
```

Expected: both pass cleanly.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/card.tsx apps/web/src/components/ui/tooltip.tsx apps/web/src/components/ui/kbd.tsx
git commit -m "feat(web): add Card, Tooltip, Kbd primitives

Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter
for consistent content grouping. Tooltip wraps Radix Tooltip with the
theme tokens. Kbd renders a key-cap styled <kbd> for shortcut hints
and the command palette."
```

---

## Task 4 — Badge, Button, UtilizationBadge updates

**Files:**

- Modify: `apps/web/src/components/ui/badge.tsx`
- Modify: `apps/web/src/components/ui/button.tsx`
- Modify: `apps/web/src/components/clusters/utilization-badge.tsx`

**Goal:** Status badges read correctly in both modes; focus rings are visible on dark backgrounds; the utilization badge gains a color-dot prefix for icon-level redundancy.

- [ ] **Step 1: Replace `apps/web/src/components/ui/badge.tsx` with token-based variants and `dot` prop**

```tsx
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'text-foreground',
        success: 'border-success/30 bg-success/15 text-success',
        warning: 'border-warning/30 bg-warning/15 text-warning',
        danger: 'border-destructive/30 bg-destructive/15 text-destructive',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

const dotColor: Record<NonNullable<VariantProps<typeof badgeVariants>['variant']>, string> = {
  default: 'bg-primary-foreground',
  secondary: 'bg-muted-foreground',
  destructive: 'bg-destructive-foreground',
  outline: 'bg-muted-foreground',
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

- [ ] **Step 2: Update `apps/web/src/components/ui/button.tsx` focus ring offset**

Open `apps/web/src/components/ui/button.tsx` and replace this fragment in the base class string:

```
'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
```

with:

```
'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50',
```

Two changes: explicit `duration-150 ease-out` (matches the spec's interaction baseline) and `ring-offset-background` (so the focus ring is always visible against the actual page color).

- [ ] **Step 3: Update `utilization-badge.tsx` to pass `dot`**

Replace `apps/web/src/components/clusters/utilization-badge.tsx`:

```tsx
import { Badge } from '@/components/ui/badge';

interface UtilizationBadgeProps {
  /** 0..1 ratio (consumption / capacity). */
  value: number;
}

export function UtilizationBadge({ value }: UtilizationBadgeProps): React.JSX.Element {
  const variant = value >= 0.9 ? 'danger' : value >= 0.7 ? 'warning' : 'success';
  const pct = (value * 100).toFixed(1);
  return (
    <Badge variant={variant} dot>
      {pct}%
    </Badge>
  );
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @lcm/web test
```

Expected: all pass. `cluster-table.test.tsx` may exercise the utilization badge; it should still match since the text content (`20.0%`) is unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/badge.tsx apps/web/src/components/ui/button.tsx apps/web/src/components/clusters/utilization-badge.tsx
git commit -m "feat(web): theme-aware Badge variants, focus-ring offset

Badge success/warning/danger variants now use semantic tokens with alpha
modifiers so they render correctly in both light and dark mode. Adds an
optional dot prefix for color+shape redundancy; UtilizationBadge opts
in. Button focus ring offsets against background so it stays visible in
dark mode."
```

---

## Task 5 — Theme-aware chart colors (Recharts + sparkline)

**Files:**

- Create: `apps/web/src/lib/use-chart-colors.ts`
- Modify: `apps/web/src/components/sparkline.tsx`
- Modify: `apps/web/src/components/clusters/forecast-chart.tsx`
- Modify: `apps/web/src/components/clusters/utilization-panel.tsx`

**Goal:** Every chart in the app pulls its stroke, fill, grid, axis, and event-category colors from a single hook that returns OKLCH strings derived from the active theme. Toggling the theme repaints all charts.

- [ ] **Step 1: Create `apps/web/src/lib/use-chart-colors.ts`**

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
}

const LIGHT: ChartColors = {
  consumption: 'oklch(50% 0.22 262)',
  consumptionFill: 'oklch(50% 0.22 262 / 0.18)',
  capacity: 'oklch(58% 0.22 25)',
  grid: 'oklch(90% 0.01 257)',
  axis: 'oklch(50% 0.02 257)',
  utilizationOk: 'oklch(60% 0.18 142)',
  utilizationWarn: 'oklch(70% 0.2 80)',
  utilizationCrit: 'oklch(58% 0.22 25)',
  event: {
    growth: 'oklch(60% 0.15 50)',
    hardware_change: 'oklch(55% 0.18 145)',
    openshift: 'oklch(55% 0.2 290)',
    note: 'oklch(55% 0.02 260)',
  },
};

const DARK: ChartColors = {
  consumption: 'oklch(68% 0.18 262)',
  consumptionFill: 'oklch(68% 0.18 262 / 0.22)',
  capacity: 'oklch(70% 0.18 25)',
  grid: 'oklch(28% 0.01 257)',
  axis: 'oklch(68% 0.02 257)',
  utilizationOk: 'oklch(72% 0.12 142)',
  utilizationWarn: 'oklch(78% 0.14 80)',
  utilizationCrit: 'oklch(70% 0.18 25)',
  event: {
    growth: 'oklch(75% 0.12 50)',
    hardware_change: 'oklch(72% 0.13 145)',
    openshift: 'oklch(72% 0.15 290)',
    note: 'oklch(70% 0.02 260)',
  },
};

export function useChartColors(): ChartColors {
  const { resolvedTheme } = useTheme();
  return useMemo(() => (resolvedTheme === 'dark' ? DARK : LIGHT), [resolvedTheme]);
}
```

Note: we ship the palette inline (not via `getComputedStyle`) because Recharts re-renders synchronously on prop changes — reading CSS vars introduces a frame of stale color when `html.dark` toggles. The OKLCH values match the token values in `styles.css`; if you change one, change both.

- [ ] **Step 2: Refactor `apps/web/src/components/clusters/forecast-chart.tsx`**

Replace the file with:

```tsx
import type { EventCategory, ForecastResponse } from '@lcm/shared';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Card } from '@/components/ui/card';
import { useChartColors } from '@/lib/use-chart-colors';

interface ForecastChartProps {
  forecast: ForecastResponse;
}

const numberFormat = new Intl.NumberFormat('en-US');

function formatMonth(month: string): string {
  const date = new Date(`${month}T00:00:00Z`);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });
}

export function ForecastChart({ forecast }: ForecastChartProps): React.JSX.Element {
  const colors = useChartColors();
  const data = forecast.months.map((point) => ({
    month: point.month,
    consumption: Math.round(point.consumption),
    capacity: Math.round(point.capacity),
  }));

  const eventsByMonth = new Map<string, ForecastResponse['events']>();
  for (const event of forecast.events) {
    const monthKey = `${event.effectiveDate.slice(0, 7)}-01`;
    const bucket = eventsByMonth.get(monthKey) ?? [];
    bucket.push(event);
    eventsByMonth.set(monthKey, bucket);
  }

  return (
    <Card className="p-4">
      <div className="h-[320px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 12, right: 16, bottom: 0, left: 8 }}>
            <defs>
              <linearGradient id="forecast-consumption" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.consumption} stopOpacity={0.45} />
                <stop offset="100%" stopColor={colors.consumption} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
            <XAxis
              dataKey="month"
              tickFormatter={formatMonth}
              tick={{ fontSize: 11 }}
              stroke={colors.axis}
              interval="preserveStartEnd"
              minTickGap={24}
            />
            <YAxis
              tick={{ fontSize: 11 }}
              stroke={colors.axis}
              tickFormatter={(v: number) => numberFormat.format(v)}
              label={{
                value: 'GB',
                angle: -90,
                position: 'insideLeft',
                style: { fontSize: 11, fill: colors.axis },
              }}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0 || typeof label !== 'string') {
                  return null;
                }
                const consumption = (payload[0]?.value as number) ?? 0;
                const capacity = (payload[1]?.value as number) ?? 0;
                const utilization = capacity > 0 ? (consumption / capacity) * 100 : 0;
                const monthEvents = eventsByMonth.get(label) ?? [];
                return (
                  <div className="rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-md">
                    <div className="font-medium">{formatMonth(label)}</div>
                    <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
                      <dt className="text-muted-foreground">Consumption</dt>
                      <dd className="text-right font-mono tabular-nums">
                        {numberFormat.format(consumption)} GB
                      </dd>
                      <dt className="text-muted-foreground">Capacity</dt>
                      <dd className="text-right font-mono tabular-nums">
                        {numberFormat.format(capacity)} GB
                      </dd>
                      <dt className="text-muted-foreground">Utilization</dt>
                      <dd className="text-right font-mono tabular-nums">
                        {utilization.toFixed(1)}%
                      </dd>
                    </dl>
                    {monthEvents.length > 0 ? (
                      <ul className="mt-2 space-y-1 border-t border-border pt-2">
                        {monthEvents.map((event) => (
                          <li key={event.id} className="flex items-center gap-2">
                            <span
                              aria-hidden
                              className="h-2 w-2 rounded-full"
                              style={{ background: colors.event[event.category] }}
                            />
                            <span className="flex-1 truncate">{event.title}</span>
                            <span className="font-mono tabular-nums text-muted-foreground">
                              {formatDelta(event.consumptionDelta, event.capacityDelta)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                );
              }}
            />
            <Area
              type="monotone"
              dataKey="consumption"
              name="Consumption"
              stroke={colors.consumption}
              strokeWidth={2}
              fill="url(#forecast-consumption)"
              isAnimationActive={false}
            />
            <Line
              type="stepAfter"
              dataKey="capacity"
              name="Capacity"
              stroke={colors.capacity}
              strokeWidth={1.75}
              strokeDasharray="4 3"
              dot={false}
              isAnimationActive={false}
            />
            {forecast.events.map((event) => {
              const monthKey = `${event.effectiveDate.slice(0, 7)}-01`;
              const datum = data.find((d) => d.month === monthKey);
              if (!datum) return null;
              return (
                <ReferenceDot
                  key={event.id}
                  x={monthKey}
                  y={datum.consumption}
                  r={5}
                  fill={colors.event[event.category]}
                  stroke="var(--card)"
                  strokeWidth={1.5}
                  isFront
                  ifOverflow="extendDomain"
                />
              );
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <ChartLegend events={forecast.events} colors={colors} />
    </Card>
  );
}

function formatDelta(consumption: number | null, capacity: number | null): string {
  const parts: string[] = [];
  if (consumption !== null) {
    parts.push(`${consumption >= 0 ? '+' : ''}${numberFormat.format(consumption)} cons`);
  }
  if (capacity !== null) {
    parts.push(`${capacity >= 0 ? '+' : ''}${numberFormat.format(capacity)} cap`);
  }
  return parts.length === 0 ? '—' : parts.join(' · ');
}

interface ChartLegendProps {
  events: ForecastResponse['events'];
  colors: ReturnType<typeof useChartColors>;
}

function ChartLegend({ events, colors }: ChartLegendProps): React.JSX.Element {
  const categories = Array.from(new Set(events.map((e) => e.category)));
  return (
    <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
      <LegendItem swatch={colors.consumption} label="Consumption" />
      <LegendItem swatch={colors.capacity} label="Capacity ceiling" dashed />
      {categories.length > 0 ? (
        <span aria-hidden className="mx-1">
          ·
        </span>
      ) : null}
      {categories.map((category) => (
        <LegendItem
          key={category}
          swatch={colors.event[category]}
          label={categoryLabel(category)}
          dot
        />
      ))}
    </div>
  );
}

function LegendItem({
  swatch,
  label,
  dot,
  dashed,
}: {
  swatch: string;
  label: string;
  dot?: boolean;
  dashed?: boolean;
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden
        className={dot ? 'h-2 w-2 rounded-full' : 'h-0 w-4 border-t-2'}
        style={
          dot
            ? { background: swatch }
            : { borderColor: swatch, borderStyle: dashed ? 'dashed' : 'solid' }
        }
      />
      <span>{label}</span>
    </span>
  );
}

function categoryLabel(category: EventCategory): string {
  switch (category) {
    case 'growth':
      return 'Growth';
    case 'hardware_change':
      return 'Hardware';
    case 'openshift':
      return 'OpenShift';
    case 'note':
      return 'Note';
  }
}
```

- [ ] **Step 3: Refactor `apps/web/src/components/sparkline.tsx`**

Replace with:

```tsx
import { useChartColors } from '@/lib/use-chart-colors';
import { cn } from '@/lib/utils';

interface SparklineProps {
  /** Numeric series, oldest to newest. */
  values: number[];
  /** Optional second series rendered as a stepped ceiling line. */
  ceiling?: number[];
  width?: number;
  height?: number;
  className?: string;
}

export function Sparkline({
  values,
  ceiling,
  width = 120,
  height = 28,
  className,
}: SparklineProps): React.JSX.Element | null {
  const colors = useChartColors();
  if (values.length < 2) return null;

  const allPoints = ceiling ? [...values, ...ceiling] : values;
  const min = Math.min(...allPoints);
  const max = Math.max(...allPoints);
  const span = max - min || 1;
  const padX = 2;
  const padY = 2;
  const usableW = width - padX * 2;
  const usableH = height - padY * 2;

  const project = (vals: number[]): string =>
    vals
      .map((v, i) => {
        const x = padX + (i / (vals.length - 1)) * usableW;
        const y = padY + usableH - ((v - min) / span) * usableH;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('overflow-visible', className)}
      role="img"
      aria-label="12 month utilization trend"
    >
      {ceiling ? (
        <path
          d={project(ceiling)}
          fill="none"
          stroke={colors.capacity}
          strokeWidth="1.25"
          strokeDasharray="3 2"
          strokeLinecap="round"
        />
      ) : null}
      <path
        d={project(values)}
        fill="none"
        stroke={colors.consumption}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
```

- [ ] **Step 4: Refactor `apps/web/src/components/clusters/utilization-panel.tsx`**

Replace with:

```tsx
import type { ForecastResponse } from '@lcm/shared';
import {
  Bar,
  BarChart,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useChartColors, type ChartColors } from '@/lib/use-chart-colors';

interface UtilizationPanelProps {
  forecast: ForecastResponse;
}

function formatMonth(month: string): string {
  const date = new Date(`${month}T00:00:00Z`);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });
}

function utilizationColor(value: number, colors: ChartColors): string {
  if (value >= 0.9) return colors.utilizationCrit;
  if (value >= 0.7) return colors.utilizationWarn;
  return colors.utilizationOk;
}

export function UtilizationPanel({ forecast }: UtilizationPanelProps): React.JSX.Element {
  const colors = useChartColors();
  const data = forecast.months.map((point) => ({
    month: point.month,
    pct: Number((point.utilization * 100).toFixed(1)),
  }));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0">
        <CardTitle>Monthly utilization</CardTitle>
        <span className="text-xs text-muted-foreground">% capacity used</span>
      </CardHeader>
      <CardContent className="pt-2">
        <div className="h-[140px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
              <XAxis
                dataKey="month"
                tickFormatter={formatMonth}
                tick={{ fontSize: 10 }}
                stroke={colors.axis}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis
                domain={[0, (max: number) => Math.max(100, Math.ceil(max / 10) * 10)]}
                tick={{ fontSize: 10 }}
                stroke={colors.axis}
                tickFormatter={(v: number) => `${v}%`}
                width={36}
              />
              <ReferenceLine y={70} stroke={colors.utilizationWarn} strokeDasharray="2 2" />
              <ReferenceLine y={90} stroke={colors.utilizationCrit} strokeDasharray="2 2" />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload || payload.length === 0 || typeof label !== 'string') {
                    return null;
                  }
                  const pct = payload[0]?.value as number;
                  return (
                    <div className="rounded-md border border-border bg-popover p-2 text-xs text-popover-foreground shadow-md">
                      <div className="font-medium">{formatMonth(label)}</div>
                      <div className="font-mono tabular-nums text-muted-foreground">
                        {pct.toFixed(1)}%
                      </div>
                    </div>
                  );
                }}
              />
              <Bar dataKey="pct" isAnimationActive={false} radius={[2, 2, 0, 0]}>
                {data.map((entry) => (
                  <Cell key={entry.month} fill={utilizationColor(entry.pct / 100, colors)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @lcm/web test
```

Expected: existing `forecast-chart.test.tsx` continues to pass. (If it does string-matched legend assertions, those still work since labels are unchanged.)

- [ ] **Step 6: Manual visual check**

```bash
pnpm --filter @lcm/web dev
```

Visit a cluster detail page (e.g., create one if none exist). Toggle `<html class="dark">` in DevTools. Expected: chart strokes, axis labels, tooltip backgrounds, sparklines, and utilization bars all repaint. Stop the dev server.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/use-chart-colors.ts apps/web/src/components/sparkline.tsx apps/web/src/components/clusters/forecast-chart.tsx apps/web/src/components/clusters/utilization-panel.tsx
git commit -m "feat(web): theme-aware Recharts colors via useChartColors

Centralizes consumption, capacity, axis, grid, utilization-threshold,
and event-category colors behind a single hook that switches palette
on resolvedTheme. forecast-chart, sparkline, and utilization-panel
all consume it. Wraps the chart bodies in the new Card primitive."
```

---

## Task 6 — Sidebar, breadcrumbs, refreshed app shell

**Files:**

- Create: `apps/web/src/components/layout/sidebar.tsx`
- Create: `apps/web/src/components/layout/breadcrumbs.tsx`
- Modify: `apps/web/src/components/layout/app-shell.tsx`

**Goal:** Two-column layout with a collapsible left sidebar (state persisted) and a slim header with breadcrumbs, API health pill, and the theme toggle. The `⌘K` chip slot is included but stubbed until Task 8.

- [ ] **Step 1: Create `apps/web/src/components/layout/sidebar.tsx`**

```tsx
import { Link } from '@tanstack/react-router';
import { ChevronsLeft, ChevronsRight, LayoutDashboard, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

const STORAGE_KEY = 'sidebar';

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { to: '/settings', label: 'Settings', icon: Settings, exact: false },
] as const;

function readStored(): 'expanded' | 'collapsed' {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'collapsed') return 'collapsed';
  } catch {
    // ignore
  }
  return 'expanded';
}

export function Sidebar(): React.JSX.Element {
  const [state, setState] = useState<'expanded' | 'collapsed'>(() => readStored());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, state);
    } catch {
      // ignore
    }
  }, [state]);

  const collapsed = state === 'collapsed';

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col border-r border-border bg-card transition-[width] duration-150 ease-out',
        collapsed ? 'w-16' : 'w-60',
      )}
      aria-label="Primary navigation"
    >
      <nav className="flex-1 px-2 py-4">
        <ul className="flex flex-col gap-1">
          {navItems.map((item) => (
            <li key={item.to}>
              <Link
                to={item.to}
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground',
                  collapsed && 'justify-center px-0',
                )}
                activeProps={{
                  className: 'bg-muted text-foreground',
                }}
                activeOptions={{ exact: item.exact }}
                title={collapsed ? item.label : undefined}
              >
                <item.icon className="h-5 w-5 shrink-0" aria-hidden />
                {!collapsed && <span>{item.label}</span>}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="border-t border-border p-2">
        <button
          type="button"
          onClick={() => setState(collapsed ? 'expanded' : 'collapsed')}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground',
            collapsed && 'justify-center px-0',
          )}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <ChevronsRight className="h-4 w-4" />
          ) : (
            <>
              <ChevronsLeft className="h-4 w-4" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Create `apps/web/src/components/layout/breadcrumbs.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { Link, useMatches } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { Fragment } from 'react';

import { api } from '@/lib/api-client';

interface Crumb {
  label: string;
  to?: string;
  /** Indicates the label is loading and should render a skeleton. */
  pending?: boolean;
}

function useClusterCrumb(clusterId: string | undefined): Crumb {
  const query = useQuery({
    queryKey: ['cluster', clusterId],
    queryFn: () => api.clusters.get(clusterId!),
    enabled: Boolean(clusterId),
  });
  if (!clusterId) return { label: '' };
  if (query.isPending) return { label: 'Loading…', pending: true };
  if (query.isError || !query.data) return { label: clusterId };
  return { label: query.data.name };
}

export function Breadcrumbs(): React.JSX.Element | null {
  const matches = useMatches();
  const last = matches[matches.length - 1];
  if (!last) return null;

  const path = last.pathname;
  const clusterId =
    'id' in (last.params as Record<string, unknown>)
      ? (last.params as { id?: string }).id
      : undefined;
  const clusterCrumb = useClusterCrumb(clusterId);

  const crumbs: Crumb[] = (() => {
    if (path === '/' || path === '') {
      return [{ label: 'Dashboard' }];
    }
    if (path.startsWith('/clusters/new')) {
      return [{ label: 'Dashboard', to: '/' }, { label: 'New cluster' }];
    }
    if (path.startsWith('/clusters/') && clusterId) {
      return [{ label: 'Dashboard', to: '/' }, clusterCrumb];
    }
    if (path.startsWith('/settings')) {
      return [{ label: 'Settings' }];
    }
    return [{ label: 'Dashboard', to: '/' }];
  })();

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        return (
          <Fragment key={`${crumb.label}-${index}`}>
            {index > 0 && (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
            )}
            {crumb.pending ? (
              <span
                aria-hidden
                className="inline-block h-4 w-24 animate-pulse rounded bg-muted align-middle"
              />
            ) : crumb.to && !isLast ? (
              <Link
                to={crumb.to}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                {crumb.label}
              </Link>
            ) : (
              <span className={isLast ? 'font-medium text-foreground' : 'text-muted-foreground'}>
                {crumb.label}
              </span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 3: Rewrite `apps/web/src/components/layout/app-shell.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet } from '@tanstack/react-router';
import { Activity } from 'lucide-react';

import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { Sidebar } from '@/components/layout/sidebar';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Badge } from '@/components/ui/badge';
import { Kbd } from '@/components/ui/kbd';
import { api } from '@/lib/api-client';

export function AppShell(): React.JSX.Element {
  return (
    <div className="flex h-full min-h-screen flex-col bg-background text-foreground">
      <Header />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-x-hidden">
          <div className="mx-auto w-full max-w-7xl px-6 py-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

function Header(): React.JSX.Element {
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-4 border-b border-border bg-card/95 px-4 backdrop-blur">
      <Link to="/" className="flex items-center gap-2 font-semibold">
        <Activity className="h-5 w-5 text-primary" aria-hidden />
        <span className="hidden sm:inline">Capacity Forecast</span>
      </Link>
      <div className="hidden h-6 w-px bg-border md:block" aria-hidden />
      <div className="hidden min-w-0 flex-1 md:block">
        <Breadcrumbs />
      </div>
      <div className="ml-auto flex items-center gap-2">
        <ApiHealthPill />
        <CommandPaletteTrigger />
        <ThemeToggle />
      </div>
    </header>
  );
}

function ApiHealthPill(): React.JSX.Element {
  const healthQuery = useQuery({
    queryKey: ['health'],
    queryFn: () => api.health.live(),
    refetchInterval: 30_000,
  });
  if (healthQuery.status === 'pending') {
    return (
      <Badge variant="secondary" className="hidden sm:inline-flex">
        API: checking…
      </Badge>
    );
  }
  if (healthQuery.status === 'error') {
    return (
      <Badge variant="danger" dot className="hidden sm:inline-flex">
        API: unreachable
      </Badge>
    );
  }
  return (
    <Badge variant="success" dot className="hidden sm:inline-flex">
      API: {healthQuery.data?.status}
    </Badge>
  );
}

function CommandPaletteTrigger(): React.JSX.Element {
  // Wired up in Task 8 — the global keyboard handler dispatches a CustomEvent
  // that the palette listens for. For now this is a no-op button that displays
  // the discoverable shortcut.
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent('lcm:open-command-palette'))}
      className="hidden items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:inline-flex"
      aria-label="Open command palette"
    >
      <span>Search</span>
      <span className="flex items-center gap-0.5">
        <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
        <Kbd>K</Kbd>
      </span>
    </button>
  );
}
```

This also removes the previous health-pill duty from `routes/index.tsx` — that file no longer needs to render it. We'll update that route in Task 7.

- [ ] **Step 4: Run typecheck and tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web test
```

Expected: typecheck passes. Tests pass — `cluster-table.test.tsx`, `create-cluster-dialog.test.tsx`, and `forecast-chart.test.tsx` render their components in isolation without the app shell, so they're unaffected.

- [ ] **Step 5: Manual visual check**

```bash
pnpm --filter @lcm/web dev
```

Expected: header is slim with the logo on the left, breadcrumb in the middle, health pill + a stub "Search ⌘K" chip + theme toggle on the right. Sidebar on the left with Dashboard + Settings. Collapse button at the bottom of the sidebar toggles width; refreshing the page preserves the state. Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/layout/sidebar.tsx apps/web/src/components/layout/breadcrumbs.tsx apps/web/src/components/layout/app-shell.tsx
git commit -m "feat(web): sidebar layout, breadcrumbs, refreshed header

Replaces the top-nav bar with a slim 56px header (logo, breadcrumbs,
health pill, ⌘K trigger, theme toggle) above a two-column shell with
a collapsible 240/64px sidebar. Sidebar collapse state persists in
localStorage. ⌘K trigger dispatches a window CustomEvent the palette
will listen for in a later task."
```

---

## Task 7 — Apply Card primitive across routes, refresh empty/error states

**Files:**

- Modify: `apps/web/src/components/clusters/cluster-table.tsx`
- Modify: `apps/web/src/components/clusters/empty-state.tsx`
- Modify: `apps/web/src/routes/index.tsx`
- Modify: `apps/web/src/routes/clusters.$id.tsx`

**Goal:** Replace inline `rounded-lg border bg-card …` literals with the new `Card` primitive, give error states a consistent look, and adjust the dashboard page now that the header owns the health pill.

- [ ] **Step 1: Update `cluster-table.tsx` to wrap in Card and use mono numerals**

In `apps/web/src/components/clusters/cluster-table.tsx`:

Replace this block:

```tsx
  return (
    <div className="rounded-lg border bg-card">
      <Table>
```

with:

```tsx
  return (
    <Card className="overflow-hidden">
      <Table>
```

Replace the closing:

```tsx
        </TableBody>
      </Table>
    </div>
  );
```

with:

```tsx
        </TableBody>
      </Table>
    </Card>
  );
```

Add the import at the top:

```tsx
import { Card } from '@/components/ui/card';
```

Then update the two `TableCell` lines that already use `tabular-nums` to also use `font-mono`:

```tsx
                <TableCell className="text-right font-mono tabular-nums">
                  {metric ? numberFormat.format(Math.round(metric.currentConsumption)) : '—'}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {metric ? numberFormat.format(Math.round(metric.currentCapacity)) : '—'}
                </TableCell>
```

Add a row hover affordance to `TableRow` for non-header rows. Update the row:

```tsx
              <TableRow key={cluster.id} className="hover:bg-muted/50">
```

- [ ] **Step 2: Update `empty-state.tsx`**

Replace `apps/web/src/components/clusters/empty-state.tsx`:

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Database } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api-client';

import { CreateClusterDialog } from './create-cluster-dialog';

const REFERENCE_CLUSTERS = [
  { name: 'CL-DMZ-P1', baselineConsumption: 3378, baselineCapacity: 7680 },
  { name: 'CL-Prod-P2', baselineConsumption: 19188, baselineCapacity: 40960 },
  { name: 'CL-Test-P2', baselineConsumption: 3345, baselineCapacity: 8192 },
  { name: 'CL-Prod-P2-Oracle', baselineConsumption: 1564, baselineCapacity: 4096 },
];

export function ClustersEmptyState(): React.JSX.Element {
  const queryClient = useQueryClient();
  const seedMutation = useMutation({
    mutationFn: async () => {
      for (const cluster of REFERENCE_CLUSTERS) {
        await api.clusters.create({
          name: cluster.name,
          baselineDate: '2026-05-01',
          baselines: [
            {
              metricTypeKey: 'memory_gb',
              baselineConsumption: cluster.baselineConsumption,
              baselineCapacity: cluster.baselineCapacity,
            },
          ],
        });
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['clusters'] });
      toast.success(`Seeded ${REFERENCE_CLUSTERS.length} reference clusters`);
    },
    onError: () => toast.error('Seed failed — some clusters may already exist'),
  });

  return (
    <Card className="flex flex-col items-center justify-center border-dashed p-12 text-center">
      <Database className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden />
      <h2 className="text-lg font-semibold">No clusters yet</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Add a cluster to start tracking memory capacity and forecasting growth.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <CreateClusterDialog />
        {import.meta.env.DEV ? (
          <Button
            variant="outline"
            disabled={seedMutation.isPending}
            onClick={() => seedMutation.mutate()}
          >
            {seedMutation.isPending ? 'Seeding…' : 'Seed sample data (dev)'}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
```

- [ ] **Step 3: Update `routes/index.tsx` — health pill moved out, error card uses Card**

Replace `apps/web/src/routes/index.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';

import { ClusterTable } from '@/components/clusters/cluster-table';
import { CreateClusterDialog } from '@/components/clusters/create-cluster-dialog';
import { ClustersEmptyState } from '@/components/clusters/empty-state';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api-client';

export const Route = createFileRoute('/')({
  component: DashboardPage,
});

function DashboardPage(): React.JSX.Element {
  const clustersQuery = useQuery({
    queryKey: ['clusters'],
    queryFn: () => api.clusters.list(),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {clustersQuery.data?.length
              ? `${clustersQuery.data.length} clusters tracked`
              : 'Capacity forecasts across all tracked clusters.'}
          </p>
        </div>
        {clustersQuery.data && clustersQuery.data.length > 0 ? <CreateClusterDialog /> : null}
      </div>

      {clustersQuery.isPending ? <ClusterTableSkeleton /> : null}

      {clustersQuery.isError ? (
        <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>Could not load clusters: {clustersQuery.error.message}</span>
        </Card>
      ) : null}

      {clustersQuery.data?.length === 0 ? <ClustersEmptyState /> : null}

      {clustersQuery.data && clustersQuery.data.length > 0 ? (
        <ClusterTable clusters={clustersQuery.data} />
      ) : null}
    </div>
  );
}

function ClusterTableSkeleton(): React.JSX.Element {
  return (
    <Card className="p-4">
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded bg-muted" />
        ))}
      </div>
    </Card>
  );
}
```

- [ ] **Step 4: Update `routes/clusters.$id.tsx` — header simplified, error card uses Card**

The breadcrumb in the header already shows the cluster name, so the previous in-page back link becomes redundant. Replace `apps/web/src/routes/clusters.$id.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';

import { ApplicationsTab } from '@/components/clusters/applications-tab';
import { EventsTab } from '@/components/clusters/events-tab';
import { ForecastChart } from '@/components/clusters/forecast-chart';
import { HostsTab } from '@/components/clusters/hosts-tab';
import { UtilizationBadge } from '@/components/clusters/utilization-badge';
import { UtilizationPanel } from '@/components/clusters/utilization-panel';
import {
  WindowControls,
  resolveWindow,
  type ForecastWindow,
} from '@/components/clusters/window-controls';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api-client';

export const Route = createFileRoute('/clusters/$id')({
  component: ClusterDetailPage,
});

function ClusterDetailPage(): React.JSX.Element {
  const { id } = Route.useParams();
  const [windowSelection, setWindowSelection] = useState<ForecastWindow>('24mo');

  const clusterQuery = useQuery({
    queryKey: ['cluster', id],
    queryFn: () => api.clusters.get(id),
  });

  const baselineDate = clusterQuery.data?.baselineDate;
  const metric = clusterQuery.data?.metrics[0];
  const range = baselineDate ? resolveWindow(windowSelection, baselineDate) : null;

  const forecastQuery = useQuery({
    queryKey: ['forecast', id, metric?.metricTypeKey, range?.from, range?.to],
    queryFn: () =>
      api.clusters.forecast(id, {
        metric: metric!.metricTypeKey,
        from: range!.from,
        to: range!.to,
      }),
    enabled: Boolean(metric && range),
  });

  return (
    <div className="space-y-6">
      <div>
        {clusterQuery.isPending ? (
          <HeaderSkeleton />
        ) : clusterQuery.isError || !clusterQuery.data ? (
          <ErrorCard message={clusterQuery.error?.message ?? 'Cluster not found'} />
        ) : (
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{clusterQuery.data.name}</h1>
              <p className="text-sm text-muted-foreground">
                Baseline {clusterQuery.data.baselineDate}
                {clusterQuery.data.description ? ` · ${clusterQuery.data.description}` : null}
              </p>
            </div>
            {metric ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Current utilization</span>
                <UtilizationBadge value={metric.utilization} />
              </div>
            ) : null}
          </div>
        )}
      </div>

      {clusterQuery.data && metric ? (
        <>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Capacity forecast</h2>
            <WindowControls value={windowSelection} onChange={setWindowSelection} />
          </div>

          {forecastQuery.isPending ? (
            <ChartSkeleton />
          ) : forecastQuery.isError || !forecastQuery.data ? (
            <ErrorCard message={forecastQuery.error?.message ?? 'Could not load forecast'} />
          ) : (
            <>
              <ForecastChart forecast={forecastQuery.data} />
              <UtilizationPanel forecast={forecastQuery.data} />
            </>
          )}

          <Tabs defaultValue="hosts" className="pt-2">
            <TabsList>
              <TabsTrigger value="hosts">Hosts</TabsTrigger>
              <TabsTrigger value="applications">Applications</TabsTrigger>
              <TabsTrigger value="events">Events</TabsTrigger>
            </TabsList>
            <TabsContent value="hosts">
              <HostsTab clusterId={id} />
            </TabsContent>
            <TabsContent value="applications">
              <ApplicationsTab clusterId={id} />
            </TabsContent>
            <TabsContent value="events">
              <EventsTab clusterId={id} />
            </TabsContent>
          </Tabs>
        </>
      ) : null}
    </div>
  );
}

function HeaderSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="h-7 w-48 animate-pulse rounded bg-muted" />
      <div className="h-4 w-64 animate-pulse rounded bg-muted" />
    </div>
  );
}

function ChartSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <Card className="h-[320px] animate-pulse" />
      <Card className="h-[140px] animate-pulse" />
    </div>
  );
}

function ErrorCard({ message }: { message: string }): React.JSX.Element {
  return (
    <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </Card>
  );
}
```

- [ ] **Step 5: Leave `routes/settings.tsx` and `routes/clusters.new.tsx` alone**

Both routes are currently stubs (an `<h1>` and a short paragraph each — `clusters.new.tsx` literally says "Form arrives in #13"). Wrapping a heading in a card is busywork; skip these files in this refresh and revisit when the real content lands. No change to the file map for this step.

- [ ] **Step 6: Run typecheck + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web test
```

Expected: pass. `cluster-table.test.tsx` still works since the Card wrapper is transparent to text-based assertions.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/clusters/cluster-table.tsx apps/web/src/components/clusters/empty-state.tsx apps/web/src/routes/index.tsx 'apps/web/src/routes/clusters.$id.tsx'
git commit -m "feat(web): adopt Card primitive across routes, refresh error states

Wraps the cluster table, empty state, error cards, and chart
skeletons in the new Card primitive. Replaces back-link on the
detail page (the header breadcrumb handles that now). Adds
AlertTriangle to error cards for icon-level redundancy. Mono
numerals on the consumption/capacity columns."
```

---

## Task 8 — Command palette, shortcuts dialog, keyboard handler

**Files:**

- Create: `apps/web/src/components/command/command-palette.tsx`
- Create: `apps/web/src/components/command/shortcuts-dialog.tsx`
- Create: `apps/web/src/components/command/keyboard-shortcuts.tsx`
- Create: `apps/web/src/__tests__/command-palette.test.tsx`
- Modify: `apps/web/src/app.tsx`

**Goal:** `⌘K` (or `Ctrl+K`) opens a palette filtering across navigation, clusters, and actions. `?` opens the shortcuts dialog. `g d` / `g s` navigate. Selecting a cluster in the palette navigates to its detail page.

- [ ] **Step 1: Write the failing test for the command palette**

Create `apps/web/src/__tests__/command-palette.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';

import { CommandPalette } from '@/components/command/command-palette';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { api } from '@/lib/api-client';

vi.mock('@tanstack/react-router', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const navigateMock = vi.fn();

function wrap(node: React.ReactElement): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <ThemeProvider>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </ThemeProvider>
  );
}

describe('CommandPalette', () => {
  test('opens via window CustomEvent and filters cluster items', async () => {
    vi.spyOn(api.clusters, 'list').mockResolvedValue([
      {
        id: 'c1',
        name: 'CL-Prod-Alpha',
        baselineDate: '2026-01-01',
        description: null,
        tenantId: 'default',
        metrics: [],
      } as Awaited<ReturnType<typeof api.clusters.list>>[number],
      {
        id: 'c2',
        name: 'CL-Test-Beta',
        baselineDate: '2026-01-01',
        description: null,
        tenantId: 'default',
        metrics: [],
      } as Awaited<ReturnType<typeof api.clusters.list>>[number],
    ]);
    const user = userEvent.setup();
    render(wrap(<CommandPalette />));

    window.dispatchEvent(new CustomEvent('lcm:open-command-palette'));

    const input = await screen.findByPlaceholderText(/search/i);
    await user.type(input, 'Alpha');

    await waitFor(() => {
      expect(screen.getByText('CL-Prod-Alpha')).toBeInTheDocument();
      expect(screen.queryByText('CL-Test-Beta')).not.toBeInTheDocument();
    });
  });

  test('selecting a cluster item navigates to its detail route', async () => {
    vi.spyOn(api.clusters, 'list').mockResolvedValue([
      {
        id: 'cluster-xyz',
        name: 'CL-One',
        baselineDate: '2026-01-01',
        description: null,
        tenantId: 'default',
        metrics: [],
      } as Awaited<ReturnType<typeof api.clusters.list>>[number],
    ]);
    const user = userEvent.setup();
    render(wrap(<CommandPalette />));

    window.dispatchEvent(new CustomEvent('lcm:open-command-palette'));
    const input = await screen.findByPlaceholderText(/search/i);
    await user.type(input, 'CL-One');
    await screen.findByText('CL-One');
    await user.keyboard('{Enter}');

    expect(navigateMock).toHaveBeenCalledWith({
      to: '/clusters/$id',
      params: { id: 'cluster-xyz' },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @lcm/web test -- command-palette
```

Expected: FAIL with "Cannot find module '@/components/command/command-palette'".

- [ ] **Step 3: Implement `command-palette.tsx`**

Create `apps/web/src/components/command/command-palette.tsx`:

```tsx
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import {
  LayoutDashboard,
  Monitor,
  Moon,
  Plus,
  Server,
  Settings,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { useTheme, type Theme } from '@/components/theme/use-theme';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/utils';

const OPEN_EVENT = 'lcm:open-command-palette';
const CREATE_CLUSTER_EVENT = 'lcm:open-create-cluster';
const SHORTCUTS_EVENT = 'lcm:open-shortcuts';

export function CommandPalette(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const navigate = useNavigate();
  const { setTheme } = useTheme();

  const clustersQuery = useQuery({
    queryKey: ['clusters'],
    queryFn: () => api.clusters.list(),
    enabled: open,
  });

  useEffect(() => {
    const onOpen = (): void => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  const runAndClose = (fn: () => void): void => {
    fn();
    setOpen(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            'fixed left-[50%] top-[20%] z-50 grid w-[92vw] max-w-[640px] translate-x-[-50%] gap-0',
            'overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          )}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command
            shouldFilter
            className="flex flex-col"
            label="Command palette"
            value={undefined}
            onValueChange={() => {}}
          >
            <div className="border-b border-border px-3">
              <Command.Input
                value={search}
                onValueChange={setSearch}
                placeholder="Search clusters, actions, navigation…"
                className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Command.List className="max-h-[60vh] overflow-y-auto py-2">
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
                No matches.
              </Command.Empty>

              <PaletteGroup heading="Navigation">
                <PaletteItem
                  icon={LayoutDashboard}
                  label="Go to dashboard"
                  hint="g d"
                  onSelect={() => runAndClose(() => navigate({ to: '/' }))}
                />
                <PaletteItem
                  icon={Settings}
                  label="Go to settings"
                  hint="g s"
                  onSelect={() => runAndClose(() => navigate({ to: '/settings' }))}
                />
              </PaletteGroup>

              {clustersQuery.data && clustersQuery.data.length > 0 ? (
                <PaletteGroup heading="Clusters">
                  {clustersQuery.data.map((cluster) => (
                    <PaletteItem
                      key={cluster.id}
                      icon={Server}
                      label={cluster.name}
                      onSelect={() =>
                        runAndClose(() =>
                          navigate({ to: '/clusters/$id', params: { id: cluster.id } }),
                        )
                      }
                    />
                  ))}
                </PaletteGroup>
              ) : null}

              <PaletteGroup heading="Actions">
                <PaletteItem
                  icon={Plus}
                  label="Create cluster"
                  onSelect={() =>
                    runAndClose(() => window.dispatchEvent(new CustomEvent(CREATE_CLUSTER_EVENT)))
                  }
                />
                <PaletteItem
                  icon={Settings}
                  label="View keyboard shortcuts"
                  hint="?"
                  onSelect={() =>
                    runAndClose(() => window.dispatchEvent(new CustomEvent(SHORTCUTS_EVENT)))
                  }
                />
              </PaletteGroup>

              <PaletteGroup heading="Theme">
                <PaletteItem
                  icon={Monitor}
                  label="Use system theme"
                  onSelect={() => runAndClose(() => setTheme('system' as Theme))}
                />
                <PaletteItem
                  icon={Sun}
                  label="Use light theme"
                  onSelect={() => runAndClose(() => setTheme('light' as Theme))}
                />
                <PaletteItem
                  icon={Moon}
                  label="Use dark theme"
                  onSelect={() => runAndClose(() => setTheme('dark' as Theme))}
                />
              </PaletteGroup>
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface PaletteGroupProps {
  heading: string;
  children: React.ReactNode;
}

function PaletteGroup({ heading, children }: PaletteGroupProps): React.JSX.Element {
  return (
    <Command.Group
      heading={heading}
      className="px-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground"
    >
      {children}
    </Command.Group>
  );
}

interface PaletteItemProps {
  icon: LucideIcon;
  label: string;
  hint?: string;
  onSelect: () => void;
}

function PaletteItem({ icon: Icon, label, hint, onSelect }: PaletteItemProps): React.JSX.Element {
  return (
    <Command.Item
      value={label}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-foreground aria-selected:bg-accent aria-selected:text-accent-foreground"
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex-1">{label}</span>
      {hint ? <span className="font-mono text-[10px] text-muted-foreground">{hint}</span> : null}
    </Command.Item>
  );
}
```

- [ ] **Step 4: Run the palette test to verify it passes**

```bash
pnpm --filter @lcm/web test -- command-palette
```

Expected: PASS.

- [ ] **Step 5: Implement `shortcuts-dialog.tsx`**

Create `apps/web/src/components/command/shortcuts-dialog.tsx`:

```tsx
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';

import { Kbd } from '@/components/ui/kbd';

const OPEN_EVENT = 'lcm:open-shortcuts';

interface Row {
  keys: string[];
  label: string;
}

const ROWS: Row[] = [
  { keys: ['⌘', 'K'], label: 'Open command palette' },
  { keys: ['?'], label: 'Show this shortcuts list' },
  { keys: ['Esc'], label: 'Close any modal' },
  { keys: ['g', 'd'], label: 'Go to dashboard' },
  { keys: ['g', 's'], label: 'Go to settings' },
];

export function ShortcutsDialog(): React.JSX.Element {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (): void => setOpen(true);
    window.addEventListener(OPEN_EVENT, handler);
    return () => window.removeEventListener(OPEN_EVENT, handler);
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-[50%] top-[50%] z-50 w-[92vw] max-w-md translate-x-[-50%] translate-y-[-50%] rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-xl">
          <Dialog.Title className="text-base font-semibold">Keyboard shortcuts</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">
            All shortcuts work when no input is focused.
          </Dialog.Description>
          <ul className="mt-4 space-y-2.5 text-sm">
            {ROWS.map((row) => (
              <li key={row.label} className="flex items-center justify-between gap-4">
                <span>{row.label}</span>
                <span className="flex items-center gap-0.5">
                  {row.keys.map((k, i) => (
                    <Kbd key={`${row.label}-${i}`}>{k}</Kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 6: Implement `keyboard-shortcuts.tsx`**

Create `apps/web/src/components/command/keyboard-shortcuts.tsx`:

```tsx
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

const SEQUENCE_TIMEOUT_MS = 1000;

export function KeyboardShortcuts(): React.JSX.Element {
  const navigate = useNavigate();
  const pendingPrefix = useRef<string | null>(null);
  const pendingTimer = useRef<number | null>(null);

  useEffect(() => {
    const clearPrefix = (): void => {
      pendingPrefix.current = null;
      if (pendingTimer.current !== null) {
        window.clearTimeout(pendingTimer.current);
        pendingTimer.current = null;
      }
    };

    const handler = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target)) return;

      // Cmd+K / Ctrl+K — open palette
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('lcm:open-command-palette'));
        clearPrefix();
        return;
      }

      // No modifiers from here on
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === '?') {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('lcm:open-shortcuts'));
        clearPrefix();
        return;
      }

      // Vim-style two-key sequences
      if (pendingPrefix.current === 'g') {
        if (event.key === 'd') {
          event.preventDefault();
          navigate({ to: '/' });
        } else if (event.key === 's') {
          event.preventDefault();
          navigate({ to: '/settings' });
        }
        clearPrefix();
        return;
      }

      if (event.key === 'g') {
        pendingPrefix.current = 'g';
        pendingTimer.current = window.setTimeout(clearPrefix, SEQUENCE_TIMEOUT_MS);
      }
    };

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      clearPrefix();
    };
  }, [navigate]);

  return <></>;
}
```

- [ ] **Step 7: Wire the create-cluster event in `create-cluster-dialog.tsx`**

The palette dispatches `lcm:open-create-cluster` when the "Create cluster" action is selected. `create-cluster-dialog.tsx` already controls its own open state via `const [open, setOpen] = useState(false)`; we just add a listener.

In `apps/web/src/components/clusters/create-cluster-dialog.tsx`, update the React import on line 3:

```tsx
import { useEffect, useState, type FormEvent } from 'react';
```

Then immediately after the existing `const [fieldErrors, setFieldErrors] = useState<…>({});` line (currently line 44), add:

```tsx
useEffect(() => {
  const handler = (): void => setOpen(true);
  window.addEventListener('lcm:open-create-cluster', handler);
  return () => window.removeEventListener('lcm:open-create-cluster', handler);
}, []);
```

The effect captures `setOpen` stably (React guarantees setter identity), so the empty dependency array is correct.

- [ ] **Step 8: Mount palette + shortcuts + handler in `app.tsx`**

Edit `apps/web/src/app.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter } from '@tanstack/react-router';

import { CommandPalette } from '@/components/command/command-palette';
import { KeyboardShortcuts } from '@/components/command/keyboard-shortcuts';
import { ShortcutsDialog } from '@/components/command/shortcuts-dialog';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';

import { routeTree } from './routeTree.gen';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function App(): React.JSX.Element {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={200}>
          <RouterProvider router={router} />
          <CommandPalette />
          <ShortcutsDialog />
          <KeyboardShortcuts />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
```

The `TooltipProvider` is needed once at the app root so every `Tooltip` works without local wiring.

- [ ] **Step 9: Run all tests**

```bash
pnpm --filter @lcm/web test
```

Expected: all green, including the new palette test.

- [ ] **Step 10: Manual visual check**

```bash
pnpm --filter @lcm/web dev
```

Verify:

- `⌘K` (Mac) or `Ctrl+K` opens the palette; clusters appear; typing filters them; pressing Enter on a cluster row navigates.
- `?` opens the shortcuts dialog; `Esc` closes it.
- `g` then `d` navigates to dashboard; `g` then `s` navigates to settings.
- `g` then any other key resets the prefix; pressing `g` and waiting >1s also resets.
- Toggling theme via the palette persists across reload.
- The header "Search ⌘K" chip also opens the palette.

Stop the dev server.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/components/command/ apps/web/src/components/clusters/create-cluster-dialog.tsx apps/web/src/__tests__/command-palette.test.tsx apps/web/src/app.tsx
git commit -m "feat(web): ⌘K command palette, shortcuts dialog, global keys

Adds cmdk-powered palette (navigation, clusters, actions, theme),
a ? shortcuts dialog, and a single keyboard-shortcuts component
that handles ⌘K, ?, and vim-like 'g d' / 'g s' sequences. Wires
the create-cluster dialog to listen for a window CustomEvent so
the palette can trigger it. Adds TooltipProvider at the app root."
```

---

## Task 9 — Playwright update + full verification

**Files:**

- Modify: `apps/web/playwright/golden-path.spec.ts`

**Goal:** Append a small theme-toggle assertion to the e2e golden path, then run every verification command end-to-end.

- [ ] **Step 1: Append theme-toggle assertion to the Playwright spec**

Edit `apps/web/playwright/golden-path.spec.ts`. Right after the existing successful golden-path assertions (before the `finally` block), add:

```ts
// Theme toggle round-trip: cycle system → light → dark → system.
const toggle = page.getByRole('button', { name: /Theme:/ });
await toggle.click();
await expect(page.locator('html')).not.toHaveClass(/dark/);
await toggle.click();
await expect(page.locator('html')).toHaveClass(/dark/);
await toggle.click();
// Back to system — class state depends on the host OS preference, so just
// assert the aria-label reads "System".
await expect(toggle).toHaveAccessibleName(/Theme: System/);
```

This block depends on the initial theme being `system` (no prior localStorage entry). To guarantee that, prepend before `page.goto('/')`:

```ts
await page.addInitScript(() => {
  try {
    localStorage.removeItem('theme');
  } catch {}
});
```

- [ ] **Step 2: Bring up the dev DB if needed**

The Playwright spec talks to the API at `http://localhost:8090`. Start it if not already running:

```bash
docker compose -f docker-compose.dev.yml up -d db
pnpm --filter @lcm/api dev
```

(In a separate terminal.) Then start the web dev server:

```bash
pnpm --filter @lcm/web dev
```

- [ ] **Step 3: Run the Playwright test**

```bash
pnpm --filter @lcm/web test:e2e
```

Expected: golden-path spec passes including the new theme block.

- [ ] **Step 4: Run the full verification gauntlet**

```bash
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web test
pnpm --filter @lcm/web build
```

Expected: all four exit zero.

- [ ] **Step 5: Visual smoke test in both modes**

With the dev server still running:

- Open `http://localhost:5173` in a browser.
- Theme toggle → cycle through system / light / dark; observe header, sidebar, dashboard, cluster detail, charts, dialogs.
- Open `⌘K`, type a partial cluster name, hit Enter, land on detail page; back to dashboard via `g d`.
- Settings page opens via `g s` and the sidebar.
- Resize the sidebar (collapse/expand); refresh; state persists.
- Force an API error (stop the API briefly) and confirm the error card looks right in both modes; restart the API.

Stop both dev servers when satisfied.

- [ ] **Step 6: Commit**

```bash
git add apps/web/playwright/golden-path.spec.ts
git commit -m "test(web): cover theme toggle cycle in e2e golden path

Resets localStorage in an init script so the suite always starts on
system mode, then cycles light → dark → system via the header toggle
and asserts the html.dark class flips accordingly."
```

- [ ] **Step 7: Open a PR (user does this)**

Hand back to the user. They push and open the PR; the design spec is already on the branch (`c4e7284`) and the implementation commits stack on top.

---

## Acceptance verification checklist

After Task 9 step 4 passes, also confirm each spec acceptance criterion (from the spec's "Acceptance criteria" section):

1. ☐ App renders correctly in both light and dark with no flash on initial load (Task 1 + Task 2).
2. ☐ Theme toggle cycles `system → light → dark`, persists, and tracks OS changes when in `system` mode (Task 2 tests pass; manual cycle in Task 9).
3. ☐ Sidebar replaces top-nav row; breadcrumb in header reflects route and cluster name (Task 6 + Task 7).
4. ☐ `⌘K`/`Ctrl+K` opens palette; `?` opens shortcuts (Task 8 tests pass; manual in Task 9).
5. ☐ Recharts forecast + sparklines use theme-aware colors; no hardcoded `oklch(...)` literals remain in chart files (`rg "oklch\\(" apps/web/src/components/clusters apps/web/src/components/sparkline.tsx` returns no results — Task 5).
6. ☐ Status badges read correctly in both modes (Task 4 + manual).
7. ☐ `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build` all pass on the web workspace (Task 9 step 4).
8. ☐ No changes outside `apps/web/**` and the design docs (`git diff main --stat` confirms).

---

## Notes for the executor

- **TDD where useful, light touch elsewhere.** Tasks 2 and 8 are TDD with real unit tests because the logic is non-trivial (system listeners, palette filtering + navigation). Tasks 3, 4, 6, and 7 are presentational — verify by typecheck + manual visual rather than asserting against rendered DOM in unit tests. Don't write tests that lock in implementation details (e.g., specific class names).
- **Husky lint-staged will reformat your commits.** Don't fight it. If a commit fails on typecheck, fix the underlying issue and re-stage.
- **Recharts re-renders.** When the theme flips, `useChartColors()` returns a new object, which propagates new stroke/fill props down. With `isAnimationActive={false}` (already set), this is one paint.
- **Keep imports sorted.** The existing convention is: type-only imports first, then external libs (alphabetical), then `@/` imports (alphabetical). Prettier won't sort imports for you — match the surrounding files.
- **`rg "oklch\\(" apps/web/src`** is a useful guardrail. After Task 5 the only file containing OKLCH literals should be `apps/web/src/lib/use-chart-colors.ts` (and `apps/web/src/styles.css` which is the source of truth).
