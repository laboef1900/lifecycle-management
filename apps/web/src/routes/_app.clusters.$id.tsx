import { createFileRoute } from '@tanstack/react-router';

import { ClusterPanel } from '@/components/detail/cluster-panel';
import { FleetConsole } from '@/components/fleet/fleet-console';

export const Route = createFileRoute('/_app/clusters/$id')({
  component: ClusterDetailRoute,
});

/**
 * The fleet console stays mounted underneath the slide-in panel (spec §2):
 * this URL is the console with the detail panel open, not a separate page.
 */
function ClusterDetailRoute(): React.JSX.Element {
  const { id } = Route.useParams();
  return (
    <>
      <FleetConsole />
      <ClusterPanel clusterId={id} />
    </>
  );
}
