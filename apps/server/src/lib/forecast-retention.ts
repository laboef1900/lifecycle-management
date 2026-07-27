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
 * OFF — rather than being clamped into range. This is the SAME rule
 * `SettingsService.coerceBandWidth` already applies: fall back to the schema
 * default. It just looks different here because
 * `DEFAULT_FORECAST_SNAPSHOT_RETENTION_MONTHS` IS
 * `FORECAST_SNAPSHOT_RETENTION_DISABLED` — this field's default is "off" — so
 * "fall back to the default" and "prune nothing" are the same instruction. It
 * is not a bespoke policy invented for this field.
 *
 * Why not clamp: the schema forecloses the dead zone on every legitimate write
 * path, so the only way an out-of-spec value reaches here is tampering or
 * corruption — never an operator's intent partially expressed. There is no
 * legitimate-intent case for clamping to serve, and clamping would convert an
 * unauthorised value into real, unrecoverable deletes the moment the sweep runs.
 * A bit-flipped column is not the authorisation Golden Rule 3 requires.
 *
 * And clamping UP is not the safer direction either, which is the tempting
 * mistake: a stored `5` may be a torn or partial write of what was meant to be
 * `0` (disabled). In that case ANY non-null cutoff — clamped up to 12 or down —
 * deletes history the operator explicitly asked to keep forever. Null for every
 * out-of-range value is the only answer that cannot do that, which is why the
 * check is a rejection and not a `Math.min`/`Math.max`.
 *
 * The caller is expected to notice the `null`-with-nonzero-months case and log
 * it (`ForecastSnapshotCleanup.runSweep` does); silence would hide the tampering.
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
