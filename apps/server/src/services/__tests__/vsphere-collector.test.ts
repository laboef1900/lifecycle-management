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
