import type { ItemResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { ItemsTab } from './items-tab';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeApplication(): ItemResponse {
  return {
    id: 'app-1',
    clusterId: 'cl-1',
    kind: 'application',
    name: 'openshift-lab',
    category: 'OpenShift',
    description: null,
    effectiveDate: '2026-01-15',
    endedAt: null,
    metricTypeKey: null,
    consumptionDelta: null,
    capacityDelta: null,
    allocations: [
      {
        id: 'alloc-1',
        metricTypeKey: 'memory_gb',
        metricTypeDisplayName: 'Memory',
        unit: 'GB',
        effectiveFrom: '2026-01-15',
        amount: 512,
      },
    ],
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
  };
}

function makeEvent(): ItemResponse {
  return {
    id: 'evt-1',
    clusterId: 'cl-1',
    kind: 'event',
    name: 'Wachstum Q4',
    category: 'Growth',
    description: null,
    effectiveDate: '2026-03-01',
    endedAt: null,
    metricTypeKey: 'memory_gb',
    consumptionDelta: 750,
    capacityDelta: null,
    allocations: [],
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
  };
}

function renderTab(canManage = true): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ItemsTab clusterId="cl-1" canManage={canManage} />
    </QueryClientProvider>,
  );
}

describe('ItemsTab', () => {
  beforeEach(() => {
    vi.spyOn(api.items, 'listByCluster').mockResolvedValue({
      items: [makeApplication(), makeEvent()],
      total: 2,
      limit: 100,
      offset: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the Add app or event button for managers and hides it for viewers', async () => {
    renderTab(true);
    // Renamed from "Add item" (#243 Part B) — the domain never calls these
    // "items", only apps and events.
    expect(await screen.findByRole('button', { name: 'Add app or event' })).toBeInTheDocument();

    cleanup();
    renderTab(false);
    await screen.findByText('openshift-lab');
    expect(screen.queryByRole('button', { name: 'Add app or event' })).not.toBeInTheDocument();
  });

  it('renders both application and event rows with type and category', async () => {
    renderTab();

    // Names of both items render.
    expect(await screen.findByText('openshift-lab')).toBeInTheDocument();
    expect(screen.getByText('Wachstum Q4')).toBeInTheDocument();

    // A Type badge for each kind.
    expect(screen.getByText('Application')).toBeInTheDocument();
    expect(screen.getByText('Event')).toBeInTheDocument();

    // Category text for each item.
    expect(screen.getByText('OpenShift')).toBeInTheDocument();
    expect(screen.getByText('Growth')).toBeInTheDocument();
  });

  it('colors the category badge by its semantic variant', async () => {
    renderTab();

    // OpenShift maps to the neutral default variant; Growth to warning.
    expect((await screen.findByText('OpenShift')).closest('[data-variant]')).toHaveAttribute(
      'data-variant',
      'default',
    );
    expect(screen.getByText('Growth').closest('[data-variant]')).toHaveAttribute(
      'data-variant',
      'warning',
    );
  });

  it('shows a truncation note when the server total exceeds the fetched rows', async () => {
    vi.spyOn(api.items, 'listByCluster').mockResolvedValue({
      items: [makeApplication(), makeEvent()],
      total: 750,
      limit: 500,
      offset: 0,
    });
    renderTab();

    expect(await screen.findByText('openshift-lab')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Showing first 2 of 750 items.');
  });

  it('omits the truncation note when all items fit in one page', async () => {
    renderTab();

    expect(await screen.findByText('openshift-lab')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders the empty state (not an item row) when the cluster has no items', async () => {
    vi.spyOn(api.items, 'listByCluster').mockResolvedValue({
      items: [],
      total: 0,
      limit: 500,
      offset: 0,
    });
    renderTab();

    expect(
      await screen.findByText(
        'Add an application to track its memory allocation, or an event to annotate the forecast.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('No apps or events yet.')).toBeInTheDocument();
    expect(screen.queryByText('openshift-lab')).not.toBeInTheDocument();
  });

  it('moves the Add app or event CTA into the empty state instead of duplicating the header button (#243 Part B)', async () => {
    vi.spyOn(api.items, 'listByCluster').mockResolvedValue({
      items: [],
      total: 0,
      limit: 500,
      offset: 0,
    });
    renderTab();

    // Wait for the EmptyState's own (unique) title, not the header subtitle
    // — "No apps or events yet." renders from the very first paint (items
    // defaults to [] while the query is still pending), so it resolves
    // before the mocked fetch settles and races the assertion below.
    await screen.findByText(
      'Add an application to track its memory allocation, or an event to annotate the forecast.',
    );
    // Exactly one "Add app or event" control — the header CTA is hidden while
    // the table has no rows, so it never coexists with the empty state's own
    // action.
    expect(screen.getAllByRole('button', { name: 'Add app or event' })).toHaveLength(1);
  });

  it('hides the empty-state action for viewers (no mutation affordance)', async () => {
    vi.spyOn(api.items, 'listByCluster').mockResolvedValue({
      items: [],
      total: 0,
      limit: 500,
      offset: 0,
    });
    renderTab(false);

    await screen.findByText(
      'Add an application to track its memory allocation, or an event to annotate the forecast.',
    );
    expect(screen.queryByRole('button', { name: 'Add app or event' })).not.toBeInTheDocument();
  });

  it('shows skeleton placeholders while the items query is pending', () => {
    // A never-resolving fetch keeps the query in its pending state.
    vi.spyOn(api.items, 'listByCluster').mockReturnValue(new Promise<never>(() => {}));
    const { container } = renderTab();

    expect(container.querySelector('.animate-shimmer')).toBeInTheDocument();
    expect(
      screen.queryByText(
        'Add an application to track its memory allocation, or an event to annotate the forecast.',
      ),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('openshift-lab')).not.toBeInTheDocument();
  });

  it('table icon affordances hover with the neutral ghost tint, never brand amber (#243 Part B High-3)', async () => {
    renderTab();
    // Only application rows get the expand chevron; the beforeEach data has one.
    await screen.findAllByRole('button', { name: 'Expand history' });
    // Positive: the expand chevron and the h-7/w-7 icon-action buttons use the
    // ghost pairing (amber hover computes ~1.33:1 dark — SC 1.4.3).
    for (const btn of screen.getAllByRole('button', { name: 'Expand history' })) {
      expect(btn).toHaveClass('hover:bg-card-hover');
      // Muted base, foreground on hover: inside a hovered row the row already
      // paints --card-hover, so the *text* transition is the visible affordance
      // (review finding — without a muted base both hover halves were no-ops).
      expect(btn).toHaveClass('text-muted-foreground', 'hover:text-foreground');
    }
    const iconButtons = Array.from(document.querySelectorAll('button.h-7.w-7'));
    expect(iconButtons.length).toBeGreaterThan(0);
    for (const btn of iconButtons) {
      expect(btn.className).toMatch(/hover:bg-card-hover|hover:bg-destructive\/10/);
    }
    // Negative: no bare shadcn hover:bg-accent leftovers anywhere in the tab.
    const offenders = Array.from(document.querySelectorAll('button')).filter((b) =>
      /(?:^|\s)hover:bg-accent(?:\s|$)/.test(b.className),
    );
    expect(offenders).toEqual([]);
  });
});
