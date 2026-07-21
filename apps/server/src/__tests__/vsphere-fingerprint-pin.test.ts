import { Buffer } from 'node:buffer';
import { createServer, type Server } from 'node:tls';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { soapCall } from '../services/vsphere-client.js';
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

beforeEach(async () => {
  received = [];
  server = createServer({ cert: certPem, key: keyPem }, (socket) => {
    socket.on('data', (b: Buffer) => received.push(b)); // never answers
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
