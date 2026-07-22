import { createFileRoute, redirect } from '@tanstack/react-router';

import { AuthenticationForm } from '@/components/settings/authentication-form';
import { isAdmin } from '@/lib/auth';

// Route-level guard (#293): the Access tab is already hidden from non-admins
// in the sub-nav (`_app.settings.tsx`'s `isAdmin` check), but hiding the tab
// is not enough — a direct/deep link straight to `/settings/access` must not
// reach the panel either. Mirrors the `beforeLoad` redirect precedent in
// `_app.clusters.index.tsx`, using the same `isAdmin` predicate
// `useIsAdmin()` applies elsewhere, just fed `context.auth` directly since
// `beforeLoad` runs outside React and cannot call hooks.
//
// @ai-warning This is a UX guard only, same as the old `canManageAuth`
// render-gate it replaces. `/api/settings/auth` remains the real enforcement
// point and is unchanged by this route split — a non-admin who bypasses this
// redirect (e.g. a stale client) still gets a 403 from the server.
export const Route = createFileRoute('/_app/settings/access')({
  beforeLoad: ({ context }) => {
    if (!isAdmin(context.auth)) {
      throw redirect({ to: '/settings/forecasting' });
    }
  },
  component: AccessSettingsPage,
});

function AccessSettingsPage(): React.JSX.Element {
  return (
    <section aria-labelledby="settings-access-heading" className="space-y-6">
      <h2 id="settings-access-heading" className="font-display text-h2">
        Access
      </h2>
      <AuthenticationForm />
    </section>
  );
}
