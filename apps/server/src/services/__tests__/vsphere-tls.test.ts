import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { connect as tlsConnect, createServer, type TlsOptions } from 'node:tls';

import { afterAll, describe, expect, it } from 'vitest';

import type { DetailedPeerCertificate } from 'node:tls';

import { OTHER_CERT_PEM, TEST_CERT_PEM, TEST_KEY_PEM } from './vsphere-tls-fixtures.js';
import {
  describeChain,
  extractTlsErrorCode,
  normalizeFingerprint,
  probeCertificate,
} from '../vsphere-tls.js';

/**
 * Build a fake chain of `DetailedPeerCertificate`s from leaf to terminal.
 *
 * `describeChain` reads only `issuerCertificate`, `subject.CN`, `issuer.CN`, and
 * `fingerprint256`, so a shaped literal exercises the real logic without a real
 * cert. `selfSignedTop` controls the ONE thing #272 turns on: whether the top of
 * the built chain points at itself (a genuine root) or leaves its issuer missing
 * (an incomplete chain, the failure mode).
 */
function fakeChain(cns: string[], selfSignedTop: boolean): DetailedPeerCertificate {
  const nodes = cns.map(
    (name, i) =>
      ({
        subject: { CN: name },
        issuer: { CN: cns[i + 1] ?? (selfSignedTop ? name : `${name}-issuer`) },
        fingerprint256: `FP:${name}`,
      }) as unknown as DetailedPeerCertificate,
  );
  for (let i = 0; i < nodes.length - 1; i += 1) {
    (nodes[i] as { issuerCertificate: unknown }).issuerCertificate = nodes[i + 1];
  }
  const top = nodes[nodes.length - 1]!;
  // A real root self-references; an incomplete chain leaves the issuer missing.
  (top as { issuerCertificate: unknown }).issuerCertificate = selfSignedTop ? top : undefined;
  return nodes[0]!;
}

/**
 * TLS trust behaviour for vCenter connections (#175, epic #172).
 *
 * These assert against a REAL TLS server with a REAL self-signed certificate,
 * because the whole design turns on a behaviour that documentation and intuition
 * both get wrong: `checkServerIdentity` is never invoked when chain verification
 * fails. That is not something a mock can tell you, and shipping the intuitive
 * design would have produced code that reads as pinned while performing no
 * verification at all.
 *
 * @ai-context The certificates come from `vsphere-tls-fixtures.ts` — throwaway
 * self-signed pairs committed as test data. Nothing here is a real key.
 */

const privateKey = TEST_KEY_PEM;
const certificate = TEST_CERT_PEM;

const servers: Array<{ close: () => void }> = [];
afterAll(() => {
  for (const s of servers) s.close();
});

function startServer(options: TlsOptions): Promise<{ port: number }> {
  return new Promise((resolve) => {
    const server = createServer(options, (socket) => socket.end());
    server.listen(0, '127.0.0.1', () => {
      servers.push({ close: () => server.close() });
      resolve({ port: (server.address() as AddressInfo).port });
    });
  });
}

interface HandshakeResult {
  connected: boolean;
  error: string | null;
  checkServerIdentityCalls: number;
}

function handshake(
  port: number,
  opts: { rejectUnauthorized: boolean; ca?: string[] },
): Promise<HandshakeResult> {
  return new Promise((resolve) => {
    let calls = 0;
    const socket = tlsConnect(
      {
        host: '127.0.0.1',
        port,
        servername: 'vcenter.test.local',
        rejectUnauthorized: opts.rejectUnauthorized,
        ...(opts.ca ? { ca: opts.ca } : {}),
        checkServerIdentity: () => {
          calls += 1;
          return undefined; // accept — we only care THAT it ran
        },
      },
      () => {
        socket.destroy();
        resolve({ connected: true, error: null, checkServerIdentityCalls: calls });
      },
    );
    socket.once('error', (err: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve({
        connected: false,
        error: err.code ?? err.message,
        checkServerIdentityCalls: calls,
      });
    });
  });
}

describe('TLS trust — why checkServerIdentity cannot implement pinning', () => {
  it('⚠️ rejectUnauthorized:false CONNECTS and never calls checkServerIdentity', async () => {
    const { port } = await startServer({ key: privateKey, cert: certificate });
    // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
    const r = await handshake(port, { rejectUnauthorized: false });

    // THIS is the finding the whole TLS design rests on. The intuitive design —
    // `rejectUnauthorized: false` plus a thumbprint check inside
    // checkServerIdentity — connects happily while the check NEVER RUNS. The code
    // reads as pinned; it is `curl -k`. It fails open, silently, with green tests.
    expect(r.connected).toBe(true);
    expect(r.checkServerIdentityCalls).toBe(0);
  });

  it('rejectUnauthorized:true against an untrusted cert fails, and still never calls it', async () => {
    const { port } = await startServer({ key: privateKey, cert: certificate });
    const r = await handshake(port, { rejectUnauthorized: true });

    expect(r.connected).toBe(false);
    expect(r.error).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
    // Gated on verifyError being empty — not on rejectUnauthorized. It is a
    // HOSTNAME check that runs AFTER validation, so it is structurally incapable
    // of rescuing a certificate that fails validation, which is precisely and only
    // the case TOFU exists for.
    expect(r.checkServerIdentityCalls).toBe(0);
  });

  it('★ pinning the cert as a ca: anchor CONNECTS and DOES call checkServerIdentity', async () => {
    const { port } = await startServer({ key: privateKey, cert: certificate });
    const r = await handshake(port, { rejectUnauthorized: true, ca: [certificate] });

    // The recommended design: the chain now validates against the pinned anchor,
    // so OpenSSL enforces trust and hostname verification comes back for free.
    // No `rejectUnauthorized: false` anywhere on the credential path.
    expect(r.connected).toBe(true);
    expect(r.checkServerIdentityCalls).toBe(1);
  });

  it('★ pinning the WRONG anchor fails closed — in OpenSSL, not in app code', async () => {
    const { port } = await startServer({ key: privateKey, cert: certificate });
    const r = await handshake(port, { rejectUnauthorized: true, ca: [OTHER_CERT_PEM] });

    // The negative control. There is no app-layer check to forget or refactor
    // away: get the anchor wrong and the handshake simply does not complete.
    expect(r.connected).toBe(false);
  });
});

describe('fingerprints', () => {
  it('normalizes to the uppercase form govc prints, so a paste-comparison matches', () => {
    expect(normalizeFingerprint(' ab:cd:ef ')).toBe('AB:CD:EF');
  });

  it('the generated cert has a readable SHA-256 fingerprint', () => {
    const x509 = new X509Certificate(certificate);
    expect(x509.fingerprint256).toMatch(/^[A-F0-9]{2}(:[A-F0-9]{2}){31}$/);
  });
});

describe('extractTlsErrorCode (#272 diagnostics)', () => {
  it('reads the nested undici/fetch cause.code', () => {
    expect(extractTlsErrorCode({ cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' } })).toBe(
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    );
  });

  it('reads the top-level code on a raw tls/https error', () => {
    expect(extractTlsErrorCode({ code: 'SELF_SIGNED_CERT_IN_CHAIN' })).toBe(
      'SELF_SIGNED_CERT_IN_CHAIN',
    );
  });

  it('prefers the nested cause.code over a top-level one', () => {
    expect(extractTlsErrorCode({ code: 'OUTER', cause: { code: 'INNER' } })).toBe('INNER');
  });

  it('falls through an EMPTY nested cause.code to a real top-level code', () => {
    // `'' ?? x` would have returned the empty string and masked the real code.
    expect(extractTlsErrorCode({ code: 'REAL', cause: { code: '' } })).toBe('REAL');
  });

  it('returns null when there is no code, rather than an empty or bogus string', () => {
    expect(extractTlsErrorCode(new Error('boom'))).toBeNull();
    expect(extractTlsErrorCode({ code: '' })).toBeNull();
    expect(extractTlsErrorCode({ code: 42 })).toBeNull();
    expect(extractTlsErrorCode({ cause: { code: '' } })).toBeNull();
    expect(extractTlsErrorCode(null)).toBeNull();
  });
});

describe('describeChain (#272 diagnostics)', () => {
  it('reports a single self-signed leaf as depth 0, self-signed', () => {
    const d = describeChain(fakeChain(['vcenter.local'], true));
    expect(d).toMatchObject({
      depth: 0,
      terminalSelfSigned: true,
      leafSubjectCn: 'vcenter.local',
      terminalSubjectCn: 'vcenter.local',
    });
  });

  it('reports a full leaf→intermediate→root chain as depth 2, self-signed', () => {
    const d = describeChain(fakeChain(['leaf', 'intermediate', 'root'], true));
    expect(d).toMatchObject({
      depth: 2,
      terminalSelfSigned: true,
      leafSubjectCn: 'leaf',
      terminalSubjectCn: 'root',
    });
  });

  it('flags a leaf-only incomplete chain as NOT self-signed (the #272 smoking gun)', () => {
    // Terminal is the leaf, whose issuer was never presented — the walk stops but
    // the anchor is not a root. This is the state that pins a non-root and makes
    // the credentialed handshake fail later.
    const d = describeChain(fakeChain(['leaf'], false));
    expect(d).toMatchObject({ depth: 0, terminalSelfSigned: false, terminalSubjectCn: 'leaf' });
  });

  it('flags a leaf+intermediate incomplete chain as NOT self-signed', () => {
    const d = describeChain(fakeChain(['leaf', 'intermediate'], false));
    expect(d).toMatchObject({
      depth: 1,
      terminalSelfSigned: false,
      terminalSubjectCn: 'intermediate',
    });
  });

  it('does not mistake a missing issuer for self-signed even when fingerprints are absent', () => {
    const leaf = {
      subject: { CN: 'leaf' },
      issuer: { CN: 'some-ca' },
      // No fingerprint256, no issuerCertificate — the empty-ish shape Node can
      // leave for an unpresented issuer. Must read as incomplete, not self-signed.
      issuerCertificate: undefined,
    } as unknown as DetailedPeerCertificate;
    expect(describeChain(leaf).terminalSelfSigned).toBe(false);
  });

  it('treats the empty-OBJECT issuer Node can leave as incomplete, not self-signed', () => {
    // The other shape Node uses for an unpresented issuer is `{}` (not
    // `undefined`). The walk advances into it once, terminates there, and must
    // still read as incomplete — this is exactly the ambiguity the diagnostic
    // exists to observe, so pin it.
    const leaf = {
      subject: { CN: 'leaf' },
      issuer: { CN: 'some-ca' },
      fingerprint256: 'FP:leaf',
      issuerCertificate: {}, // empty object, no fingerprint, no subject
    } as unknown as DetailedPeerCertificate;
    const d = describeChain(leaf);
    expect(d.terminalSelfSigned).toBe(false);
    expect(d.depth).toBe(1); // advanced into the empty object, then stopped
    expect(d.leafSubjectCn).toBe('leaf');
    expect(d.terminalSubjectCn).toBeNull(); // the empty object has no CN
  });

  it('collapses a multi-valued CN (string[]) to a single string', () => {
    const leaf = {
      subject: { CN: ['primary.local', 'alt.local'] },
      issuer: { CN: 'primary.local' },
      fingerprint256: 'FP',
      issuerCertificate: undefined,
    } as unknown as DetailedPeerCertificate;
    // issuer===undefined so it self-terminates; but fingerprint present and
    // issuer object is missing → not genuinely self-signed.
    expect(describeChain(leaf).leafSubjectCn).toBe('primary.local');
  });
});

describe('probeCertificate dials the configured port (#199)', () => {
  it('captures a certificate from a non-443 port', async () => {
    // Bind to and dial `localhost` (a valid SNI name — an IP is not) on an ephemeral
    // port. If probeCertificate ignored the port and dialed 443, nothing would answer
    // and this would be `unreachable`; a successful capture proves the port argument
    // reaches the socket.
    const port = await new Promise<number>((resolve) => {
      const server = createServer({ key: privateKey, cert: certificate }, (socket) => socket.end());
      server.listen(0, 'localhost', () => {
        servers.push({ close: () => server.close() });
        resolve((server.address() as AddressInfo).port);
      });
    });

    const result = await probeCertificate('localhost', port);

    expect(result.outcome).toBe('ok');
    expect(result.chain?.leafFingerprintSha256).toMatch(/^[A-F0-9]{2}(:[A-F0-9]{2}){31}$/);
    // A real single self-signed cert reads as a genuine self-signed terminal (#272) —
    // the diagnostic evidence logged alongside the leaf we actually pin.
    expect(result.diagnostics).toMatchObject({ depth: 0, terminalSelfSigned: true });
  });
});
