/** Format a Date as its UTC calendar date, `YYYY-MM-DD`. */
export function formatDateIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const SHORT_FMT: Intl.DateTimeFormatOptions = { month: 'short', year: '2-digit', timeZone: 'UTC' };
const LONG_FMT: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric', timeZone: 'UTC' };

/** `'2026-06-01'` → `'Jun 26'` */
export function formatMonthShort(month: string): string {
  return new Date(`${month}T00:00:00Z`).toLocaleDateString('en-US', SHORT_FMT);
}

/** `'2026-06-01'` → `'June 2026'` */
export function formatMonthLong(month: string): string {
  return new Date(`${month}T00:00:00Z`).toLocaleDateString('en-US', LONG_FMT);
}

/**
 * Add calendar months in UTC, clamping the day-of-month to the target month's
 * length (Jan 31 + 1mo = Feb 28/29). Time-of-day is preserved.
 */
export function addUtcMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const daysInMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, daysInMonth));
  return result;
}

/** The relative units a bulk date shift may be expressed in. */
export type DateShiftUnit = 'days' | 'weeks' | 'months';

const MS_PER_DAY = 86_400_000;

/**
 * Move a UTC calendar date by a signed relative amount.
 *
 * Shared deliberately: the server applies the shift and the web dialog previews
 * it, and the two MUST agree exactly — a preview that disagrees with the write
 * turns the confirmation step into a lie. Months delegate to `addUtcMonths`, so
 * day-of-month clamping (Jan 31 + 1mo = Feb 28) is identical on both sides.
 *
 * @ai-warning Month clamping is monotone but NOT injective: Jan 29 and Jan 31
 * both land on Feb 28. Callers shifting a *set* of dates that must stay
 * distinct (an item's allocation rows) have to re-check distinctness after the
 * shift — use `hasShiftCollision` below.
 */
export function shiftDateByUnit(date: Date, amount: number, unit: DateShiftUnit): Date {
  if (unit === 'months') return addUtcMonths(date, amount);
  const days = unit === 'weeks' ? amount * 7 : amount;
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/** One allocation row reduced to what a collision check needs. */
export interface ShiftCollisionRow {
  /** Grouping key — rows only ever collide within the same metric. */
  metric: string;
  effectiveFrom: Date;
}

/**
 * Whether a uniform shift would collapse two allocation rows of the same metric
 * onto a single date — the non-injectivity warned about on `shiftDateByUnit`.
 *
 * Shared so the server's write path and the web dialog's preview cannot drift.
 * Duplicating these few lines on the client would silently stop matching the
 * server the first time either side changed, putting the operator back to
 * discovering the conflict only after clicking Apply.
 */
export function hasShiftCollision(
  allocations: readonly ShiftCollisionRow[],
  amount: number,
  unit: DateShiftUnit,
): boolean {
  const seenPerMetric = new Map<string, Set<number>>();
  for (const row of allocations) {
    const shifted = shiftDateByUnit(row.effectiveFrom, amount, unit).getTime();
    const seen = seenPerMetric.get(row.metric) ?? new Set<number>();
    if (seen.has(shifted)) return true;
    seen.add(shifted);
    seenPerMetric.set(row.metric, seen);
  }
  return false;
}

/** Inclusive bounds for any date this app will persist, as UTC epoch ms. */
const MIN_SUPPORTED_DATE_MS = Date.UTC(1970, 0, 1);
const MAX_SUPPORTED_DATE_MS = Date.UTC(2999, 11, 31);

/**
 * Whether `date` is a real date inside the range the `YYYY-MM-DD` wire format
 * and the Postgres `date` column can both represent. A large relative shift can
 * push a date outside it (or, at the extreme, to `Invalid Date`), which must be
 * rejected rather than written.
 */
export function isSupportedDate(date: Date): boolean {
  const ms = date.getTime();
  return Number.isFinite(ms) && ms >= MIN_SUPPORTED_DATE_MS && ms <= MAX_SUPPORTED_DATE_MS;
}

/**
 * The first of `date`'s month at 00:00 UTC — the canonical **period anchor**.
 *
 * Every baseline's `capturedAt` is snapped through here, whether entered by hand
 * or captured by the monthly vSphere snapshot. That is what makes
 * `@@unique([clusterId, metricTypeId, capturedAt])` mean "one truth per month"
 * rather than "one truth per day": a snapshot job that restarts and re-runs on a
 * different day of the same month recomputes the same anchor and conflicts,
 * instead of appending a second competing baseline for that period.
 *
 * @ai-note Anchoring on day 1 also sidesteps `addUtcMonths`' day-clamping — any
 * other anchor would drift permanently to the 28th after one pass through
 * February.
 */
export function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** Whole-month difference between two UTC dates (to minus from). */
export function monthsBetweenUtc(from: Date, to: Date): number {
  return (
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
  );
}
