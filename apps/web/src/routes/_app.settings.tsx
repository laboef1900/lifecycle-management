import {
  Link,
  Outlet,
  createFileRoute,
  useCanGoBack,
  useLocation,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import { useCallback, useEffect, useRef } from 'react';

import { BackButton } from '@/components/ui/back-button';
import { useIsAdmin } from '@/lib/auth';
import { isOverlayOpen, isTypingTarget } from '@/lib/keyboard';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsLayout,
});

/** Every pathname this layout renders for — its own index plus every child. */
const SETTINGS_PATH_PREFIX = '/settings';

function isSettingsPathname(pathname: string): boolean {
  return pathname === SETTINGS_PATH_PREFIX || pathname.startsWith(`${SETTINGS_PATH_PREFIX}/`);
}

function SettingsLayout(): React.JSX.Element {
  const isAdmin = useIsAdmin();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const navigate = useNavigate();
  const { href, pathname } = useLocation();

  // Go back to the previous route when there is real history to pop, else fall
  // back to the fleet console — a deep link/refresh onto /settings/* has no
  // prior entry (useCanGoBack tracks `__TSR_index !== 0`), so it lands on `/`.
  //
  // @ai-warning Re-entrancy latch, keyed to the href it fired from — NOT a
  // one-shot boolean. `router.history.back()` is `window.history.back()`: the
  // traversal is queued and only lands on a later task (popstate → router
  // transition → unmount), so this layout — and its document keydown listener
  // — outlives its own navigation in two windows that need OPPOSITE treatment.
  // Both are load-bearing:
  //
  //  1. Pop not landed yet — `href` is still the one we fired from and
  //     `canGoBack` is stale. A second activation here (double-clicked Back,
  //     double-tapped Esc, OS auto-repeat) pops a *second* entry and can eject
  //     the user out of the SPA entirely. Stay latched.
  //  2. Pop landed outside `/settings` entirely — this layout still renders
  //     once more before React unmounts it (the parent route no longer
  //     matches). Resetting here would re-open exactly the double-pop of (1).
  //     Stay latched; the unmount discards the latch anyway.
  //
  // @ai-note (#293) This redesigns the release condition the single-route
  // version of this page used (pinned in `app-settings-back.test.tsx`), rather
  // than copying it: that version compared the CURRENT pathname against the
  // one the latch fired from, because `/settings` was the only pathname this
  // page ever rendered at (only the hash varied) — any pathname change meant
  // the page was on its way OUT and about to unmount, so it stayed latched
  // until then. Now Forecasting/Inventory/Access are sibling child routes
  // under this shared layout: this component does NOT unmount when Back (or a
  // tab `Link`) lands on a sibling sub-route — only `<Outlet/>`'s child does —
  // so treating "pathname changed" as "about to unmount" would leave Back and
  // Esc dead on the very first cross-tab landing, with no recovery short of a
  // reload. The rule that actually matches this layout's lifetime: stay
  // latched only while `href` hasn't moved yet (case 1) OR the landing left
  // `/settings` altogether (case 2, still `isSettingsPathname` === false).
  // Landing anywhere else under `/settings` — including the exact sub-route we
  // started from, e.g. `/settings/inventory#add-cluster` → back →
  // `/settings/inventory` — releases the latch, because this layout is
  // provably still mounted to receive the next Back/Esc.
  const firedFromRef = useRef<string | null>(null);
  const goBack = useCallback((): void => {
    const firedFrom = firedFromRef.current;
    if (firedFrom !== null && (firedFrom === href || !isSettingsPathname(pathname))) return;
    firedFromRef.current = href;
    if (canGoBack) {
      router.history.back();
    } else {
      void navigate({ to: '/' });
    }
  }, [href, pathname, canGoBack, router, navigate]);

  // Esc goes back, mirroring the panel's affordance. A document-level listener
  // is required (not a wrapper onKeyDown): Settings has no focus trap, so focus
  // on arrival is wherever the entry path left it, which is routinely OUTSIDE
  // this subtree — the topbar <Link> keeps focus on its own <a>, which survives
  // the navigation because AppShell persists, and `g s` leaves focus wherever
  // the user already was (typically <body>). A wrapper handler sees neither.
  //
  // Guards, in order: ignore OS key auto-repeat (holding Esc is one intent, not
  // ~30 of them); skip if another handler already consumed the event; skip when
  // typing in a field (Esc means "cancel this edit"); skip while a dismissible
  // overlay is open so it — not the page — handles Escape (dirty-form gating is
  // out of scope, #225).
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (event.repeat) return;
      if (event.defaultPrevented) return;
      if (isTypingTarget(event.target)) return;
      if (isOverlayOpen()) return;
      event.preventDefault();
      goBack();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [goBack]);

  return (
    <div className="space-y-8">
      <BackButton onClick={goBack} />
      <header>
        {/* The 'Configuration' eyebrow is dropped (#243 Part B) — the h1 below
            already names the page, and the tab nav that replaces the old
            in-page nav below gives the eyebrow's real estate to something the
            user can act on. font-display + text-display: the existing
            type-scale tokens (styles.css) were defined but unused here —
            every sibling screen's top-level heading (fleet verdict, cluster
            panel title) uses font-display; Settings was the one screen still
            on the arbitrary Inter fallback. */}
        <h1 className="font-display text-display">Settings</h1>
      </header>
      {/* Tab-style sub-nav (#293, reverses #243 Part B's "one flat scroll"):
          each item is a real route (`/settings/forecasting`,
          `/settings/inventory`, `/settings/access`), not a fragment anchor —
          plain <Link>s carrying `aria-current="page"` automatically
          (TanStack Router's default active-link behaviour) rather than a
          synthetic ARIA tablist, since these are genuinely separate pages a
          user can bookmark or reload, not tab-panels sharing one DOM. */}
      <nav aria-label="Settings sections" className="flex gap-4 border-b border-border text-sm">
        <SettingsTab to="/settings/forecasting">Forecasting</SettingsTab>
        <SettingsTab to="/settings/inventory">Inventory</SettingsTab>
        {isAdmin ? <SettingsTab to="/settings/access">Access</SettingsTab> : null}
      </nav>
      <Outlet />
    </div>
  );
}

function SettingsTab({
  to,
  children,
}: {
  to: '/settings/forecasting' | '/settings/inventory' | '/settings/access';
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Link
      to={to}
      className={cn(
        'relative inline-flex h-9 items-center whitespace-nowrap px-1 font-medium text-fg-muted',
        'transition-colors hover:text-foreground focus-visible:text-foreground',
        'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:origin-center after:scale-x-0',
        'after:rounded-full after:bg-accent after:transition-transform after:duration-200 after:ease-out',
        'data-[status=active]:text-foreground data-[status=active]:after:scale-x-100',
      )}
    >
      {children}
    </Link>
  );
}
