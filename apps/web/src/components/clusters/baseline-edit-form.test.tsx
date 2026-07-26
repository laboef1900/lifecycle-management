import type { ClusterResponse, MetricStateResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { BaselineEditForm } from './baseline-edit-form';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const CLUSTER_ID = 'clu_test_001';

const baseCluster: ClusterResponse = {
  id: CLUSTER_ID,
  name: 'CL-Test',
  description: null,
  baselineDate: '2026-05-01',
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
  archivedAt: null,
  metrics: [
    {
      metricTypeKey: 'memory_gb',
      metricTypeDisplayName: 'Memory',
      unit: 'GB',
      baselineConsumption: 400,
      baselineCapacity: 1000,
      currentConsumption: 400,
      currentCapacity: 1000,
      utilization: 0.4,
    },
  ],
};

function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

// Scoped to the dialog: the trigger now carries the same words plus the ellipsis
// that advertises the confirm step, so an unscoped /rewrite baseline/i would
// match both controls.
function confirmButton(): HTMLElement {
  return within(screen.getByRole('dialog')).getByRole('button', { name: 'Rewrite baseline' });
}

describe('<BaselineEditForm>', () => {
  beforeEach(() => {
    vi.spyOn(api.clusters, 'get').mockResolvedValue(baseCluster);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and displays current baseline date + per-metric values', async () => {
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => {
      expect(screen.getByLabelText(/baseline date/i)).toHaveValue('2026-05-01');
      expect(screen.getByLabelText(/memory.*consumption/i)).toHaveValue(400);
      expect(screen.getByLabelText(/memory.*capacity/i)).toHaveValue(1000);
    });
  });

  it('disables the submit trigger until a field changes', async () => {
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/baseline date/i)).toHaveValue('2026-05-01'));
    expect(screen.getByRole('button', { name: /rewrite baseline…/i })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText(/memory.*consumption/i));
    await userEvent.type(screen.getByLabelText(/memory.*consumption/i), '500');
    expect(screen.getByRole('button', { name: /rewrite baseline…/i })).toBeEnabled();
  });

  it('opens a confirm dialog on save instead of submitting immediately', async () => {
    const updateSpy = vi.spyOn(api.clusters, 'update').mockResolvedValue(baseCluster);
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/memory.*consumption/i)).toHaveValue(400));
    await userEvent.clear(screen.getByLabelText(/memory.*consumption/i));
    await userEvent.type(screen.getByLabelText(/memory.*consumption/i), '500');
    await userEvent.click(screen.getByRole('button', { name: /rewrite baseline…/i }));
    expect(screen.getByRole('dialog', { name: /rewrite baseline/i })).toBeInTheDocument();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('cancel button in the dialog does not submit', async () => {
    const updateSpy = vi.spyOn(api.clusters, 'update').mockResolvedValue(baseCluster);
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/memory.*consumption/i)).toHaveValue(400));
    await userEvent.clear(screen.getByLabelText(/memory.*consumption/i));
    await userEvent.type(screen.getByLabelText(/memory.*consumption/i), '500');
    await userEvent.click(screen.getByRole('button', { name: /rewrite baseline…/i }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('confirm submits the full baselines array even when only one value changed', async () => {
    const updateSpy = vi.spyOn(api.clusters, 'update').mockResolvedValue(baseCluster);
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/memory.*consumption/i)).toHaveValue(400));
    await userEvent.clear(screen.getByLabelText(/memory.*consumption/i));
    await userEvent.type(screen.getByLabelText(/memory.*consumption/i), '500');
    await userEvent.click(screen.getByRole('button', { name: /rewrite baseline…/i }));
    await userEvent.click(confirmButton());
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(CLUSTER_ID, {
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 500, baselineCapacity: 1000 },
        ],
      });
    });
  });

  it('includes baselineDate in PUT when only the date changed', async () => {
    const updateSpy = vi.spyOn(api.clusters, 'update').mockResolvedValue(baseCluster);
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/baseline date/i)).toHaveValue('2026-05-01'));
    const dateInput = screen.getByLabelText(/baseline date/i);
    await userEvent.clear(dateInput);
    await userEvent.type(dateInput, '2026-06-01');
    await userEvent.click(screen.getByRole('button', { name: /rewrite baseline…/i }));
    await userEvent.click(confirmButton());
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(CLUSTER_ID, { baselineDate: '2026-06-01' });
    });
  });

  it('opts out of native constraint validation', async () => {
    // `min={0}` on the metric inputs made the browser's own bubble the winning
    // error path here: interactive validation runs before the submit event, so
    // typing -5 produced Chrome's transient, unstyled, first-field-only
    // "Value must be greater than or equal to 0." and this form's own error
    // path never ran. Losing `noValidate` again is invisible in a screenshot.
    const { container } = renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/baseline date/i)).toHaveValue('2026-05-01'));
    expect(container.querySelector('form')?.noValidate).toBe(true);
  });

  it('reports a blank metric field inline, before the confirm step, instead of re-sending the old value', async () => {
    const updateSpy = vi.spyOn(api.clusters, 'update').mockResolvedValue(baseCluster);
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/baseline date/i)).toHaveValue('2026-05-01'));
    // Make the form dirty via the date field, then blank out a metric field so
    // its edit is present but unparseable — the "invalid edit next to a
    // legitimate one" case. The old code substituted the server's 400 for the
    // blank and said so nowhere; the only signal was a confirm-time toast
    // naming the wire key `memory_gb`, with no pointer to the field.
    const dateInput = screen.getByLabelText(/baseline date/i);
    await userEvent.clear(dateInput);
    await userEvent.type(dateInput, '2026-06-01');
    const consumption = screen.getByLabelText(/memory.*consumption/i);
    await userEvent.clear(consumption);
    await userEvent.click(screen.getByRole('button', { name: /rewrite baseline…/i }));

    await waitFor(() => expect(consumption).toHaveAttribute('aria-invalid', 'true'));
    const errorId = consumption.getAttribute('aria-describedby');
    expect(errorId).not.toBeNull();
    expect(document.getElementById(errorId ?? '')?.textContent).toBe('Enter a value');
    // Caught at submit, so the operator is never asked to confirm a rewrite
    // that cannot happen.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    // Focus lands on the field to fix (SC 3.3.1).
    expect(consumption).toHaveFocus();
  });

  it('reports a negative baseline through the shared contract, not the browser', async () => {
    const updateSpy = vi.spyOn(api.clusters, 'update').mockResolvedValue(baseCluster);
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/memory.*capacity/i)).toHaveValue(1000));
    const capacity = screen.getByLabelText(/memory.*capacity/i);
    await userEvent.clear(capacity);
    await userEvent.type(capacity, '-5');
    await userEvent.click(screen.getByRole('button', { name: /rewrite baseline…/i }));

    await waitFor(() => expect(capacity).toHaveAttribute('aria-invalid', 'true'));
    // `positiveAmount` in @lcm/shared owns this sentence — the bound is not
    // restated in the component.
    expect(screen.getByText('Must be greater than or equal to 0')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('reports a cleared baseline date inline and does not open the confirm', async () => {
    const updateSpy = vi.spyOn(api.clusters, 'update').mockResolvedValue(baseCluster);
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/baseline date/i)).toHaveValue('2026-05-01'));
    const dateInput = screen.getByLabelText(/baseline date/i);
    await userEvent.clear(dateInput);
    await userEvent.click(screen.getByRole('button', { name: /rewrite baseline…/i }));

    await waitFor(() => expect(dateInput).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('submits with the accent variant, not the delete colour, and names its own confirm', async () => {
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/memory.*consumption/i)).toHaveValue(400));
    const trigger = screen.getByRole('button', { name: /rewrite baseline…/i });
    // Coral (`--destructive`) belongs to Delete. A save wearing it — as this one
    // used to — teaches users to discount the one colour that means "this
    // removes data", so it must stay on the steel interaction accent.
    expect(trigger).not.toHaveClass('bg-destructive');
    expect(trigger).toHaveClass('bg-accent');

    await userEvent.clear(screen.getByLabelText(/memory.*consumption/i));
    await userEvent.type(screen.getByLabelText(/memory.*consumption/i), '500');
    await userEvent.click(trigger);
    // The trigger's words are the confirm's words: the ellipsis is the only
    // difference, and it is what advertises the extra step.
    expect(confirmButton()).toBeInTheDocument();
    expect(trigger).toHaveAccessibleName(`${confirmButton().textContent ?? ''}…`);
  });
});

describe('<BaselineEditForm> errors follow the metric, not its position', () => {
  const memory = baseCluster.metrics[0] as MetricStateResponse;
  const cpu: MetricStateResponse = {
    metricTypeKey: 'cpu_cores',
    metricTypeDisplayName: 'CPU',
    unit: 'cores',
    baselineConsumption: 8,
    baselineCapacity: 32,
    currentConsumption: 8,
    currentCapacity: 32,
    utilization: 0.25,
  };
  const twoMetrics: ClusterResponse = { ...baseCluster, metrics: [memory, cpu] };

  beforeEach(() => {
    vi.spyOn(api.clusters, 'get').mockResolvedValue(twoMetrics);
    vi.spyOn(api.clusters, 'update').mockResolvedValue(twoMetrics);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a blocked field’s error on that field when a refetch reorders the metrics', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <BaselineEditForm clusterId={CLUSTER_ID} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText(/cpu.*consumption/i)).toHaveValue(8));

    // Blank the SECOND metric's field, so a positional key and an identity key
    // disagree the moment the order changes.
    await userEvent.clear(screen.getByLabelText(/cpu.*consumption/i));
    await userEvent.click(screen.getByRole('button', { name: /rewrite baseline…/i }));
    await waitFor(() =>
      expect(screen.getByLabelText(/cpu.*consumption/i)).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(screen.getByLabelText(/memory.*consumption/i)).not.toHaveAttribute('aria-invalid');

    // The query has a 5-minute staleTime but refetches on focus/reconnect, and
    // the server does not promise a stable metric order. Simulate that landing
    // while the error is on screen: keyed by index, the message would jump onto
    // Memory — a field the operator never touched — and read as valid.
    act(() => {
      client.setQueryData(['cluster', CLUSTER_ID], { ...twoMetrics, metrics: [cpu, memory] });
    });

    await waitFor(() =>
      expect(screen.getByLabelText(/cpu.*consumption/i)).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(screen.getByLabelText(/cpu.*consumption/i)).toHaveAccessibleDescription('Enter a value');
    expect(screen.getByLabelText(/memory.*consumption/i)).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText(/memory.*capacity/i)).not.toHaveAttribute('aria-invalid');
  });
});
