import type { ItemResponse } from '@lcm/shared';
import { MAX_BULK_SHIFT_ITEMS } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';

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
      {/* app.tsx mounts TooltipProvider app-wide; the row-action IconButtons
          use Radix Tooltip, so isolated renders need it too. */}
      <TooltipProvider delayDuration={0}>
        <ItemsTab clusterId="cl-1" canManage={canManage} />
      </TooltipProvider>
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

  it('routes app row actions through an honest kebab (WCAG 3.2.4)', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('openshift-lab');
    // Edit is the one inline row action, reachable by its accessible name.
    expect(screen.getAllByRole('button', { name: 'Edit' }).length).toBeGreaterThan(0);
    // Everything else lives behind a "More actions" kebab with honest labels —
    // no more Plus-means-Resize / kebab-glyph-means-End glyph collisions.
    await user.click(screen.getAllByRole('button', { name: 'More actions' })[0]!);
    expect(await screen.findByRole('menuitem', { name: /Resize/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /End/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Delete/ })).toBeInTheDocument();
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

describe('ItemsTab — bulk date shift (#256)', () => {
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

  const openShiftDialog = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
    await user.click(await screen.findByRole('checkbox', { name: 'Select all apps and events' }));
    await user.click(screen.getByRole('button', { name: /Shift dates/ }));
  };

  it('hides the selection checkboxes from viewers', async () => {
    renderTab(false);
    await screen.findByText('openshift-lab');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('reveals the action bar with a live count once a row is selected', async () => {
    const user = userEvent.setup();
    renderTab();

    expect(screen.queryByRole('button', { name: /Shift dates/ })).not.toBeInTheDocument();

    await user.click(await screen.findByRole('checkbox', { name: 'Select openshift-lab' }));
    expect(screen.getByRole('status')).toHaveTextContent('1 selected');
    expect(screen.getByRole('button', { name: /Shift dates/ })).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Select Wachstum Q4' }));
    expect(screen.getByRole('status')).toHaveTextContent('2 selected');
  });

  it('select-all toggles every row, and goes indeterminate on a partial selection', async () => {
    const user = userEvent.setup();
    renderTab();

    const selectAll = (await screen.findByRole('checkbox', {
      name: 'Select all apps and events',
    })) as HTMLInputElement;

    await user.click(selectAll);
    expect(screen.getByRole('status')).toHaveTextContent('2 selected');
    expect(selectAll.checked).toBe(true);
    expect(selectAll.indeterminate).toBe(false);

    // Unticking one row leaves the header in the mixed state.
    await user.click(screen.getByRole('checkbox', { name: 'Select Wachstum Q4' }));
    expect(screen.getByRole('status')).toHaveTextContent('1 selected');
    expect(selectAll.checked).toBe(false);
    expect(selectAll.indeterminate).toBe(true);

    // Toggling the header again from the mixed state selects everything.
    await user.click(selectAll);
    expect(screen.getByRole('status')).toHaveTextContent('2 selected');
  });

  it('clears the selection and hides the action bar', async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole('checkbox', { name: 'Select openshift-lab' }));
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));

    expect(screen.queryByRole('button', { name: /Shift dates/ })).not.toBeInTheDocument();
  });

  it('previews the old → new date for every selected entry before applying', async () => {
    const user = userEvent.setup();
    renderTab();
    await openShiftDialog(user);

    const preview = within(screen.getByRole('region', { name: 'Date change preview' }));

    // Defaults are +1 month, so the app moves 2026-01-15 → 2026-02-15 and the
    // event 2026-03-01 → 2026-04-01.
    const appRow = preview.getByText('openshift-lab').closest('li');
    expect(appRow).toHaveTextContent('2026-01-15');
    expect(appRow).toHaveTextContent('2026-02-15');

    const eventRow = preview.getByText('Wachstum Q4').closest('li');
    expect(eventRow).toHaveTextContent('2026-03-01');
    expect(eventRow).toHaveTextContent('2026-04-01');
  });

  it('tells the operator that an application s allocation dates cascade', async () => {
    const user = userEvent.setup();
    renderTab();
    await openShiftDialog(user);

    const preview = within(screen.getByRole('region', { name: 'Date change preview' }));
    expect(preview.getByText('openshift-lab').closest('li')).toHaveTextContent(
      'also moves 1 allocation date',
    );
    // The event carries no allocations, so it gets no cascade note.
    expect(preview.getByText('Wachstum Q4').closest('li')).not.toHaveTextContent('also moves');
  });

  it('recomputes the preview when the direction or unit changes', async () => {
    const user = userEvent.setup();
    renderTab();
    await openShiftDialog(user);

    await user.click(screen.getByRole('button', { name: 'Earlier' }));
    const preview = within(screen.getByRole('region', { name: 'Date change preview' }));
    expect(preview.getByText('Wachstum Q4').closest('li')).toHaveTextContent('2026-02-01');

    await user.click(screen.getByRole('button', { name: 'Days' }));
    expect(preview.getByText('Wachstum Q4').closest('li')).toHaveTextContent('2026-02-28');
  });

  it('sends one signed shift for the whole selection and clears it afterwards', async () => {
    const user = userEvent.setup();
    const bulkShift = vi.spyOn(api.items, 'bulkShiftDates').mockResolvedValue({
      shifted: 2,
      items: [],
    });
    renderTab();
    await openShiftDialog(user);

    await user.click(screen.getByRole('button', { name: 'Earlier' }));
    await user.clear(screen.getByLabelText(/Amount/));
    await user.type(screen.getByLabelText(/Amount/), '3');
    await user.click(screen.getByRole('button', { name: 'Shift 2 entries' }));

    await waitFor(() =>
      expect(bulkShift).toHaveBeenCalledWith(
        {
          itemIds: ['app-1', 'evt-1'],
          shift: { amount: -3, unit: 'months' },
        },
        expect.stringMatching(/^[0-9a-f-]{36}$/i),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Shift dates/ })).not.toBeInTheDocument(),
    );
  });

  it('flags an entry whose allocation dates would collide, before submit', async () => {
    // Jan 29 and Jan 31 both clamp to Feb 28 under a +1 month shift — the
    // server rejects that with SHIFT_ALLOCATION_COLLISION, so the preview has
    // to surface it rather than letting the operator eat a whole-batch 422.
    const colliding = makeApplication();
    const base = colliding.allocations[0];
    if (!base) throw new Error('fixture must have an allocation to clone');
    colliding.effectiveDate = '2026-01-29';
    colliding.allocations = [
      { ...base, id: 'alloc-1', effectiveFrom: '2026-01-29' },
      { ...base, id: 'alloc-2', effectiveFrom: '2026-01-31' },
    ];
    vi.spyOn(api.items, 'listByCluster').mockResolvedValue({
      items: [colliding, makeEvent()],
      total: 2,
      limit: 100,
      offset: 0,
    });
    const bulkShift = vi.spyOn(api.items, 'bulkShiftDates');

    const user = userEvent.setup();
    renderTab();
    await openShiftDialog(user);

    const preview = within(screen.getByRole('region', { name: 'Date change preview' }));
    // Distinct wording from out-of-range: the operator needs to know which
    // entry and why, since the fix is a different amount or a deselect.
    expect(preview.getByText('openshift-lab').closest('li')).toHaveTextContent('date conflict');
    expect(preview.getByText('Wachstum Q4').closest('li')).toHaveTextContent('2026-04-01');
    expect(
      screen.getByText(/would put two of its allocation dates on the same day/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Shift 2 entries' })).toBeDisabled();

    // Switching to a unit that never clamps clears the conflict.
    await user.click(screen.getByRole('button', { name: 'Days' }));
    expect(preview.getByText('openshift-lab').closest('li')).not.toHaveTextContent('date conflict');
    expect(screen.getByRole('button', { name: 'Shift 2 entries' })).toBeEnabled();
    expect(bulkShift).not.toHaveBeenCalled();
  });

  it('blocks the shift when the selection exceeds the batch cap', async () => {
    const many = Array.from({ length: MAX_BULK_SHIFT_ITEMS + 1 }, (_, i) => ({
      ...makeEvent(),
      id: `evt-${i}`,
      name: `event-${i}`,
    }));
    vi.spyOn(api.items, 'listByCluster').mockResolvedValue({
      items: many,
      total: many.length,
      limit: 500,
      offset: 0,
    });

    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole('checkbox', { name: 'Select all apps and events' }));

    expect(screen.getByRole('status')).toHaveTextContent(`${MAX_BULK_SHIFT_ITEMS + 1} selected`);
    expect(screen.getByRole('alert')).toHaveTextContent(
      `Shift at most ${MAX_BULK_SHIFT_ITEMS} at a time.`,
    );
    expect(screen.getByRole('button', { name: /Shift dates/ })).toBeDisabled();

    // Dropping back to the cap re-enables it.
    await user.click(screen.getByRole('checkbox', { name: 'Select event-0' }));
    expect(screen.getByRole('button', { name: /Shift dates/ })).toBeEnabled();
  });

  it('blocks the apply button while the amount is invalid', async () => {
    const user = userEvent.setup();
    const bulkShift = vi.spyOn(api.items, 'bulkShiftDates');
    renderTab();
    await openShiftDialog(user);

    await user.clear(screen.getByLabelText(/Amount/));
    await user.type(screen.getByLabelText(/Amount/), '999');

    expect(screen.getByText('At most 120 months')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Shift 2 entries' })).toBeDisabled();
    expect(bulkShift).not.toHaveBeenCalled();
  });
});
