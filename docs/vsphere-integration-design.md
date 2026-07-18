# vSphere integration — design and threat model

**Status:** ✅ **APPROVED 2026-07-17** (issue #174, the high-risk design gate for epic #172). Implementation
authorised in the order given in §10.
**Date:** 2026-07-17.

---

## 0. Owner decisions — recorded 2026-07-17

These are the project owner's rulings on §12's blocking questions. They are **authoritative** and override
any recommendation elsewhere in this document.

| #          | Decision                                                                                     | Consequence                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Q9a**    | **`baselineCapacity = 0` for synced clusters; synced hosts carry 100% of capacity.**         | Resolves the D34 double-count. vCenter's per-host `hardware.memorySize` is authoritative, and the existing EOL/decommission/replacement machinery operates on real numbers. **Write-time invariant:** for a synced cluster, _every_ baseline row (manual or vSphere) must have `baselineCapacity = 0` — otherwise an admin correction reintroduces the double-count.                                                                                   |
| **Q9b** ✅ | ~~Snapshot-time subtraction.~~ **RE-DECIDED 2026-07-17: forecast-time delta filter** (§D35). | **Filter deltas** (applications, `consumptionDelta` events, `capacityDelta` events) to `effectiveDate > anchor.capturedAt`; **never filter measurement carriers** (hosts, `baseline*`). Covers all **four** instances, self-correcting as the anchor advances, mutates no admin-authored data, and holds for manual clusters too. `baselineConsumption` stays the raw measurement.                                                                     |
| **Q9c**    | **Admin sets `commissionedAt` per host after import.**                                       | Most accurate, but `Host.commissionedAt` is **`NOT NULL`** (`schema.prisma`), so sync MUST import a provisional value and flag it. Requires a `commissionedAtProvisional` marker + a "confirm commissioning dates" task surfaced in the UI. **Directly forces Q9d** — provisional/absent dates make zero-capacity months reachable by default.                                                                                                         |
| **Q9d**    | **`utilization` returns `null` at zero capacity; the UI renders "unknown", never 0%.**       | Closes the D34b fail-open. **High-risk:** changes forecast output for every zero-capacity month, so D33's characterization snapshot **will** diff — deliberately, and the diff must be explained in the PR body, not absorbed. Colour must never be the sole signal for "unknown" (house style).                                                                                                                                                       |
| **Q2**     | **FQDN addressing. NO TLS override — TOFU root-pinning only.**                               | The `ca` path is viable; D11's IP-SAN problem does not arise. **An `insecure`/`ignore TLS` flag is explicitly rejected** — see §0.1.                                                                                                                                                                                                                                                                                                                   |
| **Q4** ✅  | ~~In-place migration.~~ **RE-DECIDED 2026-07-17: new-table dual-write.**                     | The rollback window **never closes**; recovery is `LCM_IMAGE_TAG=<previous>`, lossless, at any time. §D30's warning ceases to exist — _a hazard removed by construction beats a hazard documented_. **Cost accepted:** two write paths in `ClustersService` for one release, both tested, plus one rule — **the old table mirrors the NEWEST baseline; a manual edit backfilling an OLDER period must not touch it.** Contract PR drops the old table. |
| **Q6**     | **Manual baselines snap to first-of-month, like vSphere snapshots.**                         | `capturedAt` is the period anchor for **both** sources ⇒ D27's "exactly one truth per cluster/metric/period" holds and is DB-enforced. A manual correction to a month that already has a snapshot is an explicit upsert. Accepted cost: no two baselines in one month; an entered date shifts to the 1st (the UI must say so).                                                                                                                         |
| **Q8**     | **The `clusters.ts:132` data-loss bug gets its own issue + PR, landed before #177.**         | Keeps a live-bug fix bisectable and out of a large migration PR, and gives D33's characterization test an honest pre-state to capture.                                                                                                                                                                                                                                                                                                                 |

**Still open (non-blocking for #177):** Q1 (GiB — proceeding on the research evidence, see §0.2), Q3
(network segmentation — affects only the recorded severity of R1), Q5 (coarse test-endpoint errors),
Q7 (`import-xlsx.ts` baselines).

### 0.1 — Recorded rejection: the "ignore TLS errors" setting

The owner initially asked for _"FQDN, add in the settings to ignore TLS error"_ and, on review of the
threat model, **withdrew it in favour of TOFU pinning only.** Recorded because the request is the natural
one and **will recur**:

- The underlying need — _"self-signed VMCA certs must just work"_ — **is fully met by D11's TOFU
  root-pinning**, with verification ON, surviving leaf auto-renewal.
- The mechanism is not a convenience flag; it is **trust material wearing a convenience flag's clothing.**
  Complete attack, no password and no test endpoint required: `disabled` mode ⇒ anonymous ADMIN ⇒
  `PATCH …/vcenter/1 {"insecure": true}` (a benign-looking boolean that sails through any password gate
  scoped to "credential fields", and through review) ⇒ spoof internal DNS ⇒ **the next scheduled poll
  delivers the vCenter credential in cleartext, and every poll after it, forever.**
- It would waive **#175's own acceptance criterion** ("TLS verification is never silently disabled") and
  `CLAUDE.md` Golden Rule 8, which requires a recorded exception — not a settings checkbox.
- **`tlsMode` therefore has exactly two values, both of which fail closed.** There is no third state.
- **The legitimate need inside the request is diagnostic, and is served properly:** a TLS failure returns a
  _named cause_ plus a one-click "trust this certificate" action — never a bypass.

> **`@ai-warning` this at the TLS implementation site.** A future contributor meeting a handshake failure
> will reach for `rejectUnauthorized: false` on day one. The answer is the trust flow, not the flag.

### 0.2 — Q1 (GiB): proceeding on evidence, owner confirmation still welcome

The research is conclusive that the chain is **base-2 end to end** (§D3a: govmomi's `units` defines `GB` as
`1 << (10*iota)`; `govc cluster.usage` does `OverallMemoryUsage << 20`; Broadcom states the convention
explicitly). Corroborated in-repo: **every seed baseline value is an exact multiple of 1024**, which only
"humans reading the vSphere UI" explains. Proceeding with **GiB (2³⁰)**.

**Two things this raises that the owner should still see:**

1. `unit: 'GB'` is a **pre-existing mislabel** — the stored numbers are GiB. Recording it (`@ai-note` +
   `docs/operations.md`) is mandatory so nobody later "fixes" it to 10⁹ and shifts every forecast 7.4%.
   Renaming the display string to `GiB` is a **product decision**, flagged not taken.
2. **The sharper risk is not the unit — it is whether existing baselines are trustworthy.** If any was
   typed from a decimal-GB source it is _already_ 7.4% off, and syncing would **surface** rather than cause
   it. → **The first sync per cluster MUST report a diff against the hand-entered baseline rather than
   silently overwriting it.** Adopted as a design requirement.
   **Risk classification:** **High** on four axes per `CLAUDE.md` § Change Risk — secrets handling, outbound
   server connections, Prisma migration on purchasing-critical baseline data, and forecast-engine correctness.
   No implementation phase (#175–#179) may begin until this document is explicitly approved.

> **This document is the gate, not a formality.** It resolves every open question listed in #174 and, in
> several places, contradicts assumptions baked into the epic's sub-issues. Those contradictions are
> listed in §11 and need explicit sign-off, because they change scope.

---

## 1. Environment facts (confirmed by the project owner, 2026-07-17)

These are authoritative inputs, not assumptions. Several of them invalidate the issues' premises.

| Fact                 | Value                                        | Consequence                                                                         |
| -------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| vCenter version      | **8.0 U3 today, 9.0 near future**            | Design must work on both. Rules out anything 9.0-deprecated.                        |
| Number of vCenters   | **Two or more, today**                       | **#175's `vsphere_config` singleton is invalid.** See §11.1.                        |
| vCenter TLS certs    | **Self-signed (VMCA default)**               | Trust must be explicitly established; see §5.                                       |
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

| Candidate               | Verdict                                                                                                                                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **vim25 SOAP**          | ✅ **Chosen.** GA, non-deprecated in 9.0, and the only protocol both real vCenter _and_ the test double speak.                                                                                                                                                                                                 |
| vSphere Automation REST | ❌ Inventory endpoints return identity only — **no memory capacity or usage**. Fatal.                                                                                                                                                                                                                          |
| VI/JSON (8.0 U1+)       | ❌ Same vim25 object model over JSON, and genuinely attractive — but **vcsim does not implement it** (verified: no route registered in `simulator/simulator.go`). Choosing it means no integration test double for a purchasing-critical path. Rejected on testability alone.                                  |
| vStats                  | ❌ **Technology Preview.** Broadcom verbatim: _"VMware does not guarantee backwards compatibility and recommends against using them in production environments."_ Also push/registration-oriented (would mutate vCenter state — violates read-only), counters versioned by "edition", and not served by vcsim. |

**SOAP is not deprecated in 9.0** — verified against Broadcom VCF 9.0 TechDocs. 9.0's deprecations are
targeted (Patch Manager, vSAN .NET/Perl/Ruby SDKs, Supervisor `cluster_id`); the Java SDK's merge into
the VCF SDK with VIM+VSAN in a single WSDL is evidence the contract is _maintained_, not retired.
govmomi's `vim25` package declares `Version = "9.0.0.0"`.

**Accepted strategic risk:** Broadcom's direction is VI/JSON. We choose the older wire format _because
the test double requires it_. **Mitigation (mandatory):** keep the wire format behind a narrow transport
interface — `retrieveProperties(specSet) → objects`. The PropertyFilterSpec, traversal, and all parsing
above it are protocol-independent, so a VI/JSON swap stays contained. Revisit if vcsim adds VI/JSON.

### D2 — Client: **hand-rolled**, with `fast-xml-parser`

Every vSphere-specific npm package is abandoned: `node-vsphere-soap` (last publish **2015**),
`vsphere-connect` (**2017**). No official VMware/Broadcom Node SDK exists (Java, Python, Go, .NET only).
The maintained generic option (`soap`) is **WSDL-driven** — the vim25 WSDL is megabytes and _grew_ in 9.0;
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

| Value                                                             | Unit                       |
| ----------------------------------------------------------------- | -------------------------- |
| `HostSystem.summary.hardware.memorySize`                          | **bytes** (int64)          |
| `HostSystem.summary.quickStats.overallMemoryUsage`                | **MB** (int32)             |
| `ComputeResourceSummary.totalMemory`                              | **bytes**                  |
| `ComputeResourceSummary.effectiveMemory`                          | **MB**                     |
| **LCM `MetricType{key:'memory_gb', unit:'GB'}`**, `Decimal(18,3)` | **GB** (`seed.ts:105-108`) |

**Rules:**

1. **Sum per-host `summary.hardware.memorySize` for capacity. NEVER read `effectiveMemory`.** Three
   reasons: (a) it sits in the same struct as `totalMemory` in a _different unit_; (b) its
   maintenance-mode exclusion is a **product policy LCM must own explicitly**, derived from
   `runtime.inMaintenanceMode` / `runtime.connectionState`, not silently inherited; and (c) —
   decisively — **vcsim populates it wrongly** (see below).
2. **`Σ memorySize == totalMemory` is asserted as a drift check.** vcsim aggregates `totalMemory`
   correctly, so this assertion is safe against the double.
3. **One conversion function, in `@lcm/shared`**, used by _both_ the live-usage path and the
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

- Broadcom (2025-08-19): _"vCenter continues to use the TB prefix on a base-2 calculation… our products
  predate the IEC standard and our customers prefer the traditional prefixes."_
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
vSphere's mixed units are a quirk of _that_ integration and must not leak past its adapter; `@lcm/shared`
carries **GiB only**, so the forecast engine never sees a vSphere unit. Round only at the display edge.

> **The 7.4% gap is real but entirely avoidable — it appears only if we convert with 10⁹.** A 512 GiB host
> would land as 549.756, **inflating apparent capacity by 7.4% and deferring hardware purchases that are
> actually needed.**

**Two things for the owner (§12 Q1 — now a confirmation, not an open question):**

1. **`unit: 'GB'` is a pre-existing mislabel** — the stored numbers are GiB. That is fine and matches
   vCenter, but it must be **recorded** (`@ai-note` on the seed + `docs/operations.md`), or someone will
   "fix" it to 10⁹ later and silently shift every forecast by 7.4%. Changing the display string to `GiB` is
   a product decision, flagged not taken.
2. _(Fixture note: vcsim's template host is 4294430720 B = **3.9995 GiB**, not exactly 4 — do not hard-code
   `4` in a fixture assertion.)_

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

- **Degrade must be per-connection.** `AuthConfig`'s failure mode is a _global_ `mode=disabled`. Here,
  connection A having an undecryptable secret must not disable connection B.
- **Do not cache decrypted secrets.** `AuthConfig` caches because it is on the hot path of _every request_.
  vCenter credentials are used by a background job every few minutes, so **decrypt-on-use** is affordable
  and keeps plaintext out of the long-lived heap. The plugin decorates the _service_, not a secret registry.

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

**Why:** MoRefs are unique only _within_ a vCenter. If `vc-prod.example.com` is re-pointed (DNS change, DR
failover, rebuilt appliance reusing the name), then `domain-c123` at the new target is a **completely
different cluster**. Sync would match it by `(connectionId, externalId)` and **overwrite the wrong
cluster's hosts and capacity**, feeding wrong numbers into a purchasing forecast. Nothing else in the
design catches this.

| Scenario                           | `instanceUuid` | MoRefs         | Behaviour                                                                      |
| ---------------------------------- | -------------- | -------------- | ------------------------------------------------------------------------------ |
| Restore from backup                | same           | same           | Normal sync                                                                    |
| Rebuilt appliance / re-pointed DNS | **new**        | **reassigned** | `status='identity_mismatch'` → **block sync**, require explicit admin re-adopt |

**Rule: compare on every connect; on mismatch, refuse to sync, log loudly, never auto-heal.** Re-adopt is
an explicit admin action that re-matches clusters **by name** and rebinds `externalId`, showing exactly
what will bind to what before it commits. _(The rebuild-vs-restore semantics are asserted from vendor
behaviour, not tested — but the design fails safe either way: any mismatch blocks sync, so a wrong
assumption costs an unnecessary re-adopt, never silent corruption.)_

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

> **A late team disagreement, resolved in favour of `Restrict`.** It was argued that `Restrict` "deadlocks
> detach" and that `SetNull` should be used instead. **It does not**, provided the detach transaction nulls
> the referencing FKs _before_ deleting the connection — at `DELETE` time no rows reference it, so the
> constraint is satisfied. `SetNull` is rejected on the original grounds (which that same teammate argued
> in round 1): it would leave `source='vsphere'` with a null `connectionId` — an inconsistent row no code
> path expects — and, more importantly, it makes the destructive path **automatic** rather than deliberate.
> `Restrict` is the DB-level backstop that guarantees **no application bug can delete purchasing history**;
> that guarantee is the entire point and must not be traded for convenience. **Order the detach explicitly
> and comment why.**

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

| Server           | Client options                          | Result                               | `checkServerIdentity` calls |
| ---------------- | --------------------------------------- | ------------------------------------ | --------------------------- |
| self-signed leaf | `rejectUnauthorized:true`, no `ca`      | FAILED `DEPTH_ZERO_SELF_SIGNED_CERT` | 0                           |
| self-signed leaf | **`rejectUnauthorized:false`** + spy    | **CONNECTED**                        | **0** ⚠️                    |
| VMCA chain       | **`rejectUnauthorized:false`** + spy    | **CONNECTED**                        | **0** ⚠️                    |
| self-signed leaf | `ca:[cert]` + `rejectUnauthorized:true` | CONNECTED                            | **1** ✅                    |

**The mechanism, now precise:**

> **`checkServerIdentity` is invoked if and only if OpenSSL chain verification SUCCEEDS.** It is gated on
> `verifyError` being empty — **not** on `rejectUnauthorized`. Node computes `verifyError` first and only
> then calls `checkServerIdentity`; `rejectUnauthorized` is consulted _afterwards_, purely to decide
> whether to destroy the socket.

> ### ⚠️ The trap this design MUST NOT walk into
>
> An implementer writes `rejectUnauthorized:false` + a thumbprint check inside `checkServerIdentity`, tests
> against their vCenter, sees it connect, and ships. **The thumbprint check never executed once.** The code
> reads as pinned; it is `curl -k`. It fails **open**, **silently**, with green tests — the worst possible
> failure mode for the control C1 depends on.
> **`checkServerIdentity` MUST NOT be used to implement thumbprint pinning.**
> _(govmomi does implement TOFU — but in Go, whose `crypto/tls` exposes `InsecureSkipVerify` +
> `VerifyPeerCertificate`, a hook that **does** run on verification failure. **Node has no equivalent.** The
> govmomi model does not port. This is exactly the cross-language API assumption that needs testing, not
> recall.)_

### D11 — **Pin the root of the presented chain as a `ca:` trust anchor.** No insecure flag on the credential path.

Verified end-to-end (`probe4.mjs`) across **both** real-world vCenter cert shapes with **one uniform code
path**:

| Server shape                                | Pin (= `chain[last]`) | Steady-state result                  |
| ------------------------------------------- | --------------------- | ------------------------------------ |
| Self-signed leaf (ESXi-style)               | the leaf itself       | **CONNECTED**, identity check ran 1× |
| **VMCA leaf + VMCA root (default vCenter)** | the VMCA root         | **CONNECTED**, identity check ran 1× |
| Negative control: wrong root                | —                     | **FAILED** ✅                        |

```js
// Phase 1 — TOFU capture. NO credential, no request body. The ONLY place rejectUnauthorized:false appears.
//   walk getPeerCertificate(true).issuerCertificate to the root; keep root DER → PEM.
// Steady state — no insecure flag anywhere:
new Agent({
  connect: { ca: [pinnedRootPem], rejectUnauthorized: true, lookup: pinnedLookup(vettedIp) },
});
```

**Why this is strictly better than a custom-connector fingerprint check** (which also works, and was the
fallback considered):

1. **No `rejectUnauthorized:false` in steady state at all** — it is confined to the credential-free capture
   phase. The dangerous shape never appears on the credential path.
2. **Fails closed in OpenSSL, not in app code.** No app-layer check to forget, skip, or refactor away. A
   connector-based fingerprint check puts `rejectUnauthorized:false` into steady-state code, where one
   refactor dropping the fingerprint line silently reverts it to `curl -k`.
3. **Hostname verification comes back for free** — the chain now validates, so `checkServerIdentity` runs.
   Binding becomes _"a cert for this hostname, issued by this exact VMCA"_ — strictly stronger than a bare
   fingerprint, which the connector approach loses entirely.
4. **Survives routine leaf auto-renewal** (the decisive lifecycle win — see below).
5. **Uniform:** pin `chain[last]`. For a self-signed leaf, root == leaf, so it degenerates to exact leaf
   pinning automatically. **One code path, both shapes** — which also dissolves the root-vs-leaf debate.

> **⚠️ Non-obvious trap, measured:** pinning the **leaf** via `ca:` does **not** work when the server
> presents a chain — `ca:[leaf]` against the VMCA server FAILED with `SELF_SIGNED_CERT_IN_CHAIN`, because
> OpenSSL builds the chain from what the server sent and must terminate at a _self-signed_ anchor it
> trusts; a trusted leaf mid-chain doesn't terminate it (no `X509_V_FLAG_PARTIAL_CHAIN`, which Node
> doesn't expose). **Pin the root of the presented chain, not the leaf.** An implementer will otherwise try
> `ca:[leafPem]` first, watch it fail against real vCenter, and "fix" it with `rejectUnauthorized:false`.

**Use SHA-256, reject SHA-1.** govmomi has `ThumbprintSHA256` (v0.36.1+) and `govc about.cert -thumbprint`
emits **SHA-256 by default** — so SHA-256 is both correct _and_ what the admin's out-of-band confirmation
command actually prints. _(vCenter's own `HostConnectSpec.sslThumbprint` remains SHA-1 for legacy reasons —
do not let that pull the design back.)_

### D11a — The corrected rule, for code and docs, verbatim

> **`rejectUnauthorized: false` is permitted in exactly one place: the TOFU certificate-capture probe,
> which sends no credential and no request body. The credential-bearing path and the scheduled poll MUST
> use `ca: [pinnedRootPem] + rejectUnauthorized: true`.**
>
> **`checkServerIdentity` MUST NOT be used to implement thumbprint pinning.** It is not called when chain
> verification fails (measured: 0 invocations, Node 26.5.0), so a thumbprint check placed there **never
> runs and every connection silently succeeds against any certificate.**

**Resolution order at connect:** pinned root → system roots → **refuse to sync.** The last step is what
makes "verification is never silently disabled" _structurally_ true: an unconfirmed connection is not a
connection that syncs insecurely — it is a connection that **does not sync**. There is no code path from
unconfigured to connected.

**⚠️ Two facts that decide which mode is viable — and they point in opposite directions:**

1. **Default VMCA Machine SSL certs carry the FQDN in the SAN and no IP SAN** unless deliberately added.
   Node's `checkServerIdentity` **requires an `iPAddress` SAN** to validate a connection to a literal IP —
   it does not fall back to CN. **So if LCM addresses vCenter by IP, `ca` mode fails with
   `ERR_TLS_CERT_ALTNAME_INVALID` even with the correct root loaded and a perfectly valid chain.** That is
   a _hostname_ failure, not a _trust_ failure, and no CA plumbing fixes it. **→ §12 Q2 is blocking.**
2. **The Machine SSL leaf auto-renews unattended** on vCenter 8.0U3h+ / VCF 9.0.2+ (KB 427937;
   `autoRenewThreshold` default: 10 days before expiry; `daysValid` default **730 days**, KB 425527).
   **So a leaf pin is guaranteed to break on its own, on a ~2-year timer, with no human involved.** The
   VMCA **root** changes only when an admin deliberately regenerates it or rebuilds vCenter — i.e. exactly
   when you _want_ re-confirmation.

**→ Prefer `ca` mode (uploading the VMCA root PEM, downloadable from vCenter's documented
`/certs/download.zip`). CA-upload _is_ root-pinning, and it makes automatic leaf renewal a non-event.**
Use `pinned` only where `ca` is not viable — principally IP addressing.

> **Note the divergence from ecosystem convention, deliberately:** govmomi (`soap.ThumbprintSHA1`),
> PowerCLI, and `vic-machine --thumbprint` all pin the **leaf**. Those are _interactive, short-lived_
> tools where a spontaneous break is immediately visible to a human at a terminal. Ours is an
> **unattended background job**, where the same break is a silent stop. Do not "fix" this to match
> govmomi. `@ai-warning` this at the implementation site.

**Unverified, and it gates `pinned`-as-root-pin:** whether vCenter actually **sends the VMCA root in its
handshake chain** (servers commonly omit the root). If it does not, TOFU can only pin the _leaf_, and the
fallback inherits the auto-renewal break. **Must be confirmed against the real vCenter at implementation
time**; if it fails, `ca` mode becomes mandatory and IP addressing becomes unsupported.

### D12 — Rotation is a fail-safe, visible event

Never auto-re-pin (that makes the pin decorative). Never fall back to skip-verify (`CLAUDE.md`: security
failures MUST NOT silently fall back to weaker defaults). On mismatch: `status='cert_mismatch'`, stop
syncing **that connection only**, log **one** clear line — a pin mismatch is not transient and must not
ride the backoff ladder — and raise a UI banner naming expected vs presented fingerprint. **The forecast
keeps working**: a failed sync appends nothing; append-only means "sync failed" and "sync wrote something
wrong" are _structurally_ different outcomes and only the former is reachable.

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

The obvious framing — _"the OIDC `isPrivateAddress` deny-list inverts, so build an allow-list"_ — **solves
the wrong problem.** Two primitives hide here, with very different severities:

| Primitive                          | What the attacker gains                                                       | Severity                        |
| ---------------------------------- | ----------------------------------------------------------------------------- | ------------------------------- |
| Network scan oracle                | Port/host enumeration **from LCM's network position**                         | Low–Moderate, largely redundant |
| **Stored-credential exfiltration** | The **vCenter service-account credential**, cleartext, to a host they control | **Critical**                    |

An IP/CIDR allow-list addresses the first and **does nothing** about the second: the attacker's own
workstation is already a legitimate private address. A "private IPs allowed" list happily permits
exfiltration to `https://10.20.30.40/`.

**The control that matters is a data-flow rule, not a network rule.**

### 6.2 ⚠️ The near-miss already in the codebase — the most important thing in this document

`routes/settings-auth.ts:154-170` **already implements the dangerous shape**: a caller-supplied
`issuerUrl` combined with a fallback to the **stored** `clientSecret`.

**It is not currently a vulnerability — and the reason is an accident of protocol.** `client.discovery()`
only fetches the issuer's _public_ metadata and never transmits the secret. The authors knew this; the
docstring on `sanitizeDiscoveryError` (`plugins/oidc.ts:48-53`) says so explicitly.

**vim25 `Login` DOES transmit the credential.** Copying this in-repo precedent — the natural thing for an
implementer to do, since it carries reassuring security comments — converts an accidentally-safe pattern
into a **critical credential-disclosure endpoint**. This must be `@ai-warning`-ed at both new routes.

### 6.3 Trust boundaries

- **TB-1 — Untrusted → API.** In `AUTH_MODE=disabled` (**production today**) this boundary is _open_:
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

| #   | Asset                            | Threat                                                                                                                 | Impact                                   | Control                       |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------- |
| T1  | **Stored vCenter credential**    | Caller supplies attacker URL; server decrypts and sends `Login` to it                                                  | **Critical** — vSphere estate compromise | **C1**, **C6**                |
| T2  | Internal topology                | Error/timing differentiation enumerates hosts+ports from LCM's position                                                | Low–Mod (∝ segmentation)                 | C2, C4, C5 (all partial)      |
| T3  | Internal HTTP services           | Fixed SOAP `Login` POST as blind write                                                                                 | Low                                      | C2 (https-only, no redirects) |
| T4  | Cloud metadata (169.254.169.254) | IMDS credential theft                                                                                                  | Negligible on-prem; hedges drift         | C3                            |
| T5  | **Scheduled poll**               | Attacker edits the **saved** URL and waits — the next unattended poll delivers the credential, no test endpoint needed | **Critical**                             | **C1 rule 3**                 |
| T6  | Credential in transit            | Self-signed cert + blanket skip-verify → MitM harvests credential **on every poll**                                    | **High**                                 | **C6**                        |
| T7  | Internal DNS names               | TOFU probe returns cert SANs → internal-hostname disclosure                                                            | Low–Mod                                  | C4a                           |

### 6.5 Controls

**C1 — ★ _the_ control. Restated to cover the scheduler, which is the primary target.**

> **The generative principle (this replaces case-by-case reasoning):**
> **In `disabled` mode, every API-drivable flow is attacker-drivable. The only asymmetry between the
> legitimate admin and an anonymous attacker is _knowledge of the vCenter password_. Therefore any
> invariant that must hold in `disabled` mode MUST be gated on the password.** No flow design, signed
> confirmation token, or "human confirms the thumbprint" step can substitute — the attacker drives the flow
> too, and **there is no human to consult.**

**The attack needs no test endpoint at all (T5):** in `disabled` mode the attacker writes the saved
connection's `url` → their host, waits, and the scheduled poll delivers the decrypted credential —
unattended, repeatedly, forever. That is _strictly better for the attacker_ than the test endpoint: no
interaction, persistent, and it survives deleting the test endpoint entirely. **Protecting only the test
endpoint would have protected nothing.**

> **C1: Stored credentials may only be sent to a destination whose _trust material_ was written by someone
> who knew the password.**
> **Any mutation to a connection's trust material MUST carry the current password. Reads and probes MUST
> NOT require it.**

**Trust material** = _where credentials go_ (`hostname`, `username`) + _what proves the destination's
identity_ (`tlsMode`, `pinnedCaPem`). One rule, covering the test path, the write path, and the poll.

**The split probe (adopted):**

| Phase                                | Endpoint                                      | Sends credential?               | Needs password?                  |
| ------------------------------------ | --------------------------------------------- | ------------------------------- | -------------------------------- |
| **P1 — reachability + cert capture** | `POST …/probe` (URL in body) or `…/:id/probe` | **No** — TCP/TLS handshake only | **No**                           |
| **P2 — verify login**                | `POST …/verify`                               | Yes                             | **Yes** (body; no fallback)      |
| **Trust / re-trust**                 | `POST …/:id/trust-ca`                         | No                              | **Yes** (mutates trust material) |

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
   observed the cert; it proves nothing about _who asked_. It is theatre in the exact mode production runs.
6. **Pleasant property:** C1 holds even against a _malicious admin_ who doesn't know the password.

**C2 — URL constraints + resolve-and-pin.** https only; **reject userinfo** (`url.username||url.password`
— blocks `https://vcenter.corp.local@attacker.example/` parser-differential tricks); port allow-list
`{443, 8443}` (removes 22/5432/6379/3306/8080/9200… from T2's reach) **[superseded by #199 — the port is now configurable over `1`–`65535`; see the Addendum 2026-07-18 below]**; `redirect: 'error'`; parse **once**
with WHATWG `new URL()`; `AbortSignal.timeout(10s)`; resolve all A/AAAA, vet each, then connect to a vetted
address via `connect.lookup` (verified typed, D10) so the check applies to the address actually connected
to — closing the TOCTOU the OIDC path openly accepts in its `@ai-warning` (`oidc.ts:167-175`).

**C3 — Residual deny-list (inverted from OIDC).** Deny loopback (`127/8`, `::1`), unspecified
(`0.0.0.0`, `::`), link-local + IMDS (`169.254/16`, `fe80::/10`), and IPv4-mapped forms of all of them.
**Explicitly permit** `10/8`, `172.16/12`, `192.168/16`, `fc00::/7`, `100.64/10`. **That inversion is the
whole point and MUST be commented as such**, or someone will "notice the inconsistency" with the OIDC
deny-list and re-add RFC1918, breaking every legitimate deployment. Factor the existing careful IPv4/IPv6
classifier out of `oidc.ts` (it already handles the `::ffff:7f00:1` mapped-form trap) and give it a
purpose-specific predicate. **Honest expectation:** its present value is _low_ — `db` is a separate
container at a private IP indistinguishable from a vCenter, so this **cannot** protect the database. It is
~10 lines hedging deployment drift, not the control doing the work.

**Any relaxation flag must be server-side config only, never request-body.** `oidc.ts:192-208` spells out
why: a caller-supplied flag that disables the caller's own deny-list is not a control. _Recommendation: do
not add the flag at all in v1._

**C4 — Flatten the error surface** to a closed enum — `ok | unreachable | tls_untrusted | not_a_vcenter |
auth_failed` — deliberately diverging from the OIDC precedent, which returns the raw error string. Merge
`ECONNREFUSED`/`ETIMEDOUT`/`EHOSTUNREACH`/`ENETUNREACH` into `unreachable`, collapsing the cleanest
scanning distinctions. Detail goes to the server log, correlated by pino request id.
**Honest limits: this blunts, it does not close.** `unreachable` vs `tls_untrusted` still separates
"closed" from "open+TLS", and timing still separates refused from filtered. Constant-time responses are
rejected as theatre (they'd pad every response to ~10s and the attacker still reads the enum).
**→ §12 Q5: this costs real admin debuggability.**

**C4a — TOFU disclosure (resolves the tension between C4 and TOFU).** The probe returns **the SHA-256
fingerprint and validity dates only** — _not_ subject, issuer, or SANs. A fingerprint is a hash: useless
for enumeration, sufficient for out-of-band confirmation against the vSphere Client or `govc about.cert`,
which is what an admin actually compares. This keeps TOFU usable without turning the endpoint into an
internal TLS scanner that discloses hostnames (T7).

**C5 — Per-route rate limit** ~10/min/IP. A speed bump, not a boundary — the global 300/min lets a
/24 × 5-port sweep finish in ~4 minutes; 10/min makes it ~2 hours, which stops opportunistic automation and
not a patient attacker. Include it because it's ~free; **do not count it in the security argument.**

**C6 — TLS: §5. ★ second load-bearing control.** Without it, C1 collapses: with verification off, "the
stored URL" no longer identifies a _host_, and a MitM harvests the credential on **every scheduled poll**,
silently, on the happy path, with no attacker interaction with the API at all.

**C7 — Bootstrap-safe admin gate.** Mirror `settings-auth.ts:78-83` verbatim: open while
`mode==='disabled'` (there are no accounts to authenticate against — requiring a real ADMIN would make the
feature unusable in the mode production runs today), hard admin-gated once `local`/`oidc` is on.
**Defensible only because C1 removes the critical primitive.**

**C8 — Read-only vCenter service account (operations doc). Highest value-to-effort ratio here.** LCM only
reads; it has no reason to hold a write-capable account. This is the **only** control that limits _blast
radius_ rather than _probability_ — every other control assumes the credential stays put; this one assumes
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
expensive, low-yield machinery. Anything justified only by _"ASVS says allowlist"_ is theatre here. If the
owner wants ASVS 1.3.6 formally ticked, that is a **decision to move this surface to L2** and must be
recorded as such, not smuggled in.

### 6.7 What the attacker actually gains — the honest answer

Mostly nothing they didn't have, **with one exception that is the whole ballgame**: they are already on the
internal network and can `nmap` from their own machine. But **vCenter management networks are commonly
segmented away from user VLANs** — that is standard vSphere practice, and this feature _implies_ LCM can
reach that network. If LCM sits where the attacker cannot, **LCM is a proxy across a segmentation boundary
they cannot otherwise cross.** That is genuine privilege escalation, and its severity is entirely a
function of the deployment's segmentation, which LCM cannot know. **→ §12 Q3.**

### 6.8 Residual risk (with C1–C8 adopted)

| #   | Residual                                                                                                 | Level                    | Why accepted                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Binary reachability oracle on 443/8443 from LCM's position, in `disabled` mode                           | Low–Mod (∝ segmentation) | **Irreducible** — a connection-test feature must report reachability. Closing it means deleting the feature. **Eliminated** by moving off `disabled`. |
| R2  | Authenticated ADMIN can probe                                                                            | Low                      | That is the _authorized_ use of the feature.                                                                                                          |
| R3  | Timing side channel survives C4                                                                          | Low                      | Constant-time rejected as theatre.                                                                                                                    |
| R4  | vCenter may not send the root in its chain → `pinned` degrades to a leaf pin that breaks on auto-renewal | **Unverified**           | Must be confirmed at implementation; `ca` mode is the fallback.                                                                                       |
| R5  | ASVS 1.3.6 (L2) not formally met                                                                         | Accepted                 | Project targets L1; allow-list rejected **on merit**, not cost.                                                                                       |

**Overall:** with C1 and C6, this endpoint is **not meaningfully more dangerous than the OIDC discovery
endpoint the project already ships and documents** — and it is better built, because C2's resolve-and-pin
closes a TOCTOU the OIDC path accepts. The severe primitive (T1) is **designed out**, not mitigated.

### 6.9 Documented caveat

A `> **SECURITY NOTE — vCenter connection testing.**` block will be added to `docs/operations.md`
alongside the existing OIDC note (`:346-358`), matching its register: private addresses are _permitted_
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
_"has the wall clock passed X?"_ — which, against a persisted `dueAt`, is the expression `dueAt <= now()`.
Worse, **they are all in-memory schedulers**: they forget everything on restart, and our single hardest
requirement (#178 catch-up) is precisely what an in-memory scheduler cannot do. We would carry the
dependency _and_ still write the whole persistence layer. And we do not want a cron DSL — there is one
monthly shape and one interval shape; exposing `0 0 1 * *` is a support burden and a timezone footgun.

The hand-rolled core is ~80 lines. _(If ever revisited: `croner`. Not `bree`.)_

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
>
> - explicit detach. Scheduler rows and the usage cache are pure derived state, rebuilt on the next tick ⇒
>   `Cascade`. D8's detach flow composes cleanly: detach clusters → delete connection → job rows and usage
>   samples cascade away, while **every cluster, host, and baseline survives**.

### D16 — Catch-up **is the data model, not a code path**

`dueAt <= now()` _is_ catch-up: server down three days ⇒ `dueAt` two days past ⇒ the first tick after boot
runs it. No "did I miss one?" branch to get wrong, no boot-time special case to test separately.

**Missed months must not stampede:** on success, `dueAt = firstOfNextMonthUtc(now)` — computed **forward
from now**, never `dueAt + 1 month`. Three missed months produce **one** catch-up run, not three. (Three
snapshots of _today's_ usage backdated to three past months would be **fabricated data** — actively
harmful in a purchasing forecast.)

> **⚠️ D16a — a failed snapshot MUST NOT consume its month. The unambiguous rule:**
>
> **The period written is `startOfUtcMonth(measuredAt)` — always derived from the clock at measurement
> time, never from `dueAt`.**
> **On success:** `dueAt = firstOfNextMonthUtc(now)`; `failureCount = 0`; `lastSuccessPeriod = P`.
> **On failure:** `dueAt = now + backoff`; `failureCount += 1`. **No period advance. Ever.**

**Deriving the period from `measuredAt` rather than `dueAt` makes staying in-period _emergent_, not an
invariant someone must remember**: a retry on 3 Aug still computes `2026-08-01` by itself, so no "clamp the
backoff within the period" rule is needed — and that clamp is exactly the version that eventually breaks.

**Backoff cap = 1 hour** (not OIDC's 60s, not the poll's 5 min). Worst case ~740 retries/month against a
dead vCenter — one API call each, trivial. Retrying _often_ is actively desirable: the earlier in August we
catch a recovery window, the more representative August's baseline is. Log `error` on the healthy→failing
transition and `warn` thereafter, so 740 lines aren't 740 alarms.

**vCenter down all August ⇒ 1 Sep writes September only; August is an honest gap.** A backdated August
built from September's usage is not missing data — **it is wrong data that looks real**, entering a
purchasing trend as a fact. **A gap is visibly absent; a fabrication is invisibly wrong.** In a tool whose
output buys hardware, that asymmetry decides it.

**A missed period gets three signals, because they answer different questions:**

1. **During the outage:** `lastSnapshotStatus='failed'`, `failureCount`, `lastError` — _"is it broken now?"_
2. **At recovery:** `lastSuccessPeriod @db.Date`. On success for period `P`, if
   `monthsBetweenUtc(lastSuccessPeriod, P) > 1`, log a loud `warn` naming the skipped months and surface
   "Missed: Aug 2026" in the settings panel (reuses existing `monthsBetweenUtc`) — _"did we lose anything?"_
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
constraint _be_ monthly idempotency — natively Prisma-expressible, no second column, no partial index.

_(A rejected alternative — a separate `periodMonth` column with a partial unique index or a generated
column — is **not** expressible in Prisma 7 and would reintroduce precisely the schema-drift pain that
migration `20260705080919_fix_hosts_serial_unique_index` / issue #123 was written to eliminate. Rejected.)_

### D18 — Concurrency: do it now (~6 lines), and **not** with advisory locks

Not premature, for a reason unrelated to replicas: **`docker compose up -d` overlaps containers.** The old
container drains for up to 10s (`index.ts:6,17-24`) while the new one boots and ticks — a genuine
double-run window **on today's single-instance deployment**.

A **conditional claim UPDATE**, expressed in plain Prisma — **no raw SQL**:

```ts
const { count } = await prisma.vsphereConnectionJob.updateMany({
  where: {
    connectionId,
    dueAt: { lte: now },
    OR: [{ runningSince: null }, { runningSince: { lt: staleThreshold } }], // 15-min stale lease
  },
  data: { runningSince: now, lockedBy: bootId },
});
if (count === 0) return; // someone else owns it — skip
```

`updateMany` compiles to a single `UPDATE … WHERE`, which Postgres executes atomically: under READ
COMMITTED a concurrent writer blocks, then **re-evaluates the WHERE against the new row version**, so the
loser sees `runningSince` already set and gets `count === 0`. Same guarantee as raw SQL. The 15-minute
clause doubles as a **stale-lease breaker** so a hard-killed process self-heals instead of wedging forever.

> **Corrected from an earlier draft, which proposed `$queryRaw … RETURNING *` and justified it with
> `routes/health.ts:10` as precedent.** That precedent is **weak and should not have been cited**: the only
> raw query in the entire server is `SELECT 1` in a readiness probe — a liveness ping, not business logic.
> `updateMany` gives identical atomicity with none of the grain against `CLAUDE.md`'s "don't use raw
> queries", so **there is no reason to reach for raw SQL here at all.** (`RETURNING *` isn't needed either
> — once the claim is held, a follow-up read is safe.)

**Not `pg_advisory_lock` / `FOR UPDATE SKIP LOCKED`:** both bind to a session/transaction, and Prisma's pg
adapter uses a **connection pool** (`plugins/prisma.ts:19-25`) — a session lock can't be reliably held
across awaits without pinning a connection, and `pg_advisory_xact_lock` would hold a transaction open for
the entire vCenter round-trip (`idle in transaction` for seconds-to-minutes). The claim-row UPDATE holds no
lock while the job runs.

### D19 — Time: **UTC, 1st of month, 00:00**

Not arbitrary — it is what the repo already does (`formatDateIso` slices `toISOString()`; `addUtcMonths` /
`monthsBetweenUtc` are UTC-based; every date column is `@db.Date`). A local/DST-aware schedule would import
a concept this codebase does not have into the one job that writes purchasing data.

**Reuse `addUtcMonths`, and note the trap it documents:** it _clamps_ day-of-month ("Jan 31 + 1mo = Feb
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
- Inject `Clock { now(): Date }` only to assert _which period_ is written.
- **Do not start the timer when `NODE_ENV==='test'`**, mirroring how `server.ts:66-77` already skips
  rate-limit and under-pressure in test.
- Inject the vCenter client behind an interface; vcsim is for the _client_ suite, not the scheduler suite.

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

- **Poll = 5 min.** ESXi samples real-time counters every **20 seconds**, so _nothing here is truly live_ —
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
- **A _sync_ failure aborts that connection's snapshot — deliberately.** Stale inventory means a wrong
  capacity denominator, and **a baseline with a wrong denominator is worse than a missing one**: it is a
  plausible lie that silently biases purchasing, where a gap is merely visible. The line is: **we never
  write a baseline we cannot stand behind.**
- **Product-visible consequence, stated plainly: gaps are per-cluster, not fleet-wide.** August exists for
  B and C's clusters and is missing for A's. That is the honest rendering of what happened.
- **Backoff clamps at the poll interval** — `min(pollIntervalMs, 30s · 2^attempt)`. Reusing
  `discoveryBackoffMs` (`oidc.ts:39-41`) verbatim would retry a dead vCenter after 2s, _noisier than the
  normal cadence_.

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

**Why a union and not `values + optional flag`:** it makes `never_fetched` _structurally incapable_ of
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
_The degrade path we had to build anyway is the load-shed path._

### D25a — **Capacity is dropped from the cache entirely.** One owner, structurally.

**Capacity is inventory, not usage.** It changes when a host is physically installed — a sync event, on a
scale of months. **Nothing about it is live.** Putting it in a 5-minute usage cache would duplicate
inventory into a cache with a _different owner and a different cadence_, guaranteeing the two disagree (a
host added 10 minutes ago is in the poll but not yet in inventory). `docs/vision.md` names exactly that
failure — _"charts are cluttered or misleading, causing people to distrust the data and revert to
spreadsheets"_ — as an anti-pattern.

- **Authoritative denominator for both the live view and the forecast: the synced inventory.** One owner,
  one number, **structurally incapable of disagreeing**.
- The sample keeps only what is genuinely live: `memoryUsedGiB`, `hostsSampled`, `hostsTotal`, `measuredAt`.

**A bonus falls out of dropping it:** keep `hostsTotal` (a _count_ from vCenter, not a capacity). If it
disagrees with LCM's synced in-service host count, that is a precise **"inventory is behind"** signal ⇒ set
the connection job's sync due immediately (`dueAt = now()`). The poll becomes a cheap change-detector that
self-heals the 6-hour window for the only case that matters (a host was added), while owning no capacity
whatsoever — a better answer to _"why not sync more often"_ than shortening the interval.

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
  honest cost — conflating _when we measured_ with _which period this represents_ — is what the nullable,
  informational `observedAt` absorbs; it is in no key and read by nothing on the forecast path.
- **`source` is NOT in the unique key.** Including it would let a manual and a vSphere row coexist for the
  same period, making **"the newest baseline" ambiguous** and forcing an implicit tiebreak — for a value
  anchoring hardware purchasing, that is a bug waiting to be found by a wrong invoice. Excluding it means
  **exactly one truth per metric per period**, and a manual correction to a month that already has a
  snapshot is an _explicit overwrite_ (upsert; `source` flips to `manual`) — which is what an admin
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
whose failure mode (drift against the newest history row) is _silent_ and _wrong_ — the worst available
combination for this value.

**But the web needs a cluster-level date** (`stale-baseline.ts`, `fleet-console.tsx:85`,
`cluster-panel.tsx:194`, `window-controls.tsx:45` all consume `ClusterResponse.baselineDate`). So **keep the
response field and derive it**:

> `ClusterResponse.baselineDate` = **MIN** over the newest-per-metric `capturedAt`.

**MIN, not MAX — deliberately.** MIN means staleness reflects the _stalest_ metric; MAX would let a
freshly-synced metric **hide a stale one**, so the tile reads healthy while an anchor driving hardware spend
quietly rots. Single-metric clusters (i.e. every cluster today) make MIN and MAX identical, so this costs
nothing now and prevents a subtle wrong answer later. Keeping the field name means **zero web churn**.

**Leave `ForecastInput.baselineDate` alone.** It is the internal contract of the _pure_ forecast function;
renaming it would churn `forecast.ts` + `scenario.ts` + `forecast.test.ts` for no behavioural gain and widen
the diff across the exact code the correctness invariants protect. **The pure function must never learn that
history exists** — that is what keeps the regression test meaningful.

### D29 — The semantic change, and why the migration is provably behaviour-preserving

Today `Cluster.baselineDate` is **one date for all metrics** (`clusters.ts:225` passes it into
`computeForecast` for every metric). The new `capturedAt` is **per metric row** — a real semantic change for
multi-metric clusters. It doesn't bite today (the seed only creates `memory_gb`), but the API permits up to
50 metrics (`cluster.ts:16`), so the migration must be correct for them.

**The backfill resolves it exactly:** every existing row for cluster C gets `capturedAt = C.baseline_date`.
All of C's metrics land on the same anchor — _which is today's semantics, reproduced precisely._ Divergence
can only begin with a **future** write. The migration is provably behaviour-preserving.

_(Correction to #177's premise: `Cluster.baselineDate` is `DATE NOT NULL` and **can never be NULL**, so the
backfill needs no NULL branch. And `import-xlsx.ts` does **not** touch baselines — the parser extracts them
but the importer discards them, so it needs no migration work. §12 Q7.)_

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
> edits `_prisma_migrations` bookkeeping so a _failed_ migration stops blocking the next `deploy`. Anyone who
> reads the flag name and expects an undo produces a database whose actual shape and recorded history
> disagree — worse than either failure alone.

| Situation                                               | Recovery                                                                                                                                                                                                                          |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration fails mid-run                                 | Prisma runs each migration in a transaction ⇒ DDL rolls back atomically; the entrypoint's `migrate deploy` fails ⇒ **the container does not start Fastify** ⇒ fails safe, serving nothing rather than wrong numbers. Fix forward. |
| Migration OK, code bad, **≤1 row** per (cluster,metric) | Roll back `LCM_IMAGE_TAG`. Old columns exist, `baselines[0]` still unambiguous, `baseline_date` still populated. **Safe.**                                                                                                        |
| Migration OK, **≥2 rows** for any (cluster,metric)      | ❌ **Image rollback NOT safe** — silently wrong forecasts. Recovery = restore the pre-PR-1 dump, losing everything written since. **This is why the dump must be verified before deploying, not after.**                          |
| After PR 2 (contract)                                   | Image rollback never safe. Dump-restore only.                                                                                                                                                                                     |

Backup uses the documented `pg_dump --format=custom` flow (`docs/operations.md:138-156`); **the dump must be
verified restorable (row counts matching production) before PR 1 deploys.**

### D32 — Forecast-correctness invariants

1. **The absolute requirement:** for any (cluster, metric) with exactly one baseline row, `computeForecast`
   output is **byte-identical** before and after. D29 makes this _structurally_ true, so the test confirms a
   property the design already guarantees.
2. **The anchor is `MAX(capturedAt)`, unconditionally.** ⚠️ Note what is _not_ proposed:
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
2. It **passes against current `dev`**, because it is a _characterization_ test: it captures today's
   behaviour as-is, bugs included. It asserts nothing about correctness — only **sameness**.
3. **The migration PR must not change the committed snapshot.** Any diff there is a behaviour change that
   must be explained or reverted.

> A snapshot written _inside_ the migration PR proves nothing — it records whatever the new code happens to
> do, and the reviewer cannot tell the difference.

**Three things must be pinned or a naive `toMatchSnapshot()` fails confusingly:** the **clock**
(`clusters.ts:295` `firstOfCurrentMonth()` calls `new Date()`, so `currentConsumption`/`utilization` drift
monthly — needs `vi.setSystemTime()`, which would be the **first server-side use**); **ids** (`cuid()`s
differ every run — `factories.ts` must accept explicit ids); and the **window** (pass explicit
`fromMonth`/`toMonth`). _(Verified: `host-projection.ts` has no `new Date()`, so the explicit-window path is
clean.)_

**Supporting integration tests** (Vitest + Testcontainers, real Postgres): newest-baseline anchoring;
**DB-level idempotency** (two inserts with the same key → second rejected — assert against real Postgres,
since the whole point is that the _database_ enforces it); **restart idempotency** (run the job twice on
different _days_ of the same month → exactly one row — the test that proves D27's period-anchor decision);
multi-metric MIN assertion (**load-bearing**: a MAX implementation passes every single-metric test, which is
every test that exists today); archived cluster survives; and **"update no longer destroys"** (the direct
regression for D26). Backfill correctness: seed the _old_ shape, run the migration, assert row counts and
`captured_at` values — the suite already runs `prisma migrate deploy` in `vitest.global-setup.ts:40`.

---

## 9b. ⚠️ D34 — The forecast-correctness landmine: synced hosts **double-count** against `baselineCapacity`

**This is the single most dangerous finding of the design gate. It was not in any issue. Verified in
source, not inferred.**

`forecast.ts:117-122` computes capacity as an **offset plus addends**:

```ts
let capacity = input.baselineCapacity; // :117
for (const host of hosts) capacity += effectiveCapacityAt(host, date); // :120-122
```

**Tracked hosts are ADDITIVE to `baselineCapacity` — they are not the total.**

**Why nothing catches it today:** the seed's `ReferenceHost` carries no capacity field (`seed.ts:13-24`)
and host create/update writes **no `capacities`** (`seed.ts:148-192`), so seeded hosts contribute **0** and
`baselineCapacity` (7680 / 40960 / 8192 / 4096 — "derived from the original Capacity_Forecast_vSphere.xlsx
(May 2026 baseline column)", `seed.ts:56-85`) carries the entire cluster. The additive path is effectively
**unexercised for capacity**. But the API _requires_ ≥1 capacity row per host
(`packages/shared/src/schemas/host.ts:16`).

**The hazard:** if sync imports every host with its real `hardware.memorySize` **and** the monthly snapshot
writes `baselineCapacity` = measured fleet capacity, then:

> `capacity = fleet + fleet = 2 × real` ⇒ **utilization halves** ⇒ _"plenty of headroom"_ ⇒ **no hardware
> purchased** ⇒ **precisely the outage LCM exists to prevent.**

It is silent, produces a plausible number, and **no existing test would catch it.**

### D34a — ⚠️ The same trap exists for **consumption**, and the fix must cover both halves

`forecast.ts:118` + `:126-130` is **structurally identical**:

```ts
let consumption = input.baselineConsumption; // :118
for (const app of applications) consumption += effectiveAllocationAt(app, date); // :126-130
```

So _"`baselineCapacity = 0` but `baselineConsumption` stays a genuine measurement"_ **double-counts
consumption** whenever a tracked application has `effectiveDate <= capturedAt` — the app's memory is
already inside the measured baseline _and_ added again as an addend.

> **The real invariant, which must be stated once and applied to both halves:**
> **`baseline*` is the portion NOT modelled by tracked entities.**
> `= 0` is the _special case_ where tracked entities cover 100%. That is true for **capacity** on a synced
> cluster; it is **not** automatically true for **consumption**.

> **⚠️ This trap is live in `dev` today — vSphere only makes it systematic.** Hand-enter a May baseline,
> add an application backdated to January, and the forecast already double-counts a workload that was
> inside the measurement. The monthly snapshot turns an occasional hand-entry mistake into a **monthly,
> automatic** one.

**The missing test, named precisely:** `forecast.test.ts` covers `baselineCapacity: 0` with hosts carrying
everything (`:108`) **and** nonzero baselines (`:34` = 7680, `:253` = 5000) — while the seed uses a nonzero
baseline with hosts carrying **nothing** (`seed.ts:56-85`, `:148-192`). Both _pure_ modes are covered.
**The mixed quadrant — a nonzero `baseline*` AND tracked entities both accounting for the same physical
capacity — is what nothing tests, and it is exactly what sync creates.**

### D34b — ⚠️ Zero capacity renders as **0% utilization = maximum headroom = healthy**

`forecast.ts:138`: `const utilization = capacity === 0 ? 0 : consumption / capacity;`

A synced cluster whose window predates any host — or a sync that writes 0 capacity — displays a reassuring
**0%** exactly where the truth is **"unknown"**. Same silent-plausible-wrong shape as the double-count, in
the opposite direction, and it **defeats the staleness detector we were relying on as the backstop**.

Fixing it (`null` rather than `0`) changes forecast output for **every zero-capacity month** — so it is
high-risk, belongs to this gate, and **must not be a quiet edit inside #177.** → **§12 Q9.**

### D34c — Recommended direction (§12 Q9 — the owner's call, not the design's)

For **synced** clusters, `baselineCapacity = 0` and let synced hosts carry 100% of capacity. vCenter gives
authoritative per-host `hardware.memorySize`, and that is what makes the existing EOL / decommission /
replacement machinery operate on real numbers — the point of syncing hosts at all. **`baselineConsumption`
must then be reconciled against tracked applications per D34a's invariant, not simply left as a
measurement.** Manual clusters are untouched.

> **These modelling semantics are documented nowhere.** `docs/vision.md` does not describe them.
> Purchasing-critical arithmetic resting on an _undocumented_ modelling convention is itself a finding —
> **this gate should produce that documentation** (§11.7).

> **⚠️ Knock-on that MUST be solved with it, or the chart silently flatlines.** `effectiveCapacityAt`
> returns **0 before `commissionedAt`** (`forecast.ts:177`), and **vCenter cannot tell us when a host was
> commissioned.** A fleet imported today would show capacity 0 for all prior history — and
> `utilization = capacity === 0 ? 0 : …` (`forecast.ts:138`) renders that as **0% for every month before
> the import.** Synced hosts therefore need `commissionedAt` backdated (to `cluster.baselineDate`, or
> first-seen). Unresolved: what value is _honest_ here, given we genuinely do not know. **§12 Q9.**

---

## 9c. ⚠️ Late findings that supersede parts of §0 — RE-RAISED for the owner (Hard Rule 5)

Continued cross-examination after the §0 decisions were taken produced four findings that **change the
basis on which two of those decisions were made.** Recorded here rather than absorbed silently.

### D35 — ⚠️ The double-count is **one mechanism with four instances**, and the fix is a _forecast-time filter_ — not a snapshot-time subtraction (SUPERSEDES Q9b)

> **The mechanism: an advancing anchor absorbs a delta that was legitimately forward-looking when written.**

| #   | Instance                                   | Code                        |
| --- | ------------------------------------------ | --------------------------- |
| 1   | Applications                               | `forecast.ts:126-130`       |
| 2   | `consumptionDelta` events                  | `forecast.ts:132-136`       |
| 3   | `capacityDelta` events                     | `forecast.ts:132-136`       |
| 4   | Synced host capacity vs `baselineCapacity` | `forecast.ts:117-122` (D34) |

**Worked example (instance 3), verified:** admin models `capacityDelta +2560` at `2026-10-01`. October: the
memory is physically installed, sync writes new `HostMetricCapacity` rows. November: `effectiveCapacityAt`
(`:188-192`) returns the **new, larger** amount — which already contains the +2560 — and `:132-136` then
adds the event's `capacityDelta` again because `2026-10-01 <= 2026-11-01`. **`capacity = real + 2560`.**

> **The uniform rule:**
> **Filter deltas** — applications, `consumptionDelta` events, `capacityDelta` events — to
> `effectiveDate > anchor.capturedAt`.
> **Never filter measurement carriers** — hosts, `baselineConsumption`, `baselineCapacity`.

This is strictly better than a consumption-side-only rule because it **explains why hosts are exempt**
(_they are the measurement_, distributed per host rather than collapsed into a scalar) instead of leaving
the asymmetry looking accidental. It holds unchanged for **manual** clusters too, where
`baselineCapacity = 7680` _is_ the scalar measurement and a `capacityDelta` dated before `baselineDate`
double-counts identically. **One rule, both sources, both delta types.**

**⚠️ Why this supersedes Q9b's "snapshot subtracts allocations":**

- **It doesn't cover events at all** — only applications. Instances 2 and 3 would remain live.
- **Create-time/write-time validation is structurally dead:** `startedAt > capturedAt` is _true when
  written and made false by the passage of time_ — the snapshot job itself falsifies it. Green at write,
  wrong a month later, no admin action, no warning. **A predicate validated against a moving target.**
- **A forecast-time filter is self-correcting** as the anchor advances, has nothing to drift, and
  **mutates no admin-authored data from a background job** — which would be a Golden Rule 3 problem in its
  own right. (It also removes the "retroactively-edited allocation won't retro-adjust" rough edge that Q9b
  carried.)

**Coupled decision, and it cannot be split:** the anchor choice and the absorption rule must be decided
together. **Anchor = latest** (§D32 invariant 2) is confirmed — and first-anchor is wrong for a reason
beyond "stops tracking reality": **the monthly re-anchor IS the error-correction mechanism.** Anchored
permanently on the first baseline, every modelling error compounds forever with nothing to correct it —
precisely what #172 exists to end.

### D36 — ⚠️ Q4 RE-RAISED: `tls-baseline` reversed its recommendation to **dual-write**, and the reason defeats my framing

The Q4 decision was taken on my "in-place (Recommended)" framing. **That recommendation has been withdrawn
by its author**, on an argument I did not put in front of the owner:

|                | Worst case after an image rollback                                                                                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dual-write** | The old table holds a **stale but previously-correct** value. Wrong only by being _old_ — and **staleness is visible**: `stale-baseline.ts` already flags it on the fleet tile (`cluster-tile.tsx:303`). **The existing tripwire catches it.**                                                                            |
| **In-place**   | `baselines[0]` returns an **arbitrary** row — and because PR 1 dual-writes `clusters.baseline_date`, the response pairs that arbitrary value with a **fresh, correct date**. Staleness says _"healthy."_ A 3-year-old capacity number presented as current, with **no signal**, on the number that drives hardware spend. |

> **A fresh date on an arbitrary value is strictly worse than a stale date on a real value** — the first
> **defeats the detector we already have**; the second trips it. That asymmetry is decisive on its own, and
> it was absent from the framing the owner decided against.

**Second under-weighted point: in-place's recovery is disproportionate.** Rolling back after the window
closes means restoring a `pg_dump`, which discards **every** write since the dump — hosts, items, events,
sessions — not just baselines. That is a heavy, lossy operation to reach for because a _forecast bug_
shipped. Dual-write's recovery is `LCM_IMAGE_TAG=<previous> && docker compose up -d`: **lossless, at any
time, forever.**

**Honest cost of dual-write:** two write paths in `ClustersService` for one release, both tested; one rule
to get right (_the old table mirrors the **newest** baseline — a manual edit backfilling an **older** period
must not touch it_); a second model in `schema.prisma` for a release; a naming choice at contract time.
**What it buys:** the rollback window **never closes**, and §D30's warning — the loudest paragraph in this
document — **ceases to exist**. _A hazard removed by construction beats a hazard documented._

**What would legitimately keep in-place:** judging rollback sufficiently unlikely (single-replica, CI-gated,
two people who'd catch it in dev) that the extra path isn't worth carrying. That is a real risk-appetite
call and it is the owner's — but it should be made knowing **the in-place failure mode is invisible to the
staleness detector.** → **§12 Q4-REVISED.**

### D37 — ⚠️ HARD REQUIREMENT: the scheduler tick must never reject — Hard Rule 4 is currently unenforceable

**Verified, and it falsifies every degrade path in this document:**

- `plugins/error-handler.ts:10` — `fastify.setErrorHandler(...)` is **request-scoped**. It **cannot see a
  background job.**
- `index.ts:31-34` — `unhandledRejection` → `void shutdown('unhandledRejection', 1)` → `process.exit(1)`.
- `docker/docker-compose.yml:42,110,133` — all services are `restart: unless-stopped`.

⇒ **Any** uncaught rejection in the scheduler — a vCenter timeout, a TLS handshake failure, a Prisma hiccup
— **kills the server**, and `restart: unless-stopped` converts every transient vCenter failure into a
**permanent restart loop.**

This silently assumes-away §D9's per-connection statuses, §D16a's failure backoff, and §D22's
per-connection independence: **all of them assume the rejection stays inside the job, and nothing enforces
that.**

> **The cleanest instance of the pattern in this whole gate: `unhandledRejection → shutdown` is _correct as
> written_.** For a purely request-scoped server, Fastify catches everything request-shaped, so a surviving
> unhandled rejection genuinely is a bug worth dying on. **#178 adds the first background loop and that
> premise silently becomes false — in code nobody is editing.**

**Requirement:** the tick body is wrapped so that **no path can reject**; every job failure is caught,
recorded to the job row, and logged. This is a **precondition for Hard Rule 4** ("never crash"), not a
nicety — without it, "vCenter unreachable ⇒ serve last known data" is false. **Must be tested**: a job whose
client throws must leave the server serving.

### D38 — ⚠️ #176 gap: adoption can duplicate a host, doubling capacity

Host identity is `(connectionId, moref)`; a **manually-created** host has both NULL, so sync sees no match
and **creates a second row for a machine already modelled by hand.** Both rows carry capacity ⇒ **doubled
capacity** — the same family as D34.

The obvious backstop does not close it: `@@unique([tenantId, serialNumber])` exists (`schema.prisma:150`),
but `serialNumber` is **nullable** (`:126`), and the schema's own comment says why that matters — _"Postgres
treats NULLs as distinct, so NULL-serial rows never conflict"_ (`:141-147`). A hand-entered host without a
serial — entirely normal, the field is optional — **silently duplicates on adoption.** Where both rows _do_
have serials, sync hits a P2002 and fails instead: safer, but still wrong (adoption shouldn't error).

**#176 needs an explicit host-reconciliation rule:** match a discovered host to an existing manual host by
`serialNumber` when both have one; otherwise **an operator-confirmed mapping step, never a silent create** —
the same shape as D6's `instanceUuid` re-adopt (_identity that cannot be established automatically must be
confirmed, never guessed_). Depends on whether vCenter reliably reports a usable host serial.

---

## 10. Phase plan

| Order | Issue                                                       | Risk        | Gate                                                   |
| ----- | ----------------------------------------------------------- | ----------- | ------------------------------------------------------ |
| 0     | **#174** — this document                                    | High        | **Owner approval (§13)**                               |
| 1     | **NEW** — fix `clusters.ts:132` baseline data-loss bug (Q8) | Normal      | Own PR, lands **before** #177                          |
| 2     | **NEW** — D33 characterization snapshot of `ForecastResult` | Low         | Own PR; **must pass against current `dev`**            |
| 3     | **#177** — baseline history + chart + Q9d utilization       | **High**    | Owner approval on the PR; **verified `pg_dump` first** |
| 4     | #175 — connections, encrypted creds, TOFU trust flow        | **High**    | Owner approval on the PR                               |
| 5     | #176 — inventory sync                                       | High        | Per approved design                                    |
| 6     | #178 — monthly snapshot + scheduler                         | Normal–High | Depends on #176 + #177                                 |
| 7     | #179 — live usage view                                      | Normal      | Depends on #175 + #176                                 |

Per phase: worktree off `origin/dev`, TDD, Zod contracts in `@lcm/shared` first,
`pnpm lint && pnpm typecheck && pnpm test` green before the PR, PR → `dev` with `Closes #<n>`, merge
`--merge`, then remove the worktree and the local branch.

**Sequencing rationale.** Steps 1–3 land before any vSphere connectivity: #177 is independently valuable
(manual baselines gain history), it de-risks the migration, and **D33's characterization test is worthless
unless it lands first** — written inside the migration PR it would merely record whatever the new code
happens to do. Step 1 precedes step 2 so the snapshot captures a _fixed_ baseline path rather than
enshrining a live data-loss bug.

> **⚠️ Q9d makes the characterization snapshot diff — on purpose.** Returning `null` at zero capacity
> changes output for every zero-capacity month. That diff is the _evidence the change worked_, not noise:
> it must be reviewed line-by-line and explained in the PR body. **Every other line of the snapshot must be
> unchanged.**

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
7. **The forecast's modelling semantics must be documented** (D34/D34a) — that `baseline*` is _the portion
   not modelled by tracked entities_ is purchasing-critical arithmetic currently recorded **nowhere**, and
   the double-count trap it guards against is **already reachable in `dev` today** via a backdated
   application. This gate should produce that documentation regardless of what else is approved.

---

## 12. Open questions — blocking approval

| #                  | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Why it blocks                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q4-REVISED** ⚠️  | **Re-decide: in-place vs new-table dual-write.** The "in-place (Recommended)" framing you decided on **has been withdrawn by its author** (§D36). The missing argument: in-place's post-rollback failure pairs an **arbitrary** baseline value with a **fresh** date, so `stale-baseline.ts` reports **"healthy"** — a 3-year-old capacity number presented as current, with no signal. Dual-write's failure is merely _stale_, which the existing tripwire catches. Also: in-place recovery = `pg_dump` restore, discarding **every** write since the dump (hosts, items, events, sessions); dual-write recovery = `LCM_IMAGE_TAG` rollback, lossless, forever. **Legitimately still in-place** if you judge rollback unlikely enough not to carry the extra path — but decide it knowing the in-place failure is **invisible to the detector**. |
| **Q9b-REVISED** ⚠️ | **Re-decide: forecast-time delta filter, replacing snapshot-time subtraction** (§D35). Your intent was right; the mechanism was wrong — it covered only applications (missing both **event** instances), and write-time validation checks a predicate the snapshot job itself later falsifies. Uniform rule: **filter deltas** (apps, `consumptionDelta`, `capacityDelta`) to `effectiveDate > anchor.capturedAt`; **never filter measurement carriers** (hosts, `baseline*`). Self-correcting, nothing to drift, mutates no admin-authored data.                                                                                                                                                                                                                                                                                                 |
| **Q9** ⚠️          | **THE BIG ONE — the forecast modelling semantics.** Four linked parts: **(a)** for synced clusters, `baselineCapacity = 0` with hosts carrying 100%? **(b)** how is `baselineConsumption` reconciled against tracked applications (the same double-count applies — D34a)? **(c)** what should a synced host's `commissionedAt` be, given vCenter cannot tell us? **(d)** should `utilization` return `null` instead of `0` when capacity is 0 (D34b)?                                                                                                                                                                                                                                                                                                                                                                                             | Otherwise capacity **double-counts** (`2 × real` ⇒ utilization halves ⇒ _"plenty of headroom"_ ⇒ **hardware not purchased**). Silent, plausible, and **the mixed quadrant is untested today**. (c) decides whether the historical chart flatlines at 0%; (d) changes forecast output for every zero-capacity month, so it is gate-level, not a quiet #177 edit. |
| **Q1** ✅          | **Confirm: LCM's `'GB'` is GiB (2³⁰).** The evidence is strong (govmomi's `units` is 1024-based; `govc cluster.usage` does `<< 20`; VMware states the base-2 convention). **Confirm your spreadsheet figures came from the vSphere UI** — i.e. round numbers like 512/768/1024.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Answered by research (D3a), but it is **your data** — a wrong call is a silent 7.4% on every synced host. Also: do you want the `unit` label corrected to `GiB` (product decision), or just documented?                                                                                                                                                         |
| **Q2**             | **Will LCM address the vCenters by FQDN or by IP?**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | By IP, default VMCA certs have **no IP SAN**, so hostname verification fails regardless of trust — `ERR_TLS_CERT_ALTNAME_INVALID` (D11). Changes what ships.                                                                                                                                                                                                    |
| **Q3**             | **Is your vCenter management network segmented from user VLANs?**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Sets the true severity of R1. If not segmented, the residual scan risk drops to ~zero and C5 could be dropped (§6.7).                                                                                                                                                                                                                                           |
| **Q4**             | **Migration rollback appetite:** in-place (simpler; rollback window closes at the first appended baseline) vs new-table dual-write (image-rollback safe indefinitely; a write-only second table for one release)?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Risk-appetite call the owner should make explicitly (D30).                                                                                                                                                                                                                                                                                                      |
| **Q5**             | **Accept coarse test-endpoint errors** (`unreachable`/`tls_untrusted`/…) with detail in the server log?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | The one real usability cost in the control set (C4).                                                                                                                                                                                                                                                                                                            |
| **Q6**             | **Do manual baselines snap to first-of-month like vSphere ones?**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | If not, the uniqueness property silently fails and MAX picks by accident of date (D27).                                                                                                                                                                                                                                                                         |
| **Q7**             | `import-xlsx.ts` discards parsed baselines — intentional?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Cosmetic, but a latent gap worth confirming (D29).                                                                                                                                                                                                                                                                                                              |
| **Q8**             | **Do you want the `dev`-today data-loss bug (D26) fixed as part of #177, or as its own separate issue/PR?**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | It is a pre-existing bug, not this epic's — but #177 rewrites that exact code path, so fixing it there is nearly free. Your call on scope hygiene.                                                                                                                                                                                                              |

---

## 13. Approval

- [x] **Environment facts (§1) confirmed** — 2026-07-17.
- [x] **Blocking decisions recorded (§0)** — Q9a, Q9b, Q9c, Q9d, Q2, Q4, Q6, Q8 — 2026-07-17.
- [x] **Scope amendments (§11) accepted** — 2026-07-17.
- [x] **Threat model and control set (§6) accepted**, ASVS L1 note and residual risks included — 2026-07-17.
- [x] **TLS policy (§5) accepted**, incl. §0.1's recorded rejection of an insecure mode — 2026-07-17.
- [x] **Migration strategy accepted** — 2026-07-17, **as new-table dual-write** (Q4 re-decided), so the
      rollback window never closes and §D30's warning does not apply.
- [x] **`docs/vision.md` amendment (§11.5) approved** — 2026-07-17.

> ## ✅ GATE APPROVED — 2026-07-17. Implementation authorised.
>
> Order: **#181** → **characterization snapshot** → **#177** → **#175** → **#176** → **#178** / **#179**.
> Hard Rule 2 still applies: **#177 and #175 stop for explicit approval before merging.**
> Hard Rule 5 still applies: if implementation shows a decision here is wrong, **stop and re-raise it**.

### 13.1 What approval commits to, in one paragraph

A **hand-rolled vim25 SOAP client** (no viable dependency exists) reading memory from **N vCenters** over
**TOFU root-pinned TLS with no insecure mode**, storing credentials with the existing `secret-box` and
**never sending them to a request-supplied destination** — the rule that also covers the scheduler, which
is the real target. Inventory syncs every 6h, usage polls every 5 min into a **Postgres cache** so no API
response ever awaits vCenter, and a **hand-rolled scheduler** (one claimed job row per connection, `dueAt
<= now()` _is_ catch-up) appends **one baseline per cluster per month**, DB-enforced idempotent, where a
failure **never consumes its month** and a missed month is an **honest gap rendered as a break in the
line** — never interpolated. Baselines become **append-only history**; for synced clusters
`baselineCapacity = 0` with hosts carrying 100% and `baselineConsumption` net of tracked apps, per the
invariant **`baseline*` is the portion not modelled by tracked entities**; and `utilization` returns
**`null`, not 0%,** when capacity is unknown.

---

## Addendum 2026-07-18 — configurable vCenter port (#199)

**Shipped in #199.** Supersedes part of §6.5 (C2) and confirms §6.5 (C5). Recorded here so the history
stays legible; the superseded text above is left intact, with an inline pointer at C2.

- **The port is now configurable per connection, over the full `1`–`65535` range.** A `port` field on
  `VsphereConnection` (default `443`) carries it; `hostname` still holds no scheme and no port.
- **This SUPERSEDES C2's `{443, 8443}` port allow-list.** The trust gate is **TOFU root-pinning (D11),
  not a port allow-list** — the allow-list only ever addressed T2's low-severity scan oracle, which §6.7
  and R1 (§6.8) already accept as irreducible for a connection-test feature. **The port never relaxes
  TLS:** `rejectUnauthorized` stays `true` on the credential path and the scheduled poll, and the `ca:`
  root pin (D11/D11a) is unchanged. A configurable port widens _where we connect_, never _what we trust_.
- **C5's per-route rate limit is now IMPLEMENTED at 10/min/IP on every route that can probe, create,
  re-arm, or re-point outbound vCenter work** (`…/connections`, update, sync, trust-ca, probe, and
  verify). §6.5 listed it as "~free, include it"; it is a speed bump, not a boundary, and is still not
  counted in the credential-security argument. Because create seeds durable work, the scheduler also
  has a hard work budget of **five oldest due connections per one-minute tick**, with established
  vCenters first and at most one never-connected endpoint in that batch. Queue depth can delay first
  contacts, but cannot starve established inventory work or turn the HTTP limit into an unbounded burst
  of persistent background probes.
- **Q2/D11's ruling — "FQDN + TOFU root-pinning, no TLS override" — is unchanged.** A configurable _port_
  is categorically different from a configurable _trust_ toggle (§0.1): the port only changes the
  destination socket; it cannot turn verification off. §0.1's rejection of an `insecure`/`ignore TLS`
  flag stands, undiminished.
- **A port change is trust material** — under C1 (trust material = _where credentials go_) it re-demands
  the current vCenter password, exactly as a hostname change does. **But a port change does NOT reset the
  pin:** same host means the same Machine SSL certificate, so the pinned root still applies (unlike a
  hostname change, which clears the pin and the discovered `instanceUuid`).
