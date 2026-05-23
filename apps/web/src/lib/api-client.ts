import type {
  ApplicationResponse,
  ClusterCreateInput,
  ClusterResponse,
  EventCategory,
  EventResponse,
  ForecastResponse,
  HostResponse,
} from '@lcm/shared';

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

export interface HealthResponse {
  status: 'ok';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...init?.headers,
    },
  });

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

  return body as T;
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

export interface HostCreateInputWire {
  name: string;
  description?: string;
  commissionedAt: string;
  decommissionedAt?: string | null;
  capacities: Array<{ metricTypeKey: string; effectiveFrom: string; amount: number }>;
}

export interface HostUpdateInputWire {
  name?: string;
  description?: string | null;
  commissionedAt?: string;
  decommissionedAt?: string | null;
}

export interface CapacityAppendInputWire {
  metricTypeKey: string;
  effectiveFrom: string;
  amount: number;
}

export interface ApplicationCreateInputWire {
  name: string;
  category: string;
  description?: string;
  startedAt: string;
  endedAt?: string | null;
  allocations: Array<{ metricTypeKey: string; effectiveFrom: string; amount: number }>;
}

export interface ApplicationUpdateInputWire {
  name?: string;
  category?: string;
  description?: string | null;
  startedAt?: string;
  endedAt?: string | null;
}

export interface AllocationAppendInputWire {
  metricTypeKey: string;
  effectiveFrom: string;
  amount: number;
}

export interface EventCreateInputWire {
  metricTypeKey: string;
  effectiveDate: string;
  category: EventCategory;
  title: string;
  description?: string;
  consumptionDelta?: number | null;
  capacityDelta?: number | null;
}

export interface EventUpdateInputWire {
  metricTypeKey?: string;
  effectiveDate?: string;
  category?: EventCategory;
  title?: string;
  description?: string | null;
  consumptionDelta?: number | null;
  capacityDelta?: number | null;
}

// ---------- API surface ----------

export const api = {
  health: {
    live: () => request<HealthResponse>('/healthz'),
    ready: () => request<HealthResponse>('/readyz'),
  },
  clusters: {
    list: () => request<ClusterResponse[]>('/api/clusters'),
    get: (id: string) => request<ClusterResponse>(`/api/clusters/${id}`),
    create: (input: ClusterCreateInputWire) =>
      request<ClusterResponse>('/api/clusters', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    delete: (id: string) => request<void>(`/api/clusters/${id}`, { method: 'DELETE' }),
    forecast: (id: string, params: { metric: string; from?: string; to?: string }) => {
      const search = new URLSearchParams({ metric: params.metric });
      if (params.from) search.set('from', params.from);
      if (params.to) search.set('to', params.to);
      return request<ForecastResponse>(`/api/clusters/${id}/forecast?${search.toString()}`);
    },
  },
  hosts: {
    listByCluster: (clusterId: string) =>
      request<HostResponse[]>(`/api/clusters/${clusterId}/hosts`),
    create: (clusterId: string, input: HostCreateInputWire) =>
      request<HostResponse>(`/api/clusters/${clusterId}/hosts`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    update: (id: string, input: HostUpdateInputWire) =>
      request<HostResponse>(`/api/hosts/${id}`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    appendCapacity: (id: string, input: CapacityAppendInputWire) =>
      request<HostResponse>(`/api/hosts/${id}/capacity`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    delete: (id: string) => request<void>(`/api/hosts/${id}`, { method: 'DELETE' }),
  },
  applications: {
    listByCluster: (clusterId: string) =>
      request<ApplicationResponse[]>(`/api/clusters/${clusterId}/applications`),
    create: (clusterId: string, input: ApplicationCreateInputWire) =>
      request<ApplicationResponse>(`/api/clusters/${clusterId}/applications`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    update: (id: string, input: ApplicationUpdateInputWire) =>
      request<ApplicationResponse>(`/api/applications/${id}`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    appendAllocation: (id: string, input: AllocationAppendInputWire) =>
      request<ApplicationResponse>(`/api/applications/${id}/allocation`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    delete: (id: string) => request<void>(`/api/applications/${id}`, { method: 'DELETE' }),
  },
  events: {
    listByCluster: (clusterId: string) =>
      request<EventResponse[]>(`/api/clusters/${clusterId}/events`),
    create: (clusterId: string, input: EventCreateInputWire) =>
      request<EventResponse>(`/api/clusters/${clusterId}/events`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    update: (id: string, input: EventUpdateInputWire) =>
      request<EventResponse>(`/api/events/${id}`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    delete: (id: string) => request<void>(`/api/events/${id}`, { method: 'DELETE' }),
  },
};
