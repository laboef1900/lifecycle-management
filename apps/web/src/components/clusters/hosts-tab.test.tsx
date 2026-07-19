import type { HostResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { api } from '@/lib/api-client';

import { HostsTab } from './hosts-tab';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeHost(overrides: Partial<HostResponse> = {}): HostResponse {
  return {
    id: 'host-1',
    clusterId: 'cl-1',
    name: 'esx-01',
    description: null,
    commissionedAt: '2025-06-01',
    decommissionedAt: null,
    serialNumber: null,
    vendor: null,
    model: null,
    purchasedAt: null,
    warrantyEndsAt: null,
    eolAt: null,
    runPastEol: false,
    state: 'in_service',
    projectedDecommissionAt: null,
    createdAt: '2025-06-01T00:00:00.000Z',
    updatedAt: '2025-06-01T00:00:00.000Z',
    capacities: [
      {
        id: 'cap-1',
        metricTypeKey: 'memory_gb',
        metricTypeDisplayName: 'Memory',
        unit: 'GB',
        effectiveFrom: '2025-06-01',
        amount: 1024,
      },
    ],
    ...overrides,
  };
}

function renderTab(canManage = true): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={0}>
        <HostsTab clusterId="cl-1" canManage={canManage} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('HostsTab', () => {
  beforeEach(() => {
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [makeHost(), makeHost({ id: 'host-2', name: 'esx-02' })],
      total: 2,
      limit: 500,
      offset: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a row per host', async () => {
    renderTab();

    expect(await screen.findByText('esx-01')).toBeInTheDocument();
    expect(screen.getByText('esx-02')).toBeInTheDocument();
  });

  it('shows the Add host button for managers and hides it for viewers', async () => {
    renderTab(true);
    expect(await screen.findByRole('button', { name: /add host/i })).toBeInTheDocument();

    cleanup();
    renderTab(false);
    await screen.findByText('esx-01');
    expect(screen.queryByRole('button', { name: /add host/i })).not.toBeInTheDocument();
  });

  it('shows a truncation note when the server total exceeds the fetched rows', async () => {
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [makeHost(), makeHost({ id: 'host-2', name: 'esx-02' })],
      total: 512,
      limit: 500,
      offset: 0,
    });
    renderTab();

    expect(await screen.findByText('esx-01')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Showing first 2 of 512 hosts.');
  });

  it('omits the truncation note when all hosts fit in one page', async () => {
    renderTab();

    expect(await screen.findByText('esx-01')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders the empty state (not a host row) when the cluster has no hosts', async () => {
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [],
      total: 0,
      limit: 500,
      offset: 0,
    });
    renderTab();

    expect(
      await screen.findByText('Add a host to start contributing capacity.'),
    ).toBeInTheDocument();
    expect(screen.getByText('No hosts yet.')).toBeInTheDocument();
    expect(screen.queryByText('esx-01')).not.toBeInTheDocument();
  });

  it('moves the Add host CTA into the empty state instead of duplicating the header button (#243 Part B)', async () => {
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [],
      total: 0,
      limit: 500,
      offset: 0,
    });
    renderTab();

    await screen.findByText('Add a host to start contributing capacity.');
    // Exactly one "Add host" control exists — the header CTA is hidden while
    // the table has no rows, so it never coexists with the empty state's own
    // action (avoiding two same-named controls, which would also make the
    // control ambiguous to find by accessible name).
    expect(screen.getAllByRole('button', { name: 'Add host' })).toHaveLength(1);
  });

  it('hides the empty-state action for viewers (no mutation affordance)', async () => {
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [],
      total: 0,
      limit: 500,
      offset: 0,
    });
    renderTab(false);

    await screen.findByText('Add a host to start contributing capacity.');
    expect(screen.queryByRole('button', { name: 'Add host' })).not.toBeInTheDocument();
  });

  it('shows skeleton placeholders while the hosts query is pending', () => {
    // A never-resolving fetch keeps the query in its pending state.
    vi.spyOn(api.hosts, 'listByCluster').mockReturnValue(new Promise<never>(() => {}));
    const { container } = renderTab();

    expect(container.querySelector('.animate-shimmer')).toBeInTheDocument();
    expect(
      screen.queryByText('Add a host to start contributing capacity.'),
    ).not.toBeInTheDocument();
  });

  it('replaces the date columns with one Lifecycle gantt cell per host, aria-labelled with all three dates', async () => {
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [
        makeHost({
          commissionedAt: '2024-03-15',
          warrantyEndsAt: '2027-03-15',
          eolAt: '2029-03-15',
        }),
        makeHost({ id: 'host-2', name: 'esx-02' }),
      ],
      total: 2,
      limit: 500,
      offset: 0,
    });
    renderTab();

    expect(await screen.findByText('esx-01')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Lifecycle' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Commissioned' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Decommissioned' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Warranty' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'EOL' })).not.toBeInTheDocument();

    const rows = screen.getAllByRole('img');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAccessibleName(
      'esx-01: commissioned 2024-03-15, warranty until 2027-03-15, hardware EOL 2029-03-15.',
    );
  });

  it('shows an actionable banner when synced hosts carry a provisional commissioning date', async () => {
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [
        makeHost({ commissionedAtProvisional: true }),
        makeHost({ id: 'host-2', name: 'esx-02' }),
      ],
      total: 2,
      limit: 500,
      offset: 0,
    });
    renderTab();

    expect(
      await screen.findByText(/1 host needs a confirmed commissioning date/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm date/i })).toBeInTheDocument();
  });

  it('omits the banner when no host is provisional', async () => {
    renderTab();

    expect(await screen.findByText('esx-01')).toBeInTheDocument();
    expect(screen.queryByText(/needs a confirmed commissioning date/i)).not.toBeInTheDocument();
  });

  it('hides the provisional banner from viewers', async () => {
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [makeHost({ commissionedAtProvisional: true })],
      total: 1,
      limit: 500,
      offset: 0,
    });
    renderTab(false);

    expect(await screen.findByText('esx-01')).toBeInTheDocument();
    expect(screen.queryByText(/needs a confirmed commissioning date/i)).not.toBeInTheDocument();
  });

  it('opens the confirm dialog from the banner CTA', async () => {
    const user = userEvent.setup();
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [makeHost({ commissionedAtProvisional: true })],
      total: 1,
      limit: 500,
      offset: 0,
    });
    renderTab();

    await screen.findByText('esx-01');
    await user.click(screen.getByRole('button', { name: /confirm date/i }));

    expect(await screen.findByRole('dialog')).toHaveTextContent('Confirm commissioning dates');
  });

  it('flags the provisional date with a non-colour-only badge in the expanded row', async () => {
    const user = userEvent.setup();
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [makeHost({ commissionedAtProvisional: true })],
      total: 1,
      limit: 500,
      offset: 0,
    });
    renderTab();

    await screen.findByText('esx-01');
    await user.click(screen.getByRole('button', { name: 'Expand history' }));

    expect(screen.getByText('Provisional')).toBeInTheDocument();
  });

  it('shows the full lifecycle dates in the expanded row content', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
      items: [
        makeHost({
          commissionedAt: '2024-03-15',
          warrantyEndsAt: '2027-03-15',
          eolAt: '2029-03-15',
        }),
      ],
      total: 1,
      limit: 500,
      offset: 0,
    });
    renderTab();

    expect(await screen.findByText('esx-01')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand history' }));

    expect(screen.getByText('Lifecycle dates')).toBeInTheDocument();
    expect(screen.getAllByText(/2024-03-15/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2027-03-15/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2029-03-15/).length).toBeGreaterThan(0);
  });

  it('table icon affordances hover with the neutral ghost tint, never brand amber (#243 Part B High-3)', async () => {
    renderTab();
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

  describe('row actions overflow menu (#243 Part B Medium)', () => {
    it('keeps only Edit and Transition as inline icon buttons, folding the rest behind "More actions"', async () => {
      renderTab();
      await screen.findByText('esx-01');

      const [firstRow] = screen.getAllByRole('row', { name: /esx-01/ });
      expect(firstRow).toBeDefined();
      const row = within(firstRow!);

      expect(row.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
      expect(row.getByRole('button', { name: 'Transition…' })).toBeInTheDocument();
      expect(row.getByRole('button', { name: 'More actions' })).toBeInTheDocument();

      // Everything else is not directly clickable — it only exists once the
      // overflow menu is opened (checked in the next test).
      expect(row.queryByRole('button', { name: /^Resize/ })).not.toBeInTheDocument();
      expect(row.queryByRole('button', { name: /^Decommission/ })).not.toBeInTheDocument();
      expect(row.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
      expect(row.queryByRole('button', { name: /^View history/ })).not.toBeInTheDocument();
    });

    it('opens the overflow menu via keyboard and lists text menu items with honest icons', async () => {
      const user = userEvent.setup();
      renderTab();
      await screen.findByText('esx-01');

      const [trigger] = screen.getAllByRole('button', { name: 'More actions' });
      trigger!.focus();
      await user.keyboard('{Enter}');

      const menu = await screen.findByRole('menu');
      const menuScope = within(menu);
      expect(menuScope.getByRole('menuitem', { name: /View history/ })).toBeInTheDocument();
      // Resize uses Scaling, not Plus (Plus already means "add a new host" on
      // the header CTA — WCAG SC 3.2.4 consistent identification).
      const resizeItem = menuScope.getByRole('menuitem', { name: /Resize/ });
      expect(resizeItem.querySelector('.lucide-scaling')).toBeInTheDocument();
      expect(resizeItem.querySelector('.lucide-plus')).not.toBeInTheDocument();
      // Decommission uses PowerOff — MoreVertical is freed for the overflow
      // trigger itself and must not also label this item.
      const decommissionItem = menuScope.getByRole('menuitem', { name: /Decommission/ });
      expect(decommissionItem.querySelector('.lucide-power-off')).toBeInTheDocument();
      expect(decommissionItem.querySelector('.lucide-more-vertical')).not.toBeInTheDocument();
      expect(menuScope.getByRole('menuitem', { name: /Delete/ })).toBeInTheDocument();
    });

    it('separates the destructive Decommission/Delete items from the frequent ones', async () => {
      const user = userEvent.setup();
      renderTab();
      await screen.findByText('esx-01');

      await user.click(screen.getAllByRole('button', { name: 'More actions' })[0]!);
      const menu = await screen.findByRole('menu');

      expect(within(menu).getByRole('menuitem', { name: /Decommission/ })).toHaveClass(
        'text-destructive',
      );
      expect(within(menu).getByRole('menuitem', { name: /Delete/ })).toHaveClass(
        'text-destructive',
      );
      // The frequent group (History, Resize) stays the default (non-destructive) tint.
      expect(within(menu).getByRole('menuitem', { name: /View history/ })).not.toHaveClass(
        'text-destructive',
      );
    });

    it('still opens the existing confirmation dialogs for Decommission and Delete from the menu', async () => {
      // Regression coverage: opening a Dialog straight from a DropdownMenuItem
      // onSelect, with Radix's defaults, fights an infinite focus loop between
      // the closing menu (returning focus to its trigger) and the opening
      // dialog's own FocusScope — RowActions' onCloseAutoFocus guard exists
      // for exactly this. This test previously blew the call stack before
      // that guard was added.
      const user = userEvent.setup();
      renderTab();
      await screen.findByText('esx-01');

      await user.click(screen.getAllByRole('button', { name: 'More actions' })[0]!);
      await user.click(await screen.findByRole('menuitem', { name: /Delete/ }));

      expect(await screen.findByRole('dialog', { name: /delete esx-01/i })).toBeInTheDocument();
    });

    it('opens the Decommission dialog from the menu without a focus-loop crash', async () => {
      const user = userEvent.setup();
      renderTab();
      await screen.findByText('esx-01');

      await user.click(screen.getAllByRole('button', { name: 'More actions' })[0]!);
      await user.click(await screen.findByRole('menuitem', { name: /Decommission/ }));

      expect(await screen.findByRole('dialog')).toBeInTheDocument();
    });

    it('returns focus to the trigger when the menu is dismissed without selecting an item', async () => {
      const user = userEvent.setup();
      renderTab();
      await screen.findByText('esx-01');

      const trigger = screen.getAllByRole('button', { name: 'More actions' })[0]!;
      await user.click(trigger);
      await screen.findByRole('menu');
      await user.keyboard('{Escape}');

      expect(trigger).toHaveFocus();
    });

    it('shows Replace… only for decommissioned hosts', async () => {
      const user = userEvent.setup();
      vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
        items: [makeHost({ state: 'decommissioned', decommissionedAt: '2026-01-01' })],
        total: 1,
        limit: 500,
        offset: 0,
      });
      renderTab();
      await screen.findByText('esx-01');

      await user.click(screen.getByRole('button', { name: 'More actions' }));
      expect(await screen.findByRole('menuitem', { name: /Replace/ })).toBeInTheDocument();
    });

    it('keeps a disabled Transition button focusable, with its reason reachable via the tooltip', async () => {
      const user = userEvent.setup();
      vi.spyOn(api.hosts, 'listByCluster').mockResolvedValue({
        items: [makeHost({ state: 'disposed' })],
        total: 1,
        limit: 500,
        offset: 0,
      });
      renderTab();
      await screen.findByText('esx-01');

      const transitionBtn = screen.getByRole('button', { name: 'No further transitions' });
      // Not natively disabled — a real `disabled` attribute would remove it
      // from the tab order and make the explanation unreachable by keyboard.
      expect(transitionBtn).not.toBeDisabled();
      expect(transitionBtn).toHaveAttribute('aria-disabled', 'true');

      await user.tab();
      // Keep tabbing until we reach it (row 1 has Edit before Transition).
      let guard = 0;
      while (document.activeElement !== transitionBtn && guard < 5) {
        await user.tab();
        guard += 1;
      }
      expect(transitionBtn).toHaveFocus();
      // Two matches by design (ui/tooltip.tsx): the visible bubble plus
      // Radix's visually-hidden `role="tooltip"` echo for assistive tech —
      // findAllByText, not findByText, which would fail on the duplicate.
      const reason = await screen.findAllByText('No further transitions');
      expect(reason.length).toBeGreaterThan(0);
    });

    it('never falls back to native title= tooltips on the row actions', async () => {
      renderTab();
      await screen.findByText('esx-01');

      const rowButtons = Array.from(document.querySelectorAll('td button'));
      expect(rowButtons.length).toBeGreaterThan(0);
      for (const btn of rowButtons) {
        expect(btn).not.toHaveAttribute('title');
        expect(btn).toHaveAttribute('aria-label');
      }
    });
  });

  describe('sticky Actions column at phone width (#243 Part B Low)', () => {
    it('marks the Actions header and cells sticky with an opaque, bordered surface', async () => {
      renderTab();
      await screen.findByText('esx-01');

      const header = screen.getByRole('columnheader', { name: 'Actions' });
      expect(header).toHaveClass('sticky', 'right-0', 'bg-card', 'border-l');

      const [firstRow] = screen.getAllByRole('row', { name: /esx-01/ });
      const actionsCell = firstRow!.querySelector('td.sticky');
      expect(actionsCell).not.toBeNull();
      expect(actionsCell).toHaveClass(
        'right-0',
        'bg-card',
        'border-l',
        'group-hover:bg-card-hover',
      );
      // The row itself carries `group` so the sticky cell's hover match works.
      expect(firstRow).toHaveClass('group');
    });
  });
});
