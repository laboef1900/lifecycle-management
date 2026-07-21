# vSphere Leaf-Fingerprint TLS Pinning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace vCenter root-CA pinning with leaf-certificate SHA-256 pinning, verified at the socket before any credential byte is written, so trust "just works" against self-signed, incomplete-chain, and full-chain vCenters alike.

**Architecture:** The stored pin becomes the leaf certificate's SHA-256 (`tlsPinnedSha256`). The credential-bearing `soapCall` connects with `rejectUnauthorized: false` inside a single confined `createConnection` factory that compares the presented leaf's fingerprint to the pin and destroys the socket before the HTTP layer writes, on any mismatch. A `null` pin keeps today's system-trust path (`rejectUnauthorized: true`). Root-walk pinning machinery is removed.

**Tech Stack:** Node 26 (`node:tls`, `node:https`), Fastify 5, Prisma 7, Zod 4, Vitest + Testcontainers, React 19.

**Spec:** `docs/superpowers/specs/2026-07-21-vsphere-leaf-fingerprint-pinning-design.md`. **Branch:** `fix/272-vsphere-leaf-pinning-design` (already created; the design doc is committed there).

## Global Constraints

- TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. No `any`, no `@ts-ignore`, no `eslint-disable`, no skipped tests (CLAUDE.md Golden Rule 5 & 8).
- Every API input/output validated with a `@lcm/shared` Zod schema, parsed inside the handler.
- **Security invariant (linchpin):** on a credential path, no application byte reaches the socket until the presented leaf SHA-256 equals the pin. `rejectUnauthorized: false` exists ONLY inside the fingerprint-gated factory. A `null` pin uses `rejectUnauthorized: true` (system trust) — it never connects insecurely.
- **Do NOT use `checkServerIdentity` for the fingerprint check** — it does not run when `rejectUnauthorized: false` (design D10). Use the TLS socket's `secureConnect` event.
- Fingerprints are uppercase colon-separated SHA-256 (`govc about.cert -thumbprint` form), normalized via `normalizeFingerprint`.
- Feature is **dev-only, not in production** (owner, 2026-07-21) — the migration may reset existing pins; no `pg_dump` gate.
- Commit style: `type(scope): description`, imperative. Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01EvuAEAuEBdYxxcBbU3enh5
  ```
- Run `pnpm --filter @lcm/server exec prisma generate` after any schema change; `pnpm --filter @lcm/web generate-routes` is not needed (no route-file changes). Server tests need Docker (Testcontainers).

---

### Task 1: Shared contract — rename to leaf-fingerprint (behavior-preserving)

A compiler-guided rename across `@lcm/shared` and every consumer. **No behavior changes** — the probe still returns the chain-root value; it is merely renamed here and made correct in Task 2. (For a genuinely self-signed leaf, root == leaf, so the value is already right; only the incomplete-chain case is briefly misnamed, fixed next task.)

**Files:**

- Modify: `packages/shared/src/schemas/vsphere.ts`
- Modify: `packages/shared/src/schemas/responses.ts:270-312`
- Modify: `packages/shared/src/schemas/__tests__/vsphere.test.ts:60-75`
- Modify: `packages/shared/src/schemas/__tests__/responses.test.ts:298-390`
- Modify: `apps/server/src/routes/settings-vsphere.ts` (probe route field, trust route schema import + endpoint path)
- Modify: `apps/server/src/services/vsphere-connections.ts:378` (`toResponse` field)
- Modify: `apps/web/src/lib/api-client.ts:392-396` (method name, path, type)
- Modify: `apps/web/src/components/settings/trust-certificate-dialog.tsx` (type import, `trustCa`→`trustCert`, copy)
- Modify: `apps/web/src/components/settings/vcenter-connections-panel.tsx:428,448` (`probe.rootFingerprintSha256`→`probe.leafFingerprintSha256`)

**Interfaces:**

- Produces (consumed by later tasks): `VsphereProbeResult.leafFingerprintSha256: string | null`; `VsphereConnectionResponse.pinnedLeafFingerprintSha256: string | null`; `vsphereTrustCertSchema` with `{ leafFingerprintSha256: string; password: string }`, type `VsphereTrustCert`; endpoint `POST /api/settings/vsphere/connections/:id/trust-cert`.

- [ ] **Step 1: Rename the shared field/schema/type names**

In `packages/shared/src/schemas/vsphere.ts`:

- `VsphereProbeResult`: rename property `rootFingerprintSha256` → `leafFingerprintSha256`. Replace its doc comment (lines ~165-173) with:
  ```ts
  /**
   * SHA-256 of the presented LEAF certificate — the exact cert to pin.
   *
   * This is what `govc about.cert -thumbprint` and the vSphere Client both print,
   * so the admin compares like-for-like. Pinning the leaf works against a
   * self-signed cert, an incomplete chain (leaf without its issuing CA), and a
   * full chain alike. It does not survive vCenter's unattended leaf renewal
   * (~2 yrs); on renewal the connection reports `cert_mismatch` and the admin
   * re-confirms once. See the 2026-07-21 design (supersedes D11).
   */
  leafFingerprintSha256: string | null;
  ```
- `vsphereTlsModeSchema` doc (lines ~55-68): change the `pinned` bullet to `- \`pinned\` — the presented leaf certificate's SHA-256 was confirmed out-of-band by an admin and is pinned; the credential is only sent to a cert with that exact fingerprint.`
- Rename `vsphereTrustCaSchema` → `vsphereTrustCertSchema` and its field `rootFingerprintSha256` → `leafFingerprintSha256`; rename type `VsphereTrustCa` → `VsphereTrustCert`. Update the doc to say "Pin a certificate as this connection's trust anchor (TOFU) by its leaf fingerprint."
- `VsphereConnectionResponse`: rename `pinnedRootFingerprintSha256` → `pinnedLeafFingerprintSha256` (keep the `string | null` and the "Public data — never a secret" comment).
- The file header comment (line ~15): change `what proves the destination's identity (\`tlsMode\`, \`pinnedCaPem\`)`→`(\`tlsMode\`, \`tlsPinnedSha256\`)`.

In `packages/shared/src/schemas/responses.ts`:

- Line 277: `pinnedRootFingerprintSha256: z.string().nullable(),` → `pinnedLeafFingerprintSha256: z.string().nullable(),`
- Line 302: `rootFingerprintSha256: z.string().nullable(),` → `leafFingerprintSha256: z.string().nullable(),`

- [ ] **Step 2: Update the shared tests to the new names**

In `packages/shared/src/schemas/__tests__/vsphere.test.ts` (~line 60-75): replace `vsphereTrustCaSchema` → `vsphereTrustCertSchema` and `rootFingerprintSha256` → `leafFingerprintSha256` in both the import and the assertions.

In `packages/shared/src/schemas/__tests__/responses.test.ts` (~line 306): `pinnedRootFingerprintSha256:` → `pinnedLeafFingerprintSha256:`.

- [ ] **Step 3: Run the shared tests — expect PASS**

Run: `pnpm --filter @lcm/shared test`
Expected: PASS (names updated on both sides).

- [ ] **Step 4: Update the server consumers**

In `apps/server/src/routes/settings-vsphere.ts`:

- Probe route (~line 192 and 205): `rootFingerprintSha256:` → `leafFingerprintSha256:` (both the unreachable branch and the ok branch), sourcing `result.chain.rootFingerprintSha256` for now (renamed to `leafFingerprintSha256` on the chain in Task 2 — keep it compiling by using the current field name until then; if `CapturedChain` still exposes `rootFingerprintSha256`, read that here and rename in Task 2).
- Trust route: change the import `vsphereTrustCaSchema` → `vsphereTrustCertSchema`; the parsed field `body.rootFingerprintSha256` → `body.leafFingerprintSha256`; the route path `'/settings/vsphere/connections/:id/trust-ca'` → `'/settings/vsphere/connections/:id/trust-cert'`.

In `apps/server/src/services/vsphere-connections.ts:378`: `pinnedRootFingerprintSha256: row.tlsPinnedSha256,` → `pinnedLeafFingerprintSha256: row.tlsPinnedSha256,`.

> Note: `CapturedChain.rootFingerprintSha256` and `vsphereProbeSchema`/route wiring are still "root"-named internally until Task 2. This step only renames the _contract_ field. If a name clash makes the probe route awkward, read `result.chain.rootFingerprintSha256` and assign to the renamed contract field `leafFingerprintSha256`.

- [ ] **Step 5: Update the web consumers**

In `apps/web/src/lib/api-client.ts`:

- Import `VsphereTrustCert` instead of `VsphereTrustCa`.
- Rename the method `trustCa` → `trustCert`, its param type to `VsphereTrustCert`, and the path `.../trust-ca` → `.../trust-cert`.

In `apps/web/src/components/settings/trust-certificate-dialog.tsx`:

- `api.settings.vsphere.connections.trustCa(...)` → `.trustCert(...)`; the mutation arg key `rootFingerprintSha256` → `leafFingerprintSha256`.
- Copy fix (line ~39, `tls_untrusted` description): `'LCM will pin this certificate root as the trust anchor for this connection. Compare the fingerprint against your vCenter before you confirm.'` → `'LCM will pin this exact certificate as the trust anchor for this connection. Compare the fingerprint against your vCenter before you confirm.'`

In `apps/web/src/components/settings/vcenter-connections-panel.tsx` (lines ~428, 448): `probe.rootFingerprintSha256` → `probe.leafFingerprintSha256` (both the null-check and the `<CertificateFingerprint fingerprint=...>` prop).

- [ ] **Step 6: Typecheck + web tests — expect PASS**

Run: `pnpm typecheck && pnpm --filter @lcm/web test`
Expected: PASS. No behavior change; only names and one copy string.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(api): rename vCenter pin fields to leaf-fingerprint semantics

Behavior-preserving rename across @lcm/shared, server, and web ahead of the
leaf-pinning change: rootFingerprintSha256 -> leafFingerprintSha256,
pinnedRootFingerprintSha256 -> pinnedLeafFingerprintSha256, vsphereTrustCaSchema
-> vsphereTrustCertSchema, and /trust-ca -> /trust-cert." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01EvuAEAuEBdYxxcBbU3enh5"
```

---

### Task 2: Probe captures & trust stores the leaf fingerprint

Make the probe report the presented **leaf** (not a chain-root walk), store only the fingerprint (no PEM), and remove the root-walk pinning machinery.

**Files:**

- Modify: `apps/server/src/services/vsphere-tls.ts` (`CapturedChain`, `probeCertificate`; remove `rootOf`, `derToPem`)
- Modify: `apps/server/src/routes/settings-vsphere.ts` (probe route field source; trust route no longer passes a PEM)
- Modify: `apps/server/src/services/vsphere-connections.ts` (`trustCa` → `trustCert`, drop `caPem`; `update()` stop writing `tlsPinnedCaPem`)
- Create: `apps/server/src/__tests__/support/self-signed-cert.ts` (ephemeral cert helper)
- Create: `apps/server/src/__tests__/vsphere-tls.test.ts` (probe unit test)
- Modify: `apps/server/src/__tests__/settings-vsphere-routes.test.ts:295-320` (trust stores fingerprint, not PEM)
- Modify: `apps/server/src/__tests__/vsphere-connections.test.ts:185-195` (drop PEM fixture)

**Interfaces:**

- Consumes: `VsphereProbeResult.leafFingerprintSha256` (Task 1).
- Produces: `CapturedChain { leafFingerprintSha256: string; trustedBySystemRoots: boolean; validFrom: string | null; validTo: string | null }`; `probeCertificate(hostname, port?)` returns the leaf fingerprint; `VsphereConnectionsService.trustCert(tenantId, id, leafFingerprintSha256): Promise<VsphereConnectionResponse>`; a test helper `makeSelfSignedCert(): { certPem: string; keyPem: string; fingerprint256: string }`.

- [ ] **Step 1: Write the self-signed cert test helper**

Create `apps/server/src/__tests__/support/self-signed-cert.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';

/**
 * An ephemeral self-signed cert for TLS-server tests. Generated at runtime via
 * openssl (present on CI runners and dev machines) so NO private key is ever
 * committed — CLAUDE.md forbids committing key material.
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
    // Exactly the form getPeerCertificate().fingerprint256 returns ("AB:CD:...").
    const fingerprint256 = new X509Certificate(certPem).fingerprint256;
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

let server: Server;
let port: number;
const { certPem, keyPem, fingerprint256 } = makeSelfSignedCert();

beforeEach(async () => {
  server = createServer({ cert: certPem, key: keyPem }, (socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'object' && addr) port = addr.port;
});
afterEach(() => server.close());

it('captures the presented LEAF fingerprint, not a chain root', async () => {
  const result = await probeCertificate('127.0.0.1', port);
  expect(result.outcome).toBe('ok');
  expect(result.chain?.leafFingerprintSha256).toBe(fingerprint256);
  // A self-signed leaf does NOT validate against system roots.
  expect(result.chain?.trustedBySystemRoots).toBe(false);
});
```

- [ ] **Step 3: Run it — expect FAIL**

Run: `pnpm --filter @lcm/server test -- vsphere-tls`
Expected: FAIL — `chain.leafFingerprintSha256` is undefined (`CapturedChain` still has `rootFingerprintSha256`).

- [ ] **Step 4: Rewrite `CapturedChain` and `probeCertificate` to capture the leaf**

In `apps/server/src/services/vsphere-tls.ts`:

- Change `CapturedChain` to:
  ```ts
  export interface CapturedChain {
    /** Uppercase colon-separated SHA-256 of the presented LEAF, as `govc about.cert` prints. */
    leafFingerprintSha256: string;
    /** Did the chain already validate against the system trust store? */
    trustedBySystemRoots: boolean;
    validFrom: string | null;
    validTo: string | null;
  }
  ```
  (Remove `rootPem`.)
- Delete `derToPem` and `rootOf` (no longer used for pinning). **Keep** `describeChain`, `chainTerminates`, `isGenuinelySelfSigned`, `cn`, `extractTlsErrorCode`, `ChainDiagnostics`, `normalizeFingerprint`, `fingerprintOf`, `VCENTER_PORT`, `CONNECT_TIMEOUT_MS` — the diagnostics stay as server-log evidence.
- In `probeCertificate`'s `secureConnect` handler, replace the `rootOf(detailed)` block with:
  ```ts
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
  ```
- Update the `@ai-warning` on `verifiedTlsOptions` and the file docstrings that reference "root pin" — but leave `verifiedTlsOptions` itself in place for now (Task 3 replaces it). Its callers still compile.

- [ ] **Step 5: Point the probe route field at the leaf, and drop the PEM from the trust route**

In `apps/server/src/routes/settings-vsphere.ts`:

- Probe route ok-branch: `leafFingerprintSha256: result.chain.leafFingerprintSha256,`.
- Trust route: it compares the confirmed fingerprint and stores the pin. Replace the mismatch check and store with:

  ```ts
  if (probe.chain.leafFingerprintSha256 !== body.leafFingerprintSha256.toUpperCase()) {
    throw new UnprocessableError(
      'FINGERPRINT_MISMATCH',
      'The certificate presented does not match the fingerprint you confirmed',
    );
  }
  return service.trustCert(request.tenantId, id, probe.chain.leafFingerprintSha256);
  ```

  (Remove the `probe.chain.rootPem` argument.)

- [ ] **Step 6: Change `trustCa` → `trustCert` (fingerprint only) and stop writing the PEM**

In `apps/server/src/services/vsphere-connections.ts`:

- Replace the `trustCa` method with:
  ```ts
  /**
   * Pin a confirmed LEAF fingerprint as this connection's trust anchor (TOFU).
   * The fingerprint the admin confirmed is the same value the server re-probed and
   * is about to store — the route guarantees they agree.
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
  (No `tlsPinnedCaPem` write.)
- In `update()` (the hostname-change reset, ~line 154-164): remove the line `data.tlsPinnedCaPem = null;`. Keep `data.tlsPinnedSha256 = null;` and the rest.

- [ ] **Step 7: Run the probe test — expect PASS**

Run: `pnpm --filter @lcm/server test -- vsphere-tls`
Expected: PASS.

- [ ] **Step 8: Update the route + service tests that referenced the PEM**

In `apps/server/src/__tests__/settings-vsphere-routes.test.ts` (~295-320): the trust test currently seeds `tlsPinnedCaPem: 'PEM-ROOT'` and asserts `row.tlsPinnedCaPem`. Change it to drive the `/trust-cert` endpoint with a `leafFingerprintSha256`, and assert `row.tlsPinnedSha256` equals the confirmed fingerprint. Remove `tlsPinnedCaPem` from the assertions.

In `apps/server/src/__tests__/vsphere-connections.test.ts` (~185-195): drop the `tlsPinnedCaPem` PEM fixture; if the test pins trust, assert on `tlsPinnedSha256` only.

- [ ] **Step 9: Run the affected server tests — expect PASS**

Run: `pnpm --filter @lcm/server test -- settings-vsphere-routes vsphere-connections vsphere-tls`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(server): probe and pin the vCenter leaf certificate, not a chain root

Capture the presented leaf fingerprint in probeCertificate, store only the
fingerprint on trust (no PEM), and drop the root-walk pinning machinery
(rootOf/derToPem). Fixes the #272 dead-end where a vCenter that omits its VMCA
root from the handshake had nothing to pin. Diagnostics (describeChain) stay as
server-log evidence." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01EvuAEAuEBdYxxcBbU3enh5"
```

---

### Task 3: Fingerprint-gated credential connection (the security linchpin)

Enforce the stored leaf fingerprint on every credential-bearing `soapCall`, proving no credential byte is written on a mismatch.

**Files:**

- Modify: `apps/server/src/services/vsphere-tls.ts` (add `fingerprintPinnedConnection`; remove `verifiedTlsOptions`)
- Modify: `apps/server/src/services/vsphere-client.ts` (`soapCall` wiring; param `pinnedRootPem` → `pinnedLeafSha256`; `verifyLogin`)
- Modify: `apps/server/src/services/vsphere-collector.ts` (`SoapTransport` type; `collect` param)
- Modify: `apps/server/src/services/vsphere-sync.ts:81`, `vsphere-snapshot.ts:61`, `vsphere-inventory.ts:64` (credentials field rename)
- Modify: `apps/server/src/services/vsphere-job-runner.ts:13-20,162` (`VsphereCredentials`; pass `connection.tlsPinnedSha256`)
- Create: `apps/server/src/__tests__/vsphere-fingerprint-pin.test.ts` (the linchpin byte-recording test)

**Interfaces:**

- Consumes: `probeCertificate`/`trustCert` store `tlsPinnedSha256` (Task 2); the test helper `makeSelfSignedCert` (Task 2).
- Produces: `fingerprintPinnedConnection(hostname, port, pinnedSha256): (options, oncreate) => net.Socket`; `soapCall(hostname, pinnedLeafSha256, action, body, cookie, options?)`; `verifyLogin({ ..., pinnedLeafSha256 })`; `SoapTransport` with `pinnedLeafSha256` as its 2nd param; `VsphereCredentials { ..., pinnedLeafSha256: string | null }`.

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
    socket.on('data', (b: Buffer) => received.push(b));
    // Never answer: the test only cares what bytes we RECEIVE.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'object' && addr) port = addr.port;
});
afterEach(() => server.close());

const WRONG = Array.from({ length: 32 }, () => 'AA').join(':');

it('writes ZERO bytes to the server when the leaf fingerprint does not match', async () => {
  await expect(
    soapCall('127.0.0.1', WRONG, 'Login', '<secret-credential/>', null, { port }),
  ).rejects.toMatchObject({ code: 'CERT_FINGERPRINT_MISMATCH' });
  expect(Buffer.concat(received)).toHaveLength(0); // the credential never left us
});

it('sends the request when the leaf fingerprint matches', async () => {
  // No response arrives, so the call rejects on timeout — but the body must reach us.
  await soapCall('127.0.0.1', fingerprint256, 'RetrieveServiceContent', '<hello/>', null, {
    port,
  }).catch(() => undefined);
  expect(Buffer.concat(received).toString('utf8')).toContain('<hello/>');
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm --filter @lcm/server test -- vsphere-fingerprint-pin`
Expected: FAIL — `soapCall`'s 2nd argument is still a PEM (`pinnedRootPem`), so a fingerprint string is used as a `ca:` value and the pin gate does not exist.

- [ ] **Step 3: Add the fingerprint-gated connection factory**

In `apps/server/src/services/vsphere-tls.ts`, add (and import `type TLSSocket` and `net`):

```ts
import {
  connect as tlsConnect,
  type DetailedPeerCertificate,
  type PeerCertificate,
  type TLSSocket,
} from 'node:tls';
import type { Socket } from 'node:net';
```

```ts
/**
 * The credential-path connection factory for a PINNED connection.
 *
 * @ai-warning This is the ONLY place `rejectUnauthorized: false` is allowed on a
 * credential-bearing path. It is safe for exactly one reason: the fingerprint gate
 * below runs on `secureConnect` and destroys the socket — and only then hands it to
 * the HTTP layer via `oncreate` — so NO request byte is ever written to a peer
 * whose leaf does not match the pin. Do NOT return the socket synchronously:
 * returning it makes `http` use it before `secureConnect` fires, defeating the gate.
 *
 * @ai-warning Do NOT move this check into `checkServerIdentity` — with
 * `rejectUnauthorized: false` that callback never fires (design D10).
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
      rejectUnauthorized: false, // gated below — see the @ai-warning
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
    // Returning undefined forces `http` to wait for `oncreate` — the gate.
    return undefined as unknown as Socket;
  };
}
```

Delete `verifiedTlsOptions` (Task 3 Step 4 rewires its one caller).

> **If the linchpin test still writes bytes on mismatch after this:** the Node version is using the synchronously-returned socket. Confirm `createConnection` is returning `undefined` (not the socket) and that `oncreate` is the only path that yields the socket. This is the D10-style empirical bit — make the test green before proceeding.

- [ ] **Step 4: Wire `soapCall` to the factory and rename its pin parameter**

In `apps/server/src/services/vsphere-client.ts`:

- Change the import from `verifiedTlsOptions` to `fingerprintPinnedConnection, VCENTER_PORT`.
- Change `soapCall`'s signature: `pinnedRootPem: string | null` → `pinnedLeafSha256: string | null`.
- Replace the TLS-options block and `httpsRequest(...)` options with:
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
    // Pinned: our factory verifies the leaf fingerprint before any write, with
    // rejectUnauthorized:false confined inside it. Unpinned (null): system trust.
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
    /* unchanged body */
  });
  ```
  Keep the existing `res` handler, `req.on('timeout', ...)`, `req.on('error', reject)`, `req.end(payload)`.
- Update the three `soapCall(input.hostname, input.pinnedRootPem, ...)` calls in `verifyLogin` to `input.pinnedLeafSha256`.
- Change `verifyLogin`'s input type field `pinnedRootPem: string | null` → `pinnedLeafSha256: string | null`.
- Update the `@ai-warning` above `soapCall` that references `verifiedTlsOptions` to describe the factory instead (fingerprint gate; `rejectUnauthorized: false` confined; no `checkServerIdentity`).

- [ ] **Step 5: Rename the pin field through the transport consumers**

- `apps/server/src/services/vsphere-collector.ts`: in `SoapTransport` (line ~78) rename the 2nd param `pinnedRootPem` → `pinnedLeafSha256`; in `collect`'s input type (line ~145) and destructure (line ~150) rename `pinnedRootPem` → `pinnedLeafSha256`; the `this.transport(hostname, pinnedLeafSha256, ...)` call.
- `apps/server/src/services/vsphere-sync.ts:81`, `vsphere-snapshot.ts:61`, `vsphere-inventory.ts:64`: rename the credentials-object field `pinnedRootPem: string | null` → `pinnedLeafSha256: string | null`.
- `apps/server/src/services/vsphere-job-runner.ts`: in `interface VsphereCredentials` (line ~13) rename `pinnedRootPem` → `pinnedLeafSha256`; at the construction site (line ~162) change `pinnedRootPem: connection.tlsPinnedCaPem,` → `pinnedLeafSha256: connection.tlsPinnedSha256,`.

- [ ] **Step 6: Run the linchpin test + full server suite — expect PASS**

Run: `pnpm --filter @lcm/server test -- vsphere-fingerprint-pin`
Expected: PASS (both cases: zero bytes on mismatch, body delivered on match).
Run: `pnpm typecheck`
Expected: PASS (all transport consumers renamed).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(server): pin the vCenter leaf fingerprint on the credential path

soapCall now opens a pinned connection through a confined createConnection
factory that verifies the presented leaf's SHA-256 on secureConnect and destroys
the socket before any request byte is written on a mismatch. rejectUnauthorized:
false lives only inside that factory; a null pin keeps the system-trust path. A
byte-recording TLS test proves zero credential bytes leak on mismatch." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01EvuAEAuEBdYxxcBbU3enh5"
```

---

### Task 4: Sync — a fingerprint mismatch surfaces as `cert_mismatch`

When a pinned connection's leaf rotates, route it to the "Replace the trusted certificate" flow instead of the first-time-trust one.

**Files:**

- Modify: `apps/server/src/services/vsphere-sync.ts:100-140,503-520`
- Modify: `apps/server/src/__tests__/vsphere-sync.test.ts` (add a mismatch case)

**Interfaces:**

- Consumes: `soapCall`/collector reject with `code: 'CERT_FINGERPRINT_MISMATCH'` (Task 3).
- Produces: on a fingerprint mismatch, `VsphereConnection.status = 'cert_mismatch'`; the returned `VsphereSyncResult.outcome` stays a valid `VsphereSyncOutcome` (`'tls_untrusted'`).

- [ ] **Step 1: Write the failing mismatch test**

In `apps/server/src/__tests__/vsphere-sync.test.ts`, add a case that injects a collector whose `collect` rejects with `Object.assign(new Error('fp mismatch'), { code: 'CERT_FINGERPRINT_MISMATCH' })`, runs a sync for a pinned connection, and asserts the connection row's `status === 'cert_mismatch'` and `lastError` is the sanitized mismatch message. (Mirror the existing failure-path tests in this file for setup — factories + the real Postgres.)

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm --filter @lcm/server test -- vsphere-sync`
Expected: FAIL — the mismatch currently classifies as `tls_untrusted` (message matches `/cert|tls/`), so `status` is `tls_untrusted`, not `cert_mismatch`.

- [ ] **Step 3: Classify the fingerprint mismatch distinctly**

In `apps/server/src/services/vsphere-sync.ts`, add the import `extractTlsErrorCode` if not present (it is imported already for the log line), and change `classify`:

```ts
function classify(err: unknown): 'unreachable' | 'auth_failed' | 'tls_untrusted' | 'cert_mismatch' {
  const code = extractTlsErrorCode(err);
  const msg = err instanceof Error ? err.message : String(err);
  // A pinned leaf that no longer matches: the cert WAS trusted and now differs —
  // route it to the "replace the trusted certificate" flow, not first-time trust.
  if (code === 'CERT_FINGERPRINT_MISMATCH' || /CERT_FINGERPRINT_MISMATCH/.test(msg)) {
    return 'cert_mismatch';
  }
  if (/auth|login|credential/i.test(msg)) return 'auth_failed';
  if (/cert|tls|self.signed/i.test(msg)) return 'tls_untrusted';
  return 'unreachable';
}
```

In `sanitize`, add a branch before the `tls_untrusted` one:

```ts
if (outcome === 'cert_mismatch') {
  return 'vCenter is presenting a different certificate than the one you trusted.';
}
```

In the catch block (~line 112-137), keep `const outcome = classify(err);` and `data: { status: outcome, ... }` — `cert_mismatch` is a valid `VsphereConnectionStatus`. But the returned `VsphereSyncResult.outcome` must be a `VsphereSyncOutcome` (which has no `cert_mismatch`), so map it:

```ts
const syncOutcome: VsphereSyncOutcome = outcome === 'cert_mismatch' ? 'tls_untrusted' : outcome;
return { ...empty, outcome: syncOutcome, error: sanitize(err) };
```

Import `VsphereSyncOutcome` from `@lcm/shared` if not already. Adjust the log-level line so `cert_mismatch` warns (it is persistent/actionable): `if (outcome === 'unreachable') this.logger.info(...) else this.logger.warn(...)` already covers it.

- [ ] **Step 4: Run the sync tests — expect PASS**

Run: `pnpm --filter @lcm/server test -- vsphere-sync`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): surface a vCenter leaf-pin mismatch as cert_mismatch

A pinned connection whose presented leaf no longer matches now sets status
cert_mismatch (routing the operator to the Replace-the-trusted-certificate flow)
while the sync outcome stays a valid tls_untrusted for the job vocabulary." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01EvuAEAuEBdYxxcBbU3enh5"
```

---

### Task 5: Prisma migration — reset pins and drop the PEM column

**Files:**

- Modify: `apps/server/prisma/schema.prisma` (`VsphereConnection`: remove `tlsPinnedCaPem`; update comments)
- Create: `apps/server/prisma/migrations/20260721HHMMSS_vsphere_leaf_pinning/migration.sql`

**Interfaces:**

- Consumes: no code references `tlsPinnedCaPem` remain after Tasks 2–3. Verify with grep before generating.

- [ ] **Step 1: Confirm no code references the column**

Run: `grep -rn "tlsPinnedCaPem\|tls_pinned_ca_pem" apps/server/src packages`
Expected: no matches in non-migration source (tests updated in Task 2). If any remain, fix them before continuing — `prisma generate` will drop the field and break compilation otherwise.

- [ ] **Step 2: Edit the schema**

In `apps/server/prisma/schema.prisma`, `model VsphereConnection`:

- Remove the `tlsPinnedCaPem  String? @map("tls_pinned_ca_pem")` line and its doc comment.
- Update the `tlsPinnedSha256` comment to: `/// The pinned trust anchor: the SHA-256 of the presented LEAF certificate (govc form). Public data, plaintext. Does not survive vCenter leaf renewal — a mismatch then surfaces as cert_mismatch for re-confirm. See the 2026-07-21 design (supersedes D11).`
- Update the `tlsMode` comment: `/// 'system' | 'pinned', both fail closed. 'pinned' verifies the leaf fingerprint; 'system' verifies against the system trust store. No insecure value, ever.`
- Update the `port` comment's "TOFU root-pinning" phrase to "TOFU leaf-fingerprint pinning".

- [ ] **Step 3: Generate the migration**

Run: `pnpm --filter @lcm/server exec prisma migrate dev --name vsphere_leaf_pinning --create-only`
Expected: a new migration folder with a `DROP COLUMN` statement. Then **edit** the generated `migration.sql` to prepend the data reset (so existing dev pins re-confirm the leaf), making the full file:

```sql
-- Existing pins are chain-root fingerprints/PEMs and cannot match a leaf pin.
-- Reset them so the operator re-confirms the leaf once (dev-only; no prod data).
UPDATE "vsphere_connections"
SET "tls_pinned_sha256" = NULL,
    "status" = 'tls_untrusted'
WHERE "tls_mode" = 'pinned' AND "tls_pinned_sha256" IS NOT NULL;

-- Leaf pinning stores only the fingerprint; the PEM anchor is gone.
ALTER TABLE "vsphere_connections" DROP COLUMN "tls_pinned_ca_pem";
```

- [ ] **Step 4: Apply + regenerate client, then typecheck**

Run: `pnpm --filter @lcm/server exec prisma migrate dev` then `pnpm --filter @lcm/server exec prisma generate`
Expected: migration applies clean; client regenerates without `tlsPinnedCaPem`.
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Run the full server suite — expect PASS**

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

### Task 6: Documentation — supersede D11, update operator notes

**Files:**

- Modify: `docs/vsphere-integration-design.md` (§0.1 amendment; D10 stands; D11 marked superseded)
- Modify: `docs/operations.md` (any TLS-trust / pinning operator note)
- Modify: `docs/superpowers/specs/2026-07-21-vsphere-leaf-fingerprint-pinning-design.md` (Status → implemented; link the plan)

- [ ] **Step 1: Amend the vSphere design doc**

In `docs/vsphere-integration-design.md`:

- At **D11** (§5, "Pin the root of the presented chain…"), add a leading note: `> **SUPERSEDED 2026-07-21** by leaf-fingerprint pinning — see docs/superpowers/specs/2026-07-21-vsphere-leaf-fingerprint-pinning-design.md. Real vCenters present the leaf without the VMCA root in the handshake, so root-pinning had nothing to pin (#272). Leaf-fingerprint pinning verifies the exact cert at the socket before any write; it is verification-equivalent, not the §0.1-rejected "ignore TLS" flag, and D10 (no checkServerIdentity) still holds.`
- At **§0.1**, append one line: `Amendment 2026-07-21: root-pinning (D11) is replaced by leaf-fingerprint pinning. This is NOT the "ignore TLS" flag rejected here — verification stays on; the predicate is exact-cert identity rather than "chains to a trusted root." The rejection of an insecure/ignore flag stands.`

- [ ] **Step 2: Update operations.md**

Search `docs/operations.md` for pinning/TLS-trust wording (root pin, "Trust this certificate", CA). Update it to describe leaf-fingerprint pinning and the `cert_mismatch` → re-confirm-on-renewal behavior. If no such section exists, add a short "vCenter certificate trust" note describing: probe → confirm the fingerprint against `govc about.cert -thumbprint` → pin; on leaf renewal the connection shows `cert_mismatch` and the admin re-confirms.

- [ ] **Step 3: Mark the spec implemented**

In the design spec header, set `- **Status:** Implemented via docs/superpowers/plans/2026-07-21-vsphere-leaf-fingerprint-pinning.md.`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: record leaf-fingerprint pinning superseding D11

Amend the vSphere integration design (D11 superseded, §0.1 clarified, D10 stands),
update the operator trust note, and mark the leaf-pinning spec implemented." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" \
  -m "Claude-Session: https://claude.ai/code/session_01EvuAEAuEBdYxxcBbU3enh5"
```

---

### Task 7: Full verification + high-risk review gate

**Files:** none (verification only).

- [ ] **Step 1: Run the complete affected suite**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all PASS (server suite needs Docker).

- [ ] **Step 2: Web e2e (golden path unaffected, but confirm)**

Run: `pnpm --filter @lcm/web test:e2e` (assumes the dev stack). Expected: PASS. This is not a CI gate but confirms the settings flow renders.

- [ ] **Step 3: Manual smoke against a self-signed target (optional but recommended)**

With the dev stack up, add a vCenter connection pointing at a self-signed / incomplete-chain host, probe, confirm the fingerprint matches `govc about.cert -thumbprint`, trust, and confirm a sync connects. Confirm a deliberately wrong fingerprint yields `cert_mismatch`, not a hang or a silent success.

- [ ] **Step 4: Open the PR into `dev` with the high-risk controls**

This is a High-risk change (TLS trust path + shared contract + migration). Per CLAUDE.md "Automated high-risk approval", the PR body MUST include: the DESIGN.md link (the spec), the threat model / invariants (copy from the spec), the linchpin verification evidence (the byte-recording test), and it needs two independent AI reviews (e.g. `critic` + `brahma-analyzer`) or a human sign-off, plus green CI (`verify` + `oidc-e2e`). Target base: `dev`. Do NOT merge to `dev`/`main` directly.

```bash
git push -u origin fix/272-vsphere-leaf-pinning-design
gh pr create --base dev --title "fix(#272): pin the vCenter leaf certificate instead of a chain root" --body "<design link + threat model + invariants + linchpin evidence>"
```

---

## Self-Review

**Spec coverage:**

- Decision (leaf pin, two-mode, confined `rejectUnauthorized:false`) → Tasks 2, 3. ✓
- `system` mode unchanged (null pin → system trust) → Task 3 Step 4 (`rejectUnauthorized: true` branch). ✓
- Data model (drop `tlsPinnedCaPem`, keep `tlsPinnedSha256` as leaf, reset pins) → Task 5. ✓
- Shared contract renames + `/trust-cert` → Task 1. ✓
- Certificate capture (leaf fp; remove `rootOf`/`derToPem`; keep diagnostics) → Task 2. ✓
- The `createConnection` gate + no-`checkServerIdentity` + empirical byte test → Task 3 (linchpin). ✓
- Trust flow (password-gated, re-probe, store leaf) → Task 2 Steps 5-6. ✓
- Sync mismatch → `cert_mismatch` (+ lockstep union note handled by mapping to `tls_untrusted` for `VsphereSyncOutcome`) → Task 4. ✓
- Invariants 1-6 → Task 3 (INV 1-3, 6), Task 2 (INV 5 password gate is route-preserved), Task 4 (INV 4). ✓
- Threat model / misuse (hostname-verification-replaced-by-exact-cert-identity) → noted in Task 3 factory `@ai-warning`; the mismatch-before-write test is INV-1's proof. ✓
- Docs (D11 superseded, §0.1, operations) → Task 6. ✓
- Testing (linchpin, happy path, mismatch→cert_mismatch, probe leaf, migration reset) → Tasks 2-5. ✓

**Placeholder scan:** none — every code step shows the code; the one empirically-settled bit (return-undefined vs return-socket in `createConnection`) is called out with the test that decides it, not left vague.

**Type consistency:** `pinnedLeafSha256: string | null` is the transport param name in Task 3 across `soapCall`/`SoapTransport`/`collect`/`verifyLogin`/`VsphereCredentials`. `leafFingerprintSha256` is the contract field (Task 1) and `CapturedChain` field (Task 2). `trustCert(tenantId, id, leafFingerprintSha256)` is used identically in the route (Task 2 Step 5) and the service (Task 2 Step 6). `CERT_FINGERPRINT_MISMATCH` is the error `code` set in Task 3 and read in Task 4.

**Known risk to watch:** Task 3's `createConnection` ordering is the one place Node behavior must be verified empirically — the linchpin test is the gate, and it runs before any consumer relies on the gate. If it cannot be made airtight, stop and escalate; do not weaken the test.
