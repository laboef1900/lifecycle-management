# vSphere TLS: leaf-fingerprint pinning — design

- **Origin:** [#272](https://github.com/laboef1900/lifecycle-management/issues/272) follow-up. Real-world failure: a default vCenter presents its Machine SSL **leaf without the VMCA root in the handshake**, so root-pinning has nothing to pin. The operator now hits **PR #278**'s `chain_incomplete` guidance — _"vCenter did not present its root CA, so there is no certificate to pin. Add the issuing or root CA to vCenter's certificate chain, then try again"_ — which is a correct diagnosis but a dead-end for a vCenter the operator can't re-chain.
- **Supersedes:** **D11** of `docs/vsphere-integration-design.md` (pin the chain root as a `ca:` anchor) **and PR #278** (merged to `dev` 2026-07-21, `a0509c7`: `evaluateProbedChain`/`isSelfSignedAnchor` refuse to pin a non-self-signed anchor and return `chain_incomplete`). #278 made the failure explicit and actionable but did **not** fix it; leaf-fingerprint pinning does, so its `chain_incomplete` outcome and self-signed-anchor gate are removed. **Amends** the reasoning in **§0.1** (does _not_ re-introduce a rejected "ignore TLS" flag) and **honors D10** (the `checkServerIdentity` trap) in full.
- **Date:** 2026-07-21
- **Risk:** **High** — the vCenter credential-bearing TLS trust path, a `@lcm/shared` contract change, and a Prisma migration (see CLAUDE.md Change Risk table). Requires the Automated high-risk approval controls (written design + two independent AI reviews + green CI) or a human sign-off.
- **Status:** Design — owner approved the direction (2026-07-21); pending owner review of this written spec.
- **Owner decisions (2026-07-21):** (1) **Replace** root-pinning entirely with leaf-fingerprint pinning — one trust path, "works everywhere". (2) The vSphere feature is **dev-only, not in production**, so the migration may reset any existing pinned rows to require a one-time re-confirm.

## Problem

D11 pins the **root** of the presented chain as an OpenSSL `ca:` trust anchor. Its stated premise — _"self-signed VMCA certs must just work, verification ON, surviving leaf auto-renewal"_ — assumed vCenter presents a chain that terminates at a self-signed anchor (either a self-signed leaf, or leaf + VMCA root).

Real deployments break that premise. A stock vCenter routinely presents **only the Machine SSL leaf**, issued by VMCA, **without the VMCA root in the TLS handshake** — an _incomplete chain_. Walking `issuerCertificate` then runs out of links at a **non-self-signed leaf** (`vsphere-tls.ts` `rootOf` / `describeChain`, `terminalSelfSigned: false` — the #272 diagnostic). There is no self-signed root to pin, and pinning the non-self-signed leaf as a `ca:` anchor cannot work: OpenSSL must terminate at a self-signed anchor it trusts, and a non-self-signed leaf in the CA set yields `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (Node exposes no `X509_V_FLAG_PARTIAL_CHAIN`). The operator is dead-ended: the certificate is real, but the trust flow has nothing it can pin.

PR #278 (merged 2026-07-21) addressed the _symptom_: `evaluateProbedChain` refuses to pin a non-self-signed terminal (`isSelfSignedAnchor` gate) and returns a distinct `chain_incomplete` outcome so the operator sees actionable guidance rather than a silent sync failure six hours later. That was the right containment, but it leaves the operator dead-ended when they can't add the VMCA root to vCenter's presented chain — which is the state that prompts the "just ignore the certificate" request this design answers instead.

The underlying need is unchanged from §0.1: **a self-signed / privately-issued vCenter must "just work," with verification effectively ON.** D11's mechanism is what fails, not the goal; #278's refusal is honest but not a fix.

## Decision

**Pin the leaf certificate's SHA-256, verified at the socket before any credential byte is written.** Keep the existing two-mode, fail-closed model; change only what `pinned` _means_:

- **`tlsMode: 'system'`** — _unchanged._ `rejectUnauthorized: true`, no `ca:`. For a vCenter whose leaf already chains to a CA in the system trust store.
- **`tlsMode: 'pinned'`** — _new meaning._ The connection opens with `rejectUnauthorized: false` **inside a single confined factory**, and a mandatory check compares the presented leaf's `fingerprint256` to the stored pin, **destroying the socket before the HTTP layer writes the SOAP `Login` body** on any mismatch or missing pin. This validates against a self-signed leaf, an incomplete chain, _and_ a full chain — the "works everywhere" property.

This is **not** the §0.1-rejected "ignore TLS" flag: there is no mode that sends the credential to an unverified peer. It is verification by a different, stronger-for-this-environment predicate (exact-certificate identity) than "chains to a trusted root."

### Why not `checkServerIdentity` (honoring D10)

D10 established empirically that `checkServerIdentity` is invoked **iff** OpenSSL chain verification succeeds, so with `rejectUnauthorized: false` against an untrusted cert it runs **zero times** — a thumbprint check placed there is `curl -k` with green tests. **This design does not use `checkServerIdentity`.** It reads the peer certificate in the TLS socket's `secureConnect` handler, which fires on every successful handshake regardless of `rejectUnauthorized`, and gates the HTTP layer on that result. The D10 prohibition stands and is respected.

### Why leaf, not root (the accepted trade-off)

A leaf pin does **not** survive vCenter's unattended leaf auto-renewal (~2 yrs) or an admin regenerating certs. On renewal the presented leaf's fingerprint stops matching → the connection goes `cert_mismatch` → the operator re-confirms once via the existing **"Replace the trusted certificate"** dialog. This is a **usability cost, not a security regression**: it fails closed (the credential is never sent to the new, unconfirmed cert), and the re-confirm UI already exists. The owner has re-weighted D11's longevity argument in favor of "works everywhere + one simple path." **Recorded as a deliberate decision, superseding D11.**

Bonus correctness: the pinned/displayed value is now the **leaf** thumbprint, which is exactly what `govc about.cert -thumbprint` prints — so the trust dialog's "prints the same value" instruction becomes literally true (it was subtly wrong when comparing against a chain root).

## Architecture

### Data model (Prisma migration)

`VsphereConnection` (`apps/server/prisma/schema.prisma`):

- **Keep** `tlsMode String @default("pinned")` — values still `'system' | 'pinned'`, both fail closed, no insecure value. Update the doc comment: `'pinned'` now means a leaf-fingerprint pin.
- **Keep** `tlsPinnedSha256 String?` — now stores the **leaf** SHA-256 (uppercase, colon-separated, `govc` form). Update the doc comment from "root" to "leaf".
- **Drop** `tlsPinnedCaPem` — the pin is a fingerprint now; no PEM is stored or used as a `ca:` anchor. Certificate detail shown in the UI (e.g. `validTo`) comes from a **live probe**, as it already does in the trust dialog.

Migration behavior (dev-only, per owner decision): drop the `tls_pinned_ca_pem` column, and for any row currently in a pinned/connected state, **reset trust** — set `status = 'tls_untrusted'` and `tls_pinned_sha256 = NULL` — so the operator re-confirms the leaf once. No data preserved; no `pg_dump` gate required because the feature is not in production (re-confirm before shipping to `main` if that changes).

### Shared contract (`packages/shared/src/schemas/vsphere.ts`) — high-risk change

- `VsphereProbeResult`: rename `rootFingerprintSha256` → **`leafFingerprintSha256`** (keeping the misleading "root" name would be an actively wrong contract). Other fields (`reachable`, `trustedBySystemRoots`, `validFrom`, `validTo`, `outcome`) unchanged.
- `vsphereTrustCaSchema` → **`vsphereTrustCertSchema`**: `{ leafFingerprintSha256, password }`.
- Trust endpoint path `/settings/vsphere/connections/:id/trust-ca` → **`/trust-cert`** (honest name; safe to rename because the feature is dev-only).
- `VsphereConnectionStatus` union — **unchanged** (`cert_mismatch` already exists).

### Certificate capture (`vsphere-tls.ts`)

- Probe returns the **leaf** fingerprint (`detailed.fingerprint256`) and its `validFrom`/`validTo`, plus `trustedBySystemRoots` (`socket.authorized`). No PEM leaves the probe.
- **Remove** the root-walk _pinning_ machinery **and #278's anchor gate**: `evaluateProbedChain`, `isSelfSignedAnchor`, `isSelfSignedAnchorPem`, `rootOf`, `derToPem`, `CapturedChain.rootPem`, and the `chain_incomplete` `TlsProbeOutcome`. The whole #272 incomplete-chain failure class disappears with leaf-pinning. `probeCertificate` captures the leaf directly (no `evaluateProbedChain` delegation). The read-only diagnostics unit — `describeChain` with its helpers `chainTerminates`/`isGenuinelySelfSigned` — MAY be kept **as a whole** (server-log-only evidence; subject/issuer CNs stay off the response per its existing `@ai-warning`) or removed **as a whole**; it is not load-bearing for pinning either way. Don't drop a helper while keeping its caller.
- **Remove `chain_incomplete` from BOTH lockstep union locations:** `VsphereProbeResult.outcome` (interface, `schemas/vsphere.ts`) **and** `vsphereProbeResultSchema` (Zod, `schemas/responses.ts`). `z.ZodType<T>` does not enforce enum exhaustiveness, so editing only one compiles but makes the web client reject probe responses (`RESPONSE_VALIDATION`); the `responses.test.ts` round-trip is the real guard. Remove the web `chain_incomplete` branches in `vcenter-connections-panel.tsx` and `trust-certificate-dialog.tsx` (and their `.test.tsx`), and the server `#272` anchor-gate tests + `ROOT_CA_BAD_SIG_PEM` fixture in `settings-vsphere-mappers.test.ts`.
- `verifiedTlsOptions(hostname, pinnedRootPem, port)` is **replaced** (see below). The `pinnedRootPem: string | null` parameter threaded through `soapCall`, `vsphere-collector`, `vsphere-snapshot`, `vsphere-sync`, `vsphere-inventory`, `vsphere-job-runner`, `vsphere-live-usage`, and `verifyLogin` becomes **`pinnedLeafSha256: string | null`** — a mechanical rename across those call sites. `null` continues to mean "system-trust mode," preserving the existing convention.

### The credentialed connection — the security-critical mechanism (`vsphere-client.ts`)

`soapCall` keeps using `node:https` (chosen in D2/comments for native per-request TLS options). For **pinned** mode (`pinnedLeafSha256` non-null) it supplies a confined `createConnection`:

```ts
// The ONLY place rejectUnauthorized:false appears on a credential path.
// It is SAFE only because the fingerprint gate below destroys the socket
// BEFORE the HTTP layer is handed a usable socket to write the Login body on.
createConnection: (opts, onReady) => {
  const socket = tlsConnect({ ...opts, rejectUnauthorized: false });
  socket.once('secureConnect', () => {
    const fp = normalizeFingerprint(socket.getPeerCertificate(false).fingerprint256 ?? '');
    if (!fp || fp !== pinnedLeafSha256) {
      socket.destroy(new Error('CERT_FINGERPRINT_MISMATCH')); // fail closed, no write
      onReady(new Error('CERT_FINGERPRINT_MISMATCH'));
      return;
    }
    onReady(null, socket); // only now may the request flush
  });
  socket.once('error', onReady);
  return socket;
};
```

For **system** mode (`pinnedLeafSha256 === null`) the request keeps `rejectUnauthorized: true` and no custom `createConnection` — standard verification, exactly as today's `pinnedRootPem: null` path.

> **Empirical-verification requirement (D10-grade).** The ordering guarantee — _no application byte reaches the socket on a fingerprint mismatch_ — MUST be proven by an integration test against a byte-recording TLS server, not assumed. The exact Node wiring (callback vs. return-value form of `createConnection`, listener registration order) is settled by making that test pass, the same way D10/D11 were settled on the real toolchain. This test is the linchpin of the whole change.

### Trust flow (`settings-vsphere.ts`)

- **Probe** (`POST /settings/vsphere/probe`): returns `leafFingerprintSha256` (server-log diagnostics unchanged, still server-side only).
- **Trust** (`POST /settings/vsphere/connections/:id/trust-cert`): password-gated (unchanged — a re-pin plus DNS spoof delivers the credential on the next poll). Re-probe the stored hostname/port, require the presented leaf fp to equal the admin-confirmed `leafFingerprintSha256` (else `FINGERPRINT_MISMATCH`), then store the leaf fp, set `tlsMode='pinned'`, and clear the untrusted state so the next sync can connect (status transitions on that sync, exactly as today). Server pins what **it** observes; the admin's fingerprint only has to agree.
- **Verify** (`POST /settings/vsphere/verify`, unsaved connection): still verifies against system roots with no pin (`pinnedLeafSha256: null`); a self-signed vCenter reports `tls_untrusted` until confirmed — vet the cert, _then_ send the credential.

### Sync mismatch → `cert_mismatch` (`vsphere-sync.ts`)

`classify()` currently returns `'unreachable' | 'auth_failed' | 'tls_untrusted'` and maps any `/cert|tls|self.signed/` message to `tls_untrusted`. Add a **specific** branch: an error carrying `CERT_FINGERPRINT_MISMATCH` → **`cert_mismatch`** (extend the return union and `sanitize()` with a message like _"vCenter is presenting a different certificate than the one you trusted."_). This routes a rotated/attacker leaf into the existing "Replace the trusted certificate" flow instead of the never-trusted `tls_untrusted` copy. Generic TLS errors still fall through to `tls_untrusted`.

> **Lockstep unions.** The login/sync outcome unions live in two places kept in sync (`vsphere-client.ts` `VsphereLoginOutcome` and `vsphere-sync.ts` `classify`), plus the shared `VsphereProbeResult.outcome` literals. Any new outcome value must be added to each. The implementer verifies all sites.

## Invariants

1. **No credential byte is written to a pinned-mode socket until the presented leaf SHA-256 equals the stored pin.** Enforced structurally in `createConnection` and proven by the byte-recording test.
2. **`rejectUnauthorized: false` exists only inside that fingerprint-gated factory.** `system` mode keeps `rejectUnauthorized: true`. There is no third path, and no flag that disables verification.
3. **A null/empty pin never sends the credential to an unverified peer.** Runtime behavior keys off the stored fingerprint, exactly as today keyed off `pinnedRootPem`: a **null** pin takes the system-trust path (`rejectUnauthorized: true`, no gate) — so a not-yet-trusted self-signed vCenter fails the handshake and reports `tls_untrusted` (vet-then-pin), it does not connect insecurely; the `rejectUnauthorized: false` fingerprint gate engages **only** for a non-null pin. Fail closed either way.
4. **A fingerprint mismatch at sync time sets `cert_mismatch`, stops sending the credential, and requires a human re-confirm.** A new leaf is never auto-accepted.
5. **Re-pinning still requires the connection password** (unchanged trust-material gate).
6. **No PEM/subject/issuer/SAN leaves the server** — only the fingerprint and validity dates, as today.

## Threat model / misuse cases

- **On-path MITM / DNS spoof substitutes its own certificate:** different leaf fingerprint → socket destroyed before the SOAP body flushes → credential never sent (INV-1/4). Equivalent protection to root-pinning against this, the primary threat §0.1/D11 cared about.
- **Attacker with API access re-pins to their certificate:** still blocked by the password gate (INV-5) — the same control D11 relied on.
- **Implementer "fixes" a handshake failure by widening the factory:** blocked by INV-2 (single confined site) and the byte-recording test, which fails if the credential can reach an unmatched cert.
- **Benign leaf renewal misread as an attack:** indistinguishable from here by design — the operator re-confirms against `govc about.cert -thumbprint`; fail-closed until they do.
- **Residual risk (accepted):** leaf pins require a one-time re-confirm on each vCenter cert rotation. Usability cost, fail-closed, mitigated by the existing Replace dialog.

## Testing

- **Security linchpin (integration, Testcontainers/`vcsim` or a local TLS stub):** on a fingerprint mismatch, the credential-bearing request writes **zero application bytes** to the server before the socket closes. This is the gate on the whole change.
- Pinned-mode happy path: matching leaf fp → `Login` succeeds against `vcsim`.
- Self-signed leaf, incomplete chain, and full chain all pin and connect (the "works everywhere" claim, each as a case).
- Mismatch at sync → status `cert_mismatch`, sanitized `lastError`, credential not re-sent.
- Trust route: `FINGERPRINT_MISMATCH` when the re-probe disagrees; `PASSWORD_MISMATCH` gate intact.
- Probe returns the leaf fp (matches `getPeerCertificate` on the stub); no PEM/CN in the response body.
- Migration: an existing pinned row is reset to `tls_untrusted` with a null pin.
- Web: trust dialog copy for `tls_untrusted` vs `cert_mismatch`; fingerprint confirm; e2e golden path unaffected.

## Migration & rollback

- One additive-then-subtractive Prisma migration: drop `tls_pinned_ca_pem`; reset pinned rows to `tls_untrusted` / null pin. Dev-only ⇒ no backup gate (re-confirm deployment state before any `dev → main` sync).
- Rollback: revert the migration and the code together; no production data is at stake. Because a leaf pin and a root pin are different values, forward and backward both require operators to re-confirm — acceptable at dev stage.

## Documentation to update

- `docs/vsphere-integration-design.md`: mark **D11 superseded** by this spec; append an amendment to **§0.1** clarifying that leaf-fingerprint pinning (verification-equivalent, not an "ignore TLS" flag) replaces root-pinning, with the #272 evidence; **D10 stands.**
- `docs/operations.md`: update any TLS-trust/operator note that describes root-pinning.
- The many `@ai-warning`/`@ai-context` markers in `vsphere-tls.ts`, `vsphere-client.ts`, `settings-vsphere.ts`, and the schema that reference "root" pinning.

## Out of scope

- Auto-fetching the VMCA root from vCenter's `/certs/download.zip` (SSRF-adjacent; unnecessary once we pin the leaf).
- Any `system`-mode change.
- Re-introducing an insecure/ignore-TLS flag (permanently rejected, §0.1).
- Multi-leaf / load-balanced vCenter presenting different certs per node (rare; if it surfaces, a follow-up can pin a set — not now, YAGNI).
