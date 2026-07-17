# vSphere integration — design and threat model

**Status:** DRAFT — awaiting project-owner approval (issue #174, the high-risk design gate for epic #172).
**Date:** 2026-07-17.
**Risk classification:** **High** on four axes per `CLAUDE.md` § Change Risk — secrets handling, outbound
server connections, Prisma migration on purchasing-critical baseline data, and forecast-engine correctness.
No implementation phase (#175–#179) may begin until this document is explicitly approved.

> **This document is the gate, not a formality.** It resolves every open question listed in #174 and, in
> several places, contradicts assumptions baked into the epic's sub-issues. Those contradictions are
> listed in §11 and need explicit sign-off, because they change scope.

---

## 1. Environment facts (confirmed by the project owner, 2026-07-17)

These are authoritative inputs, not assumptions. Several of them invalidate the issues' premises.

| Fact | Value | Consequence |
| --- | --- | --- |
| vCenter version | **8.0 U3 today, 9.0 near future** | Design must work on both. Rules out anything 9.0-deprecated. |
| Number of vCenters | **Two or more, today** | **#175's `vsphere_config` singleton is invalid.** See §11.1. |
| vCenter TLS certs | **Self-signed (VMCA default)** | Trust must be explicitly established; see §5. |
| Production auth mode | **`disabled` today**, `local`/`oidc` planned | Every `/api/*` caller is an anonymous ADMIN. The threat model must hold under this. |

**Still unanswered — blocking (see §12):** GB vs GiB; FQDN vs IP addressing; management-network
segmentation; migration rollback appetite.

---

## 2. Scope

**In scope (v1):** read-only memory capacity + usage per cluster and per host, from N vCenters;
automatic inventory sync; append-only baseline history; monthly automatic snapshots; live (polled,
cached) usage display.

**Out of scope:** CPU/storage metrics; any write to vSphere; VM-level inventory; push/streaming updates.

**Product-doc conflict — must be resolved before implementation.** `docs/vision.md` lists "live vSphere
API integration" under **v1 Non-goals** and names "premature hypervisor API integration" an explicit
**Anti-pattern**, while its **Horizons** section names live hypervisor integrations "starting with
vSphere" as the long-term direction. Since v1 has shipped, this epic follows the horizon rather than
contradicting it — but `CLAUDE.md` makes `docs/vision.md` authoritative, so this reading requires the
owner's explicit sign-off and a doc amendment (§11.5). It is recorded here rather than assumed away.

---

## 3. Decision: API surface and client

### D1 — Protocol: **vim25 SOAP** (`POST https://<vc>/sdk`)

| Candidate | Verdict |
| --- | --- |
| **vim25 SOAP** | ✅ **Chosen.** GA, non-deprecated in 9.0, and the only protocol both real vCenter *and* the test double speak. |
| vSphere Automation REST | ❌ Inventory endpoints return identity only — **no memory capacity or usage**. Fatal. |
| VI/JSON (8.0 U1+) | ❌ Same vim25 object model over JSON, and genuinely attractive — but **vcsim does not implement it** (verified: no route registered in `simulator/simulator.go`). Choosing it means no integration test double for a purchasing-critical path. Rejected on testability alone. |
| vStats | ❌ **Technology Preview.** Broadcom verbatim: *"VMware does not guarantee backwards compatibility and recommends against using them in production environments."* Also push/registration-oriented (would mutate vCenter state — violates read-only), counters versioned by "edition", and not served by vcsim. |

**SOAP is not deprecated in 9.0** — verified against Broadcom VCF 9.0 TechDocs. 9.0's deprecations are
targeted (Patch Manager, vSAN .NET/Perl/Ruby SDKs, Supervisor `cluster_id`); the Java SDK's merge into
the VCF SDK with VIM+VSAN in a single WSDL is evidence the contract is *maintained*, not retired.
govmomi's `vim25` package declares `Version = "9.0.0.0"`.

**Accepted strategic risk:** Broadcom's direction is VI/JSON. We choose the older wire format *because
the test double requires it*. **Mitigation (mandatory):** keep the wire format behind a narrow transport
interface — `retrieveProperties(specSet) → objects`. The PropertyFilterSpec, traversal, and all parsing
above it are protocol-independent, so a VI/JSON swap stays contained. Revisit if vcsim adds VI/JSON.

### D2 — Client: **hand-rolled**, with `fast-xml-parser`

Every vSphere-specific npm package is abandoned: `node-vsphere-soap` (last publish **2015**),
`vsphere-connect` (**2017**). No official VMware/Broadcom Node SDK exists (Java, Python, Go, .NET only).
The maintained generic option (`soap`) is **WSDL-driven** — the vim25 WSDL is megabytes and *grew* in 9.0;
we would parse it at runtime to call **three methods**, get `any`-shaped results, and Zod-validate them
anyway. The WSDL machinery buys nothing.

**Scope is genuinely small (~200–300 LOC transport).** Per vCenter per poll:

1. `RetrieveServiceContent` — also yields `about.instanceUuid` (§4.2) and `about.apiVersion`.
2. `SessionManager.Login`.
3. `ViewManager.CreateContainerView` (rootFolder, `["HostSystem"]`, recursive) — **collapses the
   4–5 chained `TraversalSpec`s with `SelectionSpec` back-references into one**. This is the single
   simplification that makes hand-rolling reasonable.
4. `PropertyCollector.RetrievePropertiesEx` over the view: `name`, `parent`,
   `summary.hardware.memorySize`, `summary.quickStats.overallMemoryUsage`,
   `runtime.inMaintenanceMode`, `runtime.connectionState`.
   **`ContinueRetrievePropertiesEx` while a token is returned is MANDATORY** — large fleets paginate, and
   a missing continue-loop silently truncates the host list, i.e. **under-counts fleet capacity**.
5. `DestroyView`, `SessionManager.Logout`.

**Sessions: login → collect → logout per cycle. Do not keep sessions alive.** Sidesteps keepalive,
reconnect, and session-leak handling; login cost is negligible at a 5-minute cadence; and it holds the
"server holds no local state" invariant — no session state to lose across restarts.

`fast-xml-parser` (MIT, ESM+CJS+types, actively maintained, published via GitHub Actions OIDC trusted
publishing) is the only new runtime dependency.

### D3 — ⚠️ Units: the highest-severity correctness trap in this epic

vCenter returns **different units for the same host**, and LCM stores a **third**:

| Value | Unit |
| --- | --- |
| `HostSystem.summary.hardware.memorySize` | **bytes** (int64) |
| `HostSystem.summary.quickStats.overallMemoryUsage` | **MB** (int32) |
| `ComputeResourceSummary.totalMemory` | **bytes** |
| `ComputeResourceSummary.effectiveMemory` | **MB** |
| **LCM `MetricType{key:'memory_gb', unit:'GB'}`**, `Decimal(18,3)` | **GB** (`seed.ts:105-108`) |

**Rules:**

1. **Sum per-host `summary.hardware.memorySize` for capacity. NEVER read `effectiveMemory`.** Three
   reasons: (a) it sits in the same struct as `totalMemory` in a *different unit*; (b) its
   maintenance-mode exclusion is a **product policy LCM must own explicitly**, derived from
   `runtime.inMaintenanceMode` / `runtime.connectionState`, not silently inherited; and (c) —
   decisively — **vcsim populates it wrongly** (see below).
2. **`Σ memorySize == totalMemory` is asserted as a drift check.** vcsim aggregates `totalMemory`
   correctly, so this assertion is safe against the double.
3. **One conversion function, in `@lcm/shared`**, used by *both* the live-usage path and the
   baseline-snapshot path. They MUST agree; a live view and a baseline differing by a unit factor on the
   same cluster is a purchasing-grade bug. Normalise to bytes at the client boundary; convert to GB once,
   at the persistence boundary.

> **⚠️ vcsim's `effectiveMemory` is unit-buggy, and the bug rewards a wrong implementation.**
> `simulator/host_system.go` `addComputeResource` does `s.EffectiveMemory += h.Summary.Hardware.MemorySize`
> — adding a **bytes** value into an **MB**-documented field. For the default 3-host cluster vcsim reports
> ≈ **12,883,292,160** where real vCenter reports ≈ **12,288**. A **1,048,576×** discrepancy, in the
> direction where treating `effectiveMemory` as bytes makes the test suite **pass** and production wrong by
> six orders of magnitude — in the system that sizes hardware purchases. This is the strongest possible
> argument for rule 1.

### D3a — GB vs GiB: **resolved — it is GiB (2³⁰), base-2 end to end**

The chain is base-2 at every step, and this is VMware's stated, deliberate convention — not an accident:

- Broadcom (2025-08-19): *"vCenter continues to use the TB prefix on a base-2 calculation… our products
  predate the IEC standard and our customers prefer the traditional prefixes."*
- **govmomi's `units` package** defines `KB/MB/GB/TB` as `1 << (10 * iota)` — **1024-based constants
  carrying SI names.**
- `govc host.info` prints `h.MemorySize/(1024*1024)` labelled `"MB"` — i.e. MiB.
- **Decisive:** `govc cluster.usage` reconciles the mismatched units with
  `res.Memory.Used += int64(host.Summary.QuickStats.OverallMemoryUsage) << 20`. **`<< 20` = ×1,048,576** —
  so `quickStats.overallMemoryUsage`'s documented "MB" is **MiB**, confirmed by the reference SDK's own
  arithmetic.

So LCM's `'GB'` **is GiB**, consistent with hand-entered baselines. Corroborating: humans reading the
vSphere UI type round numbers (512, 768, 1024) — those are GiB; nobody hand-types 549.756.

```
capacityGiB = Number(memorySize) / 1073741824   // bytes → GiB (2^30)
usageGiB    = Number(overallMemoryUsage) / 1024 // MiB   → GiB (2^10)
```

**Where it lives:** one `toGiB()` helper **in the vSphere collector, at the boundary**, applied immediately
after parsing the SOAP response — before anything reaches `@lcm/shared`, services, or the forecast engine.
vSphere's mixed units are a quirk of *that* integration and must not leak past its adapter; `@lcm/shared`
carries **GiB only**, so the forecast engine never sees a vSphere unit. Round only at the display edge.

> **The 7.4% gap is real but entirely avoidable — it appears only if we convert with 10⁹.** A 512 GiB host
> would land as 549.756, **inflating apparent capacity by 7.4% and deferring hardware purchases that are
> actually needed.**

**Two things for the owner (§12 Q1 — now a confirmation, not an open question):**
1. **`unit: 'GB'` is a pre-existing mislabel** — the stored numbers are GiB. That is fine and matches
   vCenter, but it must be **recorded** (`@ai-note` on the seed + `docs/operations.md`), or someone will
   "fix" it to 10⁹ later and silently shift every forecast by 7.4%. Changing the display string to `GiB` is
   a product decision, flagged not taken.
2. *(Fixture note: vcsim's template host is 4294430720 B = **3.9995 GiB**, not exactly 4 — do not hard-code
   `4` in a fixture assertion.)*

### D4 — Test double: **vcsim**, digest-pinned

- **Provenance:** first-party component of `github.com/vmware/govmomi` (VMware's own Go SDK), Apache-2.0,
  built from `Dockerfile.vcsim` in-repo. Docker Hub `vmware/vcsim` is actively maintained (`v0.55.1`
  pushed 2026-07-03; ~524k pulls).
- **Correction:** it is **not** a Docker Official Image (those live in `library/`) and not DHI. It is a
  vendor-namespace image. Good provenance, but **pin by digest** like everything else. Test-only, so DHI
  base-image rules don't apply.
- **Verified it serves what we need:** vim25 SOAP at `/sdk` ✅; `summary.hardware.memorySize` = 4294430720
  and `summary.quickStats.overallMemoryUsage` = 1404 are populated from `simulator/esx/host_system.go` ✅;
  `CreateContainerView` + `RetrievePropertiesEx`-over-view implemented ✅; `instanceUuid` ✅.
  VI/JSON ❌; vStats ❌.
- **Multi-vCenter:** run N containers (`-l 0.0.0.0:8989`, `-dc 2 -cluster 2 -host 4`) → exercises the
  multi-vCenter path for real.
- **TLS:** `-tls` defaults **true** with a generated self-signed cert — mirrors the real VMCA situation and
  lets us test the trust path honestly.
- **Auth failures:** `-username`/`-password` produce `InvalidLogin` faults. ⚠️ **The default is permissive
  — with no `-username`/`-password`, any credentials are accepted**, so an auth-rejection test would
  silently pass for the wrong reason. Always set them explicitly.

> **⚠️ vcsim proves shape, not correctness.** All simulated hosts are identical (same 4 GiB, same 1404 MB)
> and `quickStats` is **static** — it cannot exercise usage-over-time at all. **Collector tests (vcsim) and
> forecast-maths tests (hand-built fixtures) must stay separate**, or we build false confidence in the
> number that drives purchasing.

---

## 4. Decision: data model

### D5 — **`vsphere_connections`, N rows.** The #175 singleton is dead.

The `AuthConfig` pattern does **not** transfer wholesale, for two specific reasons:

- **Degrade must be per-connection.** `AuthConfig`'s failure mode is a *global* `mode=disabled`. Here,
  connection A having an undecryptable secret must not disable connection B.
- **Do not cache decrypted secrets.** `AuthConfig` caches because it is on the hot path of *every request*.
  vCenter credentials are used by a background job every few minutes, so **decrypt-on-use** is affordable
  and keeps plaintext out of the long-lived heap. The plugin decorates the *service*, not a secret registry.

What **does** transfer, and must be copied literally: on a decrypt failure, **never null out the encrypted
column** (`auth-config.ts:144-153` — that ciphertext may be the only copy), log loudly, keep serving.

```prisma
model VsphereConnection {
  id           String   @id @default(cuid())
  tenantId     String   @default("default") @map("tenant_id")
  name         String                                  // operator label
  hostname     String                                  // https + 443 fixed; no scheme/port in the field
  username     String
  passwordEnc  String   @map("password_enc")           // AES-GCM via crypto/secret-box.ts — reused as-is

  tlsMode              String  @default("pinned") @map("tls_mode")   // 'ca' | 'pinned' — never 'off'
  tlsCaPem             String? @map("tls_ca_pem")                    // public cert — NOT encrypted (§5.4)
  tlsPinSha256         String? @map("tls_pin_sha256")                // public hash — NOT encrypted

  instanceUuid String?  @map("instance_uuid")          // discovered, never operator-entered
  apiVersion   String?  @map("api_version")

  enabled      Boolean  @default(true)
  status       String   @default("never_connected")
  lastError    String?  @map("last_error")             // sanitized; never secret-bearing
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  tenant   Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  clusters Cluster[]                                   // onDelete: Restrict — see D8

  @@unique([tenantId, name])
  @@unique([tenantId, instanceUuid], map: "vsphere_connections_tenant_instance_unique")
  @@map("vsphere_connections")
}
```

`@@unique([tenantId, instanceUuid])`: Postgres treats NULLs as distinct, so many not-yet-connected rows
coexist — the same property the repo already relies on for `hosts_tenant_serial_unique`
(`schema.prisma:148-152`). Its job: prevent adding the **same vCenter twice** under two names (FQDN + IP),
which would import every cluster twice and **double-count fleet capacity** — a silent, purchasing-relevant
corruption.

### D6 — Store `instanceUuid`; a mismatch **blocks sync**

`ServiceContent.about.instanceUuid` is globally unique per vCenter instance. This is the single most
important safety field in the model.

**Why:** MoRefs are unique only *within* a vCenter. If `vc-prod.example.com` is re-pointed (DNS change, DR
failover, rebuilt appliance reusing the name), then `domain-c123` at the new target is a **completely
different cluster**. Sync would match it by `(connectionId, externalId)` and **overwrite the wrong
cluster's hosts and capacity**, feeding wrong numbers into a purchasing forecast. Nothing else in the
design catches this.

| Scenario | `instanceUuid` | MoRefs | Behaviour |
| --- | --- | --- | --- |
| Restore from backup | same | same | Normal sync |
| Rebuilt appliance / re-pointed DNS | **new** | **reassigned** | `status='identity_mismatch'` → **block sync**, require explicit admin re-adopt |

**Rule: compare on every connect; on mismatch, refuse to sync, log loudly, never auto-heal.** Re-adopt is
an explicit admin action that re-matches clusters **by name** and rebinds `externalId`, showing exactly
what will bind to what before it commits. *(The rebuild-vs-restore semantics are asserted from vendor
behaviour, not tested — but the design fails safe either way: any mismatch blocks sync, so a wrong
assumption costs an unnecessary re-adopt, never silent corruption.)*

### D7 — Cluster identity: `(connectionId, externalId)`; keep the name constraint

```prisma
// added to model Cluster
source       String    @default("manual")           // 'manual' | 'vsphere'
connectionId String?   @map("vsphere_connection_id")
externalId   String?   @map("external_id")          // MoRef, e.g. 'domain-c123'
externalName String?   @map("external_name")        // raw vCenter name, sync-owned
nameIsCustom Boolean   @default(false) @map("name_is_custom")
lastSyncedAt DateTime? @map("last_synced_at")

connection VsphereConnection? @relation(fields: [connectionId], references: [id], onDelete: Restrict)

@@unique([connectionId, externalId], map: "clusters_connection_external_unique")
```

**MoRefs are stable across renames** (verified against govmomi), so sync matches on `externalId`, notices
`externalName` changed, and updates the label. Name-matching would treat a rename as delete+create and
**destroy the baseline history**.

**The name collision is real and #176 does not mention it:** `Cluster` has
`@@unique([tenantId, name])` (`schema.prisma:87`), and two vCenters each having a cluster named
`Production` is normal. Sync would fail on day one with `CLUSTER_NAME_TAKEN` (`clusters.ts:18-23`).

**Resolution: keep the constraint; decouple the label.** Dropping it would put two clusters both named
"Production" in the fleet console — a genuine UX failure, since the user cannot tell which one needs
hardware. Widening to `@@unique([tenantId, connectionId, name])` would silently regress manual clusters
(NULLs distinct ⇒ no uniqueness). Instead: `name` is an LCM display label **seeded** from vCenter and
qualified deterministically on collision (`"Production (vc-prod-zrh)"`, ordered by `connection.createdAt`
so sync stays idempotent); `externalName` tracks vCenter verbatim; editing `name` sets `nameIsCustom=true`
and sync never touches it again.

### D8 — ⚠️ Connection delete: **`onDelete: Restrict` + explicit detach. NEVER cascade.**

This is the epic's most dangerous data-safety decision, and the reason is concrete, not theoretical:

> `ClusterMetricBaseline` **already cascades** from `Cluster` (`schema.prisma:110`), as do `Host` (`:130`)
> and `ClusterSettings` (`:98`). So `onDelete: Cascade` on the connection FK would chain:
> **delete connection → delete clusters → delete every baseline.** One admin misclick in Settings silently
> destroys the entire purchasing history this epic exists to accumulate — and it would not even look
> destructive at the click site. That is a direct Golden Rule 3 violation.

`onDelete: SetNull` is also wrong: it leaves `source='vsphere'` with a null `connectionId` — an
inconsistent row no code path expects.

**Design:**
1. The DB **refuses** the delete while synced clusters reference the connection (the constraint is the
   backstop, so no application bug can bypass it).
2. `DELETE /api/vsphere/connections/:id` → **409**, listing affected clusters and their baseline counts —
   scope and consequences, per `CLAUDE.md`'s destructive-action rule.
3. **Detach** (`POST .../connections/:id/detach`), one transaction: set `source='manual'`, null the sync
   fields, then delete the connection. **Every cluster, host, and baseline survives** and the clusters
   become ordinary manual clusters — exactly the pre-vSphere state the app already supports.
4. **Steer operators to `enabled=false`, not delete.** "Stop syncing" is the common intent; disable keeps
   every mapping intact. Delete stays rare and deliberate.

### D9 — Per-connection status

`status ∈ { never_connected, active, unreachable, auth_failed, tls_untrusted, cert_mismatch,
identity_mismatch, secret_undecryptable, disabled }` — each per-connection; healthy connections keep
syncing. `secret_undecryptable` **preserves `passwordEnc` untouched** (the `auth-config.ts:144-153` rule).
`lastError` is sanitized before storage.

---

## 5. Decision: TLS policy for self-signed VMCA

### D10 — ⚠️ Verified **empirically**, on the real toolchain — and it refutes the obvious design

Both security teammates independently built probes against real self-signed and real VMCA-chain TLS
servers on the installed stack (**Node v26.5.0, undici 8.6.0/8.7.0, `@types/node` 26.1.0**), counting
`checkServerIdentity` invocations. The results overturn the design that "reads correct":

| Server | Client options | Result | `checkServerIdentity` calls |
| --- | --- | --- | --- |
| self-signed leaf | `rejectUnauthorized:true`, no `ca` | FAILED `DEPTH_ZERO_SELF_SIGNED_CERT` | 0 |
| self-signed leaf | **`rejectUnauthorized:false`** + spy | **CONNECTED** | **0** ⚠️ |
| VMCA chain | **`rejectUnauthorized:false`** + spy | **CONNECTED** | **0** ⚠️ |
| self-signed leaf | `ca:[cert]` + `rejectUnauthorized:true` | CONNECTED | **1** ✅ |

**The mechanism, now precise:**

> **`checkServerIdentity` is invoked if and only if OpenSSL chain verification SUCCEEDS.** It is gated on
> `verifyError` being empty — **not** on `rejectUnauthorized`. Node computes `verifyError` first and only
> then calls `checkServerIdentity`; `rejectUnauthorized` is consulted *afterwards*, purely to decide
> whether to destroy the socket.

> ### ⚠️ The trap this design MUST NOT walk into
> An implementer writes `rejectUnauthorized:false` + a thumbprint check inside `checkServerIdentity`, tests
> against their vCenter, sees it connect, and ships. **The thumbprint check never executed once.** The code
> reads as pinned; it is `curl -k`. It fails **open**, **silently**, with green tests — the worst possible
> failure mode for the control C1 depends on.
> **`checkServerIdentity` MUST NOT be used to implement thumbprint pinning.**
> *(govmomi does implement TOFU — but in Go, whose `crypto/tls` exposes `InsecureSkipVerify` +
> `VerifyPeerCertificate`, a hook that **does** run on verification failure. **Node has no equivalent.** The
> govmomi model does not port. This is exactly the cross-language API assumption that needs testing, not
> recall.)*

### D11 — **Pin the root of the presented chain as a `ca:` trust anchor.** No insecure flag on the credential path.

Verified end-to-end (`probe4.mjs`) across **both** real-world vCenter cert shapes with **one uniform code
path**:

| Server shape | Pin (= `chain[last]`) | Steady-state result |
| --- | --- | --- |
| Self-signed leaf (ESXi-style) | the leaf itself | **CONNECTED**, identity check ran 1× |
| **VMCA leaf + VMCA root (default vCenter)** | the VMCA root | **CONNECTED**, identity check ran 1× |
| Negative control: wrong root | — | **FAILED** ✅ |

```js
// Phase 1 — TOFU capture. NO credential, no request body. The ONLY place rejectUnauthorized:false appears.
//   walk getPeerCertificate(true).issuerCertificate to the root; keep root DER → PEM.
// Steady state — no insecure flag anywhere:
new Agent({ connect: { ca: [pinnedRootPem], rejectUnauthorized: true, lookup: pinnedLookup(vettedIp) } });
```

**Why this is strictly better than a custom-connector fingerprint check** (which also works, and was the
fallback considered):

1. **No `rejectUnauthorized:false` in steady state at all** — it is confined to the credential-free capture
   phase. The dangerous shape never appears on the credential path.
2. **Fails closed in OpenSSL, not in app code.** No app-layer check to forget, skip, or refactor away. A
   connector-based fingerprint check puts `rejectUnauthorized:false` into steady-state code, where one
   refactor dropping the fingerprint line silently reverts it to `curl -k`.
3. **Hostname verification comes back for free** — the chain now validates, so `checkServerIdentity` runs.
   Binding becomes *"a cert for this hostname, issued by this exact VMCA"* — strictly stronger than a bare
   fingerprint, which the connector approach loses entirely.
4. **Survives routine leaf auto-renewal** (the decisive lifecycle win — see below).
5. **Uniform:** pin `chain[last]`. For a self-signed leaf, root == leaf, so it degenerates to exact leaf
   pinning automatically. **One code path, both shapes** — which also dissolves the root-vs-leaf debate.

> **⚠️ Non-obvious trap, measured:** pinning the **leaf** via `ca:` does **not** work when the server
> presents a chain — `ca:[leaf]` against the VMCA server FAILED with `SELF_SIGNED_CERT_IN_CHAIN`, because
> OpenSSL builds the chain from what the server sent and must terminate at a *self-signed* anchor it
> trusts; a trusted leaf mid-chain doesn't terminate it (no `X509_V_FLAG_PARTIAL_CHAIN`, which Node
> doesn't expose). **Pin the root of the presented chain, not the leaf.** An implementer will otherwise try
> `ca:[leafPem]` first, watch it fail against real vCenter, and "fix" it with `rejectUnauthorized:false`.

**Use SHA-256, reject SHA-1.** govmomi has `ThumbprintSHA256` (v0.36.1+) and `govc about.cert -thumbprint`
emits **SHA-256 by default** — so SHA-256 is both correct *and* what the admin's out-of-band confirmation
command actually prints. *(vCenter's own `HostConnectSpec.sslThumbprint` remains SHA-1 for legacy reasons —
do not let that pull the design back.)*

### D11a — The corrected rule, for code and docs, verbatim

> **`rejectUnauthorized: false` is permitted in exactly one place: the TOFU certificate-capture probe,
> which sends no credential and no request body. The credential-bearing path and the scheduled poll MUST
> use `ca: [pinnedRootPem] + rejectUnauthorized: true`.**
>
> **`checkServerIdentity` MUST NOT be used to implement thumbprint pinning.** It is not called when chain
> verification fails (measured: 0 invocations, Node 26.5.0), so a thumbprint check placed there **never
> runs and every connection silently succeeds against any certificate.**

**Resolution order at connect:** pinned root → system roots → **refuse to sync.** The last step is what
makes "verification is never silently disabled" *structurally* true: an unconfirmed connection is not a
connection that syncs insecurely — it is a connection that **does not sync**. There is no code path from
unconfigured to connected.

**⚠️ Two facts that decide which mode is viable — and they point in opposite directions:**

1. **Default VMCA Machine SSL certs carry the FQDN in the SAN and no IP SAN** unless deliberately added.
   Node's `checkServerIdentity` **requires an `iPAddress` SAN** to validate a connection to a literal IP —
   it does not fall back to CN. **So if LCM addresses vCenter by IP, `ca` mode fails with
   `ERR_TLS_CERT_ALTNAME_INVALID` even with the correct root loaded and a perfectly valid chain.** That is
   a *hostname* failure, not a *trust* failure, and no CA plumbing fixes it. **→ §12 Q2 is blocking.**
2. **The Machine SSL leaf auto-renews unattended** on vCenter 8.0U3h+ / VCF 9.0.2+ (KB 427937;
   `autoRenewThreshold` default: 10 days before expiry; `daysValid` default **730 days**, KB 425527).
   **So a leaf pin is guaranteed to break on its own, on a ~2-year timer, with no human involved.** The
   VMCA **root** changes only when an admin deliberately regenerates it or rebuilds vCenter — i.e. exactly
   when you *want* re-confirmation.

**→ Prefer `ca` mode (uploading the VMCA root PEM, downloadable from vCenter's documented
`/certs/download.zip`). CA-upload *is* root-pinning, and it makes automatic leaf renewal a non-event.**
Use `pinned` only where `ca` is not viable — principally IP addressing.

> **Note the divergence from ecosystem convention, deliberately:** govmomi (`soap.ThumbprintSHA1`),
> PowerCLI, and `vic-machine --thumbprint` all pin the **leaf**. Those are *interactive, short-lived*
> tools where a spontaneous break is immediately visible to a human at a terminal. Ours is an
> **unattended background job**, where the same break is a silent stop. Do not "fix" this to match
> govmomi. `@ai-warning` this at the implementation site.

**Unverified, and it gates `pinned`-as-root-pin:** whether vCenter actually **sends the VMCA root in its
handshake chain** (servers commonly omit the root). If it does not, TOFU can only pin the *leaf*, and the
fallback inherits the auto-renewal break. **Must be confirmed against the real vCenter at implementation
time**; if it fails, `ca` mode becomes mandatory and IP addressing becomes unsupported.

### D12 — Rotation is a fail-safe, visible event

Never auto-re-pin (that makes the pin decorative). Never fall back to skip-verify (`CLAUDE.md`: security
failures MUST NOT silently fall back to weaker defaults). On mismatch: `status='cert_mismatch'`, stop
syncing **that connection only**, log **one** clear line — a pin mismatch is not transient and must not
ride the backoff ladder — and raise a UI banner naming expected vs presented fingerprint. **The forecast
keeps working**: a failed sync appends nothing; append-only means "sync failed" and "sync wrote something
wrong" are *structurally* different outcomes and only the former is reachable.

**A pre-existing tripwire already catches a silently-stopped sync:** `isBaselineStale` /
`STALE_BASELINE_DAYS` (`apps/web/src/components/fleet/stale-baseline.ts:24`) already drives a stale flag on
the fleet tile and cluster panel. Warn at 30 days before leaf expiry via `getPeerCertificate().notAfter`,
matching the vSphere Client's own 30-day alarm.

### D13 — CA PEM and fingerprint are **stored plaintext, not `secret-box`-encrypted**

A CA certificate is public by construction — vCenter serves it unauthenticated and presents it in every
handshake; a fingerprint is a hash of public data. Encrypting either protects a secret that does not exist.
Only `passwordEnc` is encrypted.

---

## 6. Threat model — the connection-test endpoint and the scheduled poll

### 6.1 The reframe

The obvious framing — *"the OIDC `isPrivateAddress` deny-list inverts, so build an allow-list"* — **solves
the wrong problem.** Two primitives hide here, with very different severities:

| Primitive | What the attacker gains | Severity |
| --- | --- | --- |
| Network scan oracle | Port/host enumeration **from LCM's network position** | Low–Moderate, largely redundant |
| **Stored-credential exfiltration** | The **vCenter service-account credential**, cleartext, to a host they control | **Critical** |

An IP/CIDR allow-list addresses the first and **does nothing** about the second: the attacker's own
workstation is already a legitimate private address. A "private IPs allowed" list happily permits
exfiltration to `https://10.20.30.40/`.

**The control that matters is a data-flow rule, not a network rule.**

### 6.2 ⚠️ The near-miss already in the codebase — the most important thing in this document

`routes/settings-auth.ts:154-170` **already implements the dangerous shape**: a caller-supplied
`issuerUrl` combined with a fallback to the **stored** `clientSecret`.

**It is not currently a vulnerability — and the reason is an accident of protocol.** `client.discovery()`
only fetches the issuer's *public* metadata and never transmits the secret. The authors knew this; the
docstring on `sanitizeDiscoveryError` (`plugins/oidc.ts:48-53`) says so explicitly.

**vim25 `Login` DOES transmit the credential.** Copying this in-repo precedent — the natural thing for an
implementer to do, since it carries reassuring security comments — converts an accidentally-safe pattern
into a **critical credential-disclosure endpoint**. This must be `@ai-warning`-ed at both new routes.

### 6.3 Trust boundaries

- **TB-1 — Untrusted → API.** In `AUTH_MODE=disabled` (**production today**) this boundary is *open*:
  every request gets an anonymous ADMIN principal. There is no authentication boundary.
- **TB-2 — LCM server → outbound.** The `server` service has **no egress restriction** and compose
  declares no `networks:` block, so it reaches anything the Docker host can route to.
- **TB-3 — LCM server → its own secrets.** The server holds `CONFIG_ENCRYPTION_KEY` and can decrypt at
  will. **Nothing but application logic sits between the API surface and the plaintext credential.** This
  is the boundary the design defends.

**Attacker:** unauthenticated caller with network reachability to LCM's API; can run arbitrary tooling from
their own machine and control a host with a DNS name and TLS listener. Not an external internet attacker
(no public exposure).

### 6.4 Threats and controls

| # | Asset | Threat | Impact | Control |
| --- | --- | --- | --- | --- |
| T1 | **Stored vCenter credential** | Caller supplies attacker URL; server decrypts and sends `Login` to it | **Critical** — vSphere estate compromise | **C1**, **C6** |
| T2 | Internal topology | Error/timing differentiation enumerates hosts+ports from LCM's position | Low–Mod (∝ segmentation) | C2, C4, C5 (all partial) |
| T3 | Internal HTTP services | Fixed SOAP `Login` POST as blind write | Low | C2 (https-only, no redirects) |
| T4 | Cloud metadata (169.254.169.254) | IMDS credential theft | Negligible on-prem; hedges drift | C3 |
| T5 | **Scheduled poll** | Attacker edits the **saved** URL and waits — the next unattended poll delivers the credential, no test endpoint needed | **Critical** | **C1 rule 3** |
| T6 | Credential in transit | Self-signed cert + blanket skip-verify → MitM harvests credential **on every poll** | **High** | **C6** |
| T7 | Internal DNS names | TOFU probe returns cert SANs → internal-hostname disclosure | Low–Mod | C4a |

### 6.5 Controls

**C1 — ★ *the* control. Restated to cover the scheduler, which is the primary target.**

> **The generative principle (this replaces case-by-case reasoning):**
> **In `disabled` mode, every API-drivable flow is attacker-drivable. The only asymmetry between the
> legitimate admin and an anonymous attacker is *knowledge of the vCenter password*. Therefore any
> invariant that must hold in `disabled` mode MUST be gated on the password.** No flow design, signed
> confirmation token, or "human confirms the thumbprint" step can substitute — the attacker drives the flow
> too, and **there is no human to consult.**

**The attack needs no test endpoint at all (T5):** in `disabled` mode the attacker writes the saved
connection's `url` → their host, waits, and the scheduled poll delivers the decrypted credential —
unattended, repeatedly, forever. That is *strictly better for the attacker* than the test endpoint: no
interaction, persistent, and it survives deleting the test endpoint entirely. **Protecting only the test
endpoint would have protected nothing.**

> **C1: Stored credentials may only be sent to a destination whose *trust material* was written by someone
> who knew the password.**
> **Any mutation to a connection's trust material MUST carry the current password. Reads and probes MUST
> NOT require it.**

**Trust material** = *where credentials go* (`hostname`, `username`) + *what proves the destination's
identity* (`tlsMode`, `pinnedCaPem`). One rule, covering the test path, the write path, and the poll.

**The split probe (adopted):**

| Phase | Endpoint | Sends credential? | Needs password? |
| --- | --- | --- | --- |
| **P1 — reachability + cert capture** | `POST …/probe` (URL in body) or `…/:id/probe` | **No** — TCP/TLS handshake only | **No** |
| **P2 — verify login** | `POST …/verify` | Yes | **Yes** (body; no fallback) |
| **Trust / re-trust** | `POST …/:id/trust-ca` | No | **Yes** (mutates trust material) |

1. P2's schema **requires** the password: `z.string().min(1)`, never `.optional()`. **No `?? stored`
   fallback, ever** — enforced in the `@lcm/shared` contract so both sides see it.
2. The saved re-test route **takes no URL at all** — it cannot be pointed anywhere. Better than comparing a
   supplied URL to the stored one: an absent parameter cannot be defeated by a comparison bug (case,
   trailing slash, unicode, port normalisation). **Design out the class; don't guard it.**
3. **Security win beyond convenience:** P1/P2 means **a credential is never sent to a certificate that
   hasn't been vetted.** It also confines `rejectUnauthorized:false` to P1, which sends nothing (D11).
4. **UX win:** when the cert already validates against system roots or an existing pin, the UI runs P1→P2
   in one click — the thumbprint interstitial appears **only** when TOFU is genuinely required.
5. **A signed-confirmation-token design to let re-trust skip the password was explored and rejected**: in
   `disabled` mode the attacker calls `probe` and `trust-ca` themselves. The token proves the server
   observed the cert; it proves nothing about *who asked*. It is theatre in the exact mode production runs.
6. **Pleasant property:** C1 holds even against a *malicious admin* who doesn't know the password.

**C2 — URL constraints + resolve-and-pin.** https only; **reject userinfo** (`url.username||url.password`
— blocks `https://vcenter.corp.local@attacker.example/` parser-differential tricks); port allow-list
`{443, 8443}` (removes 22/5432/6379/3306/8080/9200… from T2's reach); `redirect: 'error'`; parse **once**
with WHATWG `new URL()`; `AbortSignal.timeout(10s)`; resolve all A/AAAA, vet each, then connect to a vetted
address via `connect.lookup` (verified typed, D10) so the check applies to the address actually connected
to — closing the TOCTOU the OIDC path openly accepts in its `@ai-warning` (`oidc.ts:167-175`).

**C3 — Residual deny-list (inverted from OIDC).** Deny loopback (`127/8`, `::1`), unspecified
(`0.0.0.0`, `::`), link-local + IMDS (`169.254/16`, `fe80::/10`), and IPv4-mapped forms of all of them.
**Explicitly permit** `10/8`, `172.16/12`, `192.168/16`, `fc00::/7`, `100.64/10`. **That inversion is the
whole point and MUST be commented as such**, or someone will "notice the inconsistency" with the OIDC
deny-list and re-add RFC1918, breaking every legitimate deployment. Factor the existing careful IPv4/IPv6
classifier out of `oidc.ts` (it already handles the `::ffff:7f00:1` mapped-form trap) and give it a
purpose-specific predicate. **Honest expectation:** its present value is *low* — `db` is a separate
container at a private IP indistinguishable from a vCenter, so this **cannot** protect the database. It is
~10 lines hedging deployment drift, not the control doing the work.

**Any relaxation flag must be server-side config only, never request-body.** `oidc.ts:192-208` spells out
why: a caller-supplied flag that disables the caller's own deny-list is not a control. *Recommendation: do
not add the flag at all in v1.*

**C4 — Flatten the error surface** to a closed enum — `ok | unreachable | tls_untrusted | not_a_vcenter |
auth_failed` — deliberately diverging from the OIDC precedent, which returns the raw error string. Merge
`ECONNREFUSED`/`ETIMEDOUT`/`EHOSTUNREACH`/`ENETUNREACH` into `unreachable`, collapsing the cleanest
scanning distinctions. Detail goes to the server log, correlated by pino request id.
**Honest limits: this blunts, it does not close.** `unreachable` vs `tls_untrusted` still separates
"closed" from "open+TLS", and timing still separates refused from filtered. Constant-time responses are
rejected as theatre (they'd pad every response to ~10s and the attacker still reads the enum).
**→ §12 Q5: this costs real admin debuggability.**

**C4a — TOFU disclosure (resolves the tension between C4 and TOFU).** The probe returns **the SHA-256
fingerprint and validity dates only** — *not* subject, issuer, or SANs. A fingerprint is a hash: useless
for enumeration, sufficient for out-of-band confirmation against the vSphere Client or `govc about.cert`,
which is what an admin actually compares. This keeps TOFU usable without turning the endpoint into an
internal TLS scanner that discloses hostnames (T7).

**C5 — Per-route rate limit** ~10/min/IP. A speed bump, not a boundary — the global 300/min lets a
/24 × 5-port sweep finish in ~4 minutes; 10/min makes it ~2 hours, which stops opportunistic automation and
not a patient attacker. Include it because it's ~free; **do not count it in the security argument.**

**C6 — TLS: §5. ★ second load-bearing control.** Without it, C1 collapses: with verification off, "the
stored URL" no longer identifies a *host*, and a MitM harvests the credential on **every scheduled poll**,
silently, on the happy path, with no attacker interaction with the API at all.

**C7 — Bootstrap-safe admin gate.** Mirror `settings-auth.ts:78-83` verbatim: open while
`mode==='disabled'` (there are no accounts to authenticate against — requiring a real ADMIN would make the
feature unusable in the mode production runs today), hard admin-gated once `local`/`oidc` is on.
**Defensible only because C1 removes the critical primitive.**

**C8 — Read-only vCenter service account (operations doc). Highest value-to-effort ratio here.** LCM only
reads; it has no reason to hold a write-capable account. This is the **only** control that limits *blast
radius* rather than *probability* — every other control assumes the credential stays put; this one assumes
it won't. Cost: a doc paragraph and five minutes in the vCenter UI. Value: turns "virtualization estate
compromise" into "capacity data disclosure" — data the attacker could already read from LCM's own API in
`disabled` mode.

> **If only two controls are adopted, they must be C1 and C8.**

### 6.6 Compliance — stated honestly

The project targets **OWASP ASVS 5.0 Level 1** (recorded 2026-07-16). Checked against the actual v5.0.0
text: **1.3.6** (SSRF allowlist) is **L2**; **1.5.3** (consistent URL parsing) is **L3**; **2.4.1**
(anti-automation) is **L2**. **No SSRF or anti-automation requirement is Level 1.**

This cuts both ways, deliberately: it is **not** licence to do nothing — the T1 credential risk is real,
severe, and cheap to close, and compliance floors are not threat models. But it **is** reason to reject
expensive, low-yield machinery. Anything justified only by *"ASVS says allowlist"* is theatre here. If the
owner wants ASVS 1.3.6 formally ticked, that is a **decision to move this surface to L2** and must be
recorded as such, not smuggled in.

### 6.7 What the attacker actually gains — the honest answer

Mostly nothing they didn't have, **with one exception that is the whole ballgame**: they are already on the
internal network and can `nmap` from their own machine. But **vCenter management networks are commonly
segmented away from user VLANs** — that is standard vSphere practice, and this feature *implies* LCM can
reach that network. If LCM sits where the attacker cannot, **LCM is a proxy across a segmentation boundary
they cannot otherwise cross.** That is genuine privilege escalation, and its severity is entirely a
function of the deployment's segmentation, which LCM cannot know. **→ §12 Q3.**

### 6.8 Residual risk (with C1–C8 adopted)

| # | Residual | Level | Why accepted |
| --- | --- | --- | --- |
| R1 | Binary reachability oracle on 443/8443 from LCM's position, in `disabled` mode | Low–Mod (∝ segmentation) | **Irreducible** — a connection-test feature must report reachability. Closing it means deleting the feature. **Eliminated** by moving off `disabled`. |
| R2 | Authenticated ADMIN can probe | Low | That is the *authorized* use of the feature. |
| R3 | Timing side channel survives C4 | Low | Constant-time rejected as theatre. |
| R4 | vCenter may not send the root in its chain → `pinned` degrades to a leaf pin that breaks on auto-renewal | **Unverified** | Must be confirmed at implementation; `ca` mode is the fallback. |
| R5 | ASVS 1.3.6 (L2) not formally met | Accepted | Project targets L1; allow-list rejected **on merit**, not cost. |

**Overall:** with C1 and C6, this endpoint is **not meaningfully more dangerous than the OIDC discovery
endpoint the project already ships and documents** — and it is better built, because C2's resolve-and-pin
closes a TOCTOU the OIDC path accepts. The severe primitive (T1) is **designed out**, not mitigated.

### 6.9 Documented caveat

A `> **SECURITY NOTE — vCenter connection testing.**` block will be added to `docs/operations.md`
alongside the existing OIDC note (`:346-358`), matching its register: private addresses are *permitted*
(a vCenter is private by definition); while auth is disabled anyone reachable can probe whether an internal
host answers TLS **from the server's network position**; responses are coarse and rate-limited; stored
credentials are **never** sent to a request-supplied URL; changing a saved URL requires re-entering the
password; untrusted certs are pinned to an out-of-band-confirmed anchor and a change fails rather than
trusts; **use a read-only service account**.

---

## 7. Decision: scheduler

### D14 — **Hand-rolled. No dependency.**

Registry facts checked: `croner` 10.0.1 (MIT, **0** deps, real ESM), `node-cron` 4.6.0 (ISC, 0 deps, single
maintainer), `toad-scheduler` 4.1.0 (CJS-first, wraps croner), `@fastify/schedule` 6.0.0 (CJS, oldest
release, a wrapper around a wrapper), `bree` 9.2.9 (**8** transitive deps, worker-thread runner, wildly
over-scoped).

**None of them solve any hard part of this problem.** Persistence, downtime catch-up, idempotency,
cross-process claim, and shutdown draining are 100% ours regardless. All a cron library contributes is
*"has the wall clock passed X?"* — which, against a persisted `dueAt`, is the expression `dueAt <= now()`.
Worse, **they are all in-memory schedulers**: they forget everything on restart, and our single hardest
requirement (#178 catch-up) is precisely what an in-memory scheduler cannot do. We would carry the
dependency *and* still write the whole persistence layer. And we do not want a cron DSL — there is one
monthly shape and one interval shape; exposing `0 0 1 * *` is a support burden and a timezone footgun.

The hand-rolled core is ~80 lines. *(If ever revisited: `croner`. Not `bree`.)*

### D15 — Shape: 60s tick over a persisted `dueAt`

```prisma
model ScheduledJob {
  name         String    @id            // 'vsphere.snapshot' | 'vsphere.sync:<connId>' | 'vsphere.poll:<connId>'
  dueAt        DateTime  @map("due_at")
  lastRunAt    DateTime? @map("last_run_at")
  lastStatus   String?   @map("last_status")
  lastError    String?   @map("last_error")     // sanitized
  failureCount Int       @default(0) @map("failure_count")
  runningSince DateTime? @map("running_since")  // lease; NULL = unclaimed
  lockedBy     String?   @map("locked_by")      // process boot uuid

  @@index([dueAt])
  @@map("scheduled_jobs")
}
```

> **⚠️ SUPERSEDED — a generic `ScheduledJob` table keyed by an encoded `name` string is rejected.** It has
> **no FK and cannot cascade**, so orphan rows would tick and fail forever against a deleted connection;
> and independent rows with independent `dueAt` **cannot express "sync before snapshot"** (D22). It is also
> speculative generality — there is exactly one job family here.

### D15a — **One job row per connection** (`connectionId` is **both PK and FK**, `onDelete: Cascade`)

```prisma
model VsphereConnectionJob {
  connectionId String    @id @map("vsphere_connection_id")   // PK *and* FK
  dueAt        DateTime  @map("due_at")
  runningSince DateTime? @map("running_since")
  lockedBy     String?   @map("locked_by")
  failureCount Int       @default(0) @map("failure_count")
  lastPollAt         DateTime? @map("last_poll_at")
  lastSyncAt         DateTime? @map("last_sync_at")
  lastSyncStatus     String?   @map("last_sync_status")
  lastSnapshotAt     DateTime? @map("last_snapshot_at")
  lastSnapshotPeriod DateTime? @db.Date @map("last_snapshot_period")
  lastSnapshotStatus String?   @map("last_snapshot_status")
  lastSuccessPeriod  DateTime? @db.Date @map("last_success_period")   // D16a layer 2

  connection VsphereConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  @@index([dueAt])
  @@map("vsphere_connection_jobs")
}
```

**Ordering becomes sequential statements inside one claimed job body** — the simplest possible expression
of the dependency, with no cross-job race to reason about because there is no second row to race:

```
claim(connectionId)
  → if (syncDue || snapshotDue) runSync()      // the snapshot FORCES a sync first
  → if (snapshotDue && syncOk)  runSnapshot()
  → if (pollDue)                runPoll()
  → release; dueAt = min(nextPoll, nextSync, nextMonthBoundary)
```

One claim per connection makes intra-connection concurrency **structurally impossible** rather than
defended against, gives #178's per-activity job status for free, and eliminates the orphan problem entirely
(job rows die with the connection, enforced by Postgres).

> **Reconciling `Cascade` here with D8's "never cascade" — the principle is not "cascade is bad":**
> **Cascade is correct for regenerable operational state; forbidden for irreplaceable user data.**
> Baselines are irreplaceable (a destroyed August cannot be re-measured — the moment is gone) ⇒ `Restrict`
> + explicit detach. Scheduler rows and the usage cache are pure derived state, rebuilt on the next tick ⇒
> `Cascade`. D8's detach flow composes cleanly: detach clusters → delete connection → job rows and usage
> samples cascade away, while **every cluster, host, and baseline survives**.

### D16 — Catch-up **is the data model, not a code path**

`dueAt <= now()` *is* catch-up: server down three days ⇒ `dueAt` two days past ⇒ the first tick after boot
runs it. No "did I miss one?" branch to get wrong, no boot-time special case to test separately.

**Missed months must not stampede:** on success, `dueAt = firstOfNextMonthUtc(now)` — computed **forward
from now**, never `dueAt + 1 month`. Three missed months produce **one** catch-up run, not three. (Three
snapshots of *today's* usage backdated to three past months would be **fabricated data** — actively
harmful in a purchasing forecast.)

> **⚠️ D16a — a failed snapshot MUST NOT consume its month. The unambiguous rule:**
>
> **The period written is `startOfUtcMonth(measuredAt)` — always derived from the clock at measurement
> time, never from `dueAt`.**
> **On success:** `dueAt = firstOfNextMonthUtc(now)`; `failureCount = 0`; `lastSuccessPeriod = P`.
> **On failure:** `dueAt = now + backoff`; `failureCount += 1`. **No period advance. Ever.**

**Deriving the period from `measuredAt` rather than `dueAt` makes staying in-period *emergent*, not an
invariant someone must remember**: a retry on 3 Aug still computes `2026-08-01` by itself, so no "clamp the
backoff within the period" rule is needed — and that clamp is exactly the version that eventually breaks.

**Backoff cap = 1 hour** (not OIDC's 60s, not the poll's 5 min). Worst case ~740 retries/month against a
dead vCenter — one API call each, trivial. Retrying *often* is actively desirable: the earlier in August we
catch a recovery window, the more representative August's baseline is. Log `error` on the healthy→failing
transition and `warn` thereafter, so 740 lines aren't 740 alarms.

**vCenter down all August ⇒ 1 Sep writes September only; August is an honest gap.** A backdated August
built from September's usage is not missing data — **it is wrong data that looks real**, entering a
purchasing trend as a fact. **A gap is visibly absent; a fabrication is invisibly wrong.** In a tool whose
output buys hardware, that asymmetry decides it.

**A missed period gets three signals, because they answer different questions:**
1. **During the outage:** `lastSnapshotStatus='failed'`, `failureCount`, `lastError` — *"is it broken now?"*
2. **At recovery:** `lastSuccessPeriod @db.Date`. On success for period `P`, if
   `monthsBetweenUtc(lastSuccessPeriod, P) > 1`, log a loud `warn` naming the skipped months and surface
   "Missed: Aug 2026" in the settings panel (reuses existing `monthsBetweenUtc`) — *"did we lose anything?"*
3. **Permanently and authoritatively — the baseline history itself.** A month with no baseline between two
   that have one **is** the gap. Derived from data, so it cannot drift out of sync the way a stored flag
   can. **Layer 3 is the truth**; layer 2 is an ops convenience.

> **⚠️ A hard UI requirement falls out of this, and it is not optional (#177's chart):** a gap MUST render
> as a **break in the line, never an interpolation** (Recharts `connectNulls={false}`). If the chart
> silently connects July to September, a missed month becomes an **invisible smoothing of exactly the trend
> that drives purchasing** — converting the honest gap into a fabrication at the last step and undoing the
> entire argument above.

### D17 — Idempotency: **the database enforces it**

Application-level "have I run this period?" is exactly the guard that fails under the concurrency it exists
to prevent. **Resolved in favour of making `capturedAt` itself the period anchor** (D19) with
`@@unique([clusterId, metricTypeId, capturedAt])`, so the monthly job writing first-of-month makes the
constraint *be* monthly idempotency — natively Prisma-expressible, no second column, no partial index.

*(A rejected alternative — a separate `periodMonth` column with a partial unique index or a generated
column — is **not** expressible in Prisma 7 and would reintroduce precisely the schema-drift pain that
migration `20260705080919_fix_hosts_serial_unique_index` / issue #123 was written to eliminate. Rejected.)*

### D18 — Concurrency: do it now (~6 lines), and **not** with advisory locks

Not premature, for a reason unrelated to replicas: **`docker compose up -d` overlaps containers.** The old
container drains for up to 10s (`index.ts:6,17-24`) while the new one boots and ticks — a genuine
double-run window **on today's single-instance deployment**.

```sql
UPDATE scheduled_jobs SET running_since = now(), locked_by = $1
 WHERE name = $2 AND due_at <= now()
   AND (running_since IS NULL OR running_since < now() - interval '15 minutes')
RETURNING *;
```

Atomic; 0 rows ⇒ someone else owns it, skip. The 15-minute clause doubles as a **stale-lease breaker** so a
hard-killed process self-heals instead of wedging forever.

**Not `pg_advisory_lock` / `FOR UPDATE SKIP LOCKED`:** both bind to a session/transaction, and Prisma's pg
adapter uses a **connection pool** (`plugins/prisma.ts:19-25`) — a session lock can't be reliably held
across awaits without pinning a connection, and `pg_advisory_xact_lock` would hold a transaction open for
the entire vCenter round-trip (`idle in transaction` for seconds-to-minutes). The claim-row UPDATE holds no
lock while the job runs. Parameterized `$queryRaw` has precedent (`routes/health.ts:10`) and does not
conflict with the "no raw queries" guidance, which is about SQLi.

### D19 — Time: **UTC, 1st of month, 00:00**

Not arbitrary — it is what the repo already does (`formatDateIso` slices `toISOString()`; `addUtcMonths` /
`monthsBetweenUtc` are UTC-based; every date column is `@db.Date`). A local/DST-aware schedule would import
a concept this codebase does not have into the one job that writes purchasing data.

**Reuse `addUtcMonths`, and note the trap it documents:** it *clamps* day-of-month ("Jan 31 + 1mo = Feb
28"). **Anchoring to day 1 sidesteps clamping entirely** — anchoring anywhere else would silently drift the
schedule to the 28th forever after one pass through February. The month-boundary helper belongs in
`packages/shared/src/dates.ts` beside its siblings, where it is unit-testable without a DB.

### D20 — Testability: the binding constraint, and it rules out the obvious approach

Two verified facts: the suite uses **fake timers nowhere** (zero hits for `useFakeTimers`/`setSystemTime`
in `apps/server/src/__tests__/`), and **`vi.mock` is unreliable here** — `vitest.config.ts` sets
`isolate: false`, and `oidc-plugin.test.ts:27-33` documents that `vi.mock('openid-client')` was empirically
found to **silently stop intercepting** once other files importing the same module join the run (its
workaround is a real controllable HTTP server).

**So the scheduler must be testable without controlling time at all:**
- Expose **`runDueJobs(): Promise<void>`**; the `setInterval` merely calls it. Tests call it directly —
  never start the timer, never sleep, never fake time.
- **To test "a month passed", move the data, not the clock**: update `dueAt` into the past, call
  `runDueJobs()`, assert.
- Inject `Clock { now(): Date }` only to assert *which period* is written.
- **Do not start the timer when `NODE_ENV==='test'`**, mirroring how `server.ts:66-77` already skips
  rate-limit and under-pressure in test.
- Inject the vCenter client behind an interface; vcsim is for the *client* suite, not the scheduler suite.

### D21 — Graceful shutdown

`onClose`: stop the tick, then `await Promise.race([activeJobs, timeout(5s)])` — half the 10s budget,
leaving headroom for Prisma `$disconnect`. **Every job carries an `AbortSignal`** passed into every vCenter
fetch. **On abort, release the claim in a `finally`** (`running_since = NULL`, `dueAt` unchanged) so the
next boot retries immediately instead of waiting out the 15-minute lease.
**Partial-write safety: do all vCenter I/O first, then write in ONE short transaction** — a kill
mid-snapshot writes nothing (clean retry), and the transaction never spans a network call.

---

## 8. Decision: sync and live usage

### D22 — Inventory sync every **6 hours**; live poll every **5 minutes**

- **Poll = 5 min.** ESXi samples real-time counters every **20 seconds**, so *nothing here is truly live* —
  1 min and 5 min are both stale by design, and freshness has no product value below the 20s floor.
  **Cost is O(connections), not O(hosts)**: one `RetrievePropertiesEx` per vCenter returns every host
  (the N×M shape only appears if someone naively fetches per host — D2 specifies the call that avoids it).
  ±10% jitter on `dueAt` so N connections don't align into a thundering herd. **Not env-configurable**
  (`CLAUDE.md`: no new env-based app settings); if it becomes configurable it goes in the Settings UI.
- **Sync = 6h** + an admin **"Sync now"** (implemented as `dueAt = now()`, reusing the identical claim/run
  path rather than a second code path) + sync-on-connection-create/enable.
- **The monthly snapshot forces a sync first** — the capacity denominator must reflect current hosts or the
  recorded baseline utilization is wrong. **Mechanized** by D15a's single claimed job body, not left to the
  coincidence of a 6h sync having recently run.
- **One of N connections failing:** snapshot the **healthy** connections, skip the failed one. Each
  connection is independent and clusters are **disjoint per connection**, so there is no fleet-atomic
  snapshot semantic worth preserving — and a dead vCenter A must not deny B and C their baselines, which
  would convert a one-vCenter outage into fleet-wide data loss.
- **A *sync* failure aborts that connection's snapshot — deliberately.** Stale inventory means a wrong
  capacity denominator, and **a baseline with a wrong denominator is worse than a missing one**: it is a
  plausible lie that silently biases purchasing, where a gap is merely visible. The line is: **we never
  write a baseline we cannot stand behind.**
- **Product-visible consequence, stated plainly: gaps are per-cluster, not fleet-wide.** August exists for
  B and C's clusters and is missing for A's. That is the honest rendering of what happened.
- **Backoff clamps at the poll interval** — `min(pollIntervalMs, 30s · 2^attempt)`. Reusing
  `discoveryBackoffMs` (`oidc.ts:39-41`) verbatim would retry a dead vCenter after 2s, *noisier than the
  normal cadence*.

### D23 — Cache in **Postgres**, not memory

The server is stateless-by-invariant and must serve last-known data after a restart with a stale indicator.
An in-memory cache fails **exactly when it matters most**: restart during a vCenter outage ⇒ "never
fetched" ⇒ no data at all, for the duration of the outage. It would also violate "the server holds no local
state; server processes are replaceable".

One row per cluster (`clusterId @id`), upserted per poll — the table never grows and needs no retention
policy. **This is a cache, not history**; history is what baselines are for, and conflating them would
quietly turn a cache into purchasing data.

### D24 — Staleness: a **discriminated union**, so "no data" cannot masquerade as 0%

```ts
z.discriminatedUnion('state', [
  z.object({ state: z.literal('never_fetched'), … }),                        // structurally carries NO numbers
  z.object({ state: z.literal('fresh'), memoryUsedGb, …, measuredAt, ageSeconds }),
  z.object({ state: z.literal('stale'), …, reason: z.enum(['unreachable','auth_failed','tls_untrusted','identity_mismatch','disabled']) }),
])
```

**Why a union and not `values + optional flag`:** it makes `never_fetched` *structurally incapable* of
carrying numbers. The classic bug in this shape is rendering `0 / 0` as **"0% utilized"** when the truth is
"we have no idea" — and in a tool that drives hardware purchasing, **"0% used" is the most dangerous
possible wrong answer**.

- **Staleness is computed server-side**, never client-side (no clock-skew disagreement). `fresh` iff
  `now − measuredAt ≤ 2 × pollInterval`; the 2× hysteresis stops one missed poll flapping the UI.
- `hostsSampled < hostsTotal` is its own honest signal ("2 of 12 hosts didn't report") — otherwise a
  partial read looks like a **real drop in consumption**.
- Text + icon, never colour alone (house style).

### D25 — Polling never blocks request serving — **structurally**

Request handlers only ever read the Postgres cache; **there is no code path where an API response awaits
vCenter**. A total vCenter outage therefore cannot add a millisecond to any request — a property of the
topology, not of careful coding. Additionally: check `fastify.isUnderPressure()` at tick start and **skip
the poll** when true — skipping is free, the cache just ages, and D24 already renders that correctly.
*The degrade path we had to build anyway is the load-shed path.*

### D25a — **Capacity is dropped from the cache entirely.** One owner, structurally.

**Capacity is inventory, not usage.** It changes when a host is physically installed — a sync event, on a
scale of months. **Nothing about it is live.** Putting it in a 5-minute usage cache would duplicate
inventory into a cache with a *different owner and a different cadence*, guaranteeing the two disagree (a
host added 10 minutes ago is in the poll but not yet in inventory). `docs/vision.md` names exactly that
failure — *"charts are cluttered or misleading, causing people to distrust the data and revert to
spreadsheets"* — as an anti-pattern.

- **Authoritative denominator for both the live view and the forecast: the synced inventory.** One owner,
  one number, **structurally incapable of disagreeing**.
- The sample keeps only what is genuinely live: `memoryUsedGiB`, `hostsSampled`, `hostsTotal`, `measuredAt`.

**A bonus falls out of dropping it:** keep `hostsTotal` (a *count* from vCenter, not a capacity). If it
disagrees with LCM's synced in-service host count, that is a precise **"inventory is behind"** signal ⇒ set
the connection job's sync due immediately (`dueAt = now()`). The poll becomes a cheap change-detector that
self-heals the 6-hour window for the only case that matters (a host was added), while owning no capacity
whatsoever — a better answer to *"why not sync more often"* than shortening the interval.

---

## 9. Decision: baseline history and its migration (#177)

### D26 — ⚠️ A live data-loss bug exists in `dev` today, independent of this epic

`ClustersService.update` (`clusters.ts:130-148`) does **`deleteMany` + `createMany`**, not upsert — so
**editing a baseline destroys the previous one**. Worse: the `deleteMany` is scoped to `clusterId` with
**no `metricTypeId` filter**, so editing one metric **wipes every metric's baseline** on that cluster and
recreates only those in the payload. Combined with `baselines: z.array(...).min(1)` (`cluster.ts:24`), a
partial payload silently drops the omitted metrics.

**This is a pre-existing bug, not something this epic introduces. It deserves its own issue** (§11.6).

### D27 — Target model

```prisma
model ClusterMetricBaseline {
  id                  String   @id @default(cuid())
  clusterId           String   @map("cluster_id")
  metricTypeId        String   @map("metric_type_id")
  tenantId            String   @default("default") @map("tenant_id")
  capturedAt          DateTime @map("captured_at") @db.Date      // PERIOD ANCHOR
  source              String   @default("manual")                // 'manual' | 'vsphere'
  observedAt          DateTime? @map("observed_at") @db.Timestamptz(3)  // informational only
  baselineConsumption Decimal  @map("baseline_consumption") @db.Decimal(18, 3)
  baselineCapacity    Decimal  @map("baseline_capacity") @db.Decimal(18, 3)
  …
  @@unique([clusterId, metricTypeId, capturedAt], map: "cluster_metric_baselines_period_unique")
  @@map("cluster_metric_baselines")
}
```

- **`capturedAt` is `@db.Date` and IS the period anchor.** The forecast is month-grained and truncates to
  first-of-month anyway (`forecast-loader.ts:109`), so snapping discards nothing the engine could use. The
  honest cost — conflating *when we measured* with *which period this represents* — is what the nullable,
  informational `observedAt` absorbs; it is in no key and read by nothing on the forecast path.
- **`source` is NOT in the unique key.** Including it would let a manual and a vSphere row coexist for the
  same period, making **"the newest baseline" ambiguous** and forcing an implicit tiebreak — for a value
  anchoring hardware purchasing, that is a bug waiting to be found by a wrong invoice. Excluding it means
  **exactly one truth per metric per period**, and a manual correction to a month that already has a
  snapshot is an *explicit overwrite* (upsert; `source` flips to `manual`) — which is what an admin
  correcting a bad sync actually wants.
- **⚠️ Open (§12 Q6):** whether **manual** entries also snap to first-of-month. If vSphere rows snap and
  manual rows don't, the constraint never collides between them and the "one truth per period" property
  quietly fails.
- **No extra indexes.** The unique constraint's btree on `(cluster_id, metric_type_id, captured_at)` serves
  both access patterns — Postgres scans a btree **backwards** as cheaply as forwards, so newest-per-group
  needs no `DESC` index. Scale check: 2 vCenters × monthly ≈ 12 rows/cluster/year; a decade for a 20-cluster
  fleet is ~2,400 rows. `DISTINCT ON` is the documented escape hatch if that ever breaks; note it, don't
  build for it.

### D28 — `Cluster.baselineDate`: **drop the column, derive the response field**

Keeping it as a derived column would be **a second source of truth for a purchasing-critical anchor**,
whose failure mode (drift against the newest history row) is *silent* and *wrong* — the worst available
combination for this value.

**But the web needs a cluster-level date** (`stale-baseline.ts`, `fleet-console.tsx:85`,
`cluster-panel.tsx:194`, `window-controls.tsx:45` all consume `ClusterResponse.baselineDate`). So **keep the
response field and derive it**:

> `ClusterResponse.baselineDate` = **MIN** over the newest-per-metric `capturedAt`.

**MIN, not MAX — deliberately.** MIN means staleness reflects the *stalest* metric; MAX would let a
freshly-synced metric **hide a stale one**, so the tile reads healthy while an anchor driving hardware spend
quietly rots. Single-metric clusters (i.e. every cluster today) make MIN and MAX identical, so this costs
nothing now and prevents a subtle wrong answer later. Keeping the field name means **zero web churn**.

**Leave `ForecastInput.baselineDate` alone.** It is the internal contract of the *pure* forecast function;
renaming it would churn `forecast.ts` + `scenario.ts` + `forecast.test.ts` for no behavioural gain and widen
the diff across the exact code the correctness invariants protect. **The pure function must never learn that
history exists** — that is what keeps the regression test meaningful.

### D29 — The semantic change, and why the migration is provably behaviour-preserving

Today `Cluster.baselineDate` is **one date for all metrics** (`clusters.ts:225` passes it into
`computeForecast` for every metric). The new `capturedAt` is **per metric row** — a real semantic change for
multi-metric clusters. It doesn't bite today (the seed only creates `memory_gb`), but the API permits up to
50 metrics (`cluster.ts:16`), so the migration must be correct for them.

**The backfill resolves it exactly:** every existing row for cluster C gets `capturedAt = C.baseline_date`.
All of C's metrics land on the same anchor — *which is today's semantics, reproduced precisely.* Divergence
can only begin with a **future** write. The migration is provably behaviour-preserving.

*(Correction to #177's premise: `Cluster.baselineDate` is `DATE NOT NULL` and **can never be NULL**, so the
backfill needs no NULL branch. And `import-xlsx.ts` does **not** touch baselines — the parser extracts them
but the importer discards them, so it needs no migration work. §12 Q7.)*

### D30 — Expand / migrate / contract, and the rollback window

`prisma migrate deploy` runs from the container entrypoint (`entrypoint.ts:39`) and the deployment is
**single-replica**, so migration and matching code ship in the same image and there is **no window where new
schema meets old code** — the rolling-deploy hazard expand/contract classically solves **does not exist
here**. The real reason to split is **rollback**.

**Two PRs / two releases:**
- **PR 1 — EXPAND + MIGRATE + new code**, with `clusters.baseline_date` **retained and dual-written**, so an
  image rollback still works.
- **PR 2 — CONTRACT** (a later, deliberate release): drop `clusters.baseline_date`.

> **⚠️ The loudest sentence in this document.** After PR 1, rolling back the image is safe **only while every
> (cluster, metric) still has exactly one baseline row.** The moment a second row exists — the first monthly
> snapshot, or the first admin edit — the old code's `cluster.baselines[0]` (`forecast-loader.ts:101`)
> selects an **arbitrary** row from an unordered set. Not an error. Not a crash. **A silently wrong forecast,
> on the number that drives hardware purchasing.** Why: PR 1 drops the old `@@id([clusterId, metricTypeId])`
> PK, so the old client still runs — it just no longer has the uniqueness guarantee that made `[0]` correct.
> **PR 1's rollback window is the interval between deploying it and the first appended baseline.** After
> that, recovery is restore-from-dump. This must appear in the PR body and in `docs/operations.md`.

**→ §12 Q4 — the owner's risk-appetite call.** The alternative (a **new** `cluster_metric_baseline_history`
table, old table untouched and dual-written, dropped in contract) keeps image-rollback safe **indefinitely**,
at the cost of a genuine dual-write for one release cycle.

### D31 — Backup and rollback, honestly

**`prisma migrate deploy` has no `down` migrations. Full stop.** Prisma's documented recovery is **roll
forward**.

> **The trap worth naming:** `prisma migrate resolve --rolled-back <name>` **does NOT undo any DDL.** It only
> edits `_prisma_migrations` bookkeeping so a *failed* migration stops blocking the next `deploy`. Anyone who
> reads the flag name and expects an undo produces a database whose actual shape and recorded history
> disagree — worse than either failure alone.

| Situation | Recovery |
| --- | --- |
| Migration fails mid-run | Prisma runs each migration in a transaction ⇒ DDL rolls back atomically; the entrypoint's `migrate deploy` fails ⇒ **the container does not start Fastify** ⇒ fails safe, serving nothing rather than wrong numbers. Fix forward. |
| Migration OK, code bad, **≤1 row** per (cluster,metric) | Roll back `LCM_IMAGE_TAG`. Old columns exist, `baselines[0]` still unambiguous, `baseline_date` still populated. **Safe.** |
| Migration OK, **≥2 rows** for any (cluster,metric) | ❌ **Image rollback NOT safe** — silently wrong forecasts. Recovery = restore the pre-PR-1 dump, losing everything written since. **This is why the dump must be verified before deploying, not after.** |
| After PR 2 (contract) | Image rollback never safe. Dump-restore only. |

Backup uses the documented `pg_dump --format=custom` flow (`docs/operations.md:138-156`); **the dump must be
verified restorable (row counts matching production) before PR 1 deploys.**

### D32 — Forecast-correctness invariants

1. **The absolute requirement:** for any (cluster, metric) with exactly one baseline row, `computeForecast`
   output is **byte-identical** before and after. D29 makes this *structurally* true, so the test confirms a
   property the design already guarantees.
2. **The anchor is `MAX(capturedAt)`, unconditionally.** ⚠️ Note what is *not* proposed:
   `MAX(...) WHERE capturedAt <= today`. A future-dated baseline is accepted **today** and simply pushes
   `fromMonth` forward. Filtering to `<= today` would be a **silent behaviour change smuggled in under a
   migration**. Flagged so it isn't "tidied up" mid-implementation.
3. `fromMonth` default = `firstOfMonth(anchor.capturedAt)`.
4. **History is append-only** — the sync only ever INSERTs (`ON CONFLICT DO NOTHING`). Mutation is reachable
   only through explicit admin action.
5. `ClusterResponse.baselineDate` = **MIN** over newest-per-metric `capturedAt`.
6. **The pure function is untouched.** If the diff touches `computeForecast`, something has gone wrong.

### D33 — The strongest regression test: a characterization snapshot, landed **first**

**Sequencing is the entire value:**
1. **Land the characterization test on its own, BEFORE the migration PR.** Deterministic fixtures via
   `factories.ts` across the shapes that matter — single metric; **two metrics** (the semantic-change case);
   capacity steps; events; applications; archived cluster; zero-valued baseline — snapshotting the full
   `ForecastResult`.
2. It **passes against current `dev`**, because it is a *characterization* test: it captures today's
   behaviour as-is, bugs included. It asserts nothing about correctness — only **sameness**.
3. **The migration PR must not change the committed snapshot.** Any diff there is a behaviour change that
   must be explained or reverted.

> A snapshot written *inside* the migration PR proves nothing — it records whatever the new code happens to
> do, and the reviewer cannot tell the difference.

**Three things must be pinned or a naive `toMatchSnapshot()` fails confusingly:** the **clock**
(`clusters.ts:295` `firstOfCurrentMonth()` calls `new Date()`, so `currentConsumption`/`utilization` drift
monthly — needs `vi.setSystemTime()`, which would be the **first server-side use**); **ids** (`cuid()`s
differ every run — `factories.ts` must accept explicit ids); and the **window** (pass explicit
`fromMonth`/`toMonth`). *(Verified: `host-projection.ts` has no `new Date()`, so the explicit-window path is
clean.)*

**Supporting integration tests** (Vitest + Testcontainers, real Postgres): newest-baseline anchoring;
**DB-level idempotency** (two inserts with the same key → second rejected — assert against real Postgres,
since the whole point is that the *database* enforces it); **restart idempotency** (run the job twice on
different *days* of the same month → exactly one row — the test that proves D27's period-anchor decision);
multi-metric MIN assertion (**load-bearing**: a MAX implementation passes every single-metric test, which is
every test that exists today); archived cluster survives; and **"update no longer destroys"** (the direct
regression for D26). Backfill correctness: seed the *old* shape, run the migration, assert row counts and
`captured_at` values — the suite already runs `prisma migrate deploy` in `vitest.global-setup.ts:40`.

---

## 9b. ⚠️ D34 — The forecast-correctness landmine: synced hosts **double-count** against `baselineCapacity`

**This is the single most dangerous finding of the design gate. It was not in any issue. Verified in
source, not inferred.**

`forecast.ts:117-122` computes capacity as an **offset plus addends**:

```ts
let capacity = input.baselineCapacity;                       // :117
for (const host of hosts) capacity += effectiveCapacityAt(host, date);   // :120-122
```

**Tracked hosts are ADDITIVE to `baselineCapacity` — they are not the total.**

**Why nothing catches it today:** the seed's `ReferenceHost` carries no capacity field (`seed.ts:13-24`)
and host create/update writes **no `capacities`** (`seed.ts:148-192`), so seeded hosts contribute **0** and
`baselineCapacity` (7680 / 40960 / 8192 / 4096 — "derived from the original Capacity_Forecast_vSphere.xlsx
(May 2026 baseline column)", `seed.ts:56-85`) carries the entire cluster. The additive path is effectively
**unexercised for capacity**. But the API *requires* ≥1 capacity row per host
(`packages/shared/src/schemas/host.ts:16`).

**The hazard:** if sync imports every host with its real `hardware.memorySize` **and** the monthly snapshot
writes `baselineCapacity` = measured fleet capacity, then:

> `capacity = fleet + fleet = 2 × real` ⇒ **utilization halves** ⇒ *"plenty of headroom"* ⇒ **no hardware
> purchased** ⇒ **precisely the outage LCM exists to prevent.**

It is silent, produces a plausible number, and **no existing test would catch it.**

**Recommended direction (§12 Q9 — the owner's call, not the design's):** for **synced** clusters,
`baselineCapacity = 0` and let synced hosts carry 100% of capacity. vCenter gives authoritative per-host
`hardware.memorySize`, and that is what makes the existing EOL / decommission / replacement machinery
operate on real numbers — which is the point of syncing hosts at all. `baselineConsumption` remains a
genuine cluster-level measurement. Manual clusters are untouched.

> **⚠️ Knock-on that MUST be solved with it, or the chart silently flatlines.** `effectiveCapacityAt`
> returns **0 before `commissionedAt`** (`forecast.ts:177`), and **vCenter cannot tell us when a host was
> commissioned.** A fleet imported today would show capacity 0 for all prior history — and
> `utilization = capacity === 0 ? 0 : …` (`forecast.ts:138`) renders that as **0% for every month before
> the import.** Synced hosts therefore need `commissionedAt` backdated (to `cluster.baselineDate`, or
> first-seen). Unresolved: what value is *honest* here, given we genuinely do not know. **§12 Q9.**

---

## 10. Phase plan

| Phase | Issue | Risk | Gate |
| --- | --- | --- | --- |
| 0 | **#174** — this document | High | **Owner approval (§12)** |
| 1 | #175 — connections, encrypted creds, connection test | **High** | Owner approval on the PR |
| 2 | #176 — inventory sync | High | Per approved design |
| 3 | **#177** — baseline history + chart | **High** | Owner approval on the PR; verified `pg_dump` first |
| 4 | #178 — monthly snapshot + scheduler | Normal–High | Depends on #176 + #177 |
| 5 | #179 — live usage view | Normal | Depends on #175 + #176 |

`#174 → #175 → #176 → (#178, #179)`; **#177 needs only D27/D30's migration decision** and proceeds in its own
worktree in parallel. Per phase: worktree off `origin/dev`, TDD, Zod contracts in `@lcm/shared` first,
`pnpm lint && pnpm typecheck && pnpm test` green before the PR, PR → `dev` with `Closes #<n>`, merge
`--merge`, then remove worktree and local branch.

**Recommendation: land #177 first**, before any vSphere connectivity. It is independently valuable (manual
baselines gain history), it de-risks the migration, and D33's characterization test wants to land ahead of it
anyway.

---

## 11. Scope amendments — these change the issues and need sign-off

1. **#175's `vsphere_config` singleton is invalid** → `vsphere_connections`, N rows (D5). The issue's central
   premise ("follows the proven `AuthConfig` pattern") does not transfer (D5).
2. **#176's "external vCenter id" is not globally unique** → identity is `(connectionId, MoRef)` (D7).
3. **#176 does not mention the `@@unique([tenantId, name])` collision**, which would break sync on day one
   with two vCenters (D7).
4. **#178's "no duplicate baselines for the same period" is currently unimplementable** — there is no period
   column; a second snapshot today would **silently overwrite** via the composite PK, destroying the very
   history the epic exists to preserve. #178 hard-depends on #177 (D17/D27).
5. **`docs/vision.md` must be amended** — its v1 Non-goals and Anti-patterns still forbid what this epic
   builds (§2).
6. **A new issue is needed** for the pre-existing `clusters.ts:132` data-loss bug (D26) — it is not this
   epic's to fix, but it should not go unrecorded.

---

## 12. Open questions — blocking approval

| # | Question | Why it blocks |
| --- | --- | --- |
| **Q9** ⚠️ | **THE BIG ONE — for synced clusters, should `baselineCapacity` be 0 with synced hosts carrying 100% of capacity?** And **what should a synced host's `commissionedAt` be**, given vCenter cannot tell us? | Otherwise capacity **double-counts** (`2 × real` ⇒ utilization halves ⇒ *"plenty of headroom"* ⇒ **hardware not purchased**). Silent, plausible, and untested today (**D34**). The `commissionedAt` half decides whether the historical chart flatlines at 0%. |
| **Q1** ✅ | **Confirm: LCM's `'GB'` is GiB (2³⁰).** The evidence is strong (govmomi's `units` is 1024-based; `govc cluster.usage` does `<< 20`; VMware states the base-2 convention). **Confirm your spreadsheet figures came from the vSphere UI** — i.e. round numbers like 512/768/1024. | Answered by research (D3a), but it is **your data** — a wrong call is a silent 7.4% on every synced host. Also: do you want the `unit` label corrected to `GiB` (product decision), or just documented? |
| **Q2** | **Will LCM address the vCenters by FQDN or by IP?** | By IP, default VMCA certs have **no IP SAN**, so hostname verification fails regardless of trust — `ERR_TLS_CERT_ALTNAME_INVALID` (D11). Changes what ships. |
| **Q3** | **Is your vCenter management network segmented from user VLANs?** | Sets the true severity of R1. If not segmented, the residual scan risk drops to ~zero and C5 could be dropped (§6.7). |
| **Q4** | **Migration rollback appetite:** in-place (simpler; rollback window closes at the first appended baseline) vs new-table dual-write (image-rollback safe indefinitely; a write-only second table for one release)? | Risk-appetite call the owner should make explicitly (D30). |
| **Q5** | **Accept coarse test-endpoint errors** (`unreachable`/`tls_untrusted`/…) with detail in the server log? | The one real usability cost in the control set (C4). |
| **Q6** | **Do manual baselines snap to first-of-month like vSphere ones?** | If not, the uniqueness property silently fails and MAX picks by accident of date (D27). |
| **Q7** | `import-xlsx.ts` discards parsed baselines — intentional? | Cosmetic, but a latent gap worth confirming (D29). |
| **Q8** | **Do you want the `dev`-today data-loss bug (D26) fixed as part of #177, or as its own separate issue/PR?** | It is a pre-existing bug, not this epic's — but #177 rewrites that exact code path, so fixing it there is nearly free. Your call on scope hygiene. |

---

## 13. Approval

- [ ] Environment facts (§1) confirmed.
- [ ] Blocking questions Q1–Q6 answered (§12).
- [ ] Scope amendments (§11) accepted — in particular **multi-vCenter**, which rewrites #175.
- [ ] Threat model and control set (§6) accepted, including the **ASVS L1 honesty note** (§6.6) and the
      residual risks (§6.8).
- [ ] TLS policy (§5) accepted, including the **deliberate divergence from govmomi's leaf-pin convention**.
- [ ] Migration strategy and the **rollback window** (§D30) accepted.
- [ ] `docs/vision.md` amendment (§11.5) approved.

**No implementation begins until this is signed off.**
