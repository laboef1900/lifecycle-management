import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/clusters/$id')({
  component: ClusterDetailPage,
});

function ClusterDetailPage(): React.JSX.Element {
  const { id } = Route.useParams();
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">Cluster {id}</h1>
      <p className="text-sm text-muted-foreground">Chart and entity tabs arrive in #14 and #15.</p>
    </div>
  );
}
