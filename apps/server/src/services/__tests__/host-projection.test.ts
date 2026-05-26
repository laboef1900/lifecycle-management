import { describe, it, expect } from 'vitest';
import type { HostState } from '@prisma/client';

import { projectedDecommissionDate, type ProjectableHost } from '../host-projection.js';

const baseHost = (overrides: Partial<ProjectableHost> = {}): ProjectableHost => ({
  state: 'in_service',
  eolAt: new Date('2027-06-01'),
  runPastEol: false,
  replacedByLinks: [],
  ...overrides,
});

const successor = (commissionedAt: Date, state: HostState = 'in_service') => ({
  new: { commissionedAt, state },
});

describe('projectedDecommissionDate', () => {
  it('returns eolAt when no successor exists', () => {
    expect(projectedDecommissionDate(baseHost())).toEqual(new Date('2027-06-01'));
  });

  it('returns null when runPastEol is true', () => {
    expect(projectedDecommissionDate(baseHost({ runPastEol: true }))).toBeNull();
  });

  it('returns null when eolAt is null', () => {
    expect(projectedDecommissionDate(baseHost({ eolAt: null }))).toBeNull();
  });

  it('returns null when host state is not active', () => {
    expect(projectedDecommissionDate(baseHost({ state: 'decommissioned' }))).toBeNull();
    expect(projectedDecommissionDate(baseHost({ state: 'disposed' }))).toBeNull();
  });

  it('returns null when an active successor is commissioned on or before eolAt', () => {
    expect(
      projectedDecommissionDate(
        baseHost({ replacedByLinks: [successor(new Date('2027-06-01'), 'in_service')] }),
      ),
    ).toBeNull();
    expect(
      projectedDecommissionDate(
        baseHost({ replacedByLinks: [successor(new Date('2027-01-01'), 'degraded')] }),
      ),
    ).toBeNull();
  });

  it('returns eolAt when the successor is commissioned AFTER eolAt', () => {
    expect(
      projectedDecommissionDate(
        baseHost({ replacedByLinks: [successor(new Date('2027-09-01'), 'in_service')] }),
      ),
    ).toEqual(new Date('2027-06-01'));
  });

  it('returns eolAt when the successor exists but is itself disposed', () => {
    expect(
      projectedDecommissionDate(
        baseHost({ replacedByLinks: [successor(new Date('2027-01-01'), 'disposed')] }),
      ),
    ).toEqual(new Date('2027-06-01'));
  });

  it('returns eolAt when the successor exists but is itself decommissioned', () => {
    expect(
      projectedDecommissionDate(
        baseHost({ replacedByLinks: [successor(new Date('2027-01-01'), 'decommissioned')] }),
      ),
    ).toEqual(new Date('2027-06-01'));
  });

  it('returns null if at least one active successor covers the EOL among multiple replacements', () => {
    expect(
      projectedDecommissionDate(
        baseHost({
          replacedByLinks: [
            successor(new Date('2027-01-01'), 'disposed'),
            successor(new Date('2027-05-01'), 'in_service'),
          ],
        }),
      ),
    ).toBeNull();
  });
});
