import { z } from 'zod';

import { cuid } from './common.js';

/**
 * vCenter connection contracts (#175, epic #172).
 *
 * @ai-warning THE RULE THIS FILE EXISTS TO ENFORCE:
 *
 *   **Stored credentials may only be sent to a destination whose trust material
 *   was written by someone who knew the password. Any mutation to trust material
 *   MUST carry the current password. Reads and probes MUST NOT require it.**
 *
 * Trust material = where credentials go (`hostname`, `username`) + what proves
 * the destination's identity (`tlsMode`, `pinnedCaPem`).
 *
 * Why this is not paranoia: the default auth mode is `disabled`, in which every
 * anonymous caller is an ADMIN principal. The only asymmetry between the real
 * admin and an attacker is knowledge of the vCenter password — so any invariant
 * that must hold in `disabled` mode has to be gated on it. No flow design,
 * signed token, or "the human confirms the thumbprint" step can substitute: the
 * attacker drives the flow too, and there is no human to consult.
 *
 * @ai-warning DO NOT copy `authConfigTestSchema`'s shape (`auth-config.ts`),
 * which lets `clientSecret` be omitted and falls back to the stored one. That is
 * safe ONLY by accident of protocol — OIDC discovery fetches a public document
 * and transmits no secret. **vim25 `Login` transmits the credential.** The same
 * shape here would let an anonymous caller point the server at a host they
 * control and be handed the vCenter service-account password in cleartext.
 */

/** Hostname only — the scheme and port are fixed server-side (https, 443). */
const vcenterHostname = z
  .string()
  .trim()
  .min(1)
  .max(253)
  // No scheme, no userinfo, no path, no port. Rejecting `user@host` here closes
  // the `https://vcenter.corp.local@attacker.example/` parser-differential trick
  // at the contract rather than hoping every parser downstream agrees.
  .regex(/^[a-zA-Z0-9.-]+$/, 'Must be a bare hostname or IP — no scheme, port, userinfo, or path');

/**
 * How the connection proves vCenter's identity. **There are exactly two values
 * and both fail closed. There is no third "off" state, and there must never be.**
 *
 * - `system` — the cert validates against the system trust store (a real CA).
 * - `pinned` — the cert chain's root was confirmed out-of-band by an admin and
 *   is pinned as the only trust anchor.
 *
 * An `insecure` flag would be trust material wearing a convenience flag's
 * clothing: in `disabled` mode a `PATCH {"insecure": true}` sails through any
 * password gate scoped to "credential fields", and the next scheduled poll hands
 * the credential to whoever spoofed DNS — forever, with no attacker interaction
 * with the API. Requested and rejected 2026-07-17; see the design doc §0.1.
 */
export const vsphereTlsModeSchema = z.enum(['system', 'pinned']);
export type VsphereTlsMode = z.infer<typeof vsphereTlsModeSchema>;

export const vsphereConnectionStatusSchema = z.enum([
  'never_connected',
  'active',
  'unreachable',
  'auth_failed',
  'tls_untrusted',
  'cert_mismatch',
  'identity_mismatch',
  'secret_undecryptable',
  'disabled',
]);
export type VsphereConnectionStatus = z.infer<typeof vsphereConnectionStatusSchema>;

/**
 * Creating a connection. The password is **required** — there is no stored
 * credential to fall back to, and inventing a fallback later is the bug this
 * contract is shaped to prevent.
 */
export const vsphereConnectionCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  hostname: vcenterHostname,
  username: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(1000),
  enabled: z.boolean().default(true),
});
export type VsphereConnectionCreate = z.infer<typeof vsphereConnectionCreateSchema>;

/**
 * Updating a connection.
 *
 * @ai-warning `password` is REQUIRED whenever any trust-material field
 * (`hostname`, `username`) is present. That is enforced by the refine below and
 * again server-side — a client cannot opt out. Without it, an anonymous caller in
 * `disabled` mode repoints a saved connection at their own host and simply waits:
 * the next unattended poll delivers the credential. That attack needs no test
 * endpoint at all, which is why protecting only the test endpoint would protect
 * nothing.
 *
 * `displayName`-style fields carry no such requirement: the worst they achieve is
 * confusion, not disclosure.
 */
export const vsphereConnectionUpdateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    hostname: vcenterHostname.optional(),
    username: z.string().trim().min(1).max(255).optional(),
    password: z.string().min(1).max(1000).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' })
  .refine(
    (v) => (v.hostname === undefined && v.username === undefined) || v.password !== undefined,
    {
      message: 'Changing the hostname or username requires re-entering the password',
      path: ['password'],
    },
  );
export type VsphereConnectionUpdate = z.infer<typeof vsphereConnectionUpdateSchema>;

/**
 * PHASE 1 — reachability + certificate capture. **Sends no credential.**
 *
 * Splitting the probe from the login is not merely convenient: it makes "vet the
 * certificate, THEN send the credential" the only expressible order. A merged
 * probe naturally connects and logs in at once — sending the credential to a cert
 * nobody has vetted, on first contact, which is the exact disclosure being
 * designed out.
 */
export const vsphereProbeSchema = z.strictObject({
  hostname: vcenterHostname,
});
export type VsphereProbe = z.infer<typeof vsphereProbeSchema>;

/**
 * What a probe reports back.
 *
 * Deliberately narrow: the SHA-256 fingerprint and validity window, and **not**
 * the certificate's subject, issuer, or SANs. A fingerprint is a hash — useless
 * for enumerating a network, sufficient for the admin to compare against
 * `govc about.cert -thumbprint` or the vSphere Client, which is what they
 * actually do. Returning SANs would turn this endpoint into an internal TLS
 * scanner that discloses hostnames an unauthenticated caller may have no other
 * way to learn.
 */
export interface VsphereProbeResult {
  reachable: boolean;
  /** True when the chain already validates against the system trust store. */
  trustedBySystemRoots: boolean;
  /**
   * SHA-256 of the chain's ROOT — the anchor to pin, not the leaf.
   *
   * The leaf is the wrong thing to pin: vCenter auto-renews its Machine SSL
   * certificate unattended (~2 years by default), so a leaf pin breaks by itself,
   * on a timer, with nobody to explain why — and admins learn to click through
   * mismatches, which is how pinning dies. The VMCA root changes only when a human
   * deliberately regenerates it, which is exactly when re-confirmation is wanted.
   */
  rootFingerprintSha256: string | null;
  validFrom: string | null;
  validTo: string | null;
  /**
   * Coarse by design. Full detail goes to the server log, correlated by request
   * id. `unreachable` merges connection-refused, timed-out, and no-route so the
   * endpoint cannot be used to tell "port closed" from "filtered" from "no route"
   * — the distinctions that make a scan oracle useful.
   */
  outcome: 'ok' | 'unreachable' | 'tls_untrusted' | 'not_a_vcenter';
}

/**
 * PHASE 2 — verify the credential actually logs in.
 *
 * @ai-warning `password` is `.min(1)` and NOT `.optional()`. There is no
 * `?? stored` fallback and there must never be one. See the file header.
 */
export const vsphereVerifySchema = z.strictObject({
  hostname: vcenterHostname,
  username: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(1000),
});
export type VsphereVerify = z.infer<typeof vsphereVerifySchema>;

export interface VsphereVerifyResult {
  outcome: 'ok' | 'unreachable' | 'tls_untrusted' | 'not_a_vcenter' | 'auth_failed';
  /** vCenter's own instance id, when the login succeeded. */
  instanceUuid: string | null;
  apiVersion: string | null;
}

/**
 * Pin a certificate root as this connection's trust anchor (TOFU).
 *
 * Requires the password because it mutates **trust material**: re-pinning to an
 * attacker's root plus a DNS spoof delivers the credential on the next poll. The
 * bar is lower than it looks — self-service internal DNS is common, and needs no
 * network position at all.
 */
export const vsphereTrustCaSchema = z.strictObject({
  /** Echoed back from the probe, so the admin confirms what the server saw. */
  rootFingerprintSha256: z
    .string()
    .regex(/^[A-F0-9]{2}(:[A-F0-9]{2}){31}$/i, 'Expected a SHA-256 fingerprint'),
  password: z.string().min(1).max(1000),
});
export type VsphereTrustCa = z.infer<typeof vsphereTrustCaSchema>;

export const vsphereConnectionIdParamsSchema = z.object({ id: cuid });

/**
 * A connection as served to clients.
 *
 * @ai-warning There is no `password` field and there must never be one — not even
 * redacted or masked. The encrypted secret never leaves the server, and a
 * "password: '••••'" field is the first step towards someone rendering the real
 * one.
 */
export interface VsphereConnectionResponse {
  id: string;
  name: string;
  hostname: string;
  username: string;
  tlsMode: VsphereTlsMode;
  /** Fingerprint of the pinned root, for display. Public data — never a secret. */
  pinnedRootFingerprintSha256: string | null;
  instanceUuid: string | null;
  apiVersion: string | null;
  enabled: boolean;
  status: VsphereConnectionStatus;
  /** Sanitized. Never carries a secret, a raw driver error, or a stack. */
  lastError: string | null;
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
