-- Opt-in empirical forecast uncertainty band settings.
-- See docs/design/forecast-uncertainty-band.md. Additive, non-destructive:
-- three columns on tenant_settings with defaults mirroring the @lcm/shared
-- DEFAULT_FORECAST_UNCERTAINTY_* constants. Off by default.
ALTER TABLE "tenant_settings" ADD COLUMN "forecast_uncertainty_band_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenant_settings" ADD COLUMN "forecast_uncertainty_min_anchors" INTEGER NOT NULL DEFAULT 6;
ALTER TABLE "tenant_settings" ADD COLUMN "forecast_uncertainty_band_width" TEXT NOT NULL DEFAULT 'p10_p90';
