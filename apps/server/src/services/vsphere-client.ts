import { request as httpsRequest } from 'node:https';

import { XMLParser } from 'fast-xml-parser';

import { verifiedTlsOptions } from './vsphere-tls.js';

/**
 * A minimal vim25 SOAP client — just enough to prove a credential works and to
 * learn which vCenter we are talking to (#175, epic #172).
 *
 * @ai-context Why hand-rolled rather than a dependency: every vSphere-specific
 * npm package is abandoned (`node-vsphere-soap` 2015, `vsphere-connect` 2017),
 * there is no official Node SDK (VMware ships Java/Python/Go/.NET), and the one
 * maintained generic option (`soap`) is WSDL-driven — the vim25 WSDL is megabytes
 * and grew in 9.0, so it would be parsed at runtime to call three methods and
 * would still hand back untyped results we'd validate anyway.
 *
 * @ai-context Why SOAP rather than the nicer VI/JSON (8.0U1+, same object model
 * over JSON): `vcsim`, the only viable integration test double, does not implement
 * VI/JSON — verified against `simulator/simulator.go`. SOAP is the only protocol
 * both real vCenter (8.0U3 and 9.0) and the test double speak. The wire format is
 * kept behind this module so a future swap stays contained.
 *
 * Sessions are NOT kept alive: login → use → logout, every time. That sidesteps
 * keepalive, reconnect and session-leak handling entirely, costs nothing against a
 * multi-minute poll cadence, and holds the project's "server keeps no local state"
 * invariant — there is no session to lose across a restart.
 */

const REQUEST_TIMEOUT_MS = 15_000;

/** The well-known root MoRef. Stable across every vCenter version. */
const SERVICE_INSTANCE = 'ServiceInstance';

export type VsphereLoginOutcome =
  'ok' | 'unreachable' | 'tls_untrusted' | 'not_a_vcenter' | 'auth_failed';

export interface VsphereAbout {
  instanceUuid: string;
  apiVersion: string;
}

export interface VsphereLoginResult {
  outcome: VsphereLoginOutcome;
  about: VsphereAbout | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
});

function envelope(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:urn="urn:vim25"><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface SoapCallResult {
  status: number;
  body: string;
  setCookie: string | null;
}

export interface SoapCallOptions {
  /**
   * Cancellation token, threaded into `node:https` so an in-flight request is torn
   * down on abort (design §D21 — every vCenter call carries an `AbortSignal`). When
   * omitted the call is bounded only by `REQUEST_TIMEOUT_MS`.
   */
  signal?: AbortSignal;
  /**
   * Destination TCP port. Configurable per connection (#199), defaulting to 443.
   * This is a port number, not a TLS relaxation: `verifiedTlsOptions` keeps
   * `rejectUnauthorized: true` and the `ca:` root pin regardless of port.
   */
  port?: number;
}

/**
 * One vim25 SOAP call.
 *
 * Uses `node:https` rather than `fetch`/undici for one reason: it takes `ca` and
 * `rejectUnauthorized` per-request natively, so the trust anchor travels with the
 * call and no extra dependency is needed to express it.
 *
 * @ai-warning `verifiedTlsOptions` always sets `rejectUnauthorized: true` and has
 * no branch that relaxes it. Do not add an options parameter that could. The
 * `options.port` value (configurable per connection, #199) is a destination port
 * only — it cannot weaken trust. See `vsphere-tls.ts` for why the intuitive
 * `checkServerIdentity` alternative fails open.
 */
export async function soapCall(
  hostname: string,
  pinnedRootPem: string | null,
  action: string,
  body: string,
  cookie: string | null,
  options: SoapCallOptions = {},
): Promise<SoapCallResult> {
  const tls = verifiedTlsOptions(hostname, pinnedRootPem, options.port);
  const payload = envelope(body);

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: tls.host,
        port: tls.port,
        servername: tls.servername,
        rejectUnauthorized: tls.rejectUnauthorized,
        ...(tls.ca ? { ca: tls.ca } : {}),
        path: '/sdk',
        method: 'POST',
        timeout: REQUEST_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(payload),
          SOAPAction: `urn:vim25/${action}`,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        // A redirect is never followed: an allowed host must not be able to bounce
        // a credential-bearing request onward to a destination nobody vetted.
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            setCookie: res.headers['set-cookie']?.[0]?.split(';')[0] ?? null,
          }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', reject);
    req.end(payload);
  });
}

function classifyTransportError(err: unknown): VsphereLoginOutcome {
  const code =
    (err as { cause?: { code?: string }; code?: string })?.cause?.code ??
    (err as { code?: string })?.code ??
    '';
  // Certificate problems are worth distinguishing because they have a specific,
  // actionable remedy (confirm and pin the CA). Everything else collapses to
  // `unreachable`: telling "connection refused" from "timed out" from "no route"
  // is exactly what makes a scan oracle useful, and this endpoint is reachable
  // unauthenticated in the default auth mode.
  if (
    typeof code === 'string' &&
    (code.includes('CERT') || code.includes('SELF_SIGNED') || code.includes('ALTNAME'))
  ) {
    return 'tls_untrusted';
  }
  return 'unreachable';
}

/**
 * Verify a credential against vCenter and learn its identity.
 *
 * Returns `instanceUuid`, which is the one field that makes cross-vCenter
 * corruption detectable: MoRefs are unique only WITHIN a vCenter, so if a
 * hostname is ever re-pointed, `domain-c123` at the new target is a different
 * cluster entirely and sync would overwrite the wrong one's capacity.
 *
 * @ai-warning `password` is used and discarded. It must never be logged, stored
 * outside `secret-box`, or placed in an error message — including a sanitized one.
 */
export async function verifyLogin(input: {
  hostname: string;
  port?: number;
  username: string;
  password: string;
  pinnedRootPem: string | null;
}): Promise<VsphereLoginResult> {
  // Scoped to this call by construction: login, use, logout. No session outlives
  // the function, so there is nothing to leak across a restart and nothing to
  // keep alive.
  let cookie: string | null = null;
  // Built conditionally: under exactOptionalPropertyTypes, `{ port: undefined }` is
  // not assignable to `port?: number`. Omitting the key lets the collector default it.
  const callOptions = input.port !== undefined ? { port: input.port } : {};

  try {
    // 1. RetrieveServiceContent — unauthenticated, and it yields both the
    //    SessionManager MoRef and `about`, so it doubles as the "is this actually
    //    a vCenter?" check before any credential is sent.
    const contentRes = await soapCall(
      input.hostname,
      input.pinnedRootPem,
      'RetrieveServiceContent',
      `<urn:RetrieveServiceContent><urn:_this type="ServiceInstance">${SERVICE_INSTANCE}</urn:_this></urn:RetrieveServiceContent>`,
      null,
      callOptions,
    );
    if (contentRes.status !== 200) return { outcome: 'not_a_vcenter', about: null };

    const parsed = parser.parse(contentRes.body) as Record<string, unknown>;
    const about = extractAbout(parsed);
    const sessionManager = extractSessionManager(parsed);
    if (!about || !sessionManager) return { outcome: 'not_a_vcenter', about: null };

    // 2. Login. THIS is the call that transmits the credential, which is why the
    //    connection above must already be verified — and why the probe that
    //    captures an untrusted certificate is a separate endpoint that sends
    //    nothing.
    const loginRes = await soapCall(
      input.hostname,
      input.pinnedRootPem,
      'Login',
      `<urn:Login><urn:_this type="SessionManager">${escapeXml(sessionManager)}</urn:_this><urn:userName>${escapeXml(input.username)}</urn:userName><urn:password>${escapeXml(input.password)}</urn:password></urn:Login>`,
      cookie,
      callOptions,
    );
    if (loginRes.status !== 200) return { outcome: 'auth_failed', about: null };
    cookie = loginRes.setCookie;

    // 3. Log out immediately — no session is kept.
    await soapCall(
      input.hostname,
      input.pinnedRootPem,
      'Logout',
      `<urn:Logout><urn:_this type="SessionManager">${escapeXml(sessionManager)}</urn:_this></urn:Logout>`,
      cookie,
      callOptions,
    ).catch(() => undefined);

    return { outcome: 'ok', about };
  } catch (err) {
    return { outcome: classifyTransportError(err), about: null };
  }
}

/** Parse a SOAP response body with the module's namespace-stripping XML parser. */
export function parseSoap(body: string): unknown {
  return parser.parse(body) as unknown;
}

/**
 * Depth-first search for the first value under `key`, ignoring namespace nesting.
 * The vim25 envelope wraps every payload in `Envelope > Body > *Response`, and the
 * property names we want (`about`, `returnval`, `token`, …) are unique within a
 * response — so a keyed walk is simpler and more robust than hard-coding the path.
 */
export function walk(node: unknown, key: string): unknown {
  if (node === null || typeof node !== 'object') return undefined;
  const record = node as Record<string, unknown>;
  if (key in record) return record[key];
  for (const value of Object.values(record)) {
    const found = walk(value, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function extractAbout(parsed: unknown): VsphereAbout | null {
  const about = walk(parsed, 'about');
  if (!about || typeof about !== 'object') return null;
  const record = about as Record<string, unknown>;
  const instanceUuid = record.instanceUuid;
  const apiVersion = record.apiVersion;
  if (typeof instanceUuid !== 'string' || typeof apiVersion !== 'string') return null;
  return { instanceUuid, apiVersion };
}

function extractSessionManager(parsed: unknown): string | null {
  const sm = walk(parsed, 'sessionManager');
  if (typeof sm === 'string') return sm;
  if (sm && typeof sm === 'object') {
    const text = (sm as Record<string, unknown>)['#text'];
    if (typeof text === 'string') return text;
  }
  return null;
}
