import type { EffectiveThresholds } from '@lcm/shared';
import { SYSTEM_DEFAULTS } from '@lcm/shared';
import { useQuery } from '@tanstack/react-query';

import { api } from './api-client';

const FIVE_MINUTES = 5 * 60_000;

/**
 * Resolves effective warn/crit thresholds for a given cluster (or tenant if no
 * id is provided). Always returns defined values — falls back to
 * SYSTEM_DEFAULTS if neither the network call has resolved nor server data
 * exists. The `source` field reports where the values came from.
 */
export function useEffectiveThresholds(clusterId?: string): EffectiveThresholds {
  const clusterQuery = useQuery({
    queryKey: ['cluster-settings', clusterId],
    queryFn: () => api.settings.cluster.get(clusterId!),
    enabled: Boolean(clusterId),
    staleTime: FIVE_MINUTES,
  });
  const tenantQuery = useQuery({
    queryKey: ['tenant-settings'],
    queryFn: () => api.settings.tenant.get(),
    enabled: !clusterId,
    staleTime: FIVE_MINUTES,
  });

  if (clusterId && clusterQuery.data) {
    return clusterQuery.data.effective;
  }
  if (!clusterId && tenantQuery.data) {
    return {
      warn: tenantQuery.data.warnThreshold,
      crit: tenantQuery.data.critThreshold,
      source: 'tenant',
    };
  }
  return { warn: SYSTEM_DEFAULTS.warn, crit: SYSTEM_DEFAULTS.crit, source: 'system' };
}
