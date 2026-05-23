# Mobile Responsiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app usable on phones (390–420 px) and small tablets without regressing the desktop experience.

**Architecture:** Collapse the inline sidebar into an overlay `<Sheet>` drawer below `lg:` (1024 px). Add a hamburger trigger in the header that shares state via a small context provider. Trim header chrome at `< sm:`. Make the KPI tile + cluster H1 wrap on any character (not just hyphens). Replace the clusters table with a card stack below `md:` (768 px). Charts get a `compact?: boolean` prop driven by `useMediaQuery('(min-width: 640px)')` that suppresses label text and tightens margins on phone widths.

**Tech Stack:** React 19 + TypeScript, Tailwind v4, `@radix-ui/react-dialog` (already in repo for Dialog), TanStack Router, Recharts, Vitest + Testing Library, Playwright.

**Spec:** [`docs/superpowers/specs/2026-05-23-mobile-responsive-design.md`](../specs/2026-05-23-mobile-responsive-design.md)

---

## File map

**New files**

- `apps/web/src/lib/use-media-query.ts` — `useMediaQuery(query: string): boolean` hook backed by `useSyncExternalStore`.
- `apps/web/src/__tests__/use-media-query.test.tsx` — unit tests.
- `apps/web/src/components/ui/sheet.tsx` — shadcn `Sheet` primitive (Radix Dialog under the hood) with `side="left"` slide animation.
- `apps/web/src/components/ui/sheet.test.tsx` — smoke test (open, close on Escape, close on backdrop click).
- `apps/web/src/components/layout/mobile-nav.tsx` — `<MobileNavProvider>`, `useMobileNav()`, `<MobileNavTrigger>`.
- `apps/web/src/components/layout/mobile-nav.test.tsx` — provider + trigger smoke test.
- `apps/web/src/components/clusters/cluster-list-card.tsx` — single mobile card variant of a clusters-table row.
- `apps/web/src/components/clusters/cluster-list-card.test.tsx` — smoke test.
- `apps/web/playwright/mobile.spec.ts` — Playwright spec for mobile viewport.

**Modified files**

- `apps/web/src/components/layout/sidebar.tsx` — extract `<SidebarNav>` sub-component, mark the inline aside `hidden lg:flex`, accept an optional `onNavigate` callback so links can close the sheet.
- `apps/web/src/components/layout/app-shell.tsx` — wrap children in `<MobileNavProvider>`, render the Sheet variant of the sidebar at `< lg:`, add `<MobileNavTrigger>` to the header, trim `<ApiHealthPill>` and `<CommandPaletteTrigger>` at `< sm:`.
- `apps/web/src/components/overview/kpi-tile.tsx` — value font becomes `text-2xl sm:text-3xl`, add `[overflow-wrap:anywhere]` on value and caption.
- `apps/web/src/routes/clusters.$id.tsx` — add `[overflow-wrap:anywhere]` to the H1; pass `compact` from `useMediaQuery` to `<ForecastChart>`.
- `apps/web/src/routes/index.tsx` — pass `compact` from `useMediaQuery` to `<FleetCapacityChart>`.
- `apps/web/src/components/clusters/cluster-table.tsx` — wrap the existing table in `hidden md:block` and render a `<div className="md:hidden">` with mapped `<ClusterListCard>` above it.
- `apps/web/src/components/overview/fleet-capacity-chart.tsx` — accept `compact?: boolean`; when set, suppress threshold-line label `value`, reduce `margin.right` to 16, drop axis tick `fontSize` to 10.
- `apps/web/src/components/clusters/forecast-chart.tsx` — same `compact` treatment.

---

## Task 1: `useMediaQuery` hook

**Files:**

- Create: `apps/web/src/lib/use-media-query.ts`
- Create test: `apps/web/src/__tests__/use-media-query.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/use-media-query.test.tsx`:

```tsx
import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMediaQuery } from '../lib/use-media-query';

interface FakeMediaQueryList {
  matches: boolean;
  media: string;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  listeners: Array<(e: { matches: boolean }) => void>;
}

const fakes = new Map<string, FakeMediaQueryList>();

function makeMatchMedia(): (query: string) => FakeMediaQueryList {
  return (query) => {
    if (!fakes.has(query)) {
      const listeners: FakeMediaQueryList['listeners'] = [];
      fakes.set(query, {
        matches: false,
        media: query,
        listeners,
        addEventListener: vi.fn((_event, cb: (e: { matches: boolean }) => void) => {
          listeners.push(cb);
        }),
        removeEventListener: vi.fn((_event, cb: (e: { matches: boolean }) => void) => {
          const idx = listeners.indexOf(cb);
          if (idx >= 0) listeners.splice(idx, 1);
        }),
      });
    }
    return fakes.get(query)!;
  };
}

beforeEach(() => {
  fakes.clear();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: makeMatchMedia(),
  });
});

afterEach(() => {
  fakes.clear();
});

describe('useMediaQuery', () => {
  it('returns the initial match value from matchMedia', () => {
    const { result } = renderHook(() => useMediaQuery('(min-width: 640px)'));
    expect(result.current).toBe(false);
  });

  it('subscribes to change events and updates when the match flips', () => {
    const { result } = renderHook(() => useMediaQuery('(min-width: 640px)'));
    const mql = fakes.get('(min-width: 640px)')!;
    expect(mql.listeners).toHaveLength(1);

    act(() => {
      mql.matches = true;
      for (const cb of mql.listeners) cb({ matches: true });
    });
    expect(result.current).toBe(true);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useMediaQuery('(min-width: 640px)'));
    const mql = fakes.get('(min-width: 640px)')!;
    expect(mql.removeEventListener).not.toHaveBeenCalled();
    unmount();
    expect(mql.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('returns false on the SSR snapshot when window is undefined', () => {
    const originalWindow = global.window;
    // Simulate SSR by removing window before reading the SSR snapshot.
    // We can't actually delete window in jsdom, but the hook's getServerSnapshot
    // is what useSyncExternalStore uses on the server, which we can call indirectly
    // by checking that the hook gracefully returns false when matchMedia is missing.
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
    const { result } = renderHook(() => useMediaQuery('(min-width: 999px)'));
    expect(result.current).toBe(false);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: originalWindow.matchMedia,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lcm/web test -- use-media-query`
Expected: FAIL — cannot resolve `'../lib/use-media-query'`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/use-media-query.ts`:

```ts
import { useSyncExternalStore } from 'react';

function subscribe(query: string): (callback: () => void) => () => void {
  return (callback) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return () => {};
    }
    const mql = window.matchMedia(query);
    mql.addEventListener('change', callback);
    return () => mql.removeEventListener('change', callback);
  };
}

function getSnapshot(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(query).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(subscribe(query), () => getSnapshot(query), getServerSnapshot);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @lcm/web test -- use-media-query`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/use-media-query.ts apps/web/src/__tests__/use-media-query.test.tsx
git commit -m "feat(web): useMediaQuery hook"
```

---

## Task 2: `Sheet` primitive (Radix-backed left-side drawer)

**Files:**

- Create: `apps/web/src/components/ui/sheet.tsx`
- Create test: `apps/web/src/components/ui/sheet.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/ui/sheet.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Sheet, SheetContent, SheetTrigger } from './sheet';

describe('<Sheet>', () => {
  it('opens via the trigger and closes on Escape', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open</SheetTrigger>
        <SheetContent aria-label="Nav">
          <a href="/">Home</a>
        </SheetContent>
      </Sheet>,
    );

    expect(screen.queryByRole('dialog', { name: 'Nav' })).toBeNull();
    await user.click(screen.getByText('Open'));
    expect(await screen.findByRole('dialog', { name: 'Nav' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Nav' })).toBeNull();
  });

  it('renders a close button inside the sheet content', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open</SheetTrigger>
        <SheetContent aria-label="Nav">
          <span>content</span>
        </SheetContent>
      </Sheet>,
    );

    await user.click(screen.getByText('Open'));
    const close = await screen.findByRole('button', { name: /close/i });
    await user.click(close);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lcm/web test -- sheet`
Expected: FAIL — cannot resolve `'./sheet'`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/components/ui/sheet.tsx`:

```tsx
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetPortal = DialogPrimitive.Portal;

export const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-40 bg-background/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
));
SheetOverlay.displayName = 'SheetOverlay';

export const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-0 top-0 z-50 flex h-full w-[260px] flex-col border-r border-border bg-card shadow-lg',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left',
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        aria-label="Close"
        className="absolute right-3 top-3 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-4 w-4" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = 'SheetContent';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @lcm/web test -- sheet`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/sheet.tsx apps/web/src/components/ui/sheet.test.tsx
git commit -m "feat(web): Sheet primitive (left-side drawer)"
```

---

## Task 3: `MobileNavProvider` + `useMobileNav` + `MobileNavTrigger`

**Files:**

- Create: `apps/web/src/components/layout/mobile-nav.tsx`
- Create test: `apps/web/src/components/layout/mobile-nav.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/layout/mobile-nav.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { MobileNavProvider, MobileNavTrigger, useMobileNav } from './mobile-nav';

function StateProbe(): React.JSX.Element {
  const { open } = useMobileNav();
  return <span data-testid="probe">{open ? 'open' : 'closed'}</span>;
}

describe('<MobileNavProvider> + <MobileNavTrigger>', () => {
  it('starts closed and opens when the trigger is clicked', async () => {
    const user = userEvent.setup();
    render(
      <MobileNavProvider>
        <MobileNavTrigger />
        <StateProbe />
      </MobileNavProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('closed');
    await user.click(screen.getByRole('button', { name: /open navigation/i }));
    expect(screen.getByTestId('probe')).toHaveTextContent('open');
  });

  it('exposes setOpen so consumers can close the sheet on navigation', async () => {
    function CloseProbe(): React.JSX.Element {
      const { setOpen } = useMobileNav();
      return (
        <button type="button" onClick={() => setOpen(false)}>
          close-from-probe
        </button>
      );
    }
    const user = userEvent.setup();
    render(
      <MobileNavProvider>
        <MobileNavTrigger />
        <CloseProbe />
        <StateProbe />
      </MobileNavProvider>,
    );
    await user.click(screen.getByRole('button', { name: /open navigation/i }));
    expect(screen.getByTestId('probe')).toHaveTextContent('open');
    await user.click(screen.getByText('close-from-probe'));
    expect(screen.getByTestId('probe')).toHaveTextContent('closed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lcm/web test -- mobile-nav`
Expected: FAIL — cannot resolve `'./mobile-nav'`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/components/layout/mobile-nav.tsx`:

```tsx
import { Menu } from 'lucide-react';
import { createContext, useContext, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';

interface MobileNavContextValue {
  open: boolean;
  setOpen: (next: boolean) => void;
}

const MobileNavContext = createContext<MobileNavContextValue | null>(null);

export function MobileNavProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ open, setOpen }), [open]);
  return <MobileNavContext.Provider value={value}>{children}</MobileNavContext.Provider>;
}

export function useMobileNav(): MobileNavContextValue {
  const value = useContext(MobileNavContext);
  if (!value) {
    throw new Error('useMobileNav must be used inside <MobileNavProvider>');
  }
  return value;
}

export function MobileNavTrigger(): React.JSX.Element {
  const { setOpen } = useMobileNav();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Open navigation"
      className="lg:hidden"
      onClick={() => setOpen(true)}
    >
      <Menu className="h-5 w-5" />
    </Button>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @lcm/web test -- mobile-nav`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/layout/mobile-nav.tsx apps/web/src/components/layout/mobile-nav.test.tsx
git commit -m "feat(web): MobileNavProvider + Trigger"
```

---

## Task 4: Extract `<SidebarNav>` + mark aside `hidden lg:flex`

**Files:**

- Modify: `apps/web/src/components/layout/sidebar.tsx`

- [ ] **Step 1: Rewrite the sidebar to expose a reusable nav component**

Overwrite `apps/web/src/components/layout/sidebar.tsx` with:

```tsx
import { Link } from '@tanstack/react-router';
import { ChevronsLeft, ChevronsRight, Database, LayoutPanelLeft, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

const STORAGE_KEY = 'sidebar';

const navItems = [
  { to: '/', label: 'Overview', icon: LayoutPanelLeft, exact: true },
  { to: '/clusters', label: 'Clusters', icon: Database, exact: false },
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

interface SidebarNavProps {
  collapsed?: boolean;
  onNavigate?: () => void;
}

export function SidebarNav({ collapsed = false, onNavigate }: SidebarNavProps): React.JSX.Element {
  return (
    <nav className="flex-1 px-2 py-4">
      <ul className="flex flex-col gap-1">
        {navItems.map((item) => (
          <li key={item.to}>
            <Link
              to={item.to}
              onClick={onNavigate}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground',
                collapsed && 'justify-center px-0',
              )}
              activeProps={{
                className: 'bg-muted text-foreground shadow-[inset_3px_0_0_0_var(--primary)]',
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
  );
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
        'hidden shrink-0 flex-col border-r border-border bg-card/60 backdrop-blur-xl transition-[width] duration-150 ease-out lg:flex',
        collapsed ? 'w-16' : 'w-60',
      )}
      aria-label="Primary navigation"
    >
      <SidebarNav collapsed={collapsed} />
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

- [ ] **Step 2: Verify**

Run: `pnpm --filter @lcm/web typecheck && pnpm --filter @lcm/web test && pnpm --filter @lcm/web lint`
Expected: green. No existing test consumes the sidebar directly; the AppShell test (if any) renders it but won't break because the public `<Sidebar>` export is unchanged.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/layout/sidebar.tsx
git commit -m "refactor(web): extract SidebarNav, hide aside below lg"
```

---

## Task 5: Wire AppShell — provider, sheet, hamburger, header trim

**Files:**

- Modify: `apps/web/src/components/layout/app-shell.tsx`

- [ ] **Step 1: Rewrite the AppShell**

Overwrite `apps/web/src/components/layout/app-shell.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet } from '@tanstack/react-router';
import { Activity, Search } from 'lucide-react';

import { CommandPalette } from '@/components/command/command-palette';
import { KeyboardShortcuts } from '@/components/command/keyboard-shortcuts';
import { ShortcutsDialog } from '@/components/command/shortcuts-dialog';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { MobileNavProvider, MobileNavTrigger, useMobileNav } from '@/components/layout/mobile-nav';
import { Sidebar, SidebarNav } from '@/components/layout/sidebar';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { api } from '@/lib/api-client';

export function AppShell(): React.JSX.Element {
  return (
    <MobileNavProvider>
      <div className="flex h-full min-h-screen flex-col bg-background text-foreground">
        <Header />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <MobileSidebarSheet />
          <main className="min-w-0 flex-1 overflow-x-hidden">
            <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
      <CommandPalette />
      <ShortcutsDialog />
      <KeyboardShortcuts />
    </MobileNavProvider>
  );
}

function MobileSidebarSheet(): React.JSX.Element {
  const { open, setOpen } = useMobileNav();
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent aria-label="Primary navigation">
        <SidebarNav onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}

function Header(): React.JSX.Element {
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-card/70 px-4 backdrop-blur-xl sm:gap-4">
      <MobileNavTrigger />
      <Link to="/" className="flex items-center gap-2.5 font-semibold">
        <span
          aria-hidden
          className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/70 shadow-[var(--shadow-card)]"
        >
          <Activity className="h-4 w-4 text-primary-foreground" />
        </span>
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

  const compact = (label: string, dotClass: string): React.JSX.Element => (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={`inline-flex h-2.5 w-2.5 items-center justify-center rounded-full sm:hidden ${dotClass}`}
    />
  );

  if (healthQuery.status === 'pending') {
    return (
      <>
        {compact('API: checking', 'bg-muted-foreground')}
        <Badge variant="secondary" className="hidden sm:inline-flex">
          API: checking…
        </Badge>
      </>
    );
  }
  if (healthQuery.status === 'error') {
    return (
      <>
        {compact('API: unreachable', 'bg-destructive')}
        <Badge variant="danger" dot className="hidden sm:inline-flex">
          API: unreachable
        </Badge>
      </>
    );
  }
  return (
    <>
      {compact(`API: ${healthQuery.data?.status ?? 'ok'}`, 'bg-success')}
      <Badge variant="success" dot className="hidden sm:inline-flex">
        API: {healthQuery.data?.status}
      </Badge>
    </>
  );
}

function CommandPaletteTrigger(): React.JSX.Element {
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Open command palette"
        className="sm:hidden"
        onClick={() => window.dispatchEvent(new CustomEvent('lcm:open-command-palette'))}
      >
        <Search className="h-4 w-4" />
      </Button>
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
    </>
  );
}
```

- [ ] **Step 2: Verify**

Run: `pnpm --filter @lcm/web typecheck && pnpm --filter @lcm/web test && pnpm --filter @lcm/web lint`
Expected: green. The hamburger only appears at `< lg:` (CSS-class controlled inside `<MobileNavTrigger>`), so desktop tests keep passing.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/layout/app-shell.tsx
git commit -m "feat(web): mobile nav drawer + responsive header chrome"
```

---

## Task 6: KPI tile robust typography

**Files:**

- Modify: `apps/web/src/components/overview/kpi-tile.tsx`

- [ ] **Step 1: Update the component**

Open `apps/web/src/components/overview/kpi-tile.tsx`. Replace the existing `<Card>` body. The `KpiTile` function currently renders:

```tsx
return (
  <Card className={cn('p-5', className)} {...props}>
    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {label}
    </p>
    <p className="mt-1.5 text-3xl font-semibold tracking-tight">{value}</p>
    {caption || status ? (
      <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        {status ? <span aria-hidden className={dotVariants({ status })} /> : null}
        {caption}
      </p>
    ) : null}
  </Card>
);
```

Replace with:

```tsx
return (
  <Card className={cn('p-5', className)} {...props}>
    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {label}
    </p>
    <p className="mt-1.5 text-2xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-3xl">
      {value}
    </p>
    {caption || status ? (
      <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {status ? <span aria-hidden className={dotVariants({ status })} /> : null}
        {caption}
      </p>
    ) : null}
  </Card>
);
```

- [ ] **Step 2: Verify**

Run: `pnpm --filter @lcm/web test && pnpm --filter @lcm/web typecheck && pnpm --filter @lcm/web lint`
Expected: all green. No KpiTile-specific test exists; this is a visual-only change picked up by e2e in Task 12.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/overview/kpi-tile.tsx
git commit -m "feat(web): KPI tile typography scales + wraps anywhere"
```

---

## Task 7: Cluster detail H1 — overflow-wrap

**Files:**

- Modify: `apps/web/src/routes/clusters.$id.tsx`

- [ ] **Step 1: Add `[overflow-wrap:anywhere]` to the H1**

In `apps/web/src/routes/clusters.$id.tsx`, find the H1 inside the header block. It currently reads:

```tsx
<h1 className="text-[1.625rem] font-semibold tracking-tight">{clusterQuery.data.name}</h1>
```

Replace with:

```tsx
<h1 className="text-[1.625rem] font-semibold tracking-tight [overflow-wrap:anywhere]">
  {clusterQuery.data.name}
</h1>
```

- [ ] **Step 2: Verify**

Run: `pnpm --filter @lcm/web test && pnpm --filter @lcm/web typecheck && pnpm --filter @lcm/web lint`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add 'apps/web/src/routes/clusters.$id.tsx'
git commit -m "feat(web): allow cluster H1 to wrap on any character"
```

---

## Task 8: `<ClusterListCard>` component

**Files:**

- Create: `apps/web/src/components/clusters/cluster-list-card.tsx`
- Create test: `apps/web/src/components/clusters/cluster-list-card.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/clusters/cluster-list-card.test.tsx`:

```tsx
import type { ClusterResponse, ForecastMonthPoint } from '@lcm/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ClusterListCard } from './cluster-list-card';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    ...rest
  }: {
    children: React.ReactNode;
    to: string;
    params?: Record<string, string>;
    [key: string]: unknown;
  }) => {
    let href = to;
    for (const [k, v] of Object.entries(params ?? {})) href = href.replace(`$${k}`, v);
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

const cluster: ClusterResponse = {
  id: 'c1',
  name: 'CL-Test',
  description: null,
  baselineDate: '2026-05-01',
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
  metrics: [
    {
      metricTypeKey: 'memory_gb',
      metricTypeDisplayName: 'Memory',
      unit: 'GB',
      baselineConsumption: 400,
      baselineCapacity: 1000,
      currentConsumption: 400,
      currentCapacity: 1000,
      utilization: 0.4,
    },
  ],
};

const months: ForecastMonthPoint[] = [
  { month: '2026-05-01', consumption: 400, capacity: 1000, utilization: 0.4 },
  { month: '2026-06-01', consumption: 500, capacity: 1000, utilization: 0.5 },
];

describe('<ClusterListCard>', () => {
  it('links to the cluster detail page and renders the key metrics', () => {
    render(<ClusterListCard cluster={cluster} months={months} horizonMonths={2} />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/clusters/c1');
    expect(screen.getByText('CL-Test')).toBeInTheDocument();
    expect(screen.getByText(/40\.0%/)).toBeInTheDocument();
    expect(screen.getByText(/400 \/ 1,000 GB/)).toBeInTheDocument();
    expect(screen.getByText(/2\+ mo/)).toBeInTheDocument();
  });

  it('falls back to em-dash when no metric is present', () => {
    const noMetric: ClusterResponse = { ...cluster, metrics: [] };
    render(<ClusterListCard cluster={noMetric} months={[]} horizonMonths={0} />);
    expect(screen.getByText('CL-Test')).toBeInTheDocument();
    expect(screen.getByText('No baseline')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lcm/web test -- cluster-list-card`
Expected: FAIL — cannot resolve `'./cluster-list-card'`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/components/clusters/cluster-list-card.tsx`:

```tsx
import type { ClusterResponse, ForecastMonthPoint } from '@lcm/shared';
import { Link } from '@tanstack/react-router';

import { Card } from '@/components/ui/card';
import { RunwayPill } from '@/components/ui/runway-pill';
import { runwayToWarn } from '@/lib/forecast-summary';

import { UtilizationBadge } from './utilization-badge';

interface ClusterListCardProps {
  cluster: ClusterResponse;
  months: ForecastMonthPoint[];
  horizonMonths: number;
}

const numberFormat = new Intl.NumberFormat('en-US');

export function ClusterListCard({
  cluster,
  months,
  horizonMonths,
}: ClusterListCardProps): React.JSX.Element {
  const metric = cluster.metrics[0];
  const summary = metric && months.length > 0 ? runwayToWarn(months) : undefined;

  return (
    <Link
      to="/clusters/$id"
      params={{ id: cluster.id }}
      className="block rounded-xl transition-shadow duration-150 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Card className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="min-w-0 truncate text-base font-semibold [overflow-wrap:anywhere]">
            {cluster.name}
          </h3>
          {metric ? <UtilizationBadge value={metric.utilization} /> : null}
        </div>
        {metric ? (
          <p className="font-mono text-xs tabular-nums text-muted-foreground">
            {numberFormat.format(Math.round(metric.currentConsumption))} /{' '}
            {numberFormat.format(Math.round(metric.currentCapacity))} GB
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">No baseline</p>
        )}
        {summary ? (
          <RunwayPill summary={summary} {...(horizonMonths > 0 && { horizonMonths })} />
        ) : null}
      </Card>
    </Link>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @lcm/web test -- cluster-list-card`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/clusters/cluster-list-card.tsx apps/web/src/components/clusters/cluster-list-card.test.tsx
git commit -m "feat(web): ClusterListCard for mobile clusters list"
```

---

## Task 9: ClusterTable renders card stack below `md:`

**Files:**

- Modify: `apps/web/src/components/clusters/cluster-table.tsx`

- [ ] **Step 1: Modify the existing `ClusterTable`**

In `apps/web/src/components/clusters/cluster-table.tsx`, find the `return (` block at line 91 (it starts `return (<Card className="overflow-hidden">…`). Replace the entire returned JSX with a fragment that renders the card stack at `md:hidden` and the existing table at `hidden md:block`.

Add this import at the top of the file:

```tsx
import { ClusterListCard } from './cluster-list-card';
```

Replace the entire `return (...)` block (lines 91-163) with:

```tsx
return (
  <>
    <div className="space-y-2 md:hidden">
      {sorted.map(({ cluster }) => {
        const months = forecastsById?.[cluster.id] ?? [];
        return (
          <ClusterListCard
            key={cluster.id}
            cluster={cluster}
            months={months}
            horizonMonths={horizonMonths ?? 0}
          />
        );
      })}
    </div>
    <Card className="hidden overflow-hidden md:block">
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead label="Cluster" sortKey="name" sort={sort} onToggle={toggle} />
            <SortableHead
              label="Consumption (GB)"
              sortKey="consumption"
              sort={sort}
              onToggle={toggle}
              align="right"
            />
            <SortableHead
              label="Capacity (GB)"
              sortKey="capacity"
              sort={sort}
              onToggle={toggle}
              align="right"
            />
            <SortableHead
              label="Utilization"
              sortKey="utilization"
              sort={sort}
              onToggle={toggle}
              align="right"
            />
            <SortableHead label="Runway" sortKey="runway" sort={sort} onToggle={toggle} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map(({ cluster, summary }) => {
            const metric = cluster.metrics[0];
            return (
              <TableRow
                key={cluster.id}
                className="cursor-pointer hover:bg-muted/60 focus-within:bg-muted/60"
              >
                <TableCell className="font-medium">
                  <Link
                    to="/clusters/$id"
                    params={{ id: cluster.id }}
                    className="block w-full focus-visible:outline-none"
                  >
                    {cluster.name}
                  </Link>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {metric ? numberFormat.format(Math.round(metric.currentConsumption)) : '—'}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {metric ? numberFormat.format(Math.round(metric.currentCapacity)) : '—'}
                </TableCell>
                <TableCell className="text-right">
                  {metric ? <UtilizationBadge value={metric.utilization} /> : '—'}
                </TableCell>
                <TableCell>
                  {summary === undefined ? (
                    '—'
                  ) : (
                    <RunwayPill
                      summary={summary}
                      {...(horizonMonths !== undefined && { horizonMonths })}
                    />
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  </>
);
```

- [ ] **Step 2: Verify**

Run: `pnpm --filter @lcm/web test && pnpm --filter @lcm/web typecheck && pnpm --filter @lcm/web lint`
Expected: all green. Existing `cluster-table.test.tsx` runs in jsdom which has no real layout — the `md:hidden` and `hidden md:block` selectors don't actually hide anything in jsdom, so both renderings co-exist. Existing role queries (`getByRole('row')`, etc.) still find the table; the card stack adds anchors but those don't have `role=row`. Verify by running the existing test suite.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/clusters/cluster-table.tsx
git commit -m "feat(web): clusters table renders card stack below md"
```

---

## Task 10: Charts accept `compact` prop

**Files:**

- Modify: `apps/web/src/components/overview/fleet-capacity-chart.tsx`
- Modify: `apps/web/src/components/clusters/forecast-chart.tsx`

- [ ] **Step 1: Update `<FleetCapacityChart>` to accept `compact`**

In `apps/web/src/components/overview/fleet-capacity-chart.tsx`:

(a) Add `compact?: boolean` to `FleetCapacityChartProps`:

```tsx
interface FleetCapacityChartProps {
  fleetMonths: FleetMonthRow[];
  clusters: ClusterMeta[];
  compact?: boolean;
}
```

Destructure it in the function signature:

```tsx
export function FleetCapacityChart({
  fleetMonths,
  clusters,
  compact = false,
}: FleetCapacityChartProps): React.JSX.Element {
```

(b) Replace the `<AreaChart … margin={{ top: 12, right: 56, bottom: 0, left: 8 }}>` line with:

```tsx
<AreaChart
  data={enrichedRows}
  margin={{ top: 12, right: compact ? 16 : 56, bottom: 0, left: 8 }}
>
```

(c) In the `<YAxis ... />` block, change `tick={{ fontSize: 11 }}` to:

```tsx
tick={{ fontSize: compact ? 10 : 11 }}
```

Do the same for the `<XAxis>` `tick` prop.

(d) In both `<ReferenceLine>` blocks, conditionally drop the label text by wrapping the existing `label` prop in a `compact ? undefined : { ... }` conditional.

For the Warn line:

```tsx
<ReferenceLine
  y={maxCeiling * 0.7}
  stroke={colors.utilizationWarn}
  strokeDasharray="2 2"
  label={
    compact
      ? undefined
      : {
          value: `Warn ${numberFormat.format(Math.round(maxCeiling * 0.7))}`,
          position: 'right',
          fontSize: 10,
          fill: colors.utilizationWarn,
        }
  }
/>
```

For the Crit line:

```tsx
<ReferenceLine
  y={maxCeiling * 0.9}
  stroke={colors.utilizationCrit}
  strokeDasharray="2 2"
  label={
    compact
      ? undefined
      : {
          value: `Crit ${numberFormat.format(Math.round(maxCeiling * 0.9))}`,
          position: 'right',
          fontSize: 10,
          fill: colors.utilizationCrit,
        }
  }
/>
```

(e) Update the `YAxis` `label.style.fontSize` so it shrinks too. Find:

```tsx
label={{
  value: 'GB',
  angle: -90,
  position: 'insideLeft',
  style: { fontSize: 11, fill: colors.axis },
}}
```

Change to:

```tsx
label={{
  value: 'GB',
  angle: -90,
  position: 'insideLeft',
  style: { fontSize: compact ? 10 : 11, fill: colors.axis },
}}
```

- [ ] **Step 2: Update `<ForecastChart>` to accept `compact`**

In `apps/web/src/components/clusters/forecast-chart.tsx`:

(a) Add `compact?: boolean` to `ForecastChartProps`:

```tsx
interface ForecastChartProps {
  forecast: ForecastResponse;
  compact?: boolean;
}
```

Destructure with default:

```tsx
export function ForecastChart({ forecast, compact = false }: ForecastChartProps): React.JSX.Element {
```

(b) Replace `<ComposedChart … margin={{ top: 12, right: 56, bottom: 0, left: 8 }}>` with:

```tsx
<ComposedChart
  data={data}
  margin={{ top: 12, right: compact ? 16 : 56, bottom: 0, left: 8 }}
>
```

(c) Change both axis `tick` `fontSize` from `11` to:

```tsx
tick={{ fontSize: compact ? 10 : 11 }}
```

Apply this on both `<XAxis>` and `<YAxis>`.

For the `YAxis`'s own `label.style.fontSize`, find:

```tsx
label={{
  value: 'GB',
  angle: -90,
  position: 'insideLeft',
  style: { fontSize: 11, fill: colors.axis },
}}
```

Change to:

```tsx
label={{
  value: 'GB',
  angle: -90,
  position: 'insideLeft',
  style: { fontSize: compact ? 10 : 11, fill: colors.axis },
}}
```

(d) For both `<ReferenceLine>` blocks, wrap the `label` prop in `compact ? undefined : { ... }`.

For the Warn line:

```tsx
<ReferenceLine
  y={maxCeiling * 0.7}
  stroke={colors.utilizationWarn}
  strokeDasharray="2 2"
  label={
    compact
      ? undefined
      : {
          value: `Warn ${numberFormat.format(Math.round(maxCeiling * 0.7))}`,
          position: 'right',
          fontSize: 10,
          fill: colors.utilizationWarn,
        }
  }
/>
```

For the Crit line:

```tsx
<ReferenceLine
  y={maxCeiling * 0.9}
  stroke={colors.utilizationCrit}
  strokeDasharray="2 2"
  label={
    compact
      ? undefined
      : {
          value: `Crit ${numberFormat.format(Math.round(maxCeiling * 0.9))}`,
          position: 'right',
          fontSize: 10,
          fill: colors.utilizationCrit,
        }
  }
/>
```

- [ ] **Step 3: Wire `useMediaQuery` in routes**

In `apps/web/src/routes/index.tsx`, add this import:

```tsx
import { useMediaQuery } from '@/lib/use-media-query';
```

Inside `OverviewPage()`, just below the existing `const summary = ...` line, add:

```tsx
const isWide = useMediaQuery('(min-width: 640px)');
```

Change the `<FleetCapacityChart>` call from:

```tsx
<FleetCapacityChart
  fleetMonths={summary.fleetMonths}
  clusters={summary.perClusterSeries.map((s) => ({
    clusterId: s.clusterId,
    clusterName: s.clusterName,
  }))}
/>
```

To:

```tsx
<FleetCapacityChart
  fleetMonths={summary.fleetMonths}
  clusters={summary.perClusterSeries.map((s) => ({
    clusterId: s.clusterId,
    clusterName: s.clusterName,
  }))}
  compact={!isWide}
/>
```

In `apps/web/src/routes/clusters.$id.tsx`, add the same import:

```tsx
import { useMediaQuery } from '@/lib/use-media-query';
```

At the top of `ClusterDetailPage()` (just below the existing hooks), add:

```tsx
const isWide = useMediaQuery('(min-width: 640px)');
```

Change the `<ForecastChart forecast={forecastQuery.data} />` line to:

```tsx
<ForecastChart forecast={forecastQuery.data} compact={!isWide} />
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @lcm/web test && pnpm --filter @lcm/web typecheck && pnpm --filter @lcm/web lint`
Expected: green. The existing `forecast-chart.test.tsx` already mocks `ReferenceLine` to `() => null` and tests text content, so the `label`-prop change is invisible to it.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/overview/fleet-capacity-chart.tsx apps/web/src/components/clusters/forecast-chart.tsx apps/web/src/routes/index.tsx 'apps/web/src/routes/clusters.$id.tsx'
git commit -m "feat(web): charts compact mode below sm"
```

---

## Task 11: Mobile E2E spec

**Files:**

- Create: `apps/web/playwright/mobile.spec.ts`

- [ ] **Step 1: Write the spec**

Create `apps/web/playwright/mobile.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test.describe('mobile layout at 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('overview page collapses sidebar into a sheet drawer', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.removeItem('theme');
      } catch {
        // ignore
      }
    });

    await page.goto('/');
    // Inline sidebar (aside) must be hidden — it has aria-label="Primary navigation".
    // The Sheet contents share the same label but only render when open, so
    // initially there must be zero matching nodes.
    await expect(page.getByLabel('Primary navigation')).toHaveCount(0);

    // Hamburger button opens navigation.
    const hamburger = page.getByRole('button', { name: 'Open navigation' });
    await expect(hamburger).toBeVisible();
    await hamburger.click();

    const drawer = page.getByRole('dialog', { name: 'Primary navigation' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Overview' })).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Clusters' })).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Settings' })).toBeVisible();
  });

  test('clusters page renders card stack and tapping a card navigates to detail', async ({
    page,
  }) => {
    await page.goto('/clusters');

    // The table version is hidden at this viewport; the card stack uses anchors.
    // Pick the first card link and confirm it routes to a cluster detail page.
    const card = page.locator('a[href^="/clusters/"]').first();
    await expect(card).toBeVisible();
    const href = await card.getAttribute('href');
    expect(href).toMatch(/^\/clusters\/[a-z0-9]+$/);

    await card.click();
    await expect(page).toHaveURL(/\/clusters\/[a-z0-9]+/);
  });

  test('cluster detail KPI strip renders without clipping', async ({ page }) => {
    await page.goto('/clusters');
    await page.locator('a[href^="/clusters/"]').first().click();

    // KPI strip labels visible.
    await expect(page.getByText('Current utilization')).toBeVisible();
    await expect(page.getByText('Headroom', { exact: true })).toBeVisible();
    await expect(page.getByText('Runway', { exact: true })).toBeVisible();
  });
});
```

- [ ] **Step 2: Verify (typecheck only; real e2e needs dev stack)**

Run: `pnpm --filter @lcm/web typecheck`
Expected: clean. (The Playwright spec compiles via the project's TS config.)

If a dev stack is available (`pnpm dev` running on 5173 + API on 8090), run:

```bash
pnpm --filter @lcm/web test:e2e
```

Otherwise rely on the implementation's manual verification step in Task 12.

- [ ] **Step 3: Commit**

```bash
git add apps/web/playwright/mobile.spec.ts
git commit -m "test(web): mobile layout e2e at 390x844"
```

---

## Task 12: Manual Playwright verification

Not committed. Produces evidence that the change works end-to-end.

- [ ] **Step 1: Rebuild docker stack so it serves the branch code**

```bash
docker compose build web && docker compose up -d web
```

Wait for healthcheck: `until curl -sf http://localhost:8082 -o /dev/null; do sleep 1; done; echo UP`

- [ ] **Step 2: Inspect at 390 × 844 (light + dark)**

Using Playwright MCP, navigate to:

- `/` — confirm hamburger visible, sidebar hidden, KPI tiles not clipped, fleet chart visible without label text but with reference lines.
- Tap hamburger — confirm drawer slides in with Overview/Clusters/Settings links; tap Clusters — confirm drawer closes and route changes.
- `/clusters` — confirm card stack renders (no `<table>` visible), KPI banner stacks 1-col, no horizontal scroll.
- `/clusters/:id` — confirm H1 doesn't break on hyphens, KPI strip stacks 1-col, forecast chart compact (no Crit/Warn label text but lines visible).

- [ ] **Step 3: Inspect at 768 × 1024**

- `/` — hamburger still visible, KPI tiles 3-up sm:col-span-4 working, chart labels visible at this width.
- `/clusters` — KPI banner 3-up sm:col-span-4 working; table version renders (`md:` breakpoint = 768 exactly is the cutoff — Tailwind's `md:` means `min-width: 768px`, so at 768 the table appears).
- `/clusters/:id` — KPI strip 3-up; chart labels visible.

- [ ] **Step 4: Inspect at 1440 × 900**

- Full desktop unchanged: inline sidebar visible, hamburger hidden, full header chrome, table view, full chart labels.

- [ ] **Step 5: Toggle dark mode and repeat at each width**

Verify the sheet backdrop blur and sidebar background colors render correctly in dark mode.

- [ ] **Step 6: If any visual regression, file a follow-up task in this plan rather than amending earlier commits**

---

## Definition of done

- All unit tests in `apps/web/src/**/__tests__` and `apps/web/src/**/*.test.tsx` pass.
- `pnpm --filter @lcm/web test:e2e` passes (golden-path + mobile spec) when run against a real dev stack.
- `pnpm typecheck` and `pnpm lint` clean at the repo root.
- Manual checks from Task 12 are satisfied at 390 px, 768 px, 1440 px in both light and dark.
- No regression in the existing golden-path Playwright spec.
