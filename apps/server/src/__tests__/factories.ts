import { startOfUtcMonth } from '@lcm/shared';
import type { EntitySource, HostState, VsphereConnectionStatus } from '@lcm/shared';
import { Prisma, type PrismaClient } from '@prisma/client';

import { encrypt } from '../crypto/secret-box.js';

const DEFAULT_TENANT = 'default';
const DEFAULT_METRIC_KEY = 'memory_gb';
const DEFAULT_BASELINE_DATE = new Date('2026-05-01T00:00:00.000Z');

let sequence = 0;

function nextSuffix(): string {
  sequence += 1;
  return `${Date.now().toString(36)}_${sequence}`;
}

async function resolveMetricId(prisma: PrismaClient, key: string): Promise<string> {
  const metric = await prisma.metricType.findUnique({ where: { key } });
  if (!metric) {
    throw new Error(`Metric type ${key} is not seeded; check vitest.global-setup.ts`);
  }
  return metric.id;
}

export interface MakeClusterOptions {
  /**
   * Explicit primary key. Omitted, Prisma generates a `cuid()`, which differs
   * every run — fine for assertions, fatal for snapshots (ids surface in
   * `ForecastResult.hosts[].id` / `applications[].id`). Snapshot tests pass a
   * stable id so the committed snapshot is a function of behaviour only.
   */
  id?: string;
  name?: string;
  description?: string | null;
  /**
   * The PERIOD the cluster's first baseline-history row lands in, snapped to the
   * first of the month. Since #195 there is no cluster-level baseline date column
   * behind this — `ClusterResponse.baselineDate` is derived from history — but the
   * option name is kept because ~8 call sites pass it and several feed the
   * forecast characterization snapshot.
   */
  baselineDate?: Date;
  metricKey?: string;
  baselineConsumption?: number;
  baselineCapacity?: number;
  tenantId?: string;
  /**
   * Sync provenance. Omitted leaves the schema default (`manual`) with null sync
   * fields — an ordinary manual cluster. Pass `source: 'vsphere'` (with a
   * `connectionId`) to fabricate a synced cluster for the live-usage / sync-state
   * surfaces (#193) and the #196 sync-owned-field guard. `externalId` is required
   * by the DB's `(connectionId, externalId)` identity once a connection is set.
   */
  source?: EntitySource;
  connectionId?: string;
  externalId?: string;
  externalName?: string;
  lastSyncedAt?: Date;
  /**
   * Extra baseline-history rows, each carrying its own metric and its own period.
   *
   * The options above produce exactly ONE row — one metric, one period — which
   * cannot express the fixture `ClusterResponse.baselineDate` has to be tested
   * against. That field is MIN over the NEWEST row per metric, and telling it
   * apart from MAX, and from a naive MIN over every row, needs two metrics whose
   * newest periods differ plus one metric carrying two periods. Every fixture in
   * the suite before this one had a single row per metric, under which all three
   * implementations agree.
   *
   * `capturedAt` is snapped to the first of the month exactly as every real
   * writer snaps it: the period unique key is the monthly idempotency guarantee,
   * so a fixture holding a mid-month anchor would describe a state the
   * application cannot produce.
   */
  extraBaselines?: readonly {
    metricKey: string;
    capturedAt: Date;
    baselineConsumption?: number;
    baselineCapacity?: number;
    source?: 'manual' | 'vsphere';
    /** See {@link MakeClusterOptions.observedAt} — same rule, per extra row. */
    observedAt?: Date | null;
  }[];
  /**
   * Provenance of the PRIMARY baseline-history row (the one the options above
   * produce). Distinct from `source`, which is the CLUSTER's provenance: a synced
   * cluster imported before its first snapshot has `source: 'vsphere'` and no
   * vSphere baseline row at all. Defaults to `manual`.
   */
  baselineSource?: 'manual' | 'vsphere';
  /**
   * The instant the measurement was actually taken — `ClusterBaselineHistory.
   * observedAt`, which forecast absorption keys off (`absorbsDeltas` in
   * forecast.ts). Omitted, it is DERIVED, not left null:
   *
   *   - a `vsphere` row gets its own `capturedAt`, because that is the only state
   *     production can produce. `VsphereSnapshotService` writes both columns from
   *     one `measuredAt` (`capturedAt: startOfUtcMonth(measuredAt)`,
   *     `observedAt: measuredAt`), so snapping `observedAt` always yields
   *     `capturedAt`. A `vsphere` row with `observedAt: null` is an UNREACHABLE
   *     state, and a fixture in it silently exercises the null guard instead of
   *     the boundary the test means to test — which is how the regression corpus
   *     for defects 1-6 ended up on the replaced code path.
   *   - a `manual` row gets `null`. Manual baselines are never measured — no
   *     manual write path sets `observedAt` — and a null measured period is
   *     exactly what makes `absorbed` return false for them. That is now the ONLY
   *     thing keeping a manual baseline unabsorbed: `absorbed` does not read
   *     `source`, so a fixture that set `observedAt` on a manual row would
   *     describe an absorbing baseline, not a manual one.
   *
   * Pass it explicitly (including `null`) only to fabricate a state deliberately:
   * a mid-month instant where the SNAP is what a test is pinning, or `null` on a
   * `vsphere` row to exercise the broken-invariant fail-safe.
   */
  observedAt?: Date | null;
}

/**
 * The `observedAt` a baseline-history row would really carry. See
 * {@link MakeClusterOptions.observedAt} for why a `vsphere` row defaults to its
 * own `capturedAt` rather than to null.
 *
 * `undefined` means "not specified" and derives; an explicit `null` is honoured,
 * so a test can still fabricate the broken-invariant row on purpose.
 */
function resolveObservedAt(
  explicit: Date | null | undefined,
  source: 'manual' | 'vsphere',
  capturedAt: Date,
): Date | null {
  if (explicit !== undefined) return explicit;
  return source === 'vsphere' ? capturedAt : null;
}

export async function makeCluster(
  prisma: PrismaClient,
  options: MakeClusterOptions = {},
): Promise<{ id: string; name: string; metricTypeId: string }> {
  const metricKey = options.metricKey ?? DEFAULT_METRIC_KEY;
  const metricTypeId = await resolveMetricId(prisma, metricKey);
  const tenantId = options.tenantId ?? DEFAULT_TENANT;
  const name = options.name ?? `cluster-${nextSuffix()}`;

  const extraBaselines = await Promise.all(
    (options.extraBaselines ?? []).map(async (extra) => {
      const capturedAt = startOfUtcMonth(extra.capturedAt);
      const source = extra.source ?? 'manual';
      return {
        tenantId,
        metricTypeId: await resolveMetricId(prisma, extra.metricKey),
        capturedAt,
        source,
        observedAt: resolveObservedAt(extra.observedAt, source, capturedAt),
        baselineConsumption: new Prisma.Decimal(extra.baselineConsumption ?? 0),
        baselineCapacity: new Prisma.Decimal(extra.baselineCapacity ?? 0),
      };
    }),
  );

  const primaryCapturedAt = startOfUtcMonth(options.baselineDate ?? DEFAULT_BASELINE_DATE);
  const primarySource = options.baselineSource ?? 'manual';

  const cluster = await prisma.cluster.create({
    data: {
      ...(options.id !== undefined ? { id: options.id } : {}),
      tenantId,
      name,
      description: options.description ?? null,
      ...(options.source !== undefined ? { source: options.source } : {}),
      ...(options.connectionId !== undefined ? { connectionId: options.connectionId } : {}),
      ...(options.externalId !== undefined ? { externalId: options.externalId } : {}),
      ...(options.externalName !== undefined ? { externalName: options.externalName } : {}),
      ...(options.lastSyncedAt !== undefined ? { lastSyncedAt: options.lastSyncedAt } : {}),
      // `cluster_baseline_history` is the only baseline store (#195): the
      // forecast anchors on it, and `ClusterResponse.metrics`/`baselineDate` are
      // both derived from it. `baselineDate` names the PERIOD this row lands in.
      baselineHistory: {
        create: [
          {
            tenantId,
            metricTypeId,
            capturedAt: primaryCapturedAt,
            source: primarySource,
            observedAt: resolveObservedAt(options.observedAt, primarySource, primaryCapturedAt),
            baselineConsumption: new Prisma.Decimal(options.baselineConsumption ?? 0),
            baselineCapacity: new Prisma.Decimal(options.baselineCapacity ?? 0),
          },
          ...extraBaselines,
        ],
      },
    },
  });

  return { id: cluster.id, name: cluster.name, metricTypeId };
}

export interface MakeHostOptions {
  /** Explicit primary key — see `MakeClusterOptions.id`. */
  id?: string;
  clusterId: string;
  name?: string;
  commissionedAt?: Date;
  decommissionedAt?: Date | null;
  metricKey?: string;
  initialCapacity?: { effectiveFrom: Date; amount: number }[];
  tenantId?: string;
  /** Lifecycle state; omitted uses the schema default (in_service). */
  state?: HostState;
  /**
   * A synced host whose commissioning date vCenter could not supply (Q9c, #194).
   * Marks the imported `commissionedAt` as provisional (sync-imported,
   * unconfirmed). Drives the fleet-console "N hosts need commissioning dates"
   * hint (#193/#194). Omitted leaves the schema default (`false`). Set `true`
   * alongside `source: 'vsphere'` to fabricate the provisional state the confirm
   * flow operates on.
   */
  commissionedAtProvisional?: boolean;
  source?: EntitySource;
  connectionId?: string;
  externalId?: string;
}

export async function makeHost(
  prisma: PrismaClient,
  options: MakeHostOptions,
): Promise<{ id: string; name: string }> {
  const metricKey = options.metricKey ?? DEFAULT_METRIC_KEY;
  const metricTypeId = await resolveMetricId(prisma, metricKey);
  const tenantId = options.tenantId ?? DEFAULT_TENANT;
  const commissionedAt = options.commissionedAt ?? DEFAULT_BASELINE_DATE;
  const name = options.name ?? `host-${nextSuffix()}`;
  const initialCapacity = options.initialCapacity ?? [
    { effectiveFrom: commissionedAt, amount: 512 },
  ];

  const host = await prisma.host.create({
    data: {
      ...(options.id !== undefined ? { id: options.id } : {}),
      tenantId,
      clusterId: options.clusterId,
      name,
      commissionedAt,
      decommissionedAt: options.decommissionedAt ?? null,
      ...(options.state !== undefined && { state: options.state }),
      ...(options.commissionedAtProvisional !== undefined && {
        commissionedAtProvisional: options.commissionedAtProvisional,
      }),
      ...(options.source !== undefined && { source: options.source }),
      ...(options.connectionId !== undefined && { connectionId: options.connectionId }),
      ...(options.externalId !== undefined && { externalId: options.externalId }),
      capacities: {
        create: initialCapacity.map((row) => ({
          tenantId,
          metricTypeId,
          effectiveFrom: row.effectiveFrom,
          amount: new Prisma.Decimal(row.amount),
        })),
      },
      // #289 Every real host-creating path (HostsService.create, sync, and the
      // migration backfill) opens one membership timeline in the host's cluster.
      // The forecast attributes host capacity THROUGH this timeline, so the
      // factory must seed it too — otherwise a factory-made host would contribute
      // nothing to its cluster's forecast. `effectiveFrom = commissionedAt`,
      // `effectiveTo = null` reproduces the pre-#289 whole-life attribution.
      memberships: {
        create: [{ tenantId, clusterId: options.clusterId, effectiveFrom: commissionedAt }],
      },
    },
  });

  return { id: host.id, name: host.name };
}

export interface MakeApplicationOptions {
  /** Explicit primary key — see `MakeClusterOptions.id`. */
  id?: string;
  clusterId: string;
  name?: string;
  category?: string;
  startedAt?: Date;
  endedAt?: Date | null;
  metricKey?: string;
  initialAllocation?: { effectiveFrom: Date; amount: number }[];
  tenantId?: string;
}

export async function makeApplication(
  prisma: PrismaClient,
  options: MakeApplicationOptions,
): Promise<{ id: string; name: string }> {
  const metricKey = options.metricKey ?? DEFAULT_METRIC_KEY;
  const metricTypeId = await resolveMetricId(prisma, metricKey);
  const tenantId = options.tenantId ?? DEFAULT_TENANT;
  const startedAt = options.startedAt ?? DEFAULT_BASELINE_DATE;
  const name = options.name ?? `app-${nextSuffix()}`;
  const initialAllocation = options.initialAllocation ?? [{ effectiveFrom: startedAt, amount: 64 }];

  const application = await prisma.item.create({
    data: {
      ...(options.id !== undefined ? { id: options.id } : {}),
      tenantId,
      clusterId: options.clusterId,
      kind: 'application',
      name,
      category: options.category ?? 'openshift',
      effectiveDate: startedAt,
      endedAt: options.endedAt ?? null,
      allocations: {
        create: initialAllocation.map((row) => ({
          tenantId,
          metricTypeId,
          effectiveFrom: row.effectiveFrom,
          amount: new Prisma.Decimal(row.amount),
        })),
      },
    },
  });

  return { id: application.id, name: application.name };
}

export interface MakeEventOptions {
  /** Explicit primary key — see `MakeClusterOptions.id`. */
  id?: string;
  clusterId: string;
  effectiveDate?: Date;
  category?: string;
  title?: string;
  description?: string | null;
  consumptionDelta?: number | null;
  capacityDelta?: number | null;
  metricKey?: string;
  tenantId?: string;
}

export async function makeEvent(
  prisma: PrismaClient,
  options: MakeEventOptions,
): Promise<{ id: string; title: string }> {
  const metricKey = options.metricKey ?? DEFAULT_METRIC_KEY;
  const metricTypeId = await resolveMetricId(prisma, metricKey);
  const tenantId = options.tenantId ?? DEFAULT_TENANT;
  const title = options.title ?? `event-${nextSuffix()}`;

  const event = await prisma.item.create({
    data: {
      ...(options.id !== undefined ? { id: options.id } : {}),
      tenantId,
      clusterId: options.clusterId,
      kind: 'event',
      metricTypeId,
      name: title,
      effectiveDate: options.effectiveDate ?? new Date('2026-10-01T00:00:00.000Z'),
      category: options.category ?? 'growth',
      description: options.description ?? null,
      consumptionDelta:
        options.consumptionDelta === undefined
          ? new Prisma.Decimal(100)
          : options.consumptionDelta === null
            ? null
            : new Prisma.Decimal(options.consumptionDelta),
      capacityDelta:
        options.capacityDelta === undefined || options.capacityDelta === null
          ? null
          : new Prisma.Decimal(options.capacityDelta),
    },
  });

  return { id: event.id, title: event.name };
}

export interface MakeVsphereConnectionOptions {
  id?: string;
  name?: string;
  hostname?: string;
  username?: string;
  password?: string;
  enabled?: boolean;
  status?: VsphereConnectionStatus;
  tenantId?: string;
  instanceUuid?: string;
  lastConnectedAt?: Date | null;
  /**
   * The pinned leaf-fingerprint SHA-256 (schema column `tlsPinnedSha256`). Defaults
   * to `null` — an unestablished pin, which the scheduler/job-runner now gate OUT of
   * unattended work (#279). Pass a fingerprint to model an established, pinned
   * connection (what the scheduler/job-runner suites need to reach the run path).
   */
  tlsPinnedSha256?: string | null;
  /**
   * The AES-GCM key the password is encrypted under — must match the service that
   * reveals it. Supply it to write a REAL encrypted `passwordEnc` (so
   * `revealPassword` round-trips, as the scheduler/job tests need). Omit it and the
   * row gets a non-secret placeholder ciphertext instead — fine for read-path tests
   * (live usage, sync-state surfaces — #193) that never decrypt the credential.
   */
  key?: Buffer;
}

/**
 * A vCenter connection row. Writes the row directly (no scheduler job — pair with
 * {@link makeVsphereConnectionJob} when a due job is needed) so a test controls the
 * job's timestamps precisely.
 *
 * With a `key`, `passwordEnc` is a real AES-GCM ciphertext that `revealPassword`
 * round-trips; without one it is a placeholder, which is all the read paths that
 * only ever read `name`/`status`/`enabled` require. Do NOT rely on the placeholder
 * for tests that decrypt the credential — pass `key` (or use the service).
 */
export async function makeVsphereConnection(
  prisma: PrismaClient,
  options: MakeVsphereConnectionOptions = {},
): Promise<{ id: string; name: string; tenantId: string }> {
  const tenantId = options.tenantId ?? DEFAULT_TENANT;
  const name = options.name ?? `vc-${nextSuffix()}`;
  const passwordEnc =
    options.key !== undefined
      ? encrypt(options.password ?? 'p', options.key)
      : 'factory-placeholder-not-a-real-secret';
  const connection = await prisma.vsphereConnection.create({
    data: {
      ...(options.id !== undefined ? { id: options.id } : {}),
      tenantId,
      name,
      hostname: options.hostname ?? 'vcenter.corp.local',
      username: options.username ?? 'svc-lcm',
      passwordEnc,
      ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.instanceUuid !== undefined ? { instanceUuid: options.instanceUuid } : {}),
      ...(options.lastConnectedAt !== undefined
        ? { lastConnectedAt: options.lastConnectedAt }
        : {}),
      ...(options.tlsPinnedSha256 !== undefined
        ? { tlsPinnedSha256: options.tlsPinnedSha256 }
        : {}),
    },
  });
  return { id: connection.id, name: connection.name, tenantId: connection.tenantId };
}

export interface MakeVsphereConnectionJobOptions {
  connectionId: string;
  dueAt?: Date;
  lastPollAt?: Date | null;
  lastSyncAt?: Date | null;
  lastSyncStatus?: string | null;
  lastSnapshotAt?: Date | null;
  lastSnapshotStatus?: string | null;
  lastSnapshotPeriod?: Date | null;
  lastSuccessPeriod?: Date | null;
  failureCount?: number;
  runningSince?: Date | null;
  lockedBy?: string | null;
}

/** A scheduler job row for a connection, with every last-run timestamp controllable. */
export async function makeVsphereConnectionJob(
  prisma: PrismaClient,
  options: MakeVsphereConnectionJobOptions,
): Promise<void> {
  await prisma.vsphereConnectionJob.create({
    data: {
      connectionId: options.connectionId,
      dueAt: options.dueAt ?? new Date(0),
      lastPollAt: options.lastPollAt ?? null,
      lastSyncAt: options.lastSyncAt ?? null,
      lastSyncStatus: options.lastSyncStatus ?? null,
      lastSnapshotAt: options.lastSnapshotAt ?? null,
      lastSnapshotStatus: options.lastSnapshotStatus ?? null,
      lastSnapshotPeriod: options.lastSnapshotPeriod ?? null,
      lastSuccessPeriod: options.lastSuccessPeriod ?? null,
      failureCount: options.failureCount ?? 0,
      runningSince: options.runningSince ?? null,
      lockedBy: options.lockedBy ?? null,
    },
  });
}

export interface MakeUserOptions {
  issuer?: string;
  subject?: string;
  email?: string | null;
  displayName?: string | null;
  role?: 'ADMIN' | 'VIEWER';
}

export async function makeUser(
  prisma: PrismaClient,
  options: MakeUserOptions = {},
): Promise<{ id: string; email: string | null; role: 'ADMIN' | 'VIEWER' }> {
  const suffix = nextSuffix();
  const user = await prisma.user.create({
    data: {
      issuer: options.issuer ?? 'https://idp.test',
      subject: options.subject ?? `sub-${suffix}`,
      email: options.email === undefined ? `user-${suffix}@example.com` : options.email,
      displayName: options.displayName ?? null,
      role: options.role ?? 'ADMIN',
    },
  });
  return { id: user.id, email: user.email, role: user.role };
}

export interface MakeSessionOptions {
  userId: string;
  tokenHash?: string;
  expiresAt?: Date;
}

export async function makeSession(
  prisma: PrismaClient,
  options: MakeSessionOptions,
): Promise<{ id: string; tokenHash: string }> {
  const tokenHash = options.tokenHash ?? `hash-${nextSuffix()}`;
  const session = await prisma.session.create({
    data: {
      userId: options.userId,
      tokenHash,
      expiresAt: options.expiresAt ?? new Date(Date.now() + 12 * 60 * 60 * 1000),
    },
  });
  return { id: session.id, tokenHash };
}
