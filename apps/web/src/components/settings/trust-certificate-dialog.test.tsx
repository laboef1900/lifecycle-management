import type { VsphereConnectionResponse } from '@lcm/shared';
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
});
