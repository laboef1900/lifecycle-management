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

  it('lets the visible label be the accessible name on the create form', async () => {
    renderWithClient(<LocalAccountsPanel />);
    await screen.findByText('admin');

    // These two carried an `aria-label` duplicating their own `<label>`. A
    // duplicate that overrides the visible text is one edit away from
    // disagreeing with it (SC 2.5.3 Label in Name), so the label is the single
    // source now — and these assertions fail if an `aria-label` comes back
    // saying something else.
    expect(screen.getByLabelText(/^username$/i)).toHaveAccessibleName('Username');
    expect(screen.getByLabelText(/^password$/i)).toHaveAccessibleName('Password');

    // The reset row keeps its own `aria-label` deliberately: one panel renders
    // many rows, so the name has to say WHICH admin. It still starts with the
    // visible label, which is what SC 2.5.3 requires.
    await userEvent.click(screen.getByRole('button', { name: /^reset$/i }));
    expect(screen.getByLabelText(/new password for admin/i)).toHaveAccessibleName(
      'New password for admin',
    );
  });

  it('opts both credential forms out of native constraint validation', async () => {
    const { container } = renderWithClient(<LocalAccountsPanel />);
    await screen.findByText('admin');
    expect(container.querySelector('form')?.noValidate).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: /^reset$/i }));
    // Both the per-row reset form and the create form — the reset form is first
    // in the DOM once it is open.
    const forms = container.querySelectorAll('form');
    expect(forms).toHaveLength(2);
    for (const form of forms) expect(form.noValidate).toBe(true);
  });

  it('rejects a too-short password through the app’s own error, not a browser bubble', async () => {
    renderWithClient(<LocalAccountsPanel />);
    await screen.findByText('admin');

    const password = screen.getByLabelText(/^password$/i);
    await userEvent.type(screen.getByLabelText(/^username$/i), 'jsmith');
    await userEvent.type(password, 'short');
    // The submit used to be enabled here with `minLength={12}` as the only
    // enforcement, so Chrome's transient bubble was the whole error story.
    expect(screen.getByRole('button', { name: /add account/i })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: /add account/i }));

    await waitFor(() => expect(password).toHaveAttribute('aria-invalid', 'true'));
    const errorId = password.getAttribute('aria-describedby');
    expect(errorId).not.toBeNull();
    expect(document.getElementById(errorId ?? '')?.textContent).toMatch(/at least 12 characters/i);
    expect(api.settings.auth.localUsers.create).not.toHaveBeenCalled();
    // SC 3.3.1 — focus lands on the field to fix.
    expect(password).toHaveFocus();
  });

  it('names the blank field instead of doing nothing at all', async () => {
    renderWithClient(<LocalAccountsPanel />);
    await screen.findByText('admin');

    // Both blank: the old handler `return`ed silently and the button was
    // disabled, so a confused admin got no explanation from any surface.
    await userEvent.click(screen.getByRole('button', { name: /add account/i }));

    const username = screen.getByLabelText(/^username$/i);
    await waitFor(() => expect(username).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByText('Enter a username.')).toBeInTheDocument();
    expect(screen.getByText('Enter a password.')).toBeInTheDocument();
    expect(api.settings.auth.localUsers.create).not.toHaveBeenCalled();
  });

  it('rejects a too-short reset password inline and keeps the form open', async () => {
    renderWithClient(<LocalAccountsPanel />);
    await screen.findByText('admin');

    await userEvent.click(screen.getByRole('button', { name: /^reset$/i }));
    const password = screen.getByLabelText(/new password for admin/i);
    await userEvent.type(password, 'short');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(password).toHaveAttribute('aria-invalid', 'true'));
    expect(api.settings.auth.localUsers.resetPassword).not.toHaveBeenCalled();
    expect(password).toBeInTheDocument();
  });

  it('does not carry one row’s reset error over to another row', async () => {
    vi.mocked(api.settings.auth.localUsers.list).mockResolvedValue([
      adminUser,
      { ...adminUser, id: '2', username: 'viewer', role: 'VIEWER' },
    ]);
    renderWithClient(<LocalAccountsPanel />);
    await screen.findByText('admin');

    const [adminReset, viewerReset] = screen.getAllByRole('button', { name: /^reset$/i });
    await userEvent.click(adminReset as HTMLElement);
    await userEvent.type(screen.getByLabelText(/new password for admin/i), 'short');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(screen.getByLabelText(/new password for admin/i)).toHaveAttribute(
        'aria-invalid',
        'true',
      ),
    );

    // One `resetErrors` serves whichever row is open; opening the next row must
    // not greet that admin with the previous row's failure.
    await userEvent.click(viewerReset as HTMLElement);
    const viewerPassword = screen.getByLabelText(/new password for viewer/i);
    expect(viewerPassword).not.toHaveAttribute('aria-invalid');
  });

  it('sends a password verbatim, including surrounding whitespace', async () => {
    renderWithClient(<LocalAccountsPanel />);
    await screen.findByText('admin');

    await userEvent.click(screen.getByRole('button', { name: /^reset$/i }));
    // `userEvent.type` needs the space escaped only in keyboard syntax; a plain
    // string is typed literally, so this is exactly what an admin would paste
    // out of a password manager.
    await userEvent.type(screen.getByLabelText(/new password for admin/i), ' padded-secret-99 ');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      // The handler used to `.trim()` this, which stores a hash of something the
      // operator never typed — the account is then unreachable with the password
      // they believe they set.
      expect(api.settings.auth.localUsers.resetPassword).toHaveBeenCalledWith(
        '1',
        ' padded-secret-99 ',
      );
    });
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
