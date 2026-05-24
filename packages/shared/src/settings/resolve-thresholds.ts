export const SYSTEM_DEFAULTS = { warn: 0.7, crit: 0.9 } as const;

export interface ResolvedThresholds {
  warn: number;
  crit: number;
}

export interface TenantThresholdsInput {
  warnThreshold: number;
  critThreshold: number;
}

export interface ClusterThresholdsInput {
  warnThreshold: number | null;
  critThreshold: number | null;
}

export function resolveThresholds(
  clusterSettings: ClusterThresholdsInput | null,
  tenantSettings: TenantThresholdsInput | null,
  defaults: ResolvedThresholds = SYSTEM_DEFAULTS,
): ResolvedThresholds {
  return {
    warn: clusterSettings?.warnThreshold ?? tenantSettings?.warnThreshold ?? defaults.warn,
    crit: clusterSettings?.critThreshold ?? tenantSettings?.critThreshold ?? defaults.crit,
  };
}
