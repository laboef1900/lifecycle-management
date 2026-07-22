import { createFileRoute } from '@tanstack/react-router';

import { AddClusterPanel } from '@/components/settings/add-cluster-panel';
import { VcenterConnectionsPanel } from '@/components/settings/vcenter-connections-panel';

export const Route = createFileRoute('/_app/settings/inventory')({
  component: InventorySettingsPage,
});

function InventorySettingsPage(): React.JSX.Element {
  return (
    <section aria-labelledby="settings-inventory-heading" className="space-y-6">
      <h2 id="settings-inventory-heading" className="font-display text-h2">
        Inventory
      </h2>
      <VcenterConnectionsPanel />
      {/* Deep-links to this panel specifically (⌘K "Add cluster", the fleet
          empty-state CTA) still target `/settings/inventory#add-cluster` —
          `ADD_CLUSTER_HASH` in `lib/anchors.ts` is unchanged by #293, only the
          route it now lives on. */}
      <AddClusterPanel />
    </section>
  );
}
