import type {
  VsphereConnectionCreate,
  VsphereConnectionUpdate,
  VsphereProbe,
  VsphereTrustCa,
  VsphereVerify,
  ApiErrorBody,
  AuthConfigTest,
  AuthConfigUpdate,
  ClusterSettingsInput,
  CreateLocalUser,
  ResetPassword,
  TenantSettings,
  UpdateLocalUser,
} from '@lcm/shared';
import {
  vsphereConnectionResponseSchema,
  vsphereProbeResultSchema,
  vsphereVerifyResultSchema,
  authConfigResponseSchema,
  authConfigTestResultSchema,
  capacityRowInputSchema,
  categoryResponseSchema,
  clusterCreateInputSchema,
  clusterResponseSchema,
  clusterSettingsResponseSchema,
  clusterUpdateInputSchema,
  forecastResponseSchema,
  hostCreateInputSchema,
  hostLifecycleEventResponseSchema,
  hostReplacementCreateInputSchema,
  hostReplacementResponseSchema,
  hostResponseSchema,
  hostTransitionInputSchema,
  hostUpdateInputSchema,
  isApiErrorBody,
  itemAllocationRowInputSchema,
  itemCreateInputSchema,
  itemResponseSchema,
  itemUpdateInputSchema,
  localUserSummarySchema,
  paginatedSchema,
  rotateSigningSecretResponseSchema,
  scenarioSchema,
  tenantSettingsResponseSchema,
} from '@lcm/shared';
import { z } from 'zod';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.error.code;
    this.details = body.error.details;
  }
}

async function request<T>(path: string, init?: RequestInit, schema?: z.ZodType<T>): Promise<T> {
  // Only advertise a JSON body when we actually send one — Fastify rejects
  // requests that declare content-type: application/json but have an empty
  // body (e.g. a bodyless DELETE).
  const hasBody = init?.body !== undefined && init.body !== null;
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...((init?.headers ?? {}) as Record<string, string>),
  };
  if (hasBody && !('content-type' in headers) && !('Content-Type' in headers)) {
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers,
  });

  // Session expired or missing: bounce to the login page. The ApiError below
  // still throws so in-flight callers settle deterministically.
  if (response.status === 401 && !window.location.pathname.startsWith('/login')) {
    window.location.assign('/login');
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  const body = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;

  if (!response.ok) {
    if (isApiErrorBody(body)) {
      throw new ApiError(response.status, body);
    }
    throw new ApiError(response.status, {
      error: { code: 'UNKNOWN', message: response.statusText || 'Request failed' },
    });
  }

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
}

/** Human-readable message for a failed API call: the server's message when available. */
export function describeApiError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Local admin login: POSTs username/password to the local-auth endpoint. On
 * success the server sets the session cookie and responds 204; any other
 * status (401 bad credentials, etc.) resolves to false rather than throwing,
 * so the caller can show one generic "invalid credentials" message without
 * distinguishing wrong-username from wrong-password.
 */
export async function localLogin(username: string, password: string): Promise<boolean> {
  const res = await fetch('/api/auth/local/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return res.status === 204;
}

// ---------- Wire body types ----------

// Derived directly from the shared input schemas via `z.input`, which yields the
// PRE-transform (wire) shape — e.g. `dateOnly`/`monthOnly` are `string` on input
// but `Date` after parsing. This keeps the request bodies in lockstep with the
// server's Zod contracts instead of hand-maintaining parallel types.
export type ScenarioWire = z.input<typeof scenarioSchema>;
export type ClusterCreateInputWire = z.input<typeof clusterCreateInputSchema>;
export type ClusterUpdateInputWire = z.input<typeof clusterUpdateInputSchema>;
export type HostCreateInputWire = z.input<typeof hostCreateInputSchema>;
export type HostUpdateInputWire = z.input<typeof hostUpdateInputSchema>;
export type CapacityAppendInputWire = z.input<typeof capacityRowInputSchema>;
export type ItemCreateInputWire = z.input<typeof itemCreateInputSchema>;
export type ItemUpdateInputWire = z.input<typeof itemUpdateInputSchema>;
export type ItemAllocationAppendInputWire = z.input<typeof itemAllocationRowInputSchema>;
export type HostTransitionInputWire = z.input<typeof hostTransitionInputSchema>;
export type HostReplacementCreateInputWire = z.input<typeof hostReplacementCreateInputSchema>;

// ---------- Query string helper ----------

/** Builds a leading-`?` query string from a params object, skipping undefined/false values. */
function listQuery(params?: Record<string, string | number | boolean | undefined>): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== false) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

// ---------- API surface ----------

export const api = {
  clusters: {
    list: (params?: { includeArchived?: boolean; limit?: number; offset?: number }) =>
      request(
        `/api/clusters${listQuery(params)}`,
        undefined,
        paginatedSchema(clusterResponseSchema),
      ),
    get: (id: string) => request(`/api/clusters/${id}`, undefined, clusterResponseSchema),
    create: (input: ClusterCreateInputWire) =>
      request(
        '/api/clusters',
        { method: 'POST', body: JSON.stringify(input) },
        clusterResponseSchema,
      ),
    update: (id: string, input: ClusterUpdateInputWire) =>
      request(
        `/api/clusters/${id}`,
        { method: 'PUT', body: JSON.stringify(input) },
        clusterResponseSchema,
      ),
    delete: (id: string) => request<void>(`/api/clusters/${id}`, { method: 'DELETE' }),
    archive: (id: string) =>
      request(`/api/clusters/${id}/archive`, { method: 'POST' }, clusterResponseSchema),
    unarchive: (id: string) =>
      request(`/api/clusters/${id}/unarchive`, { method: 'POST' }, clusterResponseSchema),
    forecast: (id: string, params: { metric: string; from?: string; to?: string }) => {
      const search = new URLSearchParams({ metric: params.metric });
      if (params.from) search.set('from', params.from);
      if (params.to) search.set('to', params.to);
      return request(
        `/api/clusters/${id}/forecast?${search.toString()}`,
        undefined,
        forecastResponseSchema,
      );
    },
    forecastScenario: (
      id: string,
      params: { metric: string; from?: string; to?: string },
      scenario: ScenarioWire,
    ) => {
      const search = new URLSearchParams({ metric: params.metric });
      if (params.from) search.set('from', params.from);
      if (params.to) search.set('to', params.to);
      return request(
        `/api/clusters/${id}/forecast/scenario?${search.toString()}`,
        { method: 'POST', body: JSON.stringify(scenario) },
        forecastResponseSchema,
      );
    },
  },
  hosts: {
    listByCluster: (clusterId: string, params?: { limit?: number; offset?: number }) =>
      request(
        `/api/clusters/${clusterId}/hosts${listQuery(params)}`,
        undefined,
        paginatedSchema(hostResponseSchema),
      ),
    create: (clusterId: string, input: HostCreateInputWire) =>
      request(
        `/api/clusters/${clusterId}/hosts`,
        { method: 'POST', body: JSON.stringify(input) },
        hostResponseSchema,
      ),
    update: (id: string, input: HostUpdateInputWire) =>
      request(
        `/api/hosts/${id}`,
        { method: 'PUT', body: JSON.stringify(input) },
        hostResponseSchema,
      ),
    appendCapacity: (id: string, input: CapacityAppendInputWire) =>
      request(
        `/api/hosts/${id}/capacity`,
        { method: 'POST', body: JSON.stringify(input) },
        hostResponseSchema,
      ),
    delete: (id: string) => request<void>(`/api/hosts/${id}`, { method: 'DELETE' }),
    transition: (id: string, input: HostTransitionInputWire) =>
      request<void>(`/api/hosts/${id}/transitions`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    listLifecycle: (id: string) =>
      request(`/api/hosts/${id}/lifecycle`, undefined, z.array(hostLifecycleEventResponseSchema)),
  },
  hostReplacements: {
    create: (input: HostReplacementCreateInputWire) =>
      request(
        '/api/host-replacements',
        { method: 'POST', body: JSON.stringify(input) },
        hostReplacementResponseSchema,
      ),
    delete: (id: string) => request<void>(`/api/host-replacements/${id}`, { method: 'DELETE' }),
  },
  items: {
    listByCluster: (clusterId: string, params?: { limit?: number; offset?: number }) =>
      request(
        `/api/clusters/${clusterId}/items${listQuery(params)}`,
        undefined,
        paginatedSchema(itemResponseSchema),
      ),
    create: (clusterId: string, input: ItemCreateInputWire) =>
      request(
        `/api/clusters/${clusterId}/items`,
        { method: 'POST', body: JSON.stringify(input) },
        itemResponseSchema,
      ),
    update: (id: string, input: ItemUpdateInputWire) =>
      request(
        `/api/items/${id}`,
        { method: 'PATCH', body: JSON.stringify(input) },
        itemResponseSchema,
      ),
    appendAllocation: (id: string, input: ItemAllocationAppendInputWire) =>
      request(
        `/api/items/${id}/allocations`,
        { method: 'POST', body: JSON.stringify(input) },
        itemResponseSchema,
      ),
    delete: (id: string) => request<void>(`/api/items/${id}`, { method: 'DELETE' }),
  },
  settings: {
    categories: {
      list: () => request('/api/settings/categories', undefined, z.array(categoryResponseSchema)),
      create: (name: string) =>
        request(
          '/api/settings/categories',
          { method: 'POST', body: JSON.stringify({ name }) },
          categoryResponseSchema,
        ),
      delete: (id: string) => request<void>(`/api/settings/categories/${id}`, { method: 'DELETE' }),
    },
    tenant: {
      get: () => request('/api/settings/tenant', undefined, tenantSettingsResponseSchema),
      update: (input: TenantSettings) =>
        request(
          '/api/settings/tenant',
          { method: 'PUT', body: JSON.stringify(input) },
          tenantSettingsResponseSchema,
        ),
    },
    cluster: {
      get: (id: string) =>
        request(`/api/clusters/${id}/settings`, undefined, clusterSettingsResponseSchema),
      update: (id: string, input: ClusterSettingsInput) =>
        request(
          `/api/clusters/${id}/settings`,
          { method: 'PUT', body: JSON.stringify(input) },
          clusterSettingsResponseSchema,
        ),
      reset: (id: string) =>
        request(
          `/api/clusters/${id}/settings`,
          { method: 'DELETE' },
          clusterSettingsResponseSchema,
        ),
    },
    // authConfigUpdateSchema/authConfigTestSchema have no Date fields (all
    // strings/enums/numbers/booleans), so the Zod-inferred types are already
    // the wire shape — no *Wire translation type needed here.
    vsphere: {
      connections: {
        list: () =>
          request(
            '/api/settings/vsphere/connections',
            undefined,
            z.array(vsphereConnectionResponseSchema),
          ),
        create: (input: VsphereConnectionCreate) =>
          request(
            '/api/settings/vsphere/connections',
            { method: 'POST', body: JSON.stringify(input) },
            vsphereConnectionResponseSchema,
          ),
        update: (id: string, input: VsphereConnectionUpdate) =>
          request(
            `/api/settings/vsphere/connections/${id}`,
            { method: 'PUT', body: JSON.stringify(input) },
            vsphereConnectionResponseSchema,
          ),
        remove: (id: string) =>
          request(`/api/settings/vsphere/connections/${id}`, { method: 'DELETE' }, z.void()),
        trustCa: (id: string, input: VsphereTrustCa) =>
          request(
            `/api/settings/vsphere/connections/${id}/trust-ca`,
            { method: 'POST', body: JSON.stringify(input) },
            vsphereConnectionResponseSchema,
          ),
      },
      // Phase 1: reachability + certificate capture. Sends NO credential.
      probe: (input: VsphereProbe) =>
        request(
          '/api/settings/vsphere/probe',
          { method: 'POST', body: JSON.stringify(input) },
          vsphereProbeResultSchema,
        ),
      // Phase 2: verify the credential. The password is required by the contract
      // and there is no stored fallback — see packages/shared/src/schemas/vsphere.ts.
      verify: (input: VsphereVerify) =>
        request(
          '/api/settings/vsphere/verify',
          { method: 'POST', body: JSON.stringify(input) },
          vsphereVerifyResultSchema,
        ),
    },
    auth: {
      get: () => request('/api/settings/auth', undefined, authConfigResponseSchema),
      update: (input: AuthConfigUpdate) =>
        request(
          '/api/settings/auth',
          { method: 'PUT', body: JSON.stringify(input) },
          authConfigResponseSchema,
        ),
      test: (input: AuthConfigTest) =>
        request(
          '/api/settings/auth/test',
          { method: 'POST', body: JSON.stringify(input) },
          authConfigTestResultSchema,
        ),
      rotateSigningSecret: () =>
        request(
          '/api/settings/auth/rotate-signing-secret',
          { method: 'POST' },
          rotateSigningSecretResponseSchema,
        ),
      // Local admin accounts (mode: 'local', plus break-glass access while
      // mode is 'oidc'). Scoped separately from oidc/get/update/test above.
      localUsers: {
        list: () =>
          request('/api/settings/auth/local-users', undefined, z.array(localUserSummarySchema)),
        create: (input: CreateLocalUser) =>
          request(
            '/api/settings/auth/local-users',
            { method: 'POST', body: JSON.stringify(input) },
            localUserSummarySchema,
          ),
        setDisabled: (id: string, disabled: boolean) =>
          request<void>(`/api/settings/auth/local-users/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ disabled } satisfies UpdateLocalUser),
          }),
        resetPassword: (id: string, newPassword: string) =>
          request<void>(`/api/settings/auth/local-users/${id}/reset-password`, {
            method: 'POST',
            body: JSON.stringify({ newPassword } satisfies ResetPassword),
          }),
        delete: (id: string) =>
          request<void>(`/api/settings/auth/local-users/${id}`, { method: 'DELETE' }),
      },
    },
  },
};
