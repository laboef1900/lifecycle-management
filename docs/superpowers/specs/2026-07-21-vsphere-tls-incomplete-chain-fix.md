# DESIGN — #272 Part A: refuse to pin a non-self-signed TLS anchor

**Issue:** #272 — vCenter sync fails with "untrusted certificate" shortly after trusting the certificate.
**Risk class:** HIGH (vCenter TLS trust/pinning boundary; forecast staleness when sync stalls).
**Scope decision (owner, 2026-07-21):** **Part A only.** No operator-supplied-PEM path (that is Part B, deferred).
**Approval path (owner, 2026-07-21):** Automated AI-review — this design + failing-first tests + two independent AI reviewers (`critic` and `brahma-analyzer`) + green CI, then merge to `dev`.
**Predecessor:** PR #273 (diagnostics, merged to `dev` at `baae44f`) added `describeChain`, `isGenuinelySelfSigned`, `extractTlsErrorCode`, and the server-log evidence. This PR is the approved follow-up its `rootOf` `@ai-warning` names.

---

## 1. Root cause (proven, not inferred)

Empirically reproduced on the target runtime (Node **26.5.0**, OpenSSL 3.6.3) with an in-process `tls.createServer` and a real 3-level chain (root → intermediate → leaf):

`probeCertificate` → `rootOf` walks `issuerCertificate` to the chain's terminal and pins it as the trust anchor **without verifying the terminal is self-signed**. When vCenter presents an **incomplete chain** (leaf-only, or leaf+intermediate with the self-signed root withheld — standard for enterprise-CA-signed Machine SSL certs), the terminal is a leaf/intermediate, not a root. `trustCa` stores it; the admin's confirmed fingerprint is derived from the _same_ `rootOf`, so trust "succeeds". Then `verifiedTlsOptions` loads that non-anchor as the sole `ca:` with `rejectUnauthorized: true`, and every credentialed sync fails strict verification (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE`) — the reported "untrusted certificate", re-surfaced on each retry (the "reverts after a while").

**Measured terminal shape per topology (Node 26.5.0):**

| Server presents                         | `rootOf` terminal | terminal `subject==issuer` | `issuerCertificate` | genuine anchor?  |
| --------------------------------------- | ----------------- | -------------------------- | ------------------- | ---------------- |
| leaf + intermediate + root              | root              | yes                        | self-reference      | **yes** — pin it |
| leaf + intermediate (root withheld)     | intermediate      | no                         | `undefined`         | **no** — refuse  |
| leaf only                               | leaf              | no                         | `undefined`         | **no** — refuse  |
| self-signed leaf (vcsim / VMCA default) | leaf==root        | yes                        | self-reference      | **yes** — pin it |

The last row is why dev/CI (vcsim, self-signed leaf==root) **cannot** reproduce #272 and there is no existing regression test. This PR commits the real multi-level chain as **public-certificate** fixtures so the security predicate is asserted on genuine bytes, and drives the pin/refuse decision with `fakeChain` literals shaped to match this table (see §6).

Correction to an earlier note: on Node 26.5.0 an incomplete chain's terminal has `issuerCertificate === undefined` (not a circular self-reference), so `subject !== issuer` cleanly separates it from a real anchor.

## 2. The fix (Part A)

**One security property:** _pin X as the trust anchor **iff** X is an anchor OpenSSL will accept_ — i.e. a **self-issued** certificate (`subject DN == issuer DN`). This makes probe-time trust identical to sync-time verification, closing the gap that let a pin succeed and then fail 6h later.

> **Empirically settled (Node 26.5.0), and it is why the check is self-ISSUED, not self-SIGNED:** OpenSSL does **not** re-verify a supplied trust anchor's own self-signature — `X509_V_FLAG_CHECK_SS_SIGNATURE` is off by default. Pinning a root whose self-signature bytes were corrupted (so `X509Certificate.verify(publicKey)` returns `false`) as `ca:` still validates a real chain in a live handshake. So the gate must **not** require `verify()`: doing so would make it _stricter_ than sync-time verification and refuse a self-issued root that works today — a regression that breaks invariant #3. The TOFU model already decides trust by the admin-confirmed fingerprint, not the self-signature. Locked by the `ROOT_CA_BAD_SIG_PEM` fixture + test.

- Add `isSelfSignedAnchorPem(certData)` — authoritative, operates on the **actual certificate bytes** (PEM or DER) via `node:crypto` `X509Certificate`, comparing the canonical DN strings: `subject === issuer`. Independent of Node's `issuerCertificate` chain reconstruction, so it cannot be fooled by any chain-walk quirk. Fails closed (returns `false`) on empty/malformed input.
- Add `isSelfSignedAnchor(cert)` — the gate on a probed terminal. When the raw bytes are present (always in production) it compares the canonical `X509Certificate` DN strings; shaped test certs carry no `raw`, so the parsed subject/issuer objects are compared. Both branches check the identical property — self-issued — so neither is weaker than the other; a leaf/intermediate always has `subject !== issuer` and can never pass.
- Extract `evaluateProbedChain(detailed, trustedBySystemRoots)` — the pure pin/refuse decision `probeCertificate` makes on the peer chain. It pins the root only when `isSelfSignedAnchor` passes; otherwise it returns the new outcome `chain_incomplete` with `chain: null` (**refuse to pin**) and the existing server-log `diagnostics`. `probeCertificate` is now a thin socket wrapper around it, which is what makes the decision unit-testable without a live server.
- New probe outcome `chain_incomplete` added to the server `TlsProbeOutcome` and to **both** halves of the shared contract: the TS interface `VsphereProbeResult.outcome` (`vsphere.ts`) **and** the runtime validator `vsphereProbeResultSchema.outcome` (`responses.ts`) that the web client parses every response against. The `z.ZodType<…>` annotation does not enforce exhaustiveness, so the two must be kept in lockstep by hand (guarded by a `responses.test.ts` round-trip test); omitting the runtime half makes the client reject the response with `RESPONSE_VALIDATION`. It is a probe/trust-flow value only — **not** a persisted connection status, so **no Prisma migration**.
- Defense-in-depth at the storage boundary: `VsphereConnectionsService.trustCa` refuses to persist an empty `caPem` (an empty `ca:` list silently falls back to the system trust store). Cannot fire via the route today, but it stops the upstream gate from being the _only_ safeguard.
- Probe route passes `chain_incomplete` through (instead of collapsing it to `tls_untrusted`). Trust-ca route maps it to a distinct `CHAIN_INCOMPLETE` 422 with operator guidance ("vCenter did not present its root CA…") — the route already failed closed on any non-`ok` outcome, so this only improves the message; it does not change whether a bad pin is stored.
- Web trust dialog renders a dedicated `chain_incomplete` guidance branch and keeps the Trust button disabled (there is no fingerprint to confirm).
- The `rootOf` `@ai-warning` is updated from "pending follow-up" to "the gate now lives in `evaluateProbedChain`".

Deliberately **out of scope** (Part B): letting the operator paste the root CA PEM. `rejectUnauthorized: false` and moving trust into `checkServerIdentity` remain forbidden (they fail open — see the existing `@ai-warning`s and the `checkServerIdentity` unit tests).

## 3. Trust boundary & misuse cases

- **Boundary:** the unauthenticated `POST /settings/vsphere/probe` and the password-gated `trust-ca` re-probe. In the default `disabled` auth mode every caller is an ADMIN principal; the only asymmetry with an attacker is knowledge of the vCenter password (enforced by `trust-ca`'s password gate, unchanged here).
- **Misuse — pin a non-anchor to cause silent later failure:** previously possible by presenting an incomplete chain; now refused at probe time. Strictly safer.
- **Misuse — downgrade/relax verification:** not introduced. This change only _rejects_ pins; it never accepts one it previously rejected, and it adds no insecure branch.
- **No new information disclosure:** `chain_incomplete` carries no subject/issuer/SAN to the client — only the outcome enum. Subject/issuer CNs remain server-log-only via the existing `diagnostics`.

## 4. Invariants (must hold)

1. `verifiedTlsOptions` keeps `rejectUnauthorized: true` always; no insecure branch, ever.
2. Failing closed here = **refuse to trust**, never trust-anyway. An incomplete chain yields a clear error at probe/trust time, not a silent pin that dies at sync.
3. The change may only make trust **stricter** — it can reject a chain it previously accepted, never accept one it previously rejected. (Full-chain and self-signed-leaf topologies are unchanged — regression-guarded by tests that stay green.)
4. Stored pins are never wiped by this change — recoverability preserved; correcting the vCenter chain and re-trusting restores it with no data loss and no migration.
5. No secret in any log line, error, `lastError`, response body, or test fixture.

## 5. Why working connections are not at risk

- Full chain (leaf→intermediate→root): `rootOf` reaches the self-signed root → gate passes → same root pinned → **no change**.
- Self-signed leaf (vCenter out-of-box / vcsim): the leaf _is_ a self-signed anchor → gate passes → **no change**.
- Only **incomplete-presenting** connections change behaviour — and those are exactly the ones broken today (they pin a non-anchor that fails every sync).

## 6. Test matrix (failing-first; no Testcontainers, no real vCenter)

**No new private key is committed for this change** (the pre-existing
`TEST_KEY_PEM` throwaway self-signed key, which the existing real-TLS-server tests
already use, is untouched). The security predicate is asserted on real **public**
certificate bytes (verifying a self-signature needs only the cert's own embedded
public key), and the pin/refuse decision is driven by `fakeChain` shaped
literals — whose incomplete shape (`issuerCertificate: undefined`, `subject !=
issuer`) was verified during the investigation to match real Node 26.5.0 (§1
table), so it is a faithful model, not a mock that lies. That combination avoids
standing up a real incomplete-chain TLS server (which would need a committed leaf
private key) while still covering every decision path.

| Layer / test                                                                     | Assertion                                                     | Before fix           |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------- |
| `isSelfSignedAnchorPem`: `ROOT_CA_PEM` / `TEST_CERT_PEM` / `OTHER_CERT_PEM`      | `true`                                                        | n/a (new)            |
| `isSelfSignedAnchorPem`: **`ROOT_CA_BAD_SIG_PEM`** (self-issued, self-sig fails) | `true` (matches OpenSSL — locks "no `verify()`")              | n/a (new)            |
| `isSelfSignedAnchorPem`: `INTERMEDIATE_CA_PEM` / `CHAIN_LEAF_PEM` / '' / garbage | `false`                                                       | n/a (new)            |
| `isSelfSignedAnchor` (shaped): self-issued terminal / subject≠issuer terminal    | `true` / `false`                                              | n/a (new)            |
| `evaluateProbedChain` (fakeChain): full chain / self-signed leaf                 | `ok`, `chain` populated, `terminalSelfSigned: true`           | passes (guard)       |
| `evaluateProbedChain` (fakeChain): **leaf+intermediate, root withheld**          | `chain_incomplete`, `chain: null`, `terminalSelfSigned:false` | **`ok` (bug)** → RED |
| `evaluateProbedChain` (fakeChain): **leaf-only**                                 | `chain_incomplete`, `chain: null`                             | **`ok` (bug)** → RED |
| `probeCertificate` (real self-signed `tls.createServer`)                         | `ok`, real fingerprint, `terminalSelfSigned: true`            | passes (guard)       |
| `toProbeResponse`: `chain_incomplete` / `unreachable` / `tls_untrusted` / `ok`   | outcome passthrough / collapse; `ok`→fingerprint              | RED (passthrough)    |
| `trustReprobeError`: `chain_incomplete` / `unreachable` / `tls_untrusted` / `ok` | `CHAIN_INCOMPLETE` / `VCENTER_UNREACHABLE` / null             | RED                  |
| `vsphereProbeResultSchema` round-trip: every `VsphereProbeResult.outcome`        | accepts all (incl. `chain_incomplete`); rejects unknown       | RED (schema drift)   |
| `trustCa` with an empty `caPem` (storage-boundary guard)                         | throws, nothing pinned                                        | n/a (new)            |
| web dialog + add-connection panel: probe `chain_incomplete`                      | both show root-CA guidance (Trust disabled in the dialog)     | RED                  |

**Documented residual (accepted):** no test stands up a _real_ TLS server
presenting an incomplete chain (that needs a committed leaf private key, which the
established fixture pattern would allow but which trips the local secret scanner
for no security gain here). The socket-level behaviour it would assert — real Node
returning a `subject != issuer` terminal for an incomplete chain — is the §1 table,
established empirically during the investigation. If a future Node changed that,
the `evaluateProbedChain` fakeChain tests would still pass while production
regressed; the risk is low (the predicate also verifies the self-signature on real
bytes) and is called out here for the reviewers.

## 7. Rollback / containment

Revert the single commit. Stored pins are untouched (no migration, no data loss). Worst case of the change is an operator seeing a clear "incomplete chain — fix the vCenter chain" error instead of a silent later sync failure — strictly safer. There is no TLS break-glass and there must not be one (`RECOVERY_DISABLE_AUTH` is auth-only).

## 8. Security & privacy impact

Net positive: converts a silent, delayed fail-open-adjacent trust bug (a pin that never validated) into an immediate fail-closed diagnosis. No new data collected, logged, or disclosed. No change to secrets handling, RBAC, or the password gate. `docs/operations.md` SSRF/trust notes unchanged (the probe SSRF surface and `guardTarget` are untouched).
