import { z } from 'zod';

export const percentSchema = z.number().min(0.01).max(0.99);

export const tenantSettingsSchema = z
  .object({
    warnThreshold: percentSchema,
    critThreshold: percentSchema,
  })
  .refine((s) => s.warnThreshold < s.critThreshold, {
    message: 'warnThreshold must be less than critThreshold',
    path: ['warnThreshold'],
  });

export const clusterSettingsInputSchema = z
  .object({
    warnThreshold: percentSchema.nullable(),
    critThreshold: percentSchema.nullable(),
  })
  .refine(
    (s) => {
      if (s.warnThreshold === null || s.critThreshold === null) return true;
      return s.warnThreshold < s.critThreshold;
    },
    {
      message: 'warnThreshold must be less than critThreshold',
      path: ['warnThreshold'],
    },
  );

export const effectiveThresholdsSchema = z.object({
  warn: z.number(),
  crit: z.number(),
  source: z.enum(['system', 'tenant', 'cluster']),
});

export const clusterSettingsResponseSchema = z.object({
  warnThreshold: z.number().nullable(),
  critThreshold: z.number().nullable(),
  effective: effectiveThresholdsSchema,
});

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;
export type ClusterSettingsInput = z.infer<typeof clusterSettingsInputSchema>;
export type EffectiveThresholds = z.infer<typeof effectiveThresholdsSchema>;
export type ClusterSettingsResponse = z.infer<typeof clusterSettingsResponseSchema>;
