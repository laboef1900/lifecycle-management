import type { HostResponse, ItemResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { CreateClusterDialog } from '../create-cluster-dialog';
import {
  ConfirmCommissioningDialog,
  CreateHostDialog,
  EditHostDialog,
  HostReplaceDialog,
  HostTransitionDialog,
  ResizeHostDialog,
} from '../host-dialogs';
import {
  BulkQuarterlyGrowthDialog,
  CreateItemDialog,
  EditItemDialog,
  ResizeItemDialog,
} from '../item-dialogs';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeHost(overrides: Partial<HostResponse> = {}): HostResponse {
  return {
    id: 'host-1',
    clusterId: 'cl-1',
    name: 'hpe-01',
    description: null,
    commissionedAt: '2026-01-15',
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
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
    capacities: [
      {
        id: 'cap-1',
        metricTypeKey: 'memory_gb',
        metricTypeDisplayName: 'Memory',
        unit: 'GB',
        effectiveFrom: '2026-01-15',
        amount: 512,
      },
    ],
    ...overrides,
  };
}

function makeApplication(overrides: Partial<ItemResponse> = {}): ItemResponse {
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
    ...overrides,
  };
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderWithClient(ui: React.ReactNode): void {
  render(<QueryClientProvider client={makeClient()}>{ui}</QueryClientProvider>);
}

/**
 * The dialogs render into a portal, so reach for the form by tag rather than
 * through the render container.
 */
function currentForm(): HTMLFormElement {
  const form = document.querySelector('form');
  if (!form) throw new Error('expected a <form> to be rendered');
  return form;
}

const dialogProps = { open: true, onOpenChange: vi.fn(), clusterId: 'cl-1' } as const;

/**
 * Every dialog that owns a `<form>` with a required field, in one table.
 *
 * This is the regression guard for the whole sweep: the app ships a designed
 * error path (`Field` → `aria-invalid` + `aria-describedby` + visible message)
 * that the browser's native constraint bubble preempts, because interactive
 * validation runs BEFORE the submit event ever fires. A form that quietly loses
 * `noValidate` silently reverts to the browser's transient, unstyled,
 * first-field-only bubble — visually identical in a screenshot, and invisible to
 * a test that only asserts on the happy path.
 */
const FORMS: ReadonlyArray<{ name: string; render: () => void }> = [
  {
    name: '<ConfirmCommissioningDialog>',
    render: () =>
      renderWithClient(<ConfirmCommissioningDialog {...dialogProps} hosts={[makeHost()]} />),
  },
  {
    name: '<CreateHostDialog>',
    render: () => renderWithClient(<CreateHostDialog {...dialogProps} />),
  },
  {
    name: '<EditHostDialog>',
    render: () => renderWithClient(<EditHostDialog {...dialogProps} host={makeHost()} />),
  },
  {
    name: '<HostReplaceDialog>',
    render: () =>
      renderWithClient(
        <HostReplaceDialog
          {...dialogProps}
          host={makeHost()}
          candidates={[makeHost({ id: 'host-2', name: 'hpe-02' })]}
        />,
      ),
  },
  {
    name: '<HostTransitionDialog>',
    render: () => renderWithClient(<HostTransitionDialog {...dialogProps} host={makeHost()} />),
  },
  {
    name: '<ResizeHostDialog>',
    render: () => renderWithClient(<ResizeHostDialog {...dialogProps} host={makeHost()} />),
  },
  {
    name: '<BulkQuarterlyGrowthDialog>',
    render: () => renderWithClient(<BulkQuarterlyGrowthDialog {...dialogProps} />),
  },
  {
    name: '<CreateItemDialog>',
    render: () => renderWithClient(<CreateItemDialog {...dialogProps} />),
  },
  {
    name: '<EditItemDialog>',
    render: () => renderWithClient(<EditItemDialog {...dialogProps} item={makeApplication()} />),
  },
  {
    name: '<ResizeItemDialog>',
    render: () => renderWithClient(<ResizeItemDialog {...dialogProps} item={makeApplication()} />),
  },
];

describe('dialog forms opt out of native constraint validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(api.settings.categories, 'list').mockResolvedValue([{ id: 'c1', name: 'Growth' }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(FORMS)('$name sets noValidate', ({ render: renderDialog }) => {
    renderDialog();
    expect(currentForm().noValidate).toBe(true);
  });

  it('<CreateClusterDialog> sets noValidate', async () => {
    const user = userEvent.setup();
    renderWithClient(<CreateClusterDialog />);
    await user.click(screen.getByRole('button', { name: '+ Add cluster' }));

    expect(currentForm().noValidate).toBe(true);
  });

  it('still marks the fields required for assistive tech', () => {
    // noValidate turns off the browser's *bubble*, not the semantics: the field
    // must still announce as required, or the opt-out would have traded a bad
    // error message for a missing one (SC 3.3.2).
    renderWithClient(<ResizeHostDialog {...dialogProps} host={makeHost()} />);

    const amount = screen.getByLabelText('New capacity (GB)');
    expect(amount).toHaveAttribute('required');
    expect(amount).toHaveAttribute('aria-required', 'true');
  });
});

describe('<ResizeHostDialog> submit validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(api.hosts, 'appendCapacity').mockResolvedValue(makeHost());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a blank capacity through the app’s own error instead of appending 0', async () => {
    const user = userEvent.setup();
    renderWithClient(<ResizeHostDialog {...dialogProps} host={makeHost()} />);

    const amount = screen.getByLabelText('New capacity (GB)');
    await user.clear(amount);
    await user.click(screen.getByRole('button', { name: 'Add resize' }));

    await waitFor(() => expect(amount).toHaveAttribute('aria-invalid', 'true'));
    const errorId = amount.getAttribute('aria-describedby');
    expect(errorId).not.toBeNull();
    expect(document.getElementById(errorId ?? '')?.textContent).toBe('Enter a value');
    // The whole point: `Number('')` is 0 and `positiveAmount` accepts 0, so
    // without the guard this call would have gone out with amount: 0.
    expect(api.hosts.appendCapacity).not.toHaveBeenCalled();
  });

  it('reports a cleared date on the date field and does not submit', async () => {
    const user = userEvent.setup();
    renderWithClient(<ResizeHostDialog {...dialogProps} host={makeHost()} />);

    fireEvent.change(screen.getByLabelText('Effective from'), { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: 'Add resize' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Effective from')).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(api.hosts.appendCapacity).not.toHaveBeenCalled();
  });

  it('still submits a capacity the operator deliberately typed as 0', async () => {
    const user = userEvent.setup();
    renderWithClient(<ResizeHostDialog {...dialogProps} host={makeHost()} />);

    const amount = screen.getByLabelText('New capacity (GB)');
    await user.clear(amount);
    await user.type(amount, '0');
    await user.click(screen.getByRole('button', { name: 'Add resize' }));

    await waitFor(() =>
      expect(api.hosts.appendCapacity).toHaveBeenCalledWith(
        'host-1',
        expect.objectContaining({ amount: 0 }),
      ),
    );
  });
});

describe('<ResizeItemDialog> submit validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(api.items, 'appendAllocation').mockResolvedValue(makeApplication());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a blank allocation through the app’s own error instead of appending 0', async () => {
    const user = userEvent.setup();
    renderWithClient(<ResizeItemDialog {...dialogProps} item={makeApplication()} />);

    const amount = screen.getByLabelText('New allocation (GB)');
    await user.clear(amount);
    await user.click(screen.getByRole('button', { name: 'Add resize' }));

    await waitFor(() => expect(amount).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByText('Enter a value')).toBeInTheDocument();
    expect(api.items.appendAllocation).not.toHaveBeenCalled();
  });
});

describe('<HostReplaceDialog> submit validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(api.hostReplacements, 'create').mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a cleared swap date inline and does not record the replacement', async () => {
    const user = userEvent.setup();
    renderWithClient(
      <HostReplaceDialog
        {...dialogProps}
        host={makeHost()}
        candidates={[makeHost({ id: 'host-2', name: 'hpe-02' })]}
      />,
    );

    const swappedAt = screen.getByLabelText('Swapped at');
    fireEvent.change(swappedAt, { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: 'Record replacement' }));

    await waitFor(() => expect(swappedAt).toHaveAttribute('aria-invalid', 'true'));
    expect(api.hostReplacements.create).not.toHaveBeenCalled();
  });
});

describe('<HostTransitionDialog> submit validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The transition endpoint returns no body.
    vi.spyOn(api.hosts, 'transition').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a cleared occurrence date inline and does not transition the host', async () => {
    const user = userEvent.setup();
    renderWithClient(<HostTransitionDialog {...dialogProps} host={makeHost()} />);

    const occurredAt = screen.getByLabelText('Occurred at');
    fireEvent.change(occurredAt, { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: 'Transition' }));

    await waitFor(() => expect(occurredAt).toHaveAttribute('aria-invalid', 'true'));
    expect(api.hosts.transition).not.toHaveBeenCalled();
  });

  it('moves focus to the invalid date field on a blocked submit', async () => {
    const user = userEvent.setup();
    renderWithClient(<HostTransitionDialog {...dialogProps} host={makeHost()} />);

    const occurredAt = screen.getByLabelText('Occurred at');
    fireEvent.change(occurredAt, { target: { value: '' } });
    const submit = screen.getByRole('button', { name: 'Transition' });
    submit.focus();

    await user.click(submit);

    await waitFor(() => expect(occurredAt).toHaveFocus());
  });
});
