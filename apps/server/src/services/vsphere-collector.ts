import {
  escapeXml,
  parseSoap,
  soapCall,
  walk,
  type SoapCallOptions,
  type SoapCallResult,
} from './vsphere-client.js';
import {
  bytesToGiB,
  mibToGiB,
  type CollectedCluster,
  type CollectedHost,
  type CollectedInventory,
  type VsphereInventoryCollector,
} from './vsphere-inventory.js';

/**
 * The production `VsphereInventoryCollector` — a PropertyCollector read over vim25
 * (#190, epic #172, design §D2/§D3a/§D11).
 *
 * Per collect, one session, no keepalive:
 *   RetrieveServiceContent → Login → CreateContainerView(rootFolder,
 *   ["HostSystem","ComputeResource"], recursive) → RetrievePropertiesEx +
 *   ContinueRetrievePropertiesEx while a token is returned → DestroyView → Logout.
 *
 * Three things here are load-bearing and each is silent when wrong:
 *
 * 1. **The continue-loop.** `RetrievePropertiesEx` returns at most `maxObjects` per
 *    page plus a token; large fleets paginate. A missing continue-loop truncates
 *    the host list — i.e. under-counts fleet capacity, in a forecast that buys
 *    hardware. The loop runs until no token is returned.
 *
 * 2. **Units convert here and only here** (design §D3a). `memorySize` is bytes,
 *    `overallMemoryUsage` is MiB (its documented "MB" is a lie), LCM stores GiB —
 *    all base-2. Never read `ComputeResourceSummary.effectiveMemory`: it is a
 *    different unit beside `totalMemory` and vcsim populates it wrongly, so a bug
 *    there is invisible to tests and 1,048,576× wrong in production. Capacity is
 *    the sum of per-host `summary.hardware.memorySize`.
 *
 * 3. **Hosts are grouped by their `parent`, not by ClusterComputeResource.** A
 *    standalone ESXi host's parent is a plain `ComputeResource` (`domain-sNN`), not
 *    a cluster; grouping only by cluster would silently drop it — another capacity
 *    under-count. The container view is created over `ComputeResource` (which
 *    matches the `ClusterComputeResource` subtype), and every host lands under its
 *    parent compute resource, standalone or clustered.
 *
 * 4. **Host inclusion is a product policy, not an accident** (design §D3 rule 1c,
 *    owner-approved 2026-07-17). A host whose `runtime.connectionState` is not
 *    `connected` is EXCLUDED by policy — a disconnected host (racked-but-never-
 *    connected is a normal infra state) provides no live capacity, so counting its
 *    memory would be wrong and its absence must not be counted as loss. A host that
 *    IS connected but whose `summary.hardware.memorySize` is missing is an anomaly:
 *    that one host is SKIPPED. Both cases log a WARN and let the REST of the vCenter
 *    collect — never throw, because a single bad host must not abort the whole
 *    vCenter's sync (and its message would be mis-classified as an unreachable
 *    NETWORK failure by `VsphereSyncService.classify()`, disguising a data problem
 *    as an outage). Connected, readable hosts still sum `memorySize` exactly.
 *
 * @ai-warning Thrown messages are matched by `VsphereSyncService.classify()`
 * (`/auth|login|credential/i` BEFORE `/cert|tls|self.signed/i`) and rendered by
 * `sanitize()` into `lastError`. They MUST be credential-free and MUST NOT name a
 * SOAP action — a TLS failure raised mid-`Login` whose message contained "login"
 * would be mis-reported as an auth failure. Transport (TLS/socket) errors are left
 * to propagate verbatim so their native codes classify correctly; only an
 * authentication rejection is re-thrown, deliberately worded to match `/credential/`.
 */

const SERVICE_INSTANCE = 'ServiceInstance';

/**
 * Objects per `RetrievePropertiesEx` page. Bounds peak memory on large fleets and
 * exercises the continue-loop above ~100 managed objects. Not the vCenter default
 * (unbounded); a smaller page is only correct because the continue-loop is.
 */
const DEFAULT_MAX_OBJECTS = 100;

/** The transport seam — the real `soapCall` in production, a spy in tests. */
export type SoapTransport = (
  hostname: string,
  pinnedRootPem: string | null,
  action: string,
  body: string,
  cookie: string | null,
  options?: SoapCallOptions,
) => Promise<SoapCallResult>;

/** Where the per-cluster memory-drift warning goes (pino-shaped). */
export interface CollectorLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface VsphereCollectorOptions {
  /** Overridden in tests to force pagination; production uses {@link DEFAULT_MAX_OBJECTS}. */
  maxObjects?: number;
  /** Injected transport for tests (counts/observes SOAP calls); defaults to `soapCall`. */
  transport?: SoapTransport;
  /** Structured sink for the `Σ memorySize != totalMemory` drift warning; defaults to no-op. */
  logger?: CollectorLogger;
}

interface ServiceContent {
  instanceUuid: string;
  apiVersion: string;
  sessionManager: string;
  viewManager: string;
  propertyCollector: string;
  rootFolder: string;
}

interface RawHost {
  moref: string;
  name: string;
  parentMoref: string;
  memoryBytes: number;
  usageMib: number | null;
  inMaintenanceMode: boolean;
  connected: boolean;
}

interface RawComputeResource {
  moref: string;
  name: string;
  totalMemoryBytes: number | null;
}

const noopLogger: CollectorLogger = { warn: () => undefined };

export class VsphereClientInventoryCollector implements VsphereInventoryCollector {
  private readonly maxObjects: number;
  private readonly transport: SoapTransport;
  private readonly logger: CollectorLogger;

  constructor(options: VsphereCollectorOptions = {}) {
    this.maxObjects = options.maxObjects ?? DEFAULT_MAX_OBJECTS;
    this.transport = options.transport ?? soapCall;
    this.logger = options.logger ?? noopLogger;
  }

  async collect(
    input: {
      hostname: string;
      username: string;
      password: string;
      pinnedRootPem: string | null;
      port?: number;
    },
    signal?: AbortSignal,
  ): Promise<CollectedInventory> {
    const { hostname, username, password, pinnedRootPem } = input;
    const call = (action: string, body: string, cookie: string | null): Promise<SoapCallResult> => {
      const options: SoapCallOptions = {};
      if (signal) options.signal = signal;
      if (input.port !== undefined) options.port = input.port;
      return this.transport(hostname, pinnedRootPem, action, body, cookie, options);
    };

    // 1. RetrieveServiceContent — unauthenticated; yields identity + the MoRefs the
    //    rest of the sequence needs. A transport failure here (TLS distrust, refused
    //    connection) propagates verbatim and is classified by its native error code.
    const contentRes = await call(
      'RetrieveServiceContent',
      `<urn:RetrieveServiceContent><urn:_this type="ServiceInstance">${SERVICE_INSTANCE}</urn:_this></urn:RetrieveServiceContent>`,
      null,
    );
    if (contentRes.status !== 200) {
      throw new Error('vCenter did not return a valid service response.');
    }
    const content = extractServiceContent(parseSoap(contentRes.body));

    // 2. Login — the only call that transmits the credential, which is why the
    //    connection was verified above. A rejection is re-thrown with a message
    //    worded to classify as an auth failure (never naming the SOAP action).
    const loginRes = await call(
      'Login',
      `<urn:Login><urn:_this type="SessionManager">${escapeXml(content.sessionManager)}</urn:_this><urn:userName>${escapeXml(username)}</urn:userName><urn:password>${escapeXml(password)}</urn:password></urn:Login>`,
      null,
    );
    if (loginRes.status !== 200) {
      throw new Error('vCenter rejected the credentials.');
    }
    const cookie = loginRes.setCookie;

    try {
      const viewRes = await call(
        'CreateContainerView',
        `<urn:CreateContainerView><urn:_this type="ViewManager">${escapeXml(content.viewManager)}</urn:_this><urn:container type="Folder">${escapeXml(content.rootFolder)}</urn:container><urn:type>HostSystem</urn:type><urn:type>ComputeResource</urn:type><urn:recursive>true</urn:recursive></urn:CreateContainerView>`,
        cookie,
      );
      if (viewRes.status !== 200) {
        throw new Error('vCenter returned an unexpected response.');
      }
      const view = textOf(walk(parseSoap(viewRes.body), 'returnval'));
      if (view === null) {
        throw new Error('vCenter returned an unexpected response.');
      }

      try {
        const objects = await this.retrieveAll(call, content.propertyCollector, view, cookie);
        return this.buildInventory(content, objects);
      } finally {
        // Best-effort teardown; a cleanup failure must not mask the real result.
        await call(
          'DestroyView',
          `<urn:DestroyView><urn:_this type="ContainerView">${escapeXml(view)}</urn:_this></urn:DestroyView>`,
          cookie,
        ).catch(() => undefined);
      }
    } finally {
      // Session dies with the call — no keepalive, nothing to leak across a restart.
      await call(
        'Logout',
        `<urn:Logout><urn:_this type="SessionManager">${escapeXml(content.sessionManager)}</urn:_this></urn:Logout>`,
        cookie,
      ).catch(() => undefined);
    }
  }

  /**
   * `RetrievePropertiesEx` then `ContinueRetrievePropertiesEx` until no token is
   * returned. This loop is the whole point of the issue: without it, a fleet larger
   * than one page is silently truncated.
   */
  private async retrieveAll(
    call: (action: string, body: string, cookie: string | null) => Promise<SoapCallResult>,
    propertyCollector: string,
    view: string,
    cookie: string | null,
  ): Promise<unknown[]> {
    const first = await call(
      'RetrievePropertiesEx',
      retrieveBody(propertyCollector, view, this.maxObjects),
      cookie,
    );
    if (first.status !== 200) {
      throw new Error('vCenter returned an unexpected response.');
    }

    let page = extractRetrieveResult(parseSoap(first.body));
    const objects: unknown[] = [...page.objects];
    let token = page.token;

    while (token !== null) {
      const next = await call(
        'ContinueRetrievePropertiesEx',
        `<urn:ContinueRetrievePropertiesEx><urn:_this type="PropertyCollector">${escapeXml(propertyCollector)}</urn:_this><urn:token>${escapeXml(token)}</urn:token></urn:ContinueRetrievePropertiesEx>`,
        cookie,
      );
      if (next.status !== 200) {
        throw new Error('vCenter returned an unexpected response.');
      }
      page = extractRetrieveResult(parseSoap(next.body));
      objects.push(...page.objects);
      token = page.token;
    }

    return objects;
  }

  private buildInventory(content: ServiceContent, objects: unknown[]): CollectedInventory {
    const hosts: RawHost[] = [];
    const computeResources = new Map<string, RawComputeResource>();

    for (const object of objects) {
      const record = asRecord(object);
      if (!record) continue;
      const moref = textOf(record['obj']);
      const type = typeOf(record['obj']);
      if (moref === null || type === null) continue;
      const props = propMap(record['propSet']);

      if (type === 'HostSystem') {
        // Policy (§D3 rule 1c): disconnected hosts are excluded and connected-but-
        // unreadable hosts are skipped — both return null, so only live, readable
        // hosts enter the sum. Skipping here (not in the group loop) keeps the drift
        // check below consistent with what was actually counted.
        const host = this.readHost(moref, props);
        if (host !== null) hosts.push(host);
      } else {
        // ComputeResource and its ClusterComputeResource subtype both land here.
        computeResources.set(moref, {
          moref,
          name: textOf(props.get('name')) ?? moref,
          totalMemoryBytes: numOf(props.get('summary.totalMemory')),
        });
      }
    }

    // Group every host under its parent compute resource — standalone or clustered.
    const hostsByParent = new Map<string, RawHost[]>();
    for (const host of hosts) {
      const group = hostsByParent.get(host.parentMoref);
      if (group) group.push(host);
      else hostsByParent.set(host.parentMoref, [host]);
    }

    const clusters: CollectedCluster[] = [];
    for (const [parentMoref, group] of hostsByParent) {
      const cr = computeResources.get(parentMoref);
      const collectedHosts = group.map(toCollectedHost);

      // Drift check (design §D3 rule 2): the sum of per-host memory must equal the
      // compute resource's reported total. A mismatch means our capacity number
      // disagrees with vCenter's own aggregate — surface it, but never block the
      // sync on it, and never grow the interface to carry it (kept internal).
      // `group` already contains only the INCLUDED hosts (disconnected/unreadable
      // hosts were filtered out in the object loop), so the sum matches what was
      // counted — an excluded host never trips this warning (§D3 rule 1c).
      if (cr?.totalMemoryBytes != null) {
        const sumBytes = group.reduce((acc, h) => acc + h.memoryBytes, 0);
        if (sumBytes !== cr.totalMemoryBytes) {
          this.logger.warn(
            {
              cluster: parentMoref,
              name: cr.name,
              summedHostBytes: sumBytes,
              reportedTotalBytes: cr.totalMemoryBytes,
            },
            'vCenter cluster memory drift: summed host memory does not equal reported total',
          );
        }
      }

      clusters.push({
        moref: parentMoref,
        name: cr?.name ?? parentMoref,
        hosts: collectedHosts,
      });
    }

    return {
      instanceUuid: content.instanceUuid,
      apiVersion: content.apiVersion,
      clusters,
    };
  }

  /**
   * Read one host, applying the inclusion policy (§D3 rule 1c, owner-approved
   * 2026-07-17). Returns `null` — never throws — for a host that must not be
   * counted, so a single bad host cannot abort the whole vCenter's collection:
   *
   *   - **Disconnected** (`runtime.connectionState !== 'connected'`): EXCLUDED. A
   *     disconnected host provides no live capacity; counting its memory would be
   *     wrong. WARN naming the host and the connection state.
   *   - **Connected but no readable `memorySize`**: SKIPPED as an anomaly. Refuse to
   *     invent a capacity number — defaulting to 0 would under-count the fleet, the
   *     exact failure this collector exists to prevent — but skip only this one host
   *     with a WARN rather than throwing and taking the whole vCenter down.
   *
   * A connected, readable host is summed exactly as before.
   */
  private readHost(moref: string, props: Map<string, unknown>): RawHost | null {
    const connectionState = textOf(props.get('runtime.connectionState'));
    const connected = connectionState === 'connected';
    const name = textOf(props.get('name')) ?? moref;

    if (!connected) {
      this.logger.warn(
        { host: moref, name, connectionState: connectionState ?? 'unknown' },
        'Excluding disconnected vCenter host from capacity (no live memory to count)',
      );
      return null;
    }

    const memoryBytes = numOf(props.get('summary.hardware.memorySize'));
    if (memoryBytes === null) {
      this.logger.warn(
        { host: moref, name },
        'Skipping connected vCenter host with no readable memory size',
      );
      return null;
    }

    const parentMoref = textOf(props.get('parent'));
    if (parentMoref === null) {
      throw new Error('vCenter returned a host without a parent.');
    }
    return {
      moref,
      name,
      parentMoref,
      memoryBytes,
      usageMib: numOf(props.get('summary.quickStats.overallMemoryUsage')),
      inMaintenanceMode: textOf(props.get('runtime.inMaintenanceMode')) === 'true',
      connected,
    };
  }
}

function toCollectedHost(host: RawHost): CollectedHost {
  return {
    moref: host.moref,
    name: host.name,
    memoryGiB: bytesToGiB(host.memoryBytes),
    usageGiB: host.usageMib === null ? null : mibToGiB(host.usageMib),
    inMaintenanceMode: host.inMaintenanceMode,
    connected: host.connected,
  };
}

interface RetrieveResult {
  objects: unknown[];
  token: string | null;
}

function extractRetrieveResult(parsed: unknown): RetrieveResult {
  const returnval = walk(parsed, 'returnval');
  const record = asRecord(returnval);
  if (!record) return { objects: [], token: null };
  const token = typeof record['token'] === 'string' ? record['token'] : null;
  return { objects: asArray(record['objects']), token };
}

function extractServiceContent(parsed: unknown): ServiceContent {
  const about = asRecord(walk(parsed, 'about'));
  const instanceUuid = about ? about['instanceUuid'] : undefined;
  const apiVersion = about ? about['apiVersion'] : undefined;
  const sessionManager = textOf(walk(parsed, 'sessionManager'));
  const viewManager = textOf(walk(parsed, 'viewManager'));
  const propertyCollector = textOf(walk(parsed, 'propertyCollector'));
  const rootFolder = textOf(walk(parsed, 'rootFolder'));

  if (
    typeof instanceUuid !== 'string' ||
    typeof apiVersion !== 'string' ||
    sessionManager === null ||
    viewManager === null ||
    propertyCollector === null ||
    rootFolder === null
  ) {
    throw new Error('vCenter did not return a valid service response.');
  }
  return { instanceUuid, apiVersion, sessionManager, viewManager, propertyCollector, rootFolder };
}

function retrieveBody(propertyCollector: string, view: string, maxObjects: number): string {
  return (
    `<urn:RetrievePropertiesEx>` +
    `<urn:_this type="PropertyCollector">${escapeXml(propertyCollector)}</urn:_this>` +
    `<urn:specSet>` +
    `<urn:propSet><urn:type>HostSystem</urn:type>` +
    `<urn:pathSet>name</urn:pathSet>` +
    `<urn:pathSet>parent</urn:pathSet>` +
    `<urn:pathSet>summary.hardware.memorySize</urn:pathSet>` +
    `<urn:pathSet>summary.quickStats.overallMemoryUsage</urn:pathSet>` +
    `<urn:pathSet>runtime.inMaintenanceMode</urn:pathSet>` +
    `<urn:pathSet>runtime.connectionState</urn:pathSet>` +
    `</urn:propSet>` +
    `<urn:propSet><urn:type>ComputeResource</urn:type>` +
    `<urn:pathSet>name</urn:pathSet><urn:pathSet>summary.totalMemory</urn:pathSet></urn:propSet>` +
    `<urn:propSet><urn:type>ClusterComputeResource</urn:type>` +
    `<urn:pathSet>name</urn:pathSet><urn:pathSet>summary.totalMemory</urn:pathSet></urn:propSet>` +
    `<urn:objectSet>` +
    `<urn:obj type="ContainerView">${escapeXml(view)}</urn:obj>` +
    `<urn:skip>true</urn:skip>` +
    `<urn:selectSet xsi:type="urn:TraversalSpec">` +
    `<urn:type>ContainerView</urn:type><urn:path>view</urn:path><urn:skip>false</urn:skip>` +
    `</urn:selectSet>` +
    `</urn:objectSet>` +
    `</urn:specSet>` +
    `<urn:options><urn:maxObjects>${maxObjects}</urn:maxObjects></urn:options>` +
    `</urn:RetrievePropertiesEx>`
  );
}

// --- parse helpers: fast-xml-parser yields `#text`/`@_type`, and a single child is
//     an object while multiple children are an array — coerce both defensively. ---

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  if (record && typeof record['#text'] === 'string') return record['#text'];
  return null;
}

function typeOf(value: unknown): string | null {
  const record = asRecord(value);
  if (record && typeof record['@_type'] === 'string') return record['@_type'];
  return null;
}

function numOf(value: unknown): number | null {
  const text = textOf(value);
  if (text === null) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function propMap(propSet: unknown): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const entry of asArray(propSet)) {
    const record = asRecord(entry);
    if (!record) continue;
    const name = record['name'];
    if (typeof name === 'string') map.set(name, record['val']);
  }
  return map;
}
