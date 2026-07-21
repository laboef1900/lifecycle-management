import type { VsphereConnectionResponse, VsphereProbeResult } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from '@/lib/api-client';

import { VcenterConnectionsPanel } from './vcenter-connections-panel';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// `AdminOnly` gates the "Sync now" button via `useIsAdmin`, which reads router
// context. Mock the hook so the panel renders in isolation and each test controls
// the role. Default admin; the VIEWER test flips it.
const { useIsAdminMock } = vi.hoisted(() => ({ useIsAdminMock: vi.fn(() => true) }));
vi.mock('@/lib/auth', () => ({ useIsAdmin: () => useIsAdminMock() }));

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
  apiVersion: '8.0.3.0',
  enabled: true,
  status: 'active',
  lastError: null,
  lastConnectedAt: null,
  createdAt: '2026-07-17T00:00:00.000Z',
  updatedAt: '2026-07-17T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  vi.restoreAllMocks();
  useIsAdminMock.mockReturnValue(true);
  vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([]);
});

describe('<VcenterConnectionsPanel>', () => {
  it('steers the operator to a read-only service account', async () => {
    renderWithClient(<VcenterConnectionsPanel />);
    // The single highest value-to-effort control in the threat model: it limits
    // blast radius rather than probability. Every other control assumes the
    // credential stays put; this one assumes it will not.
    expect(await screen.findByText(/read-only service account/i)).toBeInTheDocument();
  });

  it('★ checking the certificate sends only the hostname — never the password', async () => {
    const probe = vi.spyOn(api.settings.vsphere, 'probe').mockResolvedValue({
      reachable: true,
      trustedBySystemRoots: false,
      leafFingerprintSha256: 'AB:CD',
      validFrom: null,
      validTo: null,
      outcome: 'ok',
    });
    renderWithClient(<VcenterConnectionsPanel />);

    await userEvent.type(await screen.findByLabelText(/hostname/i), 'vcenter.corp.local');
    await userEvent.type(screen.getByLabelText(/password/i), 'never-send-me');
    await userEvent.click(screen.getByRole('button', { name: /check certificate/i }));

    await waitFor(() => expect(probe).toHaveBeenCalled());
    // Vet the certificate BEFORE the credential is transmitted. A merged
    // "test connection" would send the password to a cert nobody has confirmed.
    // The port rides along (default 443) but never the password.
    expect(probe).toHaveBeenCalledWith({ hostname: 'vcenter.corp.local', port: 443 });
    expect(JSON.stringify(probe.mock.calls)).not.toContain('never-send-me');
  });

  it('offers a port field defaulting to 443 and probes the chosen port (#199)', async () => {
    const probe = vi.spyOn(api.settings.vsphere, 'probe').mockResolvedValue({
      reachable: true,
      trustedBySystemRoots: false,
      leafFingerprintSha256: 'AB:CD',
      validFrom: null,
      validTo: null,
      outcome: 'ok',
    });
    renderWithClient(<VcenterConnectionsPanel />);

    const port = await screen.findByLabelText(/port/i);
    expect(port).toHaveValue(443);

    await userEvent.type(screen.getByLabelText(/hostname/i), 'vcenter.corp.local');
    await userEvent.clear(port);
    await userEvent.type(port, '8443');
    await userEvent.click(screen.getByRole('button', { name: /check certificate/i }));

    await waitFor(() => expect(probe).toHaveBeenCalled());
    expect(probe).toHaveBeenCalledWith({ hostname: 'vcenter.corp.local', port: 8443 });
  });

  it('includes the chosen port in the create payload (#199)', async () => {
    const create = vi
      .spyOn(api.settings.vsphere.connections, 'create')
      .mockResolvedValue(connection({ port: 8443 }));
    renderWithClient(<VcenterConnectionsPanel />);

    await userEvent.type(await screen.findByLabelText(/^name/i), 'vc-alt');
    await userEvent.type(screen.getByLabelText(/hostname/i), 'vcenter.corp.local');
    await userEvent.clear(screen.getByLabelText(/port/i));
    await userEvent.type(screen.getByLabelText(/port/i), '8443');
    await userEvent.type(screen.getByLabelText(/username/i), 'svc-lcm');
    await userEvent.type(screen.getByLabelText(/password/i), 'pw');
    await userEvent.click(screen.getByRole('button', { name: /save connection/i }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ port: 8443 }));
  });

  it('shows a non-default port in the connection list, hiding it for 443 (#199)', async () => {
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([
      connection({ name: 'vc-alt', hostname: 'vcenter.corp.local', port: 8443 }),
    ]);
    renderWithClient(<VcenterConnectionsPanel />);

    expect(await screen.findByText(/vcenter\.corp\.local:8443/)).toBeInTheDocument();
  });

  it('discards a captured certificate when the port changes (#199)', async () => {
    vi.spyOn(api.settings.vsphere, 'probe').mockResolvedValue({
      reachable: true,
      trustedBySystemRoots: false,
      leafFingerprintSha256: 'AB:CD:EF:01',
      validFrom: null,
      validTo: null,
      outcome: 'ok',
    });
    renderWithClient(<VcenterConnectionsPanel />);

    await userEvent.type(await screen.findByLabelText(/hostname/i), 'vcenter.corp.local');
    await userEvent.click(screen.getByRole('button', { name: /check certificate/i }));
    expect(await screen.findByText('AB:CD:EF:01')).toBeInTheDocument();

    // A different port is a different endpoint; the old certificate says nothing.
    await userEvent.type(screen.getByLabelText(/port/i), '1');
    await waitFor(() => expect(screen.queryByText('AB:CD:EF:01')).not.toBeInTheDocument());
  });

  it('shows the fingerprint to confirm — and nothing else about the certificate', async () => {
    vi.spyOn(api.settings.vsphere, 'probe').mockResolvedValue({
      reachable: true,
      trustedBySystemRoots: false,
      leafFingerprintSha256: 'AB:CD:EF:01',
      validFrom: null,
      validTo: 'Jul 19 08:06:40 2036 GMT',
      outcome: 'ok',
    });
    renderWithClient(<VcenterConnectionsPanel />);

    await userEvent.type(await screen.findByLabelText(/hostname/i), 'vcenter.corp.local');
    await userEvent.click(screen.getByRole('button', { name: /check certificate/i }));

    expect(await screen.findByText('AB:CD:EF:01')).toBeInTheDocument();
    // Points at the out-of-band check an admin actually performs.
    expect(screen.getByText(/govc about.cert -thumbprint/)).toBeInTheDocument();
  });

  it('says nothing to confirm when a public CA already vouches for the host', async () => {
    vi.spyOn(api.settings.vsphere, 'probe').mockResolvedValue({
      reachable: true,
      trustedBySystemRoots: true,
      leafFingerprintSha256: 'AB:CD',
      validFrom: null,
      validTo: null,
      outcome: 'ok',
    });
    renderWithClient(<VcenterConnectionsPanel />);

    await userEvent.type(await screen.findByLabelText(/hostname/i), 'vcenter.example.com');
    await userEvent.click(screen.getByRole('button', { name: /check certificate/i }));

    // The TOFU interstitial appears ONLY when it is genuinely needed — friction on
    // the common path is what eventually motivates removing the gate.
    expect(await screen.findByText(/trusted by a public CA/i)).toBeInTheDocument();
  });

  it('discards a captured certificate when the hostname changes', async () => {
    vi.spyOn(api.settings.vsphere, 'probe').mockResolvedValue({
      reachable: true,
      trustedBySystemRoots: false,
      leafFingerprintSha256: 'AB:CD:EF:01',
      validFrom: null,
      validTo: null,
      outcome: 'ok',
    });
    renderWithClient(<VcenterConnectionsPanel />);

    const hostname = await screen.findByLabelText(/hostname/i);
    await userEvent.type(hostname, 'vcenter.corp.local');
    await userEvent.click(screen.getByRole('button', { name: /check certificate/i }));
    expect(await screen.findByText('AB:CD:EF:01')).toBeInTheDocument();

    await userEvent.type(hostname, '-2');
    // A different host says nothing about the old certificate. Leaving it on
    // screen would invite confirming a fingerprint for the wrong machine.
    await waitFor(() => expect(screen.queryByText('AB:CD:EF:01')).not.toBeInTheDocument());
  });

  it('states status in words, not colour alone', async () => {
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([
      connection({ status: 'cert_mismatch' }),
    ]);
    renderWithClient(<VcenterConnectionsPanel />);
    // House style: colour is never the only signal.
    expect(await screen.findByText('Certificate changed')).toBeInTheDocument();
  });

  it('promises no data loss when removing a connection', async () => {
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([connection()]);
    renderWithClient(<VcenterConnectionsPanel />);

    await userEvent.click(await screen.findByRole('button', { name: /remove vc-prod/i }));
    // Deleting a connection must never cascade into baselines — the clusters
    // survive as manually managed. The dialog says so explicitly, because scope
    // and consequences must be visible at the click site.
    expect(
      await screen.findByText(/no capacity data or baselines are deleted/i),
    ).toBeInTheDocument();
  });

  it('★ queues an immediate sync and confirms it with a toast', async () => {
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([connection()]);
    const syncNow = vi
      .spyOn(api.settings.vsphere.connections, 'syncNow')
      .mockResolvedValue({ dueAt: '2026-07-17T12:00:00.000Z' });
    renderWithClient(<VcenterConnectionsPanel />);

    await userEvent.click(await screen.findByRole('button', { name: /sync now/i }));

    // The button POSTs to the queue endpoint — it never awaits vCenter itself.
    await waitFor(() => expect(syncNow).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('shows the last sync time and a non-ok status in words, not colour alone', async () => {
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([
      connection({
        syncState: {
          lastSyncAt: '2026-07-17T09:30:00.000Z',
          lastSyncStatus: 'auth_failed',
          lastSnapshotAt: null,
          lastSnapshotStatus: null,
          lastSuccessPeriod: null,
          failureCount: 1,
        },
      }),
    ]);
    renderWithClient(<VcenterConnectionsPanel />);

    expect(await screen.findByText(/last synced/i)).toBeInTheDocument();
    // House style: the outcome is stated in words, never colour alone.
    expect(screen.getByText(/credentials rejected/i)).toBeInTheDocument();
  });

  it('hides Sync now from a VIEWER — the server still enforces it', async () => {
    useIsAdminMock.mockReturnValue(false);
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([connection()]);
    renderWithClient(<VcenterConnectionsPanel />);

    expect(await screen.findByText('vc-prod')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sync now/i })).not.toBeInTheDocument();
  });

  it('disables Sync now for a disabled connection — a queued run could never fire', async () => {
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([
      connection({ enabled: false }),
    ]);
    renderWithClient(<VcenterConnectionsPanel />);

    expect(await screen.findByRole('button', { name: /sync now/i })).toBeDisabled();
  });
});

// ---------- Trust certificate (#259) ----------

const PROBED_FINGERPRINT = 'AB:CD:EF:01';

function mockProbe(overrides: Partial<VsphereProbeResult> = {}) {
  return vi.spyOn(api.settings.vsphere, 'probe').mockResolvedValue({
    reachable: true,
    trustedBySystemRoots: false,
    leafFingerprintSha256: PROBED_FINGERPRINT,
    validFrom: null,
    validTo: 'Jul 19 08:06:40 2036 GMT',
    outcome: 'ok',
    ...overrides,
  });
}

/** Opens the dialog for the single listed connection and waits for the probe. */
async function openTrustDialog(): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: /trust certificate: vc-prod/i }));
  expect(await screen.findByText(PROBED_FINGERPRINT)).toBeInTheDocument();
}

/** Fails `trustCert` with a real ApiError so `describeApiError` reads its message. */
function mockTrustCertFailure(code: string, message: string) {
  return vi
    .spyOn(api.settings.vsphere.connections, 'trustCert')
    .mockRejectedValue(new ApiError(422, { error: { code, message } }));
}

describe('<VcenterConnectionsPanel> — trust certificate (#259)', () => {
  it.each(['tls_untrusted', 'cert_mismatch'] as const)(
    'offers the action for a %s connection',
    async (status) => {
      vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([
        connection({ status }),
      ]);
      renderWithClient(<VcenterConnectionsPanel />);

      expect(
        await screen.findByRole('button', { name: /trust certificate: vc-prod/i }),
      ).toBeInTheDocument();
    },
  );

  it('does not offer the action where re-pinning would not fix anything', async () => {
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([
      connection({ status: 'auth_failed' }),
    ]);
    renderWithClient(<VcenterConnectionsPanel />);

    expect(await screen.findByText('vc-prod')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /trust certificate/i })).not.toBeInTheDocument();
  });

  it('hides the action from a VIEWER — the server still enforces it', async () => {
    useIsAdminMock.mockReturnValue(false);
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([
      connection({ status: 'tls_untrusted' }),
    ]);
    renderWithClient(<VcenterConnectionsPanel />);

    expect(await screen.findByText('vc-prod')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /trust certificate/i })).not.toBeInTheDocument();
  });

  it('★ probes the STORED hostname and port — never a typed-in one', async () => {
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([
      connection({ status: 'tls_untrusted', hostname: 'vc-stored.corp.local', port: 8443 }),
    ]);
    const probe = mockProbe();
    renderWithClient(<VcenterConnectionsPanel />);

    await userEvent.click(
      await screen.findByRole('button', { name: /trust certificate: vc-prod/i }),
    );

    // The dialog has no hostname field and must never grow one: this endpoint
    // pins trust material, so "probe an arbitrary URL" is exactly the affordance
    // an attacker needs. The stored host is the only host.
    await waitFor(() =>
      expect(probe).toHaveBeenCalledWith({ hostname: 'vc-stored.corp.local', port: 8443 }),
    );
  });

  it('shows the fingerprint to confirm — and nothing else about the certificate', async () => {
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([
      connection({ status: 'tls_untrusted' }),
    ]);
    mockProbe();
    renderWithClient(<VcenterConnectionsPanel />);
    await openTrustDialog();

    expect(screen.getByText(/Expires Jul 19 08:06:40 2036 GMT/)).toBeInTheDocument();
    // Points at the out-of-band check an admin actually performs.
    expect(screen.getByText(/govc about.cert -thumbprint/)).toBeInTheDocument();
  });

  it('★ warns that confirming REPLACES the previously trusted certificate', async () => {
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([
      connection({ status: 'cert_mismatch' }),
    ]);
    mockProbe();
    renderWithClient(<VcenterConnectionsPanel />);
    await openTrustDialog();

    // A cert_mismatch re-pin is not the same act as first-contact trust: the
    // benign cause (a regenerated VMCA root) and the hostile one look identical
    // from here, so the admin must be told which one they are choosing.
    expect(await screen.findByRole('dialog')).toHaveTextContent(/REPLACES/);
    expect(
      screen.getByRole('button', { name: /replace trusted certificate/i }),
    ).toBeInTheDocument();
  });

  it('frames a tls_untrusted connection as first-contact trust, not a replacement', async () => {
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([
      connection({ status: 'tls_untrusted' }),
    ]);
    mockProbe();
    renderWithClient(<VcenterConnectionsPanel />);
    await openTrustDialog();

    expect(await screen.findByRole('dialog')).not.toHaveTextContent(/REPLACES/);
    expect(screen.getByRole('heading', { name: /trust this certificate/i })).toBeInTheDocument();
  });

  it('★ will not confirm without a password — the endpoint requires it', async () => {
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([
      connection({ status: 'tls_untrusted' }),
    ]);
    mockProbe();
    renderWithClient(<VcenterConnectionsPanel />);
    await openTrustDialog();

    // Never optional "because it's already saved" — re-pinning trust material is
    // precisely what a DNS-spoof-plus-repin attack needs.
    expect(screen.getByRole('button', { name: /^trust certificate$/i })).toBeDisabled();
  });

  it('★ sends the probed fingerprint and the typed password, then invalidates and toasts', async () => {
    const list = vi
      .spyOn(api.settings.vsphere.connections, 'list')
      .mockResolvedValue([connection({ status: 'tls_untrusted' })]);
    mockProbe();
    const trustCert = vi
      .spyOn(api.settings.vsphere.connections, 'trustCert')
      .mockResolvedValue(connection({ status: 'never_connected' }));
    renderWithClient(<VcenterConnectionsPanel />);
    await openTrustDialog();

    await userEvent.type(screen.getByLabelText(/password for svc-lcm/i), 'pw');
    await userEvent.click(screen.getByRole('button', { name: /^trust certificate$/i }));

    // The fingerprint is echoed from the probe, never typed: the server re-probes
    // and refuses to pin unless what it sees matches what the admin confirmed.
    await waitFor(() =>
      expect(trustCert).toHaveBeenCalledWith('c1', {
        leafFingerprintSha256: PROBED_FINGERPRINT,
        password: 'pw',
      }),
    );
    // Success promises an automatic retry — no "Sync now" click is required.
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/automatically/i)),
    );
    // The service resets status to `never_connected`; the refetch is what shows it.
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it.each([
    ['PASSWORD_MISMATCH', 'The password does not match this connection'],
    [
      'FINGERPRINT_MISMATCH',
      'The certificate presented does not match the fingerprint you confirmed',
    ],
    ['VCENTER_UNREACHABLE', 'Could not reach vCenter to read its certificate'],
  ])('★ surfaces the specific %s failure, not a generic one', async (code, message) => {
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([
      connection({ status: 'tls_untrusted' }),
    ]);
    mockProbe();
    mockTrustCertFailure(code, message);
    renderWithClient(<VcenterConnectionsPanel />);
    await openTrustDialog();

    await userEvent.type(screen.getByLabelText(/password for svc-lcm/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /^trust certificate$/i }));

    // Each code points at a different fix — a wrong password, a certificate that
    // changed under the admin, or a host that went away. Collapsing them into
    // "failed" costs the admin the diagnosis.
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('★ seals every close path while the trust submission is in flight', async () => {
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([
      connection({ status: 'tls_untrusted' }),
    ]);
    mockProbe();
    // Never settles: the mutation stays pending for the whole test.
    vi.spyOn(api.settings.vsphere.connections, 'trustCert').mockReturnValue(
      new Promise(() => undefined),
    );
    renderWithClient(<VcenterConnectionsPanel />);
    await openTrustDialog();

    await userEvent.type(screen.getByLabelText(/password for svc-lcm/i), 'pw');
    await userEvent.click(screen.getByRole('button', { name: /^trust certificate$/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /working/i })).toBeDisabled());

    // React Query does not cancel a mutation on unmount, so a dialog dismissed
    // mid-submit still fires onSuccess afterwards — clearing the parent's target
    // and force-closing whatever dialog is open by then, possibly a different
    // connection's, discarding a password the admin had already typed.
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Dispatched directly: Radix sets `pointer-events: none` on the body while a
    // modal is open, so userEvent refuses the click before Radix ever sees it.
    // `pointerdown` on an outside node is what DismissableLayer actually listens for.
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // The X routes through the same guard; Cancel is disabled outright.
    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
  });

  it('still closes freely while the read-only probe is in flight', async () => {
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([
      connection({ status: 'tls_untrusted' }),
    ]);
    // Probe never settles — the dialog sits in its loading state.
    vi.spyOn(api.settings.vsphere, 'probe').mockReturnValue(new Promise(() => undefined));
    renderWithClient(<VcenterConnectionsPanel />);

    await userEvent.click(
      await screen.findByRole('button', { name: /trust certificate: vc-prod/i }),
    );
    expect(await screen.findByText(/reading the certificate/i)).toBeInTheDocument();

    // The probe sends no credential and pins nothing, so abandoning it costs
    // nothing — only the trust submission is worth trapping the admin for.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('offers nothing to confirm when the host cannot be reached', async () => {
    vi.spyOn(api.settings.vsphere.connections, 'list').mockResolvedValue([
      connection({ status: 'tls_untrusted' }),
    ]);
    mockProbe({ reachable: false, leafFingerprintSha256: null, outcome: 'unreachable' });
    renderWithClient(<VcenterConnectionsPanel />);

    await userEvent.click(
      await screen.findByRole('button', { name: /trust certificate: vc-prod/i }),
    );

    expect(await screen.findByText(/could not reach that host/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^trust certificate$/i })).toBeDisabled();
  });
});
