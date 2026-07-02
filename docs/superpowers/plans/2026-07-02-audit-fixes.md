# Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every finding from the 2026-07-02 security/quality audit: dependency majors (TS 6, ESLint 10, Vite 8/Vitest 4, Zod 4, @fastify/cors 11, lucide-react 1.x, testcontainers 12), server hardening (helmet/rate-limit/under-pressure, CORS allowlist, forecast range cap, schema bounds, serializable append transactions, pagination), web correctness (fleet KPI current-month, query invalidations, form bounds, API response validation), and infra hardening (compose fail-closed password + container hardening, nginx security headers, CI permissions + SHA pins, dockerignore fix, docs drift).

**Architecture:** Four sequential phases. Phase B (dependencies) lands first so all code fixes are written against final APIs. Phase C (server + shared schemas) and Phase D (web) build on B; Phase E (infra) is independent and can run any time. Every task ends with the workspace green (`lint`, `typecheck`, `test` for the touched packages).

**Tech Stack:** pnpm 11 monorepo · Fastify 5 + Prisma 6 (stays on 6 — v7 explicitly out of scope) · Zod 4 · React 19 + TanStack Router/Query · Vite 8 + Vitest 4 · Docker Compose + nginx + GitHub Actions.

## Global Constraints

- `pnpm` is NOT on PATH on this machine. Run every pnpm command as `npx -y pnpm@11 <args>` (referred to as `PNPM` below).
- Server integration tests use testcontainers → Docker Desktop must be running. Verify with `docker info` before any test run; if unavailable, stop and report.
- Prisma stays on 6.x (bump within 6 only). Node engines stay `>=22`.
- Zod 4 syntax everywhere after Task B3: `z.strictObject`, `z.flattenError(err)`, `z.core.$ZodIssue`, `z.url()`.
- Commit after every task, message style `fix(scope): ...` / `chore(deps): ...` matching repo history. Never commit `.env` or binaries. Do NOT push — user pushes manually.
- New env vars introduced (Task C4): `CORS_ORIGIN` (optional, comma-separated origins; unset = CORS disabled), `TRUST_PROXY` (default `loopback,uniquelocal`), `RATE_LIMIT_MAX` (default `300`).
- Forecast span cap: `MAX_FORECAST_SPAN_MONTHS = 120`.
- Pagination: `limit` default 100 / max 500, `offset` default 0, envelope `{ items, total, limit, offset }` on GET `/api/clusters`, `/api/clusters/:clusterId/hosts`, `/api/clusters/:clusterId/items`. Host lifecycle events + categories stay unpaginated (naturally small).
- Amount caps: `positiveAmount.max(1e12)`; event deltas `min(-1e12).max(1e12)`. Array caps: baselines `.max(50)`, capacities/allocations `.max(1000)`.

---

## Phase A — Setup

### Task A1: Branch

**Files:** none

- [ ] **Step 1:** `git -C /Users/simon/Documents/localGIT/lifecycle-management checkout -b fix/audit-hardening`
- [ ] **Step 2:** `docker info --format '{{.ServerVersion}}'` — expect a version string. If it errors, STOP and report "Docker not running; integration tests impossible".

---

## Phase B — Dependency upgrades

General note for every B task: after editing `package.json` files run `PNPM install` (updates `pnpm-lock.yaml`), then the listed verification commands. `PNPM install` may print peer warnings — investigate only errors.

### Task B1: TypeScript 6 + ESLint 10 toolchain

**Files:**
- Modify: `package.json` (root devDependencies)
- Possibly modify: `tsconfig.base.json`, `eslint.config.js`, and any files with new type errors

**Interfaces:** none (toolchain only)

- [ ] **Step 1:** In root `package.json` devDependencies set:

```json
"@eslint/js": "^10.0.1",
"eslint": "^10.6.0",
"eslint-config-prettier": "^10.1.0",
"typescript": "^6.0.3",
"typescript-eslint": "^8.62.0"
```

(keep `eslint-plugin-react-hooks` at `^7.1.1` — v7 supports ESLint 10; bump patch if `PNPM outdated` shows one.)

- [ ] **Step 2:** `PNPM install`
- [ ] **Step 3:** `PNPM --filter @lcm/server exec prisma generate && PNPM --filter @lcm/web generate-routes` (type stubs needed before typecheck)
- [ ] **Step 4:** `PNPM typecheck` — fix any TS 6 fallout. Known TS 6 changes to check if errors appear: removed `node10` module resolution (repo uses `bundler`/`nodenext` — likely fine), stricter enum/narrowing rules. Fix errors minimally, do not restructure.
- [ ] **Step 5:** `PNPM lint` — fix any ESLint 10 fallout (flat config is already in use; most likely zero changes needed beyond rule renames reported in output).
- [ ] **Step 6:** `PNPM test` (docker must be up) — expect all pass.
- [ ] **Step 7:** Commit: `chore(deps): upgrade to TypeScript 6 and ESLint 10`

### Task B2: Vite 8 + Vitest 4 stack

**Files:**
- Modify: `package.json` (root: vitest), `apps/web/package.json`, `packages/shared/package.json` (vitest devDep)
- Possibly modify: `apps/web/vite.config.ts`, `apps/web/vitest.config.ts` (or test section in vite config)

**Interfaces:** none

- [ ] **Step 1:** Root `package.json`: `"vitest": "^4.1.9"`. `packages/shared/package.json` devDeps: `"vitest": "^4.1.9"`. `apps/web/package.json`: set

```json
"@playwright/test": "^1.61.1",
"@tailwindcss/vite": "^4.3.2",
"@tanstack/router-cli": "^1.170.16",
"@tanstack/router-devtools": "^1.170.16",
"@tanstack/router-plugin": "^1.170.16",
"@vitejs/plugin-react": "^6.0.3",
"jsdom": "^29.1.1",
"tailwindcss": "^4.3.2",
"vite": "^8.1.2",
"vitest": "^4.1.9"
```

- [ ] **Step 2:** `PNPM install`
- [ ] **Step 3:** `PNPM --filter @lcm/web generate-routes && PNPM typecheck`
- [ ] **Step 4:** `PNPM test` — Vitest 4 known breaking changes if failures appear: `workspace` config replaced by `projects`; `environment` per-file pragmas unchanged; `vi.mock` hoisting stricter. Fix config only, not tests' assertions.
- [ ] **Step 5:** `PNPM build` — expect vite 8 build success. If `@tailwindcss/vite` rejects vite 8 peer, check `PNPM why` output and bump tailwind packages to the newest 4.x that accepts it.
- [ ] **Step 6:** `PNPM lint`
- [ ] **Step 7:** Commit: `chore(deps): upgrade to Vite 8 and Vitest 4`

### Task B3: Zod 4 migration

**Files:**
- Modify: `packages/shared/package.json` (`"zod": "^4.4.3"`), `apps/server/package.json` (`"zod": "^4.4.3"`)
- Modify: `apps/server/src/plugins/error-handler.ts:23` (flatten), `apps/server/src/env.ts` (ZodIssue type, url())
- Possibly modify: any file failing typecheck afterward

**Interfaces:**
- Produces: all shared schemas behave identically on the wire; `error.flatten()` replaced by `z.flattenError(error)`.

- [ ] **Step 1:** Bump both package.jsons to `"zod": "^4.4.3"`, `PNPM install`.
- [ ] **Step 2:** `apps/server/src/plugins/error-handler.ts` — add `z` import and replace flatten:

```ts
import { z, ZodError } from 'zod';
```

and in the ZodError branch replace `details: error.flatten(),` with:

```ts
          details: z.flattenError(error),
```

- [ ] **Step 3:** `apps/server/src/env.ts` — replace the two `z.ZodIssue[]` occurrences with `z.core.$ZodIssue[]` and change `DATABASE_URL: z.string().url()` to `DATABASE_URL: z.url()`.
- [ ] **Step 4:** `grep -rn "\.error\.errors\|error\.errors" apps packages --include='*.ts' --include='*.tsx'` — the `.errors` alias was removed in Zod 4; replace any hits with `.issues`. `grep -rn "z\.record(" apps packages --include='*.ts'` — Zod 4 requires explicit key schema `z.record(z.string(), value)`; fix any hits.
- [ ] **Step 5:** `PNPM typecheck` then `PNPM test` then `PNPM lint` — fix remaining fallout (most schemas in this repo use only `.object/.string/.number/.enum/.literal/.discriminatedUnion/.refine/.transform/.coerce`, all unchanged in v4).
- [ ] **Step 6:** Commit: `chore(deps): migrate to Zod 4`

### Task B4: Fastify ecosystem + app-dep bumps

**Files:**
- Modify: `apps/server/package.json`, `apps/web/package.json`, root `package.json`
- Modify: `apps/server/src/server.ts:36` (cors call), any lucide icon imports that were renamed

**Interfaces:**
- Produces: `server.register(cors, { origin: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] })` — temporary; Task C4 replaces `origin: true` with the allowlist.

- [ ] **Step 1:** `apps/server/package.json`:

```json
"@fastify/cors": "^11.2.0",
"@fastify/sensible": "^6.0.4",
"dotenv": "^17.4.2",
"fastify": "^5.9.0",
"fastify-plugin": "^6.0.0",
"@prisma/client": "^6.19.3",
"prisma": "^6.19.3",
"pino-pretty": "^13.0.0",
"tsx": "^4.19.2"
```

(keep prisma pair on 6.x — v7 is out of scope). `apps/web/package.json` dependencies:

```json
"@tanstack/react-query": "^5.101.2",
"@tanstack/react-router": "^1.170.16",
"lucide-react": "^1.22.0",
"motion": "^12.42.2",
"radix-ui": "^1.6.1",
"react": "^19.2.7",
"react-dom": "^19.2.7",
"react-is": "^19.2.7",
"recharts": "^3.9.1"
```

Root: `"prettier": "^3.9.4"`, `"@types/node": "^22.19.19"`, `"husky": "^9.1.7"`, `"lint-staged": "^15.4.1"` (or newest minors `PNPM outdated -r` shows within the same major).

- [ ] **Step 2:** `PNPM install`
- [ ] **Step 3:** `apps/server/src/server.ts:36` — @fastify/cors 11 no longer defaults to all methods; make them explicit:

```ts
  await server.register(cors, {
    origin: true, // tightened to an env-driven allowlist in Task C4
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
```

- [ ] **Step 4:** `PNPM --filter @lcm/server exec prisma generate`, then `PNPM typecheck`. lucide-react 1.x renamed some icons — if imports fail, check the error list and apply the new names 1:1 (e.g. grep the failing name in `node_modules/lucide-react/dist/lucide-react.d.ts` to find its replacement).
- [ ] **Step 5:** `PNPM test && PNPM build && PNPM lint`
- [ ] **Step 6:** Commit: `chore(deps): bump fastify ecosystem, react, tanstack, lucide 1.x`

### Task B5: Test-dependency security bumps + xlsx CDN pin

**Files:**
- Modify: `apps/server/package.json` (devDependencies)

**Interfaces:** none

- [ ] **Step 1:** `apps/server/package.json` devDependencies:

```json
"@testcontainers/postgresql": "^12.0.4",
"testcontainers": "^12.0.4",
"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
```

- [ ] **Step 2:** `PNPM install`
- [ ] **Step 3:** `PNPM --filter @lcm/server test` — testcontainers 12 API changes: `new PostgreSqlContainer()` now REQUIRES an explicit image argument in v11+; grep `apps/server` for `new PostgreSqlContainer(` and ensure it passes an image string (e.g. `new PostgreSqlContainer('postgres:16-alpine')`); fix if the tests construct it bare.
- [ ] **Step 4:** Verify the xlsx pin actually parses the reference workbook without touching the DB:

```bash
PNPM --filter @lcm/server exec tsx -e "import { parseCapacityXlsx } from './scripts/lib/parse-capacity-xlsx.js'; const r = parseCapacityXlsx(new URL('../../docs/Capacity_Forecast_vSphere.xlsx', import.meta.url).pathname); console.log('clusters parsed:', Object.keys(r).length);"
```

(adjust the import path/name to the actual export of `apps/server/scripts/lib/parse-capacity-xlsx.ts` — read that file first; the goal is: call the parse function on `docs/Capacity_Forecast_vSphere.xlsx`, print a summary, exit 0.)

- [ ] **Step 5:** `PNPM audit` — expect the xlsx, testcontainers/undici/tmp/protobufjs, vitest/vite/esbuild advisory clusters gone. Record any remaining advisories in the commit body.
- [ ] **Step 6:** Commit: `chore(deps): patch xlsx via SheetJS CDN, bump testcontainers — clears audit advisories`

---

## Phase C — Server + shared-schema fixes

### Task C1: Forecast range bounds (DoS fix)

**Files:**
- Modify: `packages/shared/src/schemas/forecast.ts`, `packages/shared/src/dates.ts` (add helper)
- Modify: `apps/server/src/services/forecast-loader.ts` (~line 109, after from/to derivation)
- Test: `packages/shared/src/schemas/__tests__/forecast.test.ts` (create), plus the server's existing forecast route test file (extend)

**Interfaces:**
- Produces: `MAX_FORECAST_SPAN_MONTHS = 120` exported from `@lcm/shared`; `monthsBetweenUtc(from: Date, to: Date): number` exported from `@lcm/shared` (dates module).

- [ ] **Step 1:** Write failing tests in `packages/shared/src/schemas/__tests__/forecast.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { forecastQuerySchema, MAX_FORECAST_SPAN_MONTHS } from '../forecast.js';

describe('forecastQuerySchema range bounds', () => {
  it('rejects from > to', () => {
    const r = forecastQuerySchema.safeParse({ metric: 'memory_gb', from: '2027-01', to: '2026-01' });
    expect(r.success).toBe(false);
  });
  it('rejects spans over MAX_FORECAST_SPAN_MONTHS', () => {
    const r = forecastQuerySchema.safeParse({ metric: 'memory_gb', from: '2026-01', to: '2999-12' });
    expect(r.success).toBe(false);
  });
  it('accepts a 24-month window', () => {
    const r = forecastQuerySchema.safeParse({ metric: 'memory_gb', from: '2026-01', to: '2027-12' });
    expect(r.success).toBe(true);
  });
  it('still accepts omitted bounds', () => {
    expect(forecastQuerySchema.safeParse({ metric: 'memory_gb' }).success).toBe(true);
  });
  it('exports a 120-month cap', () => {
    expect(MAX_FORECAST_SPAN_MONTHS).toBe(120);
  });
});
```

- [ ] **Step 2:** `PNPM --filter @lcm/shared test` — expect FAIL (no export, no refine).
- [ ] **Step 3:** Add to `packages/shared/src/dates.ts` (read the file first; append in its style):

```ts
/** Whole-month difference between two UTC dates (to minus from). */
export function monthsBetweenUtc(from: Date, to: Date): number {
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}
```

In `packages/shared/src/schemas/forecast.ts` replace `forecastQuerySchema` with:

```ts
import { monthsBetweenUtc } from '../dates.js';

/** Hard cap on the forecast window — protects the O(months × rows) compute loop. */
export const MAX_FORECAST_SPAN_MONTHS = 120;

export const forecastQuerySchema = z
  .object({
    metric: z.string().min(1),
    from: monthOnly.optional(),
    to: monthOnly.optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: 'from must be on or before to',
    path: ['from'],
  })
  .refine(
    (q) =>
      q.from === undefined ||
      q.to === undefined ||
      monthsBetweenUtc(q.from, q.to) <= MAX_FORECAST_SPAN_MONTHS,
    { message: `Range must not exceed ${MAX_FORECAST_SPAN_MONTHS} months`, path: ['to'] },
  );
```

Ensure both new symbols are exported from the shared package's index barrel.

- [ ] **Step 4:** Server-side cap regardless of client input (a lone `?to=9999-12` still explodes via the baseline-date default). In `apps/server/src/services/forecast-loader.ts`, immediately after `const toMonth = ...` (~line 110):

```ts
    if (toMonth < fromMonth) {
      throw new UnprocessableError('INVALID_RANGE', 'to must be on or after from');
    }
    if (monthsBetweenUtc(fromMonth, toMonth) > MAX_FORECAST_SPAN_MONTHS) {
      throw new UnprocessableError(
        'RANGE_TOO_LARGE',
        `Forecast window must not exceed ${MAX_FORECAST_SPAN_MONTHS} months`,
      );
    }
```

Import `MAX_FORECAST_SPAN_MONTHS, monthsBetweenUtc` from `@lcm/shared`. `UnprocessableError` is already imported in this file.

- [ ] **Step 5:** Extend the server's existing forecast route integration test file (find it via `grep -rl "forecast" apps/server/src --include='*test*'`): add a case asserting `GET /api/clusters/:id/forecast?metric=memory_gb&from=0001-01&to=9999-12` returns 400, and `?from=2027-01&to=2026-01` returns 400 (not 500).
- [ ] **Step 6:** `PNPM --filter @lcm/shared test && PNPM --filter @lcm/server test` — expect PASS.
- [ ] **Step 7:** Commit: `fix(server): cap forecast window at 120 months, 400 on inverted range`

### Task C2: `includeArchived` boolean coercion fix

**Files:**
- Modify: `packages/shared/src/schemas/cluster.ts:36-38`
- Test: `packages/shared/src/schemas/__tests__/cluster.test.ts` (create or extend)

**Interfaces:**
- Produces: `clustersListQuerySchema` output type `{ includeArchived: boolean; limit: number; offset: number }` after C8 merges pagination; in this task just `{ includeArchived: boolean }`.

- [ ] **Step 1:** Failing test:

```ts
import { describe, expect, it } from 'vitest';
import { clustersListQuerySchema } from '../cluster.js';

describe('clustersListQuerySchema.includeArchived', () => {
  it.each([
    ['true', true],
    ['false', false],
    [undefined, false],
  ])('parses %s to %s', (wire, expected) => {
    const parsed = clustersListQuerySchema.parse(wire === undefined ? {} : { includeArchived: wire });
    expect(parsed.includeArchived).toBe(expected);
  });
  it('rejects junk values', () => {
    expect(clustersListQuerySchema.safeParse({ includeArchived: 'yes' }).success).toBe(false);
  });
});
```

- [ ] **Step 2:** Run — expect FAIL (`'false'` currently coerces to `true`).
- [ ] **Step 3:** Replace the schema:

```ts
export const clustersListQuerySchema = z.object({
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
```

In `apps/server/src/routes/clusters.ts:17` the `?? false` is now redundant — simplify to `{ includeArchived: query.includeArchived }`.

- [ ] **Step 4:** Run shared + server tests — PASS. Note: `apps/web/src/lib/api-client.ts:215-217` only ever sends `includeArchived=true`, so no web change needed.
- [ ] **Step 5:** Commit: `fix(shared): includeArchived=false no longer parses as true`

### Task C3: Input bounds + strict schemas

**Files:**
- Modify: `packages/shared/src/schemas/common.ts`, `cluster.ts`, `host.ts`, `item.ts`, `settings.ts`
- Test: `packages/shared/src/schemas/__tests__/bounds.test.ts` (create)

**Interfaces:**
- Produces: identical schema names/output types; only stricter runtime acceptance.

- [ ] **Step 1:** Failing tests in `bounds.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  clusterCreateInputSchema,
  hostCreateInputSchema,
  itemCreateInputSchema,
} from '../../index.js';

const cap = (i: number) => ({ metricTypeKey: 'memory_gb', effectiveFrom: '2026-01-01', amount: i });

describe('input bounds', () => {
  it('rejects amounts above 1e12', () => {
    expect(
      hostCreateInputSchema.safeParse({
        name: 'h', commissionedAt: '2026-01-01',
        capacities: [{ ...cap(0), amount: 1e13 }],
      }).success,
    ).toBe(false);
  });
  it('rejects more than 1000 capacity rows', () => {
    expect(
      hostCreateInputSchema.safeParse({
        name: 'h', commissionedAt: '2026-01-01',
        capacities: Array.from({ length: 1001 }, (_, i) => cap(i)),
      }).success,
    ).toBe(false);
  });
  it('rejects more than 50 baselines', () => {
    expect(
      clusterCreateInputSchema.safeParse({
        name: 'c', baselineDate: '2026-01-01',
        baselines: Array.from({ length: 51 }, (_, i) => ({
          metricTypeKey: `m${i}`, baselineConsumption: 1, baselineCapacity: 2,
        })),
      }).success,
    ).toBe(false);
  });
  it('rejects unknown keys on create bodies', () => {
    expect(
      itemCreateInputSchema.safeParse({
        kind: 'event', name: 'e', category: 'Growth', effectiveDate: '2026-01-01',
        metricTypeKey: 'memory_gb', evil: true,
      }).success,
    ).toBe(false);
  });
});
```

Note the duplicate-effectiveFrom nuance: the 1001-rows test uses `cap(i)` with distinct amounts but the SAME date — if the schema layer doesn't dedupe (it doesn't), that's fine for a pure bounds test.

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Apply bounds. `common.ts`:

```ts
/** Upper bound keeps values inside Postgres Decimal(18,3)'s 15 integer digits. */
export const MAX_AMOUNT = 1_000_000_000_000;

export const positiveAmount = z
  .number()
  .nonnegative({ message: 'Must be greater than or equal to 0' })
  .finite()
  .max(MAX_AMOUNT);
```

`item.ts`: `const deltaNumber = z.number().finite().min(-MAX_AMOUNT).max(MAX_AMOUNT);` (import `MAX_AMOUNT`). Array caps: in `cluster.ts` both `baselines: z.array(metricBaselineInputSchema).min(1).max(50)` occurrences; in `host.ts` `capacities: z.array(capacityRowInputSchema).min(1).max(1000)`; in `item.ts` `allocations: z.array(itemAllocationRowInputSchema).min(1).max(1000)`.

- [ ] **Step 4:** Strictness — convert these `z.object` calls to `z.strictObject` (Zod 4 idiom), keeping every field identical: `metricBaselineInputSchema`, `clusterCreateInputSchema`, `clusterUpdateInputSchema` (chain `.refine` unchanged), `capacityRowInputSchema`, `hostCreateInputSchema`, `applicationItemCreateSchema`, `eventItemCreateSchema`, `itemUpdateInputSchema`, `itemAllocationRowInputSchema`, `tenantSettingsSchema`, `clusterSettingsInputSchema`. `hostUpdateInputSchema` already has `.strict()` — convert it to `z.strictObject` for consistency. Do NOT touch query/params schemas (querystrings can legitimately carry extra keys).
- [ ] **Step 5:** `PNPM --filter @lcm/shared test && PNPM --filter @lcm/server test && PNPM --filter @lcm/web typecheck` (web imports these schemas for form validation — strictness must not break its wire payloads; the web builds payloads field-by-field so it should pass).
- [ ] **Step 6:** Commit: `fix(shared): bound amounts/arrays, reject unknown keys on write bodies`

### Task C4: Fastify production hardening

**Files:**
- Modify: `apps/server/package.json` (add plugins), `apps/server/src/env.ts`, `apps/server/src/server.ts`
- Modify: `.env.example`, `README.md` (env table), `docker/docker-compose.yml` (pass-through), `docker/docker-compose.dev.yml` if it sets server env (check)
- Test: server integration test for rate-limit config exclusion + a headers assertion

**Interfaces:**
- Produces: `envSchema` gains `CORS_ORIGIN: string | undefined`, `TRUST_PROXY: string` (default `'loopback,uniquelocal'`), `RATE_LIMIT_MAX: number` (default 300). `buildServer` behavior: helmet headers on all responses; 429 after RATE_LIMIT_MAX req/min/IP (skipped when `NODE_ENV === 'test'`); 503 under event-loop pressure; CORS disabled unless CORS_ORIGIN set.

- [ ] **Step 1:** `PNPM --filter @lcm/server add @fastify/helmet @fastify/rate-limit @fastify/under-pressure`
- [ ] **Step 2:** `apps/server/src/env.ts` — add to `envSchema`:

```ts
  CORS_ORIGIN: z.string().optional(),
  TRUST_PROXY: z.string().default('loopback,uniquelocal'),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
```

- [ ] **Step 3:** `apps/server/src/server.ts` — imports:

```ts
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import underPressure from '@fastify/under-pressure';
```

Server options: `trustProxy: env.TRUST_PROXY, bodyLimit: 1_048_576,` (replaces `trustProxy: true`). Registrations, replacing the current cors line:

```ts
  await server.register(helmet, {
    // The SPA's CSP is owned by nginx (docker/nginx.conf); this is a JSON API.
    contentSecurityPolicy: false,
    // Internal deployments serve plain HTTP; an HSTS header would be misleading.
    strictTransportSecurity: false,
  });

  // Same-origin proxies (Vite dev, nginx prod) mean CORS is normally unnecessary;
  // it stays off unless an allowlist is configured.
  const corsOrigins = env.CORS_ORIGIN?.split(',').map((o) => o.trim()).filter(Boolean);
  await server.register(cors, {
    origin: corsOrigins && corsOrigins.length > 0 ? corsOrigins : false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  if (env.NODE_ENV !== 'test') {
    await server.register(rateLimit, {
      max: env.RATE_LIMIT_MAX,
      timeWindow: '1 minute',
    });
    await server.register(underPressure, {
      maxEventLoopDelay: 1000,
      message: 'Service under pressure',
      retryAfter: 10,
    });
  }
```

- [ ] **Step 4:** Add an integration test (in the server's existing route-test style) asserting a plain GET `/healthz` response carries `x-content-type-options: nosniff` (helmet active) and no `access-control-allow-origin` header when CORS_ORIGIN is unset.
- [ ] **Step 5:** Documentation sync — `.env.example`: under the local-development block change `PORT=8080` to `PORT=8090` (matches README's dev-port claim) and append after `LOG_LEVEL=info`:

```
# Optional hardening knobs (defaults shown; normally leave unset)
#CORS_ORIGIN=
#TRUST_PROXY=loopback,uniquelocal
#RATE_LIMIT_MAX=300
```

`README.md` env table: add rows `CORS_ORIGIN` (unset → CORS disabled), `TRUST_PROXY` (default `loopback,uniquelocal`), `RATE_LIMIT_MAX` (default 300). `docker/docker-compose.yml` server environment: add `CORS_ORIGIN: ${CORS_ORIGIN:-}` and `RATE_LIMIT_MAX: ${RATE_LIMIT_MAX:-300}`.

- [ ] **Step 6:** `PNPM --filter @lcm/server test && PNPM typecheck && PNPM lint`
- [ ] **Step 7:** Commit: `feat(server): helmet, rate limiting, under-pressure, CORS allowlist, scoped trustProxy`

### Task C5: Process lifecycle + Prisma logging

**Files:**
- Modify: `apps/server/src/index.ts`, `apps/server/src/plugins/prisma.ts:16`

**Interfaces:** none (behavioral)

- [ ] **Step 1:** Replace `apps/server/src/index.ts` main body with a guarded shutdown:

```ts
import 'dotenv/config';

import { parseEnv } from './env.js';
import { buildServer } from './server.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const env = parseEnv();
  const server = await buildServer({ env });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.log.info({ signal }, 'Shutting down');
    const timer = setTimeout(() => {
      server.log.error('Shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    server.log.error({ err: reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    server.log.error({ err }, 'Uncaught exception');
    process.exit(1);
  });

  try {
    await server.listen({ port: env.PORT, host: env.HOST });
  } catch (err) {
    server.log.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2:** `apps/server/src/plugins/prisma.ts:16` — `const client = opts.prisma ?? new PrismaClient({ log: ['warn', 'error'] });`
- [ ] **Step 3:** Pino redaction (pre-auth hygiene): in `apps/server/src/server.ts` `buildLoggerConfig`, add to BOTH returned config objects (development and production branches):

```ts
      redact: ['req.headers.authorization', 'req.headers.cookie'],
```

(explicit keys, no wildcards — wildcard redaction is ~50% slower).

- [ ] **Step 4:** `PNPM --filter @lcm/server test && PNPM typecheck`
- [ ] **Step 5:** Commit: `fix(server): guarded shutdown with timeout, crash-safe process handlers, log redaction, prisma warn/error logs`

### Task C6: Serialize append/transition write races

**Files:**
- Modify: `apps/server/src/services/hosts.ts` (appendCapacity), `apps/server/src/services/items.ts` (appendAllocation), `apps/server/src/services/host-lifecycle.ts` (transition — read the TODO at ~line 30 first)
- Modify: the service that maps Prisma errors (find `translatePrismaError` implementations) to add P2034 → 409

**Interfaces:**
- Produces: same public signatures; concurrent conflicting appends now yield HTTP 409 `WRITE_CONFLICT` instead of corrupting the monotonic-date invariant.

- [ ] **Step 1:** In `hosts.ts` `appendCapacity`, wrap the read-validate-create sequence (currently `findFirst` → checks → `create`) in a serializable interactive transaction. Shape:

```ts
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const host = await tx.host.findFirst({
            where: { id, tenantId },
            include: { capacities: { include: { metricType: true } } },
          });
          // ...move the existing NotFound / EFFECTIVE_BEFORE_COMMISSION /
          // metricType / EFFECTIVE_NOT_MONOTONIC checks here unchanged,
          // resolving metric types via tx...
          await tx.hostMetricCapacity.create({ data: { /* unchanged */ } });
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (err) {
      this.translatePrismaError(err);
      throw err;
    }
    return this.getById(tenantId, id);
```

`resolveMetricTypes` currently uses `this.prisma` — add an optional `tx` parameter (`tx: Prisma.TransactionClient = this.prisma`) so it can run inside the transaction.

- [ ] **Step 2:** Same restructure for `items.ts` `appendAllocation` (NotFound / NOT_AN_APPLICATION / EFFECTIVE_BEFORE_START / metric / monotonic checks + create inside one Serializable transaction).
- [ ] **Step 3:** `host-lifecycle.ts` `transition` — read it; it already runs in a transaction per the audit (lines 29-68) but with a documented race TODO. Add `{ isolationLevel: 'Serializable' }` as the transaction options argument and delete the TODO comment.
- [ ] **Step 4:** In `translatePrismaError` (grep for it in both services — likely a shared private method or util): add before other checks:

```ts
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      throw new ConflictError('WRITE_CONFLICT', 'Concurrent write detected; retry the request');
    }
```

If no `ConflictError` (409) exists in `apps/server/src/services/errors.ts`, add one mirroring `UnprocessableError`'s shape with `statusCode = 409`.

- [ ] **Step 5:** `PNPM --filter @lcm/server test` — existing append monotonicity tests must still pass (the invariant checks moved, not changed).
- [ ] **Step 6:** Commit: `fix(server): serializable transactions for capacity/allocation appends and lifecycle transitions`

### Task C7: Tenant scoping on ClusterSettings queries

**Files:**
- Modify: `apps/server/src/services/settings.ts` (~lines 69-71, 101-112, 126)
- Read first: `apps/server/prisma/schema.prisma` (ClusterSettings model)

**Interfaces:** none (defense in depth; behavior unchanged for legitimate requests)

- [ ] **Step 1:** Read the ClusterSettings model in `schema.prisma`. Two cases:
  - If it has a `tenantId` column: add `tenantId` to every `where: { clusterId }` filter in find/delete calls. For `upsert`, if the unique index is `clusterId` alone, keep the upsert `where` as `{ clusterId }` but add `tenantId` to the `create` payload (already there, verify) and a preceding `findFirst({ where: { clusterId, tenantId } })` is NOT needed — the existing `assertClusterExists(tenantId, clusterId)` covers it; instead add a comment: `// upsert keyed on clusterId alone: safe because assertClusterExists() above pins the tenant`.
  - If it has no `tenantId` column: filter through the relation instead — `where: { clusterId, cluster: { tenantId } }` for find/delete, same comment treatment for upsert.
- [ ] **Step 2:** `PNPM --filter @lcm/server test`
- [ ] **Step 3:** Commit: `fix(server): tenant-scope ClusterSettings queries`

### Task C8: Pagination on list endpoints

**Files:**
- Create: `packages/shared/src/schemas/pagination.ts`
- Modify: `packages/shared/src/schemas/cluster.ts` (merge pagination into list query), shared index barrel
- Modify: `apps/server/src/routes/clusters.ts:15-18`, `apps/server/src/routes/hosts.ts:19-22`, `apps/server/src/routes/items.ts:15-18`
- Modify: `apps/server/src/services/clusters.ts` (list), `apps/server/src/services/hosts.ts` (listByCluster), `apps/server/src/services/items.ts` (listByCluster)
- Test: shared schema test + server integration tests for the three endpoints

**Interfaces:**
- Produces (consumed by Task D4b): `paginationQuerySchema` (limit default 100 max 500, offset default 0); `interface Paginated<T> { items: T[]; total: number; limit: number; offset: number }`; all three list endpoints return `Paginated<...Response>`.

- [ ] **Step 1:** `packages/shared/src/schemas/pagination.ts`:

```ts
import { z } from 'zod';

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
```

Export from the shared barrel. In `cluster.ts`:

```ts
export const clustersListQuerySchema = paginationQuerySchema.extend({
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
```

Schema test: `parse({})` yields `{ limit: 100, offset: 0, includeArchived: false }`; `limit=1000` rejected; `offset=-1` rejected.

- [ ] **Step 2:** Services. `clusters.ts` `list` becomes:

```ts
  async list(
    tenantId: string,
    options: { includeArchived?: boolean; limit: number; offset: number },
  ): Promise<Paginated<ClusterResponse>> {
    const where = options.includeArchived ? { tenantId } : { tenantId, archivedAt: null };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.cluster.count({ where }),
      this.prisma.cluster.findMany({
        where,
        include: clusterInclude,
        orderBy: { name: 'asc' },
        take: options.limit,
        skip: options.offset,
      }),
    ]);
    return {
      items: rows.map((row) => this.toResponse(row)),
      total,
      limit: options.limit,
      offset: options.offset,
    };
  }
```

Apply the same `{ count + findMany take/skip }` → `Paginated<...>` pattern to `hosts.ts` `listByCluster` and `items.ts` `listByCluster` (keep their existing `assertClusterExists` + ordering; add `limit/offset` params).

- [ ] **Step 3:** Routes — `clusters.ts`: `service.list(request.tenantId, query)` (query now carries all three fields). `hosts.ts`/`items.ts` GET list handlers: `const { limit, offset } = paginationQuerySchema.parse(request.query);` and pass through.
- [ ] **Step 4:** Fix server integration tests that treated list responses as arrays: grep test files for the three endpoints and switch assertions to `body.items` / add `total` checks. Add one new case: create 3 items, `?limit=2` → `items.length === 2, total === 3`, `?limit=2&offset=2` → remaining 1.
- [ ] **Step 5:** `PNPM --filter @lcm/server test && PNPM typecheck` — the WEB will now fail typecheck until D4b; that is expected mid-phase. Run `PNPM --filter @lcm/server typecheck && PNPM --filter @lcm/shared typecheck` only.
- [ ] **Step 6:** Commit: `feat(api): paginate cluster/host/item list endpoints`

---

## Phase D — Web fixes

### Task D1: Fleet KPI reads the current month

**Files:**
- Modify: `apps/web/src/lib/aggregate-fleet.ts:72-92`
- Test: `apps/web/src/lib/aggregate-fleet.test.ts` (find exact path via glob; line ~56 locks old behavior)

**Interfaces:**
- Produces: `FleetSummary.totalConsumption/totalCapacity/utilization/worstCluster` now describe `fleetMonths[0]` (the current month — `resolveWindow` starts windows at this month).

- [ ] **Step 1:** Update the test that pins last-month behavior to expect FIRST-month totals; add a regression comment. Also update any `worstCluster` expectations to first-month. Run: FAIL.
- [ ] **Step 2:** In `aggregate-fleet.ts` replace `const latest = fleetMonths[fleetMonths.length - 1];` with:

```ts
  // Headline KPIs describe the PRESENT: window rows start at the current
  // month (resolveWindow anchors windows at "now"), so row 0 is today.
  const current = fleetMonths[0];
```

and use `current` in the block below. In the `worstCluster` loop replace `series.months[series.months.length - 1]` with `series.months[0]`.

- [ ] **Step 3:** `PNPM --filter @lcm/web test` — PASS. Sanity-check `apps/web/src/routes/index.tsx:128-134`: label "Fleet utilization / memory used" now truthfully reports current usage; no copy change needed.
- [ ] **Step 4:** Commit: `fix(web): fleet KPIs report current month, not end of forecast window`

### Task D2: Complete mutation invalidations + onError feedback

**Files:**
- Modify: `apps/web/src/components/clusters/host-dialogs.tsx:52-62`
- Modify: `apps/web/src/components/clusters/item-dialogs.tsx:44-53`
- Modify: `apps/web/src/components/clusters/threshold-overrides-form.tsx:42-59`
- Modify: `apps/web/src/components/settings/forecast-thresholds-form.tsx:38-52`
- Modify: `apps/web/src/components/clusters/cluster-identity-form.tsx:29-36`
- Modify: `apps/web/src/components/clusters/baseline-edit-form.tsx:69-78`

**Interfaces:** none (behavioral)

- [ ] **Step 1:** `useHostMutations.invalidate` (host-dialogs.tsx) becomes:

```ts
    invalidate: () => {
      void queryClient.invalidateQueries({ queryKey: ['hosts', clusterId] });
      void queryClient.invalidateQueries({ queryKey: ['forecast', clusterId] });
      void queryClient.invalidateQueries({ queryKey: ['cluster', clusterId] });
      void queryClient.invalidateQueries({ queryKey: ['clusters'] });
    },
```

- [ ] **Step 2:** `useItemMutations.invalidate` (item-dialogs.tsx): add the same two lines (`['cluster', clusterId]`, `['clusters']`) after the existing three.
- [ ] **Step 3:** `threshold-overrides-form.tsx` — both mutations' `onSuccess` gain `void queryClient.invalidateQueries({ queryKey: ['forecast', clusterId] });` and both mutations gain (import `toast` from `'sonner'`):

```ts
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not save thresholds'),
```

(import `ApiError` from `@/lib/api-client`; reset variant message: `'Could not reset thresholds'`).

- [ ] **Step 4:** `forecast-thresholds-form.tsx` `onSuccess` — after `setQueryData` add:

```ts
      void queryClient.invalidateQueries({ queryKey: ['forecast'] });
      void queryClient.invalidateQueries({ queryKey: ['cluster-settings'] });
```

plus the same `onError` toast (`'Could not save settings'`).

- [ ] **Step 5:** `cluster-identity-form.tsx` `onSuccess` — add `void queryClient.invalidateQueries({ queryKey: ['clusters'] });` plus `onError` toast (`'Could not save cluster'`). `baseline-edit-form.tsx` `onSuccess` — add `void queryClient.invalidateQueries({ queryKey: ['clusters'] });` plus `onError` toast (`'Could not save baseline'`); on error also leave `confirmOpen` as-is but the toast now surfaces the failure.
- [ ] **Step 6:** `PNPM --filter @lcm/web test && PNPM --filter @lcm/web typecheck && PNPM lint`
- [ ] **Step 7:** Commit: `fix(web): invalidate all affected queries after mutations; surface save errors`

### Task D3: Client form bounds match server schemas

**Files:**
- Modify: `apps/web/src/components/settings/forecast-thresholds-form.tsx:63-81`
- Modify: `apps/web/src/components/clusters/threshold-overrides-form.tsx:72-83`
- Modify: `apps/web/src/components/settings/categories-form.tsx` (Input ~line 117)
- Modify: `apps/web/src/components/clusters/host-dialogs.tsx` (create ~163-171, edit error mapping, asset inputs)
- Modify: `apps/web/src/components/clusters/baseline-edit-form.tsx:99-110`

**Interfaces:** none

- [ ] **Step 1:** `forecast-thresholds-form.tsx` `handleSubmit` — after the warn<crit check add:

```ts
    if (warnPct < 1 || warnPct > 99 || critPct < 1 || critPct > 99) {
      setValidationError('Thresholds must be between 1% and 99%.');
      return;
    }
```

- [ ] **Step 2:** `threshold-overrides-form.tsx` `handleSubmit` — same guard applied to whichever of warn/crit is a number:

```ts
    for (const pct of [warnPct, critPct]) {
      if (typeof pct === 'number' && (pct < 1 || pct > 99)) {
        setValidationError('Thresholds must be between 1% and 99%.');
        return;
      }
    }
```

- [ ] **Step 3:** `categories-form.tsx` new-category `Input`: add `maxLength={60}` (server cap is `.max(60)`).
- [ ] **Step 4:** `host-dialogs.tsx` — add `maxLength={120}` to the serialNumber/vendor/model Inputs and `maxLength={2000}` to description (both dialogs — grep the JSX). In `CreateHostDialog`'s safeParse-failure branch, after building `fieldErrors`, add a fallback so no failure is ever silent:

```ts
      if (Object.keys(fieldErrors).length === 0) {
        toast.error(parsed.error.issues[0]?.message ?? 'Invalid input');
      }
```

Apply the same fallback in `EditHostDialog`'s mapping (~line 381).

- [ ] **Step 5:** `baseline-edit-form.tsx` — invalid numeric edits currently fall back to server values silently in `handleConfirm`. Add a guard before mutate:

```ts
    const invalidMetric = metrics.find((m) => {
      const edit = metricEdits[m.metricTypeKey];
      return (
        (edit?.consumption !== null && edit?.consumption !== undefined && parseNumber(edit.consumption) === null) ||
        (edit?.capacity !== null && edit?.capacity !== undefined && parseNumber(edit.capacity) === null)
      );
    });
    if (invalidMetric) {
      toast.error(`Invalid number for ${invalidMetric.metricTypeKey}`);
      setConfirmOpen(false);
      return;
    }
```

(import `toast` from `'sonner'`.)

- [ ] **Step 6:** `PNPM --filter @lcm/web test && PNPM --filter @lcm/web typecheck && PNPM lint`
- [ ] **Step 7:** Commit: `fix(web): client validation mirrors server bounds; no silent dead submits`

### Task D4a: Response schemas in @lcm/shared

**Files:**
- Create: `packages/shared/src/schemas/responses.ts`
- Modify: shared index barrel
- Test: `packages/shared/src/schemas/__tests__/responses.test.ts`

**Interfaces:**
- Produces (consumed by D4b): Zod schemas typed against the EXISTING interfaces (which stay the source of truth — zero drift risk, server untouched): `clusterResponseSchema: z.ZodType<ClusterResponse>`, `hostResponseSchema: z.ZodType<HostResponse>`, `itemResponseSchema: z.ZodType<ItemResponse>`, `forecastResponseSchema: z.ZodType<ForecastResponse>`, `categoryResponseSchema`, `hostLifecycleEventResponseSchema`, `hostReplacementResponseSchema`, plus `paginatedSchema<T>(item)` helper. `tenantSettingsSchema` / `clusterSettingsResponseSchema` already exist — re-use, do not duplicate.

- [ ] **Step 1:** Read the remaining response interfaces you haven't seen (`ForecastResponse` in `forecast.ts`, `CategoryResponse`, `HostLifecycleEventResponse`, `HostReplacementResponse`, `HostState` — grep the shared package). Then create `responses.ts`. Pattern (complete example for the two cluster shapes; replicate field-for-field for the rest — the `z.ZodType<T>` annotation makes tsc reject any missing/mistyped field, so parity is compiler-enforced):

```ts
import { z } from 'zod';

import type { ClusterResponse, MetricStateResponse } from './cluster.js';
import type { Paginated } from './pagination.js';

export const metricStateResponseSchema: z.ZodType<MetricStateResponse> = z.object({
  metricTypeKey: z.string(),
  metricTypeDisplayName: z.string(),
  unit: z.string(),
  baselineConsumption: z.number(),
  baselineCapacity: z.number(),
  currentConsumption: z.number(),
  currentCapacity: z.number(),
  utilization: z.number(),
});

export const clusterResponseSchema: z.ZodType<ClusterResponse> = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  baselineDate: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  metrics: z.array(metricStateResponseSchema),
});

export function paginatedSchema<T>(item: z.ZodType<T>): z.ZodType<Paginated<T>> {
  return z.object({
    items: z.array(item),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  });
}
```

Continue for `HostResponse` (+`CapacityResponseRow`, `state: hostStateSchema` — use the existing HostState zod enum if one exists, else `z.custom<HostState>()` is FORBIDDEN — write a real `z.enum([...])` from the HostState union), `ItemResponse` (+allocation row, `kind: itemKindSchema` reusing the existing enum), `ForecastResponse` (mirror every nested field you read in Step 1), `CategoryResponse`, `HostLifecycleEventResponse`, `HostReplacementResponse`. Export all from the barrel.

- [ ] **Step 2:** Test file: for each schema, one `parse()` round-trip of a representative literal (write the literal from the interface) asserting success, and one failure case (e.g. `utilization: 'high'` rejected). Keep it to the four big schemas (cluster, host, item, forecast).
- [ ] **Step 3:** `PNPM --filter @lcm/shared test && PNPM --filter @lcm/shared typecheck`
- [ ] **Step 4:** Commit: `feat(shared): zod response schemas mirroring API response types`

### Task D4b: api-client validates responses + pagination envelope

**Files:**
- Modify: `apps/web/src/lib/api-client.ts` (request(), api.clusters.list, api.hosts.listByCluster, api.items.listByCluster, every request<> call gains a schema)
- Modify: every caller of the three list functions (grep `api.clusters.list`, `api.hosts.listByCluster`, `api.items.listByCluster` under `apps/web/src`) to consume `.items`
- Modify: `apps/web/src/components/clusters/cluster-table.tsx` (rename local `ClusterForecastEntry` → `ClusterTableEntry`; add truncation note row)
- Test: existing web tests; extend api-client test if one exists

**Interfaces:**
- Consumes: D4a schemas, C8 envelope.
- Produces: `request<T>(path, init?, schema?: z.ZodType<T>)` — parses when schema given, throws `ApiError(500-style local code 'RESPONSE_VALIDATION', ...)` on mismatch.

- [ ] **Step 1:** `request()` signature and tail:

```ts
async function request<T>(
  path: string,
  init?: RequestInit,
  schema?: z.ZodType<T>,
): Promise<T> {
```

and replace the final `return body as T;` with:

```ts
  if (schema === undefined) {
    return body as T;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(response.status, {
      error: {
        code: 'RESPONSE_VALIDATION',
        message: 'Server response did not match the expected shape',
        details: z.flattenError(parsed.error),
      },
    });
  }
  return parsed.data;
```

(import `z` from `'zod'` and the D4a schemas from `@lcm/shared`.)

- [ ] **Step 2:** Attach schemas to every endpoint in the `api` object: e.g. `get: (id) => request(`/api/clusters/${id}`, undefined, clusterResponseSchema)`, `list` uses `paginatedSchema(clusterResponseSchema)`, forecast endpoints use `forecastResponseSchema`, settings use the existing `clusterSettingsResponseSchema`/`tenantSettingsSchema`, `void` endpoints (delete/transition, 204) pass no schema. The generic parameter is now inferred from the schema — drop the explicit `request<X>` type arguments where a schema is supplied.
- [ ] **Step 3:** Pagination plumbing — `api.clusters.list` gains optional `limit`/`offset` params building a `URLSearchParams`; same for the two `listByCluster` fns. Then update callers: grep shows call sites in `routes/index.tsx`, the clusters route, host/item panels, `command-palette.tsx`. Each `useQuery` whose `queryFn` returned an array now returns `Paginated<...>`; the least-churn fix is `select: (page) => page.items` on those `useQuery` options — EXCEPT `cluster-table.tsx`, which should receive both `items` and `total` so it can render, after the table body when `total > items.length`:

```tsx
        <p className="mt-2 text-xs text-fg-subtle" role="status">
          Showing first {clusters.length} of {total} clusters.
        </p>
```

(adapt naming to the component's actual props; thread `total` from the route that owns the query.)

- [ ] **Step 4:** `cluster-table.tsx:23` — rename the local minimal `ClusterForecastEntry` interface to `ClusterTableEntry` (it shadows the richer `lib/forecast-summary.ts:74` type); update its references in the file.
- [ ] **Step 5:** `PNPM --filter @lcm/web test && PNPM --filter @lcm/web typecheck && PNPM lint && PNPM build`
- [ ] **Step 6:** Full-stack smoke: `PNPM db:dev:up`, `PNPM --filter @lcm/server exec prisma migrate deploy`, `PNPM seed`, then `PNPM dev` in background; curl `http://localhost:8090/api/clusters` → expect `{"items":[...],"total":4,...}`; open `http://localhost:5173` via `curl -sI` → 200. Kill dev processes, `PNPM db:dev:down`.
- [ ] **Step 7:** Commit: `feat(web): validate API responses with shared schemas; adopt paginated list envelope`

---

## Phase E — Infrastructure (independent of B–D)

### Task E1: Compose fail-closed password + container hardening

**Files:**
- Modify: `docker/docker-compose.yml`, `.dockerignore:28`

**Interfaces:** none

- [ ] **Step 1:** `docker-compose.yml` — replace both password fallbacks:
  - line 25: `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set in .env}`
  - line 46 DATABASE_URL: same `${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set in .env}` interpolation (USER/DB keep their `:-lcm` defaults).
- [ ] **Step 2:** Add to ALL THREE services:

```yaml
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
```

Add resource limits — `db`: `mem_limit: 1g`, `cpus: 2`, `pids_limit: 256`; `server`: `mem_limit: 512m`, `cpus: 1`, `pids_limit: 256`; `web`: `mem_limit: 256m`, `cpus: 1`, `pids_limit: 128`. Add to `server` only (distroless Node writes nothing except tmp):

```yaml
    read_only: true
    tmpfs:
      - /tmp
```

Do NOT set `read_only` on `db` (data dir) or `web` (nginx cache paths unverified on DHI image — leave a one-line comment noting that).

- [ ] **Step 3:** `.dockerignore:28`: change `apps/api/.env` → `apps/server/.env` (line 29 `apps/web/.env` stays).
- [ ] **Step 4:** Validate: `POSTGRES_PASSWORD=x docker compose -f docker/docker-compose.yml config >/dev/null` (syntax OK) and `docker compose -f docker/docker-compose.yml config 2>&1 | head -3` WITHOUT the var — expect the `must be set` error.
- [ ] **Step 5:** Commit: `fix(docker): fail closed on missing POSTGRES_PASSWORD; harden containers`

### Task E2: nginx security headers + externalized theme script

**Files:**
- Modify: `docker/nginx.conf`
- Modify: `apps/web/index.html` (inline anti-FOUC script at lines ~8-17)
- Create: `apps/web/public/theme-init.js`

**Interfaces:** none

- [ ] **Step 1:** Move the inline theme script: cut the JS body from `apps/web/index.html`'s inline `<script>` into `apps/web/public/theme-init.js` verbatim and replace the inline tag with `<script src="/theme-init.js"></script>` (keeps it a blocking pre-paint script; required because the new CSP forbids inline scripts).
- [ ] **Step 2:** `PNPM --filter @lcm/web build` then serve-check: `PNPM --filter @lcm/web preview &` → `curl -s http://localhost:4173/theme-init.js | head -1` returns the script; kill preview. Also run the web e2e golden path if the dev stack is still up from D4b (optional).
- [ ] **Step 3:** Rewrite `docker/nginx.conf`:

```nginx
server {
    # DHI's distroless nginx (`dhi.io/nginx:1`) runs as uid 65532 nonroot
    # and can't bind privileged ports. Compose maps host `${HTTP_PORT:-80}`
    # to container :8080.
    listen 8080;
    server_name _;

    server_tokens off;
    client_max_body_size 1m;  # matches the Fastify bodyLimit

    root /usr/share/nginx/html;
    index index.html;

    # Security headers. NOTE: nginx `add_header` inheritance resets whenever a
    # location adds its own header, so every location that uses add_header
    # repeats this include-style block. `always` keeps them on error responses.
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;

    # Send long-cache headers for the hashed bundles, no-store for index.html.
    location ~* \.(?:js|css|woff2?|svg|png|jpg|jpeg|gif|ico)$ {
        try_files $uri =404;
        expires 1y;
        access_log off;
        add_header Cache-Control "public, max-age=31536000, immutable";
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options "DENY" always;
        add_header Referrer-Policy "no-referrer" always;
        add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;
    }

    # Reverse proxy the JSON API + health probes to the server container.
    location ~ ^/(api|healthz|readyz)(/|$) {
        proxy_pass http://server:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
        proxy_connect_timeout 5s;
        proxy_send_timeout 30s;
    }

    # SPA fallback: any other path returns index.html so TanStack Router can
    # take over client-side routing.
    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-store";
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options "DENY" always;
        add_header Referrer-Policy "no-referrer" always;
        add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;
    }

    # Gzip text responses so the bundle doesn't dominate the wire.
    gzip on;
    gzip_types
        text/plain
        text/css
        application/javascript
        application/json
        application/xml
        image/svg+xml;
    gzip_vary on;
    gzip_min_length 1024;
}
```

(`style-src 'unsafe-inline'` is required — Recharts/motion set inline style attributes. The fonts are self-hosted via @fontsource, so `font-src 'self'` suffices.)

- [ ] **Step 4:** Syntax check without the DHI image (may need auth): `docker run --rm -v "$PWD/docker/nginx.conf:/etc/nginx/conf.d/default.conf:ro" nginx:alpine nginx -t` — expect `syntax is ok`.
- [ ] **Step 5:** Commit: `feat(web,docker): CSP + security headers; externalize theme-init for strict script-src`

### Task E3: CI/CD hardening

**Files:**
- Modify: `.github/workflows/ci.yml`, `.github/workflows/publish-images.yml`
- Create: `.github/dependabot.yml`

**Interfaces:** none

- [ ] **Step 1:** Resolve the commit SHA for each action tag (network + gh available):

```bash
for a in actions/checkout@v4 actions/setup-node@v4 docker/setup-qemu-action@v3 docker/setup-buildx-action@v3 docker/login-action@v3 docker/metadata-action@v5 docker/build-push-action@v6; do
  repo=${a%@*}; tag=${a#*@};
  echo "$a $(gh api repos/$repo/commits/$tag --jq .sha)";
done
```

- [ ] **Step 2:** `ci.yml`: add at top level (after `on:` block):

```yaml
permissions:
  contents: read
```

and pin both actions: `uses: actions/checkout@<sha> # v4`, `uses: actions/setup-node@<sha> # v4`.

- [ ] **Step 3:** `publish-images.yml`: pin all six actions to their SHAs (keep `# vN` comments). Extend permissions and enable supply-chain attestations:

```yaml
permissions:
  contents: read
  packages: write
  id-token: write
  attestations: write
```

and in the Build-and-push step `with:` add:

```yaml
          provenance: true
          sbom: true
```

- [ ] **Step 4:** Create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
```

- [ ] **Step 5:** Validate YAML syntax: `npx -y yaml-lint .github/workflows/ci.yml .github/workflows/publish-images.yml .github/dependabot.yml` — expect all valid.
- [ ] **Step 6:** Commit: `ci: least-privilege permissions, SHA-pinned actions, provenance/SBOM, dependabot`

### Task E4: Documentation drift

**Files:**
- Modify: `docs/operations.md:63` (volume name), `README.md` (env table PORT row + new env rows if not already added in C4)

**Interfaces:** none

- [ ] **Step 1:** `docs/operations.md:63`: `lcm-postgres-data` → `lcm-postgres-18-data`. Grep the file for other occurrences of the wrong name.
- [ ] **Step 2:** `README.md` env table: verify the C4 rows landed (CORS_ORIGIN / TRUST_PROXY / RATE_LIMIT_MAX); confirm the PORT row reads `8080 (prod), 8090 (dev)` and `.env.example` now says `PORT=8090` in the dev block (done in C4 — verify only). Also update the README "Environment variables" note that `xlsx` import guidance still matches reality.
- [ ] **Step 3:** Commit: `docs: fix volume name and env drift`

---

## Phase F — Final verification

### Task F1: Full gate

- [ ] **Step 1:** `PNPM lint && PNPM typecheck && PNPM test && PNPM build` — all green.
- [ ] **Step 2:** `PNPM audit` — expect ZERO high/critical; paste summary into the final report.
- [ ] **Step 3:** `git log --oneline main..HEAD` — review commit list; every task above should map to one commit.
- [ ] **Step 4:** Report: summary of everything fixed, anything skipped/deferred with reasons, remaining known issues (e.g. base-image digest pinning deferred — requires DHI registry access to resolve digests safely).

## Explicitly deferred (do NOT implement)

- Prisma 7 migration (major rewrite; separate effort)
- DHI base-image digest pinning in Dockerfiles (needs authenticated `docker manifest inspect` against dhi.io to obtain real digests; wrong guesses break builds — leave tags, note in F1 report)
- `read_only` filesystem for `db`/`web` containers (unverifiable locally)
- Cosign signature verification on the deploy host (operational doc change, not repo code)
