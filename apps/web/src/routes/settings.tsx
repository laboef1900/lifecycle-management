import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

function SettingsPage(): React.JSX.Element {
  return (
    <div className="space-y-2">
      <header>
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
          Configuration
        </p>
        <h1 className="mt-1 text-[26px] font-semibold leading-[1.1] tracking-[-0.02em]">
          Settings
        </h1>
      </header>
      <p className="text-sm text-muted-foreground">
        Metric types (read-only in v1) will be listed here.
      </p>
    </div>
  );
}
