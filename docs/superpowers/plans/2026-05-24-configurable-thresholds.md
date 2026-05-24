# Configurable Warn/Crit Thresholds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard-coded 0.70/0.90 warn/crit thresholds with a two-level inheritance system (tenant defaults + per-cluster overrides), edit them via a new `/settings` form and a new Settings tab on the cluster detail page, and label the Capacity forecast chart's reference lines with the threshold percent instead of derived GB.

**Architecture:** Token-style cascade for configuration. Two new Prisma tables (`TenantSettings`, `ClusterSettings`) hold persistence; a single `resolveThresholds()` function in `@lcm/shared` runs server-side (forecast service) and client-side (React Query hook). Five new Fastify endpoints. The `ForecastResponse` schema gains an `effectiveThresholds` field so charts get the right values without an extra round-trip. UI components (`UtilizationGauge`, `RunwayPill`, `UtilizationBadge`, `utilStatus`, `runwayToWarn`) accept optional threshold props defaulting to `SYSTEM_DEFAULTS` for backwards compat.

**Tech Stack:** Prisma + Postgres, Fastify, Zod, TanStack Query, React 19, Tailwind v4. Test stack: Vitest (unit + API integration), Playwright (e2e).

**Spec:** [`docs/superpowers/specs/2026-05-24-configurable-thresholds-design.md`](../specs/2026-05-24-configurable-thresholds-design.md)

---

## File map

**Foundation (shared, depended on by everything)**

- `packages/shared/src/settings/resolve-thresholds.ts` — `resolveThresholds()`, `SYSTEM_DEFAULTS`, types. Pure function, no I/O.
- `packages/shared/src/schemas/settings.ts` — Zod schemas: `percentSchema`, `tenantSettingsSchema`, `clusterSettingsInputSchema`, `effectiveThresholdsSchema`. Plus type exports.
- `packages/shared/src/index.ts` — re-export new modules.
- `packages/shared/src/schemas/forecast.ts` — extend `ForecastResponse` with `effectiveThresholds`.

**Backend (database, services, routes)**

- `apps/api/prisma/schema.prisma` — add `TenantSettings` + `ClusterSettings` models, relations on `Tenant` + `Cluster`.
- `apps/api/prisma/migrations/<timestamp>_add_settings_tables/migration.sql` — Prisma-generated SQL plus appended CHECK constraints.
- `apps/api/src/services/settings.ts` — `SettingsService` class: `getTenant`, `updateTenant`, `getCluster`, `updateCluster`, `resetCluster`, `effectiveFor`. Pure CRUD + cross-field validation.
- `apps/api/src/routes/settings.ts` — 5 endpoints wiring `SettingsService`.
- `apps/api/src/services/forecast-loader.ts` — load tenant + cluster settings; thread effective thresholds through forecast response.
- `apps/api/src/services/forecast.ts` — extend `ForecastResult` interface with `effectiveThresholds`.
- `apps/api/src/server.ts` — register `settingsRoutes`.
- `apps/api/src/__tests__/settings.test.ts` — integration tests for all 5 endpoints + validation paths.
- `apps/api/src/__tests__/setup.ts` — clear new tables in `beforeEach`.
- `apps/api/src/__tests__/forecast-endpoint.test.ts` — assert response includes `effectiveThresholds`.

**Frontend (hook, forms, integration)**

- `apps/web/src/lib/api-client.ts` — add `api.settings.{tenant,cluster}.*` methods.
- `apps/web/src/lib/use-effective-thresholds.ts` — React Query hook + types.
- `apps/web/src/lib/forecast-summary.ts` — `runwayToWarn(points, warnThreshold?)`, `utilStatus(value, thresholds?)` overloads; export `SYSTEM_DEFAULTS` re-export from shared.
- `apps/web/src/components/ui/utilization-gauge.tsx` — accept optional `warn?`/`crit?`.
- `apps/web/src/components/clusters/utilization-badge.tsx` — same.
- `apps/web/src/components/settings/forecast-thresholds-form.tsx` — tenant form (NEW).
- `apps/web/src/components/clusters/threshold-overrides-form.tsx` — per-cluster form (NEW).
- `apps/web/src/components/clusters/settings-tab.tsx` — wraps threshold form, leaves room for future sections (NEW).
- `apps/web/src/components/clusters/forecast-chart.tsx` — percent labels; use `forecast.effectiveThresholds`.
- `apps/web/src/components/overview/fleet-capacity-chart.tsx` — percent labels; use `useEffectiveThresholds()` (no cluster id).
- `apps/web/src/routes/settings.tsx` — host the tenant form.
- `apps/web/src/routes/clusters.$id.tsx` — add fourth "Settings" tab; pass `forecast.effectiveThresholds` to KPI strip.
- `apps/web/playwright/settings.spec.ts` — e2e walkthrough (NEW).

---

## Branch convention

Recommend feature branch:

```bash
git checkout -b configurable-thresholds
```

If executing via `superpowers:using-git-worktrees`, the worktree is created up-front.

All commits stay on this branch; PR at the end (Task 20).

---

## Task 1: Add `resolveThresholds` + `SYSTEM_DEFAULTS` to shared

**Files:**

- Create: `packages/shared/src/settings/resolve-thresholds.ts`
- Create: `packages/shared/src/settings/__tests__/resolve-thresholds.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/settings/__tests__/resolve-thresholds.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { resolveThresholds, SYSTEM_DEFAULTS } from '../resolve-thresholds.js';

describe('SYSTEM_DEFAULTS', () => {
  it('is 0.7 / 0.9', () => {
    expect(SYSTEM_DEFAULTS).toEqual({ warn: 0.7, crit: 0.9 });
  });
});

describe('resolveThresholds', () => {
  it('falls back to SYSTEM_DEFAULTS when both inputs are null', () => {
    expect(resolveThresholds(null, null)).toEqual({ warn: 0.7, crit: 0.9 });
  });

  it('uses tenant values when cluster is null', () => {
    expect(resolveThresholds(null, { warnThreshold: 0.6, critThreshold: 0.8 })).toEqual({
      warn: 0.6,
      crit: 0.8,
    });
  });

  it('uses cluster values when both levels are set', () => {
    expect(
      resolveThresholds(
        { warnThreshold: 0.5, critThreshold: 0.85 },
        { warnThreshold: 0.6, critThreshold: 0.8 },
      ),
    ).toEqual({ warn: 0.5, crit: 0.85 });
  });

  it('inherits per-field when only one cluster value is set', () => {
    expect(
      resolveThresholds(
        { warnThreshold: 0.5, critThreshold: null },
        { warnThreshold: 0.6, critThreshold: 0.85 },
      ),
    ).toEqual({ warn: 0.5, crit: 0.85 });
  });

  it('inherits from tenant when cluster crit is null and warn is overridden', () => {
    expect(
      resolveThresholds(
        { warnThreshold: 0.5, critThreshold: null },
        { warnThreshold: 0.6, critThreshold: 0.85 },
      ),
    ).toEqual({ warn: 0.5, crit: 0.85 });
  });

  it('accepts custom defaults', () => {
    expect(resolveThresholds(null, null, { warn: 0.5, crit: 0.75 })).toEqual({
      warn: 0.5,
      crit: 0.75,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @lcm/shared test resolve-thresholds
```

Expected: FAIL — `Cannot find module '../resolve-thresholds.js'`.

- [ ] **Step 3: Create the resolver**

Create `packages/shared/src/settings/resolve-thresholds.ts`:

```ts
export const SYSTEM_DEFAULTS = { warn: 0.7, crit: 0.9 } as const;

export interface ResolvedThresholds {
  warn: number;
  crit: number;
}

export interface TenantThresholdsInput {
  warnThreshold: number;
  critThreshold: number;
}

export interface ClusterThresholdsInput {
  warnThreshold: number | null;
  critThreshold: number | null;
}

export function resolveThresholds(
  clusterSettings: ClusterThresholdsInput | null,
  tenantSettings: TenantThresholdsInput | null,
  defaults: ResolvedThresholds = SYSTEM_DEFAULTS,
): ResolvedThresholds {
  return {
    warn: clusterSettings?.warnThreshold ?? tenantSettings?.warnThreshold ?? defaults.warn,
    crit: clusterSettings?.critThreshold ?? tenantSettings?.critThreshold ?? defaults.crit,
  };
}
```

- [ ] **Step 4: Re-export from the package index**

Open `packages/shared/src/index.ts`. After the existing `export *` lines, add:

```ts
export * from './settings/resolve-thresholds.js';
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @lcm/shared test resolve-thresholds
pnpm --filter @lcm/shared typecheck
```

Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/settings packages/shared/src/index.ts
git commit -m "feat(shared): add resolveThresholds + SYSTEM_DEFAULTS"
```

---

## Task 2: Add settings Zod schemas to shared

**Files:**

- Create: `packages/shared/src/schemas/settings.ts`
- Create: `packages/shared/src/schemas/__tests__/settings.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/schemas/__tests__/settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  clusterSettingsInputSchema,
  effectiveThresholdsSchema,
  percentSchema,
  tenantSettingsSchema,
} from '../settings.js';

describe('percentSchema', () => {
  it('accepts 0.01 to 0.99', () => {
    expect(percentSchema.parse(0.01)).toBe(0.01);
    expect(percentSchema.parse(0.99)).toBe(0.99);
  });

  it('rejects values outside 0.01..0.99', () => {
    expect(() => percentSchema.parse(0)).toThrow();
    expect(() => percentSchema.parse(1)).toThrow();
    expect(() => percentSchema.parse(-0.1)).toThrow();
  });
});

describe('tenantSettingsSchema', () => {
  it('accepts warn < crit', () => {
    expect(tenantSettingsSchema.parse({ warnThreshold: 0.7, critThreshold: 0.9 })).toEqual({
      warnThreshold: 0.7,
      critThreshold: 0.9,
    });
  });

  it('rejects warn === crit', () => {
    expect(() => tenantSettingsSchema.parse({ warnThreshold: 0.8, critThreshold: 0.8 })).toThrow();
  });

  it('rejects warn > crit', () => {
    expect(() => tenantSettingsSchema.parse({ warnThreshold: 0.9, critThreshold: 0.7 })).toThrow();
  });
});

describe('clusterSettingsInputSchema', () => {
  it('accepts both null (will be deleted)', () => {
    expect(clusterSettingsInputSchema.parse({ warnThreshold: null, critThreshold: null })).toEqual({
      warnThreshold: null,
      critThreshold: null,
    });
  });

  it('accepts partial overrides (warn only)', () => {
    expect(clusterSettingsInputSchema.parse({ warnThreshold: 0.6, critThreshold: null })).toEqual({
      warnThreshold: 0.6,
      critThreshold: null,
    });
  });

  it('rejects warn >= crit when both are set', () => {
    expect(() =>
      clusterSettingsInputSchema.parse({ warnThreshold: 0.9, critThreshold: 0.7 }),
    ).toThrow();
  });

  it('does not enforce warn < crit when one is null', () => {
    expect(clusterSettingsInputSchema.parse({ warnThreshold: 0.95, critThreshold: null })).toEqual({
      warnThreshold: 0.95,
      critThreshold: null,
    });
  });
});

describe('effectiveThresholdsSchema', () => {
  it('accepts a resolved triple with source', () => {
    expect(effectiveThresholdsSchema.parse({ warn: 0.7, crit: 0.9, source: 'tenant' })).toEqual({
      warn: 0.7,
      crit: 0.9,
      source: 'tenant',
    });
  });

  it('rejects unknown source', () => {
    expect(() =>
      effectiveThresholdsSchema.parse({ warn: 0.7, crit: 0.9, source: 'galaxy' }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @lcm/shared test settings
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the schemas**

Create `packages/shared/src/schemas/settings.ts`:

```ts
import { z } from 'zod';

export const percentSchema = z.number().min(0.01).max(0.99);

export const tenantSettingsSchema = z
  .object({
    warnThreshold: percentSchema,
    critThreshold: percentSchema,
  })
  .refine((s) => s.warnThreshold < s.critThreshold, {
    message: 'warnThreshold must be less than critThreshold',
    path: ['warnThreshold'],
  });

export const clusterSettingsInputSchema = z
  .object({
    warnThreshold: percentSchema.nullable(),
    critThreshold: percentSchema.nullable(),
  })
  .refine(
    (s) => {
      if (s.warnThreshold === null || s.critThreshold === null) return true;
      return s.warnThreshold < s.critThreshold;
    },
    {
      message: 'warnThreshold must be less than critThreshold',
      path: ['warnThreshold'],
    },
  );

export const effectiveThresholdsSchema = z.object({
  warn: z.number(),
  crit: z.number(),
  source: z.enum(['system', 'tenant', 'cluster']),
});

export const clusterSettingsResponseSchema = z.object({
  warnThreshold: z.number().nullable(),
  critThreshold: z.number().nullable(),
  effective: effectiveThresholdsSchema,
});

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;
export type ClusterSettingsInput = z.infer<typeof clusterSettingsInputSchema>;
export type EffectiveThresholds = z.infer<typeof effectiveThresholdsSchema>;
export type ClusterSettingsResponse = z.infer<typeof clusterSettingsResponseSchema>;
```

- [ ] **Step 4: Re-export from the package index**

Open `packages/shared/src/index.ts`. Add (alongside other `export *` lines):

```ts
export * from './schemas/settings.js';
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @lcm/shared test settings
pnpm --filter @lcm/shared typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/schemas/settings.ts packages/shared/src/schemas/__tests__/settings.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): zod schemas for tenant + cluster threshold settings"
```

---

## Task 3: Extend `ForecastResponse` schema with `effectiveThresholds`

**Files:**

- Modify: `packages/shared/src/schemas/forecast.ts`

The `ForecastResponse` shape lives as a TypeScript interface (no Zod), so add the new field there.

- [ ] **Step 1: Update the interface**

Open `packages/shared/src/schemas/forecast.ts`. Find:

```ts
export interface ForecastResponse {
  fromMonth: string;
  toMonth: string;
  months: ForecastMonthPoint[];
  events: ForecastEventMarker[];
  hosts: ForecastEntityContribution[];
  applications: ForecastEntityContribution[];
}
```

Add an import at the top:

```ts
import type { EffectiveThresholds } from './settings.js';
```

Replace the interface with:

```ts
export interface ForecastResponse {
  fromMonth: string;
  toMonth: string;
  months: ForecastMonthPoint[];
  events: ForecastEventMarker[];
  hosts: ForecastEntityContribution[];
  applications: ForecastEntityContribution[];
  effectiveThresholds: EffectiveThresholds;
}
```

- [ ] **Step 2: Run typecheck across the workspace**

```bash
pnpm --filter @lcm/shared typecheck
pnpm -r typecheck
```

Expected: shared package types pass. The web and API packages will fail (they construct/consume `ForecastResponse` without the new field). That's expected — Tasks 7 and 10 fix them.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/schemas/forecast.ts
git commit -m "feat(shared): add effectiveThresholds to ForecastResponse"
```

(Don't worry about workspace-wide typecheck failing here; subsequent tasks restore it. If the pre-commit hook blocks on workspace-wide typecheck, see if it's only the expected breakage in api/web; the hook should be relaxed for this transitional commit — if it isn't, complete tasks 4–10 quickly to restore green.)

If the pre-commit hook is strict and blocks: stop, complete Task 4 first (Prisma migration), then continue to Task 5/7 which restore web + api typecheck. Then come back and commit Tasks 3+4+5+7 together.

For a cleaner approach, follow the "alternative ordering" note above and combine Tasks 3 + 7 + 10 into a single commit by deferring the commit at the end of this task.

---

## Task 4: Prisma migration — add settings tables

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_add_settings_tables/migration.sql` (Prisma-generated, then appended to)

- [ ] **Step 1: Edit `schema.prisma` — add `TenantSettings` model**

Open `apps/api/prisma/schema.prisma`. Find the `Tenant` model. After its closing `}`, add:

```prisma
model TenantSettings {
  tenantId      String   @id @map("tenant_id")
  warnThreshold Decimal  @default(0.70) @map("warn_threshold") @db.Decimal(4, 3)
  critThreshold Decimal  @default(0.90) @map("crit_threshold") @db.Decimal(4, 3)
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  tenant        Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@map("tenant_settings")
}
```

- [ ] **Step 2: Edit `schema.prisma` — add `ClusterSettings` model**

After the `Cluster` model's closing `}`, add:

```prisma
model ClusterSettings {
  clusterId     String   @id @map("cluster_id")
  warnThreshold Decimal? @map("warn_threshold") @db.Decimal(4, 3)
  critThreshold Decimal? @map("crit_threshold") @db.Decimal(4, 3)
  updatedAt     DateTime @updatedAt @map("updated_at")

  cluster       Cluster  @relation(fields: [clusterId], references: [id], onDelete: Cascade)

  @@map("cluster_settings")
}
```

- [ ] **Step 3: Add the back-relations to `Tenant` and `Cluster`**

Inside the `Tenant` model, in the relations block (after `events Event[]`), add:

```prisma
  settings       TenantSettings?
```

Inside the `Cluster` model, in the relations block (after `events Event[]`), add:

```prisma
  settings     ClusterSettings?
```

- [ ] **Step 4: Generate the migration**

```bash
pnpm --filter @lcm/api exec prisma migrate dev --name add_settings_tables --create-only
```

Expected: prints the migration SQL it generated. It creates a directory like `apps/api/prisma/migrations/20260524..._add_settings_tables/migration.sql`. Open that file.

- [ ] **Step 5: Append CHECK constraints to the migration SQL**

Open the generated `migration.sql`. At the very end of the file, append:

```sql

ALTER TABLE tenant_settings ADD CONSTRAINT tenant_settings_warn_lt_crit
  CHECK (warn_threshold > 0 AND warn_threshold < crit_threshold AND crit_threshold <= 1);

ALTER TABLE cluster_settings ADD CONSTRAINT cluster_settings_warn_lt_crit_when_both_set
  CHECK (
    warn_threshold IS NULL
    OR crit_threshold IS NULL
    OR (warn_threshold > 0 AND warn_threshold < crit_threshold AND crit_threshold <= 1)
  );
```

- [ ] **Step 6: Apply the migration to the dev DB**

```bash
pnpm --filter @lcm/api exec prisma migrate deploy
```

Expected: 1 migration applied. (If you get "Already in sync", run `prisma migrate dev` instead — but be sure the CHECK constraints are still in the generated SQL.)

- [ ] **Step 7: Regenerate the Prisma client**

```bash
pnpm --filter @lcm/api exec prisma generate
```

Expected: "Generated Prisma Client". Without this, `prisma.tenantSettings` won't exist as a property of `PrismaClient`.

- [ ] **Step 8: Update test setup to clear new tables**

Open `apps/api/src/__tests__/setup.ts`. Replace its content with:

```ts
import { PrismaClient } from '@prisma/client';
import { beforeEach } from 'vitest';

export const prisma = new PrismaClient();

beforeEach(async () => {
  await prisma.clusterSettings.deleteMany({});
  await prisma.cluster.deleteMany({});
  await prisma.tenantSettings.deleteMany({});
});
```

Order matters: ClusterSettings cascades via Cluster, but explicit delete first is safer if Cluster delete has issues. TenantSettings deletion last — the seed tenant is preserved.

- [ ] **Step 9: Run typecheck + tests**

```bash
pnpm --filter @lcm/api typecheck
pnpm --filter @lcm/api test
```

Expected: typecheck PASS, all existing tests PASS (the new tables are unused so far).

- [ ] **Step 10: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/src/__tests__/setup.ts
git commit -m "feat(api): add tenant_settings + cluster_settings tables with CHECK constraints"
```

---

## Task 5: Implement `SettingsService`

**Files:**

- Create: `apps/api/src/services/settings.ts`
- Create: `apps/api/src/services/__tests__/settings-service.test.ts`

The service handles persistence + cross-field validation (effective `warn < crit` after partial cluster override). It does NOT validate request shape — that's Zod's job in the route layer.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/__tests__/settings-service.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { prisma } from '../../__tests__/setup.js';
import { SettingsService } from '../settings.js';

const TENANT_ID = 'default';

async function makeCluster(name: string): Promise<string> {
  const cluster = await prisma.cluster.create({
    data: {
      tenantId: TENANT_ID,
      name,
      baselineDate: new Date('2026-05-01'),
    },
  });
  return cluster.id;
}

describe('SettingsService.getTenant', () => {
  it('auto-creates a default row on first read', async () => {
    const svc = new SettingsService(prisma);
    const result = await svc.getTenant(TENANT_ID);
    expect(result.warnThreshold).toBeCloseTo(0.7);
    expect(result.critThreshold).toBeCloseTo(0.9);
  });

  it('is idempotent', async () => {
    const svc = new SettingsService(prisma);
    await svc.getTenant(TENANT_ID);
    const result = await svc.getTenant(TENANT_ID);
    expect(result.warnThreshold).toBeCloseTo(0.7);
  });
});

describe('SettingsService.updateTenant', () => {
  it('persists new values', async () => {
    const svc = new SettingsService(prisma);
    const result = await svc.updateTenant(TENANT_ID, {
      warnThreshold: 0.65,
      critThreshold: 0.85,
    });
    expect(result.warnThreshold).toBeCloseTo(0.65);
    expect(result.critThreshold).toBeCloseTo(0.85);
  });
});

describe('SettingsService.getCluster', () => {
  it('returns nulls + tenant-inherited effective when no override exists', async () => {
    const svc = new SettingsService(prisma);
    const clusterId = await makeCluster('no-override');
    const result = await svc.getCluster(TENANT_ID, clusterId);
    expect(result.warnThreshold).toBeNull();
    expect(result.critThreshold).toBeNull();
    expect(result.effective.warn).toBeCloseTo(0.7);
    expect(result.effective.crit).toBeCloseTo(0.9);
    expect(result.effective.source).toBe('tenant');
  });
});

describe('SettingsService.updateCluster', () => {
  it('persists overrides and returns cluster-source effective', async () => {
    const svc = new SettingsService(prisma);
    const clusterId = await makeCluster('override-both');
    const result = await svc.updateCluster(TENANT_ID, clusterId, {
      warnThreshold: 0.6,
      critThreshold: 0.85,
    });
    expect(result.warnThreshold).toBeCloseTo(0.6);
    expect(result.critThreshold).toBeCloseTo(0.85);
    expect(result.effective.warn).toBeCloseTo(0.6);
    expect(result.effective.source).toBe('cluster');
  });

  it('rejects when effective warn >= crit (partial override + tenant default)', async () => {
    const svc = new SettingsService(prisma);
    const clusterId = await makeCluster('bad-override');
    await svc.updateTenant(TENANT_ID, { warnThreshold: 0.7, critThreshold: 0.9 });
    await expect(
      svc.updateCluster(TENANT_ID, clusterId, {
        warnThreshold: 0.95,
        critThreshold: null,
      }),
    ).rejects.toThrow(/effective/i);
  });
});

describe('SettingsService.resetCluster', () => {
  it('deletes the row and returns inherited effective', async () => {
    const svc = new SettingsService(prisma);
    const clusterId = await makeCluster('reset-me');
    await svc.updateCluster(TENANT_ID, clusterId, {
      warnThreshold: 0.6,
      critThreshold: 0.8,
    });
    const result = await svc.resetCluster(TENANT_ID, clusterId);
    expect(result.warnThreshold).toBeNull();
    expect(result.critThreshold).toBeNull();
    expect(result.effective.source).toBe('tenant');
  });

  it('is idempotent when no row exists', async () => {
    const svc = new SettingsService(prisma);
    const clusterId = await makeCluster('reset-noop');
    const result = await svc.resetCluster(TENANT_ID, clusterId);
    expect(result.warnThreshold).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @lcm/api test settings-service
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/settings.ts`:

```ts
import type { PrismaClient } from '@prisma/client';

import {
  resolveThresholds,
  SYSTEM_DEFAULTS,
  type ClusterSettingsInput,
  type ClusterSettingsResponse,
  type EffectiveThresholds,
  type TenantSettings,
} from '@lcm/shared';

import { NotFoundError, UnprocessableError } from './errors.js';

function decimalToNumber(value: unknown): number {
  if (value === null || value === undefined) {
    throw new Error('Cannot convert null/undefined to number');
  }
  // Prisma Decimal has a toNumber() method; runtime values from Postgres come through as Decimal.
  if (typeof value === 'object' && value !== null && 'toNumber' in value) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value);
}

function decimalToNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return decimalToNumber(value);
}

export class SettingsService {
  constructor(private readonly prisma: PrismaClient) {}

  async getTenant(tenantId: string): Promise<TenantSettings> {
    const row = await this.prisma.tenantSettings.upsert({
      where: { tenantId },
      create: { tenantId },
      update: {},
    });
    return {
      warnThreshold: decimalToNumber(row.warnThreshold),
      critThreshold: decimalToNumber(row.critThreshold),
    };
  }

  async updateTenant(tenantId: string, input: TenantSettings): Promise<TenantSettings> {
    const row = await this.prisma.tenantSettings.upsert({
      where: { tenantId },
      create: {
        tenantId,
        warnThreshold: input.warnThreshold,
        critThreshold: input.critThreshold,
      },
      update: {
        warnThreshold: input.warnThreshold,
        critThreshold: input.critThreshold,
      },
    });
    return {
      warnThreshold: decimalToNumber(row.warnThreshold),
      critThreshold: decimalToNumber(row.critThreshold),
    };
  }

  async getCluster(tenantId: string, clusterId: string): Promise<ClusterSettingsResponse> {
    await this.assertClusterExists(tenantId, clusterId);
    const row = await this.prisma.clusterSettings.findUnique({
      where: { clusterId },
    });
    const cluster = row
      ? {
          warnThreshold: decimalToNullableNumber(row.warnThreshold),
          critThreshold: decimalToNullableNumber(row.critThreshold),
        }
      : null;
    const tenant = await this.getTenant(tenantId);
    const effective = this.computeEffective(cluster, tenant);
    return {
      warnThreshold: cluster?.warnThreshold ?? null,
      critThreshold: cluster?.critThreshold ?? null,
      effective,
    };
  }

  async updateCluster(
    tenantId: string,
    clusterId: string,
    input: ClusterSettingsInput,
  ): Promise<ClusterSettingsResponse> {
    await this.assertClusterExists(tenantId, clusterId);
    const tenant = await this.getTenant(tenantId);
    const candidate = this.computeEffective(input, tenant);
    if (candidate.warn >= candidate.crit) {
      throw new UnprocessableError(
        'EFFECTIVE_THRESHOLDS_INVALID',
        `Effective warn (${candidate.warn}) must be less than effective crit (${candidate.crit}).`,
      );
    }
    const row = await this.prisma.clusterSettings.upsert({
      where: { clusterId },
      create: {
        clusterId,
        warnThreshold: input.warnThreshold,
        critThreshold: input.critThreshold,
      },
      update: {
        warnThreshold: input.warnThreshold,
        critThreshold: input.critThreshold,
      },
    });
    const cluster = {
      warnThreshold: decimalToNullableNumber(row.warnThreshold),
      critThreshold: decimalToNullableNumber(row.critThreshold),
    };
    return {
      warnThreshold: cluster.warnThreshold,
      critThreshold: cluster.critThreshold,
      effective: this.computeEffective(cluster, tenant),
    };
  }

  async resetCluster(tenantId: string, clusterId: string): Promise<ClusterSettingsResponse> {
    await this.assertClusterExists(tenantId, clusterId);
    await this.prisma.clusterSettings.delete({ where: { clusterId } }).catch((err: unknown) => {
      // P2025 = "Record to delete does not exist." Treat reset as idempotent.
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === 'P2025'
      ) {
        return;
      }
      throw err;
    });
    const tenant = await this.getTenant(tenantId);
    return {
      warnThreshold: null,
      critThreshold: null,
      effective: this.computeEffective(null, tenant),
    };
  }

  async effectiveFor(tenantId: string, clusterId: string): Promise<EffectiveThresholds> {
    const result = await this.getCluster(tenantId, clusterId);
    return result.effective;
  }

  private async assertClusterExists(tenantId: string, clusterId: string): Promise<void> {
    const cluster = await this.prisma.cluster.findFirst({
      where: { id: clusterId, tenantId },
      select: { id: true },
    });
    if (!cluster) {
      throw new NotFoundError('Cluster', clusterId);
    }
  }

  private computeEffective(
    cluster: ClusterSettingsInput | null,
    tenant: TenantSettings,
  ): EffectiveThresholds {
    const resolved = resolveThresholds(cluster, tenant, SYSTEM_DEFAULTS);
    let source: EffectiveThresholds['source'] = 'system';
    if (tenant) source = 'tenant';
    if (cluster && (cluster.warnThreshold !== null || cluster.critThreshold !== null)) {
      source = 'cluster';
    }
    return { warn: resolved.warn, crit: resolved.crit, source };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @lcm/api test settings-service
```

Expected: PASS (all describe blocks). If a test fails with "default tenant not found", check that the seed has run: `pnpm --filter @lcm/api exec prisma db seed`.

- [ ] **Step 5: Run typecheck**

```bash
pnpm --filter @lcm/api typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/settings.ts apps/api/src/services/__tests__/settings-service.test.ts
git commit -m "feat(api): SettingsService — tenant + cluster threshold CRUD with cross-field validation"
```

---

## Task 6: Wire `SettingsService` into Fastify routes

**Files:**

- Create: `apps/api/src/routes/settings.ts`
- Modify: `apps/api/src/server.ts`
- Create: `apps/api/src/__tests__/settings.test.ts`

- [ ] **Step 1: Create the route file**

Create `apps/api/src/routes/settings.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify';

import {
  clusterIdParamsSchema,
  clusterSettingsInputSchema,
  tenantSettingsSchema,
} from '@lcm/shared';

import { SettingsService } from '../services/settings.js';

export const settingsRoutes: FastifyPluginAsync = async (fastify) => {
  const service = new SettingsService(fastify.prisma);

  fastify.get('/settings/tenant', async (request) => {
    return service.getTenant(request.tenantId);
  });

  fastify.put('/settings/tenant', async (request) => {
    const input = tenantSettingsSchema.parse(request.body);
    return service.updateTenant(request.tenantId, input);
  });

  fastify.get('/clusters/:id/settings', async (request) => {
    const { id } = clusterIdParamsSchema.parse(request.params);
    return service.getCluster(request.tenantId, id);
  });

  fastify.put('/clusters/:id/settings', async (request) => {
    const { id } = clusterIdParamsSchema.parse(request.params);
    const input = clusterSettingsInputSchema.parse(request.body);
    return service.updateCluster(request.tenantId, id, input);
  });

  fastify.delete('/clusters/:id/settings', async (request) => {
    const { id } = clusterIdParamsSchema.parse(request.params);
    return service.resetCluster(request.tenantId, id);
  });
};
```

- [ ] **Step 2: Register the route in server.ts**

Open `apps/api/src/server.ts`. After the existing route imports, add:

```ts
import { settingsRoutes } from './routes/settings.js';
```

After the existing `await server.register(forecastRoutes, { prefix: '/api' });` line, add:

```ts
await server.register(settingsRoutes, { prefix: '/api' });
```

- [ ] **Step 3: Write the failing integration test**

Create `apps/api/src/__tests__/settings.test.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildServer({ env: makeTestEnv(), prisma });
});

afterAll(async () => {
  await server.close();
});

let sequence = 0;
const uniqueName = (suffix: string): string => {
  sequence += 1;
  return `settings-${suffix}-${sequence}`;
};

async function createCluster(name: string): Promise<string> {
  const res = await server.inject({
    method: 'POST',
    url: '/api/clusters',
    payload: {
      name,
      baselineDate: '2026-05-01',
      baselines: [{ metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 }],
    },
  });
  const body = res.json() as { id: string };
  return body.id;
}

describe('GET /api/settings/tenant', () => {
  it('returns defaults on first read', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/settings/tenant' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { warnThreshold: number; critThreshold: number };
    expect(body.warnThreshold).toBeCloseTo(0.7);
    expect(body.critThreshold).toBeCloseTo(0.9);
  });
});

describe('PUT /api/settings/tenant', () => {
  it('updates tenant settings', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings/tenant',
      payload: { warnThreshold: 0.65, critThreshold: 0.85 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { warnThreshold: number };
    expect(body.warnThreshold).toBeCloseTo(0.65);
  });

  it('rejects warn >= crit', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings/tenant',
      payload: { warnThreshold: 0.9, critThreshold: 0.7 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/clusters/:id/settings', () => {
  it('returns nulls + tenant-source effective when no override', async () => {
    const id = await createCluster(uniqueName('get-empty'));
    const res = await server.inject({ method: 'GET', url: `/api/clusters/${id}/settings` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      warnThreshold: number | null;
      critThreshold: number | null;
      effective: { warn: number; crit: number; source: string };
    };
    expect(body.warnThreshold).toBeNull();
    expect(body.effective.source).toBe('tenant');
  });

  it('returns 404 for unknown cluster', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/clusters/clbogusclubogusclubogus0/settings',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PUT /api/clusters/:id/settings', () => {
  it('saves overrides', async () => {
    const id = await createCluster(uniqueName('put-ok'));
    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${id}/settings`,
      payload: { warnThreshold: 0.6, critThreshold: 0.85 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { effective: { source: string } };
    expect(body.effective.source).toBe('cluster');
  });

  it('rejects effective warn >= crit with 400', async () => {
    const id = await createCluster(uniqueName('put-bad'));
    // tenant default is 0.7/0.9 by Task 5 — override warn to 0.95 with null crit makes effective 0.95/0.9.
    const res = await server.inject({
      method: 'PUT',
      url: `/api/clusters/${id}/settings`,
      payload: { warnThreshold: 0.95, critThreshold: null },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/clusters/:id/settings', () => {
  it('removes the override and returns inherited effective', async () => {
    const id = await createCluster(uniqueName('del'));
    await server.inject({
      method: 'PUT',
      url: `/api/clusters/${id}/settings`,
      payload: { warnThreshold: 0.6, critThreshold: 0.85 },
    });
    const res = await server.inject({
      method: 'DELETE',
      url: `/api/clusters/${id}/settings`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      warnThreshold: number | null;
      effective: { source: string };
    };
    expect(body.warnThreshold).toBeNull();
    expect(body.effective.source).toBe('tenant');
  });
});
```

- [ ] **Step 4: Run the integration tests**

```bash
pnpm --filter @lcm/api test settings
```

Expected: PASS. If the "rejects effective warn >= crit" test fails, ensure the previous tenant settings test that mutated to 0.65/0.85 didn't leak into this test's state — the `beforeEach` should clear `tenant_settings`, and the auto-create on get returns 0.70/0.90 defaults.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/settings.ts apps/api/src/server.ts apps/api/src/__tests__/settings.test.ts
git commit -m "feat(api): expose /api/settings/tenant and /api/clusters/:id/settings"
```

---

## Task 7: Thread effective thresholds through forecast service

**Files:**

- Modify: `apps/api/src/services/forecast.ts`
- Modify: `apps/api/src/services/forecast-loader.ts`
- Modify: `apps/api/src/__tests__/forecast-endpoint.test.ts`

- [ ] **Step 1: Extend `ForecastResult` interface**

Open `apps/api/src/services/forecast.ts`. Find the `ForecastResult` interface (it likely sits below `MonthlyPoint`). Read the surrounding code:

```bash
grep -n "ForecastResult" apps/api/src/services/forecast.ts
```

Update the interface to include `effectiveThresholds`. The exact shape depends on what's there, but the addition is:

```ts
import type { EffectiveThresholds } from '@lcm/shared';

export interface ForecastResult {
  // ...existing fields preserved...
  effectiveThresholds: EffectiveThresholds;
}
```

If `ForecastResult` is the same shape as `ForecastResponse`, this single edit propagates. If they're separate, update both.

- [ ] **Step 2: Update `forecast-loader.ts` to load + return thresholds**

Open `apps/api/src/services/forecast-loader.ts`. At the top, add:

```ts
import { SettingsService } from './settings.js';
```

In the `ForecastService.forCluster` method, near the start (after the cluster fetch / null check), add:

```ts
const settingsService = new SettingsService(this.prisma);
const effectiveThresholds = await settingsService.effectiveFor(tenantId, clusterId);
```

At the end of `forCluster`, where the result is returned, include `effectiveThresholds`:

```ts
return {
  // ...existing returned fields...
  effectiveThresholds,
};
```

(If the existing code returns by spreading or destructuring, adapt the same pattern. The key is: the returned `ForecastResult` MUST include the new field.)

- [ ] **Step 3: Assert the field in the existing forecast endpoint test**

Open `apps/api/src/__tests__/forecast-endpoint.test.ts`. Find a test that asserts the forecast response body. After existing assertions on `months`/`hosts`/`applications`, add:

```ts
expect(body.effectiveThresholds).toEqual({
  warn: 0.7,
  crit: 0.9,
  source: 'tenant',
});
```

(Adjust `body` to match the variable name in the existing test. The source is `'tenant'` because Task 5's `getTenant` auto-creates a default row on first read.)

If there are multiple test cases, pick the simplest "happy path" one — no need to assert in every test.

- [ ] **Step 4: Run the forecast tests**

```bash
pnpm --filter @lcm/api test forecast
```

Expected: PASS. If a test fails on a different forecast response field, that's pre-existing — verify the new field doesn't break anything else.

- [ ] **Step 5: Run full API test suite**

```bash
pnpm --filter @lcm/api typecheck
pnpm --filter @lcm/api test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/forecast.ts apps/api/src/services/forecast-loader.ts apps/api/src/__tests__/forecast-endpoint.test.ts
git commit -m "feat(api): include effectiveThresholds in forecast response"
```

---

## Task 8: Add settings API client methods

**Files:**

- Modify: `apps/web/src/lib/api-client.ts`

- [ ] **Step 1: Add imports**

Open `apps/web/src/lib/api-client.ts`. In the top imports, add to the existing `@lcm/shared` import:

```ts
import type {
  // ...existing imports...
  ClusterSettingsInput,
  ClusterSettingsResponse,
  TenantSettings,
} from '@lcm/shared';
```

- [ ] **Step 2: Add the `settings` group to the `api` export**

Find the `export const api = { ... }` block. After the `clusters` group, add:

```ts
  settings: {
    tenant: {
      get: () => request<TenantSettings>('/api/settings/tenant'),
      update: (input: TenantSettings) =>
        request<TenantSettings>('/api/settings/tenant', {
          method: 'PUT',
          body: JSON.stringify(input),
        }),
    },
    cluster: {
      get: (id: string) => request<ClusterSettingsResponse>(`/api/clusters/${id}/settings`),
      update: (id: string, input: ClusterSettingsInput) =>
        request<ClusterSettingsResponse>(`/api/clusters/${id}/settings`, {
          method: 'PUT',
          body: JSON.stringify(input),
        }),
      reset: (id: string) =>
        request<ClusterSettingsResponse>(`/api/clusters/${id}/settings`, {
          method: 'DELETE',
        }),
    },
  },
```

- [ ] **Step 3: Run typecheck + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/api-client.ts
git commit -m "feat(web): api client methods for tenant + cluster settings"
```

---

## Task 9: Add `useEffectiveThresholds` hook

**Files:**

- Create: `apps/web/src/lib/use-effective-thresholds.ts`

- [ ] **Step 1: Create the hook**

Create `apps/web/src/lib/use-effective-thresholds.ts`:

```ts
import type { EffectiveThresholds } from '@lcm/shared';
import { SYSTEM_DEFAULTS } from '@lcm/shared';
import { useQuery } from '@tanstack/react-query';

import { api } from './api-client';

const FIVE_MINUTES = 5 * 60_000;

/**
 * Resolves effective warn/crit thresholds for a given cluster (or tenant if no
 * id is provided). Always returns defined values — falls back to
 * SYSTEM_DEFAULTS if neither the network call has resolved nor server data
 * exists. The `source` field reports where the values came from.
 */
export function useEffectiveThresholds(clusterId?: string): EffectiveThresholds {
  const clusterQuery = useQuery({
    queryKey: ['cluster-settings', clusterId],
    queryFn: () => api.settings.cluster.get(clusterId!),
    enabled: Boolean(clusterId),
    staleTime: FIVE_MINUTES,
  });
  const tenantQuery = useQuery({
    queryKey: ['tenant-settings'],
    queryFn: () => api.settings.tenant.get(),
    enabled: !clusterId,
    staleTime: FIVE_MINUTES,
  });

  if (clusterId && clusterQuery.data) {
    return clusterQuery.data.effective;
  }
  if (!clusterId && tenantQuery.data) {
    return {
      warn: tenantQuery.data.warnThreshold,
      crit: tenantQuery.data.critThreshold,
      source: 'tenant',
    };
  }
  return { warn: SYSTEM_DEFAULTS.warn, crit: SYSTEM_DEFAULTS.crit, source: 'system' };
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter @lcm/web typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/use-effective-thresholds.ts
git commit -m "feat(web): useEffectiveThresholds React Query hook"
```

---

## Task 10: Make threshold-consuming utilities accept optional thresholds

**Files:**

- Modify: `apps/web/src/lib/forecast-summary.ts`
- Modify: `apps/web/src/components/ui/utilization-gauge.tsx`
- Modify: `apps/web/src/components/clusters/utilization-badge.tsx`
- Modify: `apps/web/src/__tests__/forecast-summary.test.ts`
- Modify: `apps/web/src/components/ui/utilization-gauge.test.tsx`

- [ ] **Step 1: Update `forecast-summary.ts` to accept thresholds**

Open `apps/web/src/lib/forecast-summary.ts`. Replace the file with:

```ts
import type { ForecastMonthPoint } from '@lcm/shared';
import { SYSTEM_DEFAULTS } from '@lcm/shared';

export const WARN_THRESHOLD = SYSTEM_DEFAULTS.warn;
export const CRIT_THRESHOLD = SYSTEM_DEFAULTS.crit;

export interface RunwaySummary {
  /** Index of first month at or above the warn threshold, else null. */
  months: number | null;
  /** 'warn' | 'crit' when months === 0 (the breach is the current month); false otherwise. */
  alreadyBreached: 'warn' | 'crit' | false;
}

const NO_BREACH: RunwaySummary = Object.freeze({
  months: null,
  alreadyBreached: false,
}) as RunwaySummary;

export function runwayToWarn(
  points: ForecastMonthPoint[],
  thresholds: { warn: number; crit: number } = SYSTEM_DEFAULTS,
): RunwaySummary {
  const { warn, crit } = thresholds;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (p.capacity <= 0) continue;
    const u = p.consumption / p.capacity;
    if (u >= warn) {
      const breached = i === 0 ? (u >= crit ? 'crit' : 'warn') : false;
      return { months: i, alreadyBreached: breached };
    }
  }
  return NO_BREACH;
}

export function fleetRunwayToWarn(
  series: ForecastMonthPoint[][],
  thresholds: { warn: number; crit: number } = SYSTEM_DEFAULTS,
): RunwaySummary {
  if (series.length === 0) return NO_BREACH;
  const byMonth = new Map<string, { consumption: number; capacity: number }>();
  for (const points of series) {
    for (const p of points) {
      const agg = byMonth.get(p.month) ?? { consumption: 0, capacity: 0 };
      agg.consumption += p.consumption;
      agg.capacity += p.capacity;
      byMonth.set(p.month, agg);
    }
  }
  const merged: ForecastMonthPoint[] = Array.from(byMonth.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, agg]) => ({
      month,
      consumption: agg.consumption,
      capacity: agg.capacity,
      utilization: agg.capacity > 0 ? agg.consumption / agg.capacity : 0,
    }));
  return runwayToWarn(merged, thresholds);
}

export type UtilStatus = 'ok' | 'warn' | 'crit';

export function utilStatus(
  utilization: number,
  thresholds: { warn: number; crit: number } = SYSTEM_DEFAULTS,
): UtilStatus {
  if (utilization >= thresholds.crit) return 'crit';
  if (utilization >= thresholds.warn) return 'warn';
  return 'ok';
}

export type KpiStatus = UtilStatus | 'attention';
```

- [ ] **Step 2: Update `forecast-summary.test.ts` to verify the new threshold parameter**

Open `apps/web/src/__tests__/forecast-summary.test.ts`. Find any block of existing `utilStatus` tests. Add a new describe block after the existing `KpiStatus type` describe block:

```ts
describe('utilStatus with custom thresholds', () => {
  it('uses provided warn/crit instead of defaults', () => {
    expect(utilStatus(0.65, { warn: 0.6, crit: 0.8 })).toBe('warn');
    expect(utilStatus(0.55, { warn: 0.6, crit: 0.8 })).toBe('ok');
    expect(utilStatus(0.85, { warn: 0.6, crit: 0.8 })).toBe('crit');
  });
});

describe('runwayToWarn with custom thresholds', () => {
  it('uses provided warn threshold', () => {
    const points = [
      { month: '2026-01', consumption: 50, capacity: 100, utilization: 0.5 },
      { month: '2026-02', consumption: 65, capacity: 100, utilization: 0.65 },
      { month: '2026-03', consumption: 80, capacity: 100, utilization: 0.8 },
    ];
    expect(runwayToWarn(points, { warn: 0.6, crit: 0.8 })).toEqual({
      months: 1,
      alreadyBreached: false,
    });
  });
});
```

- [ ] **Step 3: Update `UtilizationGauge` to accept optional thresholds**

Open `apps/web/src/components/ui/utilization-gauge.tsx`. Add to props interface:

```ts
interface UtilizationGaugeProps extends React.SVGAttributes<SVGSVGElement> {
  value: number | undefined;
  size?: GaugeSize;
  warn?: number;
  crit?: number;
}
```

Replace the inline `bandOf` function to use the props:

```ts
function bandOf(value: number, warn: number, crit: number): 'ok' | 'warning' | 'critical' {
  if (value >= crit) return 'critical';
  if (value >= warn) return 'warning';
  return 'ok';
}
```

Inside the component, destructure props with defaults:

```ts
export function UtilizationGauge({
  value,
  size = 'md',
  warn = 0.7,
  crit = 0.9,
  className,
  ...props
}: UtilizationGaugeProps): React.JSX.Element {
```

Then change the call site:

```ts
const band = hasValue ? bandOf(clamped, warn, crit) : null;
```

- [ ] **Step 4: Add a gauge test for custom thresholds**

Open `apps/web/src/components/ui/utilization-gauge.test.tsx`. After the existing tests, add:

```ts
it('uses custom warn/crit thresholds when provided', () => {
  render(<UtilizationGauge value={0.65} warn={0.6} crit={0.8} />);
  expect(screen.getByRole('img', { name: /, status: warning/i })).toBeInTheDocument();
});
```

- [ ] **Step 5: Update `utilization-badge.tsx` to accept optional thresholds**

Open `apps/web/src/components/clusters/utilization-badge.tsx`. Replace the file's variant logic with:

```ts
interface UtilizationBadgeProps {
  value: number;
  warn?: number;
  crit?: number;
}

export function UtilizationBadge({ value, warn = 0.7, crit = 0.9 }: UtilizationBadgeProps) {
  const variant = value >= crit ? 'danger' : value >= warn ? 'warning' : 'success';
  // ... rest of the rendering preserved
}
```

(Read the existing file first; preserve whatever JSX/Badge wrapper it has.)

- [ ] **Step 6: Run typecheck + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web test
```

Expected: PASS (76 + 2 new = 78 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/forecast-summary.ts apps/web/src/components/ui/utilization-gauge.tsx apps/web/src/components/ui/utilization-gauge.test.tsx apps/web/src/components/clusters/utilization-badge.tsx apps/web/src/__tests__/forecast-summary.test.ts
git commit -m "feat(web): threshold-consuming utilities accept optional warn/crit props"
```

---

## Task 11: Build `ForecastThresholdsForm` (tenant settings)

**Files:**

- Create: `apps/web/src/components/settings/forecast-thresholds-form.tsx`
- Create: `apps/web/src/components/settings/forecast-thresholds-form.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/settings/forecast-thresholds-form.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { ForecastThresholdsForm } from './forecast-thresholds-form';

function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('<ForecastThresholdsForm>', () => {
  beforeEach(() => {
    vi.spyOn(api.settings.tenant, 'get').mockResolvedValue({
      warnThreshold: 0.7,
      critThreshold: 0.9,
    });
    vi.spyOn(api.settings.tenant, 'update').mockResolvedValue({
      warnThreshold: 0.65,
      critThreshold: 0.85,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and displays current values as integer percent', async () => {
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() => {
      expect(screen.getByLabelText(/warn %/i)).toHaveValue(70);
      expect(screen.getByLabelText(/crit %/i)).toHaveValue(90);
    });
  });

  it('disables Save until a value changes', async () => {
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() => expect(screen.getByLabelText(/warn %/i)).toHaveValue(70));
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText(/warn %/i));
    await userEvent.type(screen.getByLabelText(/warn %/i), '65');
    expect(screen.getByRole('button', { name: /save/i })).toBeEnabled();
  });

  it('submits 0.65 / 0.85 when user enters 65 / 85', async () => {
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() => expect(screen.getByLabelText(/warn %/i)).toHaveValue(70));
    await userEvent.clear(screen.getByLabelText(/warn %/i));
    await userEvent.type(screen.getByLabelText(/warn %/i), '65');
    await userEvent.clear(screen.getByLabelText(/crit %/i));
    await userEvent.type(screen.getByLabelText(/crit %/i), '85');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(api.settings.tenant.update).toHaveBeenCalledWith({
        warnThreshold: 0.65,
        critThreshold: 0.85,
      });
    });
  });

  it('shows inline error when warn >= crit', async () => {
    renderWithClient(<ForecastThresholdsForm />);
    await waitFor(() => expect(screen.getByLabelText(/warn %/i)).toHaveValue(70));
    await userEvent.clear(screen.getByLabelText(/warn %/i));
    await userEvent.type(screen.getByLabelText(/warn %/i), '95');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(screen.getByText(/warn.*less than.*crit/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @lcm/web test forecast-thresholds-form
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the form**

Create `apps/web/src/components/settings/forecast-thresholds-form.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api-client';

export function ForecastThresholdsForm(): React.JSX.Element {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ['tenant-settings'],
    queryFn: () => api.settings.tenant.get(),
  });

  const [warnPct, setWarnPct] = React.useState<number | ''>('');
  const [critPct, setCritPct] = React.useState<number | ''>('');
  const [validationError, setValidationError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (settingsQuery.data) {
      setWarnPct(Math.round(settingsQuery.data.warnThreshold * 100));
      setCritPct(Math.round(settingsQuery.data.critThreshold * 100));
    }
  }, [settingsQuery.data]);

  const mutation = useMutation({
    mutationFn: (input: { warnThreshold: number; critThreshold: number }) =>
      api.settings.tenant.update(input),
    onSuccess: (data) => {
      queryClient.setQueryData(['tenant-settings'], data);
    },
  });

  const initialWarn = settingsQuery.data
    ? Math.round(settingsQuery.data.warnThreshold * 100)
    : null;
  const initialCrit = settingsQuery.data
    ? Math.round(settingsQuery.data.critThreshold * 100)
    : null;
  const dirty =
    typeof warnPct === 'number' &&
    typeof critPct === 'number' &&
    (warnPct !== initialWarn || critPct !== initialCrit);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setValidationError(null);
    if (typeof warnPct !== 'number' || typeof critPct !== 'number') return;
    if (warnPct >= critPct) {
      setValidationError('Warn must be less than crit.');
      return;
    }
    mutation.mutate({ warnThreshold: warnPct / 100, critThreshold: critPct / 100 });
  };

  return (
    <Card className="p-4">
      <header className="mb-4">
        <h2 className="text-h2 font-semibold">Forecast thresholds</h2>
        <p className="text-fg-muted text-sm">
          Default warn/crit bands. Per-cluster overrides apply on the cluster's Settings tab.
        </p>
      </header>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-fg-subtle text-label">Warn %</span>
            <Input
              type="number"
              min={1}
              max={99}
              aria-label="Warn %"
              value={warnPct}
              onChange={(e) => setWarnPct(e.target.value === '' ? '' : Number(e.target.value))}
              className="mt-1"
            />
          </label>
          <label className="block">
            <span className="text-fg-subtle text-label">Crit %</span>
            <Input
              type="number"
              min={1}
              max={99}
              aria-label="Crit %"
              value={critPct}
              onChange={(e) => setCritPct(e.target.value === '' ? '' : Number(e.target.value))}
              className="mt-1"
            />
          </label>
        </div>
        {validationError ? (
          <p className="text-destructive text-sm" role="alert">
            {validationError}
          </p>
        ) : null}
        <div className="flex items-center justify-between">
          <span className="text-fg-subtle text-caption">
            {settingsQuery.data ? 'Source: Saved tenant settings' : 'Source: System defaults'}
          </span>
          <Button type="submit" variant="accent" size="sm" disabled={!dirty || mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
```

- [ ] **Step 4: Run the form tests**

```bash
pnpm --filter @lcm/web test forecast-thresholds-form
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/forecast-thresholds-form.tsx apps/web/src/components/settings/forecast-thresholds-form.test.tsx
git commit -m "feat(web): ForecastThresholdsForm — tenant defaults editor"
```

---

## Task 12: Mount the form in `/settings` route

**Files:**

- Modify: `apps/web/src/routes/settings.tsx`

- [ ] **Step 1: Update the route**

Open `apps/web/src/routes/settings.tsx`. Replace with:

```tsx
import { createFileRoute } from '@tanstack/react-router';

import { ForecastThresholdsForm } from '@/components/settings/forecast-thresholds-form';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

function SettingsPage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <header>
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
          Configuration
        </p>
        <h1 className="mt-1 text-[26px] font-semibold leading-[1.1] tracking-[-0.02em]">
          Settings
        </h1>
      </header>
      <ForecastThresholdsForm />
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web test
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/settings.tsx
git commit -m "feat(web): /settings page hosts ForecastThresholdsForm"
```

---

## Task 13: Build `ThresholdOverridesForm` (per-cluster)

**Files:**

- Create: `apps/web/src/components/clusters/threshold-overrides-form.tsx`
- Create: `apps/web/src/components/clusters/threshold-overrides-form.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/clusters/threshold-overrides-form.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { ThresholdOverridesForm } from './threshold-overrides-form';

const CLUSTER_ID = 'clu_test_001';

function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('<ThresholdOverridesForm>', () => {
  beforeEach(() => {
    vi.spyOn(api.settings.cluster, 'get').mockResolvedValue({
      warnThreshold: null,
      critThreshold: null,
      effective: { warn: 0.7, crit: 0.9, source: 'tenant' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows "Inherited from tenant defaults" when no override', async () => {
    renderWithClient(<ThresholdOverridesForm clusterId={CLUSTER_ID} />);
    await waitFor(() => {
      expect(screen.getByText(/inherited from tenant defaults/i)).toBeInTheDocument();
    });
  });

  it('shows inherited values as placeholders', async () => {
    renderWithClient(<ThresholdOverridesForm clusterId={CLUSTER_ID} />);
    await waitFor(() => {
      expect(screen.getByLabelText(/warn %/i)).toHaveAttribute('placeholder', '70');
      expect(screen.getByLabelText(/crit %/i)).toHaveAttribute('placeholder', '90');
    });
  });

  it('disables Save when no fields populated', async () => {
    renderWithClient(<ThresholdOverridesForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/warn %/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /save override/i })).toBeDisabled();
  });

  it('flips source pill to "Cluster override" after saving', async () => {
    vi.spyOn(api.settings.cluster, 'update').mockResolvedValue({
      warnThreshold: 0.6,
      critThreshold: null,
      effective: { warn: 0.6, crit: 0.9, source: 'cluster' },
    });
    renderWithClient(<ThresholdOverridesForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/warn %/i)).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText(/warn %/i), '60');
    await userEvent.click(screen.getByRole('button', { name: /save override/i }));
    await waitFor(() => {
      expect(screen.getByText(/cluster override/i)).toBeInTheDocument();
    });
  });

  it('calls reset endpoint on "Reset to inherited"', async () => {
    vi.spyOn(api.settings.cluster, 'get').mockResolvedValue({
      warnThreshold: 0.6,
      critThreshold: null,
      effective: { warn: 0.6, crit: 0.9, source: 'cluster' },
    });
    vi.spyOn(api.settings.cluster, 'reset').mockResolvedValue({
      warnThreshold: null,
      critThreshold: null,
      effective: { warn: 0.7, crit: 0.9, source: 'tenant' },
    });
    renderWithClient(<ThresholdOverridesForm clusterId={CLUSTER_ID} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /reset to inherited/i })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: /reset to inherited/i }));
    await waitFor(() => {
      expect(api.settings.cluster.reset).toHaveBeenCalledWith(CLUSTER_ID);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @lcm/web test threshold-overrides-form
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the form**

Create `apps/web/src/components/clusters/threshold-overrides-form.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api-client';

interface ThresholdOverridesFormProps {
  clusterId: string;
}

function pctOrEmpty(value: number | null): number | '' {
  if (value === null) return '';
  return Math.round(value * 100);
}

export function ThresholdOverridesForm({
  clusterId,
}: ThresholdOverridesFormProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ['cluster-settings', clusterId],
    queryFn: () => api.settings.cluster.get(clusterId),
  });

  const [warnPct, setWarnPct] = React.useState<number | ''>('');
  const [critPct, setCritPct] = React.useState<number | ''>('');
  const [validationError, setValidationError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (settingsQuery.data) {
      setWarnPct(pctOrEmpty(settingsQuery.data.warnThreshold));
      setCritPct(pctOrEmpty(settingsQuery.data.critThreshold));
    }
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (input: { warnThreshold: number | null; critThreshold: number | null }) =>
      api.settings.cluster.update(clusterId, input),
    onSuccess: (data) => {
      queryClient.setQueryData(['cluster-settings', clusterId], data);
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => api.settings.cluster.reset(clusterId),
    onSuccess: (data) => {
      queryClient.setQueryData(['cluster-settings', clusterId], data);
      setWarnPct('');
      setCritPct('');
    },
  });

  const isCurrentlyOverridden =
    settingsQuery.data?.effective.source === 'cluster' ||
    settingsQuery.data?.warnThreshold !== null ||
    settingsQuery.data?.critThreshold !== null;

  const canSave =
    (typeof warnPct === 'number' || typeof critPct === 'number') && !saveMutation.isPending;

  const effective = settingsQuery.data?.effective;
  const sourceLabel = isCurrentlyOverridden ? 'Cluster override' : 'Inherited from tenant defaults';

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setValidationError(null);
    if (typeof warnPct === 'number' && typeof critPct === 'number' && warnPct >= critPct) {
      setValidationError('Warn must be less than crit.');
      return;
    }
    saveMutation.mutate({
      warnThreshold: typeof warnPct === 'number' ? warnPct / 100 : null,
      critThreshold: typeof critPct === 'number' ? critPct / 100 : null,
    });
  };

  return (
    <Card className="p-4">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-h2 font-semibold">Thresholds</h2>
          <p className="text-fg-muted text-sm">
            Override tenant defaults for this cluster, or inherit them.
          </p>
        </div>
        <Badge variant={isCurrentlyOverridden ? 'accent' : 'default'}>{sourceLabel}</Badge>
      </header>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-fg-subtle text-label">Warn %</span>
            <Input
              type="number"
              min={1}
              max={99}
              aria-label="Warn %"
              value={warnPct}
              placeholder={effective ? String(Math.round(effective.warn * 100)) : ''}
              onChange={(e) => setWarnPct(e.target.value === '' ? '' : Number(e.target.value))}
              className="mt-1"
            />
          </label>
          <label className="block">
            <span className="text-fg-subtle text-label">Crit %</span>
            <Input
              type="number"
              min={1}
              max={99}
              aria-label="Crit %"
              value={critPct}
              placeholder={effective ? String(Math.round(effective.crit * 100)) : ''}
              onChange={(e) => setCritPct(e.target.value === '' ? '' : Number(e.target.value))}
              className="mt-1"
            />
          </label>
        </div>
        {validationError ? (
          <p className="text-destructive text-sm" role="alert">
            {validationError}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!isCurrentlyOverridden || resetMutation.isPending}
            onClick={() => resetMutation.mutate()}
          >
            Reset to inherited
          </Button>
          <Button type="submit" variant="accent" size="sm" disabled={!canSave}>
            {saveMutation.isPending ? 'Saving…' : 'Save override'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
```

- [ ] **Step 4: Run the form tests**

```bash
pnpm --filter @lcm/web test threshold-overrides-form
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/clusters/threshold-overrides-form.tsx apps/web/src/components/clusters/threshold-overrides-form.test.tsx
git commit -m "feat(web): ThresholdOverridesForm — per-cluster overrides editor"
```

---

## Task 14: Build `SettingsTab` wrapper for cluster detail

**Files:**

- Create: `apps/web/src/components/clusters/settings-tab.tsx`

- [ ] **Step 1: Create the wrapper**

Create `apps/web/src/components/clusters/settings-tab.tsx`:

```tsx
import { ThresholdOverridesForm } from './threshold-overrides-form';

interface SettingsTabProps {
  clusterId: string;
}

export function SettingsTab({ clusterId }: SettingsTabProps): React.JSX.Element {
  return (
    <div className="space-y-6 py-4">
      <ThresholdOverridesForm clusterId={clusterId} />
    </div>
  );
}
```

This wrapper exists so sub-projects 2 and 3 can add more sections (identity edit, lifecycle ops) without restructuring the route.

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter @lcm/web typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/clusters/settings-tab.tsx
git commit -m "feat(web): SettingsTab wrapper for cluster detail"
```

---

## Task 15: Add Settings tab to cluster detail page

**Files:**

- Modify: `apps/web/src/routes/clusters.$id.tsx`

- [ ] **Step 1: Import the wrapper**

Open `apps/web/src/routes/clusters.$id.tsx`. Add to imports:

```tsx
import { SettingsTab } from '@/components/clusters/settings-tab';
```

- [ ] **Step 2: Add the new tab**

Find the `<Tabs>` block:

```tsx
<Tabs defaultValue="hosts" className="pt-2">
  <TabsList>
    <TabsTrigger value="hosts">Hosts</TabsTrigger>
    <TabsTrigger value="applications">Applications</TabsTrigger>
    <TabsTrigger value="events">Events</TabsTrigger>
  </TabsList>
  <TabsContent value="hosts">
    <HostsTab clusterId={id} />
  </TabsContent>
  <TabsContent value="applications">
    <ApplicationsTab clusterId={id} />
  </TabsContent>
  <TabsContent value="events">
    <EventsTab clusterId={id} />
  </TabsContent>
</Tabs>
```

Replace with:

```tsx
<Tabs defaultValue="hosts" className="pt-2">
  <TabsList>
    <TabsTrigger value="hosts">Hosts</TabsTrigger>
    <TabsTrigger value="applications">Applications</TabsTrigger>
    <TabsTrigger value="events">Events</TabsTrigger>
    <TabsTrigger value="settings">Settings</TabsTrigger>
  </TabsList>
  <TabsContent value="hosts">
    <HostsTab clusterId={id} />
  </TabsContent>
  <TabsContent value="applications">
    <ApplicationsTab clusterId={id} />
  </TabsContent>
  <TabsContent value="events">
    <EventsTab clusterId={id} />
  </TabsContent>
  <TabsContent value="settings">
    <SettingsTab clusterId={id} />
  </TabsContent>
</Tabs>
```

- [ ] **Step 3: Run typecheck + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/clusters.$id.tsx
git commit -m "feat(web): add Settings tab to cluster detail page"
```

---

## Task 16: Update Capacity forecast chart — percent labels + effective thresholds

**Files:**

- Modify: `apps/web/src/components/clusters/forecast-chart.tsx`

- [ ] **Step 1: Update the chart**

Open `apps/web/src/components/clusters/forecast-chart.tsx`. Find the two `<ReferenceLine>` blocks (warn and crit). They currently use `maxCeiling * 0.7` and `maxCeiling * 0.9` with `Warn ${formatGB(...)}` labels.

Find any `forecast` prop access. The forecast now has `effectiveThresholds`. Extract:

```tsx
const { warn, crit } = forecast.effectiveThresholds;
```

Update both ReferenceLines:

```tsx
<ReferenceLine
  y={maxCeiling * warn}
  stroke={colors.utilizationWarn}
  strokeDasharray="2 2"
  label={{
    value: `Warn ${Math.round(warn * 100)}%`,
    position: 'right',
    fill: colors.utilizationWarn,
    fontSize: 10,
  }}
/>
<ReferenceLine
  y={maxCeiling * crit}
  stroke={colors.utilizationCrit}
  strokeDasharray="2 2"
  label={{
    value: `Crit ${Math.round(crit * 100)}%`,
    position: 'right',
    fill: colors.utilizationCrit,
    fontSize: 10,
  }}
/>
```

(Preserve the existing prop shapes; only the `y`, the label `value`, and any references to thresholds change. The line geometry is unchanged.)

- [ ] **Step 2: Update the runway-to-warn callers in clusters.$id.tsx**

Open `apps/web/src/routes/clusters.$id.tsx`. Find calls to `runwayToWarn(forecast.months)`. Change to:

```tsx
runwayToWarn(forecast.months, forecast.effectiveThresholds);
```

And calls to `utilStatus(metric.utilization)` in the KPI strip — change to:

```tsx
utilStatus(metric.utilization, forecast.effectiveThresholds);
```

The `UtilizationGauge` inside the KPI strip also takes thresholds now — add:

```tsx
<UtilizationGauge
  value={metric.utilization}
  size="md"
  warn={forecast.effectiveThresholds.warn}
  crit={forecast.effectiveThresholds.crit}
/>
```

- [ ] **Step 3: Run typecheck + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/clusters/forecast-chart.tsx apps/web/src/routes/clusters.\$id.tsx
git commit -m "feat(web): forecast chart shows Warn/Crit as percent; uses effective thresholds"
```

---

## Task 17: Update fleet capacity chart — percent labels via hook

**Files:**

- Modify: `apps/web/src/components/overview/fleet-capacity-chart.tsx`

- [ ] **Step 1: Wire the hook into the fleet chart**

Open `apps/web/src/components/overview/fleet-capacity-chart.tsx`. Add to imports:

```tsx
import { useEffectiveThresholds } from '@/lib/use-effective-thresholds';
```

Inside the component (near the existing `const colors = useChartColors();`):

```tsx
const effectiveThresholds = useEffectiveThresholds();
```

- [ ] **Step 2: Update the reference-line labels**

Find both `<ReferenceLine>` blocks. Replace the labels:

```tsx
<ReferenceLine
  y={maxCeiling * effectiveThresholds.warn}
  stroke={colors.utilizationWarn}
  strokeDasharray="2 2"
  label={{
    value: `Warn ${Math.round(effectiveThresholds.warn * 100)}%`,
    position: 'right',
    fill: colors.utilizationWarn,
    fontSize: 10,
  }}
/>
<ReferenceLine
  y={maxCeiling * effectiveThresholds.crit}
  stroke={colors.utilizationCrit}
  strokeDasharray="2 2"
  label={{
    value: `Crit ${Math.round(effectiveThresholds.crit * 100)}%`,
    position: 'right',
    fill: colors.utilizationCrit,
    fontSize: 10,
  }}
/>
```

- [ ] **Step 3: Run typecheck + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/overview/fleet-capacity-chart.tsx
git commit -m "feat(web): fleet chart shows Warn/Crit as percent via useEffectiveThresholds"
```

---

## Task 18: Update overview KPI tile + clusters list to use tenant thresholds

**Files:**

- Modify: `apps/web/src/routes/index.tsx`
- Modify: `apps/web/src/routes/clusters.index.tsx`

The overview KPI tiles use `utilStatus(summary.utilization)` and `fleetRunwayToWarn(...)`. Thread tenant thresholds through.

- [ ] **Step 1: Update `routes/index.tsx`**

Open `apps/web/src/routes/index.tsx`. Add to imports:

```tsx
import { useEffectiveThresholds } from '@/lib/use-effective-thresholds';
```

Inside the component, near the top:

```tsx
const thresholds = useEffectiveThresholds();
```

Find calls to `utilStatus(summary.utilization)` — change to `utilStatus(summary.utilization, thresholds)`.

Find calls to `fleetRunwayToWarn(...)` — change the second argument to `thresholds`:

```tsx
const fleetRunway = fleetRunwayToWarn(
  summary.perClusterSeries.map((s) => s.months),
  thresholds,
);
```

- [ ] **Step 2: Update `routes/clusters.index.tsx` similarly**

Open `apps/web/src/routes/clusters.index.tsx`. Add the same hook import + invocation. Update any `utilStatus(...)` and `fleetRunwayToWarn(...)` calls to take `thresholds`.

- [ ] **Step 3: Run typecheck + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/index.tsx apps/web/src/routes/clusters.index.tsx
git commit -m "feat(web): overview + clusters list use tenant effective thresholds"
```

---

## Task 19: E2E walkthrough — settings + chart labels

**Files:**

- Create: `apps/web/playwright/settings.spec.ts`

- [ ] **Step 1: Write the e2e test**

Create `apps/web/playwright/settings.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test.describe('configurable thresholds', () => {
  test.afterEach(async ({ page }) => {
    // Reset tenant defaults to 70/90 between tests so subsequent runs are deterministic.
    await page.request.put('/api/settings/tenant', {
      data: { warnThreshold: 0.7, critThreshold: 0.9 },
    });
  });

  test('saves tenant thresholds and chart labels reflect new values', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();

    const warn = page.getByLabel('Warn %');
    const crit = page.getByLabel('Crit %');
    await expect(warn).toHaveValue('70');
    await expect(crit).toHaveValue('90');

    await warn.fill('65');
    await crit.fill('85');
    await page.getByRole('button', { name: /save/i }).click();
    await expect(page.getByText(/source: saved/i)).toBeVisible();

    await page.goto('/');
    await expect(page.getByText('Warn 65%').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Crit 85%').first()).toBeVisible();
  });

  test('cluster override flips chart labels and source pill', async ({ page, request }) => {
    // Pick the first existing cluster.
    const clustersRes = await request.get('/api/clusters');
    const clusters = (await clustersRes.json()) as Array<{ id: string }>;
    test.skip(clusters.length === 0, 'requires seeded clusters');
    const clusterId = clusters[0]!.id;

    await page.goto(`/clusters/${clusterId}`);
    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.getByText(/inherited from tenant defaults/i)).toBeVisible();

    await page.getByLabel('Warn %').fill('60');
    await page.getByLabel('Crit %').fill('85');
    await page.getByRole('button', { name: /save override/i }).click();
    await expect(page.getByText(/cluster override/i)).toBeVisible();

    // Capacity forecast chart shows the new percentages.
    await page.getByRole('tab', { name: 'Hosts' }).click();
    await expect(page.getByText('Warn 60%').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Crit 85%').first()).toBeVisible();

    // Reset.
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('button', { name: /reset to inherited/i }).click();
    await expect(page.getByText(/inherited from tenant defaults/i)).toBeVisible();
  });
});
```

- [ ] **Step 2: Run e2e**

Ensure dev DB + API are running:

```bash
docker compose -f docker-compose.dev.yml up -d
pnpm --filter @lcm/api dev &
```

Then:

```bash
pnpm --filter @lcm/web test:e2e settings.spec.ts
```

Expected: 2/2 PASS. If the second test skips ("requires seeded clusters"), seed the DB:

```bash
pnpm --filter @lcm/api exec prisma db seed
```

Then re-run.

- [ ] **Step 3: Commit**

```bash
git add apps/web/playwright/settings.spec.ts
git commit -m "test(web): e2e for tenant + cluster threshold overrides"
```

---

## Task 20: Final verification + PR

**Files:**

- None — verification + git ops only.

- [ ] **Step 1: Audit for hardcoded thresholds**

```bash
grep -rn "0\.7\|0\.9\|WARN_THRESHOLD\|CRIT_THRESHOLD" apps/web/src apps/api/src --include="*.ts" --include="*.tsx" | grep -v "\.test\." | grep -v SYSTEM_DEFAULTS
```

Expected output: only references to constants defined in `forecast-summary.ts` (which themselves come from `SYSTEM_DEFAULTS`). No raw `0.7` or `0.9` in business logic.

- [ ] **Step 2: Run the entire test suite**

```bash
pnpm -r typecheck
pnpm -r lint
pnpm --filter @lcm/api test
pnpm --filter @lcm/web test
pnpm --filter @lcm/web test:e2e
```

Expected: all PASS.

- [ ] **Step 3: Visual sanity check**

Start the dev stack:

```bash
docker compose -f docker-compose.dev.yml up -d
pnpm --filter @lcm/api dev &
pnpm --filter @lcm/web dev
```

Browser walkthrough:

- `/settings` — Forecast thresholds card with Warn % and Crit %. Save changes to 65/85. Confirm toast/source text updates.
- `/` — Overview chart shows "Warn 65%" / "Crit 85%" reference labels.
- `/clusters/<id>` — Capacity forecast chart shows the same.
- `/clusters/<id>` → Settings tab — override card with placeholders 65/90. Set Warn to 60, click Save override. Source pill flips to "Cluster override".
- Back on the Hosts tab — chart should now show "Warn 60%" / "Crit 85%" (cluster warn + inherited tenant crit).
- Click "Reset to inherited" — source pill returns to "Inherited from tenant defaults"; chart returns to "Warn 65%" / "Crit 85%".

- [ ] **Step 4: Push + PR**

```bash
git push -u origin configurable-thresholds
gh pr create --title "feat: configurable warn/crit thresholds (sub-project 1)" --body "$(cat <<'EOF'
## Summary

Replace hard-coded 0.7/0.9 warn/crit thresholds with a two-level inheritance system: tenant defaults editable at /settings, optional per-cluster overrides editable on a new Settings tab. Capacity forecast chart labels its reference lines with the threshold percent instead of derived GB.

This is sub-project 1 of 3. Sub-project 2 adds cluster name/description editing to the same Settings tab; sub-project 3 adds delete/archive/baseline-reset.

## Changes
- New Prisma tables: `TenantSettings`, `ClusterSettings` (with CHECK constraints)
- New shared module: `resolveThresholds()` runs server + client
- New API: `/api/settings/tenant`, `/api/clusters/:id/settings` (5 endpoints)
- ForecastResponse extended with `effectiveThresholds`
- New hook: `useEffectiveThresholds(clusterId?)`
- New forms: `ForecastThresholdsForm`, `ThresholdOverridesForm`
- Threshold-consuming components accept optional `warn`/`crit` props (backwards-compat defaults)

## Spec
`docs/superpowers/specs/2026-05-24-configurable-thresholds-design.md`

## Test plan
- [x] `pnpm --filter @lcm/shared test` green (resolver + schemas)
- [x] `pnpm --filter @lcm/api test` green (service + 5 endpoints + forecast)
- [x] `pnpm --filter @lcm/web test` green (hook + 2 forms + existing tests)
- [x] `pnpm --filter @lcm/web test:e2e` green (settings.spec.ts: 2/2)
- [x] Visual walkthrough at /settings, /, /clusters/:id

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Apply PR label**

After PR opens:

```bash
gh pr edit <PR_NUMBER> --add-label "PR:Approved"
```

(If labels don't exist, create them per the global CLAUDE.md PR review labeling convention.)

---

## Definition of done

- All 20 tasks complete and committed.
- `pnpm -r typecheck`, `pnpm -r lint`, `pnpm --filter @lcm/api test`, `pnpm --filter @lcm/web test`, `pnpm --filter @lcm/web test:e2e` all green.
- Grep for hardcoded 0.7/0.9 in business logic returns no matches.
- Visual walkthrough confirms:
  - Saving tenant defaults updates all chart labels and KPI bands within one query refetch.
  - Saving a cluster override updates that cluster's chart and KPI without affecting siblings.
  - Resetting reverts the cluster to inherited values immediately.
  - Validation errors render inline.
- PR open with spec link + test-plan checklist.
