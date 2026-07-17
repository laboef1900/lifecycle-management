import type { HostResponse } from '@lcm/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ganttDomain, HostLifecycleGantt, HostLifecycleGanttRow } from './host-lifecycle-gantt';

function makeHost(overrides: Partial<HostResponse> = {}): HostResponse {
  return {
    id: 'host-1',
    clusterId: 'cl-1',
    name: 'esx-01',
    description: null,
    commissionedAt: '2024-03-15',
    decommissionedAt: null,
    serialNumber: null,
    vendor: null,
    model: null,
    purchasedAt: null,
    warrantyEndsAt: '2027-03-15',
    eolAt: '2029-03-15',
    runPastEol: false,
    state: 'in_service',
    projectedDecommissionAt: null,
    createdAt: '2024-03-15T00:00:00.000Z',
    updatedAt: '2024-03-15T00:00:00.000Z',
    capacities: [],
    ...overrides,
  };
}

const TODAY = new Date('2026-07-16T00:00:00Z');

describe('ganttDomain', () => {
  it('spans min commissioned to max of eol/decommissioned/projected across hosts, padded a month each side', () => {
    const hosts = [
      makeHost({ id: 'a', commissionedAt: '2024-03-15', eolAt: '2029-01-10' }),
      makeHost({
        id: 'b',
        commissionedAt: '2023-06-01',
        eolAt: null,
        decommissionedAt: '2027-05-01',
      }),
      makeHost({
        id: 'c',
        commissionedAt: '2025-01-01',
        eolAt: null,
        decommissionedAt: null,
        projectedDecommissionAt: '2030-02-01',
      }),
    ];

    const domain = ganttDomain(hosts);

    expect(domain.min.toISOString().slice(0, 10)).toBe('2023-05-01');
    expect(domain.max.toISOString().slice(0, 10)).toBe('2030-03-01');
  });

  it('falls back to the commissioned span when no host has any end date', () => {
    const hosts = [
      makeHost({
        id: 'a',
        commissionedAt: '2025-06-01',
        eolAt: null,
        decommissionedAt: null,
        projectedDecommissionAt: null,
      }),
    ];

    const domain = ganttDomain(hosts);

    expect(domain.min.toISOString().slice(0, 10)).toBe('2025-05-01');
    expect(domain.max.toISOString().slice(0, 10)).toBe('2025-07-01');
  });

  it('returns a degenerate today/today domain for an empty host list', () => {
    const domain = ganttDomain([]);
    expect(domain.min.getTime()).toBe(domain.max.getTime());
  });
});

describe('HostLifecycleGantt', () => {
  it('renders one row per host, each an accessible image with commissioned, warranty, and EOL dates', () => {
    const hosts = [
      makeHost({ id: 'a', name: 'esx-01' }),
      makeHost({
        id: 'b',
        name: 'esx-02',
        commissionedAt: '2022-01-01',
        warrantyEndsAt: '2025-01-01', // expired relative to TODAY
        eolAt: '2028-01-01',
      }),
    ];
    render(<HostLifecycleGantt hosts={hosts} today={TODAY} />);

    const rows = screen.getAllByRole('img');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAccessibleName(
      /esx-01: commissioned 2024-03-15, warranty until 2027-03-15, hardware EOL 2029-03-15\./,
    );
    expect(rows[1]).toHaveAccessibleName(
      /esx-02: commissioned 2022-01-01, warranty expired 2025-01-01, hardware EOL 2028-01-01\./,
    );
  });

  it('shows a WTY EXPIRED marker only for hosts whose warranty date is in the past', () => {
    const hosts = [
      makeHost({ id: 'a', name: 'fresh', warrantyEndsAt: '2028-01-01' }),
      makeHost({ id: 'b', name: 'stale', warrantyEndsAt: '2020-01-01' }),
    ];
    render(<HostLifecycleGantt hosts={hosts} today={TODAY} />);

    expect(screen.getAllByText('WTY EXPIRED')).toHaveLength(1);
  });

  it('handles a null warranty or EOL date gracefully in the aria-label', () => {
    const hosts = [makeHost({ id: 'a', name: 'bare', warrantyEndsAt: null, eolAt: null })];
    render(<HostLifecycleGantt hosts={hosts} today={TODAY} />);

    expect(screen.getByRole('img')).toHaveAccessibleName(
      'bare: commissioned 2024-03-15, warranty not recorded, hardware EOL not projected.',
    );
  });

  it('renders nothing for an empty host list', () => {
    const { container } = render(<HostLifecycleGantt hosts={[]} today={TODAY} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('HostLifecycleGanttRow bar end date (MINOR #7)', () => {
  const DOMAIN = { min: new Date('2023-01-01T00:00:00Z'), max: new Date('2030-01-01T00:00:00Z') };
  const VB_WIDTH = 600;

  function expectedX(dateOnly: string): number {
    const span = DOMAIN.max.getTime() - DOMAIN.min.getTime();
    const t = new Date(`${dateOnly}T00:00:00Z`).getTime();
    const pct = ((t - DOMAIN.min.getTime()) / span) * 100;
    return (Math.max(0, Math.min(100, pct)) / 100) * VB_WIDTH;
  }

  it('ends the bar at the decommission date, not a later hardware EOL projection', () => {
    const host = makeHost({
      commissionedAt: '2024-01-01',
      decommissionedAt: '2026-06-01',
      eolAt: '2029-01-01', // later than decommission — must not be used as the bar end
    });
    const { container } = render(
      <HostLifecycleGanttRow host={host} domain={DOMAIN} today={TODAY} />,
    );
    const rect = container.querySelector('rect');
    expect(rect).not.toBeNull();
    const endX = Number(rect!.getAttribute('x')) + Number(rect!.getAttribute('width'));

    expect(endX).toBeCloseTo(expectedX('2026-06-01'), 1);
    // The end-of-bar label follows the same date, not the stale EOL text.
    expect(screen.getByText('2026-06-01')).toBeInTheDocument();
    expect(screen.queryByText('2029-01-01')).not.toBeInTheDocument();
  });

  it('falls back to the hardware EOL date when the host is not decommissioned', () => {
    const host = makeHost({
      commissionedAt: '2024-01-01',
      decommissionedAt: null,
      eolAt: '2029-01-01',
    });
    const { container } = render(
      <HostLifecycleGanttRow host={host} domain={DOMAIN} today={TODAY} />,
    );
    const rect = container.querySelector('rect');
    const endX = Number(rect!.getAttribute('x')) + Number(rect!.getAttribute('width'));

    expect(endX).toBeCloseTo(expectedX('2029-01-01'), 1);
    expect(screen.getByText('2029-01-01')).toBeInTheDocument();
  });

  it('falls back to the domain max when neither decommissionedAt nor eolAt is set', () => {
    const host = makeHost({ commissionedAt: '2024-01-01', decommissionedAt: null, eolAt: null });
    const { container } = render(
      <HostLifecycleGanttRow host={host} domain={DOMAIN} today={TODAY} />,
    );
    const rect = container.querySelector('rect');
    const endX = Number(rect!.getAttribute('x')) + Number(rect!.getAttribute('width'));

    expect(endX).toBeCloseTo(VB_WIDTH, 1);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
