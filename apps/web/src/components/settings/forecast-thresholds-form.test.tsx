import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api } from '@/lib/api-client';

import { ForecastThresholdsForm } from './forecast-thresholds-form';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderWithClient(
  ui: React.ReactNode,
  client: QueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
  return { ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>), client };
}

describe('<ForecastThresholdsForm>', () => {
  beforeEach(() => {
    vi.spyOn(api.settings.tenant, 'get').mockResolvedValue({
      warnThreshold: 0.7,
      critThreshold: 0.9,
      procurementLeadTimeWeeks: 8,
      idempotencyKeyRetentionHours: 24,
      forecastUncertaintyBandEnabled: false,
      forecastUncertaintyMinAnchors: 6,
      forecastUncertaintyBandWidth: 'p10_p90',
    });
    vi.spyOn(api.settings.tenant, 'update').mockResolvedValue({
      warnThreshold: 0.65,
      critThreshold: 0.85,
      procurementLeadTimeWeeks: 6,
      idempotencyKeyRetentionHours: 12,
      forecastUncertaintyBandEnabled: false,
      forecastUncertaintyMinAnchors: 6,
      forecastUncertaintyBandWidth: 'p10_p90',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and displays current values as integer percent', async () => {
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() => {
      expect(screen.getByLabelText(/warn %/i)).toHaveValue(70);
      expect(screen.getByLabelText(/crit %/i)).toHaveValue(90);
    });
  });

  it('disables Save until a value changes', async () => {
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() => expect(screen.getByLabelText(/warn %/i)).toHaveValue(70));
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText(/warn %/i));
    await userEvent.type(screen.getByLabelText(/warn %/i), '65');
    expect(screen.getByRole('button', { name: /save/i })).toBeEnabled();
  });

  it('submits 0.65 / 0.85 when user enters 65 / 85', async () => {
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() => expect(screen.getByLabelText(/warn %/i)).toHaveValue(70));
    await userEvent.clear(screen.getByLabelText(/warn %/i));
    await userEvent.type(screen.getByLabelText(/warn %/i), '65');
    await userEvent.clear(screen.getByLabelText(/crit %/i));
    await userEvent.type(screen.getByLabelText(/crit %/i), '85');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(api.settings.tenant.update).toHaveBeenCalledWith({
        warnThreshold: 0.65,
        critThreshold: 0.85,
        procurementLeadTimeWeeks: 8,
        idempotencyKeyRetentionHours: 24,
        forecastUncertaintyBandEnabled: false,
        forecastUncertaintyMinAnchors: 6,
        forecastUncertaintyBandWidth: 'p10_p90',
      });
    });
  });

  it('shows inline error when warn >= crit', async () => {
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() => expect(screen.getByLabelText(/warn %/i)).toHaveValue(70));
    await userEvent.clear(screen.getByLabelText(/warn %/i));
    await userEvent.type(screen.getByLabelText(/warn %/i), '95');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(screen.getByText(/warn.*less than.*crit/i)).toBeInTheDocument();
  });

  it('rejects warn below 1% with the range validation message', async () => {
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() => expect(screen.getByLabelText(/warn %/i)).toHaveValue(70));
    await userEvent.clear(screen.getByLabelText(/warn %/i));
    await userEvent.type(screen.getByLabelText(/warn %/i), '0');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(screen.getByText(/thresholds must be between 1% and 99%/i)).toBeInTheDocument();
    expect(api.settings.tenant.update).not.toHaveBeenCalled();
  });

  it('rejects crit above 99% with the range validation message', async () => {
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() => expect(screen.getByLabelText(/crit %/i)).toHaveValue(90));
    await userEvent.clear(screen.getByLabelText(/crit %/i));
    await userEvent.type(screen.getByLabelText(/crit %/i), '100');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(screen.getByText(/thresholds must be between 1% and 99%/i)).toBeInTheDocument();
    expect(api.settings.tenant.update).not.toHaveBeenCalled();
  });

  it('loads and displays the procurement lead time', async () => {
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() => {
      expect(screen.getByLabelText(/procurement lead time/i)).toHaveValue(8);
    });
  });

  it('submits the changed procurement lead time alongside thresholds', async () => {
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() => expect(screen.getByLabelText(/procurement lead time/i)).toHaveValue(8));
    await userEvent.clear(screen.getByLabelText(/procurement lead time/i));
    await userEvent.type(screen.getByLabelText(/procurement lead time/i), '12');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(api.settings.tenant.update).toHaveBeenCalledWith({
        warnThreshold: 0.7,
        critThreshold: 0.9,
        procurementLeadTimeWeeks: 12,
        idempotencyKeyRetentionHours: 24,
        forecastUncertaintyBandEnabled: false,
        forecastUncertaintyMinAnchors: 6,
        forecastUncertaintyBandWidth: 'p10_p90',
      });
    });
  });

  it('rejects out-of-range lead time with an inline error', async () => {
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() => expect(screen.getByLabelText(/procurement lead time/i)).toHaveValue(8));
    await userEvent.clear(screen.getByLabelText(/procurement lead time/i));
    await userEvent.type(screen.getByLabelText(/procurement lead time/i), '200');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(screen.getByText(/lead time.*0 to 104/i)).toBeInTheDocument();
    expect(api.settings.tenant.update).not.toHaveBeenCalled();
  });

  it('rejects non-integer lead time with an inline error', async () => {
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() => expect(screen.getByLabelText(/procurement lead time/i)).toHaveValue(8));
    await userEvent.clear(screen.getByLabelText(/procurement lead time/i));
    await userEvent.type(screen.getByLabelText(/procurement lead time/i), '4.5');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(screen.getByText(/whole number/i)).toBeInTheDocument();
    expect(api.settings.tenant.update).not.toHaveBeenCalled();
  });

  it('invalidates forecast and cluster-settings queries after a successful save', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(['forecast', 'c1', 'memory_gb'], { points: [] });
    client.setQueryData(['cluster-settings', 'c1'], { warnThreshold: null });
    renderWithClient(<ForecastThresholdsForm />, client);
    await waitFor(() => expect(screen.getByLabelText(/warn %/i)).toHaveValue(70));
    await userEvent.clear(screen.getByLabelText(/warn %/i));
    await userEvent.type(screen.getByLabelText(/warn %/i), '65');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(client.getQueryState(['forecast', 'c1', 'memory_gb'])?.isInvalidated).toBe(true);
      expect(client.getQueryState(['cluster-settings', 'c1'])?.isInvalidated).toBe(true);
    });
  });

  it('shows a toast with the API error message when saving fails', async () => {
    vi.spyOn(api.settings.tenant, 'update').mockRejectedValue(
      new ApiError(500, { error: { code: 'INTERNAL', message: 'Something broke' } }),
    );
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() => expect(screen.getByLabelText(/warn %/i)).toHaveValue(70));
    await userEvent.clear(screen.getByLabelText(/warn %/i));
    await userEvent.type(screen.getByLabelText(/warn %/i), '65');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Something broke');
    });
  });

  it('loads and displays the current retention hours', async () => {
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() => {
      expect(screen.getByLabelText(/idempotency key retention/i)).toHaveValue(24);
    });
  });

  it('submits an edited retention value alongside the unchanged thresholds', async () => {
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() =>
      expect(screen.getByLabelText(/idempotency key retention/i)).toHaveValue(24),
    );
    await userEvent.clear(screen.getByLabelText(/idempotency key retention/i));
    await userEvent.type(screen.getByLabelText(/idempotency key retention/i), '48');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(api.settings.tenant.update).toHaveBeenCalledWith({
        warnThreshold: 0.7,
        critThreshold: 0.9,
        procurementLeadTimeWeeks: 8,
        idempotencyKeyRetentionHours: 48,
        forecastUncertaintyBandEnabled: false,
        forecastUncertaintyMinAnchors: 6,
        forecastUncertaintyBandWidth: 'p10_p90',
      });
    });
  });

  it('shows inline error when retention hours is outside 1..168', async () => {
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() =>
      expect(screen.getByLabelText(/idempotency key retention/i)).toHaveValue(24),
    );
    await userEvent.clear(screen.getByLabelText(/idempotency key retention/i));
    await userEvent.type(screen.getByLabelText(/idempotency key retention/i), '200');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/1 (and|to) 168/i);
    expect(api.settings.tenant.update).not.toHaveBeenCalled();
  });
});
