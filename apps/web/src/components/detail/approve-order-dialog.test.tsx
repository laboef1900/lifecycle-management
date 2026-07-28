import type { ProcurementInfo } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { ApproveOrderDialog } from './approve-order-dialog';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const procurement: ProcurementInfo = {
  leadTimeWeeks: 8,
  orderByDate: '2026-09-01',
  breachMonth: '2026-11',
};

function renderDialog(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ApproveOrderDialog
        open
        onOpenChange={vi.fn()}
        clusterId="cl-1"
        clusterName="CL-DMZ-P1"
        procurement={procurement}
      />
    </QueryClientProvider>,
  );
}

describe('<ApproveOrderDialog>', () => {
  beforeEach(() => {
    vi.spyOn(api.orderApprovals, 'create').mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opts out of native constraint validation', () => {
    // Nothing here can raise a bubble today — the note is optional and its
    // `maxLength` caps typing rather than validating. The assertion guards the
    // invariant, so a `required` or `minLength` added later cannot silently hand
    // this form's error path back to the browser.
    renderDialog();
    const form = document.querySelector('form');
    expect(form?.noValidate).toBe(true);
  });

  it('approves with no note at all', async () => {
    renderDialog();
    await userEvent.click(screen.getByRole('button', { name: /approve order/i }));
    await waitFor(() => expect(api.orderApprovals.create).toHaveBeenCalledWith('cl-1', {}));
  });
});
