import type { Socket } from 'node:net';
import {
  connect as tlsConnect,
  type DetailedPeerCertificate,
  type PeerCertificate,
} from 'node:tls';

/**
 * The default vCenter HTTPS port. Overridable per connection since #199 — the port
 * is a destination only and never relaxes trust (the fingerprint gate in
 * `fingerprintPinnedConnection` runs regardless of port). Still the default for
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
 * the socket is destroyed. Every credential-bearing path MUST instead gate the
 * presented leaf's fingerprint against the stored pin (see
 * `fingerprintPinnedConnection`).
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

    // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
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
 * The credential-path connection factory for a PINNED connection.
 *
 * @ai-warning The ONLY place `rejectUnauthorized: false` is allowed on a
 * credential-bearing path. Safe for one reason: the fingerprint gate runs on
 * `secureConnect` and destroys the socket — and only then hands it to the HTTP
 * layer via `oncreate` — so NO request byte reaches a peer whose leaf != the pin.
 * Do NOT return the socket synchronously: `http` would use it before `secureConnect`
 * and defeat the gate. Do NOT move the check into `checkServerIdentity` — with
 * `rejectUnauthorized: false` it never fires (design D10). The `port` is a
 * destination only (#199) and cannot relax the gate, which runs regardless.
 */
export function fingerprintPinnedConnection(
  hostname: string,
  port: number,
  pinnedSha256: string,
): (options: unknown, oncreate: (err: Error | null, socket: Socket) => void) => Socket {
  // `oncreate`'s socket param is non-optional (`socket: Socket`, a `net.Duplex`) so
  // the factory is assignable to `https` `createConnection`; on the error paths the
  // socket is passed but ignored by `http` (it reads only the error).
  return (_options, oncreate) => {
    // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
    const socket = tlsConnect({
      host: hostname,
      port,
      servername: hostname,
      rejectUnauthorized: false, // gated below — see @ai-warning
      timeout: CONNECT_TIMEOUT_MS,
    });
    socket.once('secureConnect', () => {
      const presented = normalizeFingerprint(socket.getPeerCertificate(false).fingerprint256 ?? '');
      if (!presented || presented !== pinnedSha256) {
        const err = Object.assign(
          new Error('vCenter presented a certificate that does not match the pinned fingerprint'),
          { code: 'CERT_FINGERPRINT_MISMATCH' },
        );
        socket.destroy(err);
        oncreate(err, socket);
        return;
      }
      oncreate(null, socket);
    });
    socket.once('timeout', () => {
      const err = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
      socket.destroy(err);
      oncreate(err, socket);
    });
    socket.once('error', (err) => oncreate(err, socket));
    // @ai-warning Return `undefined`, not the socket: `http` must AWAIT `oncreate`
    // so the fingerprint gate above runs before any request byte is written. A
    // synchronously-returned socket is used immediately and defeats the gate.
    return undefined as unknown as Socket;
  };
}

/** Uppercase colon-separated SHA-256, the form `govc about.cert -thumbprint` prints. */
export function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.trim().toUpperCase();
}

export function fingerprintOf(cert: PeerCertificate): string {
  return normalizeFingerprint(cert.fingerprint256 ?? '');
}
