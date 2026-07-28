import type { ItemResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

    // No `removeAttribute('required')` crutch: the form sets `noValidate`, so the
    // click reaches the submit handler and the app's own error is what an operator
    // actually sees. If that opt-out regresses, this test fails.
    const nameInput = screen.getByRole('textbox', { name: 'Name' });
    await user.clear(nameInput);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/too small/i)).toBeInTheDocument();
    expect(nameInput).toHaveAttribute('aria-invalid', 'true');
    expect(api.items.update).not.toHaveBeenCalled();
  });

  it('moves focus to the Name field on a failed submit', async () => {
    const user = userEvent.setup();
    renderEditDialog();

    const nameInput = screen.getByRole('textbox', { name: 'Name' });
    await user.clear(nameInput);
    screen.getByRole('button', { name: 'Save' }).focus();

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(nameInput).toHaveFocus());
  });
});

function renderCreateItemDialog(): void {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <CreateItemDialog open onOpenChange={vi.fn()} clusterId="cl-1" />
    </QueryClientProvider>,
  );
}

/**
 * Fill everything `CreateItemDialog` requires of an application.
 *
 * The allocation starts BLANK on purpose (a pre-filled 0 would be a measurement
 * nobody made), so every test that expects to reach the API has to supply it —
 * the same way an operator does.
 */
async function fillRequiredItemFields(
  user: ReturnType<typeof userEvent.setup>,
  { name = 'openshift-lab', category = 'OpenShift', allocation = '512' } = {},
): Promise<void> {
  await user.type(screen.getByRole('textbox', { name: 'Name' }), name);
  await user.type(screen.getByLabelText('Category'), category);
  await user.type(
    screen.getByRole('spinbutton', { name: 'Initial memory allocation (GB)' }),
    allocation,
  );
}

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

    await fillRequiredItemFields(user);
    await user.click(screen.getByRole('button', { name: /add application/i }));

    await waitFor(() => {
      expect(client.getQueryState(['cluster', 'cl-1'])?.isInvalidated).toBe(true);
      expect(client.getQueryState(['clusters'])?.isInvalidated).toBe(true);
    });
  });

  it('announces WHY the category was rejected, not just that it was', async () => {
    const user = userEvent.setup();
    renderCreateItemDialog();

    // Name and allocation filled, so the category is the only thing wrong and
    // is therefore also the field focus lands on.
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'openshift-lab');
    await user.type(
      screen.getByRole('spinbutton', { name: 'Initial memory allocation (GB)' }),
      '512',
    );
    await user.click(screen.getByRole('button', { name: /add application/i }));

    const category = screen.getByLabelText('Category');
    await waitFor(() => expect(category).toHaveAttribute('aria-invalid', 'true'));
    // The combobox used to render its message with no id and no
    // `aria-describedby`, so this was the one field in the dialog whose reason
    // never reached assistive tech.
    expect(category).toHaveAccessibleDescription(/too small|required/i);
    expect(category).toHaveFocus();
    expect(api.items.create).not.toHaveBeenCalled();
  });

  it('starts the allocation blank rather than pre-filling a 0 nobody measured', () => {
    renderCreateItemDialog();

    // The blank guard closes the *cleared* path; this closes the likelier one,
    // where the operator simply accepts the default and creates an application
    // recorded as consuming nothing.
    expect(screen.getByRole('spinbutton', { name: 'Initial memory allocation (GB)' })).toHaveValue(
      null,
    );
  });

  it('blocks submit on an untouched allocation instead of posting it as 0', async () => {
    const user = userEvent.setup();
    renderCreateItemDialog();

    // Name and category filled, allocation never touched: the ONLY thing wrong
    // is the field the operator never answered.
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'openshift-lab');
    await user.type(screen.getByLabelText('Category'), 'OpenShift');
    await user.click(screen.getByRole('button', { name: /add application/i }));

    const allocation = screen.getByRole('spinbutton', { name: 'Initial memory allocation (GB)' });
    await waitFor(() => expect(allocation).toHaveAttribute('aria-invalid', 'true'));
    expect(
      document.getElementById(allocation.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('Enter a value');
    expect(api.items.create).not.toHaveBeenCalled();
  });

  it('accepts an allocation of 0 the operator typed deliberately', async () => {
    const user = userEvent.setup();
    renderCreateItemDialog();

    await fillRequiredItemFields(user, { allocation: '0' });
    await user.click(screen.getByRole('button', { name: /add application/i }));

    await waitFor(() =>
      expect(api.items.create).toHaveBeenCalledWith(
        'cl-1',
        expect.objectContaining({
          allocations: [expect.objectContaining({ amount: 0 })],
        }),
      ),
    );
  });

  it('rejects a cleared allocation instead of posting it as 0', async () => {
    const user = userEvent.setup();
    renderCreateItemDialog();

    // Typed, then cleared — the field an operator changed their mind about, as
    // opposed to the untouched-default case above. `Number('')` is 0 and the
    // shared `positiveAmount` accepts 0, so without the blank guard this would
    // create an application recorded as consuming nothing.
    await fillRequiredItemFields(user);
    const allocation = screen.getByRole('spinbutton', { name: 'Initial memory allocation (GB)' });
    await user.clear(allocation);

    await user.click(screen.getByRole('button', { name: /add application/i }));

    await waitFor(() => expect(allocation).toHaveAttribute('aria-invalid', 'true'));
    expect(
      document.getElementById(allocation.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('Enter a value');
    expect(api.items.create).not.toHaveBeenCalled();
  });

  it('blames the date field, not the allocation field, for a cleared start date', async () => {
    const user = userEvent.setup();
    renderCreateItemDialog();

    await fillRequiredItemFields(user);
    // `allocations[0].effectiveFrom` mirrors this date, so a bad value also raises
    // an issue under `allocations` — which maps to the allocation AMOUNT slot.
    fireEvent.change(screen.getByLabelText('Started at'), { target: { value: '' } });

    await user.click(screen.getByRole('button', { name: /add application/i }));

    await waitFor(() =>
      expect(screen.getByLabelText('Started at')).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(screen.getByLabelText('Initial memory allocation (GB)')).not.toHaveAttribute(
      'aria-invalid',
    );
    expect(api.items.create).not.toHaveBeenCalled();
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

  it('blocks the batch and flags the Year field when the year is cleared', async () => {
    const user = userEvent.setup();
    renderDialog();

    // The Year box is a derivation control, not a submitted field: it rewrites
    // every row's effectiveDate. Clearing it leaves the rows on the PREVIOUS
    // year's dates, which parse clean — so the schema alone cannot catch this and
    // the browser's `required` bubble used to be the only thing stopping a whole
    // year of growth being committed against the wrong year.
    const yearInput = screen.getByRole('spinbutton', { name: 'Year' });
    await user.clear(yearInput);

    await user.click(screen.getByRole('button', { name: /add 4 entries/i }));

    await waitFor(() => expect(yearInput).toHaveAttribute('aria-invalid', 'true'));
    expect(
      document.getElementById(yearInput.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('Enter a 4-digit year');
    expect(api.items.bulkCreateQuarterlyGrowth).not.toHaveBeenCalled();
  });

  it('keeps the box honest while a year is half-typed, then blocks submit', async () => {
    const user = userEvent.setup();
    renderDialog();

    const yearInput = screen.getByRole('spinbutton', { name: 'Year' });
    await user.clear(yearInput);
    await user.type(yearInput, '202');

    // The input shows exactly what was typed (it used to snap back to the last
    // parseable value), and no row got stamped with a malformed `202-01-01`.
    expect(yearInput).toHaveValue(202);
    for (const date of screen.getAllByLabelText('Effective date')) {
      expect((date as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-01$/);
    }

    await user.click(screen.getByRole('button', { name: /add 4 entries/i }));

    await waitFor(() => expect(yearInput).toHaveAttribute('aria-invalid', 'true'));
    expect(api.items.bulkCreateQuarterlyGrowth).not.toHaveBeenCalled();
  });

  it('re-derives every row date once a complete year is typed', async () => {
    const user = userEvent.setup();
    renderDialog();

    const yearInput = screen.getByRole('spinbutton', { name: 'Year' });
    await user.clear(yearInput);
    await user.type(yearInput, '2031');

    await user.click(screen.getByRole('button', { name: /add 4 entries/i }));

    await waitFor(() => expect(api.items.bulkCreateQuarterlyGrowth).toHaveBeenCalled());
    const payload = vi.mocked(api.items.bulkCreateQuarterlyGrowth).mock.calls[0]?.[1];
    expect(payload?.entries.map((entry) => entry.effectiveDate)).toEqual([
      '2031-01-01',
      '2031-04-01',
      '2031-07-01',
      '2031-10-01',
    ]);
  });

  it('keeps focus on the field being edited after a failed submit with multiple invalid rows', async () => {
    const user = userEvent.setup();
    renderDialog();

    const titles = screen.getAllByRole('textbox', { name: 'Title' });
    const [q1Title, q2Title] = titles;
    if (!q1Title || !q2Title) throw new Error('expected four Title fields');
    // No `removeAttribute('required')` crutch: the form sets `noValidate`, so the
    // Zod-driven path is what a real click exercises.
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
