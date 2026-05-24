import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/clusters/new')({
  component: NewClusterPage,
});

function NewClusterPage(): React.JSX.Element {
  return (
    <div className="space-y-2">
      <header>
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
          Cluster
        </p>
        <h1 className="mt-1 text-[26px] font-semibold leading-[1.1] tracking-[-0.02em]">
          Add cluster
        </h1>
      </header>
      <p className="text-sm text-muted-foreground">Form arrives in #13.</p>
    </div>
  );
}
