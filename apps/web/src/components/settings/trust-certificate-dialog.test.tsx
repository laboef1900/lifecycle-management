import type { VsphereConnectionResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { TrustCertificateDialog } from './trust-certificate-dialog';

/** 32 colon-separated octets — the only shape `vsphereTrustCertSchema` accepts. */
const VALID_FINGERPRINT =
  'AB:CD:EF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC';

function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const connection = (
  overrides: Partial<VsphereConnectionResponse> = {},
): VsphereConnectionResponse => ({
  id: 'c1',
  name: 'vc-prod',
  hostname: 'vcenter.corp.local',
  port: 443,
  username: 'svc-lcm',
  tlsMode: 'pinned',
  pinnedLeafFingerprintSha256: null,
  instanceUuid: null,
  apiVersion: null,
  enabled: true,
  status: 'tls_untrusted',
  lastError: null,
  lastConnectedAt: null,
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('<TrustCertificateDialog>', () => {
  it('shows the fingerprint to confirm on a normal reachable probe', async () => {
    vi.spyOn(api.settings.vsphere, 'probe').mockResolvedValue({
      reachable: true,
      trustedBySystemRoots: false,
      leafFingerprintSha256:
        'AB:CD:EF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC',
      validFrom: null,
      validTo: null,
      outcome: 'ok',
    });

    renderWithClient(
      <TrustCertificateDialog
        connection={connection()}
        onOpenChange={() => {}}
        onTrusted={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText(/confirm this fingerprint/i)).toBeInTheDocument());
  });

  it("★ refuses a blank password with the dialog's own error and pins nothing", async () => {
    vi.spyOn(api.settings.vsphere, 'probe').mockResolvedValue({
      reachable: true,
      trustedBySystemRoots: false,
      leafFingerprintSha256: VALID_FINGERPRINT,
      validFrom: null,
      validTo: null,
      outcome: 'ok',
    });
    const trustCert = vi
      .spyOn(api.settings.vsphere.connections, 'trustCert')
      .mockResolvedValue(connection({ status: 'never_connected' }));

    renderWithClient(
      <TrustCertificateDialog
        connection={connection()}
        onOpenChange={() => {}}
        onTrusted={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/confirm this fingerprint/i)).toBeInTheDocument());

    // Submitted directly: the confirm button is disabled while the password is
    // empty, so the handler — not the button state — has to be the real gate now
    // that `noValidate` has retired the browser's bubble.
    const form = document.getElementById('trust-certificate-form');
    if (form === null) throw new Error('expected the trust form to be rendered');
    fireEvent.submit(form);

    const password = screen.getByLabelText(/password for svc-lcm/i);
    expect(await screen.findByText(/enter the password for svc-lcm/i)).toBeInTheDocument();
    expect(password).toHaveAttribute('aria-invalid', 'true');
    expect(password).toHaveAccessibleDescription(/enter the password for svc-lcm/i);
    // SC 3.3.1 — focus lands on the field that needs fixing.
    expect(password).toHaveFocus();
    // Re-pinning trust material without the password is the one thing this
    // endpoint exists to refuse; the client must not even ask.
    expect(trustCert).not.toHaveBeenCalled();
  });

  it('sends only a contract-valid payload once the password is typed', async () => {
    vi.spyOn(api.settings.vsphere, 'probe').mockResolvedValue({
      reachable: true,
      trustedBySystemRoots: false,
      leafFingerprintSha256: VALID_FINGERPRINT,
      validFrom: null,
      validTo: null,
      outcome: 'ok',
    });
    const trustCert = vi
      .spyOn(api.settings.vsphere.connections, 'trustCert')
      .mockResolvedValue(connection({ status: 'never_connected' }));

    renderWithClient(
      <TrustCertificateDialog
        connection={connection()}
        onOpenChange={() => {}}
        onTrusted={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/confirm this fingerprint/i)).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText(/password for svc-lcm/i), 'pw');
    await userEvent.click(screen.getByRole('button', { name: /^trust certificate$/i }));

    // The fingerprint is echoed from the probe, never typed.
    await waitFor(() =>
      expect(trustCert).toHaveBeenCalledWith('c1', {
        leafFingerprintSha256: VALID_FINGERPRINT,
        password: 'pw',
      }),
    );
  });
});
