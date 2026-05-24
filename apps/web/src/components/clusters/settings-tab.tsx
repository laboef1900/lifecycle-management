import { ThresholdOverridesForm } from './threshold-overrides-form';

interface SettingsTabProps {
  clusterId: string;
}

export function SettingsTab({ clusterId }: SettingsTabProps): React.JSX.Element {
  return (
    <div className="space-y-6 py-4">
      <ThresholdOverridesForm clusterId={clusterId} />
    </div>
  );
}
