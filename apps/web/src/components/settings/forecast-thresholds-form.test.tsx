import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { ForecastThresholdsForm } from './forecast-thresholds-form';

function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('<ForecastThresholdsForm>', () => {
  beforeEach(() => {
    vi.spyOn(api.settings.tenant, 'get').mockResolvedValue({
      warnThreshold: 0.7,
      critThreshold: 0.9,
    });
    vi.spyOn(api.settings.tenant, 'update').mockResolvedValue({
      warnThreshold: 0.65,
      critThreshold: 0.85,
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
});
