import type { VsphereConnectionResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

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
  username: 'svc-lcm',
  tlsMode: 'pinned',
  pinnedRootFingerprintSha256: null,
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
      rootFingerprintSha256: 'AB:CD',
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
    expect(probe).toHaveBeenCalledWith({ hostname: 'vcenter.corp.local' });
    expect(JSON.stringify(probe.mock.calls)).not.toContain('never-send-me');
  });

  it('shows the fingerprint to confirm — and nothing else about the certificate', async () => {
    vi.spyOn(api.settings.vsphere, 'probe').mockResolvedValue({
      reachable: true,
      trustedBySystemRoots: false,
      rootFingerprintSha256: 'AB:CD:EF:01',
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
      rootFingerprintSha256: 'AB:CD',
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
      rootFingerprintSha256: 'AB:CD:EF:01',
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
