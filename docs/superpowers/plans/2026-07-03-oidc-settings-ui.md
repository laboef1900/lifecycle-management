# OIDC Settings UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move OIDC configuration from environment variables to a DB-backed, admin-only Authentication panel on the settings page, editable at runtime, with secrets encrypted at rest.

**Architecture:** A singleton `AuthConfig` table holds all OIDC settings; two secret columns are AES-256-GCM encrypted with one `CONFIG_ENCRYPTION_KEY`. An `AuthConfigService` + `fastify.authConfig` plugin loads/decrypts the row into an `EffectiveAuthConfig` object that replaces `env` as the auth source of truth for the oidc/auth plugins, auth routes, and users service. New `/api/settings/auth` endpoints (admin-gated when auth is on, open when disabled) edit it; a save re-runs OIDC discovery with no restart. The web app gets an admin-only Authentication panel.

**Tech Stack:** Fastify 5 · Prisma 6 · Zod 4 · openid-client 6 · React 19 + TanStack · node:crypto (AES-256-GCM, HMAC-SHA256) · Vitest/testcontainers.

## Global Constraints

- `pnpm` is NOT on PATH: every command is `npx -y pnpm@11 <args>` (called `PNPM` below). Run `PNPM install`, `PNPM --filter @lcm/server exec prisma generate`, `PNPM --filter @lcm/web generate-routes` before typecheck.
- Docker Desktop must be running (server integration tests use testcontainers).
- Zod 4 idioms (`z.strictObject`, `z.url()`, `z.flattenError`); response schemas are non-strict `z.object` annotated `z.ZodType<T>` (forward-compat convention).
- Commit style matches repo history (`feat(scope)`/`fix(scope)`/`test(scope)`/`docs(scope)`); every commit ends with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Do NOT push mid-plan.
- Secrets (`clientSecret`, `signingSecret`) are NEVER returned by any API, NEVER logged. `GET` returns `clientSecretSet`/`signingSecretSet` booleans only.
- `EffectiveAuthConfig` (defined Task C3) is the auth source of truth. After it lands, no auth code (oidc plugin, auth plugin, auth routes, users service) reads `env.AUTH_MODE`/`env.OIDC_*`/`env.APP_BASE_URL`/`env.LOGIN_STATE_SECRET`/`env.SESSION_TTL_HOURS` — those become seed-only.
- `defaultRole` config value is `'admin' | 'viewer'` (lowercase, mirrors the old `OIDC_DEFAULT_ROLE`); it maps to the `UserRole` enum `'ADMIN' | 'VIEWER'`.
- Encryption key: `CONFIG_ENCRYPTION_KEY` is base64 of exactly 32 bytes. Secret envelope format: `base64(iv).base64(tag).base64(ciphertext)` with a 12-byte IV.
- Singleton `AuthConfig` row id is the literal string `"singleton"`.
- Branch: `feat/oidc-settings-ui` (already created; spec committed at 64b5a68).

---

## Phase A — Setup

### Task A1: Verify baseline

**Files:** none

- [ ] **Step 1:** `docker info --format '{{.ServerVersion}}'` — expect a version. If it errors, STOP.
- [ ] **Step 2:** `PNPM install && PNPM --filter @lcm/server exec prisma generate && PNPM --filter @lcm/web generate-routes`
- [ ] **Step 3:** `PNPM typecheck && PNPM --filter @lcm/server test` — expect green (baseline includes the merged OIDC auth suite).

---

## Phase B — Shared schemas

### Task B1: `auth-config` shared schemas

**Files:**

- Create: `packages/shared/src/schemas/auth-config.ts`
- Modify: `packages/shared/src/index.ts` (barrel export)
- Test: `packages/shared/src/schemas/__tests__/auth-config.test.ts`

**Interfaces:**

- Produces (consumed by server routes Task E2 + web Task F1/F2):
  - `authConfigUpdateSchema` — validates `PUT /api/settings/auth` body.
  - `authConfigTestSchema` — validates `POST …/test` body.
  - `AuthConfigResponse` interface + `authConfigResponseSchema: z.ZodType<AuthConfigResponse>` (non-strict).

- [ ] **Step 1:** Write the failing test:

```ts
import { describe, expect, it } from 'vitest';
import { authConfigUpdateSchema, authConfigResponseSchema } from '../auth-config.js';

describe('authConfigUpdateSchema', () => {
  it('accepts a full oidc config with a client secret', () => {
    const r = authConfigUpdateSchema.safeParse({
      mode: 'oidc',
      issuerUrl: 'https://idp.example.com/realms/lcm',
      clientId: 'lcm',
      clientSecret: 'shhh',
      appBaseUrl: 'https://lcm.example.com',
      scopes: 'openid profile email',
      defaultRole: 'admin',
      sessionTtlHours: 12,
      allowInsecure: false,
    });
    expect(r.success).toBe(true);
  });
  it('omitting clientSecret is allowed (unchanged); null clears it', () => {
    expect(authConfigUpdateSchema.safeParse({ mode: 'disabled' }).success).toBe(true);
    expect(authConfigUpdateSchema.safeParse({ mode: 'disabled', clientSecret: null }).success).toBe(
      true,
    );
  });
  it('rejects a bad issuer url and out-of-range ttl', () => {
    expect(authConfigUpdateSchema.safeParse({ mode: 'oidc', issuerUrl: 'not-a-url' }).success).toBe(
      false,
    );
    expect(authConfigUpdateSchema.safeParse({ mode: 'oidc', sessionTtlHours: 0 }).success).toBe(
      false,
    );
    expect(authConfigUpdateSchema.safeParse({ mode: 'oidc', sessionTtlHours: 1000 }).success).toBe(
      false,
    );
  });
});

describe('authConfigResponseSchema', () => {
  it('parses a sanitized response and tolerates an extra field', () => {
    const r = authConfigResponseSchema.safeParse({
      mode: 'oidc',
      issuerUrl: 'https://x',
      clientId: 'lcm',
      appBaseUrl: 'https://a',
      scopes: 'openid',
      roleClaim: null,
      adminValues: null,
      defaultRole: 'admin',
      allowedEmailDomains: null,
      allowedEmails: null,
      sessionTtlHours: 12,
      allowInsecure: false,
      clientSecretSet: true,
      signingSecretSet: true,
      redirectUri: 'https://a/api/auth/callback',
      discoveryStatus: 'connected',
      lastDiscoveryError: null,
      futureField: 1,
    });
    expect(r.success).toBe(true);
  });
  it('rejects a bad discoveryStatus', () => {
    expect(authConfigResponseSchema.safeParse({ discoveryStatus: 'nope' }).success).toBe(false);
  });
});
```

- [ ] **Step 2:** `PNPM --filter @lcm/shared test` — FAIL (module missing).
- [ ] **Step 3:** Create `auth-config.ts`:

```ts
import { z } from 'zod';

const emptyToNull = (v: unknown): unknown => (v === '' ? null : v);
const csvField = z.preprocess(emptyToNull, z.string().max(2000).nullable().optional());
const urlOrNull = z.preprocess(emptyToNull, z.url().nullable().optional());

export const authConfigUpdateSchema = z.strictObject({
  mode: z.enum(['disabled', 'oidc']),
  issuerUrl: urlOrNull,
  clientId: z.preprocess(emptyToNull, z.string().max(255).nullable().optional()),
  // write-only: omitted = unchanged; null = clear; string = set
  clientSecret: z.preprocess(emptyToNull, z.string().max(2000).nullable().optional()),
  appBaseUrl: urlOrNull,
  scopes: z.string().min(1).max(500).default('openid profile email'),
  roleClaim: z.preprocess(emptyToNull, z.string().max(255).nullable().optional()),
  adminValues: csvField,
  defaultRole: z.enum(['admin', 'viewer']).default('admin'),
  allowedEmailDomains: csvField,
  allowedEmails: csvField,
  sessionTtlHours: z.coerce.number().int().min(1).max(720).default(12),
  allowInsecure: z.boolean().default(false),
});
export type AuthConfigUpdate = z.infer<typeof authConfigUpdateSchema>;

export const authConfigTestSchema = z.strictObject({
  issuerUrl: z.url(),
  clientId: z.string().min(1),
  // if omitted, the server uses the stored secret
  clientSecret: z.preprocess(emptyToNull, z.string().nullable().optional()),
  allowInsecure: z.boolean().default(false),
});
export type AuthConfigTest = z.infer<typeof authConfigTestSchema>;

export interface AuthConfigResponse {
  mode: 'disabled' | 'oidc';
  issuerUrl: string | null;
  clientId: string | null;
  appBaseUrl: string | null;
  scopes: string;
  roleClaim: string | null;
  adminValues: string | null;
  defaultRole: 'admin' | 'viewer';
  allowedEmailDomains: string | null;
  allowedEmails: string | null;
  sessionTtlHours: number;
  allowInsecure: boolean;
  clientSecretSet: boolean;
  signingSecretSet: boolean;
  redirectUri: string;
  discoveryStatus: 'connected' | 'unavailable' | 'disabled';
  lastDiscoveryError: string | null;
}

export const authConfigResponseSchema: z.ZodType<AuthConfigResponse> = z.object({
  mode: z.enum(['disabled', 'oidc']),
  issuerUrl: z.string().nullable(),
  clientId: z.string().nullable(),
  appBaseUrl: z.string().nullable(),
  scopes: z.string(),
  roleClaim: z.string().nullable(),
  adminValues: z.string().nullable(),
  defaultRole: z.enum(['admin', 'viewer']),
  allowedEmailDomains: z.string().nullable(),
  allowedEmails: z.string().nullable(),
  sessionTtlHours: z.number(),
  allowInsecure: z.boolean(),
  clientSecretSet: z.boolean(),
  signingSecretSet: z.boolean(),
  redirectUri: z.string(),
  discoveryStatus: z.enum(['connected', 'unavailable', 'disabled']),
  lastDiscoveryError: z.string().nullable(),
});
export type AuthConfigTestResult = { ok: boolean; error: string | null };
```

Add to `packages/shared/src/index.ts`: `export * from './schemas/auth-config.js';`

- [ ] **Step 4:** `PNPM --filter @lcm/shared test && PNPM --filter @lcm/shared typecheck` — PASS.
- [ ] **Step 5:** Commit: `feat(shared): auth-config update/response schemas`

---

## Phase C — Server foundation

### Task C1: `AuthConfig` Prisma model + migration

**Files:**

- Modify: `apps/server/prisma/schema.prisma` (add model after `Session`)
- Create: `apps/server/prisma/migrations/<timestamp>_add_auth_config/migration.sql` (generated)

**Interfaces:**

- Produces: Prisma `AuthConfig` model + client types (consumed by C3).

- [ ] **Step 1:** Add to `schema.prisma` after the `Session` model:

```prisma
model AuthConfig {
  id                  String   @id @default("singleton")
  mode                String   @default("disabled")
  issuerUrl           String?
  clientId            String?
  clientSecretEnc     String?
  signingSecretEnc    String?
  appBaseUrl          String?
  scopes              String   @default("openid profile email")
  roleClaim           String?
  adminValues         String?
  defaultRole         String   @default("admin")
  allowedEmailDomains String?
  allowedEmails       String?
  sessionTtlHours     Int      @default(12)
  allowInsecure       Boolean  @default(false)
  updatedAt           DateTime @updatedAt
  updatedByUserId     String?

  @@map("auth_config")
}
```

- [ ] **Step 2:** Generate the migration WITHOUT applying to a dev DB you care about (use a throwaway): `PNPM --filter @lcm/server exec prisma migrate dev --name add_auth_config --create-only` then inspect the generated SQL (a single `CREATE TABLE "auth_config"`). If no dev DB is available, hand-write the migration.sql mirroring the model and run `prisma migrate deploy` inside the test container path (the integration harness applies migrations).
- [ ] **Step 3:** `PNPM --filter @lcm/server exec prisma generate` — client now exposes `prisma.authConfig`.
- [ ] **Step 4:** `PNPM --filter @lcm/server typecheck` — PASS (no consumers yet).
- [ ] **Step 5:** Commit: `feat(server): AuthConfig singleton model + migration`

### Task C2: `secret-box` AES-256-GCM helper

**Files:**

- Create: `apps/server/src/crypto/secret-box.ts`
- Test: `apps/server/src/crypto/__tests__/secret-box.test.ts`

**Interfaces:**

- Produces (consumed by C3): `encrypt(plaintext: string, key: Buffer): string`, `decrypt(envelope: string, key: Buffer): string`, `loadKey(raw: string | undefined): Buffer`, `generateSecret(): string`.

- [ ] **Step 1:** Failing test:

```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encrypt, decrypt, loadKey, generateSecret } from '../secret-box.js';

const key = randomBytes(32);

describe('secret-box', () => {
  it('roundtrips', () => {
    const env = encrypt('client-secret', key);
    expect(env).not.toContain('client-secret');
    expect(decrypt(env, key)).toBe('client-secret');
  });
  it('rejects a tampered envelope', () => {
    const env = encrypt('x', key).split('.');
    env[2] = Buffer.from('tampered').toString('base64');
    expect(() => decrypt(env.join('.'), key)).toThrow();
  });
  it('rejects a wrong key', () => {
    expect(() => decrypt(encrypt('x', key), randomBytes(32))).toThrow();
  });
  it('loadKey requires 32 base64 bytes', () => {
    expect(() => loadKey(undefined)).toThrow(/CONFIG_ENCRYPTION_KEY/);
    expect(() => loadKey('short')).toThrow();
    expect(loadKey(randomBytes(32).toString('base64')).length).toBe(32);
  });
  it('generateSecret returns 32-byte base64url', () => {
    expect(Buffer.from(generateSecret(), 'base64url').length).toBe(32);
  });
});
```

- [ ] **Step 2:** `PNPM --filter @lcm/server test -- secret-box` — FAIL.
- [ ] **Step 3:** Implement `secret-box.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

export function decrypt(envelope: string, key: Buffer): string {
  const [ivB64, tagB64, ctB64] = envelope.split('.');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed secret envelope');
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

export function loadKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error('CONFIG_ENCRYPTION_KEY is required to read or write auth secrets');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32)
    throw new Error('CONFIG_ENCRYPTION_KEY must be base64 of exactly 32 bytes');
  return key;
}

export function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}
```

- [ ] **Step 4:** `PNPM --filter @lcm/server test -- secret-box` — PASS.
- [ ] **Step 5:** Commit: `feat(server): secret-box AES-256-GCM helper`

### Task C3: `EffectiveAuthConfig` + `AuthConfigService`

**Files:**

- Create: `apps/server/src/services/auth-config.ts`
- Test: `apps/server/src/services/__tests__/auth-config.test.ts` (integration — testcontainers, like existing service tests)

**Interfaces:**

- Consumes: `secret-box` (C2), Prisma `AuthConfig` (C1), `AuthConfigUpdate`/`AuthConfigResponse` (B1).
- Produces (consumed by C5/D1–D4/E2):
  - `interface EffectiveAuthConfig { mode; issuerUrl; clientId; clientSecret; signingSecret; appBaseUrl; scopes; roleClaim; adminValues; defaultRole; allowedEmailDomains; allowedEmails; sessionTtlHours; allowInsecure }` (exact fields per spec; secrets are decrypted strings or null).
  - `class AuthConfigService { constructor(prisma, key: Buffer | null); load(seedEnv?): Promise<EffectiveAuthConfig>; update(input: AuthConfigUpdate, actorUserId: string | null): Promise<void>; toEffective(row): EffectiveAuthConfig; sanitize(effective, redirectUri, discoveryStatus, lastError): AuthConfigResponse }`
  - Standalone: `seedFromEnv(env): AuthConfigUpdate | null` (maps OIDC env vars → an update payload, or null when none present).

- [ ] **Step 1:** Failing integration test (mirror `apps/server/src/services/__tests__/*.test.ts` harness — a testcontainers Prisma). Cover:

```ts
// pseudocode of the assertions; use the repo's existing integration test bootstrap
// (grep an existing services test for the container/prisma setup and copy it).
it('creates a default disabled row on first load when no env + no key', async () => {
  const svc = new AuthConfigService(prisma, null);
  const cfg = await svc.load();
  expect(cfg.mode).toBe('disabled');
  expect(await prisma.authConfig.findUnique({ where: { id: 'singleton' } })).not.toBeNull();
});
it('seeds from env on first load, encrypting the client secret', async () => {
  const svc = new AuthConfigService(prisma, key);
  const cfg = await svc.load({
    AUTH_MODE: 'oidc',
    OIDC_ISSUER_URL: 'https://idp',
    OIDC_CLIENT_ID: 'lcm',
    OIDC_CLIENT_SECRET: 'shh',
    APP_BASE_URL: 'https://app',
    LOGIN_STATE_SECRET: 'x'.repeat(32),
    OIDC_SCOPES: 'openid profile email',
    OIDC_DEFAULT_ROLE: 'admin',
  } as any);
  expect(cfg.mode).toBe('oidc');
  expect(cfg.clientSecret).toBe('shh'); // decrypted in-memory
  const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
  expect(row!.clientSecretEnc).not.toBeNull();
  expect(row!.clientSecretEnc).not.toContain('shh'); // encrypted at rest
});
it('update leaves an omitted secret unchanged, clears on null', async () => {
  const svc = new AuthConfigService(prisma, key);
  await svc.update(
    { mode: 'oidc', clientId: 'a', clientSecret: 'first' /* ...required */ } as any,
    null,
  );
  await svc.update({ mode: 'oidc', clientId: 'b' } as any, null); // secret omitted
  expect((await svc.load()).clientSecret).toBe('first');
  await svc.update({ mode: 'oidc', clientId: 'b', clientSecret: null } as any, null);
  expect((await svc.load()).clientSecret).toBeNull();
});
it('sanitize never includes secret values', () => {
  const svc = new AuthConfigService(prisma, key);
  const eff = { mode: 'oidc', clientSecret: 'shh', signingSecret: 'sig' /* ... */ } as any;
  const out = JSON.stringify(svc.sanitize(eff, 'https://app/api/auth/callback', 'connected', null));
  expect(out).not.toContain('shh');
  expect(out).not.toContain('sig');
  expect(out).toContain('"clientSecretSet":true');
});
```

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement `auth-config.ts`. Key logic:
  - `EffectiveAuthConfig` interface as above.
  - `toEffective(row)`: decrypt `clientSecretEnc`/`signingSecretEnc` with `this.key` (throw a clear error if a secret is present but `this.key` is null); map columns to the effective shape; coerce `mode`/`defaultRole` to the union types.
  - `load(seedEnv?)`: `findUnique({id:'singleton'})`; if null → if `seedEnv && seedFromEnv(seedEnv)` is non-null, `update(seed, null)` then re-read; else create the default row (`prisma.authConfig.create({ data: { id: 'singleton' } })`). If the row exists but `mode==='oidc'` and `signingSecretEnc` is null, generate+store a signing secret (upgrade path). Return `toEffective(row)`.
  - `update(input, actorUserId)`: build a Prisma `data` object; for `clientSecret`: `undefined` → don't touch column, `null` → set `clientSecretEnc: null`, string → `encrypt(value, key)` (throw if key null). When enabling oidc and no signing secret exists, generate one. Set `updatedByUserId`. `upsert({ where:{id:'singleton'}, create:{ id:'singleton', ...data }, update:data })`.
  - `sanitize(effective, redirectUri, discoveryStatus, lastError)`: return `AuthConfigResponse` with `clientSecretSet: effective.clientSecret !== null`, `signingSecretSet: effective.signingSecret !== null`, secrets omitted.
  - `seedFromEnv(env)`: if none of `OIDC_ISSUER_URL/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET/APP_BASE_URL` set → return null; else map env → `AuthConfigUpdate` (mode from `AUTH_MODE ?? 'oidc'`, defaultRole from `OIDC_DEFAULT_ROLE`, etc.). LOGIN_STATE_SECRET is NOT copied to signingSecret (signing secret is app-generated); if present it's ignored (documented).
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit: `feat(server): AuthConfigService with encrypted secrets and env seed`

### Task C4: `env.ts` — key + recovery, relax OIDC requirements

**Files:**

- Modify: `apps/server/src/env.ts`
- Test: `apps/server/src/__tests__/env.test.ts` (extend; find existing)

**Interfaces:**

- Produces: `env.CONFIG_ENCRYPTION_KEY?: string`, `env.RECOVERY_DISABLE_AUTH: boolean`. OIDC/AUTH vars stay optional (seed-only); the `superRefine` "required when AUTH_MODE=oidc" block is REMOVED.

- [ ] **Step 1:** Failing test: `parseEnv({ AUTH_MODE: 'oidc' })` now SUCCEEDS (no longer requires the OIDC vars — the DB is authoritative); `RECOVERY_DISABLE_AUTH: 'true'` parses to boolean `true`; `CONFIG_ENCRYPTION_KEY` passes through.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** In `env.ts`: add `CONFIG_ENCRYPTION_KEY: optionalString()` and `RECOVERY_DISABLE_AUTH: z.preprocess(emptyToUndefined, z.enum(['true','false']).default('false').transform(v => v === 'true'))`. DELETE the `superRefine` branch that adds issues for missing `OIDC_REQUIRED_VARS` when `AUTH_MODE==='oidc'` (keep the "AUTH_MODE must be explicit when OIDC vars present" branch as a soft aid, or remove entirely — remove to avoid confusion now that env is seed-only; keep the `.transform` defaulting `AUTH_MODE` to `'disabled'` for the seed mapping). Keep all OIDC var definitions (still read by `seedFromEnv`).
- [ ] **Step 4:** Run env tests + `PNPM --filter @lcm/server typecheck` — PASS.
- [ ] **Step 5:** Commit: `feat(server): CONFIG_ENCRYPTION_KEY + RECOVERY_DISABLE_AUTH; OIDC env is seed-only`

### Task C5: `auth-config` plugin (`fastify.authConfig`)

**Files:**

- Create: `apps/server/src/plugins/auth-config.ts`
- Test: `apps/server/src/__tests__/auth-config-plugin.test.ts`

**Interfaces:**

- Consumes: `AuthConfigService` (C3), `secret-box.loadKey` (C2), env (C4).
- Produces (consumed by D2/D3/D4/E2): decorator

  ```ts
  fastify.authConfig: {
    current: EffectiveAuthConfig;
    service: AuthConfigService;
    reload(): Promise<void>;
  }
  ```

  Registered after `prisma`, before `auth`/`oidc`. On boot: build key (or null if unset), `service.load(env)` seeds, apply `RECOVERY_DISABLE_AUTH` (if true, flip mode directly — `prisma.authConfig.update({ where:{id:'singleton'}, data:{ mode:'disabled' } })` then re-`load()`; do NOT route through `service.update()`, which would re-encrypt secrets — and warn loudly), set `current`.

- [ ] **Step 1:** Failing test: build a fastify instance with an injected prisma (testcontainers) + the plugin; assert `fastify.authConfig.current.mode` reflects the seeded row; assert `RECOVERY_DISABLE_AUTH=true` forces `mode==='disabled'` even when the row says `oidc`; assert `reload()` picks up an out-of-band row change.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement the plugin (`fp` with `dependencies: ['prisma']`). Load key via `env.CONFIG_ENCRYPTION_KEY ? loadKey(...) : null`. Order at boot: (a) `service.load(env)` — but wrap the decrypt so that if the key is null while `mode==='oidc'`, catch and force mode disabled directly in the DB + loud error (can't decrypt without the key; fail safe, don't crash); (b) if `RECOVERY_DISABLE_AUTH`, flip mode disabled directly (per interface note) + warn; (c) re-`load()` and set `current`. Declare the `fastify` module augmentation for `authConfig`.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit: `feat(server): auth-config plugin decorating fastify.authConfig`

---

## Phase D — Rewire auth off env

### Task D1: `users.ts` reads `EffectiveAuthConfig`

**Files:**

- Modify: `apps/server/src/services/users.ts`
- Test: `apps/server/src/__tests__/users.test.ts` (or wherever computeRole/isEmailAllowed are tested — grep)

**Interfaces:**

- Produces: `computeRole(claims, cfg: EffectiveAuthConfig): UserRole`, `isEmailAllowed(email, cfg: EffectiveAuthConfig): boolean`, `upsertFromIdentity(identity, cfg: EffectiveAuthConfig): Promise<User>`.

- [ ] **Step 1:** Update the existing tests to pass an `EffectiveAuthConfig` object (build a minimal `disabled`/`oidc` fixture) instead of an `Env`. Behavior unchanged: `computeRole` uses `cfg.defaultRole`/`cfg.roleClaim`/`cfg.adminValues`; `isEmailAllowed` uses `cfg.allowedEmails`/`cfg.allowedEmailDomains`.
- [ ] **Step 2:** Run — FAIL (signatures).
- [ ] **Step 3:** Change the three functions to accept `cfg: EffectiveAuthConfig` and read `cfg.*` instead of `env.OIDC_*`. Import the type from `./auth-config.js`.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit: `refactor(server): users service reads EffectiveAuthConfig`

### Task D2: `oidc.ts` reads config + `reconfigure()`

**Files:**

- Modify: `apps/server/src/plugins/oidc.ts`
- Test: `apps/server/src/__tests__/oidc-plugin.test.ts` (extend)

**Interfaces:**

- Consumes: `fastify.authConfig` (C5).
- Produces: `fastify.oidc: { config; redirectUri; status: 'connected'|'unavailable'|'disabled'; lastError: string | null; reconfigure(): Promise<void> }`. Discovery reads `fastify.authConfig.current` (issuer/clientId/clientSecret/allowInsecure); `redirectUri` derived from `current.appBaseUrl`. `reconfigure()` resets attempt + triggers immediate discovery; on `mode!=='oidc'` sets `status='disabled'`, `config=null`.

- [ ] **Step 1:** Extend tests: with a `disabled` config, `status==='disabled'` and no discovery attempted; a `reconfigure()` after switching the holder to a (fake/unreachable) oidc config flips `status` to `'unavailable'` and records `lastError`. (Keep discovery mockable — the existing test already stubs `client.discovery` or uses a local issuer; follow its pattern.)
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Rewrite the plugin to depend on `['auth-config']`, read from `fastify.authConfig.current`, expose `status`/`lastError`, and add `reconfigure()`. Remove the `env`-based option; the plugin no longer takes `{ env }` (or keeps it only for `NODE_ENV`). Redirect URI: `${current.appBaseUrl?.replace(/\/$/,'') ?? ''}/api/auth/callback`.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit: `refactor(server): oidc plugin reads authConfig, adds reconfigure()`

### Task D3: `auth.ts` plugin — gate on config, HMAC signer

**Files:**

- Modify: `apps/server/src/plugins/auth.ts`
- Create: `apps/server/src/plugins/login-state-signer.ts` (small HMAC helper)
- Test: `apps/server/src/__tests__/auth-plugin.test.ts` (extend) + `apps/server/src/__tests__/login-state-signer.test.ts`

**Interfaces:**

- Consumes: `fastify.authConfig` (C5).
- Produces: `signLoginState(value: string, secret: string): string`, `verifyLoginState(signed: string, secret: string): string | null` (HMAC-SHA256, constant-time compare). Auth `onRequest` gate reads `fastify.authConfig.current.mode` instead of `env.AUTH_MODE`; `sessionCookieName` reads `current.appBaseUrl`. `@fastify/cookie` registered WITHOUT a global secret.

- [ ] **Step 1:** Failing tests: `login-state-signer` roundtrip; tampered payload → null; wrong secret → null. Auth plugin: with `mode==='disabled'` the anonymous user is attached (unchanged); with `mode==='oidc'` and no session cookie, a protected `/api/*` route throws `UnauthenticatedError`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement `login-state-signer.ts` (`createHmac('sha256', secret)`, output `value.base64url(mac)`, verify with `timingSafeEqual`). In `auth.ts`: register `cookie` with no secret; replace `env.AUTH_MODE`/`env.APP_BASE_URL` reads with `fastify.authConfig.current.*`; keep `ANONYMOUS_USER`. `authStartupWarnings` now takes `EffectiveAuthConfig` (or is dropped — move its warnings into the auth-config plugin boot log). `sessionCookieName(cfg)` takes the effective config.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit: `refactor(server): auth plugin gates on authConfig; in-house login-state HMAC`

### Task D4: `auth.ts` routes read config + HMAC cookie

**Files:**

- Modify: `apps/server/src/routes/auth.ts`
- Test: `apps/server/src/__tests__/auth-routes.test.ts` (extend)

**Interfaces:**

- Consumes: `fastify.authConfig` (C5), `fastify.oidc` (D2), `signLoginState`/`verifyLoginState` (D3), `SessionService`, `UserService`.

- [ ] **Step 1:** Update tests: routes gate on `fastify.authConfig.current.mode` (not `env.AUTH_MODE`); `/auth/me` returns `{authRequired:false}` when `mode==='disabled'`; login sets an HMAC-signed login-state cookie (verify via `verifyLoginState`); scopes/appBaseUrl/sessionTtl come from config. Reject login with `idp_unavailable` when `fastify.oidc.config` is null.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Replace every `env.*` read in `auth.ts` with `fastify.authConfig.current.*` (add a `const cfg = () => fastify.authConfig.current` accessor since it's mutable). Login-state cookie: sign with `signLoginState(payload, cfg().signingSecret!)`, verify on callback; drop `signed: true`. `users.upsertFromIdentity(identity, cfg())`, `isEmailAllowed(email, cfg())`, `sessions.create(user.id, cfg().sessionTtlHours)`. `authRoutes` no longer needs the `{ env }` option (drop it, or keep `env` only if still used).
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit: `refactor(server): auth routes read authConfig; HMAC login-state cookie`

### Task D5: `server.ts` wiring

**Files:**

- Modify: `apps/server/src/server.ts`
- Test: existing server/integration tests must pass.

- [ ] **Step 1:** Register `authConfigPlugin` after `prismaPlugin`, before `authPlugin`. Drop `{ env }` from `authPlugin`/`oidcPlugin`/`authRoutes` registrations per their new signatures (keep `env` only where still consumed). Replace the `authStartupWarnings(env)` loop with the config-based warnings (or the auth-config plugin logs them at boot).
- [ ] **Step 2:** `PNPM --filter @lcm/server test && PNPM --filter @lcm/server typecheck` — PASS (whole server suite green with config-backed auth).
- [ ] **Step 3:** Commit: `refactor(server): wire auth-config plugin into server`

---

## Phase E — Settings endpoints

### Task E1: discovery test helper

**Files:**

- Modify: `apps/server/src/plugins/oidc.ts` (export a pure `testDiscovery`)
- Test: `apps/server/src/__tests__/oidc-plugin.test.ts` (extend)

**Interfaces:**

- Produces: `export async function testDiscovery(input: { issuerUrl: string; clientId: string; clientSecret: string; allowInsecure: boolean }): Promise<AuthConfigTestResult>` — runs `client.discovery` once, returns `{ ok:true, error:null }` or `{ ok:false, error: <sanitized message> }`. No persistence, no side effects.

- [ ] **Step 1:** Failing test: `testDiscovery` against an unreachable issuer returns `{ ok:false, error: <string> }`; against the test issuer (or a stub) returns `{ ok:true }`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement `testDiscovery` (reuse the discovery call shape from the plugin; catch → sanitized error string, never leak the secret).
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit: `feat(server): testDiscovery helper for connection testing`

### Task E2: `/api/settings/auth` routes

**Files:**

- Create: `apps/server/src/routes/settings-auth.ts`
- Modify: `apps/server/src/server.ts` (register)
- Test: `apps/server/src/__tests__/settings-auth-routes.test.ts`

**Interfaces:**

- Consumes: `fastify.authConfig` (C5), `fastify.oidc` (D2/E1), schemas (B1).
- Routes (all under `/api`): `GET /settings/auth`, `PUT /settings/auth`, `POST /settings/auth/test`, `POST /settings/auth/rotate-signing-secret`.
- Guard `requireAuthAdmin`: if `fastify.authConfig.current.mode === 'disabled'` → allow; else require `request.user?.role === 'ADMIN'` (throw `ForbiddenError` otherwise — add to `services/errors.ts` if absent, 403).

- [ ] **Step 1:** Failing integration tests:
  - `GET` returns the sanitized shape; never contains a secret value.
  - `PUT { mode:'oidc', ... }` without a passing test → 422 `TEST_REQUIRED`.
  - `POST /test` with an unreachable issuer → `{ ok:false }`, nothing persisted.
  - `PUT { mode:'disabled', clientSecret:'x' }` stores encrypted, `GET` shows `clientSecretSet:true`.
  - With `mode:'oidc'` seeded, a request carrying a VIEWER session → 403; ADMIN → 200. (Use the test harness's session/user helpers.)
  - `POST /rotate-signing-secret` → `{ rotated:true }`, `signingSecretSet` stays true.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement the routes:
  - `GET`: `const eff = fastify.authConfig.current; return service.sanitize(eff, fastify.oidc.redirectUri, fastify.oidc.status, fastify.oidc.lastError)`.
  - `PUT`: parse `authConfigUpdateSchema`; if `body.mode==='oidc'`, run `testDiscovery` with the effective (post-merge) issuer/client/secret — on failure return 422 `TEST_REQUIRED` with the error; on success `await service.update(body, request.user?.id ?? null)`, `await fastify.authConfig.reload()`, `await fastify.oidc.reconfigure()`, return the sanitized view.
  - `POST /test`: parse `authConfigTestSchema`; merge stored secret if omitted; `return testDiscovery(...)`.
  - `POST /rotate-signing-secret`: `service.rotateSigningSecret()` (add to service: generate+encrypt+store), reload, `{ rotated:true }`.
  - Apply `requireAuthAdmin` as a `preHandler` on all four.
  - Register in `server.ts` after `settingsRoutes`.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit: `feat(server): /api/settings/auth endpoints (get/put/test/rotate)`

---

## Phase F — Web

### Task F1: api-client methods + auth-state role

**Files:**

- Modify: `apps/web/src/lib/api-client.ts` (add `api.settings.auth.*`)
- Test: `apps/web/src/__tests__/api-client-auth-config.test.ts`

**Interfaces:**

- Produces: `api.settings.auth.get(): Promise<AuthConfigResponse>` (validated by `authConfigResponseSchema`), `.update(body)`, `.test(body): Promise<AuthConfigTestResult>`, `.rotateSigningSecret()`.

- [ ] **Step 1:** Failing test: `api.settings.auth.get()` validates the response through `authConfigResponseSchema` (mock fetch; a malformed response throws `RESPONSE_VALIDATION`).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Add the endpoints to the `api` object following the existing `settings` block pattern (schema-validated GET, plain PUT/POST). `test`/`rotate` return small typed results.
- [ ] **Step 4:** `PNPM --filter @lcm/web test -- api-client-auth-config && PNPM --filter @lcm/web typecheck` — PASS.
- [ ] **Step 5:** Commit: `feat(web): api-client methods for auth-config`

### Task F2: Authentication panel

**Files:**

- Create: `apps/web/src/components/settings/authentication-form.tsx`
- Modify: `apps/web/src/routes/_app.settings.tsx` (render it, admin-only)
- Test: `apps/web/src/components/settings/authentication-form.test.tsx`

**Interfaces:**

- Consumes: `api.settings.auth.*` (F1), auth state (`/api/auth/me` via the existing `useAuth`/route context — grep how `_app` exposes the user).

- [ ] **Step 1:** Failing tests (testing-library): (a) with an ADMIN user the panel renders and the clientSecret field shows "configured/Replace" when `clientSecretSet`; (b) with a VIEWER it does not render; (c) Test-connection success enables the "Enable authentication" toggle, failure keeps it disabled; (d) out-of-range `sessionTtlHours` is blocked before submit with a validation message.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Build `authentication-form.tsx`: `useQuery(['auth-config'], api.settings.auth.get)`; fields mirroring `AuthConfigResponse`; masked secret input; Test button (`useMutation` → `api.settings.auth.test`, shows result); status pill from `discoveryStatus`; redirect URI read-only + copy button; enable toggle gated on a successful test in-session; save `useMutation` → `api.settings.auth.update` with `onError` toast + `invalidateQueries(['auth-config'])`; client-side bounds mirroring `authConfigUpdateSchema` (1–99? no — ttl 1–720, scopes non-empty). Render in `_app.settings.tsx` gated on `user?.role === 'ADMIN' || authRequired === false` (determine the exact source of `user` in `_app` and follow it).
- [ ] **Step 4:** Run web tests + typecheck + `PNPM lint` — PASS.
- [ ] **Step 5:** Commit: `feat(web): admin-only Authentication settings panel`

---

## Phase G — Migration docs + integration

### Task G1: env/compose/docs

**Files:**

- Modify: `.env.example`, `docker/docker-compose.yml`, `docker/docker-compose.dev.yml` (Keycloak profile if present), `README.md`, `docs/operations.md` (or the auth runbook created by PR #116 — grep)

- [ ] **Step 1:** `.env.example`: add `CONFIG_ENCRYPTION_KEY=` (with a comment: generate via `openssl rand -base64 32`), note `RECOVERY_DISABLE_AUTH`; mark the OIDC vars as "seed-only (first boot); configure in the app's Settings → Authentication afterwards."
- [ ] **Step 2:** `docker-compose.yml` server env: add `CONFIG_ENCRYPTION_KEY: ${CONFIG_ENCRYPTION_KEY:?CONFIG_ENCRYPTION_KEY must be set}` (fail-closed like the DB password) and `RECOVERY_DISABLE_AUTH: ${RECOVERY_DISABLE_AUTH:-false}`. Keep the OIDC vars as optional pass-through for seeding.
- [ ] **Step 3:** README env table + operations runbook: document the Settings → Authentication flow, the one-time seed, key rotation caveat (losing the key means re-entering the client secret), and the `RECOVERY_DISABLE_AUTH` break-glass. Update the auth runbook's "configure OIDC" section to point at the UI.
- [ ] **Step 4:** `POSTGRES_PASSWORD=x CONFIG_ENCRYPTION_KEY=$(openssl rand -base64 32) docker compose -f docker/docker-compose.yml config >/dev/null` succeeds; without `CONFIG_ENCRYPTION_KEY` it fails closed.
- [ ] **Step 5:** Commit: `docs: configure OIDC via Settings; CONFIG_ENCRYPTION_KEY + recovery`

### Task G2: full-stack smoke

**Files:** none (verification)

- [ ] **Step 1:** `PNPM lint && PNPM typecheck && PNPM test && PNPM build` — all green.
- [ ] **Step 2:** Bring up the dev DB, migrate, seed; start `PNPM dev`. With `CONFIG_ENCRYPTION_KEY` set and no OIDC env, `GET /api/settings/auth` returns `mode:disabled`; `PUT` a bad issuer → 422 on enable; `POST /test` a bad issuer → `{ok:false}`; `GET` never leaks a secret. Tear down.
- [ ] **Step 3:** Commit any fixups: `test(server): full-stack auth-config smoke fixes` (only if needed).

---

## Phase H — Final verification

### Task H1: Full gate + whole-branch review

- [ ] **Step 1:** `PNPM lint && PNPM typecheck && PNPM test && PNPM build && PNPM audit --prod` — green, prod audit zero.
- [ ] **Step 2:** `git log --oneline main..HEAD` — each task ≈ one commit.
- [ ] **Step 3:** Dispatch the final whole-branch review (superpowers:requesting-code-review), paying special attention to: no secret ever returned/logged; the login-state HMAC change (tamper/rotation); the disabled-mode bootstrap window; every former `env.OIDC_*`/`env.AUTH_MODE` read is gone from auth code (grep to confirm).
- [ ] **Step 4:** Report: what shipped, deferred items, and the operator upgrade note (new required `CONFIG_ENCRYPTION_KEY`; OIDC now configured in Settings → Authentication).

## Explicitly deferred (do NOT implement)

- Per-tenant auth config (singleton only).
- Multiple IdPs / social login.
- KMS/secrets-manager integration.
- Route-level role enforcement (already deferred in PR #116).
