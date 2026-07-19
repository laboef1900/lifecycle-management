import { BaselineEditForm } from './baseline-edit-form';
import { ClusterIdentityForm } from './cluster-identity-form';
import { ClusterLifecycleCard } from './cluster-lifecycle-card';
import { ThresholdOverridesForm } from './threshold-overrides-form';

interface SettingsTabProps {
  clusterId: string;
}

export function SettingsTab({ clusterId }: SettingsTabProps): React.JSX.Element {
  // max-w-2xl caps the whole tab (#243 Part B — Medium: numeric inputs and row
  // actions were stretching across the full ~1360px panel width), matching
  // the same cap the global Settings forms use.
  return (
    <div className="max-w-2xl space-y-6 py-4">
      <ThresholdOverridesForm clusterId={clusterId} />
      <ClusterIdentityForm clusterId={clusterId} />
      <BaselineEditForm clusterId={clusterId} />
      <ClusterLifecycleCard clusterId={clusterId} />
    </div>
  );
}
