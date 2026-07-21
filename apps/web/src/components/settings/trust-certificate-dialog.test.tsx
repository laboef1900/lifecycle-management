import type { VsphereConnectionResponse, VsphereProbeResult } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { TrustCertificateDialog } from './trust-certificate-dialog';

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
  pinnedRootFingerprintSha256: null,
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

const chainIncompleteProbe: VsphereProbeResult = {
  reachable: false,
  trustedBySystemRoots: false,
  rootFingerprintSha256: null,
  validFrom: null,
  validTo: null,
  outcome: 'chain_incomplete',
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('<TrustCertificateDialog> — #272 incomplete chain', () => {
  it('shows root-CA guidance and keeps Trust disabled when the chain is incomplete', async () => {
    vi.spyOn(api.settings.vsphere, 'probe').mockResolvedValue(chainIncompleteProbe);

    renderWithClient(
      <TrustCertificateDialog
        connection={connection()}
        onOpenChange={() => {}}
        onTrusted={() => {}}
      />,
    );

    // The distinct, actionable message — not the generic "could not reach" copy.
    expect(await screen.findByText(/did not present its root CA/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not reach that host/i)).not.toBeInTheDocument();

    // No anchor to confirm, so the operator cannot (and must not) pin anything.
    const trust = screen.getByRole('button', { name: /trust certificate/i });
    expect(trust).toBeDisabled();
  });

  it('does not surface the incomplete-chain copy on a normal reachable probe', async () => {
    vi.spyOn(api.settings.vsphere, 'probe').mockResolvedValue({
      reachable: true,
      trustedBySystemRoots: false,
      rootFingerprintSha256:
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
    expect(screen.queryByText(/did not present its root CA/i)).not.toBeInTheDocument();
  });
});
