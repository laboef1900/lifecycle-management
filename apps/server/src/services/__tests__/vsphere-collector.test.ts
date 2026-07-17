import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { soapCall } from '../vsphere-client.js';
import {
  VsphereClientInventoryCollector,
  type CollectorLogger,
  type SoapTransport,
} from '../vsphere-collector.js';
import { VCSIM_CERT_PEM, VCSIM_IMAGE, VCSIM_KEY_PEM } from './vcsim-fixtures.js';

/**
 * The production inventory collector (#190), against real vcsim over real SOAP+TLS.
 *
 * @ai-context vcsim proves SHAPE, not NUMBERS — every simulated host has identical
 * memory (4294430720 B = 3.9995 GiB, *not* 4) and a frozen `quickStats`. These
 * tests therefore assert extraction, unit conversion, pagination, grouping and the
 * failure paths — never a forecast result. The reconciliation maths is tested
 * separately against hand-built fixtures (`__tests__/vsphere-sync.test.ts`), on
 * purpose: conflating the two would build false confidence in the numbers that buy
 * hardware.
 *
 * The connection uses `hostname: 'localhost'` (in the fixture cert's SAN) plus the
 * test-only `port` seam so a Testcontainers-mapped port is reachable. TLS is the
 * real production path: `ca: [VCSIM_CERT_PEM]`, `rejectUnauthorized: true`.
 */

// A plain service-account username: vcsim rejects a login whose userName contains
// '@' (it treats user@domain specially), which is a vcsim quirk, not a collector
// constraint — real vCenter accepts UPN-form names. The credential path is what
// matters here, and this exercises it fully.
const USERNAME = 'svc-lcm';
const PASSWORD = 'correct-horse-battery-staple';

// Every simulated host, from `simulator/esx/host_system.go`.
const HOST_MEMORY_BYTES = 4294430720; // 3.9995 GiB — deliberately NOT 4
const HOST_USAGE_MIB = 1404;

interface Topology {
  dc: number;
  cluster: number;
  host: number;
  standalone: number;
}

async function startVcsim(topology: Topology): Promise<StartedTestContainer> {
  return new GenericContainer(VCSIM_IMAGE)
    .withExposedPorts(8989)
    .withCopyContentToContainer([
      { content: VCSIM_CERT_PEM, target: '/cert.pem' },
      { content: VCSIM_KEY_PEM, target: '/key.pem' },
    ])
    .withCommand([
      '-l',
      '0.0.0.0:8989',
      '-tls',
      '-tlscert',
      '/cert.pem',
      '-tlskey',
      '/key.pem',
      // ⚠️ vcsim accepts ANY credentials unless -username/-password are set, so an
      // auth-rejection test would pass for the wrong reason without them.
      '-username',
      USERNAME,
      '-password',
      PASSWORD,
      '-dc',
      String(topology.dc),
      '-cluster',
      String(topology.cluster),
      '-host',
      String(topology.host),
      '-standalone-host',
      String(topology.standalone),
    ])
    .withWaitStrategy(Wait.forLogMessage(/export GOVC_URL/))
    .withStartupTimeout(120_000)
    .start();
}

function endpoint(container: StartedTestContainer): {
  hostname: string;
  port: number;
  pinnedRootPem: string;
} {
  return {
    hostname: 'localhost',
    port: container.getMappedPort(8989),
    pinnedRootPem: VCSIM_CERT_PEM,
  };
}

function hostCount(clusters: { hosts: unknown[] }[]): number {
  return clusters.reduce((total, cluster) => total + cluster.hosts.length, 0);
}

describe('VsphereClientInventoryCollector (vcsim)', () => {
  // fleet: 2 dc × (2 cluster × 4 host + 1 standalone) = 18 hosts, 6 compute resources
  let fleet: StartedTestContainer;
  // second vCenter: 1 dc × (1 cluster × 2 host + 1 standalone) = 3 hosts
  let second: StartedTestContainer;

  beforeAll(async () => {
    [fleet, second] = await Promise.all([
      startVcsim({ dc: 2, cluster: 2, host: 4, standalone: 1 }),
      startVcsim({ dc: 1, cluster: 1, host: 2, standalone: 1 }),
    ]);
  }, 240_000);

  afterAll(async () => {
    await Promise.all([fleet?.stop(), second?.stop()]);
  });

  it('collects the whole fleet with memory normalised to GiB (base-2, never 10⁹)', async () => {
    const warnings: string[] = [];
    const logger: CollectorLogger = { warn: (_details, message) => warnings.push(message) };
    const collector = new VsphereClientInventoryCollector({ logger });

    const inventory = await collector.collect({
      ...endpoint(fleet),
      username: USERNAME,
      password: PASSWORD,
    });

    expect(inventory.instanceUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(inventory.apiVersion).toBeTruthy();

    const hosts = inventory.clusters.flatMap((cluster) => cluster.hosts);
    expect(hosts).toHaveLength(18);
    expect(inventory.clusters).toHaveLength(6);

    for (const host of hosts) {
      // 4294430720 / 2³⁰, asserted with tolerance — NOT hard-coded to 4.
      expect(host.memoryGiB).toBeCloseTo(HOST_MEMORY_BYTES / 1024 ** 3, 5);
      expect(host.memoryGiB).not.toBe(4);
      expect(host.usageGiB).toBeCloseTo(HOST_USAGE_MIB / 1024, 5); // MiB → GiB, not /1000
      expect(host.connected).toBe(true);
      expect(host.inMaintenanceMode).toBe(false);
      expect(host.moref).toMatch(/^host-/);
    }

    // Σ per-host memorySize == cluster totalMemory in vcsim, so the drift check is
    // silent — proving the check ran against consistent data (design §D3 rule 2).
    expect(warnings).toEqual([]);
  });

  it('groups clustered AND standalone hosts, dropping neither (capacity is never truncated)', async () => {
    const collector = new VsphereClientInventoryCollector();
    const inventory = await collector.collect({
      ...endpoint(fleet),
      username: USERNAME,
      password: PASSWORD,
    });

    // A standalone ESXi host's parent is a plain ComputeResource, not a cluster.
    // Grouping by parent surfaces it as a single-host cluster instead of dropping it.
    const singleHostClusters = inventory.clusters.filter((cluster) => cluster.hosts.length === 1);
    const fourHostClusters = inventory.clusters.filter((cluster) => cluster.hosts.length === 4);
    expect(singleHostClusters).toHaveLength(2); // one standalone host per datacenter
    expect(fourHostClusters).toHaveLength(4); // 2 datacenters × 2 clusters
    expect(hostCount(inventory.clusters)).toBe(18);
  });

  it('follows ContinueRetrievePropertiesEx, so a paged fleet is not silently truncated', async () => {
    // Force pagination: 24 managed objects at 2 per page ⇒ 12 pages ⇒ 11 continues.
    // A collector missing the loop would return ≤ 2 objects and issue 0 continues.
    let continueCalls = 0;
    const transport: SoapTransport = (hostname, pinnedRootPem, action, body, cookie, options) => {
      if (action === 'ContinueRetrievePropertiesEx') continueCalls += 1;
      return soapCall(hostname, pinnedRootPem, action, body, cookie, options);
    };
    const collector = new VsphereClientInventoryCollector({ maxObjects: 2, transport });

    const inventory = await collector.collect({
      ...endpoint(fleet),
      username: USERNAME,
      password: PASSWORD,
    });

    expect(continueCalls).toBeGreaterThanOrEqual(11);
    expect(hostCount(inventory.clusters)).toBe(18); // completeness is the real proof
  });

  it('throws a credential-classified error on a bad password, and never leaks it', async () => {
    const collector = new VsphereClientInventoryCollector();
    const secret = 'WRONG-PASSWORD-must-not-appear-anywhere';

    let caught: unknown;
    try {
      await collector.collect({ ...endpoint(fleet), username: USERNAME, password: secret });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    // classify() tests /auth|login|credential/i first: this must match /credential/,
    // and must NOT name the SOAP action (a "Login: …" message would misclassify a
    // TLS failure as auth). The secret must never appear in a message stored in
    // `lastError`.
    expect(message).toMatch(/credential/i);
    expect(message).not.toMatch(/\blogin\b/i);
    expect(message).not.toContain(secret);
  });

  it('refuses an untrusted certificate and never transmits the credential', async () => {
    const collector = new VsphereClientInventoryCollector();
    const secret = 'must-never-be-sent-over-untrusted-tls';

    let caught: unknown;
    try {
      await collector.collect({
        hostname: 'localhost',
        port: fleet.getMappedPort(8989),
        pinnedRootPem: null, // no pin ⇒ the self-signed cert is distrusted by the system store
        username: USERNAME,
        password: secret,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    // The TLS handshake fails before any SOAP body is written, so the credential is
    // never sent. classify() maps this to tls_untrusted, not auth_failed.
    expect(message).toMatch(/cert/i);
    expect(message).not.toMatch(/credential|auth/i);
    expect(message).not.toContain(secret);
  });

  it('collects independently from two vCenters (multi-vCenter path)', async () => {
    const collector = new VsphereClientInventoryCollector();
    const [inventoryA, inventoryB] = await Promise.all([
      collector.collect({ ...endpoint(fleet), username: USERNAME, password: PASSWORD }),
      collector.collect({ ...endpoint(second), username: USERNAME, password: PASSWORD }),
    ]);

    expect(hostCount(inventoryA.clusters)).toBe(18);
    expect(hostCount(inventoryB.clusters)).toBe(3);
    // Two distinct appliances ⇒ distinct identities; the MoRef namespaces do not mix.
    expect(inventoryA.instanceUuid).not.toBe(inventoryB.instanceUuid);
  });

  it('cancels in-flight work when the AbortSignal fires (graceful shutdown, §D21)', async () => {
    const collector = new VsphereClientInventoryCollector();
    const controller = new AbortController();
    controller.abort();

    await expect(
      collector.collect(
        { ...endpoint(fleet), username: USERNAME, password: PASSWORD },
        controller.signal,
      ),
    ).rejects.toThrow();
  });
});

/**
 * Host inclusion policy — §D3 rule 1c (owner-approved 2026-07-17).
 *
 * @ai-context vcsim CANNOT reach these states: every simulated host is connected
 * and has identical, non-null memory. So this exercise drives the same `transport`
 * seam the pagination test uses, but with a fully-synthetic PropertyCollector
 * response instead of delegating to `soapCall` — no vcsim, no Docker. That is the
 * whole point: the defect (one disconnected/unreadable host aborting the ENTIRE
 * vCenter's collection, then being mis-reported as an unreachable-network failure)
 * is invisible to the vcsim suite by construction.
 *
 * The crafted response contains, all under the same cluster `domain-c1`:
 *   (a) a normal CONNECTED host with readable memory,
 *   (b) a DISCONNECTED host that still advertises a memorySize — proving exclusion
 *       is driven by `connectionState`, not incidentally by missing memory,
 *   (c) a CONNECTED host with NO `summary.hardware.memorySize`.
 * The cluster's `summary.totalMemory` equals host (a) alone, so a silent drift
 * check confirms the sum was taken over the INCLUDED hosts only (rule 5).
 */
/** Wrap a response payload in the SOAP envelope a vCenter would return. */
function envelope(body: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`
  );
}

describe('VsphereClientInventoryCollector — host inclusion policy (§D3 rule 1c)', () => {
  const HOST_A_MEMORY_BYTES = 4294430720; // counted
  const HOST_B_MEMORY_BYTES = 8589934592; // advertised but MUST NOT be counted (disconnected)

  const serviceContentBody = envelope(
    `<RetrieveServiceContentResponse xmlns="urn:vim25"><returnval>` +
      `<rootFolder type="Folder">group-d1</rootFolder>` +
      `<propertyCollector type="PropertyCollector">propertyCollector</propertyCollector>` +
      `<viewManager type="ViewManager">ViewManager</viewManager>` +
      `<about><instanceUuid>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</instanceUuid>` +
      `<apiVersion>8.0.3.0</apiVersion></about>` +
      `<sessionManager type="SessionManager">SessionManager</sessionManager>` +
      `</returnval></RetrieveServiceContentResponse>`,
  );

  const createViewBody = envelope(
    `<CreateContainerViewResponse xmlns="urn:vim25">` +
      `<returnval type="ContainerView">ContainerView-lcm</returnval>` +
      `</CreateContainerViewResponse>`,
  );

  const retrieveBody = envelope(
    `<RetrievePropertiesExResponse xmlns="urn:vim25"><returnval>` +
      // (a) connected + readable → counted
      `<objects><obj type="HostSystem">host-a</obj>` +
      `<propSet><name>name</name><val>esx-a.example.test</val></propSet>` +
      `<propSet><name>parent</name><val type="ClusterComputeResource">domain-c1</val></propSet>` +
      `<propSet><name>summary.hardware.memorySize</name><val>${HOST_A_MEMORY_BYTES}</val></propSet>` +
      `<propSet><name>summary.quickStats.overallMemoryUsage</name><val>1404</val></propSet>` +
      `<propSet><name>runtime.inMaintenanceMode</name><val>false</val></propSet>` +
      `<propSet><name>runtime.connectionState</name><val>connected</val></propSet></objects>` +
      // (b) disconnected but advertises memory → EXCLUDED by policy, memory ignored
      `<objects><obj type="HostSystem">host-b</obj>` +
      `<propSet><name>name</name><val>esx-b.example.test</val></propSet>` +
      `<propSet><name>parent</name><val type="ClusterComputeResource">domain-c1</val></propSet>` +
      `<propSet><name>summary.hardware.memorySize</name><val>${HOST_B_MEMORY_BYTES}</val></propSet>` +
      `<propSet><name>runtime.inMaintenanceMode</name><val>false</val></propSet>` +
      `<propSet><name>runtime.connectionState</name><val>disconnected</val></propSet></objects>` +
      // (c) connected but no readable memorySize → SKIPPED as an anomaly
      `<objects><obj type="HostSystem">host-c</obj>` +
      `<propSet><name>name</name><val>esx-c.example.test</val></propSet>` +
      `<propSet><name>parent</name><val type="ClusterComputeResource">domain-c1</val></propSet>` +
      `<propSet><name>runtime.inMaintenanceMode</name><val>false</val></propSet>` +
      `<propSet><name>runtime.connectionState</name><val>connected</val></propSet></objects>` +
      // the cluster: totalMemory == host (a) alone, so drift stays silent
      `<objects><obj type="ClusterComputeResource">domain-c1</obj>` +
      `<propSet><name>name</name><val>Production Cluster</val></propSet>` +
      `<propSet><name>summary.totalMemory</name><val>${HOST_A_MEMORY_BYTES}</val></propSet></objects>` +
      `</returnval></RetrievePropertiesExResponse>`,
  );

  function syntheticTransport(): SoapTransport {
    // A canned response per SOAP action — the collector's full session sequence,
    // no network. `_hostname`/`_pinnedRootPem` are unused: this transport never
    // touches TLS or sockets.
    return (_hostname, _pinnedRootPem, action) => {
      switch (action) {
        case 'RetrieveServiceContent':
          return Promise.resolve({ status: 200, body: serviceContentBody, setCookie: null });
        case 'Login':
          return Promise.resolve({
            status: 200,
            body: envelope('<LoginResponse/>'),
            setCookie: 'lcm=1',
          });
        case 'CreateContainerView':
          return Promise.resolve({ status: 200, body: createViewBody, setCookie: null });
        case 'RetrievePropertiesEx':
          return Promise.resolve({ status: 200, body: retrieveBody, setCookie: null });
        case 'DestroyView':
          return Promise.resolve({
            status: 200,
            body: envelope('<DestroyViewResponse/>'),
            setCookie: null,
          });
        case 'Logout':
          return Promise.resolve({
            status: 200,
            body: envelope('<LogoutResponse/>'),
            setCookie: null,
          });
        default:
          return Promise.reject(new Error(`unexpected SOAP action ${action}`));
      }
    };
  }

  interface CapturedWarn {
    details: Record<string, unknown>;
    message: string;
  }

  async function collectSynthetic(): Promise<{
    inventory: Awaited<ReturnType<VsphereClientInventoryCollector['collect']>>;
    warnings: CapturedWarn[];
  }> {
    const warnings: CapturedWarn[] = [];
    const logger: CollectorLogger = {
      warn: (details, message) => warnings.push({ details, message }),
    };
    const collector = new VsphereClientInventoryCollector({
      transport: syntheticTransport(),
      logger,
    });
    const inventory = await collector.collect({
      hostname: 'vcenter.example.test',
      username: 'svc-lcm',
      password: 'unused-by-the-synthetic-transport',
      pinnedRootPem: null,
    });
    return { inventory, warnings };
  }

  it('excludes a disconnected host and skips an unreadable one WITHOUT aborting the vCenter', async () => {
    // collect() resolving (not rejecting) is itself the fix: pre-change, host (c)'s
    // missing memory threw out of collect() and took the whole vCenter down.
    const { inventory } = await collectSynthetic();

    expect(inventory.instanceUuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(inventory.apiVersion).toBe('8.0.3.0');

    // Only host (a) survives — one cluster, one host.
    expect(inventory.clusters).toHaveLength(1);
    const cluster = inventory.clusters[0];
    expect(cluster?.moref).toBe('domain-c1');
    expect(cluster?.name).toBe('Production Cluster');

    const collectedHosts = inventory.clusters.flatMap((c) => c.hosts);
    expect(collectedHosts.map((h) => h.moref)).toEqual(['host-a']);

    // The disconnected host's advertised memory is NOT counted: the fleet total is
    // host (a) alone, base-2, not host (a)+host (b).
    const totalMemoryGiB = collectedHosts.reduce((sum, h) => sum + h.memoryGiB, 0);
    expect(totalMemoryGiB).toBeCloseTo(HOST_A_MEMORY_BYTES / 1024 ** 3, 5);
    expect(totalMemoryGiB).toBeCloseTo(collectedHosts[0]?.memoryGiB ?? 0, 10);
  });

  it('logs one WARN per excluded/skipped host and does not fire the drift warning', async () => {
    const { warnings } = await collectSynthetic();

    // Exactly two warnings: the disconnected exclusion and the unreadable skip. A
    // third (drift) warning here would mean the excluded host leaked into the sum.
    expect(warnings).toHaveLength(2);

    const disconnected = warnings.find((w) => w.details.host === 'host-b');
    expect(disconnected).toBeDefined();
    expect(disconnected?.message).toMatch(/disconnect/i);
    expect(disconnected?.details.connectionState).toBe('disconnected');
    expect(disconnected?.details.name).toBe('esx-b.example.test');

    const unreadable = warnings.find((w) => w.details.host === 'host-c');
    expect(unreadable).toBeDefined();
    expect(unreadable?.message).toMatch(/memory size/i);
    expect(unreadable?.details.name).toBe('esx-c.example.test');

    // None of the messages leaks a credential or trips the internal drift check.
    for (const { message } of warnings) {
      expect(message).not.toMatch(/drift/i);
      expect(message).not.toContain('unused-by-the-synthetic-transport');
    }
  });
});
