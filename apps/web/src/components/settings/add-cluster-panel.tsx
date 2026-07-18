import { AdminOnly } from '@/components/auth/admin-only';
import { CreateClusterDialog } from '@/components/clusters/create-cluster-dialog';
import { Card } from '@/components/ui/card';

/**
 * Settings panel hosting the manual "Add cluster" action (#223). Adding a
 * cluster by hand is a configuration task, not a day-to-day monitoring action,
 * so it lives with the other Settings panels rather than on the fleet console.
 *
 * Admin-only: the whole section is hidden from viewers (the server 403s the
 * mutation regardless — this is the matching UX affordance).
 */
export function AddClusterPanel(): React.JSX.Element {
  return (
    <AdminOnly>
      <Card className="p-6">
        <header className="mb-4">
          <h2 className="font-display text-lg">Add cluster</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Manually track a vSphere cluster that isn&rsquo;t synced from a vCenter connection. You
            provide the memory baseline; the forecast builds from there.
          </p>
        </header>
        <CreateClusterDialog />
      </Card>
    </AdminOnly>
  );
}
