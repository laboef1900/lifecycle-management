import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

function SettingsPage(): React.JSX.Element {
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="text-sm text-muted-foreground">
        Metric types (read-only in v1) will be listed here.
      </p>
    </div>
  );
}
