import { ConflictError } from './errors.js';

/**
 * Server-side enforcement of sync-owned fields on synced clusters and hosts
 * (#196, epic #172).
 *
 * A `source='vsphere'` cluster or host is reconciled from vCenter on every sync
 * pass. `VsphereSyncService` writes via Prisma directly and never calls these
 * services, so guarding here can NEVER fight the sync itself — it only refuses
 * operator API mutations that vCenter would silently overwrite (or, worse, that
 * destroy data the next sync then resurrects empty: deleting a synced cluster
 * cascades away its baseline history and the next pass re-creates a hollow twin
 * under the same `(connectionId, externalId)`).
 *
 * The refusal is a stable `SYNC_OWNED_FIELD` 409 — a state conflict, not a
 * malformed payload, so `ConflictError` (409) rather than `UnprocessableError`
 * (422). The error steers the operator at the vCenter connection settings
 * generally; there is deliberately no reference to a detach action, which does
 * not exist yet.
 *
 * @ai-note This guard is FIELD-AWARE, never route-blanket. Operator-owned
 * surfaces on synced entities are deliberately left open and MUST stay that way:
 *   - label (`name`) / description / thresholds — operator-owned; `name` is
 *     pinned via `nameIsCustom`, not rejected.
 *   - `commissionedAt` / `commissionedAtProvisional` — the #194 confirm flow.
 *   - `appendCapacity` on a MANUAL host — the operator's capacity path. On a SYNCED
 *     host it is now refused (#198): sync writes each host's installed memory as its
 *     capacity, so vCenter owns it and the two writers must not fight. See
 *     {@link assertHostCapacityAppendable}.
 *   - archive/unarchive and lifecycle transitions — sync never writes those.
 */

const SYNC_SOURCE = 'vsphere';

export function isSynced(source: string): boolean {
  return source === SYNC_SOURCE;
}

/**
 * A synced cluster's existence is sync-owned: deleting it destroys the baseline
 * history this epic exists to accumulate AND the next sync re-creates an empty
 * twin. Refuse the delete; the operator manages the mapping from vCenter settings.
 */
export function assertClusterDeletable(source: string, clusterId: string): void {
  if (isSynced(source)) {
    throw new ConflictError(
      'SYNC_OWNED_FIELD',
      `Cluster ${clusterId} is synced from a vCenter connection and cannot be deleted directly. Manage it from the vCenter connection settings.`,
    );
  }
}

/**
 * Host membership of a synced cluster is sync-owned — vCenter is the authority on
 * which hosts belong to it. Refuse hand-adding a host under it.
 */
export function assertHostCreatableUnderCluster(clusterSource: string, clusterId: string): void {
  if (isSynced(clusterSource)) {
    throw new ConflictError(
      'SYNC_OWNED_FIELD',
      `Cluster ${clusterId} is synced from a vCenter connection, which owns its host membership; hosts cannot be added to it directly. Manage synced hosts from the vCenter connection settings.`,
    );
  }
}

/** A synced host is reconciled from vCenter; refuse deleting it out from under sync. */
export function assertHostDeletable(source: string, hostId: string): void {
  if (isSynced(source)) {
    throw new ConflictError(
      'SYNC_OWNED_FIELD',
      `Host ${hostId} is synced from a vCenter connection and cannot be deleted directly. Manage synced hosts from the vCenter connection settings.`,
    );
  }
}

/**
 * A synced host's cluster membership is sync-owned — `reconcileHosts` writes each
 * synced host's `clusterId` from vCenter on every pass, so an operator move would
 * fight the sync writer and be silently reverted on the next tick. Refuse it
 * (#289, parity with {@link assertHostDeletable}); a vCenter-side host move
 * reassigns the LCM cluster on the next sync, with membership history intact.
 */
export function assertHostMovable(source: string, hostId: string): void {
  if (isSynced(source)) {
    throw new ConflictError(
      'SYNC_OWNED_FIELD',
      `Host ${hostId} is synced from a vCenter connection, which owns its cluster membership; it cannot be moved directly. Move it in vCenter and it will re-sync.`,
    );
  }
}

/**
 * A synced host's capacity is sync-owned once #198 lands: sync records each host's
 * installed memory from vCenter, so the operator appendCapacity path would fight
 * the sync writer. Refuse it on synced hosts (parity with {@link assertHostDeletable});
 * manual hosts keep the operator path open.
 */
export function assertHostCapacityAppendable(source: string, hostId: string): void {
  if (isSynced(source)) {
    throw new ConflictError(
      'SYNC_OWNED_FIELD',
      `Host ${hostId} is synced from a vCenter connection, which owns its capacity; capacity cannot be appended directly. Manage synced hosts from the vCenter connection settings.`,
    );
  }
}

/**
 * Q9a write-time invariant (owner ruling 2026-07-17): for a synced cluster,
 * EVERY baseline row — manual correction or vSphere snapshot — must carry
 * `baselineCapacity = 0`, because a synced cluster's capacity comes entirely from
 * its synced host inventory. A non-zero baseline capacity double-counts the
 * fleet (capacity = fleet + fleet), halving utilization so the tool reports
 * "plenty of headroom" and hardware is never ordered.
 *
 * The sanctioned baseline-correction path stays open: `baselineConsumption` and
 * `baselineDate` corrections are allowed on a synced cluster — only a non-zero
 * `baselineCapacity` is refused. This deliberately amends #196's "baseline
 * corrections out of scope" wording (the invariant constrains one field within
 * that path rather than blocking it).
 */
export function assertSyncedBaselineCapacityZero(
  source: string,
  clusterId: string,
  baselines: readonly { baselineCapacity: number }[],
): void {
  if (!isSynced(source)) return;
  if (baselines.some((b) => b.baselineCapacity !== 0)) {
    throw new ConflictError(
      'SYNC_OWNED_FIELD',
      `Cluster ${clusterId} is synced from a vCenter connection: its capacity is derived from synced host inventory, so every baseline row must have baselineCapacity = 0. Correct baselineConsumption instead.`,
    );
  }
}
