import { describe, expect, it } from 'vitest';

import type { TlsProbeResult } from '../services/vsphere-tls.js';

import { toProbeResponse, trustReprobeError } from '../routes/settings-vsphere.js';

/**
 * #272 Part A — the pure route mappers, unit-tested without a server or a mock.
 *
 * The `settings-vsphere-routes` suite proves the password gate at the HTTP layer;
 * these prove the certificate-outcome mapping the #272 fix added, which cannot be
 * driven end-to-end because `guardTarget` refuses the loopback address an
 * in-process TLS server would bind to.
 */

const diagnostics = {
  depth: 1,
  terminalSelfSigned: false,
  leafSubjectCn: 'vcenter.corp.local',
  terminalSubjectCn: 'Corp Intermediate CA',
  terminalIssuerCn: 'Corp Root CA',
};

describe('toProbeResponse (#272)', () => {
  it('passes chain_incomplete through — NOT collapsed into tls_untrusted', () => {
    const r = toProbeResponse({ outcome: 'chain_incomplete', chain: null, diagnostics });
    expect(r.outcome).toBe('chain_incomplete');
    expect(r.reachable).toBe(false);
    // No anchor was pinned, so no fingerprint leaves the server.
    expect(r.rootFingerprintSha256).toBeNull();
  });

  it('passes unreachable through', () => {
    const r = toProbeResponse({ outcome: 'unreachable', chain: null, diagnostics: null });
    expect(r.outcome).toBe('unreachable');
    expect(r.reachable).toBe(false);
  });

  it('collapses tls_untrusted into tls_untrusted', () => {
    const r = toProbeResponse({ outcome: 'tls_untrusted', chain: null, diagnostics: null });
    expect(r.outcome).toBe('tls_untrusted');
  });

  it('maps an ok probe to reachable with only the fingerprint and validity', () => {
    const result: TlsProbeResult = {
      outcome: 'ok',
      chain: {
        rootPem: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
        rootFingerprintSha256: 'AB:CD',
        trustedBySystemRoots: true,
        validFrom: 'Jul 1 2026',
        validTo: 'Jul 1 2028',
      },
      diagnostics: { ...diagnostics, terminalSelfSigned: true },
    };
    expect(toProbeResponse(result)).toEqual({
      reachable: true,
      trustedBySystemRoots: true,
      rootFingerprintSha256: 'AB:CD',
      validFrom: 'Jul 1 2026',
      validTo: 'Jul 1 2028',
      outcome: 'ok',
    });
  });
});

describe('trustReprobeError (#272)', () => {
  it('returns null when the re-probe pinned a genuine anchor', () => {
    expect(trustReprobeError('ok')).toBeNull();
  });

  it('reports chain_incomplete distinctly as CHAIN_INCOMPLETE', () => {
    const err = trustReprobeError('chain_incomplete');
    expect(err?.code).toBe('CHAIN_INCOMPLETE');
    expect(err?.message).toMatch(/did not present its root CA/i);
  });

  it('keeps every other non-ok outcome as VCENTER_UNREACHABLE (fail closed)', () => {
    expect(trustReprobeError('unreachable')?.code).toBe('VCENTER_UNREACHABLE');
    expect(trustReprobeError('tls_untrusted')?.code).toBe('VCENTER_UNREACHABLE');
  });
});
