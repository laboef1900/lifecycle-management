import { BaselineEditForm } from './baseline-edit-form';
import { ClusterIdentityForm } from './cluster-identity-form';
import { ClusterLifecycleCard } from './cluster-lifecycle-card';
import { ThresholdOverridesForm } from './threshold-overrides-form';

interface SettingsTabProps {
  clusterId: string;
}

export function SettingsTab({ clusterId }: SettingsTabProps): React.JSX.Element {
  return (
    <div className="space-y-6 py-4">
      <ThresholdOverridesForm clusterId={clusterId} />
      <ClusterIdentityForm clusterId={clusterId} />
      <BaselineEditForm clusterId={clusterId} />
      <ClusterLifecycleCard clusterId={clusterId} />
    </div>
  );
}
