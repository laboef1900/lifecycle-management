import type { ForecastAcknowledgment } from '@lcm/shared';

/**
 * Pure coverage rules for order approvals (#292, DESIGN.md §3). No Prisma here
 * on purpose: both the read path (forecast-loader) and the write path
 * (OrderApprovalService) depend on these, so keeping them side-effect-free
 * avoids a service import cycle and makes the crux of the feature unit-testable
 * in isolation.
 */

/**
 * Drift-vs-worsening boundary `T` (DESIGN.md §3 amendment / INV-5). `breachMonth`
 * naturally drifts as the forecast anchor advances, so a live order-by date must
 * move at least this many days EARLIER than the approved one to count as a
 * genuine worsening that supersedes the approval; smaller wobble is absorbed.
 * A named constant so the boundary is discoverable and, later, promotable to a
 * `TenantSettings` field (not required for v1).
 */
export const ORDER_APPROVAL_SUPERSEDE_TOLERANCE_DAYS = 31;

/** `capacitySignature` sums Decimal(18,3) amounts; compare with a sub-milli epsilon. */
const CAPACITY_SIGNATURE_EPSILON = 1e-6;
/** `warnThreshold` derives from Decimal(4,3); compare with a tight epsilon. */
const WARN_THRESHOLD_EPSILON = 1e-9;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A host as far as the capacity signature is concerned. */
export interface CapacitySignatureHost {
  /** `null` ⇒ active. A set decommission date (even future) excludes the host. */
  decommissionedAt: Date | null;
  capacities: ReadonlyArray<{ effectiveFrom: Date; amount: number }>;
}

/**
 * `capacitySignature` = Σ nameplate capacity across the cluster's ACTIVE
 * (non-decommissioned) hosts for the metric (DESIGN.md §3). A host's nameplate
 * is its latest capacity row (max `effectiveFrom`). This is a change-detector,
 * not a point-in-time capacity: adding, decommissioning, or resizing a host
 * moves the number; a true like-for-like swap (old decommissioned + new of
 * identical capacity) leaves it unchanged — which is correct, because the breach
 * does not move either.
 */
export function computeCapacitySignature(hosts: ReadonlyArray<CapacitySignatureHost>): number {
  let sum = 0;
  for (const host of hosts) {
    if (host.decommissionedAt !== null) continue;
    let latest: { effectiveFrom: Date; amount: number } | null = null;
    for (const row of host.capacities) {
      if (latest === null || row.effectiveFrom > latest.effectiveFrom) latest = row;
    }
    if (latest !== null) sum += latest.amount;
  }
  return sum;
}

/** The live procurement facts an approval is checked against. */
export interface LiveBreachSnapshot {
  /** `YYYY-MM-DD`, or `null` when the live forecast has no breach. */
  orderByDate: string | null;
  warnThreshold: number;
  capacitySignature: number;
}

/** The stored approval fields the coverage rule reads (the latest row per cluster). */
export interface StoredApprovalSnapshot {
  orderByDate: Date;
  warnThreshold: number;
  capacitySignature: number;
  note: string | null;
  approvedByLabel: string;
  createdAt: Date;
}

function approxEqual(a: number, b: number, epsilon: number): boolean {
  return Math.abs(a - b) <= epsilon;
}

/**
 * DESIGN.md §3 (amended) coverage rule. A live breach is ACKNOWLEDGED iff the
 * latest approval still matches every operator-controlled input:
 *
 *  - a live breach exists (INV-3: no breach ⇒ no acknowledgment), AND
 *  - `capacitySignature` is unchanged (INV-2), AND
 *  - `warnThreshold` is unchanged (INV-2), AND
 *  - the breach has not worsened on its own: the live `orderByDate` is not
 *    earlier than the approved one by ≥ `T` (INV-5). Only the earlier direction
 *    supersedes; a breach moving later (improving) never does.
 *
 * Any mismatch → `null` (superseded / re-surfaces unacknowledged). Ordinary
 * anchor/consumption drift only moves `breachMonth`, which the `T` tolerance
 * absorbs, so there is no false re-acknowledgment churn.
 */
export function resolveAcknowledgment(
  latest: StoredApprovalSnapshot | null,
  live: LiveBreachSnapshot,
): ForecastAcknowledgment | null {
  if (live.orderByDate === null) return null; // INV-3
  if (latest === null) return null;
  if (!approxEqual(latest.capacitySignature, live.capacitySignature, CAPACITY_SIGNATURE_EPSILON)) {
    return null; // INV-2 (capacity generation changed)
  }
  if (!approxEqual(latest.warnThreshold, live.warnThreshold, WARN_THRESHOLD_EPSILON)) {
    return null; // INV-2 (threshold changed)
  }
  const liveOrderBy = new Date(`${live.orderByDate}T00:00:00.000Z`).getTime();
  const daysEarlier = (latest.orderByDate.getTime() - liveOrderBy) / MS_PER_DAY;
  if (daysEarlier >= ORDER_APPROVAL_SUPERSEDE_TOLERANCE_DAYS) {
    return null; // INV-5 (materially worsened on its own)
  }
  return {
    note: latest.note,
    approvedByLabel: latest.approvedByLabel,
    approvedAt: latest.createdAt.toISOString(),
  };
}
