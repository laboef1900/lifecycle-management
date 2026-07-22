/**
 * What LCM reads out of vCenter (#176, epic #172).
 *
 * Deliberately tiny: memory only, read-only, no VM-level anything. Everything the
 * forecast needs is here and nothing else is.
 */

/** A host as vCenter describes it. Units are already normalised — see `bytesToGiB`. */
export interface CollectedHost {
  /** MoRef, e.g. `host-42`. Unique only WITHIN this vCenter. */
  moref: string;
  name: string;
  /** Installed physical memory, GiB. */
  memoryGiB: number;
  /** Machine memory in use, GiB. Absent when the host is not reporting. */
  usageGiB: number | null;
  inMaintenanceMode: boolean;
  connected: boolean;
}

export interface CollectedCluster {
  /** MoRef, e.g. `domain-c123`. Unique only WITHIN this vCenter. */
  moref: string;
  name: string;
  hosts: CollectedHost[];
}

export interface CollectedInventory {
  /** `ServiceContent.about.instanceUuid` — the vCenter's own identity. */
  instanceUuid: string;
  apiVersion: string;
  clusters: CollectedCluster[];
}

/**
 * The vCenter read surface, behind an interface.
 *
 * @ai-context Injected rather than imported so the reconciliation logic can be
 * tested against hand-built fixtures. That separation is deliberate: `vcsim`
 * gives every simulated host identical memory and a frozen `quickStats`, so it can
 * prove "we extract and shape the data correctly" but never "the reconciliation is
 * right". Conflating the two would build false confidence in the numbers that buy
 * hardware.
 */
export interface VsphereInventoryCollector {
  /**
   * Log in, read the fleet, log out — one full session per call, no keepalive.
   *
   * @param signal cancellation for graceful shutdown (design §D21). Every vCenter
   *   round-trip observes it; on abort the in-flight request is torn down and the
   *   returned promise rejects. Optional so #191 can thread a real signal without
   *   this interface changing again.
   * @throws an ordinary `Error` for expected failures (unreachable / auth / TLS).
   *   The message is credential-free and worded so `VsphereSyncService.classify()`
   *   maps it correctly — it MUST NOT name a SOAP action (a TLS failure raised
   *   during "Login" would otherwise match `/login/i` and be mis-reported as an
   *   auth failure). Callers (sync, snapshot, scheduler) contain the throw.
   */
  collect(
    input: {
      hostname: string;
      username: string;
      password: string;
      pinnedLeafSha256: string | null;
      /**
       * Destination port. Configurable per connection (#199), defaulting to 443 —
       * see `fingerprintPinnedConnection`. Changes the destination socket only; the
       * fingerprint gate is unaffected.
       */
      port?: number;
    },
    signal?: AbortSignal,
  ): Promise<CollectedInventory>;
}

const BYTES_PER_GIB = 1024 ** 3;
const MIB_PER_GIB = 1024;

/**
 * vCenter memory → LCM's `memory_gb` metric.
 *
 * @ai-warning THREE units meet here and two of them are lies:
 *
 *   - `HostSystem.summary.hardware.memorySize` is **bytes**.
 *   - `summary.quickStats.overallMemoryUsage` is documented "MB" but is **MiB** —
 *     `govc cluster.usage` reconciles it with `<< 20`, i.e. ×1048576.
 *   - LCM's metric is labelled `GB` but stores **GiB**. vCenter uses base-2
 *     arithmetic with SI prefixes throughout (govmomi's `units` defines GB as
 *     `1 << 30`), and every hand-entered baseline came from that UI.
 *
 * So: divide by 2³⁰ and 2¹⁰, never 10⁹. A decimal conversion would report a
 * 512 GiB host as 549.756 — **inflating apparent capacity by 7.4% and deferring
 * hardware purchases that are actually needed**, while agreeing with nothing an
 * operator sees in the vSphere Client.
 *
 * @ai-warning NEVER read `ComputeResourceSummary.effectiveMemory`. It sits in the
 * same struct as `totalMemory` in a *different* unit (MB vs bytes), and `vcsim`
 * populates it wrongly — adding a bytes value into the MB field — so a unit bug
 * there is invisible to the test suite and 1,048,576× wrong in production. Sum
 * per-host `memorySize` instead, which we need anyway.
 *
 * This is the ONE place the conversion happens. vSphere's mixed units are that
 * integration's quirk and must not leak past this adapter: `@lcm/shared` carries
 * GiB only, so the forecast engine stays a pure function over one unit system.
 */
export function bytesToGiB(bytes: number | bigint): number {
  return Number(bytes) / BYTES_PER_GIB;
}

/** quickStats' "MB" is MiB — see `bytesToGiB`. */
export function mibToGiB(mib: number): number {
  return mib / MIB_PER_GIB;
}
