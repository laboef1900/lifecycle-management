import { z } from 'zod';

export const percentSchema = z.number().min(0.01).max(0.99);

export const procurementLeadTimeWeeksSchema = z.number().int().min(0).max(104);

/**
 * Default idempotency-key retention when no `tenant_settings` row exists yet.
 * Single source of truth for the "24" mirrored by the Prisma column's own
 * `@default(24)` (a separate literal baked into the migration SQL, which a JS
 * constant can't reach) — server code should import this rather than
 * re-hardcoding the number.
 */
export const DEFAULT_IDEMPOTENCY_KEY_RETENTION_HOURS = 24;

/**
 * How long a stored idempotency-key record survives before cleanup — also the
 * bound on how stale a replayed response may be, since one TTL serves both
 * purposes (design doc §Invariants). 1–168h (1 hour to 7 days);
 * `DEFAULT_IDEMPOTENCY_KEY_RETENTION_HOURS` is the default, matching the DB
 * column's own default.
 */
export const idempotencyKeyRetentionHoursSchema = z.number().int().min(1).max(168);

/**
 * Opt-in forecast uncertainty band (see docs/design/forecast-uncertainty-band.md).
 * The band is EMPIRICAL — derived from measured past forecast error — never
 * fabricated, so it stays off by default and needs a minimum number of real
 * re-anchors before it can be shown.
 */
export const forecastUncertaintyBandWidthSchema = z.enum(['p10_p90', 'p05_p95', 'stddev']);
/** Minimum measured re-anchors before a cluster shows a band; 3–24, default 6. */
export const forecastUncertaintyMinAnchorsSchema = z.number().int().min(3).max(24);

export const tenantSettingsSchema = z
  .strictObject({
    warnThreshold: percentSchema,
    critThreshold: percentSchema,
    procurementLeadTimeWeeks: procurementLeadTimeWeeksSchema,
    idempotencyKeyRetentionHours: idempotencyKeyRetentionHoursSchema,
    forecastUncertaintyBandEnabled: z.boolean(),
    forecastUncertaintyMinAnchors: forecastUncertaintyMinAnchorsSchema,
    forecastUncertaintyBandWidth: forecastUncertaintyBandWidthSchema,
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
export type ForecastUncertaintyBandWidth = z.infer<typeof forecastUncertaintyBandWidthSchema>;

/** Defaults for the opt-in uncertainty band, mirrored by the Prisma column defaults. */
export const DEFAULT_FORECAST_UNCERTAINTY_MIN_ANCHORS = 6;
export const DEFAULT_FORECAST_UNCERTAINTY_BAND_WIDTH: ForecastUncertaintyBandWidth = 'p10_p90';
export type ClusterSettingsInput = z.infer<typeof clusterSettingsInputSchema>;
export type EffectiveThresholds = z.infer<typeof effectiveThresholdsSchema>;
export type ClusterSettingsResponse = z.infer<typeof clusterSettingsResponseSchema>;
