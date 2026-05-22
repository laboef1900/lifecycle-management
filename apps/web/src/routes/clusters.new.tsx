import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/clusters/new')({
  component: NewClusterPage,
});

function NewClusterPage(): React.JSX.Element {
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">New cluster</h1>
      <p className="text-sm text-muted-foreground">Form arrives in #13.</p>
    </div>
  );
}
