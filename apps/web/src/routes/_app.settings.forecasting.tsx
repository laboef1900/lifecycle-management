import { createFileRoute } from '@tanstack/react-router';

import { CategoriesForm } from '@/components/settings/categories-form';
import { ForecastThresholdsForm } from '@/components/settings/forecast-thresholds-form';

export const Route = createFileRoute('/_app/settings/forecasting')({
  component: ForecastingSettingsPage,
});

function ForecastingSettingsPage(): React.JSX.Element {
  return (
    <section aria-labelledby="settings-forecasting-heading" className="space-y-6">
      <h2 id="settings-forecasting-heading" className="font-display text-h2">
        Forecasting
      </h2>
      <ForecastThresholdsForm />
      <CategoriesForm />
    </section>
  );
}
