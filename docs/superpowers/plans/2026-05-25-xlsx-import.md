# xlsx capacity-forecast import — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-time CLI script that parses `docs/Capacity_Forecast_vSphere.xlsx` and replaces all events + hosts on the 4 reference clusters with the 32 events the spreadsheet records.

**Architecture:** Pure parser module (`scripts/lib/parse-capacity-xlsx.ts`) takes a file path, returns `ParsedCluster[]`. Thin CLI wrapper (`scripts/import-xlsx.ts`) opens a Prisma transaction, looks up each cluster by `(tenantId, name)`, wipes events + hosts, inserts the parsed events. `xlsx` is a devDependency only; the script is meant to run twice (dev DB then prod DB) and never again.

**Tech Stack:** Node 22 + pnpm 11 + tsx, Prisma 6 + Postgres 16, Vitest + xlsx (^0.18) for parsing.

**Spec:** `docs/superpowers/specs/2026-05-25-xlsx-import-design.md`. Branch: `feat/xlsx-import`.

---

## File map

**Add** (under `apps/api/`)

- `scripts/import-xlsx.ts` — CLI. ~60 LOC. Resolves the xlsx path, calls the parser, opens a Prisma transaction that wipes + inserts per cluster, prints a per-cluster summary, exits 0/1.
- `scripts/lib/parse-capacity-xlsx.ts` — pure parser. ~120 LOC. No Prisma, no fs side effects beyond reading the input file. Exports `parseCapacityXlsx(filePath)` + the helper `inferCategory(title)` (exported for testability).
- `scripts/lib/parse-capacity-xlsx.test.ts` — Vitest tests for the parser. Runs against the real xlsx + asserts the category-inference helper directly.

**Modify**

- `apps/api/package.json` — add `xlsx` (^0.18) to `devDependencies`. Add a `"db:import-xlsx": "tsx scripts/import-xlsx.ts"` script.
- `apps/api/tsconfig.json` — extend `include` to cover `scripts/**/*.ts` so typecheck + IDE see the new files.
- `apps/api/vitest.config.ts` — extend `include` glob to also cover `scripts/**/*.{test,spec}.ts`.

---

## Task 1 — Setup: dependency + config includes

**Files:**

- Modify: `apps/api/package.json`
- Modify: `apps/api/tsconfig.json`
- Modify: `apps/api/vitest.config.ts`
- Create: `apps/api/scripts/.gitkeep` (so the directory commits)

### Steps

- [ ] **Step 1: Confirm branch state**

```bash
git -C /home/simon/Documents/lifecycle-management status
git -C /home/simon/Documents/lifecycle-management rev-parse --abbrev-ref HEAD
```

Expected: branch is `feat/xlsx-import`, working tree clean.

- [ ] **Step 2: Add `xlsx` as a devDependency**

```bash
pnpm --filter @lcm/api add -D xlsx@^0.18
```

Expected: `apps/api/package.json` gains `"xlsx": "^0.18.x"` in `devDependencies` and the lockfile updates.

- [ ] **Step 3: Add the convenience script**

Edit `apps/api/package.json`. In the `"scripts"` block, add a `"db:import-xlsx"` entry alongside the existing `"seed"`:

```json
    "seed": "tsx prisma/seed.ts",
    "db:import-xlsx": "tsx scripts/import-xlsx.ts",
```

Order inside `"scripts"` doesn't matter functionally — put it right after `"seed"` for readability.

- [ ] **Step 4: Extend `apps/api/tsconfig.json` `include`**

Replace the `"include"` line:

```json
  "include": ["src/**/*", "prisma/**/*.ts", "scripts/**/*.ts"]
```

- [ ] **Step 5: Extend `apps/api/vitest.config.ts` `include` glob**

Find the `include: ['src/**/*.{test,spec}.ts']` line and replace it with:

```ts
    include: ['src/**/*.{test,spec}.ts', 'scripts/**/*.{test,spec}.ts'],
```

Leave the rest of the file unchanged.

- [ ] **Step 6: Create the scripts directory marker**

```bash
mkdir -p apps/api/scripts/lib
touch apps/api/scripts/.gitkeep
```

- [ ] **Step 7: Verify typecheck still clean**

```bash
pnpm --filter @lcm/api typecheck
```

Expected: no output (no errors).

- [ ] **Step 8: Commit**

```bash
git add apps/api/package.json apps/api/tsconfig.json apps/api/vitest.config.ts apps/api/scripts/.gitkeep pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
chore(api): Add xlsx devDep + config includes for scripts/

Adds xlsx ^0.18 (devDependency only — used by the upcoming one-time
xlsx import script), extends apps/api/tsconfig.json + vitest.config.ts
include globs to cover apps/api/scripts/, and creates the empty
scripts/ directory.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 — Parser: tests + implementation

**Files:**

- Create: `apps/api/scripts/lib/parse-capacity-xlsx.ts`
- Create: `apps/api/scripts/lib/parse-capacity-xlsx.test.ts`

### Steps

- [ ] **Step 1: Write the failing tests**

Create `apps/api/scripts/lib/parse-capacity-xlsx.test.ts`:

```ts
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { inferCategory, parseCapacityXlsx } from './parse-capacity-xlsx';

const REAL_XLSX = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'docs',
  'Capacity_Forecast_vSphere.xlsx',
);

describe('inferCategory', () => {
  it('maps Wachstum* to growth', () => {
    expect(inferCategory('Wachstum Q4')).toBe('growth');
    expect(inferCategory('wachstum 2027')).toBe('growth');
  });

  it('maps Ausbau* and Umbau* to hardware_change', () => {
    expect(inferCategory('Ausbau Memory HPE-Server')).toBe('hardware_change');
    expect(inferCategory('Ausbau 2x HPE Server')).toBe('hardware_change');
    expect(inferCategory('Umbau - ClientLab Hardware nach Prod-P2')).toBe('hardware_change');
  });

  it('maps any title containing OpenShift to openshift (case-insensitive)', () => {
    expect(inferCategory('OpenShift - Aufbau Labor Umgebung (DMZ)')).toBe('openshift');
    expect(inferCategory('START OpenShift')).toBe('openshift');
    expect(inferCategory('Ausbau - OpenShift Cluster Expansion')).toBe('hardware_change'); // Ausbau wins (earlier rule)
  });

  it('throws on an unmapped prefix, naming the offending title', () => {
    expect(() => inferCategory('Foobar Q1')).toThrow(/Foobar Q1/);
  });
});

describe('parseCapacityXlsx (real spreadsheet)', () => {
  it('returns the four reference clusters in spreadsheet order with seed-matching baselines', () => {
    const clusters = parseCapacityXlsx(REAL_XLSX);

    expect(clusters).toHaveLength(4);
    expect(clusters.map((c) => c.name)).toEqual([
      'CL-DMZ-P1',
      'CL-Prod-P2',
      'CL-Test-P2',
      'CL-Prod-P2-Oracle',
    ]);

    const byName = Object.fromEntries(clusters.map((c) => [c.name, c]));
    expect(byName['CL-DMZ-P1']).toMatchObject({
      baselineConsumption: 3378,
      baselineCapacity: 7680,
    });
    expect(byName['CL-Prod-P2']).toMatchObject({
      baselineConsumption: 19188,
      baselineCapacity: 40960,
    });
    expect(byName['CL-Test-P2']).toMatchObject({
      baselineConsumption: 3345,
      baselineCapacity: 8192,
    });
    expect(byName['CL-Prod-P2-Oracle']).toMatchObject({
      baselineConsumption: 1564,
      baselineCapacity: 4096,
    });
  });

  it('filters zero-delta events: CL-Prod-P2-Oracle has none, totals are 12/9/11/0', () => {
    const clusters = parseCapacityXlsx(REAL_XLSX);
    const counts = Object.fromEntries(clusters.map((c) => [c.name, c.events.length]));
    expect(counts).toEqual({
      'CL-DMZ-P1': 12,
      'CL-Prod-P2': 9,
      'CL-Test-P2': 11,
      'CL-Prod-P2-Oracle': 0,
    });
  });

  it('maps column L to October 2026 (L→K rule): "Ausbau Memory HPE-Server" lands on 2026-10-01', () => {
    const clusters = parseCapacityXlsx(REAL_XLSX);
    const dmz = clusters.find((c) => c.name === 'CL-DMZ-P1');
    const ev = dmz?.events.find((e) => e.title === 'Ausbau Memory HPE-Server');
    expect(ev).toEqual({
      effectiveDate: '2026-10-01',
      title: 'Ausbau Memory HPE-Server',
      category: 'hardware_change',
      capacityDelta: 2560,
      consumptionDelta: null,
    });
  });

  it('maps column P to January 2027 (P→O rule): the CL-DMZ-P1 "OpenShift - Aufbau Prod" event lands on 2027-01-01 with consumption 880', () => {
    const clusters = parseCapacityXlsx(REAL_XLSX);
    const dmz = clusters.find((c) => c.name === 'CL-DMZ-P1');
    const ev = dmz?.events.find((e) => e.title === 'OpenShift - Aufbau Prod Umgebung (DMZ)');
    expect(ev).toEqual({
      effectiveDate: '2027-01-01',
      title: 'OpenShift - Aufbau Prod Umgebung (DMZ)',
      category: 'openshift',
      capacityDelta: null,
      consumptionDelta: 880,
    });
  });

  it('preserves event order within a cluster (ascending by effectiveDate)', () => {
    const clusters = parseCapacityXlsx(REAL_XLSX);
    const dmz = clusters.find((c) => c.name === 'CL-DMZ-P1');
    const dates = dmz?.events.map((e) => e.effectiveDate) ?? [];
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @lcm/api test --run parse-capacity-xlsx
```

Expected: FAIL with `Failed to resolve import "./parse-capacity-xlsx"` (module does not exist yet).

- [ ] **Step 3: Implement the parser**

Create `apps/api/scripts/lib/parse-capacity-xlsx.ts`:

```ts
import { readFileSync } from 'node:fs';

import * as XLSX from 'xlsx';

export type ParsedEventCategory = 'growth' | 'hardware_change' | 'openshift';

export interface ParsedEvent {
  effectiveDate: string; // 'YYYY-MM-DD'
  title: string;
  category: ParsedEventCategory;
  capacityDelta: number | null;
  consumptionDelta: number | null;
}

export interface ParsedCluster {
  name: string;
  baselineConsumption: number;
  baselineCapacity: number;
  events: ParsedEvent[];
}

const SHEET_NAME = 'Forecast';
const HEADER_ROW = 7; // 1-indexed; row 7 carries the month dates
const FIRST_DATA_COL = 'F'; // first month column
const LAST_DATA_COL = 'AA'; // last month column

// Mid-month sub-event columns: L shares Oct '26 (col K), P shares Jan '27 (col O).
const SUB_EVENT_COLUMN_MAP: Record<string, string> = {
  L: 'K',
  P: 'O',
};

export function inferCategory(title: string): ParsedEventCategory {
  const t = title.trim();
  if (/^Wachstum/i.test(t)) return 'growth';
  if (/^Ausbau|^Umbau/i.test(t)) return 'hardware_change';
  if (/OpenShift/i.test(t)) return 'openshift';
  throw new Error(
    `Unmapped event title prefix: ${JSON.stringify(title)}. Add a rule to inferCategory.`,
  );
}

interface MonthByColumn {
  [col: string]: string; // YYYY-MM-DD
}

function buildMonthByColumn(ws: XLSX.WorkSheet): MonthByColumn {
  const map: MonthByColumn = {};
  const start = XLSX.utils.decode_col(FIRST_DATA_COL);
  const end = XLSX.utils.decode_col(LAST_DATA_COL);
  for (let c = start; c <= end; c++) {
    const col = XLSX.utils.encode_col(c);
    const addr = `${col}${HEADER_ROW}`;
    const cell = ws[addr];
    if (cell && cell.v instanceof Date) {
      const d = cell.v;
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      map[col] = `${yyyy}-${mm}-${dd}`;
    }
  }
  // L and P inherit from their neighbor (sub-event columns).
  for (const [sub, parent] of Object.entries(SUB_EVENT_COLUMN_MAP)) {
    if (map[parent]) map[sub] = map[parent];
  }
  return map;
}

function readNumber(ws: XLSX.WorkSheet, col: string, row: number): number | null {
  const cell = ws[`${col}${row}`];
  if (!cell || cell.v === null || cell.v === undefined || cell.v === '') return null;
  const n = Number(cell.v);
  if (!Number.isFinite(n)) return null;
  return n;
}

function readString(ws: XLSX.WorkSheet, col: string, row: number): string | null {
  const cell = ws[`${col}${row}`];
  if (!cell || cell.v === null || cell.v === undefined) return null;
  const s = String(cell.v).trim();
  return s.length > 0 ? s : null;
}

function findClusterHeaderRows(ws: XLSX.WorkSheet): number[] {
  const rows: number[] = [];
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
  for (let r = HEADER_ROW + 1; r <= range.e.r + 1; r++) {
    const name = readString(ws, 'B', r);
    if (name && /^CL-/.test(name)) rows.push(r);
  }
  return rows;
}

export function parseCapacityXlsx(filePath: string): ParsedCluster[] {
  const buf = readFileSync(filePath);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) {
    throw new Error(
      `Missing sheet '${SHEET_NAME}' in ${filePath}. Sheets: ${wb.SheetNames.join(', ')}`,
    );
  }

  const monthByColumn = buildMonthByColumn(ws);
  const headerRows = findClusterHeaderRows(ws);
  const result: ParsedCluster[] = [];

  for (const headerRow of headerRows) {
    const name = readString(ws, 'B', headerRow);
    if (!name) continue;
    const baselineConsumption = readNumber(ws, 'C', headerRow);
    const baselineCapacity = readNumber(ws, 'D', headerRow);
    if (baselineConsumption === null || baselineCapacity === null) {
      throw new Error(`Cluster '${name}' row ${headerRow} missing baseline values in C/D`);
    }

    // offsets relative to headerRow:
    //   +0 = event labels
    //   +2 = HW-Limit Δ
    //   +3 = Verbrauch Δ
    const events: ParsedEvent[] = [];

    for (const col of Object.keys(monthByColumn)) {
      const title = readString(ws, col, headerRow);
      if (!title) continue;

      const capacityDelta = readNumber(ws, col, headerRow + 2);
      const consumptionDelta = readNumber(ws, col, headerRow + 3);

      // Zero-delta filter (treats 0 the same as null for filtering purposes).
      const capacityIsZero = capacityDelta === null || capacityDelta === 0;
      const consumptionIsZero = consumptionDelta === null || consumptionDelta === 0;
      if (capacityIsZero && consumptionIsZero) continue;

      events.push({
        effectiveDate: monthByColumn[col]!,
        title,
        category: inferCategory(title),
        capacityDelta: capacityDelta && capacityDelta !== 0 ? capacityDelta : null,
        consumptionDelta: consumptionDelta && consumptionDelta !== 0 ? consumptionDelta : null,
      });
    }

    // Stable sort by effectiveDate ascending; falls back to insertion order on ties.
    events.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

    result.push({ name, baselineConsumption, baselineCapacity, events });
  }

  return result;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @lcm/api test --run parse-capacity-xlsx
```

Expected: PASS — all tests (4 `inferCategory` + 5 `parseCapacityXlsx`) green. The DB testcontainer also starts up (this is the project's default) but no DB queries run from these tests.

- [ ] **Step 5: Typecheck + lint**

```bash
pnpm --filter @lcm/api typecheck && pnpm --filter @lcm/api lint
```

Expected: no errors, no warnings.

- [ ] **Step 6: Commit**

```bash
git add apps/api/scripts/lib/parse-capacity-xlsx.ts apps/api/scripts/lib/parse-capacity-xlsx.test.ts
git commit -m "$(cat <<'EOF'
feat(api): Parse Capacity_Forecast_vSphere.xlsx into ParsedCluster[]

Pure parser module — no DB access, no fs side effects beyond reading
the input. Walks the single Forecast sheet, finds each CL-* block,
maps the L/P sub-event columns to October 2026 and January 2027
respectively, infers the event category from the title prefix
(Wachstum / Ausbau|Umbau / OpenShift), and filters zero-delta rows.
Throws on an unmapped prefix rather than guessing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 — CLI: transactional wipe + insert

**Files:**

- Create: `apps/api/scripts/import-xlsx.ts`

### Steps

- [ ] **Step 1: Implement the CLI**

Create `apps/api/scripts/import-xlsx.ts`:

```ts
#!/usr/bin/env tsx
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';

import { parseCapacityXlsx } from './lib/parse-capacity-xlsx.js';

const DEFAULT_XLSX = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'docs',
  'Capacity_Forecast_vSphere.xlsx',
);

const TENANT_ID = 'default';
const METRIC_KEY = 'memory_gb';
const TX_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  const filePath = resolve(process.argv[2] ?? DEFAULT_XLSX);
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }
  console.log(`Importing from ${filePath}`);

  const parsed = parseCapacityXlsx(filePath);
  for (const c of parsed) {
    console.log(`  ${c.name}: ${c.events.length} events`);
  }

  const prisma = new PrismaClient();
  try {
    const metric = await prisma.metricType.findUnique({ where: { key: METRIC_KEY } });
    if (!metric) {
      throw new Error(
        `MetricType '${METRIC_KEY}' missing. Run \`pnpm seed\` against this DB first.`,
      );
    }

    // Pre-flight: confirm every parsed cluster exists in the DB before any write.
    const dbClusters = await Promise.all(
      parsed.map((c) => prisma.cluster.findFirst({ where: { tenantId: TENANT_ID, name: c.name } })),
    );
    const missing = parsed.filter((_, i) => dbClusters[i] === null).map((c) => c.name);
    if (missing.length > 0) {
      throw new Error(
        `Cluster(s) missing in DB (tenant '${TENANT_ID}'): ${missing.join(', ')}. Run \`pnpm seed\` first.`,
      );
    }

    const summaries = await prisma.$transaction(
      async (tx) => {
        const lines: string[] = [];
        for (let i = 0; i < parsed.length; i++) {
          const parsedCluster = parsed[i]!;
          const dbCluster = dbClusters[i]!;
          const deletedEvents = await tx.event.deleteMany({
            where: { clusterId: dbCluster.id },
          });
          const deletedHosts = await tx.host.deleteMany({
            where: { clusterId: dbCluster.id },
          });
          for (const ev of parsedCluster.events) {
            await tx.event.create({
              data: {
                tenantId: TENANT_ID,
                clusterId: dbCluster.id,
                metricTypeId: metric.id,
                effectiveDate: new Date(`${ev.effectiveDate}T00:00:00Z`),
                category: ev.category,
                title: ev.title,
                consumptionDelta: ev.consumptionDelta,
                capacityDelta: ev.capacityDelta,
              },
            });
          }
          lines.push(
            `  ${parsedCluster.name}: deleted ${deletedEvents.count} events, ${deletedHosts.count} hosts; inserted ${parsedCluster.events.length} events`,
          );
        }
        return lines;
      },
      { timeout: TX_TIMEOUT_MS },
    );

    for (const line of summaries) console.log(line);
    console.log('Done.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck + lint**

```bash
pnpm --filter @lcm/api typecheck && pnpm --filter @lcm/api lint
```

Expected: no errors, no warnings. (If lint flags the `.js` import suffix for the local relative import, that's required by the project's NodeNext module resolution — keep it.)

- [ ] **Step 3: Dry-run the CLI with a clearly-invalid path to confirm preflight**

```bash
pnpm --filter @lcm/api db:import-xlsx /tmp/does-not-exist.xlsx
```

Expected: prints `File not found: /tmp/does-not-exist.xlsx`, exits 1.

- [ ] **Step 4: Commit**

```bash
git add apps/api/scripts/import-xlsx.ts
git commit -m "$(cat <<'EOF'
feat(api): Add one-time xlsx import CLI

Reads docs/Capacity_Forecast_vSphere.xlsx (or any path passed as
argv[2]), pre-flights that every parsed cluster exists in the DB,
then opens a Prisma transaction (30s timeout) that wipes events +
hosts on each cluster and inserts the parsed events. Aborts cleanly
on missing file, missing sheet, missing cluster, or any DB error.

Run via: pnpm --filter @lcm/api db:import-xlsx [path]

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4 — Manual verification on dev DB

**Files:** none (verification only).

### Steps

- [ ] **Step 1: Confirm the dev DB is up and seeded**

```bash
docker ps --filter "name=lcm-db-dev" --format "{{.Names}}: {{.Status}}"
```

Expected: `lcm-db-dev: Up <duration> (healthy)`. If missing, the user can start it with `docker compose -f docker-compose.dev.yml up -d db`.

```bash
DATABASE_URL=postgresql://lcm:lcm@localhost:5432/lcm pnpm --filter @lcm/api exec prisma migrate deploy
DATABASE_URL=postgresql://lcm:lcm@localhost:5432/lcm pnpm --filter @lcm/api seed
```

Expected: "Seed complete: 4 clusters, 4 baselines, 1 tenant, 1 metric type."

- [ ] **Step 2: Run the import against dev**

```bash
DATABASE_URL=postgresql://lcm:lcm@localhost:5432/lcm pnpm --filter @lcm/api db:import-xlsx
```

Expected output:

```
Importing from /home/simon/Documents/lifecycle-management/docs/Capacity_Forecast_vSphere.xlsx
  CL-DMZ-P1: 12 events
  CL-Prod-P2: 9 events
  CL-Test-P2: 11 events
  CL-Prod-P2-Oracle: 0 events
  CL-DMZ-P1: deleted N events, M hosts; inserted 12 events
  CL-Prod-P2: deleted N events, M hosts; inserted 9 events
  CL-Test-P2: deleted N events, M hosts; inserted 11 events
  CL-Prod-P2-Oracle: deleted N events, M hosts; inserted 0 events
Done.
```

Exact `N` / `M` depend on what was in dev DB before the import.

- [ ] **Step 3: Verify event counts via the dev API**

First confirm the dev API is running on :8090. If not, start it (`pnpm --filter @lcm/api dev` in a background shell).

```bash
DMZ_ID=$(curl -s http://localhost:8090/api/clusters | jq -r '.[] | select(.name=="CL-DMZ-P1") | .id')
echo "CL-DMZ-P1 id = $DMZ_ID"
curl -s "http://localhost:8090/api/clusters/$DMZ_ID/events" | jq length
```

Expected: 12.

- [ ] **Step 4: Spot-check the L→K event**

```bash
curl -s "http://localhost:8090/api/clusters/$DMZ_ID/events" | jq '.[] | select(.title=="Ausbau Memory HPE-Server")'
```

Expected: a single event with `effectiveDate: "2026-10-01"`, `category: "hardware_change"`, `capacityDelta: 2560`, `consumptionDelta: null`.

- [ ] **Step 5: Visual check in the dev web app**

Start the dev web (`pnpm --filter @lcm/web dev`) if it isn't running, then navigate to `http://localhost:5173/clusters/<CL-DMZ-P1-id>`.

Expected on the forecast chart:

- Capacity ceiling steps up at Oct 26 (+2560), Dec 26 (+4096), May 27 (+4096).
- Consumption climbs in steps matching the per-month deltas in the spreadsheet.
- The Runway pill no longer says "24+ mo" — at least one of the four clusters now shows a near-term breach.

- [ ] **Step 6: No commit**

This task is verification only.

---

## Task 5 — Manual verification on prod DB

**Files:** none (verification only). **Destructive.** Wipes operator-entered events + hosts on the 4 reference clusters in the running prod stack.

### Steps

- [ ] **Step 1: Pre-flight: take a quick mental note of what will be lost**

```bash
docker ps --filter "name=lcm-db" --filter "name=lcm-api" --filter "name=lcm-web" --format "{{.Names}}: {{.Status}}"
curl -s http://localhost:8082/api/clusters | jq '.[] | {name, id}'
```

Expected: 3 containers up; 4 clusters returned. Note the IDs — these are the prod-DB cluster IDs, distinct from dev.

- [ ] **Step 2: Run the import against the prod DB**

The prod DB container `lcm-db` publishes port 5432 only if its `docker-compose.yml` maps it. Check:

```bash
docker port lcm-db 2>/dev/null || echo "lcm-db has no published ports"
```

If `lcm-db` does NOT publish 5432 (the production compose intentionally keeps it internal), run the import from inside the API container's network instead:

```bash
docker compose exec api sh -c 'pnpm --filter @lcm/api db:import-xlsx' 2>&1 | tail -20
```

Or, if the API container image doesn't ship `tsx` / the script, run a one-shot Node container on the same compose network with `DATABASE_URL` pointed at `db`:

```bash
docker compose run --rm \
  -e DATABASE_URL='postgresql://lcm:lcm@db:5432/lcm' \
  -v "$PWD:/repo" -w /repo/apps/api \
  node:22 sh -c 'corepack enable && pnpm install --frozen-lockfile --filter @lcm/api && pnpm exec tsx scripts/import-xlsx.ts /repo/docs/Capacity_Forecast_vSphere.xlsx' \
  2>&1 | tail -25
```

Expected: the same per-cluster summary as in Task 4 Step 2 (counts may differ — operator data being wiped).

- [ ] **Step 3: Verify against the prod web**

```bash
curl -s http://localhost:8082/api/clusters | jq -r '.[] | "\(.name) \(.id)"' | while read name id; do
  count=$(curl -s "http://localhost:8082/api/clusters/$id/events" | jq length)
  echo "$name: $count events"
done
```

Expected: `CL-DMZ-P1: 12`, `CL-Prod-P2: 9`, `CL-Test-P2: 11`, `CL-Prod-P2-Oracle: 0`.

Then open `http://localhost:8082/` and confirm the new fleet views (grid + heatmap) reflect realistic per-cluster forecasts — at least one cluster's runway pill should now show a near-term breach.

- [ ] **Step 4: No commit**

The prod-DB import is a one-time runtime action; the script that performs it is already committed in Task 3.

---

## Spec coverage check

| Spec section                      | Covered by                                        |
| --------------------------------- | ------------------------------------------------- |
| 1. File layout                    | Tasks 1, 2, 3                                     |
| 2. Source shape (sheet walk, L/P) | Task 2 (impl + test)                              |
| 3. Parser contract                | Task 2                                            |
| 4. Category inference table       | Task 2 (`inferCategory` + tests)                  |
| 5. Zero-delta filter              | Task 2 (impl + test)                              |
| 6. Script flow                    | Task 3                                            |
| 7. Error handling                 | Tasks 2, 3 (parser throws; CLI catches + exits 1) |
| 8. Testing                        | Task 2 (parser tests); Tasks 4–5 (manual verify)  |
| 9. Manual verification            | Tasks 4, 5                                        |
