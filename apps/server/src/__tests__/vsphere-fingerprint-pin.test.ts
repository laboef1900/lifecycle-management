import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:tls';
import type { VsphereSyncResult } from '@lcm/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { soapCall } from '../services/vsphere-client.js';
import type { CollectedInventory } from '../services/vsphere-inventory.js';
import { VsphereJobRunner, type JobRunnerServices } from '../services/vsphere-job-runner.js';
import type { DueState } from '../services/vsphere-scheduler.js';
import { makeVsphereConnection } from './factories.js';
import { prisma } from './setup.js';
import { makeSelfSignedCert } from './support/self-signed-cert.js';

/**
 * The security linchpin (#272 leaf-pinning). Proves — against a REAL TLS server —
 * that a credential-bearing `soapCall` writes ZERO bytes when the presented leaf's
 * SHA-256 does not match the pin. The server records every byte it receives and
 * never answers, so the only thing asserted is what crossed the socket. Dial
 * `localhost` (a valid SNI name; Node forbids an IP literal as `servername`) while
 * the server binds `127.0.0.1`, matching the probe test's convention.
 */
const { certPem, keyPem, fingerprint256 } = makeSelfSignedCert();
let server: Server;
let port: number;
let received: Buffer[];
let connectionsSeen: number;

beforeEach(async () => {
  received = [];
  connectionsSeen = 0;
  server = createServer({ cert: certPem, key: keyPem }, (socket) => {
    socket.on('data', (b: Buffer) => received.push(b)); // never answers
  });
  server.on('connection', () => {
    connectionsSeen += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'object' && addr) port = addr.port;
});
afterEach(() => server.close());

const WRONG = Array.from({ length: 32 }, () => 'AA').join(':');

it('writes ZERO bytes when the leaf fingerprint does not match', async () => {
  await expect(
    soapCall('localhost', WRONG, 'Login', '<secret-credential/>', null, { port }),
  ).rejects.toMatchObject({ code: 'CERT_FINGERPRINT_MISMATCH' });
  expect(Buffer.concat(received)).toHaveLength(0);
});

it('sends the request when the leaf fingerprint matches', async () => {
  await soapCall('localhost', fingerprint256, 'RetrieveServiceContent', '<hello/>', null, {
    port,
  }).catch(() => undefined); // no response arrives; we only assert what we received
  expect(Buffer.concat(received).toString('utf8')).toContain('<hello/>');
});

/**
 * #279 — the UNATTENDED path fails closed on an unestablished (null) leaf pin.
 *
 * The #272 tests above prove the credential-path gate for a NON-null pin. This block
 * proves the gap #279 closes: a `pinned`-mode connection whose leaf fingerprint was
 * never established (`tlsPinnedSha256 IS NULL` — the state a fresh `create()`, a
 * hostname re-point, or the `20260721183652` leaf-pinning migration leaves behind)
 * MUST NOT transmit the stored service-account credential to a system-trusted peer on
 * the scheduler/job-runner path. Owner decision (2026-07-22): pin-only, fail closed.
 */
describe('#279 — unattended path fails closed on a null pin', () => {
  const KEY = randomBytes(32);
  const made: string[] = [];
  const ALL_DUE: DueState = { poll: true, sync: true, snapshot: true };

  afterEach(async () => {
    if (made.length) {
      await prisma.vsphereConnection.deleteMany({ where: { id: { in: made.splice(0) } } });
    }
  });

  /**
   * A "credential sink": every vCenter-facing service records that it was reached, so
   * a single non-empty entry proves the stored password crossed a service boundary on
   * its way to a peer. With the fail-closed gate, nothing here is ever called — the
   * password is never even decrypted.
   */
  function sinkServices(transmitted: string[]): JobRunnerServices {
    const inventory: CollectedInventory = {
      instanceUuid: 'uuid-a',
      apiVersion: '8.0',
      clusters: [],
    };
    return {
      connections: {
        revealPassword: async () => {
          transmitted.push('revealPassword');
          return 'super-secret-password';
        },
      },
      sync: {
        syncConnection: async (_t, connectionId, credentials): Promise<VsphereSyncResult> => {
          transmitted.push(`sync:${credentials.password}`);
          return {
            connectionId,
            outcome: 'ok',
            error: null,
            clustersCreated: 0,
            clustersUpdated: 0,
            clustersMissing: 0,
            hostsCreated: 0,
            hostsUpdated: 0,
            hostsMissing: 0,
          };
        },
      },
      snapshot: {
        runSnapshot: async (_t, _id, credentials) => {
          transmitted.push(`snapshot:${credentials.password}`);
          return {
            syncOutcome: 'ok',
            syncError: null,
            snapshotPeriod: null,
            clustersSnapshotted: 0,
          };
        },
      },
      liveUsage: { record: async () => 0 },
      collector: {
        collect: async (credentials) => {
          transmitted.push(`collect:${credentials.password}`);
          return inventory;
        },
      },
    };
  }

  it('never decrypts or transmits the credential, and surfaces tls_untrusted', async () => {
    // An established, enabled connection whose leaf pin is null — the exact state the
    // leaf-pinning migration leaves behind. `tlsPinnedSha256` defaults to null.
    const { id } = await makeVsphereConnection(prisma, {
      key: KEY,
      name: 'pin279-unattended',
      enabled: true,
      lastConnectedAt: new Date('2026-07-01T00:00:00Z'),
    });
    made.push(id);

    const transmitted: string[] = [];
    const runner = new VsphereJobRunner({
      prisma,
      isUnderPressure: () => false,
      ...sinkServices(transmitted),
    });
    const report = await runner.run(
      id,
      new Date('2026-08-01T00:00:00Z'),
      ALL_DUE,
      new AbortController().signal,
    );

    // The credential never crossed a service boundary — it was never even decrypted.
    expect(transmitted).toEqual([]);
    // Fail-closed report: a skip, not a false success and not a backoff storm.
    expect(report.sync.outcome).toBe('skipped');
    expect(report.errorMessage).toBeNull();
    // Surfaced clearly for the operator, non-destructively (the pin stays null).
    const conn = await prisma.vsphereConnection.findUniqueOrThrow({ where: { id } });
    expect(conn.status).toBe('tls_untrusted');
    expect(conn.tlsPinnedSha256).toBeNull();
  });

  it('leaves the operator verify path (soapCall with a null pin) able to reach the peer', async () => {
    // The gate lives at job selection, NOT in soapCall. The operator verify route
    // calls soapCall with a null pin on purpose to establish the pin, so soapCall must
    // still open the connection to the peer. Against this self-signed stub the system
    // trust store rejects the handshake — but the attempt reaches the peer, proving the
    // null-pin path is not globally blocked at the soapCall layer.
    await soapCall('localhost', null, 'RetrieveServiceContent', '<hello/>', null, {
      port,
    }).catch(() => undefined);
    expect(connectionsSeen).toBeGreaterThan(0);
  });
});
