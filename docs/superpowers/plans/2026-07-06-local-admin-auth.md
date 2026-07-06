# Local Admin Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent username+password local admin account behind a new `local` auth mode (argon2id-hashed), coexisting with OIDC as a break-glass path.

**Architecture:** Reuse the existing `User`/`Session`/`AuthConfig` model and the `plugins/auth.ts` gate (which already treats *any* non-`disabled` mode as "session required"). Local accounts are `User` rows with `issuer='local'`, a new `passwordHash` column, and lockout bookkeeping. A new `LocalUserService` owns credential logic; new routes hang off the existing `routes/auth.ts` (login/password) and `routes/settings-auth.ts` (management), behind the existing admin gate. The `mode` enum widens to `disabled | local | oidc` across `@lcm/shared` and the server.

**Tech Stack:** Node 26, Fastify 5, Prisma 7, Zod 4, `@node-rs/argon2` (argon2id), React 19 + TanStack Router, Vitest + Testcontainers, Playwright.

## Global Constraints

- TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. No `any`, no `@ts-ignore`/`eslint-disable`, no skipped tests.
- Every API input/output validated with a `@lcm/shared` Zod schema, parsed **inside** the handler.
- Named exports only (no default exports). `camelCase` vars, `PascalCase` types/components. Prettier: single quotes, semicolons, width 100.
- Shared contracts live in `packages/shared/src/schemas`; derive TS types via `z.infer`. Contract-first.
- Prisma migrations only (`apps/server/prisma/migrations/`); never hand-edit SQL after generation. Server tests need Docker (Testcontainers).
- Secrets never logged or returned. Password hashes never appear in any response (`LocalUserSummary` only).
- Password hashing params (argon2id): `memoryCost: 19456` (KiB), `timeCost: 2`, `parallelism: 1`, `outputLen: 32`. Default algorithm is Argon2id.
- Lockout: `MAX_FAILED_ATTEMPTS = 5`; after that, `lockedUntil = now + min(15min, 2^(attempts-5) min)`. Reset counters on successful login.
- Password policy: min length 12, max 200. Username: 1–100 chars, `[A-Za-z0-9._-]`.
- Run after every change: `pnpm lint && pnpm typecheck && pnpm test`. After schema/route changes: `pnpm --filter @lcm/server exec prisma generate` and `pnpm --filter @lcm/web generate-routes`.
- Commit style: `type(scope): description` (scopes: `server`, `web`, `api`, `deps`, `docker`, `ci`; docs use `docs:` as type). End commit bodies with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

**Create**
- `packages/shared/src/schemas/auth-local.ts` — Zod contracts for local login + account management.
- `apps/server/src/crypto/password.ts` — argon2id `hashPassword`/`verifyPassword` (mirrors `crypto/secret-box.ts`).
- `apps/server/src/services/local-users.ts` — `LocalUserService` (create/verify/lockout/list/update/remove).
- `apps/server/src/__tests__/password.test.ts` — unit tests for the hashing helper.
- `apps/server/src/__tests__/local-users.test.ts` — integration tests for the service.
- `apps/server/src/__tests__/local-auth-routes.test.ts` — integration tests for login/password/me.
- `apps/web/src/components/settings/local-accounts-panel.tsx` — Settings → Authentication local-account management UI.
- `apps/web/src/components/settings/local-accounts-panel.test.tsx` — RTL tests.
- `apps/web/playwright/local-login.spec.ts` — `local`-mode golden-path E2E.

**Modify**
- `packages/shared/src/index.ts` — export `auth-local.js`.
- `packages/shared/src/schemas/auth.ts` — widen `authMeResponseSchema` with `loginMethods`.
- `packages/shared/src/schemas/auth-config.ts` — widen `mode` enum to include `local`.
- `apps/server/prisma/schema.prisma` — new `User` columns (+ migration).
- `apps/server/src/services/auth-config.ts` — widen `mode` types; `toEffective` maps `local`.
- `apps/server/src/services/users.ts` — no change expected (OIDC upsert stays); local logic lives in `local-users.ts`.
- `apps/server/src/routes/auth.ts` — `POST /auth/local/login`, `POST /auth/local/password`, `/auth/me` rewrite.
- `apps/server/src/routes/settings-auth.ts` — management routes + `local` transition guard.
- `apps/web/src/routes/login.tsx` — local login form.
- `apps/web/src/components/settings/authentication-form.tsx` — add `local` mode option + mount `LocalAccountsPanel`.
- `apps/web/src/lib/api-client.ts` (or the existing client module) — local login/password/management calls.
- `apps/server/package.json` — add `@node-rs/argon2`.
- `CLAUDE.md`, `docs/operations.md`, `docs/vision.md` — auth model docs.

---

## Task 1: Shared contracts — widen `mode`, add `loginMethods`, add `auth-local` schemas

**Files:**
- Modify: `packages/shared/src/schemas/auth-config.ts`
- Modify: `packages/shared/src/schemas/auth.ts`
- Create: `packages/shared/src/schemas/auth-local.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/schemas/__tests__/auth-local.test.ts` (create; mirror any existing shared test layout — if shared has no `__tests__`, colocate as `auth-local.test.ts` next to the schema)

**Interfaces:**
- Produces:
  - `mode` enum value `'local'` in `authConfigUpdateSchema`, `authConfigResponseSchema`, and `AuthConfigResponse['mode']`.
  - `authMeResponseSchema` gains `loginMethods?: { local: boolean; oidc: boolean }`.
  - `localLoginSchema` → `LocalLogin { username: string; password: string }`
  - `createLocalUserSchema` → `CreateLocalUser { username: string; password: string; role: 'ADMIN'|'VIEWER' }`
  - `updateLocalUserSchema` → `UpdateLocalUser { disabled?: boolean; role?: 'ADMIN'|'VIEWER' }`
  - `changePasswordSchema` → `ChangePassword { currentPassword: string; newPassword: string }`
  - `resetPasswordSchema` → `ResetPassword { newPassword: string }`
  - `localUserSummarySchema` → `LocalUserSummary { id, username, role, disabled, lastLoginAt: string|null, createdAt: string }`

- [ ] **Step 1: Write the failing test** — `packages/shared/src/schemas/__tests__/auth-local.test.ts`

```typescript
import { describe, expect, it } from 'vitest';

import {
  createLocalUserSchema,
  localLoginSchema,
  passwordSchema,
} from '../auth-local.js';

describe('auth-local schemas', () => {
  it('accepts a valid local login', () => {
    expect(localLoginSchema.parse({ username: 'admin', password: 'hunter2hunter2' })).toEqual({
      username: 'admin',
      password: 'hunter2hunter2',
    });
  });

  it('rejects a short password', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('twelvechars!!').success).toBe(true);
  });

  it('rejects usernames with illegal characters and defaults role to ADMIN', () => {
    expect(createLocalUserSchema.safeParse({ username: 'a b', password: 'twelvechars!!' }).success).toBe(false);
    const ok = createLocalUserSchema.parse({ username: 'ops.admin', password: 'twelvechars!!' });
    expect(ok.role).toBe('ADMIN');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @lcm/shared test -- auth-local`
Expected: FAIL — cannot resolve `../auth-local.js`.

- [ ] **Step 3: Create `packages/shared/src/schemas/auth-local.ts`**

```typescript
import { z } from 'zod';

export const localUsernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, 'Username may contain only letters, numbers, and . _ -');

/** Server-enforced password policy — length beats composition rules (OWASP). */
export const passwordSchema = z.string().min(12).max(200);

const roleSchema = z.enum(['ADMIN', 'VIEWER']);

export const localLoginSchema = z.strictObject({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});
export type LocalLogin = z.infer<typeof localLoginSchema>;

export const createLocalUserSchema = z.strictObject({
  username: localUsernameSchema,
  password: passwordSchema,
  role: roleSchema.default('ADMIN'),
});
export type CreateLocalUser = z.infer<typeof createLocalUserSchema>;

export const updateLocalUserSchema = z.strictObject({
  disabled: z.boolean().optional(),
  role: roleSchema.optional(),
});
export type UpdateLocalUser = z.infer<typeof updateLocalUserSchema>;

export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});
export type ChangePassword = z.infer<typeof changePasswordSchema>;

export const resetPasswordSchema = z.strictObject({ newPassword: passwordSchema });
export type ResetPassword = z.infer<typeof resetPasswordSchema>;

export const localUserSummarySchema = z.object({
  id: z.string(),
  username: z.string(),
  role: roleSchema,
  disabled: z.boolean(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});
export type LocalUserSummary = z.infer<typeof localUserSummarySchema>;
```

- [ ] **Step 4: Widen the `mode` enum** in `packages/shared/src/schemas/auth-config.ts`

Change every `z.enum(['disabled', 'oidc'])` (3 occurrences: `authConfigUpdateSchema.mode`, `AuthConfigResponse.mode` interface, `authConfigResponseSchema.mode`) to `z.enum(['disabled', 'local', 'oidc'])`, and the `AuthConfigResponse` interface field `mode: 'disabled' | 'oidc'` → `mode: 'disabled' | 'local' | 'oidc'`.

- [ ] **Step 5: Add `loginMethods` to `authMeResponseSchema`** in `packages/shared/src/schemas/auth.ts`

```typescript
export const loginMethodsSchema = z.object({ local: z.boolean(), oidc: z.boolean() });
export type LoginMethods = z.infer<typeof loginMethodsSchema>;

export const authMeResponseSchema = z.object({
  authRequired: z.boolean(),
  loginMethods: loginMethodsSchema.optional(),
  user: authUserSchema.optional(),
});
```

- [ ] **Step 6: Export the new module** — add to `packages/shared/src/index.ts`, immediately after the `./schemas/auth.js` line:

```typescript
export * from './schemas/auth-local.js';
```

- [ ] **Step 7: Run tests + typecheck**

Run: `pnpm --filter @lcm/shared test -- auth-local && pnpm --filter @lcm/shared build`
Expected: PASS; `@lcm/shared` builds (dist regenerated).

- [ ] **Step 8: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add local-auth contracts and widen mode enum"
```

---

## Task 2: Prisma schema — local-credential columns + migration

**Files:**
- Modify: `apps/server/prisma/schema.prisma:286-303` (the `User` model)
- Create: `apps/server/prisma/migrations/<timestamp>_add_local_admin_credentials/migration.sql` (generated)

**Interfaces:**
- Produces: `User.passwordHash`, `User.passwordUpdatedAt`, `User.failedLoginAttempts`, `User.lockedUntil`, `User.disabled` on the generated Prisma client.

- [ ] **Step 1: Edit the `User` model** — add these fields inside `model User { ... }` (after `lastLoginAt`):

```prisma
  passwordHash        String?   @map("password_hash")
  passwordUpdatedAt   DateTime? @map("password_updated_at")
  failedLoginAttempts Int       @default(0) @map("failed_login_attempts")
  lockedUntil         DateTime? @map("locked_until")
  disabled            Boolean   @default(false)
```

- [ ] **Step 2: Start the dev database** (needed for `migrate dev`)

Run: `pnpm db:dev:up`
Expected: `lcm-db-dev` healthy.

- [ ] **Step 3: Generate the migration + client**

Run: `pnpm --filter @lcm/server exec prisma migrate dev --name add_local_admin_credentials`
Expected: a new migration folder is created; client regenerated; command reports "migration applied".

- [ ] **Step 4: Verify the migration is additive** — open the generated `migration.sql` and confirm it is only `ALTER TABLE "users" ADD COLUMN ...` (no `DROP`, no `NOT NULL` without default on a populated table). Expected: five `ADD COLUMN` statements, all nullable or defaulted.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @lcm/server typecheck`
Expected: PASS (client types now include the new fields).

- [ ] **Step 6: Commit**

```bash
git add apps/server/prisma
git commit -m "feat(server): add local-credential columns to users"
```

---

## Task 3: argon2id password helper

**Files:**
- Modify: `apps/server/package.json` (add dependency)
- Create: `apps/server/src/crypto/password.ts`
- Test: `apps/server/src/__tests__/password.test.ts`

**Interfaces:**
- Consumes: `@node-rs/argon2` (`hash`, `verify`).
- Produces:
  - `hashPassword(plain: string): Promise<string>` — returns a self-contained argon2id PHC string.
  - `verifyPassword(hash: string, plain: string): Promise<boolean>` — never throws on a malformed hash (returns `false`).

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @lcm/server add @node-rs/argon2`
Then verify the native binary loads and no `pnpm-workspace.yaml` build allowlist change is needed (napi packages ship prebuilt `.node`, no build script):
Run: `node -e "const a=require('@node-rs/argon2'); a.hash('x').then(h=>a.verify(h,'x')).then(r=>{if(!r)process.exit(1);console.log('argon2 ok')})"`
Expected: prints `argon2 ok`.

- [ ] **Step 2: Write the failing test** — `apps/server/src/__tests__/password.test.ts`

```typescript
import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from '../crypto/password.js';

describe('password hashing', () => {
  it('round-trips a password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'wrong password entirely')).toBe(false);
  });

  it('produces a distinct hash each call (random salt)', async () => {
    const a = await hashPassword('same-password-value');
    const b = await hashPassword('same-password-value');
    expect(a).not.toEqual(b);
  });

  it('returns false for a malformed stored hash instead of throwing', async () => {
    expect(await verifyPassword('not-a-real-hash', 'whatever')).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @lcm/server test -- password`
Expected: FAIL — cannot resolve `../crypto/password.js`.

- [ ] **Step 4: Implement `apps/server/src/crypto/password.ts`**

```typescript
import { hash, verify } from '@node-rs/argon2';

/**
 * OWASP-tuned argon2id parameters. Encapsulated here so the algorithm and
 * cost can evolve in one place (mirrors crypto/secret-box.ts). @node-rs/argon2
 * defaults to Argon2id, so only the cost fields below need setting.
 */
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

/** Returns a self-contained argon2id PHC string (salt embedded). */
export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

/**
 * Constant-ish-time verify. Returns false (never throws) for a malformed or
 * empty stored hash, so callers can treat "no credential" and "wrong
 * credential" identically without special-casing.
 */
export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @lcm/server test -- password`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/package.json ../../pnpm-lock.yaml apps/server/src/crypto/password.ts apps/server/src/__tests__/password.test.ts
git commit -m "feat(server): add argon2id password hashing helper"
```

---

## Task 4: `LocalUserService`

**Files:**
- Create: `apps/server/src/services/local-users.ts`
- Test: `apps/server/src/__tests__/local-users.test.ts`

**Interfaces:**
- Consumes: `PrismaClient`, `hashPassword`/`verifyPassword` (Task 3), `LocalUserSummary` (Task 1).
- Produces:
  - `LOCAL_ISSUER = 'local'`, `MAX_FAILED_ATTEMPTS = 5`
  - `type VerifyLoginResult = { ok: true; user: User } | { ok: false }`
  - `class LocalUserService`:
    - `create(input: { username: string; password: string; role: UserRole }): Promise<User>`
    - `verifyLogin(username: string, password: string): Promise<VerifyLoginResult>`
    - `changeOwnPassword(userId: string, currentPassword: string, newPassword: string): Promise<boolean>`
    - `resetPassword(userId: string, newPassword: string): Promise<void>`
    - `list(): Promise<LocalUserSummary[]>`
    - `update(userId: string, input: { disabled?: boolean; role?: UserRole }): Promise<void>`
    - `remove(userId: string): Promise<void>`
    - `enabledAdminCount(): Promise<number>`
    - `enabledCount(): Promise<number>`

- [ ] **Step 1: Write the failing test** — `apps/server/src/__tests__/local-users.test.ts`

```typescript
import { describe, expect, it } from 'vitest';

import { LocalUserService, MAX_FAILED_ATTEMPTS } from '../services/local-users.js';
import { prisma } from './setup.js';

const svc = new LocalUserService(prisma);

describe('LocalUserService', () => {
  it('creates a local admin that can log in', async () => {
    await svc.create({ username: 'root', password: 'twelvecharsok!', role: 'ADMIN' });
    const result = await svc.verifyLogin('root', 'twelvecharsok!');
    expect(result.ok).toBe(true);
  });

  it('rejects a wrong password and, after the threshold, locks the account', async () => {
    await svc.create({ username: 'lockme', password: 'twelvecharsok!', role: 'ADMIN' });
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      expect((await svc.verifyLogin('lockme', 'wrong-password')).ok).toBe(false);
    }
    // Correct password now also fails: the account is locked.
    expect((await svc.verifyLogin('lockme', 'twelvecharsok!')).ok).toBe(false);
    const row = await prisma.user.findUniqueOrThrow({
      where: { issuer_subject: { issuer: 'local', subject: 'lockme' } },
    });
    expect(row.lockedUntil).not.toBeNull();
  });

  it('returns ok:false for an unknown user (no enumeration)', async () => {
    expect((await svc.verifyLogin('ghost', 'whatever-pass')).ok).toBe(false);
  });

  it('counts only enabled local admins', async () => {
    const before = await svc.enabledAdminCount();
    const u = await svc.create({ username: 'counted', password: 'twelvecharsok!', role: 'ADMIN' });
    expect(await svc.enabledAdminCount()).toBe(before + 1);
    await svc.update(u.id, { disabled: true });
    expect(await svc.enabledAdminCount()).toBe(before);
  });

  it('changes own password only with the correct current password', async () => {
    const u = await svc.create({ username: 'changer', password: 'twelvecharsok!', role: 'ADMIN' });
    expect(await svc.changeOwnPassword(u.id, 'nope-nope-nope', 'newtwelvechars!')).toBe(false);
    expect(await svc.changeOwnPassword(u.id, 'twelvecharsok!', 'newtwelvechars!')).toBe(true);
    expect((await svc.verifyLogin('changer', 'newtwelvechars!')).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @lcm/server test -- local-users`
Expected: FAIL — cannot resolve `../services/local-users.js`.

- [ ] **Step 3: Implement `apps/server/src/services/local-users.ts`**

```typescript
import type { PrismaClient, User, UserRole } from '@prisma/client';

import type { LocalUserSummary } from '@lcm/shared';

import { hashPassword, verifyPassword } from '../crypto/password.js';

export const LOCAL_ISSUER = 'local';
export const MAX_FAILED_ATTEMPTS = 5;
const MAX_LOCK_MINUTES = 15;

export type VerifyLoginResult = { ok: true; user: User } | { ok: false };

/** Minutes to lock after N total consecutive failures (exponential, capped). */
function lockMinutes(attempts: number): number {
  const over = attempts - MAX_FAILED_ATTEMPTS;
  if (over < 0) return 0;
  return Math.min(MAX_LOCK_MINUTES, 2 ** over);
}

export class LocalUserService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * A cached argon2id hash used to spend verify-time on unknown usernames so a
   * missing account is timing-indistinguishable from a wrong password. Lazily
   * computed once per process.
   */
  private dummyHash: Promise<string> | null = null;
  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hashPassword('unused-timing-equalizer');
    return this.dummyHash;
  }

  async create(input: { username: string; password: string; role: UserRole }): Promise<User> {
    const passwordHash = await hashPassword(input.password);
    return this.prisma.user.create({
      data: {
        issuer: LOCAL_ISSUER,
        subject: input.username,
        role: input.role,
        passwordHash,
        passwordUpdatedAt: new Date(),
      },
    });
  }

  async verifyLogin(username: string, password: string): Promise<VerifyLoginResult> {
    const user = await this.prisma.user.findUnique({
      where: { issuer_subject: { issuer: LOCAL_ISSUER, subject: username } },
    });

    if (!user || user.passwordHash === null || user.disabled) {
      await verifyPassword(await this.getDummyHash(), password); // equalize timing
      return { ok: false };
    }
    if (user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now()) {
      await verifyPassword(await this.getDummyHash(), password);
      return { ok: false };
    }

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) {
      const attempts = user.failedLoginAttempts + 1;
      const minutes = lockMinutes(attempts);
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: attempts,
          lockedUntil: minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null,
        },
      });
      return { ok: false };
    }

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    return { ok: true, user: updated };
  }

  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.passwordHash === null) return false;
    if (!(await verifyPassword(user.passwordHash, currentPassword))) return false;
    await this.setPassword(userId, newPassword);
    return true;
  }

  async resetPassword(userId: string, newPassword: string): Promise<void> {
    await this.setPassword(userId, newPassword);
  }

  private async setPassword(userId: string, newPassword: string): Promise<void> {
    const passwordHash = await hashPassword(newPassword);
    // Revoke all existing sessions on a password change/reset.
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          passwordUpdatedAt: new Date(),
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      }),
      this.prisma.session.deleteMany({ where: { userId } }),
    ]);
  }

  async list(): Promise<LocalUserSummary[]> {
    const rows = await this.prisma.user.findMany({
      where: { issuer: LOCAL_ISSUER },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((u) => ({
      id: u.id,
      username: u.subject,
      role: u.role,
      disabled: u.disabled,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
    }));
  }

  async update(userId: string, input: { disabled?: boolean; role?: UserRole }): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: input });
    if (input.disabled === true) {
      await this.prisma.session.deleteMany({ where: { userId } });
    }
  }

  async remove(userId: string): Promise<void> {
    await this.prisma.user.delete({ where: { id: userId } }); // sessions cascade
  }

  async enabledAdminCount(): Promise<number> {
    return this.prisma.user.count({
      where: { issuer: LOCAL_ISSUER, role: 'ADMIN', disabled: false, passwordHash: { not: null } },
    });
  }

  async enabledCount(): Promise<number> {
    return this.prisma.user.count({
      where: { issuer: LOCAL_ISSUER, disabled: false, passwordHash: { not: null } },
    });
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @lcm/server test -- local-users`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/local-users.ts apps/server/src/__tests__/local-users.test.ts
git commit -m "feat(server): add LocalUserService with lockout"
```

---

## Task 5: Widen `mode` in the auth-config service

**Files:**
- Modify: `apps/server/src/services/auth-config.ts` (`AuthConfigWriteData.mode`, `EffectiveAuthConfig.mode`, `toEffective`)

**Interfaces:**
- Produces: `EffectiveAuthConfig.mode` includes `'local'`; `toEffective` maps a stored `local` row to `mode: 'local'`.

- [ ] **Step 1: Write the failing test** — append to `apps/server/src/__tests__/auth-config.test.ts`

```typescript
it('maps a local-mode row to effective mode "local"', () => {
  const svc = new AuthConfigService(makeFakePrisma(), null);
  const row = { ...baseAuthConfigRow, mode: 'local' };
  expect(svc.toEffective(row).mode).toBe('local');
});
```
(Reuse whatever `baseAuthConfigRow`/imports the existing file already defines; if it has no such fixture, build a row literal matching the `AuthConfig` shape with `mode: 'local'`.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @lcm/server test -- auth-config`
Expected: FAIL — `toEffective` returns `'disabled'` for a `local` row.

- [ ] **Step 3: Widen the types + mapping** in `apps/server/src/services/auth-config.ts`

- `interface AuthConfigWriteData { mode: 'disabled' | 'local' | 'oidc'; ... }`
- `interface EffectiveAuthConfig { mode: 'disabled' | 'local' | 'oidc'; ... }`
- In `toEffective`, change:

```typescript
mode: row.mode === 'oidc' ? 'oidc' : row.mode === 'local' ? 'local' : 'disabled',
```

(The `update()` signing-secret regeneration stays gated on `input.mode === 'oidc'` only — `local` needs no OIDC secret and no encryption key.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @lcm/server test -- auth-config && pnpm --filter @lcm/server typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/auth-config.ts apps/server/src/__tests__/auth-config.test.ts
git commit -m "feat(server): support local mode in effective auth config"
```

---

## Task 6: Auth routes — local login, password change, `/auth/me`

**Files:**
- Modify: `apps/server/src/routes/auth.ts`
- Test: `apps/server/src/__tests__/local-auth-routes.test.ts`

**Interfaces:**
- Consumes: `LocalUserService` (Task 4), `SessionService`, `sessionCookieName`, `localLoginSchema`/`changePasswordSchema` (Task 1), `loginMethodsSchema`.
- Produces (HTTP):
  - `POST /api/auth/local/login` → 204 + session cookie on success; 401 `{ error: 'invalid_credentials' }` otherwise. Only active when `mode !== 'disabled'`.
  - `POST /api/auth/local/password` → 204 on success; 401 if unauthenticated; 422 `{ error: 'invalid_credentials' }` if current password is wrong.
  - `GET /api/auth/me` → `{ authRequired, loginMethods?, user? }` where `authRequired = mode !== 'disabled'`.

- [ ] **Step 1: Write the failing test** — `apps/server/src/__tests__/local-auth-routes.test.ts`

```typescript
import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';
import { LocalUserService } from '../services/local-users.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

/** A local-mode server: seed a local admin, then flip the singleton to local. */
async function localModeServer() {
  await new LocalUserService(prisma).create({
    username: 'admin',
    password: 'twelvecharsok!',
    role: 'ADMIN',
  });
  await prisma.authConfig.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', mode: 'local' },
    update: { mode: 'local' },
  });
  return buildServer({ env: makeTestEnv(), prisma });
}

describe('local auth routes', () => {
  const created: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    while (created.length) await created.pop()?.close();
  });

  it('logs in with correct credentials and sets a session cookie', async () => {
    const server = await localModeServer();
    created.push(server);
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/local/login',
      payload: { username: 'admin', password: 'twelvecharsok!' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('rejects a wrong password generically', async () => {
    const server = await localModeServer();
    created.push(server);
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/local/login',
      payload: { username: 'admin', password: 'wrong-password!' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('reports authRequired + local login method at /auth/me', async () => {
    const server = await localModeServer();
    created.push(server);
    const res = await server.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.json()).toMatchObject({ authRequired: true, loginMethods: { local: true, oidc: false } });
  });

  it('gates a protected mutation until logged in, then allows it', async () => {
    const server = await localModeServer();
    created.push(server);
    const denied = await server.inject({ method: 'GET', url: '/api/clusters' });
    expect(denied.statusCode).toBe(401);

    const login = await server.inject({
      method: 'POST',
      url: '/api/auth/local/login',
      payload: { username: 'admin', password: 'twelvecharsok!' },
    });
    const cookie = login.headers['set-cookie'];
    const allowed = await server.inject({
      method: 'GET',
      url: '/api/clusters',
      headers: { cookie: Array.isArray(cookie) ? cookie.join(';') : String(cookie) },
    });
    expect(allowed.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @lcm/server test -- local-auth-routes`
Expected: FAIL — `/api/auth/local/login` returns 404 and `/auth/me` returns `authRequired:false`.

- [ ] **Step 3: Implement in `apps/server/src/routes/auth.ts`**

At the top, add imports and construct the service:

```typescript
import { changePasswordSchema, localLoginSchema } from '@lcm/shared';
import { LocalUserService } from '../services/local-users.js';
```

Inside `authRoutes`, after `const users = new UserService(fastify.prisma);`:

```typescript
  const localUsers = new LocalUserService(fastify.prisma);

  const localSecure = (): boolean => {
    const base = cfg().appBaseUrl;
    return base ? base.startsWith('https://') : false;
  };
```

Add the login route (reuse the existing `authRateLimit`):

```typescript
  fastify.post('/auth/local/login', { config: authRateLimit }, async (request, reply) => {
    const current = cfg();
    if (current.mode === 'disabled') return reply.code(404).send();
    const body = localLoginSchema.parse(request.body);
    const result = await localUsers.verifyLogin(body.username, body.password);
    if (!result.ok) {
      request.log.warn({ username: body.username }, 'Local login failed');
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const session = await sessions.create(result.user.id, current.sessionTtlHours);
    const base = current.appBaseUrl;
    const secure = base ? base.startsWith('https://') : request.protocol === 'https';
    reply.setCookie(sessionCookieName(current), session.token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      expires: session.expiresAt,
    });
    return reply.code(204).send();
  });
```

Add the self-service password change (authenticated — `request.user` is set by the auth plugin in non-disabled modes):

```typescript
  fastify.post('/auth/local/password', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'unauthenticated' });
    const body = changePasswordSchema.parse(request.body);
    const ok = await localUsers.changeOwnPassword(
      request.user.id,
      body.currentPassword,
      body.newPassword,
    );
    if (!ok) return reply.code(422).send({ error: 'invalid_credentials' });
    return reply.code(204).send();
  });
```

Replace the `/auth/me` handler body:

```typescript
  fastify.get('/auth/me', async (request): Promise<AuthMeResponse> => {
    const current = cfg();
    if (current.mode === 'disabled') return { authRequired: false };
    const loginMethods = {
      local: (await localUsers.enabledCount()) > 0,
      oidc: current.mode === 'oidc' && fastify.oidc.config !== null,
    };
    const token = request.cookies[sessionCookieName(current)];
    const user = token === undefined ? null : await sessions.findUserByToken(token);
    if (!user) return { authRequired: true, loginMethods };
    return {
      authRequired: true,
      loginMethods,
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
    };
  });
```

Note: `localUsername`/`subject` is not part of `SessionUser`; `authUserSchema` stays `{ id, email, displayName, role }`. For a local user `email`/`displayName` are null — acceptable; the UI can fall back to role.

`unauthenticated`/`invalid_credentials` bodies are not secret and need no shared schema (they are opaque error markers), but if the reviewer prefers, add a `z.object({ error: z.string() })` in `auth-local.ts` and parse the client side.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @lcm/server test -- local-auth-routes`
Expected: PASS (4 tests).

- [ ] **Step 5: Full server suite + typecheck**

Run: `pnpm --filter @lcm/server typecheck && pnpm --filter @lcm/server test`
Expected: PASS (existing auth tests unaffected — `/auth/me` still returns `authRequired:false` in disabled mode).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/auth.ts apps/server/src/__tests__/local-auth-routes.test.ts
git commit -m "feat(server): add local login, password change, and mode-aware /auth/me"
```

---

## Task 7: Settings-auth — local account management + `local` transition guard

**Files:**
- Modify: `apps/server/src/routes/settings-auth.ts`
- Test: `apps/server/src/__tests__/settings-auth-routes.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `LocalUserService`, `createLocalUserSchema`/`updateLocalUserSchema`/`resetPasswordSchema`/`localUserSummarySchema` (Task 1).
- Produces (all admin-gated, under `/api/settings/auth`):
  - `GET /settings/auth/local-users` → `LocalUserSummary[]`
  - `POST /settings/auth/local-users` (`CreateLocalUser`) → 201 `LocalUserSummary`
  - `PATCH /settings/auth/local-users/:id` (`UpdateLocalUser`) → 204
  - `POST /settings/auth/local-users/:id/reset-password` (`ResetPassword`) → 204
  - `DELETE /settings/auth/local-users/:id` → 204
  - `PUT /settings/auth`: reject `mode: 'local'` unless `enabledAdminCount() > 0`; block disabling/deleting the last enabled admin while mode is `local`.

- [ ] **Step 1: Write the failing tests** — add to `apps/server/src/__tests__/settings-auth-routes.test.ts`

```typescript
it('creates and lists a local user', async () => {
  const server = await buildDisabledModeServer(); // helper already in this file (disabled = open admin gate)
  const create = await server.inject({
    method: 'POST',
    url: '/api/settings/auth/local-users',
    payload: { username: 'newadmin', password: 'twelvecharsok!', role: 'ADMIN' },
  });
  expect(create.statusCode).toBe(201);
  expect(create.json()).toMatchObject({ username: 'newadmin', role: 'ADMIN', disabled: false });

  const list = await server.inject({ method: 'GET', url: '/api/settings/auth/local-users' });
  expect(list.json().map((u: { username: string }) => u.username)).toContain('newadmin');
});

it('refuses to switch to local mode with no enabled local admin', async () => {
  const server = await buildDisabledModeServer();
  const res = await server.inject({
    method: 'PUT',
    url: '/api/settings/auth',
    payload: { mode: 'local', scopes: 'openid profile email', defaultRole: 'admin', sessionTtlHours: 12, allowInsecure: false },
  });
  expect(res.statusCode).toBe(422);
  expect(res.json().error).toBe('NO_LOCAL_ADMIN');
});
```
(Match the existing file's server-build helper name and cleanup pattern; if it builds servers inline, follow that. The `PUT` payload mirrors `authConfigUpdateSchema` defaults.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @lcm/server test -- settings-auth-routes`
Expected: FAIL — the local-users routes 404 and the guard is absent.

- [ ] **Step 3: Implement in `apps/server/src/routes/settings-auth.ts`**

Add imports:

```typescript
import {
  createLocalUserSchema,
  resetPasswordSchema,
  updateLocalUserSchema,
} from '@lcm/shared';
import type { LocalUserSummary } from '@lcm/shared';
import { LocalUserService } from '../services/local-users.js';
import { NotFoundError } from '../services/errors.js';
```
(Confirm `NotFoundError` exists in `services/errors.ts`; the codebase already exports `ForbiddenError`/`UnprocessableError` from there — reuse the matching not-found error, or `UnprocessableError` if none exists.)

Inside the plugin, after `const service = fastify.authConfig.service;`:

```typescript
  const localUsers = new LocalUserService(fastify.prisma);
```

Add the `local` guard inside the existing `PUT /settings/auth` handler, before `await service.update(...)`. Insert right after the existing `if (body.mode === 'oidc') { ... }` block:

```typescript
    if (body.mode === 'local' && (await localUsers.enabledAdminCount()) === 0) {
      throw new UnprocessableError(
        'NO_LOCAL_ADMIN',
        'Create an enabled local admin account before switching to local authentication.',
      );
    }
```

Add the management routes (all inside the plugin body — the file's `preHandler` admin gate already covers them):

```typescript
  fastify.get('/settings/auth/local-users', async (): Promise<LocalUserSummary[]> => {
    return localUsers.list();
  });

  fastify.post('/settings/auth/local-users', async (request, reply): Promise<LocalUserSummary> => {
    const body = createLocalUserSchema.parse(request.body);
    const existing = await fastify.prisma.user.findUnique({
      where: { issuer_subject: { issuer: 'local', subject: body.username } },
    });
    if (existing) {
      throw new UnprocessableError('USERNAME_TAKEN', 'That username is already in use.');
    }
    const user = await localUsers.create(body);
    reply.code(201);
    return {
      id: user.id,
      username: user.subject,
      role: user.role,
      disabled: user.disabled,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    };
  });

  fastify.patch('/settings/auth/local-users/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateLocalUserSchema.parse(request.body);
    // Guard: never leave local mode with zero enabled admins.
    if ((body.disabled === true || body.role === 'VIEWER') && fastify.authConfig.current.mode === 'local') {
      const target = await fastify.prisma.user.findUnique({ where: { id } });
      if (target && target.issuer === 'local' && target.role === 'ADMIN' && !target.disabled) {
        if ((await localUsers.enabledAdminCount()) <= 1) {
          throw new UnprocessableError(
            'LAST_LOCAL_ADMIN',
            'Cannot disable or demote the last enabled local admin while local authentication is active.',
          );
        }
      }
    }
    await localUsers.update(id, body);
    return reply.code(204).send();
  });

  fastify.post('/settings/auth/local-users/:id/reset-password', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = resetPasswordSchema.parse(request.body);
    await localUsers.resetPassword(id, body.newPassword);
    return reply.code(204).send();
  });

  fastify.delete('/settings/auth/local-users/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const target = await fastify.prisma.user.findUnique({ where: { id } });
    if (
      target?.issuer === 'local' &&
      target.role === 'ADMIN' &&
      !target.disabled &&
      fastify.authConfig.current.mode === 'local' &&
      (await localUsers.enabledAdminCount()) <= 1
    ) {
      throw new UnprocessableError(
        'LAST_LOCAL_ADMIN',
        'Cannot delete the last enabled local admin while local authentication is active.',
      );
    }
    await localUsers.remove(id);
    return reply.code(204).send();
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @lcm/server test -- settings-auth-routes`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/settings-auth.ts apps/server/src/__tests__/settings-auth-routes.test.ts
git commit -m "feat(server): manage local accounts and guard local-mode transitions"
```

---

## Task 8: Web — API client + login form

**Files:**
- Modify: `apps/web/src/lib/api-client.ts` (or the module that wraps `fetch` for `/api`; grep for `/api/settings/auth` to find it)
- Modify: `apps/web/src/routes/login.tsx`
- Test: extend `apps/web/src/routes/__tests__/login-href.test.ts` or add `apps/web/src/routes/__tests__/login-local.test.tsx`

**Interfaces:**
- Consumes: `authMeResponseSchema.loginMethods` (Task 1), `POST /api/auth/local/login` (Task 6).
- Produces: `localLogin(username, password): Promise<boolean>` client fn; `login.tsx` renders a username/password form when `loginMethods.local` is true.

- [ ] **Step 1: Add the client function** — in the api-client module:

```typescript
export async function localLogin(username: string, password: string): Promise<boolean> {
  const res = await fetch('/api/auth/local/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return res.status === 204;
}
```

- [ ] **Step 2: Write the failing test** — `apps/web/src/routes/__tests__/login-local.test.tsx`

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LocalLoginForm } from '../login.js';

describe('LocalLoginForm', () => {
  it('renders username and password inputs', () => {
    render(<LocalLoginForm redirect={undefined} />);
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @lcm/web test -- login-local`
Expected: FAIL — `LocalLoginForm` is not exported.

- [ ] **Step 4: Implement the local form in `apps/web/src/routes/login.tsx`**

Export a `LocalLoginForm` component and render it when `context.auth.loginMethods?.local` is true. Keep the existing OIDC `<Button asChild><a href={loginHref}>` and show it when `loginMethods?.oidc` is true (or as the sole option in pure oidc mode). Full component:

```tsx
import { useState } from 'react';
import { useRouter } from '@tanstack/react-router';

import { localLogin } from '@/lib/api-client';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function LocalLoginForm({ redirect }: { redirect: string | undefined }): React.JSX.Element {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setPending(true);
    setError(null);
    const ok = await localLogin(username, password);
    setPending(false);
    if (!ok) {
      setError('Invalid username or password.');
      return;
    }
    await router.invalidate();
    await router.navigate({ to: redirect ?? '/' });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {error ? (
        <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor="username">Username</Label>
        <Input id="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
      </div>
      <div className="space-y-1">
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
```

In `LoginPage`, read `loginMethods` from route context (`Route.useRouteContext()` / the `context.auth` used in `beforeLoad`) and render `<LocalLoginForm>` when `local` is true, the OIDC button when `oidc` is true. Verify `Input`/`Label` exist under `@/components/ui/` (grep first; if `Label` is absent, use a plain `<label>` with the same `htmlFor`).

- [ ] **Step 5: Run to verify it passes + regenerate routes**

Run: `pnpm --filter @lcm/web generate-routes && pnpm --filter @lcm/web test -- login`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/login.tsx apps/web/src/lib apps/web/src/routes/__tests__
git commit -m "feat(web): local admin login form"
```

---

## Task 9: Web — Settings local-accounts panel

**Files:**
- Create: `apps/web/src/components/settings/local-accounts-panel.tsx`
- Test: `apps/web/src/components/settings/local-accounts-panel.test.tsx`
- Modify: `apps/web/src/components/settings/authentication-form.tsx`

**Interfaces:**
- Consumes: local-user management endpoints (Task 7); `LocalUserSummary`.
- Produces: `LocalAccountsPanel` (list + create form + disable/reset/delete actions); a `local` option in the mode selector.

- [ ] **Step 1: Add management client functions** — in the api-client module:

```typescript
import { localUserSummarySchema, type LocalUserSummary } from '@lcm/shared';
import { z } from 'zod';

export async function listLocalUsers(): Promise<LocalUserSummary[]> {
  const res = await fetch('/api/settings/auth/local-users', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Failed to load local users');
  return z.array(localUserSummarySchema).parse(await res.json());
}

export async function createLocalUser(input: { username: string; password: string; role: 'ADMIN' | 'VIEWER' }): Promise<void> {
  const res = await fetch('/api/settings/auth/local-users', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? 'Failed to create user');
}

export async function deleteLocalUser(id: string): Promise<void> {
  const res = await fetch(`/api/settings/auth/local-users/${id}`, { method: 'DELETE', credentials: 'same-origin' });
  if (!res.ok) throw new Error('Failed to delete user');
}
```
(Add `setLocalUserDisabled`/`resetLocalUserPassword` the same way, matching the PATCH/reset endpoints.)

- [ ] **Step 2: Write the failing test** — `local-accounts-panel.test.tsx`

```tsx
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({
  listLocalUsers: vi.fn().mockResolvedValue([
    { id: '1', username: 'admin', role: 'ADMIN', disabled: false, lastLoginAt: null, createdAt: '2026-07-06T00:00:00.000Z' },
  ]),
  createLocalUser: vi.fn(),
  deleteLocalUser: vi.fn(),
}));

import { LocalAccountsPanel } from './local-accounts-panel.js';

it('lists existing local accounts', async () => {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <LocalAccountsPanel />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('admin')).toBeInTheDocument();
});
```
(Match the exact TanStack Query test wrapper the other settings tests use — grep `QueryClientProvider` in `apps/web/src` for the shared helper.)

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @lcm/web test -- local-accounts-panel`
Expected: FAIL — component missing.

- [ ] **Step 4: Implement `LocalAccountsPanel`** — a `useQuery(['local-users'], listLocalUsers)` list rendered in the existing settings card style (Radix + tokens, `Skeleton` while loading, `EmptyState` when none), a create form (username/password/role) using `useMutation` + `sonner` toast + query invalidation, and per-row Disable/Reset/Delete actions. One primary exported component per file. Follow the structure of the sibling `authentication-form.tsx` for card/section markup so it reads as one system.

- [ ] **Step 5: Wire into `authentication-form.tsx`**

1. Add a `local` option to the mode `<Select>` (the enum-driven mode picker) — a `<SelectItem value="local">Local accounts</SelectItem>` alongside the existing `disabled`/`oidc` items, with a one-line description matching the surrounding copy.
2. Render `<LocalAccountsPanel />` when the selected/active mode is `local` (and optionally as a collapsible "Local admin (break-glass)" section when mode is `oidc`).
Read the file first to match its existing form-state and section conventions; keep the OIDC fields untouched.

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm --filter @lcm/web test -- 'local-accounts-panel|authentication-form' && pnpm --filter @lcm/web typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/settings apps/web/src/lib
git commit -m "feat(web): manage local accounts in Settings"
```

---

## Task 10: E2E golden path + build smoke test

**Files:**
- Create: `apps/web/playwright/local-login.spec.ts`
- (Verification only) the built server image can load argon2.

**Interfaces:**
- Consumes: the full stack (assumes the `pnpm dev` stack, per the existing Playwright config).

- [ ] **Step 1: Write the E2E spec** — mirror the existing `apps/web/playwright/*.spec.ts` setup/fixtures:

```typescript
import { expect, test } from '@playwright/test';

// Assumes a fresh dev DB in disabled mode. Creates a local admin via the API,
// switches to local mode, then drives the login UI.
test('local admin can sign in and reach the dashboard', async ({ page, request }) => {
  await request.post('/api/settings/auth/local-users', {
    data: { username: 'e2e-admin', password: 'twelvecharsok!', role: 'ADMIN' },
  });
  await request.put('/api/settings/auth', {
    data: { mode: 'local', scopes: 'openid profile email', defaultRole: 'admin', sessionTtlHours: 12, allowInsecure: false },
  });

  await page.goto('/login');
  await page.getByLabel(/username/i).fill('e2e-admin');
  await page.getByLabel(/password/i).fill('twelvecharsok!');
  await page.getByRole('button', { name: /sign in/i }).click();

  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading')).toBeVisible();

  // Reset to disabled so the suite is idempotent for the next run.
  await request.put('/api/settings/auth', {
    data: { mode: 'disabled', scopes: 'openid profile email', defaultRole: 'admin', sessionTtlHours: 12, allowInsecure: false },
  });
});
```
(Adjust the base URL / storage-state handling to whatever `playwright.config.ts` already establishes; if that config gates on OIDC, add a `local`-mode project or reuse its `webServer`.)

- [ ] **Step 2: Run the E2E**

Run: `pnpm --filter @lcm/web test:e2e -- local-login`
Expected: PASS (dev stack running).

- [ ] **Step 3: Build the server image and smoke-test argon2 in the distroless runtime**

Run:
```bash
docker build -f docker/Dockerfile.server -t lcm-server:argon2-smoke .
docker run --rm --entrypoint node lcm-server:argon2-smoke \
  -e "require('@node-rs/argon2').hash('x').then(h=>require('@node-rs/argon2').verify(h,'x')).then(r=>{if(!r)process.exit(1);console.log('argon2 ok in distroless')}).catch(e=>{console.error(e);process.exit(1)})"
```
Expected: prints `argon2 ok in distroless`. If it fails to find the native module, the `@node-rs/argon2-linux-*-musl` optional dep was not carried into the `pnpm deploy` bundle — fix by ensuring the optional platform dep installs in the builder (it should, since builder + runtime share arch+musl) before proceeding.

- [ ] **Step 4: Commit**

```bash
git add apps/web/playwright/local-login.spec.ts
git commit -m "test(web): local-mode login e2e golden path"
```

---

## Task 11: Documentation

**Files:**
- Modify: `CLAUDE.md` (the "OIDC only / no bcrypt/argon2" line + the two-mode description)
- Modify: `docs/operations.md` (auth modes, bootstrap, recovery)
- Modify: `docs/vision.md` (if it states an OIDC-only auth stance)

- [ ] **Step 1: Update `CLAUDE.md`** — revise the Authentication bullet: modes are now `disabled` / `local` / `oidc`; local accounts use argon2id (`@node-rs/argon2`); replace "there are no local passwords, so no bcrypt/argon2" with the new reality (argon2id for local accounts; still no bcrypt).

- [ ] **Step 2: Update `docs/operations.md`** — add a "Local admin accounts" section: create the first admin in `disabled` mode via Settings → Authentication, switch to `local`, the break-glass role of local login in `oidc` mode, and lockout recovery via `RECOVERY_DISABLE_AUTH=true` + restart.

- [ ] **Step 3: Update `docs/vision.md`** — reconcile any OIDC-only statement (grep for "OIDC only").

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/operations.md docs/vision.md
git commit -m "docs: document the local admin auth mode"
```

---

## Task 12: Full verification

- [ ] **Step 1: Regenerate artifacts**

Run: `pnpm --filter @lcm/server exec prisma generate && pnpm --filter @lcm/web generate-routes`

- [ ] **Step 2: Full gate**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green (server suite needs Docker).

- [ ] **Step 3: Open a PR**

```bash
git push -u origin feat/local-admin-auth
gh pr create --base main --title "feat: local admin account (local auth mode)" --body "Closes #<issue-if-any>. Adds a persistent username+password local admin behind a new 'local' auth mode (argon2id), coexisting with OIDC as break-glass. See docs/superpowers/specs/2026-07-06-local-admin-auth-design.md."
```

---

## Self-Review notes (author checklist — completed)

- **Spec coverage:** modes (Task 1,5,7) · data model (Task 2) · argon2id (Task 3) · service+lockout (Task 4) · endpoints (Task 6,7) · brute-force (Task 4 lockout + Task 6 reuse of `authRateLimit`) · frontend (Task 8,9) · shared contracts (Task 1) · bootstrap+recovery (Task 7 guard + Task 11 docs) · security/no-enumeration (Task 4,6) · testing (every task + Task 10) · migration/rollback (Task 2) · docs (Task 11). Spec §14 open items (argon2-in-distroless, Secure cookie in local mode) handled by Task 10 Step 3 and Task 6's `secure` derivation.
- **Type consistency:** `verifyLogin` returns `VerifyLoginResult` everywhere; `LocalUserSummary` shape identical in schema (Task 1), service (Task 4), and routes (Task 7); `loginMethods` shape identical in schema (Task 1) and `/auth/me` (Task 6).
- **Known integration points to confirm at execution time (grep, don't assume):** the api-client module path; `NotFoundError`/`UnprocessableError` exports in `services/errors.ts`; `Input`/`Label` under `@/components/ui/`; the settings-auth test file's server-build helper; the Playwright config's `webServer`/base URL.
