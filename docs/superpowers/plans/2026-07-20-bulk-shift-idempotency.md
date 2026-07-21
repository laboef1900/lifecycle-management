# Bulk-Shift Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /api/items/bulk-shift-dates` safe to retry by adding a general, client-supplied idempotency-key mechanism (issue [#263](https://github.com/laboef1900/lifecycle-management/issues/263)).

**Architecture:** A new `idempotency_keys` Postgres table plus a `TenantSettings.idempotencyKeyRetentionHours` column (Prisma migration). A small `IdempotencyService` runs `lookup`/`record` inside the caller's existing transaction; `ItemsService.bulkShiftDates` is the first (and only, for now) consumer. The client sends a normalized-payload-independent UUID via an `Idempotency-Key` header; the web dialog generates one per dialog-open via a secure-context-independent helper. A simple in-process `setInterval` sweep purges expired rows — no claim/lease needed, since a plain `DELETE ... WHERE expires_at < now()` is naturally safe to run concurrently.

**Tech Stack:** Fastify 5 route/service layers, Prisma 7 (pg driver adapter), Zod 4 shared schemas (`@lcm/shared`), React 19 + TanStack Query on the web side, Vitest + Testcontainers for server integration tests, Vitest + RTL for web.

**Design doc:** `docs/superpowers/specs/2026-07-20-bulk-shift-idempotency-design.md` — read it first; this plan implements it exactly, plus two decisions made during planning that the design doc didn't cover (both recorded below):

- **Retention bounds:** the design doc left the valid range for `idempotencyKeyRetentionHours` unspecified. This plan sets it to **1–168 hours** (1 hour to 7 days), mirroring `procurementLeadTimeWeeksSchema`'s own bounded-integer style. 24 remains the default.
- **Client-side UUID generation:** `crypto.randomUUID()` is spec'd as secure-context-only (HTTPS/localhost). This app's CLAUDE.md documents that production deliberately serves plain HTTP internally (HSTS off) — so `crypto.randomUUID` could be `undefined` there, silently breaking every bulk-shift submission. The web client instead generates its own RFC 4122 v4 UUID via `crypto.getRandomValues()`, which carries no secure-context restriction.

## Global Constraints

- TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` — no `any`, no suppression comments.
- Every API input/output is validated with a Zod schema from `@lcm/shared`, parsed inside the route handler.
- Server integration tests: Vitest + Testcontainers, centralized in `apps/server/src/__tests__/`, using `factories.ts` helpers and `prisma`/`makeTestEnv` from `test-helpers.ts`/`setup.ts`.
- Web tests: Vitest + React Testing Library, colocated with the component.
- Prisma migrations only — never hand-edit the schema via raw SQL; `prisma migrate dev` generates the migration file, `prisma migrate deploy` (the container entrypoint) applies it in every environment.
- Named exports, `camelCase` variables/functions, `PascalCase` types/components, single quotes/semicolons/width 100 (Prettier via lint-staged — don't fight it).
- Run `pnpm lint && pnpm typecheck && pnpm test` (server tests need the dev Postgres container: `pnpm db:dev:up`) at every checkpoint below.

---

## Setup: worktree and branch

Do this once, before Task 1. Per CLAUDE.md's Git Workflow, this work happens on a feature branch off `dev`, in a separate worktree — never checked out directly in the main working directory.

```bash
git fetch origin
git worktree add ../263-bulk-shift-idempotency -b feat/263-bulk-shift-idempotency origin/dev
cd ../263-bulk-shift-idempotency
pnpm install
pnpm db:dev:up
```

All subsequent commands in this plan assume the working directory is this worktree.

---

### Task 1: Shared schema — idempotency header, error code, retention setting

**Files:**

- Create: `packages/shared/src/schemas/idempotency.ts`
- Create: `packages/shared/src/schemas/__tests__/idempotency.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/shared/src/schemas/settings.ts`
- Modify: `packages/shared/src/schemas/responses.ts`
- Modify: `packages/shared/src/schemas/__tests__/settings.test.ts`

**Interfaces:**

- Produces: `idempotencyKeyHeaderSchema: z.ZodString` (validates a UUID string), `idempotencyKeyRetentionHoursSchema: z.ZodNumber` (integer, 1–168), `TenantSettings` type gains `idempotencyKeyRetentionHours: number`, `SERVICE_ERROR_CODES` gains `'IDEMPOTENCY_KEY_CONFLICT'`.

- [ ] **Step 1: Write the failing test for the new header schema**

Create `packages/shared/src/schemas/__tests__/idempotency.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { idempotencyKeyHeaderSchema } from '../idempotency.js';

describe('idempotencyKeyHeaderSchema', () => {
  it('accepts a v4 UUID string', () => {
    expect(idempotencyKeyHeaderSchema.parse('550e8400-e29b-41d4-a716-446655440000')).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
  });

  it('rejects a non-UUID string', () => {
    expect(() => idempotencyKeyHeaderSchema.parse('not-a-uuid')).toThrow();
  });

  it('rejects undefined (missing header)', () => {
    expect(() => idempotencyKeyHeaderSchema.parse(undefined)).toThrow();
  });

  it('rejects an array (duplicate header)', () => {
    expect(() => idempotencyKeyHeaderSchema.parse(['a', 'b'])).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lcm/shared test -- idempotency.test.ts`
Expected: FAIL — cannot find module `../idempotency.js`

- [ ] **Step 3: Create the schema**

Create `packages/shared/src/schemas/idempotency.ts`:

```ts
import { z } from 'zod';

/**
 * Client-supplied idempotency key for a mutating request that must be safe to
 * retry: a UUID v4 minted once per user action and reused across retries of
 * that SAME action (never across a genuinely new one). Sent as the
 * `Idempotency-Key` request header, never a body field — it describes the
 * request's delivery, not its domain payload, so it stays out of every
 * mutating endpoint's own Zod input schema.
 */
export const idempotencyKeyHeaderSchema = z.string().uuid();
```

- [ ] **Step 4: Export it from the package index**

In `packages/shared/src/index.ts` (the file is grouped by domain, not strictly alphabetical — this new export just needs to be somewhere in the `schemas/*` group), add a line right after `export * from './schemas/host-replacement.js';` and before `export * from './schemas/item.js';`:

```ts
export * from './schemas/idempotency.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @lcm/shared test -- idempotency.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Add the service error code**

In `packages/shared/src/errors.ts`, insert `'IDEMPOTENCY_KEY_CONFLICT'` into `SERVICE_ERROR_CODES` alphabetically, right after `'HOST_NOT_FOUND'`:

```ts
  'FORBIDDEN',
  'HOST_NOT_FOUND',
  'IDEMPOTENCY_KEY_CONFLICT',
  'INCOMPLETE_OIDC_CONFIG',
```

- [ ] **Step 7: Write the failing test for the retention-hours bound**

In `packages/shared/src/schemas/__tests__/settings.test.ts`, add a new `describe` block after the existing `tenantSettingsSchema` block (after its closing `});` on the line following the `procurementLeadTimeWeeks outside 0..104` test):

```ts
describe('tenantSettingsSchema — idempotencyKeyRetentionHours', () => {
  const base = { warnThreshold: 0.7, critThreshold: 0.9, procurementLeadTimeWeeks: 8 };

  it('accepts the default of 24', () => {
    expect(tenantSettingsSchema.parse({ ...base, idempotencyKeyRetentionHours: 24 })).toMatchObject(
      { idempotencyKeyRetentionHours: 24 },
    );
  });

  it('accepts the 1 and 168 boundaries', () => {
    expect(tenantSettingsSchema.parse({ ...base, idempotencyKeyRetentionHours: 1 })).toMatchObject({
      idempotencyKeyRetentionHours: 1,
    });
    expect(
      tenantSettingsSchema.parse({ ...base, idempotencyKeyRetentionHours: 168 }),
    ).toMatchObject({ idempotencyKeyRetentionHours: 168 });
  });

  it('rejects 0 and 169', () => {
    expect(() =>
      tenantSettingsSchema.parse({ ...base, idempotencyKeyRetentionHours: 0 }),
    ).toThrow();
    expect(() =>
      tenantSettingsSchema.parse({ ...base, idempotencyKeyRetentionHours: 169 }),
    ).toThrow();
  });

  it('rejects a non-integer', () => {
    expect(() =>
      tenantSettingsSchema.parse({ ...base, idempotencyKeyRetentionHours: 4.5 }),
    ).toThrow();
  });

  it('rejects a missing value', () => {
    expect(() => tenantSettingsSchema.parse(base)).toThrow();
  });
});
```

Also update every existing `tenantSettingsSchema.parse({...})` call earlier in this same file (the "accepts warn < crit", "rejects warn === crit", "rejects warn > crit", and "rejects procurementLeadTimeWeeks outside 0..104" tests) to include `idempotencyKeyRetentionHours: 24` in both the input object and the expected `toEqual` object, since `tenantSettingsSchema` is a `strictObject` and will now reject/mismatch objects missing the field. For example, the first test becomes:

```ts
it('accepts warn < crit', () => {
  expect(
    tenantSettingsSchema.parse({
      warnThreshold: 0.7,
      critThreshold: 0.9,
      procurementLeadTimeWeeks: 8,
      idempotencyKeyRetentionHours: 24,
    }),
  ).toEqual({
    warnThreshold: 0.7,
    critThreshold: 0.9,
    procurementLeadTimeWeeks: 8,
    idempotencyKeyRetentionHours: 24,
  });
});
```

Apply the same `idempotencyKeyRetentionHours: 24` addition to the "rejects warn === crit", "rejects warn > crit", and both "rejects procurementLeadTimeWeeks outside 0..104" `parse` calls (those only need the input object updated, not a `toEqual`, since they assert `.toThrow()`).

- [ ] **Step 8: Run test to verify it fails**

Run: `pnpm --filter @lcm/shared test -- settings.test.ts`
Expected: FAIL — `idempotencyKeyRetentionHours` not recognized by `tenantSettingsSchema` (strictObject rejects the extra key), and the new `describe` block's tests fail because the field doesn't exist yet.

- [ ] **Step 9: Add the schema field**

In `packages/shared/src/schemas/settings.ts`, add the bounded-integer schema after `procurementLeadTimeWeeksSchema` and wire it into `tenantSettingsSchema`:

```ts
export const percentSchema = z.number().min(0.01).max(0.99);

export const procurementLeadTimeWeeksSchema = z.number().int().min(0).max(104);

/**
 * How long a stored idempotency-key record survives before cleanup — also the
 * bound on how stale a replayed response may be, since one TTL serves both
 * purposes (design doc §Invariants). 1–168h (1 hour to 7 days); 24 is the
 * default, matching the DB column's own default.
 */
export const idempotencyKeyRetentionHoursSchema = z.number().int().min(1).max(168);

export const tenantSettingsSchema = z
  .strictObject({
    warnThreshold: percentSchema,
    critThreshold: percentSchema,
    procurementLeadTimeWeeks: procurementLeadTimeWeeksSchema,
    idempotencyKeyRetentionHours: idempotencyKeyRetentionHoursSchema,
  })
  .refine((s) => s.warnThreshold < s.critThreshold, {
    message: 'warnThreshold must be less than critThreshold',
    path: ['warnThreshold'],
  });
```

- [ ] **Step 10: Update the response schema**

In `packages/shared/src/schemas/responses.ts`, update the value import from `./settings.js` (the one already pulling in `effectiveThresholdsSchema`/`percentSchema`/`procurementLeadTimeWeeksSchema`, distinct from the `import type { TenantSettings } from './settings.js';` line directly below it):

```ts
import {
  effectiveThresholdsSchema,
  idempotencyKeyRetentionHoursSchema,
  percentSchema,
  procurementLeadTimeWeeksSchema,
} from './settings.js';
import type { TenantSettings } from './settings.js';
```

Then add the field to `tenantSettingsResponseSchema`:

```ts
export const tenantSettingsResponseSchema: z.ZodType<TenantSettings> = z.object({
  warnThreshold: percentSchema,
  critThreshold: percentSchema,
  procurementLeadTimeWeeks: procurementLeadTimeWeeksSchema,
  idempotencyKeyRetentionHours: idempotencyKeyRetentionHoursSchema,
});
```

(Check the existing import line at the top of `responses.ts` that pulls `percentSchema`/`procurementLeadTimeWeeksSchema` from `./settings.js` and add `idempotencyKeyRetentionHoursSchema` to that same import list.)

- [ ] **Step 11: Run tests to verify they pass**

Run: `pnpm --filter @lcm/shared test`
Expected: PASS (all shared-package tests, including the updated `settings.test.ts` and new `idempotency.test.ts`)

- [ ] **Step 12: Typecheck and build the shared package**

Run: `pnpm --filter @lcm/shared typecheck && pnpm --filter @lcm/shared build`
Expected: no errors. (Server and web resolve `@lcm/shared` via its built `dist/`, per issue #265 — this rebuild is required before Task 2+ code that imports the new exports will typecheck.)

- [ ] **Step 13: Commit**

```bash
git add packages/shared/src/schemas/idempotency.ts packages/shared/src/schemas/__tests__/idempotency.test.ts packages/shared/src/index.ts packages/shared/src/errors.ts packages/shared/src/schemas/settings.ts packages/shared/src/schemas/responses.ts packages/shared/src/schemas/__tests__/settings.test.ts
git commit -m "feat(shared): add idempotency-key header schema and retention setting"
```

---

### Task 2: Prisma migration — `idempotency_keys` table and `TenantSettings` column

**Files:**

- Modify: `apps/server/prisma/schema.prisma`
- Create: `apps/server/prisma/migrations/<timestamp>_add_idempotency_keys/migration.sql` (generated by the CLI, not hand-written)

**Interfaces:**

- Produces: Prisma model `IdempotencyKey` (fields: `key`, `route`, `requestHash`, `responseStatus`, `responseBody`, `createdAt`, `expiresAt`), and `TenantSettings.idempotencyKeyRetentionHours: Int @default(24)`.

- [ ] **Step 1: Add the `TenantSettings` column**

In `apps/server/prisma/schema.prisma`, find the `TenantSettings` model and add the new field after `procurementLeadTimeWeeks`:

```prisma
model TenantSettings {
  tenantId                     String   @id @map("tenant_id")
  warnThreshold                Decimal  @default(0.70) @map("warn_threshold") @db.Decimal(4, 3)
  critThreshold                Decimal  @default(0.90) @map("crit_threshold") @db.Decimal(4, 3)
  procurementLeadTimeWeeks     Int      @default(8) @map("procurement_lead_time_weeks")
  idempotencyKeyRetentionHours Int      @default(24) @map("idempotency_key_retention_hours")
  createdAt                    DateTime @default(now()) @map("created_at")
  updatedAt                    DateTime @updatedAt @map("updated_at")

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@map("tenant_settings")
}
```

- [ ] **Step 2: Add the `IdempotencyKey` model**

In the same file, add this new model directly after the `Category` model (before the `// ---------- Auth ----------` section comment):

```prisma
/**
 * General-purpose request-idempotency cache (#263). No `tenantId`: this app
 * has no cross-tenant boundary in v1 by design (see CLAUDE.md "Resource
 * ownership"), so the key alone is the uniqueness constraint. `route`
 * identifies which endpoint issued the key (audit trail / future multi-route
 * reuse); `requestHash` detects the same key replayed with a different
 * payload. Purged by an in-process sweep once `expiresAt` passes — this is an
 * ephemeral dedup cache, not business data.
 */
model IdempotencyKey {
  key            String   @id
  route          String
  requestHash    String   @map("request_hash")
  responseStatus Int      @map("response_status")
  responseBody   Json     @map("response_body")
  createdAt      DateTime @default(now()) @map("created_at")
  expiresAt      DateTime @map("expires_at")

  @@index([expiresAt])
  @@map("idempotency_keys")
}
```

- [ ] **Step 3: Generate and apply the migration**

Ensure the dev Postgres container is running (`pnpm db:dev:up`), then run:

```bash
pnpm --filter @lcm/server exec prisma migrate dev --name add_idempotency_keys
```

Expected: Prisma prints `Your database is now in sync with your schema` and creates a new directory `apps/server/prisma/migrations/<YYYYMMDDHHMMSS>_add_idempotency_keys/migration.sql`. Open that generated file and confirm it contains (column/table order may differ slightly, but the DDL is equivalent to):

```sql
ALTER TABLE "tenant_settings" ADD COLUMN "idempotency_key_retention_hours" INTEGER NOT NULL DEFAULT 24;

CREATE TABLE "idempotency_keys" (
    "key" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");
```

If the generated SQL differs meaningfully from this (e.g. Prisma names the index differently), that's fine — do not hand-edit a generated migration file to match this plan exactly; the CLI's output is authoritative.

- [ ] **Step 4: Regenerate the Prisma client**

Run: `pnpm --filter @lcm/server exec prisma generate`
Expected: no errors; `@prisma/client` now exports the `IdempotencyKey` model and `PrismaClient.idempotencyKey`.

- [ ] **Step 5: Verify the server still typechecks and boots**

Run: `pnpm --filter @lcm/server typecheck`
Expected: PASS (no code references the new model yet, so this just confirms the generated client is well-formed).

- [ ] **Step 6: Commit**

```bash
git add apps/server/prisma/schema.prisma apps/server/prisma/migrations/
git commit -m "feat(server): add idempotency_keys table and TenantSettings retention column"
```

---

### Task 3: `IdempotencyService`

**Files:**

- Create: `apps/server/src/services/idempotency.ts`
- Create: `apps/server/src/__tests__/idempotency.test.ts`
- Modify: `apps/server/src/__tests__/setup.ts`

**Interfaces:**

- Consumes: `PrismaClient`/`Prisma.TransactionClient` from `@prisma/client`; `prisma` and `makeTestEnv` test helpers from `./setup.js`/`./test-helpers.js`.
- Produces: `class IdempotencyService` with `constructor(prisma: PrismaClient)`, `lookup(key: string, requestHash: string, tx?: Prisma.TransactionClient): Promise<{ status: number; body: unknown } | 'conflict' | null>`, and `record(params: { key: string; route: string; requestHash: string; status: number; body: unknown; tenantId: string }, tx?: Prisma.TransactionClient): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/__tests__/idempotency.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { IdempotencyService } from '../services/idempotency.js';

import { prisma } from './setup.js';

let service: IdempotencyService;

beforeEach(() => {
  service = new IdempotencyService(prisma);
});

describe('IdempotencyService', () => {
  it('lookup returns null when the key has never been recorded', async () => {
    const result = await service.lookup('11111111-1111-4111-8111-111111111111', 'hash-a');
    expect(result).toBeNull();
  });

  it('record then lookup with the same hash returns the stored response', async () => {
    await service.record({
      key: '22222222-2222-4222-8222-222222222222',
      route: 'POST /items/bulk-shift-dates',
      requestHash: 'hash-b',
      status: 200,
      body: { shifted: 1, items: [] },
      tenantId: 'default',
    });

    const result = await service.lookup('22222222-2222-4222-8222-222222222222', 'hash-b');
    expect(result).toEqual({ status: 200, body: { shifted: 1, items: [] } });
  });

  it('lookup with a different hash under the same key returns "conflict"', async () => {
    await service.record({
      key: '33333333-3333-4333-8333-333333333333',
      route: 'POST /items/bulk-shift-dates',
      requestHash: 'hash-c',
      status: 200,
      body: { shifted: 1, items: [] },
      tenantId: 'default',
    });

    const result = await service.lookup('33333333-3333-4333-8333-333333333333', 'hash-different');
    expect(result).toBe('conflict');
  });

  it("record uses the tenant's configured retention hours to set expiresAt", async () => {
    await prisma.tenantSettings.upsert({
      where: { tenantId: 'default' },
      create: { tenantId: 'default', idempotencyKeyRetentionHours: 2 },
      update: { idempotencyKeyRetentionHours: 2 },
    });

    const before = Date.now();
    await service.record({
      key: '44444444-4444-4444-8444-444444444444',
      route: 'POST /items/bulk-shift-dates',
      requestHash: 'hash-d',
      status: 200,
      body: {},
      tenantId: 'default',
    });

    const row = await prisma.idempotencyKey.findUniqueOrThrow({
      where: { key: '44444444-4444-4444-8444-444444444444' },
    });
    const expectedExpiryMs = before + 2 * 60 * 60 * 1000;
    // Allow a small window for test execution time.
    expect(Math.abs(row.expiresAt.getTime() - expectedExpiryMs)).toBeLessThan(5000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lcm/server test -- idempotency.test.ts`
Expected: FAIL — cannot find module `../services/idempotency.js`

- [ ] **Step 3: Add the new table to the shared per-test cleanup**

Every other test-visible table is wiped in `apps/server/src/__tests__/setup.ts`'s `beforeEach` so each test starts from a clean slate. `idempotency_keys` has no FK relation to `cluster`/`tenant` (deliberately — see the design doc), so nothing cascades into it; without this it would be the one table that silently accumulates rows across the whole test run. In `apps/server/src/__tests__/setup.ts`, add it to the existing list:

```ts
beforeEach(async () => {
  await prisma.session.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.clusterSettings.deleteMany({});
  await prisma.cluster.deleteMany({});
  await prisma.tenantSettings.deleteMany({});
  await prisma.authConfig.deleteMany({});
  await prisma.idempotencyKey.deleteMany({});
});
```

- [ ] **Step 4: Implement the service**

Create `apps/server/src/services/idempotency.ts`:

```ts
import type { Prisma, PrismaClient } from '@prisma/client';

export interface IdempotencyHit {
  status: number;
  body: unknown;
}

export type IdempotencyLookupResult = IdempotencyHit | 'conflict' | null;

export interface IdempotencyRecordParams {
  key: string;
  route: string;
  requestHash: string;
  status: number;
  body: unknown;
  tenantId: string;
}

/**
 * General request-idempotency cache (#263). Both methods run against
 * whichever `tx` the caller passes — a caller wraps `lookup` and `record`
 * around its own transactional write so the dedup record commits or rolls
 * back atomically with the mutation it is guarding. Not scoped to any one
 * endpoint: `route` merely records which one issued a given key.
 */
export class IdempotencyService {
  constructor(private readonly prisma: PrismaClient) {}

  async lookup(
    key: string,
    requestHash: string,
    tx: Prisma.TransactionClient | PrismaClient = this.prisma,
  ): Promise<IdempotencyLookupResult> {
    const existing = await tx.idempotencyKey.findUnique({ where: { key } });
    if (!existing) return null;
    if (existing.requestHash !== requestHash) return 'conflict';
    return { status: existing.responseStatus, body: existing.responseBody };
  }

  /**
   * Reads the tenant's configured `idempotencyKeyRetentionHours` (upserting a
   * default row if none exists yet, mirroring `SettingsService.getTenant`'s
   * own upsert-on-read pattern) and stores the record with `expiresAt`
   * computed from that value at THIS moment — a later change to the setting
   * does not retroactively shorten or extend an already-stored key's life.
   */
  async record(
    params: IdempotencyRecordParams,
    tx: Prisma.TransactionClient | PrismaClient = this.prisma,
  ): Promise<void> {
    const settings = await tx.tenantSettings.upsert({
      where: { tenantId: params.tenantId },
      create: { tenantId: params.tenantId },
      update: {},
      select: { idempotencyKeyRetentionHours: true },
    });
    const now = Date.now();
    await tx.idempotencyKey.create({
      data: {
        key: params.key,
        route: params.route,
        requestHash: params.requestHash,
        responseStatus: params.status,
        responseBody: params.body as Prisma.InputJsonValue,
        expiresAt: new Date(now + settings.idempotencyKeyRetentionHours * 60 * 60 * 1000),
      },
    });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @lcm/server test -- idempotency.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/services/idempotency.ts apps/server/src/__tests__/idempotency.test.ts apps/server/src/__tests__/setup.ts
git commit -m "feat(server): add IdempotencyService"
```

---

### Task 4: Wire idempotency into `bulkShiftDates` and the route

**Files:**

- Modify: `apps/server/src/services/items.ts`
- Modify: `apps/server/src/routes/items.ts`
- Create: `apps/server/src/__tests__/items-bulk-shift-idempotency.test.ts`

**Interfaces:**

- Consumes: `IdempotencyService` from Task 3 (`lookup`/`record`, both accepting an explicit `tx`); `idempotencyKeyHeaderSchema` from Task 1.
- Produces: `ItemsService.bulkShiftDates(tenantId: string, input: ItemBulkShiftDatesInput, idempotencyKey: string): Promise<ItemBulkShiftDatesResponse>` (signature gains the third parameter); the route requires an `Idempotency-Key` header.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/__tests__/items-bulk-shift-idempotency.test.ts`:

```ts
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';

import { makeApplication, makeCluster } from './factories.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

let server: FastifyInstance;
let clusterId: string;

beforeAll(async () => {
  server = await buildServer({ env: makeTestEnv(), prisma });
});

beforeEach(async () => {
  const cluster = await makeCluster(prisma);
  clusterId = cluster.id;
});

afterAll(async () => {
  await server.close();
});

const utc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const shift = (
  payload: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<LightMyRequestResponse> =>
  server.inject({
    method: 'POST',
    url: '/api/items/bulk-shift-dates',
    payload,
    headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
  });

describe('POST /api/items/bulk-shift-dates — idempotency', () => {
  it('rejects a request with no Idempotency-Key header', async () => {
    const app = await makeApplication(prisma, { clusterId, startedAt: utc('2026-01-15') });
    const response = await shift({ itemIds: [app.id], shift: { amount: 1, unit: 'months' } });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a malformed Idempotency-Key header', async () => {
    const app = await makeApplication(prisma, { clusterId, startedAt: utc('2026-01-15') });
    const response = await shift(
      { itemIds: [app.id], shift: { amount: 1, unit: 'months' } },
      'not-a-uuid',
    );
    expect(response.statusCode).toBe(400);
  });

  it('a replay with the identical payload returns the original response and does not shift again', async () => {
    const app = await makeApplication(prisma, { clusterId, startedAt: utc('2026-01-15') });
    const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const payload = { itemIds: [app.id], shift: { amount: 1, unit: 'months' } };

    const first = await shift(payload, key);
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();

    const second = await shift(payload, key);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(firstBody);

    const row = await prisma.item.findUniqueOrThrow({ where: { id: app.id } });
    expect(row.effectiveDate.toISOString().slice(0, 10)).toBe('2026-02-15');
  });

  it('the same key with a different payload is rejected as a conflict, not executed', async () => {
    const app = await makeApplication(prisma, { clusterId, startedAt: utc('2026-01-15') });
    const key = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    const first = await shift({ itemIds: [app.id], shift: { amount: 1, unit: 'months' } }, key);
    expect(first.statusCode).toBe(200);

    const second = await shift({ itemIds: [app.id], shift: { amount: 2, unit: 'months' } }, key);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');

    // The conflicting request must not have applied its own delta on top.
    const row = await prisma.item.findUniqueOrThrow({ where: { id: app.id } });
    expect(row.effectiveDate.toISOString().slice(0, 10)).toBe('2026-02-15');
  });

  it('treats reordered itemIds naming the same set as the same request', async () => {
    const appA = await makeApplication(prisma, { clusterId, startedAt: utc('2026-01-15') });
    const appB = await makeApplication(prisma, { clusterId, startedAt: utc('2026-01-20') });
    const key = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    const first = await shift(
      { itemIds: [appA.id, appB.id], shift: { amount: 1, unit: 'months' } },
      key,
    );
    expect(first.statusCode).toBe(200);

    // Same logical request, items named in the opposite order.
    const second = await shift(
      { itemIds: [appB.id, appA.id], shift: { amount: 1, unit: 'months' } },
      key,
    );
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it('a genuinely failed request (unknown item) retried under the same key still succeeds', async () => {
    const app = await makeApplication(prisma, { clusterId, startedAt: utc('2026-01-15') });
    const key = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

    const failing = await shift(
      { itemIds: [app.id, 'does-not-exist'], shift: { amount: 1, unit: 'months' } },
      key,
    );
    expect(failing.statusCode).toBe(404);

    const retry = await shift({ itemIds: [app.id], shift: { amount: 1, unit: 'months' } }, key);
    expect(retry.statusCode).toBe(200);

    const row = await prisma.item.findUniqueOrThrow({ where: { id: app.id } });
    expect(row.effectiveDate.toISOString().slice(0, 10)).toBe('2026-02-15');
  });

  it('concurrent duplicate submissions under the same key apply the shift exactly once', async () => {
    const app = await makeApplication(prisma, { clusterId, startedAt: utc('2026-01-15') });
    const key = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const payload = { itemIds: [app.id], shift: { amount: 1, unit: 'months' } };

    const [a, b] = await Promise.all([shift(payload, key), shift(payload, key)]);
    const statuses = [a.statusCode, b.statusCode].sort();
    // One committed (200); the loser hits a serialization conflict. Per the
    // existing @ai-note on bulkShiftDates, that conflict is NOT translated to
    // a friendly code here and surfaces as a sanitized 500 — accepted
    // behaviour, unchanged by this feature.
    expect(statuses).toEqual([200, 500]);

    const row = await prisma.item.findUniqueOrThrow({ where: { id: app.id } });
    // Exactly one month, not two — the whole point of the test.
    expect(row.effectiveDate.toISOString().slice(0, 10)).toBe('2026-02-15');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lcm/server test -- items-bulk-shift-idempotency.test.ts`
Expected: FAIL — every request currently succeeds without an `Idempotency-Key` header (400 expectations fail), and `bulkShiftDates` has no dedup logic yet.

- [ ] **Step 3: Update the route to require the header**

In `apps/server/src/routes/items.ts`, add `idempotencyKeyHeaderSchema` to the `@lcm/shared` import list and change the bulk-shift handler:

```ts
import {
  clusterIdItemsParamsSchema,
  idempotencyKeyHeaderSchema,
  itemAllocationRowInputSchema,
  itemBulkShiftDatesInputSchema,
  itemCreateInputSchema,
  itemIdParamsSchema,
  itemUpdateInputSchema,
  paginationQuerySchema,
} from '@lcm/shared';
```

```ts
// Static segment, so it never shadows (or is shadowed by) `/items/:id/...`.
// Admin-gated automatically: a mutating /api route outside the read-only
// exemption list (see `requiresAdmin` in plugins/auth.ts).
fastify.post('/items/bulk-shift-dates', async (request) => {
  const idempotencyKey = idempotencyKeyHeaderSchema.parse(request.headers['idempotency-key']);
  const input = itemBulkShiftDatesInputSchema.parse(request.body);
  return service.bulkShiftDates(request.tenantId, input, idempotencyKey);
});
```

- [ ] **Step 4: Rewrite `bulkShiftDates`**

In `apps/server/src/services/items.ts`, add imports and update the constructor and method. First, update the top-of-file imports:

```ts
import { createHash } from 'node:crypto';

import type {
  ItemAllocationResponseRow,
  ItemAllocationRowInput,
  ItemBulkShiftDatesInput,
  ItemBulkShiftDatesResponse,
  ItemCreateInput,
  ItemDateShift,
  ItemResponse,
  ItemUpdateInput,
  Paginated,
} from '@lcm/shared';
import { hasShiftCollision, isSupportedDate, shiftDateByUnit } from '@lcm/shared';
import { Prisma, type PrismaClient } from '@prisma/client';

import { formatDate } from '../lib/dates.js';

import { CategoriesService } from './categories.js';
import { ConflictError, NotFoundError, UnprocessableError } from './errors.js';
import { IdempotencyService } from './idempotency.js';
import { translatePrismaError, type UniqueConstraintMapping } from './prisma-errors.js';
```

(`ConflictError` is added to the existing `./errors.js` import; `IdempotencyService` is a new import.)

Add a route-identifier constant near the other module-level constants (after `BULK_SHIFT_TIMEOUT_MS`):

```ts
/** Recorded on every idempotency-key row this endpoint writes (#263). */
const BULK_SHIFT_ROUTE = 'POST /items/bulk-shift-dates';
```

Add the normalization helper directly above `planItemShift`:

```ts
/**
 * Hashes the LOGICAL request — deduped and sorted `itemIds` paired with
 * `shift` — not the raw payload. `bulkShiftDates` already dedupes itemIds via
 * `Set`, which preserves first-occurrence order; without sorting here, the
 * same set of items submitted in a different order (e.g. a re-rendered
 * selection) would hash differently and a legitimate replay would be
 * misread as a conflict.
 */
function hashBulkShiftRequest(uniqueIds: string[], shift: ItemDateShift): string {
  const normalized = { itemIds: [...uniqueIds].sort(), shift };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
```

Update the constructor (find the existing `constructor(private readonly prisma: PrismaClient) {` block that sets `this.categories`):

```ts
  private readonly categories: CategoriesService;
  private readonly idempotency: IdempotencyService;

  constructor(private readonly prisma: PrismaClient) {
    this.categories = new CategoriesService(this.prisma);
    this.idempotency = new IdempotencyService(this.prisma);
  }
```

Now replace the entire `bulkShiftDates` method body:

```ts
  /**
   * Move a set of entries by one signed relative offset, all-or-nothing.
   *
   * The shift **cascades** across an entry's whole timeline — `effectiveDate`,
   * every `allocations[*].effectiveFrom`, and `endedAt` when set — by the same
   * delta. That is what keeps the timeline internally consistent: moving only
   * `effectiveDate` could push an application's start past its own first
   * allocation, which `update()` already refuses to do one entry at a time.
   *
   * @ai-note Idempotent via `idempotencyKey` (#263): a replay with an
   * unchanged payload returns the original response and applies nothing; the
   * same key with a different payload is rejected as a 409 conflict and also
   * applies nothing. The idempotency record is written inside this SAME
   * transaction, so it commits or rolls back atomically with the shift.
   *
   * @ai-note A genuine serialization conflict (Postgres 40001) is deliberately
   * NOT retried — it aborts the transaction and surfaces as a sanitized 500,
   * leaving the data untouched. Accepted for a low-concurrency internal tool
   * where two admins bulk-shifting the same entries at once is not a real
   * workload; the failure is safe, just unfriendly. Revisit if that changes.
   */
  async bulkShiftDates(
    tenantId: string,
    input: ItemBulkShiftDatesInput,
    idempotencyKey: string,
  ): Promise<ItemBulkShiftDatesResponse> {
    const uniqueIds = Array.from(new Set(input.itemIds));
    const requestHash = hashBulkShiftRequest(uniqueIds, input.shift);

    return this.prisma.$transaction(
      async (tx) => {
        const cached = await this.idempotency.lookup(idempotencyKey, requestHash, tx);
        if (cached === 'conflict') {
          throw new ConflictError(
            'IDEMPOTENCY_KEY_CONFLICT',
            'This Idempotency-Key was already used for a different request',
          );
        }
        if (cached !== null) {
          return cached.body as ItemBulkShiftDatesResponse;
        }

        const existing = await tx.item.findMany({
          where: { id: { in: uniqueIds }, tenantId },
          include: itemInclude,
        });
        const byId = new Map(existing.map((row) => [row.id, row]));
        for (const id of uniqueIds) {
          if (!byId.has(id)) {
            throw new NotFoundError('Item', id);
          }
        }

        const allocationRows = existing.reduce((sum, row) => sum + row.allocations.length, 0);
        if (allocationRows > MAX_SHIFT_ALLOCATION_ROWS) {
          throw new UnprocessableError(
            'SHIFT_BATCH_TOO_LARGE',
            `A bulk shift may touch at most ${MAX_SHIFT_ALLOCATION_ROWS} allocation rows; this one touches ${allocationRows}`,
          );
        }

        // Plan and validate EVERY entry before writing ANY of them, so an
        // invalid entry costs no write at all rather than relying on rollback.
        const plans = existing.map((row) => planItemShift(row, input.shift));

        for (const plan of plans) {
          await tx.item.update({
            where: { id: plan.itemId },
            data: { effectiveDate: plan.effectiveDate, endedAt: plan.endedAt },
          });
          for (const allocation of plan.allocations) {
            await tx.itemAllocation.update({
              where: { id: allocation.id },
              data: { effectiveFrom: allocation.effectiveFrom },
            });
          }
        }

        const rows = await tx.item.findMany({
          where: { id: { in: uniqueIds }, tenantId },
          include: itemInclude,
          orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }],
        });
        const response: ItemBulkShiftDatesResponse = {
          shifted: rows.length,
          items: rows.map((row) => this.toResponse(row)),
        };

        await this.idempotency.record(
          {
            key: idempotencyKey,
            route: BULK_SHIFT_ROUTE,
            requestHash,
            status: 200,
            body: response,
            tenantId,
          },
          tx,
        );

        return response;
      },
      { isolationLevel: 'Serializable', timeout: BULK_SHIFT_TIMEOUT_MS },
    );
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @lcm/server test -- items-bulk-shift-idempotency.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: Run the pre-existing bulk-shift test file to confirm no regression**

Run: `pnpm --filter @lcm/server test -- items-bulk-shift.test.ts`
Expected: FAIL — every `shift(...)` call in this file sends no `Idempotency-Key` header, so each now gets a 400 instead of the expected 200/other status.

- [ ] **Step 7: Fix the pre-existing test file**

In `apps/server/src/__tests__/items-bulk-shift.test.ts`, update the `shift` helper to always send a fresh, valid header, since none of that file's tests care about idempotency semantics — they only need requests to succeed:

```ts
import { randomUUID } from 'node:crypto';
```

Add that import at the top (after the existing `import type { FastifyInstance, LightMyRequestResponse } from 'fastify';` line), then replace the `shift` helper:

```ts
const shift = (payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  server.inject({
    method: 'POST',
    url: '/api/items/bulk-shift-dates',
    payload,
    headers: { 'idempotency-key': randomUUID() },
  });
```

Since each call now mints its own fresh key, none of this file's existing assertions change — only the helper.

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm --filter @lcm/server test -- items-bulk-shift.test.ts`
Expected: PASS (all previously-passing tests, unchanged)

- [ ] **Step 9: Run the full server test suite**

Run: `pnpm --filter @lcm/server test`
Expected: PASS. (If any other test file calls `/api/items/bulk-shift-dates` directly, apply the same fix as Step 7 — search first: `grep -rn "bulk-shift-dates" apps/server/src/__tests__/`.)

- [ ] **Step 10: Typecheck**

Run: `pnpm --filter @lcm/server typecheck`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add apps/server/src/services/items.ts apps/server/src/routes/items.ts apps/server/src/__tests__/items-bulk-shift-idempotency.test.ts apps/server/src/__tests__/items-bulk-shift.test.ts
git commit -m "feat(server): require Idempotency-Key on bulk-shift-dates"
```

---

### Task 5: `SettingsService` support for the retention setting

**Files:**

- Modify: `apps/server/src/services/settings.ts`
- Modify: `apps/server/src/__tests__/settings.test.ts`

**Interfaces:**

- Consumes: `TenantSettings` type from `@lcm/shared` (now includes `idempotencyKeyRetentionHours`).
- Produces: `SettingsService.getTenant`/`updateTenant` read/write `idempotencyKeyRetentionHours`.

- [ ] **Step 1: Write the failing test**

In `apps/server/src/__tests__/settings.test.ts`, find the test that asserts the `GET /settings/tenant` defaults (the one checking `body.procurementLeadTimeWeeks` equals `8`) and add an assertion for the new field immediately after it:

```ts
expect(body.idempotencyKeyRetentionHours).toBe(24);
```

Also update its type annotation (the `body` cast a few lines above) to include `idempotencyKeyRetentionHours: number;`.

Then update every `PUT /settings/tenant` test payload in this file to include `idempotencyKeyRetentionHours: 24` (or a deliberately different value where the test is specifically about that field). Concretely, every occurrence of a payload shaped like:

```ts
payload: { warnThreshold: 0.65, critThreshold: 0.85, procurementLeadTimeWeeks: 10 },
```

becomes:

```ts
payload: { warnThreshold: 0.65, critThreshold: 0.85, procurementLeadTimeWeeks: 10, idempotencyKeyRetentionHours: 24 },
```

Apply this to all six `PUT /settings/tenant` payloads in the file (the successful update, the warn>=crit rejection, the 0-boundary, the 104-boundary, the above-104 rejection, and the negative/non-integer rejections). Also add three new tests after the existing procurementLeadTimeWeeks boundary tests:

```ts
it('accepts idempotencyKeyRetentionHours at the 1 and 168 boundaries', async () => {
  const low = await server.inject({
    method: 'PUT',
    url: '/api/settings/tenant',
    payload: {
      warnThreshold: 0.7,
      critThreshold: 0.9,
      procurementLeadTimeWeeks: 8,
      idempotencyKeyRetentionHours: 1,
    },
  });
  expect(low.statusCode).toBe(200);
  expect(
    (low.json() as { idempotencyKeyRetentionHours: number }).idempotencyKeyRetentionHours,
  ).toBe(1);

  const high = await server.inject({
    method: 'PUT',
    url: '/api/settings/tenant',
    payload: {
      warnThreshold: 0.7,
      critThreshold: 0.9,
      procurementLeadTimeWeeks: 8,
      idempotencyKeyRetentionHours: 168,
    },
  });
  expect(high.statusCode).toBe(200);
  expect(
    (high.json() as { idempotencyKeyRetentionHours: number }).idempotencyKeyRetentionHours,
  ).toBe(168);
});

it('rejects idempotencyKeyRetentionHours outside 1..168', async () => {
  const tooLow = await server.inject({
    method: 'PUT',
    url: '/api/settings/tenant',
    payload: {
      warnThreshold: 0.7,
      critThreshold: 0.9,
      procurementLeadTimeWeeks: 8,
      idempotencyKeyRetentionHours: 0,
    },
  });
  expect(tooLow.statusCode).toBe(400);

  const tooHigh = await server.inject({
    method: 'PUT',
    url: '/api/settings/tenant',
    payload: {
      warnThreshold: 0.7,
      critThreshold: 0.9,
      procurementLeadTimeWeeks: 8,
      idempotencyKeyRetentionHours: 169,
    },
  });
  expect(tooHigh.statusCode).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lcm/server test -- settings.test.ts`
Expected: FAIL — `SettingsService.getTenant`/`updateTenant` don't read/write the new field yet, and the route's Zod parse of `tenantSettingsSchema` now rejects every PUT payload above that's missing `idempotencyKeyRetentionHours` (wait — Step 1 already added it to every payload, so instead this fails because `getTenant`/`updateTenant` in `settings.ts` don't return/persist the field, so the new assertions comparing it don't match).

- [ ] **Step 3: Update `SettingsService`**

In `apps/server/src/services/settings.ts`, update both `getTenant` and `updateTenant`:

```ts
  async getTenant(tenantId: string): Promise<TenantSettings> {
    const row = await this.prisma.tenantSettings.upsert({
      where: { tenantId },
      create: { tenantId },
      update: {},
    });
    return {
      warnThreshold: decimalToNumber(row.warnThreshold),
      critThreshold: decimalToNumber(row.critThreshold),
      procurementLeadTimeWeeks: row.procurementLeadTimeWeeks,
      idempotencyKeyRetentionHours: row.idempotencyKeyRetentionHours,
    };
  }

  async updateTenant(tenantId: string, input: TenantSettings): Promise<TenantSettings> {
    const row = await this.prisma.tenantSettings.upsert({
      where: { tenantId },
      create: {
        tenantId,
        warnThreshold: input.warnThreshold,
        critThreshold: input.critThreshold,
        procurementLeadTimeWeeks: input.procurementLeadTimeWeeks,
        idempotencyKeyRetentionHours: input.idempotencyKeyRetentionHours,
      },
      update: {
        warnThreshold: input.warnThreshold,
        critThreshold: input.critThreshold,
        procurementLeadTimeWeeks: input.procurementLeadTimeWeeks,
        idempotencyKeyRetentionHours: input.idempotencyKeyRetentionHours,
      },
    });
    return {
      warnThreshold: decimalToNumber(row.warnThreshold),
      critThreshold: decimalToNumber(row.critThreshold),
      procurementLeadTimeWeeks: row.procurementLeadTimeWeeks,
      idempotencyKeyRetentionHours: row.idempotencyKeyRetentionHours,
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @lcm/server test -- settings.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full server suite and typecheck**

Run: `pnpm --filter @lcm/server test && pnpm --filter @lcm/server typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/services/settings.ts apps/server/src/__tests__/settings.test.ts
git commit -m "feat(server): expose idempotencyKeyRetentionHours via settings API"
```

---

### Task 6: Cleanup timer service and plugin

**Files:**

- Create: `apps/server/src/services/idempotency-cleanup.ts`
- Create: `apps/server/src/plugins/idempotency-cleanup.ts`
- Create: `apps/server/src/__tests__/idempotency-cleanup.test.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**

- Consumes: `PrismaClient`.
- Produces: `class IdempotencyCleanup` with `start(intervalMs?)`, `isRunning()`, `stop()`, `sweep(): Promise<number>`; a Fastify plugin decorating `fastify.idempotencyCleanup`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/__tests__/idempotency-cleanup.test.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { idempotencyCleanupPlugin } from '../plugins/idempotency-cleanup.js';
import { prismaPlugin } from '../plugins/prisma.js';
import { IdempotencyCleanup } from '../services/idempotency-cleanup.js';
import { buildServer } from '../server.js';

import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

describe('IdempotencyCleanup', () => {
  it('sweep deletes only expired rows', async () => {
    const cleanup = new IdempotencyCleanup(prisma);
    const now = Date.now();
    await prisma.idempotencyKey.createMany({
      data: [
        {
          key: 'expired-1',
          route: 'r',
          requestHash: 'h',
          responseStatus: 200,
          responseBody: {},
          expiresAt: new Date(now - 1000),
        },
        {
          key: 'still-valid-1',
          route: 'r',
          requestHash: 'h',
          responseStatus: 200,
          responseBody: {},
          expiresAt: new Date(now + 60 * 60 * 1000),
        },
      ],
    });

    const deleted = await cleanup.sweep();
    expect(deleted).toBe(1);

    const remaining = await prisma.idempotencyKey.findMany({ select: { key: true } });
    expect(remaining.map((r) => r.key)).toEqual(['still-valid-1']);
  });
});

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function buildApp(autostart: boolean): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(prismaPlugin, { prisma });
  await app.register(idempotencyCleanupPlugin, {
    autostart,
    tickIntervalMs: 60 * 60 * 1000,
  });
  apps.push(app);
  return app;
}

describe('idempotencyCleanupPlugin', () => {
  it('does NOT start the tick when autostart is false', async () => {
    const app = await buildApp(false);
    expect(app.idempotencyCleanup.isRunning()).toBe(false);
  });

  it('starts the tick when autostart is true, and stops it on close', async () => {
    const app = await buildApp(true);
    expect(app.idempotencyCleanup.isRunning()).toBe(true);

    await app.close();
    apps.length = 0;
    expect(app.idempotencyCleanup.isRunning()).toBe(false);
  });

  it('buildServer never auto-starts the cleanup tick in the test environment', async () => {
    const server = await buildServer({ env: makeTestEnv(), prisma });
    apps.push(server);
    expect(server.idempotencyCleanup.isRunning()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lcm/server test -- idempotency-cleanup.test.ts`
Expected: FAIL — cannot find modules `../plugins/idempotency-cleanup.js` / `../services/idempotency-cleanup.js`

- [ ] **Step 3: Implement the cleanup service**

Create `apps/server/src/services/idempotency-cleanup.ts`:

```ts
import type { PrismaClient } from '@prisma/client';

/** Drain budget on shutdown — same order of magnitude as the vSphere scheduler's. */
const DRAIN_TIMEOUT_MS = 5_000;

/** How often the sweep runs. Fixed, not a setting: retention is measured in
 * hours, so a 15-minute tick is comfortably tight without being configurable
 * surface area nobody asked for. */
export const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Purges expired `idempotency_keys` rows (#263). Deliberately simpler than
 * `VsphereScheduler`: a plain `DELETE ... WHERE expires_at < now()` is
 * naturally safe to run concurrently from multiple instances with no
 * claim/lease needed — unlike coordinating exclusive outbound vCenter calls,
 * there is no external resource here to serialize access to.
 */
export class IdempotencyCleanup {
  private timer: NodeJS.Timeout | null = null;
  private activeRun: Promise<number> | null = null;

  constructor(private readonly prisma: PrismaClient) {}

  start(intervalMs: number = CLEANUP_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch(() => undefined);
    }, intervalMs);
    this.timer.unref();
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.race([this.activeRun ?? Promise.resolve(0), delay(DRAIN_TIMEOUT_MS)]);
  }

  /** Deletes every row past its `expiresAt`. Never throws; returns the count removed. */
  async sweep(): Promise<number> {
    const run = this.prisma.idempotencyKey
      .deleteMany({ where: { expiresAt: { lt: new Date() } } })
      .then((result) => result.count)
      .catch(() => 0);
    this.activeRun = run;
    try {
      return await run;
    } finally {
      this.activeRun = null;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
```

- [ ] **Step 4: Implement the plugin**

Create `apps/server/src/plugins/idempotency-cleanup.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { IdempotencyCleanup } from '../services/idempotency-cleanup.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Purges expired idempotency-key rows (#263). Exposed for tests and drain. */
    idempotencyCleanup: IdempotencyCleanup;
  }
}

export interface IdempotencyCleanupPluginOptions {
  /** Mirrors the vSphere scheduler plugin's own test-environment skip. */
  autostart: boolean;
  /** Tick interval; overridable in tests. */
  tickIntervalMs?: number;
}

const idempotencyCleanupPluginFn: FastifyPluginAsync<IdempotencyCleanupPluginOptions> = async (
  fastify,
  opts,
) => {
  const cleanup = new IdempotencyCleanup(fastify.prisma);
  fastify.decorate('idempotencyCleanup', cleanup);

  if (opts.autostart) {
    cleanup.start(opts.tickIntervalMs);
  }

  fastify.addHook('onClose', async () => {
    await cleanup.stop();
  });
};

export const idempotencyCleanupPlugin = fp(idempotencyCleanupPluginFn, {
  name: 'idempotency-cleanup',
  dependencies: ['prisma'],
});
```

- [ ] **Step 5: Register the plugin in `server.ts`**

In `apps/server/src/server.ts`, add the import (alphabetically among the existing `plugins/*` imports, right after `import { errorHandlerPlugin } from './plugins/error-handler.js';`):

```ts
import { idempotencyCleanupPlugin } from './plugins/idempotency-cleanup.js';
```

Then, right after the existing `vsphereSchedulerPlugin` registration block (the one ending `autostart: env.NODE_ENV !== 'test'`), add:

```ts
// Purges expired idempotency-key rows (#263). Same never-ticks-in-test
// rule as the vSphere scheduler above, for the same reason (isolate:false
// means a stray background tick could race assertions across files).
await server.register(idempotencyCleanupPlugin, {
  autostart: env.NODE_ENV !== 'test',
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @lcm/server test -- idempotency-cleanup.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Run the full server suite and typecheck**

Run: `pnpm --filter @lcm/server test && pnpm --filter @lcm/server typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/services/idempotency-cleanup.ts apps/server/src/plugins/idempotency-cleanup.ts apps/server/src/__tests__/idempotency-cleanup.test.ts apps/server/src/server.ts
git commit -m "feat(server): purge expired idempotency keys on a background timer"
```

---

### Task 7: Web — secure-context-independent UUID helper

**Files:**

- Create: `apps/web/src/lib/uuid.ts`
- Create: `apps/web/src/lib/uuid.test.ts`

**Interfaces:**

- Produces: `generateUuidV4(): string`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/uuid.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { generateUuidV4 } from './uuid';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('generateUuidV4', () => {
  it('produces a well-formed v4 UUID', () => {
    expect(generateUuidV4()).toMatch(UUID_V4_PATTERN);
  });

  it('produces a different value on each call', () => {
    expect(generateUuidV4()).not.toBe(generateUuidV4());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lcm/web test -- uuid.test.ts`
Expected: FAIL — cannot find module `./uuid`

- [ ] **Step 3: Implement the helper**

Create `apps/web/src/lib/uuid.ts`:

```ts
/**
 * RFC 4122 v4 UUID via `crypto.getRandomValues`, NOT `crypto.randomUUID()`.
 * The latter is spec'd secure-context-only (HTTPS/localhost); this app's
 * production deployment deliberately serves plain HTTP internally (CLAUDE.md
 * — HSTS is off), so `crypto.randomUUID` can be undefined there.
 * `crypto.getRandomValues` carries no such restriction.
 */
export function generateUuidV4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const withVersion = Array.from(bytes).map((byte, i) => {
    if (i === 6) return (byte & 0x0f) | 0x40; // version 4
    if (i === 8) return (byte & 0x3f) | 0x80; // variant 10
    return byte;
  });
  const hex = withVersion.map((byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @lcm/web test -- uuid.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/uuid.ts apps/web/src/lib/uuid.test.ts
git commit -m "feat(web): add secure-context-independent UUID v4 helper"
```

---

### Task 8: Web — send the header from the bulk-shift dialog

**Files:**

- Modify: `apps/web/src/lib/api-client.ts`
- Modify: `apps/web/src/components/clusters/item-dialogs/bulk-shift-dates-dialog.tsx`
- Modify: `apps/web/src/components/clusters/items-tab.test.tsx`

**Interfaces:**

- Consumes: `generateUuidV4` from Task 7.
- Produces: `api.items.bulkShiftDates(input: ItemBulkShiftDatesInputWire, idempotencyKey: string)` (signature gains the second parameter).

- [ ] **Step 1: Update `api-client.ts`**

In `apps/web/src/lib/api-client.ts`, find the `bulkShiftDates` entry under `items:` and change it to accept and send the key:

```ts
    bulkShiftDates: (input: ItemBulkShiftDatesInputWire, idempotencyKey: string) =>
      request(
        '/api/items/bulk-shift-dates',
        {
          method: 'POST',
          body: JSON.stringify(input),
          headers: { 'Idempotency-Key': idempotencyKey },
        },
        itemBulkShiftDatesResponseSchema,
      ),
```

- [ ] **Step 2: Update the dialog to generate and reuse a key**

In `apps/web/src/components/clusters/item-dialogs/bulk-shift-dates-dialog.tsx`, add the import (alongside the other `@/lib/...` import):

```ts
import { generateUuidV4 } from '@/lib/uuid';
```

Inside the `BulkShiftDatesDialog` component, add a lazily-initialized key right after the existing `useState` declarations for `direction`/`unit`/`rawAmount`:

```ts
// One key per dialog instance: `items-tab.tsx` only mounts this dialog
// while `shiftOpen` is true, so a fresh open is a fresh mount and a fresh
// key — while a double-click on Apply, or a client-side retry, reuses the
// SAME key across attempts of the SAME action, which is exactly what
// makes the request safe to retry (#263).
const [idempotencyKey] = useState(() => generateUuidV4());
```

Then update the mutation's `mutationFn` to pass it through:

```ts
  const mutation = useMutation({
    mutationFn: (payload: ItemBulkShiftDatesInputWire) =>
      api.items.bulkShiftDates(payload, idempotencyKey),
    onSuccess: (result) => {
```

(Leave the rest of `onSuccess`/`onError` unchanged.)

- [ ] **Step 3: Update the existing test assertion**

In `apps/web/src/components/clusters/items-tab.test.tsx`, find the test `'sends one signed shift for the whole selection and clears it afterwards'` and update its `toHaveBeenCalledWith` assertion to expect the second argument:

```ts
await waitFor(() =>
  expect(bulkShift).toHaveBeenCalledWith(
    {
      itemIds: ['app-1', 'evt-1'],
      shift: { amount: -3, unit: 'months' },
    },
    expect.stringMatching(/^[0-9a-f-]{36}$/i),
  ),
);
```

- [ ] **Step 4: Run the affected tests**

Run: `pnpm --filter @lcm/web test -- items-tab.test.tsx`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @lcm/web typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/api-client.ts apps/web/src/components/clusters/item-dialogs/bulk-shift-dates-dialog.tsx apps/web/src/components/clusters/items-tab.test.tsx
git commit -m "feat(web): send Idempotency-Key on bulk-shift-dates requests"
```

---

### Task 9: Web — retention setting in the Settings UI

**Files:**

- Modify: `apps/web/src/components/settings/forecast-thresholds-form.tsx`
- Modify: `apps/web/src/components/settings/forecast-thresholds-form.test.tsx`

**Interfaces:**

- Consumes: `TenantSettings` (now includes `idempotencyKeyRetentionHours`), `api.settings.tenant.get`/`update`.
- Produces: a new labeled field in the existing tenant-settings form, submitted atomically with the other three fields on the same `PUT /settings/tenant` call — kept in the SAME form (not a sibling component) because `tenantSettingsSchema` is a `strictObject` requiring all four fields on every write; two independent forms editing the same resource could each clobber the other's in-flight edit.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/components/settings/forecast-thresholds-form.test.tsx`, update the two `vi.spyOn` mocks in `beforeEach` to include the new field:

```ts
beforeEach(() => {
  vi.spyOn(api.settings.tenant, 'get').mockResolvedValue({
    warnThreshold: 0.7,
    critThreshold: 0.9,
    procurementLeadTimeWeeks: 8,
    idempotencyKeyRetentionHours: 24,
  });
  vi.spyOn(api.settings.tenant, 'update').mockResolvedValue({
    warnThreshold: 0.65,
    critThreshold: 0.85,
    procurementLeadTimeWeeks: 6,
    idempotencyKeyRetentionHours: 12,
  });
});
```

Update the `'submits 0.65 / 0.85 when user enters 65 / 85'` test's expected call to include the field (since the update payload now always carries all four):

```ts
expect(api.settings.tenant.update).toHaveBeenCalledWith({
  warnThreshold: 0.65,
  critThreshold: 0.85,
  procurementLeadTimeWeeks: 8,
  idempotencyKeyRetentionHours: 24,
});
```

Add new tests after the existing ones (before the file's closing `});`):

```ts
  it('loads and displays the current retention hours', async () => {
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() => {
      expect(screen.getByLabelText(/idempotency key retention/i)).toHaveValue(24);
    });
  });

  it('submits an edited retention value alongside the unchanged thresholds', async () => {
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() => expect(screen.getByLabelText(/idempotency key retention/i)).toHaveValue(24));
    await userEvent.clear(screen.getByLabelText(/idempotency key retention/i));
    await userEvent.type(screen.getByLabelText(/idempotency key retention/i), '48');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(api.settings.tenant.update).toHaveBeenCalledWith({
        warnThreshold: 0.7,
        critThreshold: 0.9,
        procurementLeadTimeWeeks: 8,
        idempotencyKeyRetentionHours: 48,
      });
    });
  });

  it('shows inline error when retention hours is outside 1..168', async () => {
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() => expect(screen.getByLabelText(/idempotency key retention/i)).toHaveValue(24));
    await userEvent.clear(screen.getByLabelText(/idempotency key retention/i));
    await userEvent.type(screen.getByLabelText(/idempotency key retention/i), '200');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/1 (and|to) 168/i);
    expect(api.settings.tenant.update).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lcm/web test -- forecast-thresholds-form.test.tsx`
Expected: FAIL — no element matches `/idempotency key retention/i`, and the existing "submits" test's expected payload is missing from the actual call.

- [ ] **Step 3: Add the field to the form**

In `apps/web/src/components/settings/forecast-thresholds-form.tsx`, add state, derive the display value, extend the mutation payload, add validation, and render the input.

Add a new `useState` alongside `leadEdit`:

```ts
const [retentionEdit, setRetentionEdit] = React.useState<NumInput | null>(null);
```

Add the initial/derived value alongside `initialLead`/`leadWeeks`:

```ts
const initialRetention = settingsQuery.data?.idempotencyKeyRetentionHours ?? null;
const retentionHours: NumInput = retentionEdit ?? initialRetention ?? '';
```

Update the `mutation`'s `mutationFn` type to include the new field:

```ts
const mutation = useMutation({
  mutationFn: (input: {
    warnThreshold: number;
    critThreshold: number;
    procurementLeadTimeWeeks: number;
    idempotencyKeyRetentionHours: number;
  }) => api.settings.tenant.update(input),
  onSuccess: (data) => {
    queryClient.setQueryData(['tenant-settings'], data);
    void queryClient.invalidateQueries({ queryKey: ['forecast'] });
    void queryClient.invalidateQueries({ queryKey: ['cluster-settings'] });
    setWarnEdit(null);
    setCritEdit(null);
    setLeadEdit(null);
    setRetentionEdit(null);
  },
  onError: (err) => toast.error(describeApiError(err, 'Could not save settings')),
});
```

Update the `dirty` check to also compare the retention field:

```ts
const dirty =
  typeof warnPct === 'number' &&
  typeof critPct === 'number' &&
  typeof leadWeeks === 'number' &&
  typeof retentionHours === 'number' &&
  initialWarn !== null &&
  initialCrit !== null &&
  initialLead !== null &&
  initialRetention !== null &&
  (warnPct !== initialWarn ||
    critPct !== initialCrit ||
    leadWeeks !== initialLead ||
    retentionHours !== initialRetention);
```

Update `handleSubmit` to validate and submit the field:

```ts
const handleSubmit = (e: React.FormEvent): void => {
  e.preventDefault();
  setValidationError(null);
  if (typeof warnPct !== 'number' || typeof critPct !== 'number') return;
  if (typeof leadWeeks !== 'number') return;
  if (typeof retentionHours !== 'number') return;
  if (warnPct >= critPct) {
    setValidationError('Warn must be less than crit.');
    return;
  }
  if (warnPct < 1 || warnPct > 99 || critPct < 1 || critPct > 99) {
    setValidationError('Thresholds must be between 1% and 99%.');
    return;
  }
  if (!Number.isInteger(leadWeeks) || leadWeeks < 0 || leadWeeks > 104) {
    setValidationError('Procurement lead time must be a whole number from 0 to 104 weeks.');
    return;
  }
  if (!Number.isInteger(retentionHours) || retentionHours < 1 || retentionHours > 168) {
    setValidationError('Idempotency key retention must be a whole number from 1 to 168 hours.');
    return;
  }
  mutation.mutate({
    warnThreshold: warnPct / 100,
    critThreshold: critPct / 100,
    procurementLeadTimeWeeks: leadWeeks,
    idempotencyKeyRetentionHours: retentionHours,
  });
};
```

Finally, add the input in the JSX, right after the existing "Procurement lead time" `<label>` block and before the `{validationError ? ...}` block:

```tsx
<label className="block">
  <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
    Idempotency key retention (hours)
  </span>
  <Input
    type="number"
    min={1}
    max={168}
    step={1}
    aria-label="Idempotency key retention (hours)"
    value={retentionHours}
    onChange={(e) => setRetentionEdit(parseInput(e.target.value))}
    className="mt-1 w-24"
  />
  <span className="mt-1 block max-w-md text-[11px] text-fg-subtle">
    How long a bulk-shift retry key stays valid before a resubmission runs fresh. 1–168 hours (24
    default).
  </span>
</label>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @lcm/web test -- forecast-thresholds-form.test.tsx`
Expected: PASS (all tests, including the 3 new ones)

- [ ] **Step 5: Run the full web suite and typecheck**

Run: `pnpm --filter @lcm/web test && pnpm --filter @lcm/web typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/settings/forecast-thresholds-form.tsx apps/web/src/components/settings/forecast-thresholds-form.test.tsx
git commit -m "feat(web): expose idempotency key retention in tenant settings"
```

---

### Task 10: Full verification and PR

**Files:** none (verification only)

- [ ] **Step 1: Run the complete affected-component suite**

```bash
pnpm --filter @lcm/shared build
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: all green. `pnpm test` runs server integration tests against the Testcontainers Postgres (Docker required) and the web unit suite.

- [ ] **Step 2: Manual smoke check (golden path)**

With `pnpm db:dev:up` and `pnpm dev` running (`DATABASE_URL`/`PORT=8090` inline for the server per this machine's dev setup), open the app, select two or more application/event entries in a cluster's Items tab, open "Shift dates", and click Apply twice quickly (or click once, then click Apply again on the same still-open dialog if the first click is slow enough to observe). Confirm: the dates move by exactly the entered amount, not double; a second click before the dialog closes returns the same result rather than shifting further.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/263-bulk-shift-idempotency
gh pr create --base dev --title "feat(server,web): idempotency-key mechanism for bulk-shift-dates" --body "$(cat <<'EOF'
## Summary
- Adds a general, client-supplied idempotency-key mechanism (Idempotency-Key header) so POST /api/items/bulk-shift-dates is safe to retry
- New idempotency_keys table + TenantSettings.idempotencyKeyRetentionHours (default 24h, configurable in Settings), purged by an in-process cleanup timer
- Design: docs/superpowers/specs/2026-07-20-bulk-shift-idempotency-design.md

Closes #263

## Test plan
- [x] Server integration tests: replay, conflict, failure-retry, concurrent-duplicate, reordered-itemIds-same-hash (items-bulk-shift-idempotency.test.ts)
- [x] IdempotencyService and cleanup-timer unit/integration tests
- [x] Web: dialog sends a stable per-open key; Settings UI retention field
- [x] pnpm lint && pnpm typecheck && pnpm test && pnpm build all green

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: After merge — worktree cleanup**

Only after the PR is merged:

```bash
cd /Users/simon/Documents/localGIT/lifecycle-management
git worktree remove ../263-bulk-shift-idempotency
git branch -d feat/263-bulk-shift-idempotency
```
