import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * An ephemeral self-signed cert for TLS-server tests. Generated at runtime via
 * openssl (present on CI runners and dev machines) so NO private key is committed —
 * CLAUDE.md forbids committing key material.
 */
export function makeSelfSignedCert(cn = 'localhost'): {
  certPem: string;
  keyPem: string;
  fingerprint256: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'lcm-tls-'));
  try {
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      `/CN=${cn}`,
      '-addext',
      `subjectAltName=DNS:${cn}`,
    ]);
    const certPem = readFileSync(join(dir, 'cert.pem'), 'utf8');
    const keyPem = readFileSync(join(dir, 'key.pem'), 'utf8');
    const fingerprint256 = new X509Certificate(certPem).fingerprint256; // "AB:CD:.."
    return { certPem, keyPem, fingerprint256 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
