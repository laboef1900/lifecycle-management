import type { ItemResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { BulkQuarterlyGrowthDialog, CreateItemDialog, EditItemDialog } from './item-dialogs';

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

function renderEditDialog(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <EditItemDialog open onOpenChange={vi.fn()} clusterId="cl-1" item={makeApplication()} />
    </QueryClientProvider>,
  );
}

describe('<EditItemDialog> validation', () => {
  beforeEach(() => {
    vi.spyOn(api.settings.categories, 'list').mockResolvedValue([
      { id: 'c1', name: 'OpenShift' },
      { id: 'c2', name: 'Growth' },
    ]);
    vi.spyOn(api.items, 'update').mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blocks submit with an inline error when the name is empty', async () => {
    const user = userEvent.setup();
    renderEditDialog();

    const nameInput = screen.getByRole('textbox', { name: 'Name' });
    // The native `required` attribute fires before our Zod layer; drop it so the
    // schema-driven validation path is the one under test.
    nameInput.removeAttribute('required');
    await user.clear(nameInput);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/too small/i)).toBeInTheDocument();
    expect(api.items.update).not.toHaveBeenCalled();
  });

  it('moves focus to the Name field on a failed submit', async () => {
    const user = userEvent.setup();
    renderEditDialog();

    const nameInput = screen.getByRole('textbox', { name: 'Name' });
    nameInput.removeAttribute('required');
    await user.clear(nameInput);
    screen.getByRole('button', { name: 'Save' }).focus();

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(nameInput).toHaveFocus());
  });
});

describe('<CreateItemDialog> invalidation', () => {
  beforeEach(() => {
    vi.spyOn(api.settings.categories, 'list').mockResolvedValue([{ id: 'c1', name: 'OpenShift' }]);
    vi.spyOn(api.items, 'create').mockResolvedValue(makeApplication());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invalidates the cluster and clusters queries after a successful create', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(['cluster', 'cl-1'], {});
    client.setQueryData(['clusters'], []);
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <CreateItemDialog open onOpenChange={vi.fn()} clusterId="cl-1" />
      </QueryClientProvider>,
    );

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'openshift-lab');
    await user.type(screen.getByLabelText('Category'), 'OpenShift');
    await user.click(screen.getByRole('button', { name: /add application/i }));

    await waitFor(() => {
      expect(client.getQueryState(['cluster', 'cl-1'])?.isInvalidated).toBe(true);
      expect(client.getQueryState(['clusters'])?.isInvalidated).toBe(true);
    });
  });
});

describe('<BulkQuarterlyGrowthDialog>', () => {
  beforeEach(() => {
    vi.spyOn(api.settings.categories, 'list').mockResolvedValue([{ id: 'c1', name: 'Growth' }]);
    vi.spyOn(api.items, 'bulkCreateQuarterlyGrowth').mockResolvedValue({
      created: 4,
      items: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderDialog(): void {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <BulkQuarterlyGrowthDialog open onOpenChange={vi.fn()} clusterId="cl-1" />
      </QueryClientProvider>,
    );
  }

  it('defaults every quarter to its own "Wachstum Qn" title', () => {
    renderDialog();
    const titles = screen.getAllByRole('textbox', { name: 'Title' });
    expect(titles.map((el) => (el as HTMLInputElement).value)).toEqual([
      'Wachstum Q1',
      'Wachstum Q2',
      'Wachstum Q3',
      'Wachstum Q4',
    ]);
  });

  it('submits all four quarters sharing the same category and metric', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /add 4 entries/i }));

    await waitFor(() => expect(api.items.bulkCreateQuarterlyGrowth).toHaveBeenCalled());
    const payload = vi.mocked(api.items.bulkCreateQuarterlyGrowth).mock.calls[0]?.[1];
    expect(payload?.category).toBe('Growth');
    expect(payload?.metricTypeKey).toBe('memory_gb');
    expect(payload?.entries).toHaveLength(4);
    expect(payload?.entries.map((entry) => entry.name)).toEqual([
      'Wachstum Q1',
      'Wachstum Q2',
      'Wachstum Q3',
      'Wachstum Q4',
    ]);
  });

  it('excludes an unchecked quarter from the submitted batch', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('checkbox', { name: 'Q2' }));
    await user.click(screen.getByRole('button', { name: /add 3 entries/i }));

    await waitFor(() => expect(api.items.bulkCreateQuarterlyGrowth).toHaveBeenCalled());
    const payload = vi.mocked(api.items.bulkCreateQuarterlyGrowth).mock.calls[0]?.[1];
    expect(payload?.entries.map((entry) => entry.name)).toEqual([
      'Wachstum Q1',
      'Wachstum Q3',
      'Wachstum Q4',
    ]);
  });

  it('disables submit once every quarter is unchecked', async () => {
    const user = userEvent.setup();
    renderDialog();

    for (const quarter of ['Q1', 'Q2', 'Q3', 'Q4']) {
      await user.click(screen.getByRole('checkbox', { name: quarter }));
    }

    expect(screen.getByRole('button', { name: /add 0 entries/i })).toBeDisabled();
    expect(api.items.bulkCreateQuarterlyGrowth).not.toHaveBeenCalled();
  });

  it('keeps focus on the field being edited after a failed submit with multiple invalid rows', async () => {
    const user = userEvent.setup();
    renderDialog();

    const titles = screen.getAllByRole('textbox', { name: 'Title' });
    const [q1Title, q2Title] = titles;
    if (!q1Title || !q2Title) throw new Error('expected four Title fields');
    // Drop `required` so the Zod-driven validation path runs instead of the
    // browser's native constraint validation (same reason other dialogs'
    // tests do this — see <EditItemDialog> above).
    q1Title.removeAttribute('required');
    q2Title.removeAttribute('required');
    await user.clear(q1Title);
    await user.clear(q2Title);

    await user.click(screen.getByRole('button', { name: /add 4 entries/i }));
    await waitFor(() => expect(q1Title).toHaveAttribute('aria-invalid', 'true'));
    expect(q2Title).toHaveAttribute('aria-invalid', 'true');

    // Q1 is the first invalid field in DOM order, so it takes focus right
    // after the failed submit. Editing the SECOND invalid field (Q2) must not
    // get yanked back to Q1 on every keystroke.
    await user.click(q2Title);
    await user.type(q2Title, 'Wachstum Q2 fixed');

    expect(q2Title).toHaveFocus();
  });
});
