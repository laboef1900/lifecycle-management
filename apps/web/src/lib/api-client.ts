import type {
  AuthConfigTest,
  AuthConfigTestResult,
  AuthConfigUpdate,
  ClusterCreateInput,
  ClusterSettingsInput,
  ClusterUpdateInput,
  HostState,
  TenantSettings,
} from '@lcm/shared';
import {
  authConfigResponseSchema,
  categoryResponseSchema,
  clusterResponseSchema,
  clusterSettingsResponseSchema,
  forecastResponseSchema,
  hostLifecycleEventResponseSchema,
  hostReplacementResponseSchema,
  hostResponseSchema,
  itemResponseSchema,
  paginatedSchema,
  tenantSettingsResponseSchema,
} from '@lcm/shared';
import { z } from 'zod';

/**
 * Wire shape of scenarioSchema: Zod's `monthOnly.optional()` transforms a
 * `YYYY-MM` string to a Date, so the inferred type's `startMonth` is `Date`.
 * On the wire we send the original `YYYY-MM` string.
 */
export type ScenarioWire =
  | { kind: 'lose_hosts'; count: number }
  | { kind: 'add_vms'; count: number; sizeGb: number; startMonth?: string }
  | { kind: 'delay_procurement'; months: number };

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

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

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { error?: { code?: unknown; message?: unknown } };
  return (
    typeof candidate.error === 'object' &&
    candidate.error !== null &&
    typeof candidate.error.code === 'string' &&
    typeof candidate.error.message === 'string'
  );
}

// ---------- Wire body types ----------

/**
 * Wire shape of clusterCreateInputSchema: a Zod-parsed ClusterCreateInput has
 * a real Date for baselineDate, but JSON.stringify serializes that to an ISO
 * string. POST bodies must send the original wire shape (YYYY-MM-DD).
 */
export type ClusterCreateInputWire = Omit<ClusterCreateInput, 'baselineDate'> & {
  baselineDate: string;
};

/**
 * Wire shape of clusterUpdateInputSchema. Same Date→string translation as
 * ClusterCreateInputWire. All fields optional; at least one must be present
 * (server-side .refine enforces this).
 */
export type ClusterUpdateInputWire = Omit<ClusterUpdateInput, 'baselineDate'> & {
  baselineDate?: string;
};

export interface HostCreateInputWire {
  name: string;
  description?: string;
  commissionedAt: string;
  decommissionedAt?: string | null;
  capacities: Array<{ metricTypeKey: string; effectiveFrom: string; amount: number }>;
  serialNumber?: string | null;
  vendor?: string | null;
  model?: string | null;
  purchasedAt?: string | null;
  warrantyEndsAt?: string | null;
  eolAt?: string | null;
  runPastEol?: boolean;
}

export interface HostUpdateInputWire {
  name?: string;
  description?: string | null;
  commissionedAt?: string;
  decommissionedAt?: string | null;
  serialNumber?: string | null;
  vendor?: string | null;
  model?: string | null;
  purchasedAt?: string | null;
  warrantyEndsAt?: string | null;
  eolAt?: string | null;
  runPastEol?: boolean;
}

export interface CapacityAppendInputWire {
  metricTypeKey: string;
  effectiveFrom: string;
  amount: number;
}

export type ItemCreateInputWire =
  | {
      kind: 'application';
      name: string;
      category: string;
      description?: string;
      effectiveDate: string;
      endedAt?: string | null;
      allocations: Array<{ metricTypeKey: string; effectiveFrom: string; amount: number }>;
    }
  | {
      kind: 'event';
      name: string;
      category: string;
      description?: string;
      effectiveDate: string;
      metricTypeKey: string;
      consumptionDelta?: number | null;
      capacityDelta?: number | null;
    };

export interface ItemUpdateInputWire {
  name?: string;
  category?: string;
  description?: string | null;
  effectiveDate?: string;
  endedAt?: string | null;
  metricTypeKey?: string;
  consumptionDelta?: number | null;
  capacityDelta?: number | null;
}

export interface ItemAllocationAppendInputWire {
  metricTypeKey: string;
  effectiveFrom: string;
  amount: number;
}

/**
 * Wire shape of hostTransitionInputSchema. The parsed type has a Date for
 * occurredAt, but the server's dateOnly schema expects 'YYYY-MM-DD' on the
 * wire — matches HostCreateInputWire.commissionedAt handling.
 */
export interface HostTransitionInputWire {
  toState: HostState;
  occurredAt: string;
  note?: string;
}

/**
 * Wire shape of hostReplacementCreateInputSchema. Same Date→string translation
 * for swappedAt.
 */
export interface HostReplacementCreateInputWire {
  oldHostId: string;
  newHostId: string;
  swappedAt: string;
  reason?: string;
}

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
    auth: {
      get: () => request('/api/settings/auth', undefined, authConfigResponseSchema),
      update: (input: AuthConfigUpdate) =>
        request(
          '/api/settings/auth',
          { method: 'PUT', body: JSON.stringify(input) },
          authConfigResponseSchema,
        ),
      test: (input: AuthConfigTest) =>
        request<AuthConfigTestResult>('/api/settings/auth/test', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      rotateSigningSecret: () =>
        request<{ rotated: boolean }>('/api/settings/auth/rotate-signing-secret', {
          method: 'POST',
        }),
    },
  },
};
