import type { AuthConfigResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api } from '@/lib/api-client';

import { AuthenticationForm } from './authentication-form';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const baseConfig: AuthConfigResponse = {
  mode: 'disabled',
  issuerUrl: null,
  clientId: null,
  appBaseUrl: null,
  scopes: 'openid profile email',
  roleClaim: null,
  adminValues: null,
  defaultRole: 'admin',
  allowedEmailDomains: null,
  allowedEmails: null,
  sessionTtlHours: 12,
  allowInsecure: false,
  clientSecretSet: false,
  signingSecretSet: false,
  redirectUri: 'https://app.example.com/api/auth/callback',
  discoveryStatus: 'disabled',
  lastDiscoveryError: null,
};

describe('<AuthenticationForm>', () => {
  beforeEach(() => {
    vi.spyOn(api.settings.auth, 'get').mockResolvedValue({ ...baseConfig });
    vi.spyOn(api.settings.auth, 'update').mockResolvedValue({ ...baseConfig });
    vi.spyOn(api.settings.auth, 'test').mockResolvedValue({ ok: true, error: null });
    vi.spyOn(api.settings.auth, 'rotateSigningSecret').mockResolvedValue({ rotated: true });
    // The mode selector renders <LocalAccountsPanel /> (mounted, even if
    // visually collapsed inside the oidc break-glass <details>) whenever
    // computed.mode is 'local' or 'oidc' — stub its query so those renders
    // don't attempt a real fetch.
    vi.spyOn(api.settings.auth.localUsers, 'list').mockResolvedValue([]);
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the panel and shows "configured" + Replace when clientSecretSet is true', async () => {
    vi.mocked(api.settings.auth.get).mockResolvedValue({
      ...baseConfig,
      mode: 'oidc',
      issuerUrl: 'https://idp.example.com',
      clientId: 'client-123',
      appBaseUrl: 'https://app.example.com',
      clientSecretSet: true,
      discoveryStatus: 'connected',
    });
    renderWithClient(<AuthenticationForm />);

    expect(await screen.findByText(/configured/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /replace/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/client secret/i)).not.toBeInTheDocument();
    expect(screen.getByText(/connected/i)).toBeInTheDocument();
  });

  it('leaves clientSecret unchanged (omitted) when the secret field is left blank on save', async () => {
    vi.mocked(api.settings.auth.get).mockResolvedValue({
      ...baseConfig,
      mode: 'oidc',
      issuerUrl: 'https://idp.example.com',
      clientId: 'client-123',
      appBaseUrl: 'https://app.example.com',
      clientSecretSet: true,
      discoveryStatus: 'connected',
    });
    renderWithClient(<AuthenticationForm />);
    await screen.findByText(/configured/i);

    // Edit something unrelated so the field values are exercised through the
    // same body-building path, then save without touching the secret.
    await userEvent.type(screen.getByLabelText(/role claim/i), 'roles');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(api.settings.auth.update).toHaveBeenCalled();
    });
    const body = vi.mocked(api.settings.auth.update).mock.calls[0]![0];
    expect(body).not.toHaveProperty('clientSecret');
    expect(body.roleClaim).toBe('roles');
  });

  it('sends the typed secret only after clicking Replace, re-testing, and entering a value', async () => {
    vi.mocked(api.settings.auth.get).mockResolvedValue({
      ...baseConfig,
      mode: 'oidc',
      issuerUrl: 'https://idp.example.com',
      clientId: 'client-123',
      appBaseUrl: 'https://app.example.com',
      clientSecretSet: true,
      discoveryStatus: 'connected',
    });
    renderWithClient(<AuthenticationForm />);
    await screen.findByText(/configured/i);

    // Replacing the secret is a critical-field edit: it now requires a
    // fresh Test connection before Save is allowed, even though the server
    // already has mode 'oidc'.
    await userEvent.click(screen.getByRole('button', { name: /replace/i }));
    await userEvent.type(screen.getByLabelText(/client secret/i), 'new-secret-value');
    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await waitFor(() => {
      expect(screen.getByText(/connection succeeded/i)).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(api.settings.auth.update).toHaveBeenCalled();
    });
    const body = vi.mocked(api.settings.auth.update).mock.calls[0]![0];
    expect(body.clientSecret).toBe('new-secret-value');
  });

  it('trims whitespace from a pasted secret before sending it (test and save)', async () => {
    vi.mocked(api.settings.auth.get).mockResolvedValue({
      ...baseConfig,
      mode: 'oidc',
      issuerUrl: 'https://idp.example.com',
      clientId: 'client-123',
      appBaseUrl: 'https://app.example.com',
      clientSecretSet: true,
      discoveryStatus: 'connected',
    });
    renderWithClient(<AuthenticationForm />);
    await screen.findByText(/configured/i);

    await userEvent.click(screen.getByRole('button', { name: /replace/i }));
    await userEvent.type(screen.getByLabelText(/client secret/i), '  padded-secret  ');
    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await waitFor(() => {
      expect(api.settings.auth.test).toHaveBeenCalledWith(
        expect.objectContaining({ clientSecret: 'padded-secret' }),
      );
    });

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(api.settings.auth.update).toHaveBeenCalled();
    });
    const body = vi.mocked(api.settings.auth.update).mock.calls[0]![0];
    expect(body.clientSecret).toBe('padded-secret');
  });

  it('requires a fresh test after editing a critical field while data.mode is already oidc', async () => {
    vi.mocked(api.settings.auth.get).mockResolvedValue({
      ...baseConfig,
      mode: 'oidc',
      issuerUrl: 'https://idp.example.com',
      clientId: 'client-123',
      appBaseUrl: 'https://app.example.com',
      clientSecretSet: true,
      discoveryStatus: 'connected',
    });
    renderWithClient(<AuthenticationForm />);
    await screen.findByText(/configured/i);

    // No edits yet: the server-verified oidc state stands in for a fresh
    // test, so the hint is hidden and the mode selector stays on OIDC.
    expect(
      screen.queryByText(/run a successful connection test below to enable/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'OIDC', pressed: true })).toBeInTheDocument();

    // Editing a critical field invalidates that carry-over, even though
    // computed.mode is still 'oidc' (the mode selector is untouched).
    await userEvent.clear(screen.getByLabelText(/issuer url/i));
    await userEvent.type(screen.getByLabelText(/issuer url/i), 'https://idp2.example.com');

    expect(screen.getByRole('button', { name: 'OIDC', pressed: true })).toBeInTheDocument();
    expect(
      screen.getByText(/run a successful connection test below to enable/i),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(
      await screen.findByText(/test the connection successfully before enabling oidc/i),
    ).toBeInTheDocument();
    expect(api.settings.auth.update).not.toHaveBeenCalled();

    // A fresh, successful test clears the block.
    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await waitFor(() => {
      expect(screen.getByText(/connection succeeded/i)).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/run a successful connection test below to enable/i),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(api.settings.auth.update).toHaveBeenCalled();
    });
  });

  it('unlocks the OIDC mode option after a successful Test connection', async () => {
    renderWithClient(<AuthenticationForm />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'OIDC' })).toBeDisabled());

    await userEvent.type(screen.getByLabelText(/issuer url/i), 'https://idp.example.com');
    await userEvent.type(screen.getByLabelText(/client id/i), 'client-123');
    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'OIDC' })).toBeEnabled();
    });
    expect(screen.getByText(/connection succeeded/i)).toBeInTheDocument();
  });

  it('keeps the OIDC mode option disabled and shows the error when Test connection fails', async () => {
    vi.mocked(api.settings.auth.test).mockResolvedValue({
      ok: false,
      error: 'Discovery document unreachable',
    });
    renderWithClient(<AuthenticationForm />);
    await waitFor(() => screen.getByLabelText(/issuer url/i));

    await userEvent.type(screen.getByLabelText(/issuer url/i), 'https://idp.example.com');
    await userEvent.type(screen.getByLabelText(/client id/i), 'client-123');
    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));

    expect(await screen.findByText(/discovery document unreachable/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'OIDC' })).toBeDisabled();
  });

  it('blocks submit with a validation message when sessionTtlHours is out of range (0)', async () => {
    renderWithClient(<AuthenticationForm />);
    await waitFor(() => screen.getByLabelText(/session ttl/i));

    await userEvent.clear(screen.getByLabelText(/session ttl/i));
    await userEvent.type(screen.getByLabelText(/session ttl/i), '0');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(
      await screen.findByText(/session ttl/i, { selector: 'p[role="alert"]' }),
    ).toBeInTheDocument();
    expect(api.settings.auth.update).not.toHaveBeenCalled();
  });

  it('blocks submit with a validation message when sessionTtlHours is out of range (1000)', async () => {
    renderWithClient(<AuthenticationForm />);
    await waitFor(() => screen.getByLabelText(/session ttl/i));

    await userEvent.clear(screen.getByLabelText(/session ttl/i));
    await userEvent.type(screen.getByLabelText(/session ttl/i), '1000');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(
      await screen.findByText(/session ttl/i, { selector: 'p[role="alert"]' }),
    ).toBeInTheDocument();
    expect(api.settings.auth.update).not.toHaveBeenCalled();
  });

  it('blocks enabling oidc without an appBaseUrl even after a successful test', async () => {
    renderWithClient(<AuthenticationForm />);
    await waitFor(() => screen.getByLabelText(/issuer url/i));

    await userEvent.type(screen.getByLabelText(/issuer url/i), 'https://idp.example.com');
    await userEvent.type(screen.getByLabelText(/client id/i), 'client-123');
    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'OIDC' })).toBeEnabled());

    await userEvent.click(screen.getByRole('button', { name: 'OIDC' }));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/app base url is required/i)).toBeInTheDocument();
    expect(api.settings.auth.update).not.toHaveBeenCalled();
  });

  it('saves successfully once tested, appBaseUrl set, and OIDC mode selected', async () => {
    renderWithClient(<AuthenticationForm />);
    await waitFor(() => screen.getByLabelText(/issuer url/i));

    await userEvent.type(screen.getByLabelText(/issuer url/i), 'https://idp.example.com');
    await userEvent.type(screen.getByLabelText(/client id/i), 'client-123');
    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'OIDC' })).toBeEnabled());

    await userEvent.click(screen.getByRole('button', { name: 'OIDC' }));
    await userEvent.type(screen.getByLabelText(/app base url/i), 'https://app.example.com');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(api.settings.auth.update).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'oidc',
          issuerUrl: 'https://idp.example.com',
          clientId: 'client-123',
          appBaseUrl: 'https://app.example.com',
        }),
      );
    });
    expect(toast.success).toHaveBeenCalledWith('Authentication settings saved');
  });

  it('shows a toast with the server message when save fails (e.g. 422 TEST_REQUIRED)', async () => {
    vi.mocked(api.settings.auth.get).mockResolvedValue({
      ...baseConfig,
      issuerUrl: 'https://idp.example.com',
      clientId: 'client-123',
    });
    vi.mocked(api.settings.auth.update).mockRejectedValue(
      new ApiError(422, {
        error: { code: 'TEST_REQUIRED', message: 'Test the connection first.' },
      }),
    );
    renderWithClient(<AuthenticationForm />);
    await waitFor(() => screen.getByLabelText(/role claim/i));

    // Force a save call directly against the mocked mutation by satisfying
    // local gating: simulate having tested ok, appBaseUrl set.
    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'OIDC' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'OIDC' }));
    await userEvent.type(screen.getByLabelText(/app base url/i), 'https://app.example.com');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Test the connection first.');
    });
  });

  it('copies the redirect URI to the clipboard', async () => {
    renderWithClient(<AuthenticationForm />);
    await waitFor(() => screen.getByLabelText('Redirect URI'));

    await userEvent.click(screen.getByRole('button', { name: /copy redirect uri/i }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(baseConfig.redirectUri);
    });
    expect(toast.success).toHaveBeenCalledWith('Copied');
  });

  it('rotates the signing secret only when mode is oidc', async () => {
    vi.mocked(api.settings.auth.get).mockResolvedValue({
      ...baseConfig,
      mode: 'oidc',
      issuerUrl: 'https://idp.example.com',
      clientId: 'client-123',
      appBaseUrl: 'https://app.example.com',
      signingSecretSet: true,
      discoveryStatus: 'connected',
    });
    renderWithClient(<AuthenticationForm />);
    await screen.findByRole('button', { name: /rotate signing secret/i });

    await userEvent.click(screen.getByRole('button', { name: /rotate signing secret/i }));

    await waitFor(() => {
      expect(api.settings.auth.rotateSigningSecret).toHaveBeenCalled();
    });
    expect(toast.success).toHaveBeenCalledWith('Signing secret rotated');
  });

  it('does not show a Rotate signing secret action when mode is disabled', async () => {
    renderWithClient(<AuthenticationForm />);
    await waitFor(() => screen.getByLabelText(/issuer url/i));
    expect(
      screen.queryByRole('button', { name: /rotate signing secret/i }),
    ).not.toBeInTheDocument();
  });

  it('shows skeleton placeholders while the auth config query is pending', () => {
    // A never-resolving fetch keeps the query in its pending state.
    vi.mocked(api.settings.auth.get).mockReturnValue(new Promise<never>(() => {}));
    const { container } = renderWithClient(<AuthenticationForm />);
    expect(container.querySelector('.animate-shimmer')).toBeInTheDocument();
  });

  it('selecting "Local accounts" is never gated and renders the LocalAccountsPanel', async () => {
    vi.mocked(api.settings.auth.localUsers.list).mockResolvedValue([
      {
        id: 'u1',
        username: 'jsmith',
        role: 'ADMIN',
        disabled: false,
        lastLoginAt: null,
        createdAt: '2026-07-06T00:00:00.000Z',
      },
    ]);
    renderWithClient(<AuthenticationForm />);
    await waitFor(() => screen.getByLabelText(/issuer url/i));

    // Untested, unconfigured OIDC — the OIDC option is gated, but Local
    // accounts never is.
    expect(screen.getByRole('button', { name: 'OIDC' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Local accounts' })).toBeEnabled();
    expect(screen.queryByText('jsmith')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Local accounts' }));

    expect(await screen.findByText('jsmith')).toBeInTheDocument();
  });

  it('renders the local-admin management section collapsed (break-glass) when mode is oidc', async () => {
    vi.mocked(api.settings.auth.get).mockResolvedValue({
      ...baseConfig,
      mode: 'oidc',
      issuerUrl: 'https://idp.example.com',
      clientId: 'client-123',
      appBaseUrl: 'https://app.example.com',
      discoveryStatus: 'connected',
    });
    vi.mocked(api.settings.auth.localUsers.list).mockResolvedValue([
      {
        id: 'u1',
        username: 'breakglass',
        role: 'ADMIN',
        disabled: false,
        lastLoginAt: null,
        createdAt: '2026-07-06T00:00:00.000Z',
      },
    ]);
    renderWithClient(<AuthenticationForm />);

    const summary = await screen.findByText(/local admin \(break-glass\)/i);
    const details = summary.closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');

    // The panel is mounted (its content is queryable) even while collapsed —
    // <details> hides content visually, it doesn't unmount it.
    expect(await screen.findByText('breakglass')).toBeInTheDocument();
  });
});
