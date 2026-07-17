import type { ClusterResponse, LiveUsage } from '@lcm/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  connectionHealth,
  describeLiveUsage,
  formatLiveAge,
  formatUsedGiB,
  LiveUsageInline,
  LiveUsageSection,
  ProvisionalHostHint,
  staleReasonLabel,
  SyncStateBadge,
} from './live-usage';

function manualCluster(overrides: Partial<ClusterResponse> = {}): ClusterResponse {
  return {
    id: 'c1',
    name: 'CL-Prod',
    description: null,
    baselineDate: '2026-06-01',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    archivedAt: null,
    metrics: [],
    source: 'manual',
    lastSyncedAt: null,
    externalName: null,
    connection: null,
    provisionalHostCount: 0,
    ...overrides,
  };
}

function syncedCluster(overrides: Partial<ClusterResponse> = {}): ClusterResponse {
  return manualCluster({
    source: 'vsphere',
    lastSyncedAt: '2026-08-01T09:00:00Z',
    externalName: 'Production',
    connection: { id: 'conn1', name: 'vc-prod-zrh', status: 'active', enabled: true },
    provisionalHostCount: 0,
    ...overrides,
  });
}

const fresh: Extract<LiveUsage, { state: 'fresh' }> = {
  state: 'fresh',
  clusterId: 'c1',
  connectionName: 'vc-prod-zrh',
  memoryUsedGiB: 1234.5,
  hostsSampled: 8,
  hostsTotal: 8,
  measuredAt: '2026-08-01T11:59:00Z',
  ageSeconds: 120,
};

const neverFetched: LiveUsage = {
  state: 'never_fetched',
  clusterId: 'c1',
  connectionName: 'vc-prod-zrh',
};

describe('live-usage helpers', () => {
  it('formatUsedGiB renders whole GiB with separators — never a percentage', () => {
    expect(formatUsedGiB(1234.5)).toBe('1,235 GiB');
    expect(formatUsedGiB(0)).toBe('0 GiB');
  });

  it('formatLiveAge reads the SERVER age, not a recomputed clock', () => {
    expect(formatLiveAge(10)).toBe('just now');
    expect(formatLiveAge(120)).toBe('2m ago');
    expect(formatLiveAge(7200)).toBe('2h ago');
    expect(formatLiveAge(180_000)).toBe('2d ago');
  });

  it('each stale reason keeps a distinct, actionable label', () => {
    const labels = new Set(
      (
        ['unreachable', 'auth_failed', 'tls_untrusted', 'identity_mismatch', 'disabled'] as const
      ).map(staleReasonLabel),
    );
    expect(labels.size).toBe(5);
  });

  it('connectionHealth preserves secret_undecryptable as its own state', () => {
    const health = connectionHealth({
      id: 'x',
      name: 'vc',
      status: 'secret_undecryptable',
      enabled: true,
    });
    expect(health).toMatchObject({ tone: 'crit', showLabel: true });
    expect(health.label).not.toBe('unreachable');
  });
});

describe('<SyncStateBadge>', () => {
  it('renders nothing for a manual cluster (unchanged appearance)', () => {
    const { container } = render(<SyncStateBadge cluster={manualCluster()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reads "vSphere" with no degraded word for a healthy connection', () => {
    render(<SyncStateBadge cluster={syncedCluster()} />);
    expect(screen.getByText('vSphere')).toBeInTheDocument();
  });

  it('names a degraded state in words, not colour alone', () => {
    render(
      <SyncStateBadge
        cluster={syncedCluster({
          connection: { id: 'conn1', name: 'vc', status: 'auth_failed', enabled: true },
        })}
      />,
    );
    expect(screen.getByText(/vSphere · sign-in failed/)).toBeInTheDocument();
  });

  it('shows "paused" for a disabled connection', () => {
    render(
      <SyncStateBadge
        cluster={syncedCluster({
          connection: { id: 'conn1', name: 'vc', status: 'disabled', enabled: false },
        })}
      />,
    );
    expect(screen.getByText(/vSphere · paused/)).toBeInTheDocument();
  });
});

describe('<LiveUsageInline> — the discriminated union', () => {
  it('renders nothing for a manual cluster', () => {
    const { container } = render(
      <LiveUsageInline cluster={manualCluster()} live={undefined} isPending={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('★ never_fetched says "not yet measured" — NOT 0', () => {
    render(<LiveUsageInline cluster={syncedCluster()} live={neverFetched} isPending={false} />);
    expect(screen.getByText('not yet measured')).toBeInTheDocument();
    // The 0%-lie must not appear anywhere.
    expect(screen.queryByText(/0 GiB/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0%/)).not.toBeInTheDocument();
  });

  it('fresh renders the absolute reading + freshness', () => {
    render(<LiveUsageInline cluster={syncedCluster()} live={fresh} isPending={false} />);
    expect(screen.getByText('1,235 GiB')).toBeInTheDocument();
    expect(screen.getByText(/2m ago/)).toBeInTheDocument();
  });

  it('★ a partial read is signalled, not shown as a real consumption drop', () => {
    render(
      <LiveUsageInline
        cluster={syncedCluster()}
        live={{ ...fresh, hostsSampled: 6, hostsTotal: 8 }}
        isPending={false}
      />,
    );
    expect(screen.getByText(/6\/8 hosts/)).toBeInTheDocument();
  });

  it('stale keeps the last-known value AND names the reason', () => {
    render(
      <LiveUsageInline
        cluster={syncedCluster()}
        live={{ ...fresh, state: 'stale', reason: 'unreachable' }}
        isPending={false}
      />,
    );
    expect(screen.getByText('1,235 GiB')).toBeInTheDocument();
    expect(screen.getByText(/stale \(vCenter unreachable\)/)).toBeInTheDocument();
  });

  it('shows a skeleton, not a zero, while the batch is still loading', () => {
    const { container } = render(
      <LiveUsageInline cluster={syncedCluster()} live={undefined} isPending />,
    );
    expect(screen.queryByText(/GiB/)).not.toBeInTheDocument();
    expect(container.querySelector('.animate-shimmer')).not.toBeNull();
  });
});

describe('<LiveUsageSection> — cluster panel', () => {
  it('renders nothing for a manual cluster (no connection)', () => {
    const { container } = render(
      <LiveUsageSection cluster={manualCluster()} live={undefined} isPending={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('★ never_fetched shows an EmptyState "Not yet measured", never a 0 reading', () => {
    render(<LiveUsageSection cluster={syncedCluster()} live={neverFetched} isPending={false} />);
    expect(screen.getByText('Not yet measured')).toBeInTheDocument();
    expect(screen.queryByText(/0 GiB/)).not.toBeInTheDocument();
  });

  it('renders the reading and the inventory-sync date for a fresh reading', () => {
    render(<LiveUsageSection cluster={syncedCluster()} live={fresh} isPending={false} />);
    expect(screen.getByText('1,235 GiB')).toBeInTheDocument();
    expect(screen.getByText(/8\/8 hosts/)).toBeInTheDocument();
    expect(screen.getByText(/Inventory synced 2026-08-01/)).toBeInTheDocument();
  });

  it('surfaces the "hosts need commissioning dates" hint when provisional', () => {
    render(
      <LiveUsageSection
        cluster={syncedCluster({ provisionalHostCount: 3 })}
        live={fresh}
        isPending={false}
      />,
    );
    expect(screen.getByText(/3 HOSTS NEED DATES/)).toBeInTheDocument();
  });
});

describe('<ProvisionalHostHint>', () => {
  it('renders nothing at zero', () => {
    const { container } = render(<ProvisionalHostHint count={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('singularizes at one', () => {
    render(<ProvisionalHostHint count={1} />);
    expect(screen.getByText(/1 HOST NEED DATES/)).toBeInTheDocument();
  });
});

describe('describeLiveUsage — accessible summary', () => {
  it('is empty for a manual cluster', () => {
    expect(describeLiveUsage(manualCluster(), undefined)).toBe('');
  });

  it('says "not yet measured" for never_fetched — never 0', () => {
    const text = describeLiveUsage(syncedCluster(), neverFetched);
    expect(text).toMatch(/not yet measured/);
    expect(text).not.toMatch(/0 GiB/);
  });

  it('describes a fresh reading with coverage and freshness', () => {
    const text = describeLiveUsage(syncedCluster(), { ...fresh, hostsSampled: 6, hostsTotal: 8 });
    expect(text).toMatch(/1,235 GiB/);
    expect(text).toMatch(/6 of 8 hosts reporting/);
    expect(text).toMatch(/updated 2m ago/);
  });
});
