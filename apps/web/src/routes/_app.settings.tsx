import {
  createFileRoute,
  useCanGoBack,
  useLocation,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import { useCallback, useEffect, useRef } from 'react';

import { AddClusterPanel } from '@/components/settings/add-cluster-panel';
import { AuthenticationForm } from '@/components/settings/authentication-form';
import { CategoriesForm } from '@/components/settings/categories-form';
import { ForecastThresholdsForm } from '@/components/settings/forecast-thresholds-form';
import { VcenterConnectionsPanel } from '@/components/settings/vcenter-connections-panel';
import { BackButton } from '@/components/ui/back-button';
import { isOverlayOpen, isTypingTarget } from '@/lib/keyboard';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsPage,
});

function SettingsPage(): React.JSX.Element {
  const { auth } = Route.useRouteContext();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const navigate = useNavigate();
  const { href, pathname } = useLocation();
  // Disabled-mode bootstrap: with no auth enforced yet, anyone on this page
  // can configure it. Once OIDC is on, only an ADMIN sees the panel.
  const canManageAuth = auth.user?.role === 'ADMIN' || auth.authRequired === false;

  // Go back to the previous route when there is real history to pop, else fall
  // back to the fleet console — a deep link/refresh onto /settings has no prior
  // entry (useCanGoBack tracks `__TSR_index !== 0`), so it lands on `/`.
  //
  // @ai-warning Re-entrancy latch, keyed to the location it fired from — NOT
  // a one-shot boolean. (The cluster panel used to carry a sibling `isClosing`
  // guard; #243's instant close removed it — the panel's close is a bare
  // synchronous navigate that double-activation can't compound, so this latch
  // is now the only one of its kind and must justify itself alone.)
  // `router.history.back()` is `window.history.back()`: the traversal is queued
  // and only lands on a later task (popstate → router transition → unmount), so
  // this page — and its document keydown listener — outlives its own navigation
  // in two windows that need OPPOSITE treatment. Both are load-bearing:
  //
  //  1. Pop not landed yet — `href` is still the one we fired from and
  //     `canGoBack` is stale. A second activation here (double-clicked Back,
  //     double-tapped Esc, OS auto-repeat) pops a *second* entry and can eject
  //     the user out of the SPA entirely. Stay latched.
  //  2. Pop landed on a different pathname — this page still renders once more
  //     before React unmounts it (verified in the memory-router harness:
  //     SettingsPage renders at href `/` after Back). Resetting here would
  //     re-open exactly the double-pop of (1). Stay latched; the unmount
  //     discards the latch anyway.
  //
  // The case that MUST release is a pop landing on the SAME pathname: the route
  // does not remount, so the page carries this latch for the rest of the visit.
  // `/settings#add-cluster` (the ⌘K Add-cluster deep link) → back → `/settings`
  // is exactly that, and a permanent latch leaves Back and Esc dead with no
  // recovery short of a reload. Hence: released only by a same-pathname,
  // different-href landing. Do NOT simplify this to "reset on location change"
  // — that is window (2), and it is reachable.
  //
  // Two consequences of that release, both accepted:
  //  - Once such a pop HAS landed, a further activation is no longer guarded,
  //    so a slow double-click pops again. `canGoBack` bounds it: the worst
  //    case is landing on `/`, never leaving the SPA. The code cannot tell a
  //    stray second click from a deliberate new intent once the pop landed.
  //  - A pop landing on the same pathname AND the same href keeps the latch
  //    forever. Unreachable today — TanStack dedupes a navigation to the
  //    current href, so adjacent identical entries do not occur — but a future
  //    navigation that can create them would need this rule widened.
  const firedFromRef = useRef<{ href: string; pathname: string } | null>(null);
  const goBack = useCallback((): void => {
    const firedFrom = firedFromRef.current;
    if (firedFrom !== null && (firedFrom.href === href || firedFrom.pathname !== pathname)) return;
    firedFromRef.current = { href, pathname };
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
    <div className="space-y-6">
      <BackButton onClick={goBack} />
      <header>
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
          Configuration
        </p>
        <h1 className="mt-1 text-[26px] font-semibold leading-[1.1] tracking-[-0.02em]">
          Settings
        </h1>
      </header>
      <ForecastThresholdsForm />
      <CategoriesForm />
      <VcenterConnectionsPanel />
      <AddClusterPanel />
      {canManageAuth ? <AuthenticationForm /> : null}
    </div>
  );
}
