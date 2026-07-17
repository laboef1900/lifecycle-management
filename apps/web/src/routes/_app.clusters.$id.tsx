import { createFileRoute } from '@tanstack/react-router';

import { ClusterPanel } from '@/components/detail/cluster-panel';
import { FleetConsole } from '@/components/fleet/fleet-console';

export const Route = createFileRoute('/_app/clusters/$id')({
  component: ClusterDetailRoute,
});

/**
 * The fleet console stays mounted underneath the slide-in panel (spec §2):
 * this URL is the console with the detail panel open, not a separate page.
 *
 * The panel is a modal dialog (`aria-modal="true"`, see `cluster-panel.tsx`)
 * — everything outside it must be excluded from the tab order and assistive
 * tech while it's open (PR review fix 3). `inert` on the console wrapper
 * does that (React 19 supports the `inert` prop natively on DOM elements).
 * The topbar, rendered one level up by the parent `_app.tsx` layout route
 * and not wrappable from here, deliberately stays reachable — a narrow,
 * accepted exception: Esc still closes the panel from anywhere, and
 * `aria-modal` only asserts modal semantics for the dialog's own subtree, so
 * a technically-reachable topbar outside that subtree doesn't violate the
 * modal contract.
 */
function ClusterDetailRoute(): React.JSX.Element {
  const { id } = Route.useParams();
  return (
    <>
      <div inert data-testid="console-wrapper">
        <FleetConsole />
      </div>
      <ClusterPanel clusterId={id} />
    </>
  );
}
