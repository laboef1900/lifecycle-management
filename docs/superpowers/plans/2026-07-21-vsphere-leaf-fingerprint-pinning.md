# vSphere Leaf-Fingerprint TLS Pinning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace vCenter root-CA pinning (and PR #278's refuse-to-pin fallback) with leaf-certificate SHA-256 pinning, verified at the socket before any credential byte is written, so trust "just works" against self-signed, incomplete-chain, and full-chain vCenters alike.

**Architecture:** The stored pin becomes the leaf certificate's SHA-256 (`tlsPinnedSha256`). The credential-bearing `soapCall` connects with `rejectUnauthorized: false` inside a single confined `createConnection` factory that compares the presented leaf's fingerprint to the pin and destroys the socket before the HTTP layer writes, on any mismatch. A `null` pin keeps today's system-trust path (`rejectUnauthorized: true`). The root-walk pinning machinery **and** #278's self-signed-anchor gate (`evaluateProbedChain`/`isSelfSignedAnchor`/`chain_incomplete`) are removed — leaf-pinning makes "is there an anchor to pin?" moot.

**Tech Stack:** Node 26 (`node:tls`, `node:https`, `node:crypto`), Fastify 5, Prisma 7, Zod 4, Vitest + Testcontainers, React 19.

**Spec:** `docs/superpowers/specs/2026-07-21-vsphere-leaf-fingerprint-pinning-design.md`.

**Base:** branch `fix/272-vsphere-leaf-pinning-design`, rebased onto `dev` **including PR #278** (`a0509c7`, merged 2026-07-21). The design + this plan are committed on it. This change **supersedes both D11 and #278** — verify #278 is in ancestry (`git merge-base --is-ancestor a0509c7 HEAD`) before starting.

## Global Constraints

- TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. No `any`, no `@ts-ignore`, no `eslint-disable`, no skipped tests (CLAUDE.md Golden Rule 5 & 8).
- Every API input/output validated with a `@lcm/shared` Zod schema, parsed inside the handler.
- **Security invariant (linchpin):** on a credential path, no application byte reaches the socket until the presented leaf SHA-256 equals the pin. `rejectUnauthorized: false` exists ONLY inside the fingerprint-gated factory. A `null` pin uses `rejectUnauthorized: true` (system trust) — it never connects insecurely.
- **Do NOT use `checkServerIdentity` for the fingerprint check** — it does not run when `rejectUnauthorized: false` (design D10). Use the TLS socket's `secureConnect` event.
- **Lockstep union rule:** `VsphereProbeResult.outcome` is a hand-written TS interface (`schemas/vsphere.ts`) AND a runtime Zod validator `vsphereProbeResultSchema` (`schemas/responses.ts`). `z.ZodType<T>` does NOT enforce enum exhaustiveness — any outcome change MUST touch both, and `responses.test.ts` is the guard.
- Fingerprints are uppercase colon-separated SHA-256 (`govc about.cert -thumbprint` form), normalized via `normalizeFingerprint`.
- Feature is **dev-only, not in production** (owner, 2026-07-21) — the migration may reset existing pins; no `pg_dump` gate.
- Commit style: `type(scope): description`, imperative. Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01EvuAEAuEBdYxxcBbU3enh5
  ```
- Run `pnpm --filter @lcm/server exec prisma generate` after any schema change. Server tests need Docker (Testcontainers).

---

### Task 1: Shared contract + web — leaf-fingerprint names, drop `chain_incomplete`

A compiler-guided rename plus removal of #278's `chain_incomplete` probe outcome (leaf-pinning never produces it). Names change and one dead outcome is dropped; the probe still returns the chain-root _value_ until Task 2 (identical for self-signed leaves).

**Files:**

- Modify: `packages/shared/src/schemas/vsphere.ts` (interfaces, trust schema, `TlsProbeOutcome` note, mode comment)
- Modify: `packages/shared/src/schemas/responses.ts` (`vsphereConnectionResponseSchema`, `vsphereProbeResultSchema`)
- Modify: `packages/shared/src/schemas/__tests__/vsphere.test.ts`, `.../responses.test.ts`
- Modify: `apps/server/src/routes/settings-vsphere.ts` (probe field, trust schema import + `/trust-cert` path)
- Modify: `apps/server/src/services/vsphere-connections.ts` (`toResponse` field name)
- Modify: `apps/web/src/lib/api-client.ts` (`trustCa`→`trustCert`, path, type)
- Modify: `apps/web/src/components/settings/trust-certificate-dialog.tsx` + `.test.tsx` (type, method, drop `chain_incomplete` branch, copy)
- Modify: `apps/web/src/components/settings/vcenter-connections-panel.tsx` + `.test.tsx` (`probe.rootFingerprintSha256`→`leafFingerprintSha256`, drop `chain_incomplete` branch)

**Interfaces:**

- Produces: `VsphereProbeResult.leafFingerprintSha256: string | null`; `VsphereProbeResult.outcome: 'ok' | 'unreachable' | 'tls_untrusted' | 'not_a_vcenter'` (no `chain_incomplete`); `VsphereConnectionResponse.pinnedLeafFingerprintSha256: string | null`; `vsphereTrustCertSchema` = `{ leafFingerprintSha256: string; password: string }`, type `VsphereTrustCert`; endpoint `POST /api/settings/vsphere/connections/:id/trust-cert`.

- [ ] **Step 1: Rename shared names and drop `chain_incomplete` from the contract**

In `packages/shared/src/schemas/vsphere.ts`:

- `VsphereProbeResult`: rename `rootFingerprintSha256` → `leafFingerprintSha256`; replace its doc comment with:
  ```ts
  /**
   * SHA-256 of the presented LEAF certificate — the exact cert to pin. This is what
   * `govc about.cert -thumbprint` and the vSphere Client print, so the admin compares
   * like-for-like. Pinning the leaf works against a self-signed cert, an incomplete
   * chain, and a full chain alike. It does not survive vCenter's unattended leaf
   * renewal (~2 yrs); on renewal the connection reports `cert_mismatch` and the admin
   * re-confirms once. See the 2026-07-21 design (supersedes D11 and #278).
   */
  leafFingerprintSha256: string | null;
  ```
- `VsphereProbeResult.outcome`: remove `'chain_incomplete'` → `outcome: 'ok' | 'unreachable' | 'tls_untrusted' | 'not_a_vcenter';`. Delete the `chain_incomplete` paragraph in the surrounding doc comment.
- Rename `vsphereTrustCaSchema` → `vsphereTrustCertSchema`, its field `rootFingerprintSha256` → `leafFingerprintSha256`, and type `VsphereTrustCa` → `VsphereTrustCert`. Doc: "Pin a certificate as this connection's trust anchor (TOFU) by its leaf fingerprint."
- `VsphereConnectionResponse`: rename `pinnedRootFingerprintSha256` → `pinnedLeafFingerprintSha256`.
- `vsphereTlsModeSchema` doc `pinned` bullet → `the presented leaf certificate's SHA-256 was confirmed out-of-band by an admin and is pinned; the credential is only sent to a cert with that exact fingerprint.`
- File header comment: `(\`tlsMode\`, \`pinnedCaPem\`)`→`(\`tlsMode\`, \`tlsPinnedSha256\`)`.

In `packages/shared/src/schemas/responses.ts`:

- `vsphereConnectionResponseSchema`: `pinnedRootFingerprintSha256: z.string().nullable(),` → `pinnedLeafFingerprintSha256: z.string().nullable(),`
- `vsphereProbeResultSchema`: `rootFingerprintSha256: z.string().nullable(),` → `leafFingerprintSha256: z.string().nullable(),` **and** the outcome enum `z.enum(['ok', 'unreachable', 'tls_untrusted', 'not_a_vcenter', 'chain_incomplete'])` → drop `'chain_incomplete'`.

- [ ] **Step 2: Update the shared tests**

In `packages/shared/src/schemas/__tests__/vsphere.test.ts`: `vsphereTrustCaSchema`→`vsphereTrustCertSchema`, `rootFingerprintSha256`→`leafFingerprintSha256`.
In `packages/shared/src/schemas/__tests__/responses.test.ts`: `pinnedRootFingerprintSha256`→`pinnedLeafFingerprintSha256`; if a probe-result round-trip asserts `chain_incomplete` parses, remove that case (or flip it to assert `chain_incomplete` now FAILS parsing).

- [ ] **Step 3: Run the shared tests — expect PASS**

Run: `pnpm --filter @lcm/shared test`
Expected: PASS.

- [ ] **Step 4: Update the server consumers**

In `apps/server/src/routes/settings-vsphere.ts`:

- Probe route: the response field `rootFingerprintSha256:` → `leafFingerprintSha256:` (both branches). Source it from `result.chain.rootFingerprintSha256` for now (renamed on the chain in Task 2). The probe route currently maps `result.outcome === 'chain_incomplete'` into the response — since `chain_incomplete` no longer exists after Task 2, leave the mapping compiling here by treating any non-`ok` as before; the actual removal of the `chain_incomplete` producer is Task 2, so if a `case 'chain_incomplete'` exists in this route, keep it until Task 2 Step 5 removes it. (If TS now errors because the contract enum dropped `chain_incomplete`, remove the `chain_incomplete` mapping here in this step and fold reachability into the existing `unreachable`/`tls_untrusted` branches — Task 2 makes the probe never emit it anyway.)
- Trust route: import `vsphereTrustCertSchema` (not `...CaSchema`); `body.rootFingerprintSha256` → `body.leafFingerprintSha256`; path `'.../trust-ca'` → `'.../trust-cert'`.

In `apps/server/src/services/vsphere-connections.ts` (`toResponse`): `pinnedRootFingerprintSha256: row.tlsPinnedSha256,` → `pinnedLeafFingerprintSha256: row.tlsPinnedSha256,`.

- [ ] **Step 5: Update the web consumers and remove the `chain_incomplete` UI**

In `apps/web/src/lib/api-client.ts`: import `VsphereTrustCert`; rename method `trustCa`→`trustCert`, param type `VsphereTrustCert`, path `.../trust-ca`→`.../trust-cert`.

In `apps/web/src/components/settings/trust-certificate-dialog.tsx`:

- `.trustCa(...)` → `.trustCert(...)`; mutation arg key `rootFingerprintSha256` → `leafFingerprintSha256`.
- Remove the `probe?.outcome === 'chain_incomplete'` branch (the "did not present its root CA" block) — leaf-pinning never returns it.
- Copy fix (the `tls_untrusted` description in `COPY`): `'LCM will pin this certificate root as the trust anchor for this connection. Compare the fingerprint against your vCenter before you confirm.'` → `'LCM will pin this exact certificate as the trust anchor for this connection. Compare the fingerprint against your vCenter before you confirm.'`

In `apps/web/src/components/settings/vcenter-connections-panel.tsx`:

- `probe.rootFingerprintSha256` → `probe.leafFingerprintSha256` (null-check + `<CertificateFingerprint>` prop).
- Remove the `probe.outcome === 'chain_incomplete'` block (the "did not present its root CA" guidance).

In the two web test files (`trust-certificate-dialog.test.tsx`, `vcenter-connections-panel.test.tsx`): remove the `chain_incomplete` fixtures/assertions (`outcome: 'chain_incomplete'`, `findByText(/did not present its root CA/i)`).

- [ ] **Step 6: Typecheck + web tests — expect PASS**

Run: `pnpm typecheck && pnpm --filter @lcm/web test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(api): leaf-fingerprint pin names, drop chain_incomplete outcome

Rename rootFingerprintSha256 -> leafFingerprintSha256, pinnedRootFingerprintSha256
-> pinnedLeafFingerprintSha256, vsphereTrustCaSchema -> vsphereTrustCertSchema,
/trust-ca -> /trust-cert across @lcm/shared, server, and web. Remove #278's
chain_incomplete probe outcome from both lockstep union sites and the web
guidance UI ahead of leaf-pinning (which never produces it)." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01EvuAEAuEBdYxxcBbU3enh5"
```

---

### Task 2: Probe captures & trust stores the leaf; remove the anchor machinery

Make the probe report the presented **leaf**, store only the fingerprint (no PEM), and delete #278's `evaluateProbedChain`/`isSelfSignedAnchor` gate plus D11's `rootOf`/`derToPem`.

**Files:**

- Modify: `apps/server/src/services/vsphere-tls.ts` (`CapturedChain`, `TlsProbeOutcome`, `probeCertificate`; remove `evaluateProbedChain`, `isSelfSignedAnchor`, `isSelfSignedAnchorPem`, `rootOf`, `derToPem`)
- Modify: `apps/server/src/routes/settings-vsphere.ts` (probe field source; trust route stores a fingerprint, not a PEM; drop any `chain_incomplete` mapping)
- Modify: `apps/server/src/services/vsphere-connections.ts` (`trustCa`→`trustCert`; `update()` stop writing `tlsPinnedCaPem`)
- Create: `apps/server/src/__tests__/support/self-signed-cert.ts`
- Create: `apps/server/src/__tests__/vsphere-tls.test.ts`
- Modify: `apps/server/src/__tests__/settings-vsphere-mappers.test.ts` (remove `evaluateProbedChain`/`isSelfSignedAnchorPem`/`chain_incomplete` cases + `ROOT_CA_BAD_SIG_PEM` fixture)
- Modify: `apps/server/src/__tests__/settings-vsphere-routes.test.ts`, `vsphere-connections.test.ts` (trust stores fingerprint, not PEM)

**Interfaces:**

- Consumes: Task 1's renamed contract.
- Produces: `CapturedChain { leafFingerprintSha256: string; trustedBySystemRoots: boolean; validFrom: string | null; validTo: string | null }`; `TlsProbeOutcome = 'ok' | 'unreachable' | 'tls_untrusted'`; `probeCertificate(hostname, port?)` returns the leaf fingerprint; `VsphereConnectionsService.trustCert(tenantId, id, leafFingerprintSha256): Promise<VsphereConnectionResponse>`; test helper `makeSelfSignedCert(): { certPem; keyPem; fingerprint256 }`.

- [ ] **Step 1: Write the self-signed cert test helper**

Create `apps/server/src/__tests__/support/self-signed-cert.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * An ephemeral self-signed cert for TLS-server tests. Generated at runtime via
 * openssl (present on CI runners and dev machines) so NO private key is committed —
 * CLAUDE.md forbids committing key material.
 */
export function makeSelfSignedCert(cn = 'localhost'): {
  certPem: string;
  keyPem: string;
  fingerprint256: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'lcm-tls-'));
  try {
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      `/CN=${cn}`,
      '-addext',
      `subjectAltName=DNS:${cn}`,
    ]);
    const certPem = readFileSync(join(dir, 'cert.pem'), 'utf8');
    const keyPem = readFileSync(join(dir, 'key.pem'), 'utf8');
    const fingerprint256 = new X509Certificate(certPem).fingerprint256; // "AB:CD:.."
    return { certPem, keyPem, fingerprint256 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Write the failing probe test**

Create `apps/server/src/__tests__/vsphere-tls.test.ts`:

```ts
import { createServer, type Server } from 'node:tls';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { probeCertificate } from '../services/vsphere-tls.js';
import { makeSelfSignedCert } from './support/self-signed-cert.js';

const { certPem, keyPem, fingerprint256 } = makeSelfSignedCert();
let server: Server;
let port: number;

beforeEach(async () => {
  server = createServer({ cert: certPem, key: keyPem }, (socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'object' && addr) port = addr.port;
});
afterEach(() => server.close());

it('captures the presented LEAF fingerprint (self-signed vCenter pins successfully)', async () => {
  const result = await probeCertificate('127.0.0.1', port);
  expect(result.outcome).toBe('ok');
  expect(result.chain?.leafFingerprintSha256).toBe(fingerprint256);
  expect(result.chain?.trustedBySystemRoots).toBe(false);
});
```

- [ ] **Step 3: Run it — expect FAIL**

Run: `pnpm --filter @lcm/server test -- vsphere-tls`
Expected: FAIL — `chain.leafFingerprintSha256` is undefined (still `rootFingerprintSha256`); an incomplete-chain probe today returns `chain_incomplete`, but a self-signed leaf currently pins as its own root, so the field name is the failing assertion.

- [ ] **Step 4: Rewrite `vsphere-tls.ts` to capture the leaf and delete the anchor machinery**

In `apps/server/src/services/vsphere-tls.ts`:

- `CapturedChain` → drop `rootPem`, rename `rootFingerprintSha256` → `leafFingerprintSha256`:
  ```ts
  export interface CapturedChain {
    /** Uppercase colon-separated SHA-256 of the presented LEAF, as `govc about.cert` prints. */
    leafFingerprintSha256: string;
    trustedBySystemRoots: boolean;
    validFrom: string | null;
    validTo: string | null;
  }
  ```
- `TlsProbeOutcome` → `'ok' | 'unreachable' | 'tls_untrusted'` (drop `'chain_incomplete'`); delete its `chain_incomplete` doc paragraph.
- **Delete** `evaluateProbedChain`, `isSelfSignedAnchor`, `isSelfSignedAnchorPem`, `rootOf`, `derToPem`, and the `X509Certificate` import if now unused. **Keep** `describeChain`, `chainTerminates`, `isGenuinelySelfSigned`, `cn`, `extractTlsErrorCode`, `ChainDiagnostics`, `normalizeFingerprint`, `fingerprintOf`, `VCENTER_PORT`, `CONNECT_TIMEOUT_MS`.
- In `probeCertificate`'s `secureConnect` handler, replace the `finish(evaluateProbedChain(...))` line with a direct leaf capture:
  ```ts
  socket.once('secureConnect', () => {
    const detailed = socket.getPeerCertificate(true);
    if (!detailed || Object.keys(detailed).length === 0) {
      finish({ outcome: 'tls_untrusted', chain: null, diagnostics: null });
      return;
    }
    finish({
      outcome: 'ok',
      chain: {
        leafFingerprintSha256: normalizeFingerprint(detailed.fingerprint256 ?? ''),
        trustedBySystemRoots: socket.authorized,
        validFrom: detailed.valid_from ?? null,
        validTo: detailed.valid_to ?? null,
      },
      diagnostics: describeChain(detailed), // server-log only (#272), unchanged
    });
  });
  ```
- Leave `verifiedTlsOptions` in place for now (Task 3 removes it). Its `@ai-warning`s about root-pinning are updated in Task 3.

- [ ] **Step 5: Point the probe route at the leaf; store a fingerprint on trust**

In `apps/server/src/routes/settings-vsphere.ts`:

- Probe route ok-branch: `leafFingerprintSha256: result.chain.leafFingerprintSha256,`. If a `chain_incomplete` case remains from Task 1, delete it now (the outcome no longer exists).
- Trust route: replace the fingerprint compare + store with:

  ```ts
  if (probe.chain.leafFingerprintSha256 !== body.leafFingerprintSha256.toUpperCase()) {
    throw new UnprocessableError(
      'FINGERPRINT_MISMATCH',
      'The certificate presented does not match the fingerprint you confirmed',
    );
  }
  return service.trustCert(request.tenantId, id, probe.chain.leafFingerprintSha256);
  ```

- [ ] **Step 6: `trustCa`→`trustCert` (fingerprint only); stop writing the PEM**

In `apps/server/src/services/vsphere-connections.ts`, replace `trustCa` with:

```ts
/**
 * Pin a confirmed LEAF fingerprint as this connection's trust anchor (TOFU). The
 * route guarantees the admin-confirmed fingerprint equals the value re-probed here.
 */
async trustCert(
  tenantId: string,
  id: string,
  leafFingerprintSha256: string,
): Promise<VsphereConnectionResponse> {
  const existing = await this.prisma.vsphereConnection.findFirst({ where: { id, tenantId } });
  if (!existing) throw new NotFoundError('VsphereConnection', id);
  const row = await this.prisma.vsphereConnection.update({
    where: { id },
    data: {
      tlsMode: 'pinned',
      tlsPinnedSha256: leafFingerprintSha256.toUpperCase(),
      status: 'never_connected',
      lastError: null,
    },
    include: { job: true },
  });
  return this.toResponse(row);
}
```

In `update()` (the hostname-change reset), remove the `data.tlsPinnedCaPem = null;` line; keep `data.tlsPinnedSha256 = null;`.

- [ ] **Step 7: Run the probe test — expect PASS**

Run: `pnpm --filter @lcm/server test -- vsphere-tls`
Expected: PASS.

- [ ] **Step 8: Remove the #278 anchor-gate tests + fixtures; fix trust tests**

- `apps/server/src/__tests__/settings-vsphere-mappers.test.ts`: delete the `evaluateProbedChain`, `isSelfSignedAnchor`/`isSelfSignedAnchorPem`, and `chain_incomplete` cases, and the `ROOT_CA_BAD_SIG_PEM` (and any leaf/intermediate) fixtures. Keep whatever still maps a valid probe result to the response DTO (updating `rootFingerprintSha256`→`leafFingerprintSha256`). If the file becomes empty, delete it.
- `apps/server/src/__tests__/settings-vsphere-routes.test.ts`: drive `/trust-cert` with a `leafFingerprintSha256`; assert `row.tlsPinnedSha256`; remove `tlsPinnedCaPem` seeds/assertions.
- `apps/server/src/__tests__/vsphere-connections.test.ts`: drop the `tlsPinnedCaPem` PEM fixture; assert on `tlsPinnedSha256` only.

- [ ] **Step 9: Run the affected server tests — expect PASS**

Run: `pnpm --filter @lcm/server test -- vsphere-tls settings-vsphere-mappers settings-vsphere-routes vsphere-connections`
Expected: PASS. Also `grep -rn "chain_incomplete\|evaluateProbedChain\|isSelfSignedAnchor\|rootOf\|derToPem" apps packages --include='*.ts' --include='*.tsx' | grep -v node_modules` should return **nothing**.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(server): probe and pin the vCenter leaf certificate, not a chain root

Capture the presented leaf fingerprint directly in probeCertificate, store only
the fingerprint on trust (no PEM), and delete the root-walk + #278 anchor-gate
machinery (evaluateProbedChain/isSelfSignedAnchor/rootOf/derToPem, chain_incomplete).
Fixes the #272 dead-end where a vCenter that omits its VMCA root had nothing to
pin. Diagnostics (describeChain) stay as server-log evidence." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01EvuAEAuEBdYxxcBbU3enh5"
```

---

### Task 3: Fingerprint-gated credential connection (the security linchpin)

Enforce the stored leaf fingerprint on every credential-bearing `soapCall`, proving no credential byte is written on a mismatch.

**Files:**

- Modify: `apps/server/src/services/vsphere-tls.ts` (add `fingerprintPinnedConnection`; remove `verifiedTlsOptions`)
- Modify: `apps/server/src/services/vsphere-client.ts` (`soapCall` wiring; `pinnedRootPem`→`pinnedLeafSha256`; `verifyLogin`)
- Modify: `apps/server/src/services/vsphere-collector.ts` (`SoapTransport`; `collect` input)
- Modify: `apps/server/src/services/vsphere-sync.ts`, `vsphere-snapshot.ts`, `vsphere-inventory.ts` (credentials field rename)
- Modify: `apps/server/src/services/vsphere-job-runner.ts` (`VsphereCredentials`; pass `connection.tlsPinnedSha256`)
- Create: `apps/server/src/__tests__/vsphere-fingerprint-pin.test.ts` (the linchpin byte-recording test)

**Interfaces:**

- Consumes: `tlsPinnedSha256` stored by Task 2; `makeSelfSignedCert` (Task 2).
- Produces: `fingerprintPinnedConnection(hostname, port, pinnedSha256): (options, oncreate) => Socket`; `soapCall(hostname, pinnedLeafSha256, action, body, cookie, options?)`; `verifyLogin({ ..., pinnedLeafSha256 })`; `SoapTransport` 2nd param `pinnedLeafSha256`; `VsphereCredentials { ..., pinnedLeafSha256: string | null }`.

- [ ] **Step 1: Write the failing linchpin test**

Create `apps/server/src/__tests__/vsphere-fingerprint-pin.test.ts`:

```ts
import { Buffer } from 'node:buffer';
import { createServer, type Server } from 'node:tls';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { soapCall } from '../services/vsphere-client.js';
import { makeSelfSignedCert } from './support/self-signed-cert.js';

const { certPem, keyPem, fingerprint256 } = makeSelfSignedCert();
let server: Server;
let port: number;
let received: Buffer[];

beforeEach(async () => {
  received = [];
  server = createServer({ cert: certPem, key: keyPem }, (socket) => {
    socket.on('data', (b: Buffer) => received.push(b)); // never answers
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'object' && addr) port = addr.port;
});
afterEach(() => server.close());

const WRONG = Array.from({ length: 32 }, () => 'AA').join(':');

it('writes ZERO bytes when the leaf fingerprint does not match', async () => {
  await expect(
    soapCall('127.0.0.1', WRONG, 'Login', '<secret-credential/>', null, { port }),
  ).rejects.toMatchObject({ code: 'CERT_FINGERPRINT_MISMATCH' });
  expect(Buffer.concat(received)).toHaveLength(0);
});

it('sends the request when the leaf fingerprint matches', async () => {
  await soapCall('127.0.0.1', fingerprint256, 'RetrieveServiceContent', '<hello/>', null, {
    port,
  }).catch(() => undefined); // no response arrives; we only assert what we received
  expect(Buffer.concat(received).toString('utf8')).toContain('<hello/>');
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm --filter @lcm/server test -- vsphere-fingerprint-pin`
Expected: FAIL — `soapCall`'s 2nd arg is still a PEM (`pinnedRootPem`); the fingerprint gate does not exist.

- [ ] **Step 3: Add the fingerprint-gated connection factory**

In `apps/server/src/services/vsphere-tls.ts` add the imports and function, and **delete** `verifiedTlsOptions`:

```ts
import {
  connect as tlsConnect,
  type DetailedPeerCertificate,
  type PeerCertificate,
} from 'node:tls';
import type { Socket } from 'node:net';
```

```ts
/**
 * The credential-path connection factory for a PINNED connection.
 *
 * @ai-warning The ONLY place `rejectUnauthorized: false` is allowed on a
 * credential-bearing path. Safe for one reason: the fingerprint gate runs on
 * `secureConnect` and destroys the socket — and only then hands it to the HTTP
 * layer via `oncreate` — so NO request byte reaches a peer whose leaf != the pin.
 * Do NOT return the socket synchronously: `http` would use it before `secureConnect`
 * and defeat the gate. Do NOT move the check into `checkServerIdentity` — with
 * `rejectUnauthorized: false` it never fires (design D10).
 */
export function fingerprintPinnedConnection(
  hostname: string,
  port: number,
  pinnedSha256: string,
): (options: unknown, oncreate: (err: Error | null, socket?: Socket) => void) => Socket {
  return (_options, oncreate) => {
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
        oncreate(err);
        return;
      }
      oncreate(null, socket);
    });
    socket.once('timeout', () => {
      const err = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
      socket.destroy(err);
      oncreate(err);
    });
    socket.once('error', (err) => oncreate(err));
    return undefined as unknown as Socket; // force http to await oncreate — the gate
  };
}
```

> **If the mismatch test still records bytes:** Node is using the synchronously-returned socket. Confirm the factory returns `undefined` and yields the socket only through `oncreate`. This is the D10-style empirical bit — make the test green before proceeding; do not weaken the test.

- [ ] **Step 4: Wire `soapCall` and rename its pin parameter**

In `apps/server/src/services/vsphere-client.ts`:

- Import `fingerprintPinnedConnection, VCENTER_PORT` (not `verifiedTlsOptions`).
- `soapCall` signature: `pinnedRootPem: string | null` → `pinnedLeafSha256: string | null`.
- Replace the TLS-options + `httpsRequest` options block:
  ```ts
  const port = options.port ?? VCENTER_PORT;
  const payload = envelope(body);
  const requestOptions = {
    host: hostname,
    port,
    servername: hostname,
    path: '/sdk',
    method: 'POST' as const,
    timeout: REQUEST_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(pinnedLeafSha256
      ? { createConnection: fingerprintPinnedConnection(hostname, port, pinnedLeafSha256) }
      : { rejectUnauthorized: true as const }),
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      SOAPAction: `urn:vim25/${action}`,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  };
  const req = httpsRequest(requestOptions, (res) => {
    /* unchanged */
  });
  ```
  Keep the existing `res` handler, `req.on('timeout', ...)`, `req.on('error', reject)`, `req.end(payload)`.
- In `verifyLogin`, the three `soapCall(input.hostname, input.pinnedRootPem, ...)` calls → `input.pinnedLeafSha256`; the input field `pinnedRootPem` → `pinnedLeafSha256`.
- Update the `soapCall` `@ai-warning` that referenced `verifiedTlsOptions` to describe the factory (fingerprint gate; `rejectUnauthorized:false` confined; no `checkServerIdentity`).

- [ ] **Step 5: Rename the pin field through the transport consumers**

- `vsphere-collector.ts`: `SoapTransport` 2nd param `pinnedRootPem`→`pinnedLeafSha256`; `collect`'s input type + destructure + the `this.transport(hostname, pinnedLeafSha256, ...)` call.
- `vsphere-sync.ts`, `vsphere-snapshot.ts`, `vsphere-inventory.ts`: credentials field `pinnedRootPem: string | null`→`pinnedLeafSha256: string | null`.
- `vsphere-job-runner.ts`: `interface VsphereCredentials` field rename; at the build site `pinnedRootPem: connection.tlsPinnedCaPem,`→`pinnedLeafSha256: connection.tlsPinnedSha256,`.

- [ ] **Step 6: Run the linchpin test + typecheck — expect PASS**

Run: `pnpm --filter @lcm/server test -- vsphere-fingerprint-pin` → PASS (both cases).
Run: `pnpm typecheck` → PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(server): pin the vCenter leaf fingerprint on the credential path

soapCall opens a pinned connection through a confined createConnection factory
that verifies the presented leaf's SHA-256 on secureConnect and destroys the
socket before any request byte is written on a mismatch. rejectUnauthorized:false
lives only inside that factory; a null pin keeps the system-trust path. A
byte-recording TLS test proves zero credential bytes leak on mismatch." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01EvuAEAuEBdYxxcBbU3enh5"
```

---

### Task 4: Sync — a fingerprint mismatch surfaces as `cert_mismatch`

**Files:**

- Modify: `apps/server/src/services/vsphere-sync.ts` (`classify`, `sanitize`, catch-block outcome mapping)
- Modify: `apps/server/src/__tests__/vsphere-sync.test.ts`

**Interfaces:**

- Consumes: `soapCall`/collector reject with `code: 'CERT_FINGERPRINT_MISMATCH'` (Task 3).
- Produces: on mismatch, `VsphereConnection.status = 'cert_mismatch'`; the returned `VsphereSyncResult.outcome` stays a valid `VsphereSyncOutcome` (`'tls_untrusted'`).

- [ ] **Step 1: Write the failing mismatch test**

In `apps/server/src/__tests__/vsphere-sync.test.ts`, add a case injecting a collector whose `collect` rejects with `Object.assign(new Error('fp mismatch'), { code: 'CERT_FINGERPRINT_MISMATCH' })`, run a sync for a pinned connection, and assert the row's `status === 'cert_mismatch'` and the sanitized `lastError`. Mirror the existing failure-path setup (factories + real Postgres).

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm --filter @lcm/server test -- vsphere-sync`
Expected: FAIL — the message matches `/cert|tls/`, so it classifies `tls_untrusted`.

- [ ] **Step 3: Classify the fingerprint mismatch distinctly**

In `apps/server/src/services/vsphere-sync.ts` (`extractTlsErrorCode` is already imported for the log line; import `VsphereSyncOutcome` from `@lcm/shared` if not present):

```ts
function classify(err: unknown): 'unreachable' | 'auth_failed' | 'tls_untrusted' | 'cert_mismatch' {
  const code = extractTlsErrorCode(err);
  const msg = err instanceof Error ? err.message : String(err);
  if (code === 'CERT_FINGERPRINT_MISMATCH' || /CERT_FINGERPRINT_MISMATCH/.test(msg)) {
    return 'cert_mismatch';
  }
  if (/auth|login|credential/i.test(msg)) return 'auth_failed';
  if (/cert|tls|self.signed/i.test(msg)) return 'tls_untrusted';
  return 'unreachable';
}
```

In `sanitize`, before the `tls_untrusted` branch:

```ts
if (outcome === 'cert_mismatch') {
  return 'vCenter is presenting a different certificate than the one you trusted.';
}
```

In the catch block: keep `data: { status: outcome, ... }` (`cert_mismatch` is a valid `VsphereConnectionStatus`). Map the returned sync outcome to the `VsphereSyncOutcome` vocabulary (which has no `cert_mismatch`):

```ts
const syncOutcome: VsphereSyncOutcome = outcome === 'cert_mismatch' ? 'tls_untrusted' : outcome;
return { ...empty, outcome: syncOutcome, error: sanitize(err) };
```

The existing log-level line already warns for anything but `unreachable`, so `cert_mismatch` warns — correct.

- [ ] **Step 4: Run the sync tests — expect PASS**

Run: `pnpm --filter @lcm/server test -- vsphere-sync`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): surface a vCenter leaf-pin mismatch as cert_mismatch

A pinned connection whose presented leaf no longer matches sets status
cert_mismatch (routing the operator to the Replace-the-trusted-certificate flow)
while the sync outcome stays a valid tls_untrusted for the job vocabulary." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01EvuAEAuEBdYxxcBbU3enh5"
```

---

### Task 5: Prisma migration — reset pins and drop the PEM column

**Files:**

- Modify: `apps/server/prisma/schema.prisma` (`VsphereConnection`: remove `tlsPinnedCaPem`; update comments)
- Create: `apps/server/prisma/migrations/<ts>_vsphere_leaf_pinning/migration.sql`

- [ ] **Step 1: Confirm no code references the column**

Run: `grep -rn "tlsPinnedCaPem\|tls_pinned_ca_pem" apps/server/src packages`
Expected: no matches outside `prisma/migrations`. Fix any before continuing — `prisma generate` will drop the field and break compilation otherwise.

- [ ] **Step 2: Edit the schema**

In `apps/server/prisma/schema.prisma`, `model VsphereConnection`:

- Remove the `tlsPinnedCaPem  String? @map("tls_pinned_ca_pem")` line + its comment.
- `tlsPinnedSha256` comment → `/// The pinned trust anchor: SHA-256 of the presented LEAF certificate (govc form). Public data, plaintext. Does not survive vCenter leaf renewal — a mismatch then surfaces as cert_mismatch for re-confirm. See the 2026-07-21 design (supersedes D11 and #278).`
- `tlsMode` comment → `/// 'system' | 'pinned', both fail closed. 'pinned' verifies the leaf fingerprint; 'system' verifies against the system trust store. No insecure value, ever.`
- In the `port` comment, `TOFU root-pinning` → `TOFU leaf-fingerprint pinning`.

- [ ] **Step 3: Generate + edit the migration**

Run: `pnpm --filter @lcm/server exec prisma migrate dev --name vsphere_leaf_pinning --create-only`
Then edit the generated `migration.sql` to prepend the data reset:

```sql
-- Existing pins are chain-root fingerprints and cannot match a leaf pin.
-- Reset them so the operator re-confirms the leaf once (dev-only; no prod data).
UPDATE "vsphere_connections"
SET "tls_pinned_sha256" = NULL,
    "status" = 'tls_untrusted'
WHERE "tls_mode" = 'pinned' AND "tls_pinned_sha256" IS NOT NULL;

-- Leaf pinning stores only the fingerprint; the PEM anchor is gone.
ALTER TABLE "vsphere_connections" DROP COLUMN "tls_pinned_ca_pem";
```

- [ ] **Step 4: Apply, regenerate, typecheck**

Run: `pnpm --filter @lcm/server exec prisma migrate dev` then `pnpm --filter @lcm/server exec prisma generate` then `pnpm typecheck`
Expected: all clean; client has no `tlsPinnedCaPem`.

- [ ] **Step 5: Full server suite — expect PASS**

Run: `pnpm --filter @lcm/server test`
Expected: PASS (Testcontainers applies the new migration to a fresh Postgres).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): migrate vsphere_connections to leaf-fingerprint pinning

Drop tls_pinned_ca_pem (leaf pinning stores only the fingerprint) and reset any
existing dev pins to tls_untrusted so the operator re-confirms the leaf once.
Dev-only, no production data (owner, 2026-07-21)." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01EvuAEAuEBdYxxcBbU3enh5"
```

---

### Task 6: Documentation — supersede D11 + #278, update operator notes

**Files:**

- Modify: `docs/vsphere-integration-design.md` (§0.1 amendment; D10 stands; D11 + #278 marked superseded)
- Modify: `docs/operations.md` (TLS-trust / pinning note)
- Modify: `docs/superpowers/specs/2026-07-21-vsphere-leaf-fingerprint-pinning-design.md` (Status → implemented)

- [ ] **Step 1: Amend the vSphere design doc**

In `docs/vsphere-integration-design.md`:

- At **D11**, prepend: `> **SUPERSEDED 2026-07-21** by leaf-fingerprint pinning (docs/superpowers/specs/2026-07-21-vsphere-leaf-fingerprint-pinning-design.md), which also removes PR #278's chain_incomplete/isSelfSignedAnchor gate. Real vCenters present the leaf without the VMCA root, so root-pinning had nothing to pin (#272). Leaf-fingerprint pinning verifies the exact cert at the socket before any write; it is verification-equivalent, not the §0.1-rejected "ignore TLS" flag, and D10 (no checkServerIdentity) still holds.`
- At **§0.1**, append: `Amendment 2026-07-21: root-pinning (D11) and its #278 refuse-to-pin fallback are replaced by leaf-fingerprint pinning. This is NOT the "ignore TLS" flag rejected here — verification stays on; the predicate is exact-cert identity. The rejection of an insecure/ignore flag stands.`

- [ ] **Step 2: Update operations.md**

Search `docs/operations.md` for pinning / TLS-trust wording and update it to describe leaf-fingerprint pinning and the `cert_mismatch` → re-confirm-on-renewal behavior. If absent, add a short "vCenter certificate trust" note: probe → confirm the fingerprint against `govc about.cert -thumbprint` → pin; on leaf renewal the connection shows `cert_mismatch` and the admin re-confirms.

- [ ] **Step 3: Mark the spec implemented**

Set the spec header `- **Status:** Implemented via docs/superpowers/plans/2026-07-21-vsphere-leaf-fingerprint-pinning.md.`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: record leaf-fingerprint pinning superseding D11 and #278

Amend the vSphere integration design (D11 + #278 superseded, §0.1 clarified, D10
stands), update the operator trust note, and mark the leaf-pinning spec implemented." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01EvuAEAuEBdYxxcBbU3enh5"
```

---

### Task 7: Full verification + high-risk review gate

- [ ] **Step 1: Complete affected suite** — `pnpm lint && pnpm typecheck && pnpm test` (Docker required). Expected: all PASS.
- [ ] **Step 2: Web e2e** — `pnpm --filter @lcm/web test:e2e` (dev stack). Expected: PASS (settings flow renders; not a CI gate).
- [ ] **Step 3: Manual smoke (recommended)** — against a self-signed / incomplete-chain host: probe, confirm the fingerprint matches `govc about.cert -thumbprint`, trust, confirm sync connects; then a deliberately wrong fingerprint yields `cert_mismatch`, not a hang or silent success.
- [ ] **Step 4: Open the PR into `dev` with high-risk controls.** Per CLAUDE.md "Automated high-risk approval", the PR body MUST include the design link (spec), threat model / invariants (copy from spec), and the linchpin evidence (byte-recording test). Needs two independent AI reviews (e.g. `critic` + `brahma-analyzer`) or a human sign-off, plus green CI (`verify` + `oidc-e2e`). Base: `dev`. Never push to `dev`/`main` directly.
  ```bash
  git push -u origin fix/272-vsphere-leaf-pinning-design
  gh pr create --base dev --title "fix(#272): pin the vCenter leaf certificate instead of a chain root" --body "<design link + threat model + invariants + linchpin evidence>"
  ```

---

## Self-Review

**Spec coverage:** leaf pin + two-mode + confined `rejectUnauthorized:false` → Tasks 2-3; `system` mode unchanged (null pin) → Task 3 Step 4; data model → Task 5; contract renames + `/trust-cert` + drop `chain_incomplete` → Task 1; leaf capture + remove `rootOf`/`derToPem`/`evaluateProbedChain`/`isSelfSignedAnchor(Pem)` → Task 2; the `createConnection` gate + no-`checkServerIdentity` + byte test → Task 3; trust flow → Task 2 Steps 5-6; mismatch → `cert_mismatch` → Task 4; invariants 1-6 → Tasks 2-4; docs (D11 + #278 superseded) → Task 6; testing → Tasks 2-5. ✓

**Placeholder scan:** none — every code step shows code; the one empirically-settled bit (return-undefined vs return-socket) is called out with the test that decides it.

**Type consistency:** `pinnedLeafSha256: string | null` is the transport param across `soapCall`/`SoapTransport`/`collect`/`verifyLogin`/`VsphereCredentials` (Task 3). `leafFingerprintSha256` is the contract field (Task 1) and `CapturedChain` field (Task 2). `trustCert(tenantId, id, leafFingerprintSha256)` is used identically in the route (Task 2 Step 5) and service (Step 6). `CERT_FINGERPRINT_MISMATCH` is the error `code` set in Task 3 and read in Task 4. The `chain_incomplete` removal spans the interface (Task 1), the Zod schema (Task 1), the `TlsProbeOutcome` (Task 2), the probe route (Task 2), and the web branches (Task 1) — the grep in Task 2 Step 9 verifies nothing is left.

**Known risk to watch:** Task 3's `createConnection` ordering is the one place Node behavior must be verified empirically — the linchpin test is the gate and runs before any consumer relies on it. If it cannot be made airtight, stop and escalate; do not weaken the test.
