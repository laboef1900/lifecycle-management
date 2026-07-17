import { createFileRoute } from '@tanstack/react-router';

import { FleetConsole } from '@/components/fleet/fleet-console';

export const Route = createFileRoute('/_app/')({
  component: FleetConsole,
});
