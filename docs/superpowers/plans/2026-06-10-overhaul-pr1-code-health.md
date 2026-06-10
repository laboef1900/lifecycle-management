# Overhaul PR 1 — Code Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land Phase 0 of the app overhaul (spec: `docs/superpowers/specs/2026-06-10-app-overhaul-design.md`): verified fixes, shared date/error utilities, regression tests for forecast semantics, and the Recharts 3 bump.

**Architecture:** Pure refactors + targeted fixes in the existing pnpm monorepo (`apps/server` Fastify+Prisma, `apps/web` React 19+Vite, `packages/shared` Zod). New shared modules `packages/shared/src/dates.ts` and `packages/shared/src/errors.ts`; everything else modifies files in place. No DB migrations in this PR.

**Tech Stack:** TypeScript, vitest (+testcontainers for server integration tests), Prisma 6, Recharts 3 (bumped here), TanStack Query.

**Branch:** `feat/overhaul-1-code-health` off `main`. (The spec + this plan live on `feat/app-overhaul` — open that as a separate docs PR.)

**Audit verification status (context for the engineer):** The original audit flagged several items that direct code reading REFUTED — do not "fix" these: forecast event accumulation (months reset from baseline each iteration, `forecast.ts:117-118`), `baselines[0]` metric mismatch (include-filtered at `forecast-loader.ts:77`), event metric leak (post-filtered at `forecast-loader.ts:138`). Tasks 6–7 add tests that lock those correct behaviors in.

**Verification before completion (every task):** run the listed test command and paste actual output before checking the box. Final gate is Task 10.

---

### Task 1: Shared date utilities in `@lcm/shared`

**Files:**

- Create: `packages/shared/src/dates.ts`
- Create: `packages/shared/src/__tests__/dates.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/__tests__/dates.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { addUtcMonths, formatDateIso, formatMonthLong, formatMonthShort } from '../dates.js';

describe('formatDateIso', () => {
  it('formats a UTC date as YYYY-MM-DD', () => {
    expect(formatDateIso(new Date('2026-06-10T15:30:00Z'))).toBe('2026-06-10');
  });
});

describe('formatMonthShort / formatMonthLong', () => {
  it('formats an ISO month string', () => {
    expect(formatMonthShort('2026-06-01')).toBe('Jun 26');
    expect(formatMonthLong('2026-06-01')).toBe('June 2026');
  });
});

describe('addUtcMonths', () => {
  it('adds months within a year', () => {
    expect(addUtcMonths(new Date('2026-09-01T00:00:00Z'), 2).toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
  });

  it('rolls over year boundaries', () => {
    expect(addUtcMonths(new Date('2026-11-15T00:00:00Z'), 3).toISOString()).toBe(
      '2027-02-15T00:00:00.000Z',
    );
  });

  it('clamps to the last day of shorter months', () => {
    expect(addUtcMonths(new Date('2026-08-31T00:00:00Z'), 1).toISOString()).toBe(
      '2026-09-30T00:00:00.000Z',
    );
    expect(addUtcMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });

  it('handles leap years', () => {
    expect(addUtcMonths(new Date('2028-01-31T00:00:00Z'), 1).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  it('preserves time-of-day', () => {
    expect(addUtcMonths(new Date('2026-03-10T12:34:56.789Z'), 1).toISOString()).toBe(
      '2026-04-10T12:34:56.789Z',
    );
  });

  it('supports negative offsets', () => {
    expect(addUtcMonths(new Date('2026-03-31T00:00:00Z'), -1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lcm/shared test -- --run src/__tests__/dates.test.ts`
Expected: FAIL — `Cannot find module '../dates.js'`

- [ ] **Step 3: Implement `packages/shared/src/dates.ts`**

```ts
/** Format a Date as its UTC calendar date, `YYYY-MM-DD`. */
export function formatDateIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const SHORT_FMT: Intl.DateTimeFormatOptions = { month: 'short', year: '2-digit', timeZone: 'UTC' };
const LONG_FMT: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric', timeZone: 'UTC' };

/** `'2026-06-01'` → `'Jun 26'` */
export function formatMonthShort(month: string): string {
  return new Date(`${month}T00:00:00Z`).toLocaleDateString('en-US', SHORT_FMT);
}

/** `'2026-06-01'` → `'June 2026'` */
export function formatMonthLong(month: string): string {
  return new Date(`${month}T00:00:00Z`).toLocaleDateString('en-US', LONG_FMT);
}

/**
 * Add calendar months in UTC, clamping the day-of-month to the target month's
 * length (Jan 31 + 1mo = Feb 28/29). Time-of-day is preserved.
 */
export function addUtcMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const daysInMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, daysInMonth));
  return result;
}
```

Append to `packages/shared/src/index.ts`:

```ts
export * from './dates.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @lcm/shared test -- --run src/__tests__/dates.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/dates.ts packages/shared/src/__tests__/dates.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): date utilities (formatDateIso, month formatters, addUtcMonths)"
```

---

### Task 2: Server + web consume the shared date utilities

The three duplicated implementations become thin re-exports — zero caller churn, one implementation.

**Files:**

- Modify: `apps/server/src/lib/dates.ts` (entire file)
- Modify: `apps/web/src/lib/format-month.ts` (entire file)

- [ ] **Step 1: Replace `apps/server/src/lib/dates.ts` with a re-export**

```ts
export { formatDateIso as formatDate } from '@lcm/shared';
```

(Importers stay untouched: forecast.ts, items.ts, hosts.ts, clusters.ts, procurement.ts, host-lifecycle.ts, host-replacements.ts.)

- [ ] **Step 2: Replace `apps/web/src/lib/format-month.ts` with a re-export**

```ts
export { formatMonthLong, formatMonthShort } from '@lcm/shared';
```

(`apps/web/src/lib/format.ts` keeps `formatGb`/`formatNumber`/`todayIso` — they're web-only, not duplicates.)

- [ ] **Step 3: Run the affected test suites**

Run: `pnpm --filter @lcm/shared test -- --run && pnpm --filter @lcm/web test -- --run src/lib/format-month.test.ts && pnpm --filter @lcm/server typecheck`
(If `@lcm/server` has no `typecheck` script, use `pnpm --filter @lcm/server exec tsc --noEmit`.)
Expected: PASS — the existing `format-month.test.ts` now exercises the shared implementation.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/lib/dates.ts apps/web/src/lib/format-month.ts
git commit -m "refactor: date helpers re-export from @lcm/shared"
```

---

### Task 3: Scenario `delay_procurement` uses calendar months

Replaces the 30-day approximation (`scenario.ts:72-97`) with `addUtcMonths`. The existing tests assert the old behavior — flip them first.

**Files:**

- Modify: `apps/server/src/services/__tests__/scenario.test.ts:101-137`
- Modify: `apps/server/src/services/scenario.ts:72-97`

- [ ] **Step 1: Update the delay tests to expect calendar months**

In `scenario.test.ts`, replace the `describe('applyScenario — delay_procurement', ...)` block's first two tests and add two new ones (keep the `leaves already-deployed hosts untouched` and `no-op` tests as-is):

```ts
describe('applyScenario — delay_procurement', () => {
  it('shifts future commissionedAt by N calendar months', () => {
    const future = makeHost('upcoming', 500, {
      commissionedAt: new Date('2026-09-01T00:00:00Z'),
    });
    const r = applyScenario(makeInput([future]), { kind: 'delay_procurement', months: 2 });
    expect(r.hosts[0]!.commissionedAt.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('shifts projectedDecommissionAt on the same hosts by the same months', () => {
    const future = makeHost('upcoming', 500, {
      commissionedAt: new Date('2026-09-01T00:00:00Z'),
      projDecom: new Date('2030-09-01T00:00:00Z'),
    });
    const r = applyScenario(makeInput([future]), { kind: 'delay_procurement', months: 3 });
    expect(r.hosts[0]!.projectedDecommissionAt!.toISOString()).toBe('2030-12-01T00:00:00.000Z');
  });

  it('clamps month-end dates instead of drifting into the next month', () => {
    const future = makeHost('upcoming', 500, {
      commissionedAt: new Date('2026-08-31T00:00:00Z'),
    });
    const r = applyScenario(makeInput([future]), { kind: 'delay_procurement', months: 1 });
    expect(r.hosts[0]!.commissionedAt.toISOString()).toBe('2026-09-30T00:00:00.000Z');
  });

  it('does not shift events (point-in-time deltas are independent of procurement)', () => {
    const input = makeInput([
      makeHost('upcoming', 500, { commissionedAt: new Date('2026-09-01T00:00:00Z') }),
    ]);
    input.events = [
      {
        id: 'e1',
        effectiveDate: new Date('2026-10-01T00:00:00Z'),
        category: 'growth',
        title: 'g',
        description: null,
        consumptionDelta: 100,
        capacityDelta: null,
      },
    ];
    const r = applyScenario(input, { kind: 'delay_procurement', months: 6 });
    expect(r.events).toEqual(input.events);
  });
  // ... keep the existing 'leaves already-deployed hosts untouched' and
  // 'is a no-op when there are no future commissions to delay' tests unchanged
});
```

Note: the no-op test uses `expect(r).toEqual(makeInput([past]))` — `makeInput` sets `events: []`, still fine.

- [ ] **Step 2: Run tests to verify the two changed assertions fail**

Run: `pnpm --filter @lcm/server test -- --run src/services/__tests__/scenario.test.ts`
Expected: FAIL — `2026-10-31T00:00:00.000Z` (60 days) instead of `2026-11-01...` etc. The new clamp test also fails. The events test passes already (current code never touches events) — that's fine, it's a regression lock.

- [ ] **Step 3: Implement with `addUtcMonths`**

In `apps/server/src/services/scenario.ts`: add to the existing `@lcm/shared` import at the top (line 1):

```ts
import { addUtcMonths, type Scenario } from '@lcm/shared';
```

Delete the `DAY_MS` and `AVG_DAYS_PER_MONTH` constants (lines 72-73) and replace `delayFutureCommissions`:

```ts
/**
 * Shift every future commissionedAt and projectedDecommissionAt by N calendar
 * months (UTC, month-end clamped). Past commissions are untouched: those hosts
 * are already deployed. v1 is uniform across all hosts — per-host targeting is
 * deferred. Events are intentionally NOT shifted: they model demand/capacity
 * changes that happen regardless of procurement timing.
 */
function delayFutureCommissions(input: ForecastInput, months: number): ForecastInput {
  if (months <= 0) return input;
  const now = new Date();
  return {
    ...input,
    hosts: input.hosts.map((host) => {
      if (host.commissionedAt <= now) return host;
      return {
        ...host,
        commissionedAt: addUtcMonths(host.commissionedAt, months),
        projectedDecommissionAt: host.projectedDecommissionAt
          ? addUtcMonths(host.projectedDecommissionAt, months)
          : host.projectedDecommissionAt,
      };
    }),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @lcm/server test -- --run src/services/__tests__/scenario.test.ts`
Expected: PASS (all scenario tests)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/scenario.ts apps/server/src/services/__tests__/scenario.test.ts
git commit -m "fix(server): delay_procurement shifts by calendar months, not 30-day blocks"
```

---

### Task 4: Central error-code registry + `instanceof` narrowing

**Files:**

- Create: `packages/shared/src/errors.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/server/src/services/errors.ts` (entire file)
- Modify: `apps/server/src/plugins/error-handler.ts:41` (insert before the generic fallback)
- Modify: `apps/server/src/__tests__/error-handler.test.ts` (append)

- [ ] **Step 1: Write the failing handler test**

Append to `apps/server/src/__tests__/error-handler.test.ts` (it already builds a Fastify instance with the plugin — follow the file's existing pattern for registering a throwing route; if it uses `buildServer`, register the route on a fresh `Fastify()` instance with the plugin instead):

```ts
import Fastify from 'fastify';

import errorHandler from '../plugins/error-handler.js';
import { ConflictError, NotFoundError } from '../services/errors.js';

describe('ServiceError narrowing', () => {
  it('maps ConflictError to its status and code via instanceof', async () => {
    const app = Fastify();
    await app.register(errorHandler);
    app.get('/boom', () => {
      throw new ConflictError('CLUSTER_NAME_TAKEN', 'name already in use');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: 'CLUSTER_NAME_TAKEN', message: 'name already in use' },
    });
    await app.close();
  });

  it('maps NotFoundError to 404 NOT_FOUND', async () => {
    const app = Fastify();
    await app.register(errorHandler);
    app.get('/missing', () => {
      throw new NotFoundError('Cluster', 'abc');
    });
    const res = await app.inject({ method: 'GET', url: '/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Cluster abc not found' } });
    await app.close();
  });
});
```

- [ ] **Step 2: Run to verify current behavior**

Run: `pnpm --filter @lcm/server test -- --run src/__tests__/error-handler.test.ts`
Expected: these two may PASS today via duck-typing (`error.statusCode`/`error.code` happen to exist). That's fine — the test pins the contract; the refactor below must keep it green. If they pass, continue (this is a characterization test, not strict TDD).

- [ ] **Step 3: Create `packages/shared/src/errors.ts`**

```ts
/**
 * Central registry of service-level error codes returned in API error bodies.
 * Handler-level codes (VALIDATION_ERROR, INTERNAL_ERROR, CLIENT_ERROR) are not
 * service errors and live in the server's error handler.
 */
export const SERVICE_ERROR_CODES = [
  'ALLOCATION_DUPLICATE_DATE',
  'CAPACITY_DUPLICATE_DATE',
  'CATEGORY_IN_USE',
  'CLUSTER_NAME_TAKEN',
  'CROSS_CLUSTER_REPLACEMENT',
  'EFFECTIVE_BEFORE_COMMISSION',
  'EFFECTIVE_BEFORE_START',
  'EFFECTIVE_NOT_MONOTONIC',
  'EFFECTIVE_THRESHOLDS_INVALID',
  'HOST_NOT_FOUND',
  'INVALID_COMMISSIONED_AT',
  'INVALID_EFFECTIVE_DATE',
  'INVALID_TRANSITION',
  'METRIC_NOT_TRACKED',
  'NOT_AN_APPLICATION',
  'NOT_FOUND',
  'REPLACEMENT_DUPLICATE',
  'UNKNOWN_METRIC',
  'WRONG_KIND_FIELD',
] as const;

export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];
```

Append to `packages/shared/src/index.ts`:

```ts
export * from './errors.js';
```

- [ ] **Step 4: Rewrite `apps/server/src/services/errors.ts` on a common base**

```ts
import type { ServiceErrorCode } from '@lcm/shared';

/** Base for all service-thrown HTTP errors; the error handler narrows on it. */
export abstract class ServiceError extends Error {
  abstract readonly statusCode: number;
  readonly code: ServiceErrorCode;

  protected constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export class NotFoundError extends ServiceError {
  readonly statusCode = 404;

  constructor(resource: string, id: string) {
    super('NOT_FOUND', `${resource} ${id} not found`);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends ServiceError {
  readonly statusCode = 409;

  constructor(code: ServiceErrorCode, message: string) {
    super(code, message);
    this.name = 'ConflictError';
  }
}

export class UnprocessableError extends ServiceError {
  readonly statusCode = 422;

  constructor(code: ServiceErrorCode, message: string) {
    super(code, message);
    this.name = 'UnprocessableError';
  }
}
```

If `tsc` now flags a service passing a code that's missing from the registry, add that code to `SERVICE_ERROR_CODES` — the registry must be the superset (the Step 3 list was produced by grepping all `new ConflictError(`/`new UnprocessableError(` call sites).

- [ ] **Step 5: Narrow in `apps/server/src/plugins/error-handler.ts`**

Add the import at the top:

```ts
import { ServiceError } from '../services/errors.js';
```

Insert between the `error.validation` block (ends line 39) and `const statusCode = error.statusCode ?? 500;` (line 41):

```ts
if (error instanceof ServiceError) {
  request.log.warn({ err: error }, 'Service error');
  const body: ApiErrorBody = {
    error: { code: error.code, message: error.message },
  };
  reply.status(error.statusCode).send(body);
  return;
}
```

- [ ] **Step 6: Run the full server suite**

Run: `pnpm --filter @lcm/server exec tsc --noEmit && pnpm --filter @lcm/server test -- --run`
Expected: typecheck clean (all existing call-site codes are in the registry); all tests PASS — route tests already assert these codes/statuses, so any regression surfaces here.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/errors.ts packages/shared/src/index.ts apps/server/src/services/errors.ts apps/server/src/plugins/error-handler.ts apps/server/src/__tests__/error-handler.test.ts
git commit -m "refactor(server): ServiceError base + shared error-code registry, instanceof narrowing"
```

---

### Task 5: Harden `collectForecastState` (error fallback + metric-less clusters)

**Files:**

- Modify: `apps/web/src/lib/collect-forecast-state.ts:39-64`
- Modify: `apps/web/src/lib/collect-forecast-state.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/lib/collect-forecast-state.test.ts` (reuse the file's existing cluster/query helpers if present; otherwise this stub is self-contained):

```ts
import type { ClusterResponse } from '@lcm/shared';

function stubCluster(id: string, metricCount = 1): ClusterResponse {
  return {
    id,
    name: id,
    metrics: Array.from({ length: metricCount }, (_, i) => ({
      metricTypeKey: `metric_${i}`,
    })),
  } as unknown as ClusterResponse;
}

describe('collectForecastState hardening', () => {
  it('records a fallback message when a query errors without an Error instance', () => {
    const state = collectForecastState(
      [stubCluster('c1')],
      [{ data: undefined, isPending: false, isError: true, isSuccess: false, error: null }],
    );
    expect(state.errorsById['c1']).toBe('Failed to load forecast');
  });

  it('flags clusters with no configured metric instead of loading forever', () => {
    const state = collectForecastState(
      [stubCluster('c1', 0)],
      [
        // a disabled useQuery reports isPending: true with no data
        { data: undefined, isPending: true, isError: false, isSuccess: false, error: null },
      ],
    );
    expect(state.errorsById['c1']).toBe('No metric configured');
    expect(state.forecastsLoading).toBe(false);
    expect(state.responsiveCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lcm/web test -- --run src/lib/collect-forecast-state.test.ts`
Expected: FAIL — first: `errorsById['c1']` is `undefined` (null error short-circuits); second: `errorsById['c1']` undefined and `forecastsLoading` true.

- [ ] **Step 3: Implement**

In `collect-forecast-state.ts`, inside the `for` loop (lines 39-64), insert a metric guard right after `const q = queries[i];` and simplify the error branch:

```ts
for (let i = 0; i < clusters.length; i++) {
  const cluster = clusters[i]!;
  const q = queries[i];

  if (cluster.metrics.length === 0) {
    forecastEntries.push({ clusterId: cluster.id, data: undefined });
    errorsById[cluster.id] = 'No metric configured';
    continue;
  }

  const data = q?.data;
  forecastEntries.push({ clusterId: cluster.id, data });

  if (data) {
    // ... unchanged block ...
  }

  if (q?.isError) {
    errorsById[cluster.id] = q.error instanceof Error ? q.error.message : 'Failed to load forecast';
  }

  if (q?.isPending) forecastsLoading = true;
  if (q?.isSuccess) responsiveCount++;
}
```

- [ ] **Step 4: Run tests to verify they pass (plus the overview suite)**

Run: `pnpm --filter @lcm/web test -- --run src/lib/collect-forecast-state.test.ts src/__tests__/aggregate-fleet.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/collect-forecast-state.ts apps/web/src/lib/collect-forecast-state.test.ts
git commit -m "fix(web): surface metric-less clusters and errors without messages in fleet state"
```

---

### Task 6: Regression test — event deltas apply once per month, persisting onward

Test-only task. The audit claimed events re-accumulate (refuted); this locks the correct semantics so the claim can never silently become true.

**Files:**

- Create: `apps/server/src/services/__tests__/forecast-events.test.ts`

- [ ] **Step 1: Write the test (expected to pass immediately)**

```ts
import { describe, expect, it } from 'vitest';

import { computeForecast, type ForecastInput } from '../forecast.js';

function makeInput(events: ForecastInput['events']): ForecastInput {
  return {
    baselineDate: new Date('2026-05-01T00:00:00Z'),
    baselineConsumption: 1000,
    baselineCapacity: 5000,
    hosts: [],
    applications: [],
    events,
  };
}

describe('computeForecast — event semantics', () => {
  it('applies a consumption delta from its effective month onward, exactly once per month', () => {
    const input = makeInput([
      {
        id: 'e1',
        effectiveDate: new Date('2026-07-01T00:00:00Z'),
        category: 'growth',
        title: 'onboarding',
        description: null,
        consumptionDelta: 500,
        capacityDelta: null,
      },
    ]);
    const r = computeForecast(
      input,
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
    );
    // May, Jun unaffected; Jul..Oct shifted by exactly +500 (no compounding)
    expect(r.months.map((m) => m.consumption)).toEqual([1000, 1000, 1500, 1500, 1500, 1500]);
  });

  it('stacks multiple events additively without re-applying earlier ones', () => {
    const input = makeInput([
      {
        id: 'e1',
        effectiveDate: new Date('2026-06-01T00:00:00Z'),
        category: 'growth',
        title: 'a',
        description: null,
        consumptionDelta: 200,
        capacityDelta: null,
      },
      {
        id: 'e2',
        effectiveDate: new Date('2026-08-01T00:00:00Z'),
        category: 'capacity',
        title: 'b',
        description: null,
        consumptionDelta: null,
        capacityDelta: 1000,
      },
    ]);
    const r = computeForecast(
      input,
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-09-01T00:00:00Z'),
    );
    expect(r.months.map((m) => m.consumption)).toEqual([1000, 1200, 1200, 1200, 1200]);
    expect(r.months.map((m) => m.capacity)).toEqual([5000, 5000, 5000, 6000, 6000]);
  });
});
```

- [ ] **Step 2: Run and confirm PASS**

Run: `pnpm --filter @lcm/server test -- --run src/services/__tests__/forecast-events.test.ts`
Expected: PASS. **If this fails, STOP — the audit finding was real after all; report to the user before changing `forecast.ts`.**

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/services/__tests__/forecast-events.test.ts
git commit -m "test(server): lock forecast event-delta semantics (once per month, persists onward)"
```

---

### Task 7: Regression test — multi-metric forecasts stay independent

Integration test (testcontainers). Locks the loader's metric filtering (`forecast-loader.ts:77,138`).

**Files:**

- Modify: `apps/server/src/__tests__/forecast-endpoint.test.ts` (append imports + one test)

- [ ] **Step 1: Confirm the baseline model name**

Run: `grep -n "model ClusterBaseline" apps/server/prisma/schema.prisma`
Expected: a match (the cluster factory creates `baselines` rows). If the model has a different name, adjust `prisma.clusterBaseline` below accordingly.

- [ ] **Step 2: Append the test**

Add `import { Prisma } from '@prisma/client';` to the imports of `forecast-endpoint.test.ts`, then append inside the existing `describe('GET /api/clusters/:id/forecast', ...)`:

```ts
it('keeps forecasts independent per metric on a multi-metric cluster', async () => {
  const cpu = await prisma.metricType.upsert({
    where: { key: 'cpu_cores' },
    update: {},
    create: { key: 'cpu_cores', displayName: 'CPU', unit: 'cores' },
  });
  await prisma.clusterBaseline.create({
    data: {
      tenantId: 'default',
      clusterId,
      metricTypeId: cpu.id,
      baselineConsumption: new Prisma.Decimal(100),
      baselineCapacity: new Prisma.Decimal(400),
    },
  });

  const mem = await server.inject({
    method: 'GET',
    url: `/api/clusters/${clusterId}/forecast?metric=memory_gb`,
  });
  const cpuRes = await server.inject({
    method: 'GET',
    url: `/api/clusters/${clusterId}/forecast?metric=cpu_cores`,
  });

  expect(mem.statusCode).toBe(200);
  expect(cpuRes.statusCode).toBe(200);
  const memMonths = (mem.json() as { months: Array<{ consumption: number; capacity: number }> })
    .months;
  const cpuMonths = (cpuRes.json() as { months: Array<{ consumption: number; capacity: number }> })
    .months;
  expect(memMonths[0]).toMatchObject({ consumption: 3378, capacity: 7680 });
  expect(cpuMonths[0]).toMatchObject({ consumption: 100, capacity: 400 });
});
```

- [ ] **Step 3: Run and confirm PASS**

Run: `pnpm --filter @lcm/server test -- --run src/__tests__/forecast-endpoint.test.ts`
Expected: PASS (needs Docker for testcontainers). **If the cpu series shows memory numbers, STOP — loader bug is real; report before fixing.**

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/__tests__/forecast-endpoint.test.ts
git commit -m "test(server): multi-metric forecast independence on one cluster"
```

---

### Task 8: Chart accessibility — `role="img"` + labels

**Files:**

- Modify: `apps/web/src/components/clusters/forecast-chart.tsx:81`
- Modify: `apps/web/src/components/overview/fleet-cluster-tile-chart.tsx:75`
- Modify: `apps/web/src/components/clusters/forecast-chart.test.tsx` (append assertion)
- Modify: `apps/web/src/components/overview/fleet-cluster-tile-chart.test.tsx` (append assertion)

- [ ] **Step 1: Add failing assertions**

In `forecast-chart.test.tsx`, add a new test (reuse the fixture/props the file's first render test uses):

```ts
it('exposes the chart as a labelled image', () => {
  // render with the same props as the existing render test
  expect(screen.getByRole('img', { name: 'Capacity forecast chart' })).toBeInTheDocument();
});
```

In `fleet-cluster-tile-chart.test.tsx` (entry fixtures already exist in the file; the accessible name must include the cluster name from that fixture):

```ts
it('exposes the tile chart as a labelled image', () => {
  // render with the file's existing entry fixture
  expect(screen.getByRole('img', { name: /utilization forecast/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @lcm/web test -- --run src/components/clusters/forecast-chart.test.tsx src/components/overview/fleet-cluster-tile-chart.test.tsx`
Expected: FAIL — no element with role `img`.

- [ ] **Step 3: Implement**

`forecast-chart.tsx:81` — the chart wrapper div becomes:

```tsx
      <div className="h-[320px] w-full" role="img" aria-label="Capacity forecast chart">
```

`fleet-cluster-tile-chart.tsx:75` — the component destructures `cluster` from `entry` (line 44); the chart wrapper div becomes:

```tsx
            <div
              className="min-w-0 flex-1"
              role="img"
              aria-label={`${cluster.name} utilization forecast`}
            >
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @lcm/web test -- --run src/components/clusters/forecast-chart.test.tsx src/components/overview/fleet-cluster-tile-chart.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/clusters/forecast-chart.tsx apps/web/src/components/overview/fleet-cluster-tile-chart.tsx apps/web/src/components/clusters/forecast-chart.test.tsx apps/web/src/components/overview/fleet-cluster-tile-chart.test.tsx
git commit -m "fix(web): expose forecast charts as labelled images for screen readers"
```

---

### Task 9: Recharts 2 → 3

No `Customized` / `TooltipProps` / internal-prop usage exists in the codebase (verified by grep), so this should be mechanical.

**Files:**

- Modify: `apps/web/package.json` (recharts version)

- [ ] **Step 1: Bump and install**

In `apps/web/package.json` change `"recharts": "^2.15.0"` → `"recharts": "^3.8.1"`, then:

Run: `pnpm install`
Expected: success. If pnpm warns about a `react-is` peer mismatch, add `"react-is": "^19.0.0"` to `apps/web/package.json` dependencies and re-run `pnpm install` (Recharts 3 requires a `react-is` matching React's major).

- [ ] **Step 2: Typecheck + full web tests + build**

Run: `pnpm --filter @lcm/web exec tsc --noEmit && pnpm --filter @lcm/web test -- --run && pnpm --filter @lcm/web build`
Expected: all green. Known v3 changes to watch if anything fails: tooltip content prop types renamed (`TooltipProps` → `TooltipContentProps`), z-order now follows JSX order, `accessibilityLayer` defaults to true (may ADD `role="application"` elements inside charts — if a test now finds duplicate roles, scope queries with `within()`).

- [ ] **Step 3: Visual smoke check**

Run: `pnpm dev`, open http://localhost:5173, check the overview tiles and one cluster's forecast chart render correctly in light + dark. Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml
git commit -m "chore(web): bump recharts to v3"
```

---

### Task 10: Final verification, staleness check, PR

**Files:** none (verification + PR)

- [ ] **Step 1: Scenario staleness check (audit item, MEDIUM confidence)**

With `pnpm dev` running and a seeded cluster open: apply a scenario (e.g. delay procurement 2 months), confirm the chart shows the dashed overlay; clear the scenario; confirm the baseline series and KPI strip return to pre-scenario values without a manual refresh. The query keys include the scenario object (`clusters.$id.tsx:50,61`), so staleness is NOT expected. Record the outcome in the PR description; if stale data IS observed, file it as a follow-up for PR 4 (cluster-detail overhaul) — do not fix it blind here.

- [ ] **Step 2: Full monorepo gate**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all green. Paste the summary lines into the PR description.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/overhaul-1-code-health
gh pr create --base main --title "Overhaul PR 1: code health (Phase 0)" --body "$(cat <<'EOF'
Phase 0 of the app overhaul (spec: docs/superpowers/specs/2026-06-10-app-overhaul-design.md).

- shared date utils (formatDateIso, month formatters, addUtcMonths) — server/web re-export
- fix: delay_procurement scenario shifts by calendar months (was 30-day blocks)
- ServiceError base + shared error-code registry; error handler narrows via instanceof
- fix: fleet state surfaces metric-less clusters and message-less query errors
- regression tests: forecast event-delta semantics, multi-metric independence
- a11y: forecast charts exposed as labelled images
- chore: recharts 3

Scenario-staleness audit item: <outcome from Step 1>.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes (already applied)

- Spec Phase 0 items 1-8 + the three new tests all map to Tasks 1-9; item 5 (staleness) is Task 10 Step 1 by design (verify, don't fix blind).
- Registry list in Task 4 was generated from grep of all ConflictError/UnprocessableError call sites + NOT_FOUND; Task 4 Step 4 includes the recovery path if one was missed.
- Type consistency: `addUtcMonths`, `formatDateIso`, `ServiceErrorCode`, `ServiceError` are defined in Tasks 1/4 before first use in Tasks 3/4; web re-exports keep existing import paths compiling.
