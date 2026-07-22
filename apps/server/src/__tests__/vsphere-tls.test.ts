import { createServer, type Server } from 'node:tls';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { probeCertificate } from '../services/vsphere-tls.js';
import { makeSelfSignedCert } from './support/self-signed-cert.js';

const { certPem, keyPem, fingerprint256 } = makeSelfSignedCert();
let server: Server;
let port: number;

beforeEach(async () => {
  server = createServer({ cert: certPem, key: keyPem }, (socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'object' && addr) port = addr.port;
});
afterEach(() => server.close());

it('captures the presented LEAF fingerprint (self-signed vCenter pins successfully)', async () => {
  // Dial `localhost`, never the bind IP: Node refuses an IP literal as the TLS SNI
  // servername, and the ephemeral cert is issued for CN/SAN=localhost.
  const result = await probeCertificate('localhost', port);
  expect(result.outcome).toBe('ok');
  expect(result.chain?.leafFingerprintSha256).toBe(fingerprint256);
  expect(result.chain?.trustedBySystemRoots).toBe(false);
});
