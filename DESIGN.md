# DESIGN — #279: fail closed when a vCenter leaf pin is unestablished

**Risk class:** HIGH (credential-bearing vSphere TLS trust path).
**Owner decision (2026-07-22, recorded on #279):** _pin-only, fail closed._
`tlsMode='system'` stays unreachable; the gate lives at the **job-selection
layer**, not inside `soapCall`; the operator verify path is preserved.

## 1. Problem

`soapCall` (`services/vsphere-client.ts`) branches only on whether
`pinnedLeafSha256` is truthy. A **non-null** pin routes through
`fingerprintPinnedConnection`, which destroys the socket before any request byte is
written if the presented leaf ≠ the pin. A **null** pin falls back to
`rejectUnauthorized: true` — the system trust store.

For a **self-signed** vCenter (the norm here), a null pin fails the handshake and
sends nothing (`tls_untrusted`). But for a peer trusted by the **system CAs**, the
null-pin path **transmits the stored service-account credential** during the window
before a pin is established. Three states reach that window on the **unattended**
(scheduler/job-runner) path, none of which is gated today:

1. `create()` stores the password and seeds `job.dueAt = now()` — immediately due,
   no pin yet.
2. A hostname re-point resets `tlsPinnedSha256 = null`, `status = 'never_connected'`.
3. Migration `20260721183652_vsphere_leaf_pinning` nulled `tls_pinned_sha256` (and
   set `status = 'tls_untrusted'`) for previously-pinned rows.

Neither `vsphere-scheduler.ts` (selection filters on `enabled` + `lastConnectedAt`)
nor `vsphere-job-runner.ts` (row select reads `enabled` + `tlsPinnedSha256`, but does
not act on a null pin) stops those rows from running with a null pin. The existing
`vsphere-fingerprint-pin.test.ts` only exercises wrong-pin and matching-pin against a
**self-signed** server, so the null-pin-against-a-trusted-peer case is uncovered.

`tlsMode='system'` is genuinely unreachable: the DB default is `'pinned'`, the only
writers set `'pinned'`, and `toResponse` merely reads it. So "null pin" unambiguously
means **"pinning intended, not yet established"** — which is why fail-closed is the
correct, information-preserving reading.

## 2. Trust boundaries

- **Untrusted:** the network path to vCenter (DNS, routing). An on-path attacker or a
  self-service internal DNS spoof can substitute a peer the system CAs trust.
- **Trust anchor:** the operator-confirmed **leaf** SHA-256 pin (`tlsPinnedSha256`),
  established out-of-band (`govc about.cert -thumbprint`) via probe → verify →
  trust-cert. Until it exists, the connection has **no** verified peer identity.
- **Secret crossing the boundary:** the decrypted vCenter service-account password
  (`revealPassword`). It must only be transmitted to a peer whose leaf matches the
  pin.
- **Actors:** the **unattended** scheduler/job-runner (no human in the loop → must
  fail closed) vs. the **operator-initiated** verify route (a human establishing the
  pin with a live-entered password → must keep working).

## 3. Design — where the gate lives

The fail-closed check lives at the **job-selection layer**, in three mirrored places,
exactly where `enabled` is already guarded:

1. **Scheduler selection** (`vsphere-scheduler.ts`, `executeDueJobs`): both the
   `established` and `first-contact` `findMany` queries add
   `connection: { tlsPinnedSha256: { not: null } }`. A null-pin row is never selected.
2. **Scheduler claim** (`vsphere-scheduler.ts`, `runOne`): the conditional-`updateMany`
   claim adds the same predicate, so a row whose pin is cleared between select and
   claim is not claimed (defence against the select→claim race, mirroring the
   `enabled` re-check).
3. **Job-runner row select** (`vsphere-job-runner.ts`, `run`): after loading the
   connection and **before** `revealPassword`, a `tlsPinnedSha256 === null` row
   returns early as a **skip** — surfacing `status = 'tls_untrusted'` with a clear
   `lastError` — so the credential is never even decrypted. This mirrors the existing
   `!connection.enabled` defensive branch.

The gate is **not** in `soapCall`: `soapCall` receives no `tlsMode`/intent, and the
operator verify route legitimately calls it with `pinnedLeafSha256: null` and **must
still send**. Putting the gate at job selection leaves the operator path untouched by
construction.

**Verify path preserved.** `routes/settings-vsphere.ts` `POST /verify` calls
`verifyLogin(..., pinnedLeafSha256: null)` with the operator's live-entered password —
an explicit, human-initiated step whose purpose is to establish the pin. It does not
go through the scheduler/job-runner, so this change does not touch it. `soapCall` and
`fingerprintPinnedConnection` are unchanged.

## 4. Invariants

- **INV-279:** an unattended job never decrypts or transmits vCenter credentials over
  a connection whose leaf pin is null. Enforced structurally at job selection and
  proven by the credential-sink regression test.
- **INV-3 (amended, was leaf-pinning-spec §Invariants #3):** a null pin no longer
  takes the system-trust path on an **unattended** connection. Pinning is
  **mandatory** for unattended connections; a null-pin row is ineligible for
  scheduled sync/poll/snapshot and fails closed. `tlsMode='system'` remains
  **non-writable / unreachable** — there is deliberately no CA-signed-without-pin
  unattended workflow. The null-pin system-trust path survives **only** for the
  operator-initiated verify route, whose job is to establish the pin.
- **Non-destructive degrade (issue #222 pattern):** the gate never mutates stored
  config — the pin, `tlsMode`, and encrypted password are untouched. It only surfaces
  a reachability `status`. Running probe → verify → trust-cert establishes the pin and
  the connection resumes with no further operator action. The override never outlives
  its cause.
- **Per-connection:** one unpinned connection is gated in isolation; others are
  unaffected.

## 5. Misuse cases

- **On-path MITM / DNS spoof to a CA-trusted peer during the pin window:** previously
  the null-pin poll would hand the credential to the spoofed peer. Now the unattended
  path never runs an unpinned connection → credential never sent. **Closed.**
- **Attacker seeds/repoints a connection anonymously in `disabled` mode:** a fresh or
  repointed row has a null pin → never eligible for unattended work; establishing a
  pin still requires the password gate on trust-cert. **Closed.**
- **Implementer "fixes" a handshake failure by relaxing the gate in `soapCall`:**
  rejected by design — the gate is at job selection; `soapCall`'s single confined
  `rejectUnauthorized:false` site (in `fingerprintPinnedConnection`) is untouched, and
  the byte-recording tests still hold.
- **Benign renewal misread:** unchanged from #272 — a rotated leaf reports
  `cert_mismatch` (pin present, mismatched); a _null_ pin reports `tls_untrusted`. Both
  fail closed until the operator re-confirms.

## 6. Failure / recovery & rollback

- **Failure mode introduced:** a connection with no established pin will not sync
  unattended. This is intentional and visible (`status = tls_untrusted` /
  `never_connected`, both actionable in the connection panel). It is **not** a crash
  and **not** a silent idle — the operator sees the status and runs Check certificate →
  confirm → Save.
- **Recovery:** operator establishes the pin (probe → verify → trust-cert). The next
  scheduler tick selects the now-pinned row and syncs. No data mutated, no manual DB
  work.
- **Rollback:** revert this PR. The change is pure selection/guard logic plus tests and
  docs — no schema migration, no data change, no contract change. Reverting restores
  the prior (vulnerable) behavior with zero migration. Rolling forward again is
  likewise a code-only deploy.

## 7. Security / privacy impact

- **Security:** closes credential disclosure to a system-CA-trusted MITM peer during
  the pin-establishment window on the unattended path. Strengthens the
  vet-then-transmit ordering the whole vSphere trust design is built on.
- **Privacy:** none — no new data collected, logged, or exposed. The gate writes only a
  coarse `status`/sanitized `lastError` (no secret, no cert internals). Logs unchanged.
- **Contracts:** no `@lcm/shared` schema change. `tlsMode` stays a two-value,
  both-fail-closed enum; `'system'` stays unreachable.

## 8. Verification

- **Regression (new, failing-first):** `vsphere-fingerprint-pin.test.ts` — a null-pin,
  established, enabled connection driven through the unattended job runner never
  decrypts or transmits the credential (a credential-sink spy stays empty), reports a
  skip, and surfaces `tls_untrusted`; the stored pin is left null (non-destructive). A
  companion asserts the operator path is preserved: `soapCall` with a null pin still
  opens a connection to the peer (the gate is at the job layer, not `soapCall`).
- Existing scheduler/job-runner suites updated so their **established** connections
  carry a pin (that is what an established connection is), keeping their behavior.
- `pnpm lint && pnpm typecheck && pnpm test` (Testcontainers Postgres) all green.
