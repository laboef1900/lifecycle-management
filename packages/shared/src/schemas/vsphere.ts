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
 * Trust material = where credentials go (`hostname`, `port`, `username`) + what
 * proves the destination's identity (`tlsMode`, `pinnedCaPem`).
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

/**
 * Hostname only — the scheme is fixed server-side (https) and the port lives in
 * its own `port` field (#199). The regex still rejects an inline `host:port`.
 */
const vcenterHostname = z
  .string()
  .trim()
  .min(1)
  .max(253)
  // No scheme, no userinfo, no path, no port. Rejecting `user@host` here closes
  // the `https://vcenter.corp.local@attacker.example/` parser-differential trick
  // at the contract rather than hoping every parser downstream agrees. The port is
  // a separate field, so `host:8443` must still be rejected here.
  .regex(/^[a-zA-Z0-9.-]+$/, 'Must be a bare hostname or IP — no scheme, port, userinfo, or path');

/**
 * vCenter's HTTPS port. Full 1-65535 range is allowed (#199) — TOFU root-pinning,
 * not a port allow-list, is the trust gate; the port only changes the destination
 * socket, never whether the certificate is verified. It IS trust material: a port
 * repoints where the credential is sent, so changing it requires the password.
 */
const vcenterPort = z.number().int().min(1).max(65535);

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
  port: vcenterPort.default(443),
  username: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(1000),
  enabled: z.boolean().default(true),
});
export type VsphereConnectionCreate = z.infer<typeof vsphereConnectionCreateSchema>;

/**
 * Updating a connection.
 *
 * @ai-warning `password` is REQUIRED whenever any trust-material field
 * (`hostname`, `port`, `username`) is present. That is enforced by the refine below
 * and again server-side — a client cannot opt out. Without it, an anonymous caller
 * in `disabled` mode repoints a saved connection at their own host (or port) and
 * simply waits: the next unattended poll delivers the credential. That attack needs
 * no test endpoint at all, which is why protecting only the test endpoint would
 * protect nothing.
 *
 * `displayName`-style fields carry no such requirement: the worst they achieve is
 * confusion, not disclosure.
 */
export const vsphereConnectionUpdateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    hostname: vcenterHostname.optional(),
    port: vcenterPort.optional(),
    username: z.string().trim().min(1).max(255).optional(),
    password: z.string().min(1).max(1000).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' })
  .refine(
    (v) =>
      (v.hostname === undefined && v.username === undefined && v.port === undefined) ||
      v.password !== undefined,
    {
      message: 'Changing the hostname, port, or username requires re-entering the password',
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
  port: vcenterPort.default(443),
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
   *
   * `chain_incomplete` (#272) is distinct from `tls_untrusted` on purpose: vCenter
   * WAS reachable and presented a certificate, but its chain does not terminate at
   * a self-signed root we can pin (leaf-only, or leaf+intermediate with the root
   * withheld). The fix is on the vCenter side (add the issuing/root CA to its
   * chain), so the operator needs that specific guidance, not a generic failure.
   * It carries no subject/issuer/SAN — only the outcome — so it discloses nothing
   * a fingerprint would not.
   */
  outcome: 'ok' | 'unreachable' | 'tls_untrusted' | 'not_a_vcenter' | 'chain_incomplete';
}

/**
 * PHASE 2 — verify the credential actually logs in.
 *
 * @ai-warning `password` is `.min(1)` and NOT `.optional()`. There is no
 * `?? stored` fallback and there must never be one. See the file header.
 */
export const vsphereVerifySchema = z.strictObject({
  hostname: vcenterHostname,
  port: vcenterPort.default(443),
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
 * The response to `POST /settings/vsphere/connections/:id/sync` — the admin
 * **"Sync now"** action (#192, design §D22).
 *
 * **202 Accepted, never 200.** The sync is *queued*, not performed: the handler
 * sets the connection's scheduler job `dueAt = now()` and returns immediately, and
 * the scheduler's next tick claims and runs it through the **identical** claim/run
 * path as a scheduled job. A request handler must never await vCenter — see D25.
 *
 * `dueAt` echoes the moment the job became due so the UI can say "queued, runs
 * within a minute" without a refetch race, and so the endpoint has a deterministic,
 * disclose-nothing return value (it is derived server-side, carries no secret, and
 * reveals nothing an admin could not already see).
 */
export interface VsphereSyncNowResponse {
  dueAt: string;
}

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
  /** vCenter's HTTPS port; 443 unless configured otherwise (#199). */
  port: number;
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
  /**
   * The connection's scheduler job row (`VsphereConnectionJob`).
   *
   * `null` = no job row exists yet — it is created on connection create/enable
   * (#191). Absent = this server build predates the field. A nested object
   * rather than six flat fields precisely because the job is a SEPARATE row that
   * may not exist (`connectionId` is both PK and FK): one `null` says "no job
   * row" in one place, where six independent nulls could not distinguish that
   * from "job row that has never run".
   *
   * @ai-warning Distinct from this object's own `lastError`/`lastConnectedAt`,
   * which are connection status — "can we reach it?" — not job outcome. A
   * connection can be reachable while its last sync skipped.
   *
   * @ai-warning These columns have NO writer as of this contract landing;
   * #191 owns `onSuccess`/`onFailure` in `vsphere-scheduler.ts`. Until it lands,
   * every field here is legitimately null.
   */
  syncState?: {
    lastSyncAt: string | null;
    lastSyncStatus: VsphereSyncOutcome | null;
    lastSnapshotAt: string | null;
    lastSnapshotStatus: string | null;
    /** The last month successfully snapshotted, as a date-only string. */
    lastSuccessPeriod: string | null;
    /** Consecutive failures; drives the scheduler's capped backoff. */
    failureCount: number;
  } | null;
}

// ---------- Inventory sync (#176) ----------

/**
 * Where a cluster or host came from.
 *
 * @ai-warning `manual` is the default and must stay so: it is what makes the
 * migration additive and what lets hand-maintained clusters keep working
 * untouched alongside synced ones. Manual entities are fully editable; synced
 * entities reject edits to sync-owned fields (host membership, memory capacity)
 * but keep their label, description, thresholds and lifecycle metadata
 * operator-owned.
 */
export const entitySourceSchema = z.enum(['manual', 'vsphere']);
export type EntitySource = z.infer<typeof entitySourceSchema>;

/**
 * How one sync run ended.
 *
 * @ai-warning `skipped` is not a failure and must not be rendered as one — it is
 * how the identity guard reports "this hostname now answers as a DIFFERENT
 * vCenter, so I refused to touch anything." That refusal is the feature.
 *
 * @ai-warning This vocabulary must NOT be narrowed to `'ok' | 'failed'`. Two
 * values cannot express `skipped`, so the guard working correctly would have to
 * be rendered as an error — the exact thing the warning above forbids.
 *
 * Also the runtime validator for `VsphereConnectionJob.lastSyncStatus`, which
 * Prisma stores as an untyped `String?` with no enum behind it. Without this
 * schema an unconstrained string reaches the client.
 */
export const vsphereSyncOutcomeSchema = z.enum([
  'ok',
  'unreachable',
  'auth_failed',
  'tls_untrusted',
  'identity_mismatch',
  'skipped',
]);
export type VsphereSyncOutcome = z.infer<typeof vsphereSyncOutcomeSchema>;

/** What one sync run did, per connection. */
export interface VsphereSyncResult {
  connectionId: string;
  outcome: VsphereSyncOutcome;
  clustersCreated: number;
  clustersUpdated: number;
  clustersMissing: number;
  hostsCreated: number;
  hostsUpdated: number;
  hostsMissing: number;
  /** Sanitized. Never secret-bearing, never a raw driver error. */
  error: string | null;
}

// ---------- Live usage (#179) ----------

/**
 * Why a live reading is not fresh.
 *
 * @ai-context Each of these is actionable and distinct — `disabled` is an operator
 * choice, `identity_mismatch` needs a re-adopt, `auth_failed` needs a credential.
 * Collapsing them into a single "stale" flag would tell the operator that
 * something is wrong but not what to do about it.
 */
export const liveUsageStaleReasonSchema = z.enum([
  'unreachable',
  'auth_failed',
  'tls_untrusted',
  'identity_mismatch',
  'disabled',
]);
export type LiveUsageStaleReason = z.infer<typeof liveUsageStaleReasonSchema>;

/**
 * Live memory usage for one cluster.
 *
 * @ai-warning A DISCRIMINATED UNION, and it must stay one. `never_fetched` is
 * **structurally incapable** of carrying numbers — that is the entire point, not a
 * modelling nicety.
 *
 * The bug this designs out: a `{ values, isStale }` shape lets a consumer render
 * `0 / 0` as **"0% utilized"** when the truth is "we have no idea". In a tool whose
 * output buys hardware, **"0% used" is the most dangerous possible wrong answer** —
 * it is indistinguishable from "healthy, plenty of headroom" and it is the state in
 * which nobody orders anything. Making the numbers unreachable in that state means
 * the mistake cannot be written.
 *
 * Same failure mode as the zero-capacity fail-open closed in #177 (Q9d), for the
 * same reason: a confidently wrong number beats an honest "unknown" only until
 * someone acts on it.
 */
export const liveUsageSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('never_fetched'),
    clusterId: z.string(),
    connectionName: z.string(),
  }),
  z.object({
    state: z.literal('fresh'),
    clusterId: z.string(),
    connectionName: z.string(),
    memoryUsedGiB: z.number(),
    hostsSampled: z.number(),
    hostsTotal: z.number(),
    /** When vCenter measured it — not when we asked. */
    measuredAt: z.string(),
    /** Computed SERVER-side, so a client's clock skew cannot disagree. */
    ageSeconds: z.number(),
  }),
  z.object({
    state: z.literal('stale'),
    clusterId: z.string(),
    connectionName: z.string(),
    memoryUsedGiB: z.number(),
    hostsSampled: z.number(),
    hostsTotal: z.number(),
    measuredAt: z.string(),
    ageSeconds: z.number(),
    reason: liveUsageStaleReasonSchema,
  }),
]);
export type LiveUsage = z.infer<typeof liveUsageSchema>;

/**
 * Batch live usage for the fleet console. One entry per **synced** cluster.
 *
 * Batch, not per-cluster: the design gate fixed the cache row (D23), the payload
 * union (D24) and the no-blocking-read rule (D25) but never the HTTP surface.
 * The fleet console renders N tiles and would otherwise issue N round-trips
 * against a page that already fetches its clusters in ONE paginated call.
 * `clusterId` is present in every union member, so a flat array self-describes
 * and needs no keyed map. The single-cluster panel read reuses bare
 * `liveUsageSchema`.
 *
 * @ai-warning Manual clusters are ABSENT from `items` — they are not
 * `never_fetched`. `never_fetched` requires a `connectionName`, which a manual
 * cluster does not have. Absence is the honest encoding of "no vCenter is
 * involved here"; a fabricated entry would not be.
 *
 * @ai-warning `items` is `array(liveUsageSchema)` and MUST NOT become
 * `array(liveUsageSchema.nullable())`. `VsphereLiveUsageService.forCluster`
 * returns `null` for "no sample" and the route maps that through
 * `neverFetched()`. A nullable item would let `null` reach a renderer and
 * reintroduce the 0%-lie the union exists to prevent.
 */
export const liveUsageListResponseSchema = z.object({ items: z.array(liveUsageSchema) });
export type LiveUsageListResponse = z.infer<typeof liveUsageListResponseSchema>;
