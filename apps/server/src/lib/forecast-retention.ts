import {
  FORECAST_SNAPSHOT_RETENTION_DISABLED,
  FORECAST_SNAPSHOT_RETENTION_MAX_MONTHS,
  FORECAST_SNAPSHOT_RETENTION_MIN_MONTHS,
  startOfUtcMonth,
} from '@lcm/shared';

/**
 * Retention cutoff for `forecast_snapshot` rows (#318) — the OLDEST
 * `horizonMonth` that survives. `null` means retention is off and nothing is
 * bounded (the default).
 *
 * @ai-note THE single definition of the cutoff. Both the band's read
 * (`ForecastService.computeUncertainty`) and the prune
 * (`ForecastSnapshotCleanup.sweep`) call this one function, which is what makes
 * the core invariant hold by construction: the sweep can only ever delete rows
 * the read had already stopped considering, so a band never changes because a
 * sweep ran. Do not inline a second cutoff calculation anywhere.
 *
 * @ai-warning Keyed on `horizonMonth`, never on `anchorMonth` or `createdAt`. A
 * projection and the horizon-0 row supplying its measured actual share the same
 * `horizonMonth`, so a `horizonMonth` predicate retains or deletes BOTH — the
 * pairing hazard is structurally impossible rather than merely tested for. An
 * `anchorMonth`-keyed prune is pairing-safe too but silently caps the band's
 * horizon (deleting an anchor destroys its h24 row, the only possible evidence
 * of 24-month error).
 *
 * The window is INCLUSIVE of the current month: `retentionMonths = 12` at
 * 2026-07 retains 2025-08…2026-07. One retained month can hold at most one
 * sample per horizon index, so `retentionMonths` is also the ceiling on any
 * horizon's sample count.
 *
 * @ai-warning Any value outside `{0} ∪ [MIN, MAX]` returns `null` — retention
 * OFF — rather than being clamped into range. The schema already rejects those
 * on write, so reaching here means a direct DB write bypassed it, and the safe
 * response to an out-of-spec window on a DESTRUCTIVE operation is to prune
 * nothing rather than to invent a window nobody configured. Clamping would be
 * the weaker default CLAUDE.md's resilience rule forbids: it turns a bad value
 * into real, unrecoverable deletes. The caller is expected to notice the
 * `null`-with-nonzero-months case and log it (`ForecastSnapshotCleanup.runSweep`
 * does); silence would hide the tampering.
 *
 * Mirrors `SettingsService`'s `coerceBandWidth`, which fails an out-of-enum
 * band width safe to the default for the same reason.
 */
export function retentionCutoffMonth(thisMonth: Date, retentionMonths: number): Date | null {
  if (retentionMonths <= FORECAST_SNAPSHOT_RETENTION_DISABLED) return null;
  if (
    retentionMonths < FORECAST_SNAPSHOT_RETENTION_MIN_MONTHS ||
    retentionMonths > FORECAST_SNAPSHOT_RETENTION_MAX_MONTHS
  ) {
    return null;
  }
  const anchor = startOfUtcMonth(thisMonth);
  return new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - (retentionMonths - 1), 1),
  );
}
