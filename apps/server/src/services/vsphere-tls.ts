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
  /** Uppercase colon-separated SHA-256 of the presented LEAF, as `govc about.cert` prints. */
  leafFingerprintSha256: string;
  /** Did the chain already validate against the system trust store? */
  trustedBySystemRoots: boolean;
  validFrom: string | null;
  validTo: string | null;
}

/**
 * A probe/trust-flow value only — never a persisted connection status, so it needs
 * no migration. `tls_untrusted` covers a peer that answered but presented no
 * usable certificate; `unreachable` merges every connection-level failure so the
 * endpoint cannot be used to tell "refused" from "filtered" from "no route".
 */
export type TlsProbeOutcome = 'ok' | 'unreachable' | 'tls_untrusted';

/**
 * Server-log-only description of the chain a probe observed (#272). This is the
 * evidence that tells an incomplete-chain pin (`terminalSelfSigned: false` on an
 * `ok` outcome — a leaf/intermediate pinned as if it were a root) apart from a
 * genuine self-signed anchor.
 *
 * @ai-warning This is DIAGNOSTIC and MUST stay server-side. It carries subject
 * and issuer common names, which the probe route deliberately never returns to a
 * client (only a fingerprint leaves the server, so the endpoint is useless for
 * network enumeration). Log it via pino; never put it in a response body.
 */
export interface ChainDiagnostics {
  /** Number of hops from leaf to the chain's terminal cert (0 = single cert). */
  depth: number;
  /**
   * Did the walk terminate at a self-signed cert? `false` means Node ran out of
   * `issuerCertificate` links before reaching a self-signed anchor — an
   * incomplete chain, which is the #272 root-cause candidate. Pinning that
   * terminal makes the credentialed handshake fail with no self-signed anchor.
   */
  terminalSelfSigned: boolean;
  /** Leaf subject CN, for correlating which cert was presented. */
  leafSubjectCn: string | null;
  /** Terminal cert subject CN. */
  terminalSubjectCn: string | null;
  /** Terminal cert issuer CN — equals the subject CN exactly when self-signed. */
  terminalIssuerCn: string | null;
}

export interface TlsProbeResult {
  outcome: TlsProbeOutcome;
  chain: CapturedChain | null;
  /**
   * Populated whenever a peer certificate was seen (even when the outcome is not
   * `ok`); null only when no certificate was presented. Server-log only — see
   * {@link ChainDiagnostics}.
   */
  diagnostics: ChainDiagnostics | null;
}

/**
 * The walk's stop condition for {@link describeChain}: Node makes a self-signed
 * root's `issuerCertificate` point at itself, and leaves it missing/empty when the
 * issuer was NOT presented (an incomplete chain). BOTH end the walk.
 */
function chainTerminates(cert: DetailedPeerCertificate): boolean {
  const issuer = cert.issuerCertificate;
  return !issuer || issuer === cert || issuer.fingerprint256 === cert.fingerprint256;
}

/**
 * Genuinely self-signed: a REAL self-reference, not merely a missing issuer.
 *
 * This is the distinction {@link chainTerminates} deliberately blurs. A terminal
 * with no issuer (`undefined`, or the empty `{}` Node leaves for an unpresented
 * issuer) terminates the walk but is NOT a self-signed anchor — it is the top of
 * an incomplete chain, the #272 failure. Requiring a matching non-empty
 * fingerprint (or object identity) separates the two.
 */
function isGenuinelySelfSigned(cert: DetailedPeerCertificate): boolean {
  const issuer = cert.issuerCertificate;
  if (!issuer) return false;
  if (issuer === cert) return true;
  return Boolean(cert.fingerprint256) && issuer.fingerprint256 === cert.fingerprint256;
}

/**
 * Read-only description of the presented chain, for the server log (#272).
 *
 * Pure: walks the `issuerCertificate` links from the leaf to the chain's terminal
 * and only reports what it sees — it changes nothing. `terminalSelfSigned` uses the
 * STRICTER {@link isGenuinelySelfSigned} test, so an incomplete chain whose walk
 * merely ran out of issuers reads as `false`, not a spurious `true`. This is
 * diagnostic evidence only: the pin is the presented LEAF, not this terminal.
 */
export function describeChain(leaf: DetailedPeerCertificate): ChainDiagnostics {
  let current = leaf;
  let depth = 0;
  for (; depth < 16; depth += 1) {
    if (chainTerminates(current)) break;
    current = current.issuerCertificate;
  }
  return {
    depth,
    terminalSelfSigned: isGenuinelySelfSigned(current),
    leafSubjectCn: cn(leaf.subject?.CN),
    terminalSubjectCn: cn(current.subject?.CN),
    terminalIssuerCn: cn(current.issuer?.CN),
  };
}

/** A cert RDN's CN is `string | string[]` (multi-valued); collapse to one string. */
function cn(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * The OpenSSL/Node error code behind a failed TLS handshake, or null (#272).
 *
 * Node nests the real reason under `err.cause.code` for `fetch`/undici and
 * exposes it directly as `err.code` for the raw `tls`/`https` paths, so both are
 * checked. This is the single fact that separates the #272 root-cause candidates
 * — `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`/`SELF_SIGNED_CERT_IN_CHAIN` (incomplete
 * chain) vs a fingerprint/expiry mismatch (rotation) — and it is currently read
 * by the classifiers and then discarded, logged nowhere.
 *
 * @ai-warning Returns ONLY the code (a fixed OpenSSL identifier), never the
 * message or stack — a vCenter driver error can carry a credential in its message
 * and must not reach a log line unfiltered.
 */
export function extractTlsErrorCode(err: unknown): string | null {
  // First NON-EMPTY string wins, so an empty nested `cause.code` falls through
  // to a real top-level `code` rather than masking it (`'' ?? x` would return
  // the empty string and stop).
  const nested = (err as { cause?: { code?: unknown } })?.cause?.code;
  const top = (err as { code?: unknown })?.code;
  for (const candidate of [nested, top]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
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
        finish({ outcome: 'tls_untrusted', chain: null, diagnostics: null });
        return;
      }
      // Pin the presented LEAF directly — the exact certificate `govc about.cert
      // -thumbprint` and the vSphere Client display, so the admin compares
      // like-for-like. Pinning the leaf works against a self-signed cert, an
      // incomplete chain (the #272 dead-end that had no root to pin), and a full
      // chain alike; it supersedes the #278 root-walk. `authorized` is the honest
      // answer to "would this have worked without pinning?". `diagnostics` stays
      // server-log-only evidence of the chain shape (#272) — never a response field.
      finish({
        outcome: 'ok',
        chain: {
          leafFingerprintSha256: normalizeFingerprint(detailed.fingerprint256 ?? ''),
          trustedBySystemRoots: socket.authorized,
          validFrom: detailed.valid_from ?? null,
          validTo: detailed.valid_to ?? null,
        },
        diagnostics: describeChain(detailed),
      });
    });

    // Every failure collapses to `unreachable`. Distinguishing refused from
    // filtered from no-route is precisely what makes a scan oracle useful, so the
    // distinction is dropped here and kept in the server log instead.
    socket.once('timeout', () =>
      finish({ outcome: 'unreachable', chain: null, diagnostics: null }),
    );
    socket.once('error', () => finish({ outcome: 'unreachable', chain: null, diagnostics: null }));
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
