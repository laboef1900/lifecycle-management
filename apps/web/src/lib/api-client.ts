import type { ClusterResponse, ForecastResponse } from '@lcm/shared';

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

export const api = {
  health: {
    live: () => request<HealthResponse>('/healthz'),
    ready: () => request<HealthResponse>('/readyz'),
  },
  clusters: {
    list: () => request<ClusterResponse[]>('/api/clusters'),
    get: (id: string) => request<ClusterResponse>(`/api/clusters/${id}`),
    forecast: (id: string, params: { metric: string; from?: string; to?: string }) => {
      const search = new URLSearchParams({ metric: params.metric });
      if (params.from) search.set('from', params.from);
      if (params.to) search.set('to', params.to);
      return request<ForecastResponse>(`/api/clusters/${id}/forecast?${search.toString()}`);
    },
  },
};
