import { describe, expect, it } from 'vitest';

import {
  computeCapacitySignature,
  ORDER_APPROVAL_SUPERSEDE_TOLERANCE_DAYS,
  resolveAcknowledgment,
  type StoredApprovalSnapshot,
} from '../services/order-approval-coverage.js';

/**
 * Pure coverage-rule unit tests (#292, DESIGN.md §3/§10). No Prisma, no Docker —
 * this is the crux of the feature, isolated from the HTTP + DB integration tests
 * in `order-approvals.test.ts`.
 */

const APPROVED_ORDER_BY = new Date('2026-06-01T00:00:00.000Z');

function stored(overrides: Partial<StoredApprovalSnapshot> = {}): StoredApprovalSnapshot {
  return {
    orderByDate: APPROVED_ORDER_BY,
    warnThreshold: 0.7,
    capacitySignature: 10000,
    note: 'approved — parts on order',
    approvedByLabel: 'ada@example.com',
    createdAt: new Date('2026-05-20T12:00:00.000Z'),
    ...overrides,
  };
}

/** ISO date `daysAfter` days after the approved order-by (negative ⇒ earlier). */
function orderByShifted(days: number): string {
  const shifted = new Date(APPROVED_ORDER_BY.getTime() + days * 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

describe('computeCapacitySignature', () => {
  it('sums the latest capacity of active hosts and ignores decommissioned ones', () => {
    const signature = computeCapacitySignature([
      {
        decommissionedAt: null,
        capacities: [
          { effectiveFrom: new Date('2026-01-01'), amount: 4000 },
          // Latest effectiveFrom wins (the nameplate), not the first or the sum.
          { effectiveFrom: new Date('2026-05-01'), amount: 6000 },
        ],
      },
      {
        decommissionedAt: null,
        capacities: [{ effectiveFrom: new Date('2026-01-01'), amount: 2000 }],
      },
      // Decommissioned: excluded even though it still has a capacity row.
      {
        decommissionedAt: new Date('2026-04-01'),
        capacities: [{ effectiveFrom: new Date('2026-01-01'), amount: 9000 }],
      },
    ]);
    expect(signature).toBe(6000 + 2000);
  });

  it('is unchanged by a like-for-like swap (old decommissioned + new identical)', () => {
    const before = computeCapacitySignature([
      {
        decommissionedAt: null,
        capacities: [{ effectiveFrom: new Date('2026-01-01'), amount: 5000 }],
      },
    ]);
    const after = computeCapacitySignature([
      {
        decommissionedAt: new Date('2026-06-01'),
        capacities: [{ effectiveFrom: new Date('2026-01-01'), amount: 5000 }],
      },
      {
        decommissionedAt: null,
        capacities: [{ effectiveFrom: new Date('2026-06-01'), amount: 5000 }],
      },
    ]);
    expect(after).toBe(before);
  });
});

describe('resolveAcknowledgment', () => {
  it('acknowledges when signature + threshold match and the breach has not worsened', () => {
    const ack = resolveAcknowledgment(stored(), {
      orderByDate: orderByShifted(0),
      warnThreshold: 0.7,
      capacitySignature: 10000,
    });
    expect(ack).toEqual({
      note: 'approved — parts on order',
      approvedByLabel: 'ada@example.com',
      approvedAt: '2026-05-20T12:00:00.000Z',
    });
  });

  it('returns null when there is no live breach (INV-3)', () => {
    expect(
      resolveAcknowledgment(stored(), {
        orderByDate: null,
        warnThreshold: 0.7,
        capacitySignature: 10000,
      }),
    ).toBeNull();
  });

  it('returns null when there is no prior approval', () => {
    expect(
      resolveAcknowledgment(null, {
        orderByDate: orderByShifted(0),
        warnThreshold: 0.7,
        capacitySignature: 10000,
      }),
    ).toBeNull();
  });

  it('supersedes when the capacity signature changed (INV-2)', () => {
    expect(
      resolveAcknowledgment(stored(), {
        orderByDate: orderByShifted(0),
        warnThreshold: 0.7,
        capacitySignature: 10500,
      }),
    ).toBeNull();
  });

  it('supersedes when the warn threshold changed (INV-2)', () => {
    expect(
      resolveAcknowledgment(stored(), {
        orderByDate: orderByShifted(0),
        warnThreshold: 0.6,
        capacitySignature: 10000,
      }),
    ).toBeNull();
  });

  it('keeps the acknowledgment when the breach drifts earlier by less than T (INV-5)', () => {
    expect(
      resolveAcknowledgment(stored(), {
        orderByDate: orderByShifted(-(ORDER_APPROVAL_SUPERSEDE_TOLERANCE_DAYS - 1)),
        warnThreshold: 0.7,
        capacitySignature: 10000,
      }),
    ).not.toBeNull();
  });

  it('supersedes when the breach drifts earlier by T or more (INV-5)', () => {
    expect(
      resolveAcknowledgment(stored(), {
        orderByDate: orderByShifted(-ORDER_APPROVAL_SUPERSEDE_TOLERANCE_DAYS),
        warnThreshold: 0.7,
        capacitySignature: 10000,
      }),
    ).toBeNull();
  });

  it('keeps the acknowledgment when the breach moves later (improving)', () => {
    expect(
      resolveAcknowledgment(stored(), {
        orderByDate: orderByShifted(400),
        warnThreshold: 0.7,
        capacitySignature: 10000,
      }),
    ).not.toBeNull();
  });

  it('tolerates float noise in signature/threshold comparisons', () => {
    expect(
      resolveAcknowledgment(stored({ warnThreshold: 0.7, capacitySignature: 10000 }), {
        orderByDate: orderByShifted(0),
        warnThreshold: 0.1 + 0.6, // 0.7000000000000001
        capacitySignature: 10000.0000001,
      }),
    ).not.toBeNull();
  });
});
