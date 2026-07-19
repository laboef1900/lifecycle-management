import type { HostResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { CreateHostDialog, EditHostDialog } from './host-dialogs';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeHost(): HostResponse {
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
  };
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/**
 * Overflow the Serial number field past the shared 120-char schema cap. The
 * resulting Zod issue has path root `serialNumber`, which no dialog maps to a
 * field-error slot — exactly the fallback-toast branch under test. The native
 * maxLength clamp fires before our Zod layer, so drop it first.
 */
async function overflowSerialNumber(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const serialInput = screen.getByRole('textbox', { name: 'Serial number' });
  serialInput.removeAttribute('maxlength');
  await user.click(serialInput);
  await user.paste('x'.repeat(121));
}

describe('<CreateHostDialog> validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(api.hosts, 'create').mockResolvedValue(makeHost());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to a toast when no schema issue maps to a form field', async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={makeClient()}>
        <CreateHostDialog open onOpenChange={vi.fn()} clusterId="cl-1" />
      </QueryClientProvider>,
    );

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'hpe-01');
    await overflowSerialNumber(user);

    await user.click(screen.getByRole('button', { name: 'Add host' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/too big/i));
    });
    expect(api.hosts.create).not.toHaveBeenCalled();
  });
});

describe('<CreateHostDialog> required-field markers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(api.hosts, 'create').mockResolvedValue(makeHost());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks Name, Commissioned at, and Initial memory capacity as required', () => {
    render(
      <QueryClientProvider client={makeClient()}>
        <CreateHostDialog open onOpenChange={vi.fn()} clusterId="cl-1" />
      </QueryClientProvider>,
    );

    for (const name of ['Name', 'Commissioned at', 'Initial memory capacity (GB)']) {
      const field = screen.getByLabelText(name);
      expect(field).toHaveAttribute('required');
      expect(field).toHaveAttribute('aria-required', 'true');
    }
    // Description is genuinely optional — it must not pick up the marker.
    expect(screen.getByLabelText('Description')).not.toHaveAttribute('required');
  });
});

describe('<EditHostDialog> validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(api.hosts, 'update').mockResolvedValue(makeHost());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderEditDialog(): void {
    render(
      <QueryClientProvider client={makeClient()}>
        <EditHostDialog open onOpenChange={vi.fn()} clusterId="cl-1" host={makeHost()} />
      </QueryClientProvider>,
    );
  }

  it('blocks submit with an inline error (no toast) when the name is empty', async () => {
    const user = userEvent.setup();
    renderEditDialog();

    const nameInput = screen.getByRole('textbox', { name: 'Name' });
    // The native `required` attribute fires before our Zod layer; drop it so the
    // schema-driven validation path is the one under test.
    nameInput.removeAttribute('required');
    await user.clear(nameInput);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/too small/i)).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
    expect(api.hosts.update).not.toHaveBeenCalled();
  });

  it('moves focus to the Name field on a failed submit', async () => {
    const user = userEvent.setup();
    renderEditDialog();

    const nameInput = screen.getByRole('textbox', { name: 'Name' });
    nameInput.removeAttribute('required');
    await user.clear(nameInput);
    // Move focus off the field the way a real submit click would — otherwise
    // the assertion below would pass even if the effect never ran.
    screen.getByRole('button', { name: 'Save' }).focus();

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(nameInput).toHaveFocus());
  });

  it('falls back to a toast when no schema issue maps to a form field', async () => {
    const user = userEvent.setup();
    renderEditDialog();

    await overflowSerialNumber(user);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/too big/i));
    });
    expect(api.hosts.update).not.toHaveBeenCalled();
  });
});

describe('<CreateHostDialog> invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(api.hosts, 'create').mockResolvedValue(makeHost());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invalidates hosts, forecast, cluster and clusters queries after a successful create', async () => {
    const client = makeClient();
    client.setQueryData(['hosts', 'cl-1'], {});
    client.setQueryData(['forecast', 'cl-1'], {});
    client.setQueryData(['cluster', 'cl-1'], {});
    client.setQueryData(['clusters'], []);
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <CreateHostDialog open onOpenChange={vi.fn()} clusterId="cl-1" />
      </QueryClientProvider>,
    );

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'hpe-01');
    await user.click(screen.getByRole('button', { name: 'Add host' }));

    await waitFor(() => {
      expect(client.getQueryState(['hosts', 'cl-1'])?.isInvalidated).toBe(true);
      expect(client.getQueryState(['forecast', 'cl-1'])?.isInvalidated).toBe(true);
      expect(client.getQueryState(['cluster', 'cl-1'])?.isInvalidated).toBe(true);
      expect(client.getQueryState(['clusters'])?.isInvalidated).toBe(true);
    });
  });
});
