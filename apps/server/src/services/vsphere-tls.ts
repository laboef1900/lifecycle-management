import {
  connect as tlsConnect,
  type DetailedPeerCertificate,
  type PeerCertificate,
} from 'node:tls';

/**
 * The default vCenter HTTPS port. Overridable per connection since #199 — the port
 * is a destination only and never relaxes trust (`verifiedTlsOptions` keeps
 * `rejectUnauthorized: true` and the `ca:` pin regardless). Still the default for
 * the schema column, the shared `.default(443)`, and the params below.
 */
export const VCENTER_PORT = 443;

const CONNECT_TIMEOUT_MS = 10_000;

export interface CapturedChain {
  /** PEM of the chain's ROOT — the anchor to pin. */
  rootPem: string;
  /** Uppercase colon-separated SHA-256 of the root, as `govc about.cert` prints it. */
  rootFingerprintSha256: string;
  /** Did the chain already validate against the system trust store? */
  trustedBySystemRoots: boolean;
  validFrom: string | null;
  validTo: string | null;
}

export type TlsProbeOutcome = 'ok' | 'unreachable' | 'tls_untrusted';

export interface TlsProbeResult {
  outcome: TlsProbeOutcome;
  chain: CapturedChain | null;
}

function derToPem(der: Buffer): string {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}${b64.endsWith('\n') ? '' : '\n'}-----END CERTIFICATE-----\n`;
}

/**
 * Walk `issuerCertificate` to the chain's root.
 *
 * Node terminates the chain by making the root's `issuerCertificate` point at
 * itself, so the self-reference is the stop condition — not a bug. The depth cap
 * is belt-and-braces against a malformed chain that never self-references.
 */
function rootOf(leaf: DetailedPeerCertificate): DetailedPeerCertificate {
  let current = leaf;
  for (let depth = 0; depth < 16; depth += 1) {
    const issuer = current.issuerCertificate;
    if (!issuer || issuer === current || issuer.fingerprint256 === current.fingerprint256) break;
    current = issuer;
  }
  return current;
}

/**
 * PHASE 1 — capture the certificate chain WITHOUT sending a credential.
 *
 * @ai-warning This is the ONLY place `rejectUnauthorized: false` is permitted in
 * this codebase, and it is safe here for exactly one reason: **nothing is sent.**
 * No credential, no request body — the socket is opened, the chain is read, and
 * the socket is destroyed. Every credential-bearing path MUST instead use
 * `ca: [pinnedRootPem]` with `rejectUnauthorized: true` (see `verifiedTlsOptions`).
 *
 * @ai-warning Do NOT "improve" this by moving the trust check into
 * `checkServerIdentity`. That callback fires **only when OpenSSL chain
 * verification SUCCEEDS** — it is gated on `verifyError` being empty, not on
 * `rejectUnauthorized`. Measured on Node 26.5.0: against an untrusted certificate
 * with `rejectUnauthorized: false`, it is invoked **zero** times while the
 * connection proceeds. A thumbprint check placed there never runs, and every
 * connection silently succeeds against any certificate — code that reads as
 * pinned but is `curl -k`, with green tests. (govmomi does do TOFU in
 * `checkServerIdentity`'s Go equivalent, `VerifyPeerCertificate`, which DOES run
 * on verification failure. Node has no equivalent. The model does not port.)
 */
export async function probeCertificate(
  hostname: string,
  port: number = VCENTER_PORT,
): Promise<TlsProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: TlsProbeResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const socket = tlsConnect({
      host: hostname,
      port,
      servername: hostname,
      // Safe ONLY because this path sends nothing. See the @ai-warning above.
      rejectUnauthorized: false,
      timeout: CONNECT_TIMEOUT_MS,
    });

    socket.once('secureConnect', () => {
      const detailed = socket.getPeerCertificate(true);
      if (!detailed || Object.keys(detailed).length === 0) {
        finish({ outcome: 'tls_untrusted', chain: null });
        return;
      }
      const root = rootOf(detailed);
      finish({
        outcome: 'ok',
        chain: {
          rootPem: root.raw ? derToPem(root.raw) : '',
          rootFingerprintSha256: (root.fingerprint256 ?? '').toUpperCase(),
          // `authorized` is the honest answer to "would this have worked without
          // pinning?" — i.e. whether the operator needs the TOFU step at all.
          trustedBySystemRoots: socket.authorized,
          validFrom: detailed.valid_from ?? null,
          validTo: detailed.valid_to ?? null,
        },
      });
    });

    // Every failure collapses to `unreachable`. Distinguishing refused from
    // filtered from no-route is precisely what makes a scan oracle useful, so the
    // distinction is dropped here and kept in the server log instead.
    socket.once('timeout', () => finish({ outcome: 'unreachable', chain: null }));
    socket.once('error', () => finish({ outcome: 'unreachable', chain: null }));
  });
}

/**
 * TLS options for every credential-bearing connection.
 *
 * @ai-warning There is no insecure branch here, and there must never be one. With
 * verification off, the stored hostname identifies a *name*, not a *host* —
 * anyone able to spoof DNS or sit on the path harvests the vCenter
 * service-account password on **every scheduled poll**, on the happy path, with
 * no anomaly to detect and no interaction with our API.
 *
 * Pin the chain's ROOT as a `ca:` anchor rather than checking a leaf thumbprint
 * in application code:
 *   - it fails closed **in OpenSSL**, so there is no app-layer check to forget,
 *     skip, or refactor away;
 *   - hostname verification comes back for free, because the chain now validates,
 *     so the binding is "a cert for THIS host, issued by THIS CA" rather than a
 *     bare fingerprint;
 *   - it survives vCenter's unattended leaf auto-renewal (~2 years), whereas a
 *     leaf pin breaks by itself on a timer and trains admins to click through
 *     mismatches — which is how pinning dies in practice.
 *
 * @ai-warning Pinning the LEAF via `ca:` does not work against a chain-presenting
 * server: OpenSSL must terminate at a self-signed anchor it trusts, and a trusted
 * leaf mid-chain does not terminate it (`SELF_SIGNED_CERT_IN_CHAIN`; Node does not
 * expose `X509_V_FLAG_PARTIAL_CHAIN`). An implementer who tries `ca: [leafPem]`
 * will watch it fail against real vCenter and be tempted to "fix" it with
 * `rejectUnauthorized: false`. Pin the root.
 */
export function verifiedTlsOptions(
  hostname: string,
  pinnedRootPem: string | null,
  port: number = VCENTER_PORT,
): { host: string; port: number; servername: string; rejectUnauthorized: true; ca?: string[] } {
  // @ai-warning `port` is configurable per connection (#199), defaulting to 443. It
  // changes the destination socket ONLY: `rejectUnauthorized: true` and the `ca:`
  // root pin are unaffected, so no port value can relax trust. This is why widening
  // the port range is safe — the pin, not the port, is the gate.
  return {
    host: hostname,
    port,
    servername: hostname,
    rejectUnauthorized: true,
    ...(pinnedRootPem ? { ca: [pinnedRootPem] } : {}),
  };
}

/** Uppercase colon-separated SHA-256, the form `govc about.cert -thumbprint` prints. */
export function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.trim().toUpperCase();
}

export function fingerprintOf(cert: PeerCertificate): string {
  return normalizeFingerprint(cert.fingerprint256 ?? '');
}
