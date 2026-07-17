import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { connect as tlsConnect, createServer, type TlsOptions } from 'node:tls';

import { afterAll, describe, expect, it } from 'vitest';

import { OTHER_CERT_PEM, TEST_CERT_PEM, TEST_KEY_PEM } from './vsphere-tls-fixtures.js';
import { normalizeFingerprint, verifiedTlsOptions } from '../vsphere-tls.js';

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

describe('verifiedTlsOptions — the credential-bearing path', () => {
  it('always demands verification and never exposes an insecure branch', () => {
    const pinned = verifiedTlsOptions(
      'vcenter.corp.local',
      '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
    );
    expect(pinned.rejectUnauthorized).toBe(true);
    expect(pinned.ca).toHaveLength(1);

    const system = verifiedTlsOptions('vcenter.corp.local', null);
    expect(system.rejectUnauthorized).toBe(true);
    // No pin: fall back to the system trust store, still verifying. There is no
    // third state — with verification off, the stored hostname would identify a
    // name rather than a host, and the credential would go to whoever spoofed DNS
    // on every scheduled poll.
    expect(system.ca).toBeUndefined();
  });

  it('pins SNI to the configured hostname', () => {
    expect(verifiedTlsOptions('vcenter.corp.local', null).servername).toBe('vcenter.corp.local');
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
