# Merge Applications + Events into Unified Items — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Physically merge the `Application` and `Event` entities into one `items` table, surface them in a single "Apps & Events" cluster tab, and add a tenant-managed category list (creatable combobox + Settings card), with forecast output numerically unchanged.

**Architecture:** Reuse the `applications` table as the base for a new `items` table (rename in place; add a `kind` discriminator + nullable event columns), copy `events` rows in, drop `events`. The in-memory forecast shapes (`ForecastApplication`/`ForecastEvent`) are unchanged; only the loader changes (query `items`, partition by `kind`). Categories live in a new tenant-scoped `categories` table, upserted whenever an item is saved.

**Tech Stack:** pnpm monorepo · Fastify + Prisma (Postgres) · Zod (`@lcm/shared`) · React 19 + TanStack Query/Router + Tailwind v4 · Vitest.

**Spec:** `docs/superpowers/specs/2026-06-02-merge-apps-events-design.md`

---

## Conventions used throughout

- **Branch:** `feat/merge-apps-events` (already created).
- **Run a single server test:** `pnpm --filter @lcm/server test <pattern>`
- **Run a single shared test:** `pnpm --filter @lcm/shared test <pattern>`
- **Run a single web test:** `pnpm --filter @lcm/web test <pattern>`
- **DB for server tests** uses Testcontainers (spins up Postgres) — Docker must be running.
- **Category display-name map** (events → managed category name), used in the migration and the xlsx importer:
  `growth→Growth`, `hardware_change→Hardware`, `openshift→OpenShift`, `note→Note`.
- **ItemKind** values are the strings `application` and `event`.

---

## File Structure

**Shared (`packages/shared/src`)**

- Create `schemas/item.ts` — item kind enum, create/update discriminated unions, `ItemResponse`, wire helpers.
- Create `schemas/category.ts` — category create input + `CategoryResponse`.
- Delete `schemas/application.ts`, `schemas/event.ts` (types fold into `item.ts`).
- Modify `index.ts` — swap exports.
- Modify `schemas/forecast.ts` — `ForecastEventOutput.category` enum → `string` (if referenced there; otherwise the server-side interface).

**Server (`apps/server`)**

- Modify `prisma/schema.prisma` — `Item`, `ItemAllocation`, `Category` models; `ItemKind` enum; drop `Event`/`EventCategory`.
- Create `prisma/migrations/<ts>_merge_items/migration.sql` — hand-authored rename + backfill.
- Create `src/services/items.ts` — `ItemsService`.
- Create `src/services/categories.ts` — `CategoriesService`.
- Delete `src/services/applications.ts`, `src/services/events.ts`.
- Modify `src/services/forecast-loader.ts` — load `items`, partition by kind.
- Modify `src/services/forecast.ts` — `ForecastEvent.category`/`ForecastEventOutput.category` → `string`.
- Modify `src/services/scenario.ts` — none expected (uses `ForecastApplication`); verify only.
- Create `src/routes/items.ts`, `src/routes/categories.ts`; delete `src/routes/applications.ts`, `src/routes/events.ts`; modify route registration (find where routes register).
- Modify `prisma/seed.ts` (seed default categories) and `scripts/import-xlsx.ts` (write items).
- Tests: create `src/__tests__/items.test.ts`, `src/__tests__/categories.test.ts`; delete `applications.test.ts`, `events.test.ts`; update `forecast.test.ts`, `forecast-endpoint.test.ts`, `scenario.test.ts`, `forecast-projection.test.ts` where they build apps/events.

**Web (`apps/web/src`)**

- Modify `lib/api-client.ts` — replace `applications`/`events` clients with `items` + `settings.categories`.
- Create `components/clusters/items-tab.tsx` — merged table.
- Create `components/clusters/item-dialogs.tsx` — unified create/edit/resize/end/delete + category combobox.
- Delete `components/clusters/applications-tab.tsx`, `events-tab.tsx`, `application-dialogs.tsx`, `event-dialogs.tsx`.
- Modify `routes/clusters.$id.tsx` — one tab instead of two.
- Modify `components/clusters/forecast-chart.tsx` + `lib/use-chart-colors.ts` — name-keyed category colors.
- Create `components/settings/categories-form.tsx`; modify `routes/settings.tsx`.
- Tests alongside the new components.

---

## Phase A — Shared schemas

### Task A1: Item + category Zod schemas

**Files:**

- Create: `packages/shared/src/schemas/item.ts`
- Create: `packages/shared/src/schemas/category.ts`
- Test: `packages/shared/src/schemas/__tests__/item.test.ts`

- [ ] **Step 1: Write the failing test** (`item.test.ts`)

```ts
import { describe, expect, it } from 'vitest';

import { itemCreateInputSchema, categoryCreateInputSchema } from '../../index.js';

describe('itemCreateInputSchema', () => {
  it('accepts an application item with allocations', () => {
    const parsed = itemCreateInputSchema.safeParse({
      kind: 'application',
      name: 'ocp-lab',
      category: 'OpenShift',
      effectiveDate: '2026-01-01',
      allocations: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-01-01', amount: 512 }],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an event item with no deltas (pure annotation)', () => {
    const parsed = itemCreateInputSchema.safeParse({
      kind: 'event',
      name: 'Migration note',
      category: 'Note',
      effectiveDate: '2026-02-01',
      metricTypeKey: 'memory_gb',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an application without allocations', () => {
    const parsed = itemCreateInputSchema.safeParse({
      kind: 'application',
      name: 'x',
      category: 'c',
      effectiveDate: '2026-01-01',
      allocations: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('categoryCreateInputSchema', () => {
  it('trims and requires a name', () => {
    expect(categoryCreateInputSchema.safeParse({ name: '  Growth ' }).success).toBe(true);
    expect(categoryCreateInputSchema.safeParse({ name: '' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lcm/shared test item`
Expected: FAIL — module `item.js`/exports not found.

- [ ] **Step 3: Write `schemas/category.ts`**

```ts
import { z } from 'zod';

import { cuid } from './common.js';

export const categoryCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
});

export const categoryIdParamsSchema = z.object({ id: cuid });

export type CategoryCreateInput = z.infer<typeof categoryCreateInputSchema>;

export interface CategoryResponse {
  id: string;
  name: string;
}
```

- [ ] **Step 4: Write `schemas/item.ts`**

```ts
import { z } from 'zod';

import { cuid, dateOnly, positiveAmount } from './common.js';

export const itemKindSchema = z.enum(['application', 'event']);
export type ItemKind = z.infer<typeof itemKindSchema>;

const deltaNumber = z.number().finite();

export const itemAllocationRowInputSchema = z.object({
  metricTypeKey: z.string().min(1),
  effectiveFrom: dateOnly,
  amount: positiveAmount,
});

const baseFields = {
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(60),
  description: z.string().trim().max(2000).nullish(),
  effectiveDate: dateOnly,
};

export const applicationItemCreateSchema = z.object({
  kind: z.literal('application'),
  ...baseFields,
  endedAt: dateOnly.nullable().optional(),
  allocations: z.array(itemAllocationRowInputSchema).min(1),
});

export const eventItemCreateSchema = z.object({
  kind: z.literal('event'),
  ...baseFields,
  metricTypeKey: z.string().min(1),
  consumptionDelta: deltaNumber.nullable().optional(),
  capacityDelta: deltaNumber.nullable().optional(),
});

export const itemCreateInputSchema = z.discriminatedUnion('kind', [
  applicationItemCreateSchema,
  eventItemCreateSchema,
]);

// Update: kind is immutable, so it is NOT part of the body. All fields optional;
// the service applies them based on the stored kind.
export const itemUpdateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    category: z.string().trim().min(1).max(60).optional(),
    description: z.string().trim().max(2000).nullish(),
    effectiveDate: dateOnly.optional(),
    endedAt: dateOnly.nullable().optional(),
    metricTypeKey: z.string().min(1).optional(),
    consumptionDelta: deltaNumber.nullable().optional(),
    capacityDelta: deltaNumber.nullable().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });

export const itemIdParamsSchema = z.object({ id: cuid });
export const clusterIdItemsParamsSchema = z.object({ clusterId: cuid });

export type ItemCreateInput = z.infer<typeof itemCreateInputSchema>;
export type ItemUpdateInput = z.infer<typeof itemUpdateInputSchema>;
export type ItemAllocationRowInput = z.infer<typeof itemAllocationRowInputSchema>;

export interface ItemAllocationResponseRow {
  id: string;
  metricTypeKey: string;
  metricTypeDisplayName: string;
  unit: string;
  effectiveFrom: string;
  amount: number;
}

export interface ItemResponse {
  id: string;
  clusterId: string;
  kind: ItemKind;
  name: string;
  category: string;
  description: string | null;
  effectiveDate: string;
  endedAt: string | null;
  // event-only (null for applications)
  metricTypeKey: string | null;
  consumptionDelta: number | null;
  capacityDelta: number | null;
  // application-only (empty for events)
  allocations: ItemAllocationResponseRow[];
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 5: Swap exports in `packages/shared/src/index.ts`**

Replace the `application.js` and `event.js` export lines with:

```ts
export * from './schemas/item.js';
export * from './schemas/category.js';
```

- [ ] **Step 6: Delete old schema files**

```bash
git rm packages/shared/src/schemas/application.ts packages/shared/src/schemas/event.ts
```

(There will be downstream type errors until later tasks land — that's expected. Do not fix server/web imports yet.)

- [ ] **Step 7: Run the shared test + build**

Run: `pnpm --filter @lcm/shared test item` → PASS
Run: `pnpm --filter @lcm/shared build` → expect PASS (shared has no dangling refs to the deleted files; if `schemas.test.ts` referenced them, update it now).

- [ ] **Step 8: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add item + category schemas, drop application/event schemas"
```

---

## Phase B — Database (schema, migration, seed)

### Task B1: Prisma schema — Item, ItemAllocation, Category

**Files:**

- Modify: `apps/server/prisma/schema.prisma`

- [ ] **Step 1: Add the `ItemKind` enum and replace the `Application`/`ApplicationMetricAllocation`/`Event` models.** Edit `schema.prisma`:

Replace the `enum EventCategory { ... }` block and the `Application`, `ApplicationMetricAllocation`, and `Event` models with:

```prisma
enum ItemKind {
  application
  event

  @@map("item_kind")
}

model Item {
  id               String    @id @default(cuid())
  tenantId         String    @default("default") @map("tenant_id")
  clusterId        String    @map("cluster_id")
  kind             ItemKind  @default(application)
  name             String
  category         String
  description      String?
  effectiveDate    DateTime  @map("effective_date") @db.Date
  endedAt          DateTime? @map("ended_at") @db.Date
  metricTypeId     String?   @map("metric_type_id")
  consumptionDelta Decimal?  @map("consumption_delta") @db.Decimal(18, 3)
  capacityDelta    Decimal?  @map("capacity_delta") @db.Decimal(18, 3)
  createdAt        DateTime  @default(now()) @map("created_at")
  updatedAt        DateTime  @updatedAt @map("updated_at")

  tenant      Tenant            @relation(fields: [tenantId], references: [id])
  cluster     Cluster           @relation(fields: [clusterId], references: [id], onDelete: Cascade)
  metricType  MetricType?       @relation(fields: [metricTypeId], references: [id])
  allocations ItemAllocation[]

  @@index([clusterId])
  @@index([clusterId, effectiveDate])
  @@map("items")
}

model ItemAllocation {
  id            String   @id @default(cuid())
  itemId        String   @map("item_id")
  metricTypeId  String   @map("metric_type_id")
  tenantId      String   @default("default") @map("tenant_id")
  effectiveFrom DateTime @map("effective_from") @db.Date
  amount        Decimal  @db.Decimal(18, 3)
  createdAt     DateTime @default(now()) @map("created_at")

  item       Item       @relation(fields: [itemId], references: [id], onDelete: Cascade)
  metricType MetricType @relation(fields: [metricTypeId], references: [id])
  tenant     Tenant     @relation(fields: [tenantId], references: [id])

  @@unique([itemId, metricTypeId, effectiveFrom])
  @@map("item_allocations")
}

model Category {
  id        String   @id @default(cuid())
  tenantId  String   @default("default") @map("tenant_id")
  name      String
  createdAt DateTime @default(now()) @map("created_at")

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, name], map: "categories_tenant_name_unique")
  @@map("categories")
}
```

- [ ] **Step 2: Fix the relation lists on `Tenant`, `Cluster`, `MetricType`.**
  - `Tenant`: replace `applications Application[]`, `appAllocations ApplicationMetricAllocation[]`, `events Event[]` with `items Item[]`, `itemAllocations ItemAllocation[]`, `categories Category[]`.
  - `Cluster`: replace `applications Application[]` and `events Event[]` with `items Item[]`.
  - `MetricType`: replace `appAllocations ApplicationMetricAllocation[]` and `events Event[]` with `itemAllocations ItemAllocation[]` and `items Item[]`.

- [ ] **Step 3: Verify schema validity**

Run: `pnpm --filter @lcm/server exec prisma validate`
Expected: "The schema at prisma/schema.prisma is valid 🚀"

- [ ] **Step 4: Commit (schema only; migration next)**

```bash
git add apps/server/prisma/schema.prisma
git commit -m "feat(server): unify Item/ItemAllocation/Category in Prisma schema"
```

### Task B2: Hand-authored backfill migration

**Files:**

- Create: `apps/server/prisma/migrations/20260602120000_merge_items/migration.sql`

> Use a fixed timestamp folder name `20260602120000_merge_items` (Date.now() is not available; pick a value strictly greater than the latest existing migration `20260528163044_...`).

- [ ] **Step 1: Write the migration SQL**

```sql
-- 1. New enum
CREATE TYPE "item_kind" AS ENUM ('application', 'event');

-- 2. Rename applications -> items, allocations table + FK column
ALTER TABLE "applications" RENAME TO "items";
ALTER TABLE "application_metric_allocations" RENAME TO "item_allocations";
ALTER TABLE "item_allocations" RENAME COLUMN "application_id" TO "item_id";

-- 3. Reshape items
ALTER TABLE "items" RENAME COLUMN "started_at" TO "effective_date";
ALTER TABLE "items" ADD COLUMN "kind" "item_kind" NOT NULL DEFAULT 'application';
ALTER TABLE "items" ADD COLUMN "metric_type_id" TEXT;
ALTER TABLE "items" ADD COLUMN "consumption_delta" DECIMAL(18,3);
ALTER TABLE "items" ADD COLUMN "capacity_delta" DECIMAL(18,3);
ALTER TABLE "items"
  ADD CONSTRAINT "items_metric_type_id_fkey"
  FOREIGN KEY ("metric_type_id") REFERENCES "metric_types"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Copy events into items (reuse the event id)
INSERT INTO "items" (
  "id", "tenant_id", "cluster_id", "kind", "category", "name", "description",
  "effective_date", "ended_at", "metric_type_id", "consumption_delta",
  "capacity_delta", "created_at", "updated_at"
)
SELECT
  e."id", e."tenant_id", e."cluster_id", 'event'::"item_kind",
  CASE e."category"
    WHEN 'growth' THEN 'Growth'
    WHEN 'hardware_change' THEN 'Hardware'
    WHEN 'openshift' THEN 'OpenShift'
    WHEN 'note' THEN 'Note'
    ELSE e."category"::text
  END,
  e."title", e."description", e."effective_date", NULL, e."metric_type_id",
  e."consumption_delta", e."capacity_delta", e."created_at", e."updated_at"
FROM "events" e;

-- 5. Indexes to match the schema
CREATE INDEX "items_cluster_id_effective_date_idx" ON "items" ("cluster_id", "effective_date");

-- 6. Categories table
CREATE TABLE "categories" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL DEFAULT 'default',
  "name" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "categories_tenant_name_unique" ON "categories" ("tenant_id", "name");
ALTER TABLE "categories"
  ADD CONSTRAINT "categories_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 7. Seed categories: every distinct category in use, per tenant
INSERT INTO "categories" ("id", "tenant_id", "name")
SELECT gen_random_uuid()::text, i."tenant_id", i."category"
FROM (SELECT DISTINCT "tenant_id", "category" FROM "items") i
ON CONFLICT ("tenant_id", "name") DO NOTHING;

-- 8. Always-available canonical event names for every tenant that has items
INSERT INTO "categories" ("id", "tenant_id", "name")
SELECT gen_random_uuid()::text, t."tenant_id", c."name"
FROM (SELECT DISTINCT "tenant_id" FROM "items") t
CROSS JOIN (VALUES ('Growth'), ('Hardware'), ('OpenShift'), ('Note')) AS c("name")
ON CONFLICT ("tenant_id", "name") DO NOTHING;

-- 9. Drop the default on kind now that rows are populated
ALTER TABLE "items" ALTER COLUMN "kind" DROP DEFAULT;

-- 10. Drop the old events table + enum
DROP TABLE "events";
DROP TYPE "event_category";
```

> Note: `items_cluster_id_idx` already exists from the old `applications` `@@index([clusterId])` (Prisma named it `applications_cluster_id_idx`). After the table rename Postgres keeps the old index name. Add a rename so `migrate diff` is clean:
> `ALTER INDEX "applications_cluster_id_idx" RENAME TO "items_cluster_id_idx";`
> Also rename the allocations unique index/constraint if `prisma migrate diff` flags it (see Step 3).

- [ ] **Step 2: Apply the migration to a fresh dev DB**

```bash
pnpm db:dev:up
pnpm --filter @lcm/server exec prisma migrate reset --force   # applies all migrations incl. this one
```

Expected: completes without error; `items`, `item_allocations`, `categories` exist; no `events`.

- [ ] **Step 3: Verify the schema matches the migration history**

Run: `pnpm --filter @lcm/server exec prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$DATABASE_URL" --exit-code`
Expected: exit code 0 (no drift). If it reports renamed indexes/constraints, add matching `ALTER INDEX ... RENAME` / `ALTER TABLE ... RENAME CONSTRAINT` lines to the migration and re-run Step 2.

- [ ] **Step 4: Regenerate the Prisma client**

Run: `pnpm --filter @lcm/server exec prisma generate`

- [ ] **Step 5: Commit**

```bash
git add apps/server/prisma/migrations
git commit -m "feat(server): backfill migration merging events into items"
```

### Task B3: Seed default categories + fix xlsx importer

**Files:**

- Modify: `apps/server/prisma/seed.ts`
- Modify: `apps/server/scripts/import-xlsx.ts`

- [ ] **Step 1:** In `seed.ts`, after the tenant is ensured, upsert the four canonical categories for the default tenant:

```ts
const DEFAULT_CATEGORIES = ['Growth', 'Hardware', 'OpenShift', 'Note'];
for (const name of DEFAULT_CATEGORIES) {
  await prisma.category.upsert({
    where: { tenantId_name: { tenantId: 'default', name } },
    create: { tenantId: 'default', name },
    update: {},
  });
}
```

- [ ] **Step 2:** In `import-xlsx.ts`, change the event write to an item write. Replace `tx.event.deleteMany({ where: { clusterId } })` with `tx.item.deleteMany({ where: { clusterId, kind: 'event' } })`, and `tx.event.createMany({ data: ... })` with `tx.item.createMany`, mapping each event:

```ts
data: parsedCluster.events.map((ev) => ({
  tenantId,
  clusterId,
  kind: 'event' as const,
  metricTypeId,
  effectiveDate: ev.effectiveDate,
  category: CATEGORY_DISPLAY[ev.category] ?? ev.category,
  name: ev.title,
  description: ev.description ?? null,
  consumptionDelta: ev.consumptionDelta == null ? null : new Prisma.Decimal(ev.consumptionDelta),
  capacityDelta: ev.capacityDelta == null ? null : new Prisma.Decimal(ev.capacityDelta),
})),
```

Add near the top: `const CATEGORY_DISPLAY: Record<string, string> = { growth: 'Growth', hardware_change: 'Hardware', openshift: 'OpenShift', note: 'Note' };`
After the import loop, upsert any new category names into `categories` (mirror the seed upsert for the distinct set used). Update the `console.log` strings from "events" to "events" is fine, but adjust `tx.event` references only.

- [ ] **Step 3: Run seed against the reset DB**

Run: `pnpm seed`
Expected: completes; `select count(*) from categories;` ≥ 4.

- [ ] **Step 4: Commit**

```bash
git add apps/server/prisma/seed.ts apps/server/scripts/import-xlsx.ts
git commit -m "feat(server): seed default categories; xlsx importer writes items"
```

---

## Phase C — Server services + forecast loader

### Task C1: CategoriesService (list/create/delete with block-in-use)

**Files:**

- Create: `apps/server/src/services/categories.ts`
- Test: `apps/server/src/__tests__/categories.test.ts`

- [ ] **Step 1: Write the failing route/service test** (`categories.test.ts`) — follow the existing pattern in `apps/server/src/__tests__/applications.test.ts` for app/server bootstrapping (build the Fastify app, seed a tenant + cluster). Cover:

```ts
// pseudocode of assertions — mirror applications.test.ts harness
it('lists seeded categories', async () => {
  /* GET /api/settings/categories -> array contains 'Growth' */
});
it('creates a category (idempotent)', async () => {
  /* POST {name:'Database'} twice -> 1 row */
});
it('blocks delete when in use', async () => {
  // create an item with category 'Database', then DELETE that category -> 409 with usageCount: 1
});
it('deletes an unused category', async () => {
  /* 204 */
});
```

- [ ] **Step 2: Run → FAIL** (`pnpm --filter @lcm/server test categories`).

- [ ] **Step 3: Implement `CategoriesService`**

```ts
import type { CategoryResponse } from '@lcm/shared';
import { Prisma, type PrismaClient } from '@prisma/client';

import { ConflictError, NotFoundError } from './errors.js';

export class CategoriesService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(tenantId: string): Promise<CategoryResponse[]> {
    const rows = await this.prisma.category.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => ({ id: r.id, name: r.name }));
  }

  /** Idempotent: returns the existing row if the name already exists. */
  async create(tenantId: string, name: string): Promise<CategoryResponse> {
    const row = await this.prisma.category.upsert({
      where: { tenantId_name: { tenantId, name } },
      create: { tenantId, name },
      update: {},
    });
    return { id: row.id, name: row.name };
  }

  /** Used by ItemsService on save to keep the managed list in sync. */
  async ensure(tenantId: string, name: string): Promise<void> {
    await this.prisma.category.upsert({
      where: { tenantId_name: { tenantId, name } },
      create: { tenantId, name },
      update: {},
    });
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const category = await this.prisma.category.findFirst({ where: { id, tenantId } });
    if (!category) throw new NotFoundError('Category', id);
    const usageCount = await this.prisma.item.count({
      where: { tenantId, category: category.name },
    });
    if (usageCount > 0) {
      throw new ConflictError(
        'CATEGORY_IN_USE',
        `Category "${category.name}" is used by ${usageCount} item(s). Reassign them first.`,
      );
    }
    await this.prisma.category.delete({ where: { id } });
  }
}
```

> Confirm `ConflictError` carries a machine code; if the error envelope can include details, attach `{ usageCount }` so the web layer can show the number. Check `src/services/errors.ts` and `src/plugins/*` error serializer.

- [ ] **Step 4: Run → PASS. Step 5: Commit** `feat(server): CategoriesService with block-on-delete-in-use`.

### Task C2: ItemsService (CRUD + allocation append + category upsert)

**Files:**

- Create: `apps/server/src/services/items.ts`
- Delete: `apps/server/src/services/applications.ts`, `apps/server/src/services/events.ts`
- Test: `apps/server/src/__tests__/items.test.ts` (port the meaningful cases from `applications.test.ts` + `events.test.ts`)

- [ ] **Step 1: Write the failing `items.test.ts`** porting: create application item, create event item (incl. zero-delta annotation now allowed), list returns both kinds date-sorted, update name/category, append allocation (application only; event → 422), delete, and **category is auto-added on create** (after creating an item with a brand-new category, `GET /settings/categories` includes it).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `ItemsService`.** Mirror the two old services, unified by `kind`. Key points:
  - `listByCluster`: `findMany({ where: { tenantId, clusterId }, include: { allocations: { include: { metricType: true } }, metricType: true }, orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }] })`.
  - `create`: switch on `input.kind`.
    - `application`: same allocation validation as the old `ApplicationsService.create` (reuse `validateInitialAllocations`, `resolveMetricTypes`), write `kind: 'application'`, `effectiveDate: input.effectiveDate`, `endedAt`, allocations via `allocations: { create: [...] }`. `metricTypeId` stays null on the item.
    - `event`: resolve `input.metricTypeKey`, write `kind: 'event'`, `metricTypeId`, deltas; **no note-only rule** (zero deltas allowed).
    - After a successful write, call `categoriesService.ensure(tenantId, input.category)`.
  - `update`: load existing (need `kind`). Apply common fields; allocation/`endedAt` changes only valid for `application`; delta/`metricTypeKey` changes only valid for `event` (422 `WRONG_KIND_FIELD` otherwise). On category change, `ensure` the new name.
  - `appendAllocation`: 422 `NOT_AN_APPLICATION` if `kind !== 'application'`; otherwise identical logic to the old `appendAllocation` (monotonic/effective checks) against `itemAllocation`.
  - `delete`: `item.deleteMany({ where: { id, tenantId } })`.
  - `toResponse(row)`: map to `ItemResponse` — `kind`, `effectiveDate`/`endedAt` via `formatDate`, `metricTypeKey: row.metricType?.key ?? null`, deltas via `?.toNumber() ?? null`, `allocations` mapped as in the old service (empty array for events).

  Construct the service with both prisma and a `CategoriesService` (or instantiate internally: `private readonly categories = new CategoriesService(this.prisma)`).

- [ ] **Step 4: Run → PASS. Step 5: Commit** `feat(server): ItemsService unifying applications + events`.

### Task C3: Forecast loader + forecast type change

**Files:**

- Modify: `apps/server/src/services/forecast.ts` (interface only)
- Modify: `apps/server/src/services/forecast-loader.ts`
- Test: `apps/server/src/services/__tests__/forecast-loader.partition.test.ts` (new) + run existing forecast tests

- [ ] **Step 1:** In `forecast.ts`, change `ForecastEvent.category: EventCategory` → `category: string` and `ForecastEventOutput.category: EventCategory` → `category: string`. Remove the now-unused `EventCategory` import if present.

- [ ] **Step 2: Write a failing loader partition test** asserting that a cluster with one application item (with allocations) and one event item produces a `ForecastInput` whose `applications` has the app (with allocations) and whose `events` has the event (with deltas + string category). Build via the Testcontainers harness used by `forecast-endpoint.test.ts`.

- [ ] **Step 3: Rewrite `prepare()` in `forecast-loader.ts`.** Replace the `applications: { include: ... }` and `events: { where ... }` includes with a single `items` include:

```ts
items: {
  where: { OR: [{ metricTypeId: metricType.id }, { metricTypeId: null }] },
  include: { allocations: { where: { metricTypeId: metricType.id } } },
},
```

Then partition:

```ts
const applications: ForecastApplication[] = cluster.items
  .filter((it) => it.kind === 'application')
  .map((app) => ({
    id: app.id,
    name: app.name,
    startedAt: app.effectiveDate,
    endedAt: app.endedAt,
    allocations: app.allocations.map((a) => ({
      effectiveFrom: a.effectiveFrom,
      amount: a.amount.toNumber(),
    })),
  }));

const events: ForecastEvent[] = cluster.items
  .filter((it) => it.kind === 'event' && it.metricTypeId === metricType.id)
  .map((e) => ({
    id: e.id,
    effectiveDate: e.effectiveDate,
    category: e.category,
    title: e.name,
    description: e.description,
    consumptionDelta: e.consumptionDelta?.toNumber() ?? null,
    capacityDelta: e.capacityDelta?.toNumber() ?? null,
  }));
```

Remove the `EventCategory` import/cast. Everything downstream (`computeForecast`) is unchanged.

- [ ] **Step 4: Run loader test + the full forecast suite**

Run: `pnpm --filter @lcm/server test forecast`
Expected: PASS. This is the **forecast-parity gate** — `forecast.test.ts` and `forecast-endpoint.test.ts` assert the numbers; they must stay green (update only the fixture-building code that used `prisma.application`/`prisma.event` to use `prisma.item`, not the expected outputs).

- [ ] **Step 5: Commit** `feat(server): load forecast from unified items; category is now string`.

### Task C4: Routes — items + categories; remove old routes

**Files:**

- Create: `apps/server/src/routes/items.ts`, `apps/server/src/routes/categories.ts`
- Delete: `apps/server/src/routes/applications.ts`, `apps/server/src/routes/events.ts`
- Modify: route registration site (grep `applicationsRoutes`/`eventsRoutes` to find it, likely `src/app.ts` or `src/routes/index.ts`)
- Delete: `apps/server/src/__tests__/applications.test.ts`, `events.test.ts`

- [ ] **Step 1:** Write `routes/items.ts` mirroring the old applications+events routes:

```ts
import type { FastifyPluginAsync } from 'fastify';

import {
  clusterIdItemsParamsSchema,
  itemCreateInputSchema,
  itemIdParamsSchema,
  itemUpdateInputSchema,
  itemAllocationRowInputSchema,
} from '@lcm/shared';

import { ItemsService } from '../services/items.js';

export const itemsRoutes: FastifyPluginAsync = async (fastify) => {
  const service = new ItemsService(fastify.prisma);

  fastify.get('/clusters/:clusterId/items', async (request) => {
    const { clusterId } = clusterIdItemsParamsSchema.parse(request.params);
    return service.listByCluster(request.tenantId, clusterId);
  });

  fastify.post('/clusters/:clusterId/items', async (request, reply) => {
    const { clusterId } = clusterIdItemsParamsSchema.parse(request.params);
    const input = itemCreateInputSchema.parse(request.body);
    const created = await service.create(request.tenantId, clusterId, input);
    reply.code(201);
    return created;
  });

  fastify.patch('/items/:id', async (request) => {
    const { id } = itemIdParamsSchema.parse(request.params);
    const input = itemUpdateInputSchema.parse(request.body);
    return service.update(request.tenantId, id, input);
  });

  fastify.post('/items/:id/allocations', async (request, reply) => {
    const { id } = itemIdParamsSchema.parse(request.params);
    const input = itemAllocationRowInputSchema.parse(request.body);
    const updated = await service.appendAllocation(request.tenantId, id, input);
    reply.code(201);
    return updated;
  });

  fastify.delete('/items/:id', async (request, reply) => {
    const { id } = itemIdParamsSchema.parse(request.params);
    await service.delete(request.tenantId, id);
    reply.code(204);
  });
};
```

- [ ] **Step 2:** Write `routes/categories.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify';

import { categoryCreateInputSchema, categoryIdParamsSchema } from '@lcm/shared';

import { CategoriesService } from '../services/categories.js';

export const categoriesRoutes: FastifyPluginAsync = async (fastify) => {
  const service = new CategoriesService(fastify.prisma);

  fastify.get('/settings/categories', async (request) => service.list(request.tenantId));

  fastify.post('/settings/categories', async (request, reply) => {
    const input = categoryCreateInputSchema.parse(request.body);
    const created = await service.create(request.tenantId, input.name);
    reply.code(201);
    return created;
  });

  fastify.delete('/settings/categories/:id', async (request, reply) => {
    const { id } = categoryIdParamsSchema.parse(request.params);
    await service.delete(request.tenantId, id);
    reply.code(204);
  });
};
```

- [ ] **Step 3:** Update the registration site: remove `applicationsRoutes`/`eventsRoutes` registrations, add `itemsRoutes` and `categoriesRoutes` (same `register(... )` style + prefix as the others — match the existing pattern exactly).

- [ ] **Step 4:** `git rm` the old route + test files. Run `pnpm --filter @lcm/server test` (full suite) and fix any remaining imports.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @lcm/server typecheck` → PASS

```bash
git add apps/server
git commit -m "feat(server): items + categories routes; remove applications/events routes"
```

---

## Phase D — Web data layer

### Task D1: api-client — items + categories

**Files:**

- Modify: `apps/web/src/lib/api-client.ts`

- [ ] **Step 1:** Remove the `ApplicationResponse`/`EventResponse`/`EventCategory` imports; import `ItemResponse`, `CategoryResponse` from `@lcm/shared`. Remove the `Application*`/`Event*` wire interfaces; add:

```ts
export type ItemCreateInputWire =
  | {
      kind: 'application';
      name: string;
      category: string;
      description?: string;
      effectiveDate: string;
      endedAt?: string | null;
      allocations: Array<{ metricTypeKey: string; effectiveFrom: string; amount: number }>;
    }
  | {
      kind: 'event';
      name: string;
      category: string;
      description?: string;
      effectiveDate: string;
      metricTypeKey: string;
      consumptionDelta?: number | null;
      capacityDelta?: number | null;
    };

export interface ItemUpdateInputWire {
  name?: string;
  category?: string;
  description?: string | null;
  effectiveDate?: string;
  endedAt?: string | null;
  metricTypeKey?: string;
  consumptionDelta?: number | null;
  capacityDelta?: number | null;
}

export interface ItemAllocationAppendInputWire {
  metricTypeKey: string;
  effectiveFrom: string;
  amount: number;
}
```

- [ ] **Step 2:** Replace the `applications` and `events` blocks in `api` with one `items` block and add `settings.categories`:

```ts
items: {
  listByCluster: (clusterId: string) =>
    request<ItemResponse[]>(`/api/clusters/${clusterId}/items`),
  create: (clusterId: string, input: ItemCreateInputWire) =>
    request<ItemResponse>(`/api/clusters/${clusterId}/items`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  update: (id: string, input: ItemUpdateInputWire) =>
    request<ItemResponse>(`/api/items/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  appendAllocation: (id: string, input: ItemAllocationAppendInputWire) =>
    request<ItemResponse>(`/api/items/${id}/allocations`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  delete: (id: string) => request<void>(`/api/items/${id}`, { method: 'DELETE' }),
},
```

In `settings`, add:

```ts
categories: {
  list: () => request<CategoryResponse[]>('/api/settings/categories'),
  create: (name: string) =>
    request<CategoryResponse>('/api/settings/categories', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  delete: (id: string) =>
    request<void>(`/api/settings/categories/${id}`, { method: 'DELETE' }),
},
```

- [ ] **Step 3: Commit** `feat(web): items + categories api client` (web typecheck will fail until the tabs are migrated — that's fine; commit the client alone).

---

## Phase E — Web UI: merged tab + dialogs

### Task E1: Category combobox + name-keyed colors

**Files:**

- Modify: `apps/web/src/lib/use-chart-colors.ts` — make the event color lookup tolerate arbitrary strings (keep the four known keys; deterministic fallback by hashing the name into the existing palette).
- Modify: `apps/web/src/components/clusters/forecast-chart.tsx` — `category` is now `string`; replace the `categoryLabel` switch with identity (names are already display-ready), and index colors via a helper `eventColor(colors, category)` that falls back.
- Create: `apps/web/src/components/clusters/category-combobox.tsx` — a labeled `<input list>` + `<datalist>`.

- [ ] **Step 1:** Implement `category-combobox.tsx`:

```tsx
import { useId } from 'react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  categories: string[];
  error?: string;
  label?: string;
}

export function CategoryCombobox({
  value,
  onChange,
  categories,
  error,
  label = 'Category',
}: Props) {
  const listId = useId();
  return (
    <label className="block">
      <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
        {label}
      </span>
      <input
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
        placeholder="Pick or type a new category"
      />
      <datalist id={listId}>
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      {error ? <span className="mt-1 block text-sm text-destructive">{error}</span> : null}
    </label>
  );
}
```

> Match the exact `Input`/`Field` styling already used in `application-dialogs.tsx` so it looks native — read `components/form/field.tsx` and `components/ui/input.tsx` and reuse those classes/components rather than the literal classes above if they differ.

- [ ] **Step 2:** Update `use-chart-colors.ts` + `forecast-chart.tsx` so the chart compiles with `category: string`. Add a test or run the existing `forecast-chart.test.tsx` to confirm.

- [ ] **Step 3: Commit** `feat(web): category combobox + string-tolerant chart colors`.

### Task E2: Unified item dialogs

**Files:**

- Create: `apps/web/src/components/clusters/item-dialogs.tsx`
- Delete: `apps/web/src/components/clusters/application-dialogs.tsx`, `event-dialogs.tsx`

- [ ] **Step 1:** Build `CreateItemDialog` with a `kind` segmented toggle (`Application | Event`). When `application`: fields = name, category (combobox), description, effectiveDate ("Started at"), initial allocation amount. When `event`: fields = name ("Title"), category (combobox), description, effectiveDate, consumptionDelta, capacityDelta (`metricTypeKey` defaults to `'memory_gb'`). Validate with `itemCreateInputSchema`. Load categories via `useQuery(['categories'], api.settings.categories.list)` and pass names to the combobox. On success invalidate `['items', clusterId]`, `['forecast', clusterId]`, and `['categories']`.
- [ ] **Step 2:** Build `EditItemDialog` (kind locked; shows kind-appropriate fields), `ResizeItemDialog` + `EndItemDialog` (application only), `DeleteItemDialog`. Port logic from the old dialog files, swapping `api.applications.*`/`api.events.*` → `api.items.*` and `startedAt` → `effectiveDate`.
- [ ] **Step 3:** `git rm` the two old dialog files. Commit `feat(web): unified item dialogs with kind toggle`.

### Task E3: Merged Items tab + wire into cluster page

**Files:**

- Create: `apps/web/src/components/clusters/items-tab.tsx`
- Delete: `apps/web/src/components/clusters/applications-tab.tsx`, `events-tab.tsx`
- Modify: `apps/web/src/routes/clusters.$id.tsx`
- Test: `apps/web/src/components/clusters/items-tab.test.tsx`

- [ ] **Step 1: Write a failing render test** — given a mocked `api.items.listByCluster` returning one application item and one event item, the table renders both names, a Type badge for each, and the category badges.
- [ ] **Step 2:** Implement `items-tab.tsx`: one `Card` + `Table` with headers `Date · Type · Category · Name · Amount/Δ · Actions`. Rows sorted by `effectiveDate`. For `application` rows: keep the expand chevron + `AllocationTimeline` (port from `applications-tab.tsx`), `Amount/Δ` = latest allocation `formatGb`. For `event` rows: `Amount/Δ` shows consumption/capacity deltas (port the event cell rendering). Row actions adapt: application → resize/end/edit/delete; event → edit/delete. Use a single `<Badge>` for `Type` and the name-keyed variant helper for `Category`.
- [ ] **Step 3:** In `clusters.$id.tsx`: replace the two `TabsTrigger`s + two `TabsContent`s with one `TabsTrigger value="items">Apps & Events` and one `TabsContent value="items"><ItemsTab clusterId={id} /></TabsContent>`. Update `defaultValue` if it was `applications`/`events`.
- [ ] **Step 4: Run web test → PASS; typecheck `pnpm --filter @lcm/web typecheck`.** Commit `feat(web): merged Apps & Events tab`.

---

## Phase F — Web UI: Settings categories card

### Task F1: Categories management card

**Files:**

- Create: `apps/web/src/components/settings/categories-form.tsx`
- Modify: `apps/web/src/routes/settings.tsx`
- Test: `apps/web/src/components/settings/categories-form.test.tsx`

- [ ] **Step 1: Write a failing test** — renders the seeded categories; typing a name + clicking Add calls `api.settings.categories.create`; clicking remove on an in-use category surfaces the 409 message.
- [ ] **Step 2:** Implement `categories-form.tsx`: a `Card` titled "Categories"; `useQuery(['categories'])`; a list with a remove (trash) button per row; an input + Add button. `create`/`delete` mutations invalidate `['categories']`. On a delete `ApiError` with code `CATEGORY_IN_USE`, show `err.message` inline (and the `usageCount` from `err.details` if present). Mirror the structure/spacing of `forecast-thresholds-form.tsx`.
- [ ] **Step 3:** In `settings.tsx`, render `<CategoriesForm />` under `<ForecastThresholdsForm />`.
- [ ] **Step 4: Run test → PASS; commit** `feat(web): Settings categories management card`.

---

## Phase G — Full verification & cleanup

### Task G1: Whole-repo green

- [ ] **Step 1: Grep for stragglers**

Run: `grep -rn "applications\|\bevents\b\|EventCategory\|ApplicationResponse\|EventResponse" apps/web/src apps/server/src packages/shared/src` — every hit should be intentional (e.g. forecast `events[]` output array, which is fine). Fix any dangling imports.

- [ ] **Step 2: Run everything**

```bash
pnpm --filter @lcm/shared test
pnpm --filter @lcm/server test
pnpm --filter @lcm/web test
pnpm -r typecheck
pnpm -r lint
```

Expected: all PASS. Fix failures before proceeding.

- [ ] **Step 3: Manual smoke (optional but recommended)** — `pnpm db:dev:up && pnpm --filter @lcm/server exec prisma migrate reset --force && pnpm seed && pnpm dev`, then open a cluster: confirm the merged tab lists items, Add (both kinds) works, the category combobox lists managed categories and accepts a new one, the forecast chart still renders event markers, and Settings → Categories add/remove (with block-in-use) works.

- [ ] **Step 4: Final commit + push branch**

```bash
git add -A && git commit -m "chore: cleanup stragglers after items merge"
git push -u origin feat/merge-apps-events
```

- [ ] **Step 5: Open PR** (do not merge; user reviews):

```bash
gh pr create --base main --title "Merge applications + events into unified items" \
  --body "Implements docs/superpowers/specs/2026-06-02-merge-apps-events-design.md"
```

---

## Self-Review notes (author)

- **Spec coverage:** data model (B1), backfill incl. seed + faithful no-normalization (B2), forecast parity gate (C3 + existing forecast tests), block-on-delete-in-use (C1), category-upsert-on-save (C2), removed old routes (C4), merged tab + kind toggle + datalist combobox (E1–E3), Settings card (F1), dropped note-rule (A1/C2 — zero-delta events allowed). All covered.
- **Type consistency:** `effectiveDate` (not `startedAt`) is the unified date field across schema, Zod, services, loader, and web wire types. `ItemKind` values `application`/`event` used everywhere. `category: string` end-to-end.
- **Known follow-ups to confirm during execution:** exact route-registration file; `ConflictError` details payload for `usageCount`; the precise index/constraint rename lines needed for a clean `migrate diff` (B2 Step 3); reuse of `Field`/`Input` styling in the combobox.
