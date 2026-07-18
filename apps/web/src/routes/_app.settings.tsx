import { createFileRoute, useCanGoBack, useNavigate, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect } from 'react';

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
  // Disabled-mode bootstrap: with no auth enforced yet, anyone on this page
  // can configure it. Once OIDC is on, only an ADMIN sees the panel.
  const canManageAuth = auth.user?.role === 'ADMIN' || auth.authRequired === false;

  // Go back to the previous route when there is real history to pop, else fall
  // back to the fleet console — a deep link/refresh onto /settings has no prior
  // entry (useCanGoBack tracks `__TSR_index !== 0`), so it lands on `/`.
  const goBack = useCallback((): void => {
    if (canGoBack) {
      router.history.back();
    } else {
      void navigate({ to: '/' });
    }
  }, [canGoBack, router, navigate]);

  // Esc goes back, mirroring the panel's affordance. A document-level listener
  // is required (not a wrapper onKeyDown): Settings has no focus trap and every
  // entry path (topbar link, `g s`, ⌘K) leaves focus on <body>, where a
  // wrapper handler would never fire. Guards, in order: skip if another handler
  // already consumed the event; skip when typing in a field (Esc means "cancel
  // this edit"); skip while a dismissible overlay is open so it — not the page
  // — handles Escape (dirty-form gating is intentionally out of scope, #225).
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
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
