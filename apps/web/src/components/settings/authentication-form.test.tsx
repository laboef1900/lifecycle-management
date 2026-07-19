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

    // #241 made saving a non-oidc mode DELETE both stored secret columns
    // server-side. The recovery copy here predates that and told the operator
    // the opposite ("intact and never wiped") in the one window where the
    // deletion is most costly: the ciphertext may still be recoverable by
    // restoring the key, and this save destroys it. The claim is true of the
    // DEGRADE (which writes nothing at all), so it stays — scoped, with the
    // caveat spelled out. The break-glass copy makes no such claim and is
    // therefore left alone; both causes are covered at the point of action by
    // the confirmation below.
    it('scopes "never wiped" to the degrade and warns that saving a non-oidc mode deletes the secret (#241)', async () => {
      vi.mocked(api.settings.auth.get).mockResolvedValue({
        ...breakGlassOidcConfig,
        forceDisabledReason: 'secret_decrypt_failure',
      });
      renderWithClient(<AuthenticationForm />);

      const alert = await screen.findByRole('alert');
      // The surviving claim is now attributed to the degrade rather than
      // stated as an unconditional property of the deployment.
      expect(within(alert).getByText(/degrade itself writes nothing/i)).toBeInTheDocument();
      // ...and the destructive path an operator might take from this very
      // screen is named, with its scope and its irreversibility.
      expect(
        within(alert).getByText(/permanently deletes the stored oidc client secret/i),
      ).toBeInTheDocument();
      expect(
        within(alert).getByText(/restoring the key will not bring it back/i),
      ).toBeInTheDocument();
      expect(
        within(alert).getByText(/re-enter it from your identity provider/i),
      ).toBeInTheDocument();
    });

    // The copy used to end the decrypt-failure recovery with "changes saved
    // here take effect only after that" (restoring the key AND restarting).
    // That is false: `decryptDegraded` is set once in the auth-config plugin's
    // BOOT catch and is never re-applied, while `reload()` re-derives
    // `authConfig.current` from the successful write and `plugins/auth.ts`
    // reads it per request. So a save closes the open API on the spot — the
    // server's own `settings-auth-routes.test.ts` rotation-recovery case
    // asserts `authConfig.current.mode === 'oidc'` right after the PUT, with no
    // restart. An operator who believed the old sentence would leave `/api`
    // open to an anonymous ADMIN while hunting for the old key.
    it('tells the operator a save takes effect immediately and names what closes the open API (#241)', async () => {
      vi.mocked(api.settings.auth.get).mockResolvedValue({
        ...breakGlassOidcConfig,
        forceDisabledReason: 'secret_decrypt_failure',
      });
      renderWithClient(<AuthenticationForm />);

      const alert = await screen.findByRole('alert');
      // The falsehood must be gone. Scoped to this cause on purpose: the
      // break-glass arm says the same words and is CORRECT there, because
      // `enforce()` re-applies that override on every reload.
      expect(within(alert).queryByText(/take effect only after/i)).not.toBeInTheDocument();
      expect(
        within(alert).getByText(/takes effect immediately, with no restart/i),
      ).toBeInTheDocument();
      // Both routes that actually close the API are named...
      expect(within(alert).getByText(/enforcement resumes on the spot/i)).toBeInTheDocument();
      expect(
        within(alert).getByText(/switching to local accounts closes the api without needing/i),
      ).toBeInTheDocument();
      // ...and the mode that does NOT close it is called out, so "just save
      // any non-OIDC mode" is never read as a way out of the open API.
      expect(
        within(alert).getByText(/saving disabled .*leaves the api open by design/i),
      ).toBeInTheDocument();
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

  // Saving a non-oidc mode CLEARS both stored secret columns server-side
  // (#241) — irreversible, and specifically NOT recoverable by restoring
  // CONFIG_ENCRYPTION_KEY, which is the recovery every other path here relies
  // on. CLAUDE.md requires a destructive action to show its scope and take a
  // confirmation step; this is that step.
  describe('confirming the secret deletion when switching away from OIDC (#241)', () => {
    const storedOidcConfig: AuthConfigResponse = {
      ...baseConfig,
      mode: 'oidc',
      issuerUrl: 'https://idp.example.com',
      clientId: 'client-123',
      appBaseUrl: 'https://app.example.com',
      clientSecretSet: true,
      signingSecretSet: true,
      discoveryStatus: 'connected',
    };

    it('opens a confirmation naming the scope instead of saving immediately', async () => {
      vi.mocked(api.settings.auth.get).mockResolvedValue({ ...storedOidcConfig });
      renderWithClient(<AuthenticationForm />);
      await screen.findByText(/configured/i);

      await userEvent.click(screen.getByRole('button', { name: 'Local accounts' }));
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveAccessibleName(/delete the stored oidc client secret/i);
      // Scope + irreversibility, not just "are you sure?".
      expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
      expect(
        within(dialog).getByText(/restoring .*config_encryption_key.* will not/i),
      ).toBeInTheDocument();
      expect(within(dialog).getByText(/re-enter the client secret/i)).toBeInTheDocument();
      // The whole point: nothing has been sent yet.
      expect(api.settings.auth.update).not.toHaveBeenCalled();
    });

    it('does not PUT when the confirmation is cancelled', async () => {
      vi.mocked(api.settings.auth.get).mockResolvedValue({ ...storedOidcConfig });
      renderWithClient(<AuthenticationForm />);
      await screen.findByText(/configured/i);

      await userEvent.click(screen.getByRole('button', { name: 'Disabled' }));
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
      const dialog = await screen.findByRole('dialog');
      await userEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(api.settings.auth.update).not.toHaveBeenCalled();
      // The pending edit survives the cancel — the operator is back where they
      // were, not silently reset to the stored mode.
      expect(screen.getByRole('button', { name: 'Disabled', pressed: true })).toBeInTheDocument();
    });

    it('sends the mode change with no clientSecret once confirmed, so a keyless deployment can escape', async () => {
      // The keyless / rotated-key deployment that most needs to leave OIDC:
      // nothing decrypts, so the secret field is the empty type-it-yourself
      // input and the PUT must omit `clientSecret` entirely. Sending '' or null
      // would be harmless, but sending a VALUE would now be refused server-side
      // with 422 CLIENT_SECRET_NOT_APPLICABLE.
      vi.mocked(api.settings.auth.get).mockResolvedValue({
        ...storedOidcConfig,
        forceDisabledReason: 'secret_decrypt_failure',
        clientSecretSet: false,
        signingSecretSet: false,
        discoveryStatus: 'disabled',
      });
      renderWithClient(<AuthenticationForm />);
      await screen.findByRole('alert');
      expect(screen.getByLabelText(/client secret/i)).toHaveAttribute(
        'placeholder',
        'Client secret',
      );

      await userEvent.click(screen.getByRole('button', { name: 'Local accounts' }));
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
      const dialog = await screen.findByRole('dialog');
      await userEvent.click(
        within(dialog).getByRole('button', { name: /delete secret and save/i }),
      );

      await waitFor(() => {
        expect(api.settings.auth.update).toHaveBeenCalled();
      });
      const body = vi.mocked(api.settings.auth.update).mock.calls[0]![0];
      expect(body.mode).toBe('local');
      // The key is absent, not null and not ''.
      expect(body).not.toHaveProperty('clientSecret');
    });

    // A confirmed destructive action that then deletes nothing: the operator
    // clicks Replace, types a secret, switches to Local accounts, and confirms
    // "Delete secret and save" — but the payload still carried the typed
    // secret, which the server refuses with 422 CLIENT_SECRET_NOT_APPLICABLE.
    // Nothing saved, nothing deleted, after an irreversible-sounding
    // confirmation. A non-oidc save must never carry a client secret.
    it('drops a typed client secret from a non-oidc save so the confirmed deletion cannot 422 (#241)', async () => {
      vi.mocked(api.settings.auth.get).mockResolvedValue({ ...storedOidcConfig });
      renderWithClient(<AuthenticationForm />);
      await screen.findByText(/configured/i);

      await userEvent.click(screen.getByRole('button', { name: /replace/i }));
      await userEvent.type(screen.getByLabelText(/client secret/i), 'typed-then-abandoned');
      await userEvent.click(screen.getByRole('button', { name: 'Local accounts' }));
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

      const dialog = await screen.findByRole('dialog');
      // The typed value is dropped as the dialog opens, so the form behind it
      // stops offering to store a secret that this save deletes instead.
      // Exact label: the dialog's own accessible name ("Delete the stored OIDC
      // client secret?") matches a loose /client secret/i too.
      expect(screen.queryByLabelText('Client secret')).not.toBeInTheDocument();

      await userEvent.click(
        within(dialog).getByRole('button', { name: /delete secret and save/i }),
      );

      await waitFor(() => {
        expect(api.settings.auth.update).toHaveBeenCalled();
      });
      const body = vi.mocked(api.settings.auth.update).mock.calls[0]![0];
      expect(body.mode).toBe('local');
      expect(body).not.toHaveProperty('clientSecret');
    });

    // The counterpart to the strip above, and the reason it is scoped to the
    // confirmed path: everywhere else a typed secret is still SENT, so the
    // server's 422 CLIENT_SECRET_NOT_APPLICABLE tells the operator it was not
    // stored. Dropping it form-wide would answer 200 and discard it silently —
    // exactly the silent drop `AuthConfigService.update()` refuses to perform.
    it('still sends a typed secret with a non-oidc save when no deletion was confirmed', async () => {
      // baseConfig stores 'disabled', so no confirmation is involved.
      renderWithClient(<AuthenticationForm />);
      await waitFor(() => screen.getByLabelText('Client secret'));

      await userEvent.type(screen.getByLabelText('Client secret'), 'typed-on-a-disabled-row');
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        expect(api.settings.auth.update).toHaveBeenCalled();
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      const body = vi.mocked(api.settings.auth.update).mock.calls[0]![0];
      expect(body.mode).toBe('disabled');
      expect(body.clientSecret).toBe('typed-on-a-disabled-row');
    });

    it('does not confirm when the stored mode is not oidc — there is no stored secret to delete', async () => {
      // The negative control. `baseConfig` stores `disabled`, so switching to
      // local clears nothing and must not make the operator confirm a deletion
      // that is not happening.
      renderWithClient(<AuthenticationForm />);
      await waitFor(() => screen.getByLabelText(/issuer url/i));

      await userEvent.click(screen.getByRole('button', { name: 'Local accounts' }));
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        expect(api.settings.auth.update).toHaveBeenCalled();
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(vi.mocked(api.settings.auth.update).mock.calls[0]![0].mode).toBe('local');
    });

    it('does not confirm when the save keeps oidc selected', async () => {
      vi.mocked(api.settings.auth.get).mockResolvedValue({ ...storedOidcConfig });
      renderWithClient(<AuthenticationForm />);
      await screen.findByText(/configured/i);

      await userEvent.type(screen.getByLabelText(/role claim/i), 'roles');
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        expect(api.settings.auth.update).toHaveBeenCalled();
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
