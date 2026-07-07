import type { LocalUserSummary } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api } from '@/lib/api-client';

import { LocalAccountsPanel } from './local-accounts-panel';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const adminUser: LocalUserSummary = {
  id: '1',
  username: 'admin',
  role: 'ADMIN',
  disabled: false,
  lastLoginAt: null,
  createdAt: '2026-07-06T00:00:00.000Z',
};

describe('<LocalAccountsPanel>', () => {
  beforeEach(() => {
    vi.spyOn(api.settings.auth.localUsers, 'list').mockResolvedValue([adminUser]);
    vi.spyOn(api.settings.auth.localUsers, 'create').mockResolvedValue({
      ...adminUser,
      id: '2',
      username: 'newuser',
    });
    vi.spyOn(api.settings.auth.localUsers, 'setDisabled').mockResolvedValue(undefined);
    vi.spyOn(api.settings.auth.localUsers, 'resetPassword').mockResolvedValue(undefined);
    vi.spyOn(api.settings.auth.localUsers, 'delete').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists existing local accounts', async () => {
    renderWithClient(<LocalAccountsPanel />);
    expect(await screen.findByText('admin')).toBeInTheDocument();
    expect(screen.getByText(/active/i)).toBeInTheDocument();
  });

  it('shows an empty state when there are no local accounts', async () => {
    vi.mocked(api.settings.auth.localUsers.list).mockResolvedValue([]);
    renderWithClient(<LocalAccountsPanel />);
    expect(await screen.findByText(/no local accounts yet/i)).toBeInTheDocument();
  });

  it('shows skeleton placeholders while the local-users query is pending', () => {
    vi.mocked(api.settings.auth.localUsers.list).mockReturnValue(new Promise<never>(() => {}));
    const { container } = renderWithClient(<LocalAccountsPanel />);
    expect(container.querySelector('.animate-shimmer')).toBeInTheDocument();
  });

  it('creates a local account with the typed username/password/role', async () => {
    renderWithClient(<LocalAccountsPanel />);
    await screen.findByText('admin');

    await userEvent.type(screen.getByLabelText(/^username$/i), 'newuser');
    await userEvent.type(screen.getByLabelText(/^password$/i), 'a-strong-password-1');
    await userEvent.click(screen.getByRole('button', { name: /^viewer$/i }));
    await userEvent.click(screen.getByRole('button', { name: /add account/i }));

    await waitFor(() => {
      expect(api.settings.auth.localUsers.create).toHaveBeenCalledWith({
        username: 'newuser',
        password: 'a-strong-password-1',
        role: 'VIEWER',
      });
    });
    expect(toast.success).toHaveBeenCalledWith('Local account created');
  });

  it('shows a toast with the server message when create fails', async () => {
    vi.mocked(api.settings.auth.localUsers.create).mockRejectedValue(
      new ApiError(422, { error: { code: 'USERNAME_TAKEN', message: 'Username already in use.' } }),
    );
    renderWithClient(<LocalAccountsPanel />);
    await screen.findByText('admin');

    await userEvent.type(screen.getByLabelText(/^username$/i), 'admin');
    await userEvent.type(screen.getByLabelText(/^password$/i), 'a-strong-password-1');
    await userEvent.click(screen.getByRole('button', { name: /add account/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Username already in use.');
    });
  });

  it('disables an active account when Disable is clicked', async () => {
    renderWithClient(<LocalAccountsPanel />);
    await screen.findByText('admin');

    await userEvent.click(screen.getByRole('button', { name: /^disable$/i }));

    await waitFor(() => {
      expect(api.settings.auth.localUsers.setDisabled).toHaveBeenCalledWith('1', true);
    });
    expect(toast.success).toHaveBeenCalledWith('Local account updated');
  });

  it('resets a password via the inline form', async () => {
    renderWithClient(<LocalAccountsPanel />);
    await screen.findByText('admin');

    await userEvent.click(screen.getByRole('button', { name: /^reset$/i }));
    await userEvent.type(screen.getByLabelText(/new password for admin/i), 'a-new-password-12');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(api.settings.auth.localUsers.resetPassword).toHaveBeenCalledWith(
        '1',
        'a-new-password-12',
      );
    });
    expect(toast.success).toHaveBeenCalledWith('Password reset');
  });

  it('deletes an account after confirming the dialog', async () => {
    renderWithClient(<LocalAccountsPanel />);
    await screen.findByText('admin');

    await userEvent.click(screen.getByRole('button', { name: /delete admin/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /delete account/i }));

    await waitFor(() => {
      expect(api.settings.auth.localUsers.delete).toHaveBeenCalledWith('1');
    });
    expect(toast.success).toHaveBeenCalledWith('Local account deleted');
  });
});
