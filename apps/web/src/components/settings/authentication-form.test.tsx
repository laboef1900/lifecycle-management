import type { AuthConfigResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
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
  forceDisabledReason: null,
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

  // #241 pairs two server-side rules: `update()` clears both secret columns
  // whenever a non-oidc mode is saved, and it still runs `requireKey()` on a
  // SUBMITTED client secret first (the deliberate ENCRYPTION_KEY_REQUIRED
  // ordering pinned by settings-auth-routes.test.ts). A submitted, non-empty
  // secret therefore still 422s on a deployment with no CONFIG_ENCRYPTION_KEY —
  // harmless only because this form omits `clientSecret` entirely when the
  // field is blank. If it ever sent a value there instead, the keyless
  // deployment that most needs to escape an undecryptable OIDC config would
  // take a 422 on a save that stores no secret at all.
  it('omits clientSecret when switching away from oidc, so a keyless deployment can escape (#241)', async () => {
    vi.mocked(api.settings.auth.get).mockResolvedValue({
      ...baseConfig,
      mode: 'oidc',
      // What a keyless (or rotated-key) deployment actually reports: the stored
      // ciphertext can't be decrypted, so the effective mode is force-disabled
      // and nothing reads as "set". Spelled out rather than inherited from
      // baseConfig — it is the state this test is about.
      forceDisabledReason: 'secret_decrypt_failure',
      clientSecretSet: false,
      issuerUrl: 'https://idp.example.com',
      clientId: 'client-123',
      appBaseUrl: 'https://app.example.com',
    });
    renderWithClient(<AuthenticationForm />);
    await screen.findByRole('alert');

    // Precondition: nothing stored to "Replace", so the field is the empty
    // type-it-yourself input — leaving it untouched is exactly what an operator
    // switching modes does, and it is what keeps the PUT secret-free below.
    expect(screen.getByLabelText(/client secret/i)).toHaveAttribute('placeholder', 'Client secret');
    expect(screen.queryByRole('button', { name: /replace/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Local accounts' }));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(api.settings.auth.update).toHaveBeenCalled();
    });
    const body = vi.mocked(api.settings.auth.update).mock.calls[0]![0];
    expect(body.mode).toBe('local');
    // The load-bearing assertion: the key is absent, not null and not ''.
    expect(body).not.toHaveProperty('clientSecret');
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

  // #222 — an in-memory override forces the *enforced* mode to 'disabled'
  // while `data.mode` stays the STORED mode. The form must say so loudly for
  // BOTH causes and must never echo 'disabled' back into the PUT.
  describe('force-disabled override (#222)', () => {
    const breakGlassOidcConfig: AuthConfigResponse = {
      ...baseConfig,
      mode: 'oidc',
      forceDisabledReason: 'break_glass',
      issuerUrl: 'https://idp.example.com',
      clientId: 'client-123',
      appBaseUrl: 'https://app.example.com',
      clientSecretSet: true,
      // The override parks OIDC discovery, so this reads 'disabled' beside a
      // stored mode of 'oidc' (design note §3.9) — the alert explains it.
      discoveryStatus: 'disabled',
    };

    it('renders a warning alert naming the stored mode when break-glass is active', async () => {
      vi.mocked(api.settings.auth.get).mockResolvedValue({ ...breakGlassOidcConfig });
      renderWithClient(<AuthenticationForm />);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveAccessibleName(/break-glass override active/i);
      expect(within(alert).getByText(/authentication is force-disabled/i)).toBeInTheDocument();
      // The unauthenticated API is the whole point of the alert.
      expect(within(alert).getByText(/the api is currently unauthenticated/i)).toBeInTheDocument();
      // The env var is named so the operator knows what to clear...
      expect(within(alert).getAllByText('RECOVERY_DISABLE_AUTH').length).toBeGreaterThan(0);
      // ...and the STORED mode is named so 'disabled' is never mistaken for
      // their configured state.
      expect(within(alert).getByText('OIDC')).toBeInTheDocument();
      expect(within(alert).getByText(/take effect only after you clear/i)).toBeInTheDocument();
      // The other cause's recovery must not leak into this one.
      expect(within(alert).queryByText('CONFIG_ENCRYPTION_KEY')).not.toBeInTheDocument();

      // Colour is not the only signal: an icon plus explicit text carry it.
      expect(alert.querySelector('svg')).not.toBeNull();
      // The decorative icon is hidden from assistive tech.
      expect(alert.querySelector('svg')).toHaveAttribute('aria-hidden');

      // The mode selector reflects the stored mode, not the enforced one.
      expect(screen.getByRole('button', { name: 'OIDC', pressed: true })).toBeInTheDocument();
    });

    // The regression this contract reshape closes: a decrypt failure produces
    // the same divergence as break-glass, so it must raise the same alarm —
    // with its own recovery, since clearing RECOVERY_DISABLE_AUTH won't help.
    it('renders a warning alert with key-recovery copy on a secret decrypt failure', async () => {
      vi.mocked(api.settings.auth.get).mockResolvedValue({
        ...breakGlassOidcConfig,
        forceDisabledReason: 'secret_decrypt_failure',
      });
      renderWithClient(<AuthenticationForm />);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveAccessibleName(/could not be decrypted/i);
      expect(within(alert).getByText(/authentication is force-disabled/i)).toBeInTheDocument();
      expect(within(alert).getByText(/the api is currently unauthenticated/i)).toBeInTheDocument();
      // Names the key to restore, states the secrets survive, and never tells
      // the operator to clear a break-glass flag they never set.
      expect(within(alert).getAllByText('CONFIG_ENCRYPTION_KEY').length).toBeGreaterThan(0);
      expect(within(alert).getByText(/restore or roll back/i)).toBeInTheDocument();
      expect(within(alert).getByText(/encrypted secrets are intact/i)).toBeInTheDocument();
      expect(within(alert).queryByText('RECOVERY_DISABLE_AUTH')).not.toBeInTheDocument();

      // Same non-colour signalling and stored-mode naming as the other cause.
      expect(alert.querySelector('svg')).toHaveAttribute('aria-hidden');
      expect(within(alert).getByText('OIDC')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'OIDC', pressed: true })).toBeInTheDocument();
    });

    it('names "Local accounts" as the stored mode when that is what is stored', async () => {
      vi.mocked(api.settings.auth.get).mockResolvedValue({
        ...baseConfig,
        mode: 'local',
        forceDisabledReason: 'break_glass',
      });
      renderWithClient(<AuthenticationForm />);

      const alert = await screen.findByRole('alert');
      expect(within(alert).getByText('Local accounts')).toBeInTheDocument();
    });

    it('renders no alert when there is no divergence', async () => {
      vi.mocked(api.settings.auth.get).mockResolvedValue({
        ...breakGlassOidcConfig,
        forceDisabledReason: null,
        discoveryStatus: 'connected',
      });
      renderWithClient(<AuthenticationForm />);
      await screen.findByText(/configured/i);

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByText(/force-disabled/i)).not.toBeInTheDocument();
    });

    it('does not coerce the stored mode to disabled when saving during a decrypt failure', async () => {
      vi.mocked(api.settings.auth.get).mockResolvedValue({
        ...breakGlassOidcConfig,
        forceDisabledReason: 'secret_decrypt_failure',
      });
      renderWithClient(<AuthenticationForm />);
      await screen.findByRole('alert');

      await userEvent.type(screen.getByLabelText(/role claim/i), 'roles');
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        expect(api.settings.auth.update).toHaveBeenCalled();
      });
      expect(vi.mocked(api.settings.auth.update).mock.calls[0]![0].mode).toBe('oidc');
    });

    it('does not coerce the stored mode to disabled when saving during break-glass', async () => {
      vi.mocked(api.settings.auth.get).mockResolvedValue({ ...breakGlassOidcConfig });
      renderWithClient(<AuthenticationForm />);
      await screen.findByRole('alert');

      // Edit an unrelated, non-critical field and save without touching the
      // mode selector. The PUT must carry the STORED mode ('oidc'). If the
      // form defaulted from the enforced mode instead, this would send
      // 'disabled' and re-persist #222 through the UI.
      await userEvent.type(screen.getByLabelText(/role claim/i), 'roles');
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        expect(api.settings.auth.update).toHaveBeenCalled();
      });
      const body = vi.mocked(api.settings.auth.update).mock.calls[0]![0];
      expect(body.mode).toBe('oidc');
      expect(body.mode).not.toBe('disabled');
    });
  });
});
