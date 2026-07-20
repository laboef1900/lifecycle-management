import { z } from 'zod';

export const percentSchema = z.number().min(0.01).max(0.99);

export const procurementLeadTimeWeeksSchema = z.number().int().min(0).max(104);

/**
 * How long a stored idempotency-key record survives before cleanup — also the
 * bound on how stale a replayed response may be, since one TTL serves both
 * purposes (design doc §Invariants). 1–168h (1 hour to 7 days); 24 is the
 * default, matching the DB column's own default.
 */
export const idempotencyKeyRetentionHoursSchema = z.number().int().min(1).max(168);

export const tenantSettingsSchema = z
  .strictObject({
    warnThreshold: percentSchema,
    critThreshold: percentSchema,
    procurementLeadTimeWeeks: procurementLeadTimeWeeksSchema,
    idempotencyKeyRetentionHours: idempotencyKeyRetentionHoursSchema,
  })
  .refine((s) => s.warnThreshold < s.critThreshold, {
    message: 'warnThreshold must be less than critThreshold',
    path: ['warnThreshold'],
  });

export const clusterSettingsInputSchema = z
  .strictObject({
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
