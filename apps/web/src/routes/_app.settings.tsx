import { createFileRoute } from '@tanstack/react-router';

import { AuthenticationForm } from '@/components/settings/authentication-form';
import { CategoriesForm } from '@/components/settings/categories-form';
import { ForecastThresholdsForm } from '@/components/settings/forecast-thresholds-form';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsPage,
});

function SettingsPage(): React.JSX.Element {
  const { auth } = Route.useRouteContext();
  // Disabled-mode bootstrap: with no auth enforced yet, anyone on this page
  // can configure it. Once OIDC is on, only an ADMIN sees the panel.
  const canManageAuth = auth.user?.role === 'ADMIN' || auth.authRequired === false;

  return (
    <div className="space-y-6">
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
      {canManageAuth ? <AuthenticationForm /> : null}
    </div>
  );
}
