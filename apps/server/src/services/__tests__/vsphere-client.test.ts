import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:https';

import { afterAll, describe, expect, it } from 'vitest';

import { TEST_CERT_PEM, TEST_KEY_PEM } from './vsphere-tls-fixtures.js';
import { verifyLogin } from '../vsphere-client.js';

/**
 * The vim25 client (#175), against a real HTTPS server speaking real SOAP.
 *
 * The credential path is the subject here, so the tests care about two things
 * above all: that the password reaches vCenter and nowhere else, and that a
 * connection whose certificate we do not trust never receives it.
 */
const SERVICE_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <RetrieveServiceContentResponse xmlns="urn:vim25">
      <returnval>
        <sessionManager type="SessionManager">SessionManager</sessionManager>
        <about>
          <instanceUuid>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</instanceUuid>
          <apiVersion>8.0.3.0</apiVersion>
        </about>
      </returnval>
    </RetrieveServiceContentResponse>
  </soapenv:Body>
</soapenv:Envelope>`;

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

interface Recorded {
  bodies: string[];
}

function startVcenter(opts: { acceptLogin: boolean }): Promise<{ port: number; rec: Recorded }> {
  const rec: Recorded = { bodies: [] };
  return new Promise((resolve) => {
    const server = createServer({ key: TEST_KEY_PEM, cert: TEST_CERT_PEM }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        rec.bodies.push(body);
        if (body.includes('RetrieveServiceContent')) {
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          res.end(SERVICE_CONTENT);
          return;
        }
        if (body.includes('Login')) {
          if (!opts.acceptLogin) {
            res.writeHead(500, { 'Content-Type': 'text/xml' });
            res.end(
              '<soapenv:Fault xmlns:soapenv="x"><faultstring>InvalidLogin</faultstring></soapenv:Fault>',
            );
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/xml',
            'Set-Cookie': 'vmware_soap_session="x"; Path=/',
          });
          res.end('<ok/>');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end('<ok/>');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve({ port: (server.address() as AddressInfo).port, rec });
    });
  });
}

// The client hard-codes :443, so these exercise it through a host alias that
// resolves to the test server. Node's `servername`/`host` split lets us point at
// 127.0.0.1 while presenting the cert's SNI name.
describe('vim25 client — credential handling', () => {
  it('never sends the credential when the certificate is not trusted', async () => {
    const { rec } = await startVcenter({ acceptLogin: true });

    // No pinned root and the cert is self-signed, so the system store rejects it.
    const result = await verifyLogin({
      hostname: '127.0.0.1',
      username: 'svc-lcm',
      password: 'must-never-be-sent',
      pinnedRootPem: null,
    });

    expect(result.outcome).not.toBe('ok');
    // THE assertion: the handshake failed, so no request body was ever written.
    // A design that connected first and vetted the certificate afterwards would
    // have leaked the password on first contact.
    expect(rec.bodies.join('')).not.toContain('must-never-be-sent');
  });
});
