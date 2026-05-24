# Cluster Identity + Baseline Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators edit a cluster's name, description, baseline date, and per-metric baseline values from the Settings tab on the cluster detail page — identity edits save directly; baseline edits open a confirm dialog because they rewrite every forecast point.

**Architecture:** Pure web work on top of the existing `PUT /api/clusters/:id` endpoint. Add the missing `api.clusters.update()` web client method, then two new forms (`ClusterIdentityForm`, `BaselineEditForm`) on the Settings tab. Both forms follow the "edit overrides server" pattern established in sub-project 1 (no useEffect-driven state sync, per repo lint rules). Baseline form reuses the existing `ConfirmDialog` primitive.

**Tech Stack:** React 19, TanStack Query, Zod (server-side validation), Vitest + Testing Library for unit tests, Playwright for e2e.

**Spec:** [`docs/superpowers/specs/2026-05-24-cluster-identity-baseline-edit-design.md`](../specs/2026-05-24-cluster-identity-baseline-edit-design.md)

---

## File map

**Modified:**

- `apps/web/src/lib/api-client.ts` — add `ClusterUpdateInputWire` type + `api.clusters.update(id, input)` method.
- `apps/web/src/components/clusters/settings-tab.tsx` — extend to render three sections (Thresholds + Identity + Baseline).
- `apps/web/playwright/settings.spec.ts` — add an e2e test that walks the identity + baseline edit flow.

**New:**

- `apps/web/src/components/clusters/cluster-identity-form.tsx` — name + description editor.
- `apps/web/src/components/clusters/cluster-identity-form.test.tsx`
- `apps/web/src/components/clusters/baseline-edit-form.tsx` — baseline date + per-metric values + confirm dialog.
- `apps/web/src/components/clusters/baseline-edit-form.test.tsx`

**Untouched:**

- Backend (`apps/api/`, `packages/shared/`) — `PUT /api/clusters/:id` and `clusterUpdateInputSchema` already cover the full edit surface.
- Prisma schema + migrations.

---

## Branch convention

Recommend feature branch `cluster-identity-edit`. If executing via `superpowers:using-git-worktrees`, the worktree is created up-front. All commits stay on this branch; PR at the end (Task 6).

---

## Task 1: Add `api.clusters.update()` to web client

**Files:**

- Modify: `apps/web/src/lib/api-client.ts`

The existing `api.clusters` group has list/get/create/delete/forecast but no update. The PUT endpoint exists server-side and accepts `clusterUpdateInputSchema`.

- [ ] **Step 1: Add the wire type**

Open `apps/web/src/lib/api-client.ts`. Find the existing `ClusterCreateInputWire` definition (around line 94). After it, add:

```ts
/**
 * Wire shape of clusterUpdateInputSchema. Same Date→string translation as
 * ClusterCreateInputWire. All fields optional; at least one must be present
 * (server-side .refine enforces this).
 */
export type ClusterUpdateInputWire = Omit<ClusterUpdateInput, 'baselineDate'> & {
  baselineDate?: string;
};
```

Add `ClusterUpdateInput` to the existing `@lcm/shared` type import at the top of the file (alphabetically). The existing block looks like:

```ts
import type {
  ApplicationResponse,
  ClusterCreateInput,
  ClusterResponse,
  ClusterSettingsInput,
  ClusterSettingsResponse,
  EventCategory,
  EventResponse,
  ForecastResponse,
  HostResponse,
  TenantSettings,
} from '@lcm/shared';
```

Insert `ClusterUpdateInput` after `ClusterCreateInput`:

```ts
import type {
  ApplicationResponse,
  ClusterCreateInput,
  ClusterResponse,
  ClusterSettingsInput,
  ClusterSettingsResponse,
  ClusterUpdateInput,
  EventCategory,
  EventResponse,
  ForecastResponse,
  HostResponse,
  TenantSettings,
} from '@lcm/shared';
```

- [ ] **Step 2: Add the `update` method to `api.clusters`**

Find the `clusters` group inside `export const api = { ... }` (around line 169). Currently:

```ts
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
      ...
    },
  },
```

Add `update` between `create` and `delete`:

```ts
    create: (input: ClusterCreateInputWire) =>
      request<ClusterResponse>('/api/clusters', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    update: (id: string, input: ClusterUpdateInputWire) =>
      request<ClusterResponse>(`/api/clusters/${id}`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    delete: (id: string) => request<void>(`/api/clusters/${id}`, { method: 'DELETE' }),
```

- [ ] **Step 3: Run typecheck + lint + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web test
```

Expected: all PASS (88/88). The new method is unused so far.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/api-client.ts
git commit -m "feat(web): api.clusters.update for PUT /api/clusters/:id"
```

---

## Task 2: Build `ClusterIdentityForm`

**Files:**

- Create: `apps/web/src/components/clusters/cluster-identity-form.tsx`
- Create: `apps/web/src/components/clusters/cluster-identity-form.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/clusters/cluster-identity-form.test.tsx`:

```tsx
import type { ClusterResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { ClusterIdentityForm } from './cluster-identity-form';

const CLUSTER_ID = 'clu_test_001';

const baseCluster: ClusterResponse = {
  id: CLUSTER_ID,
  name: 'CL-Original',
  description: 'Original description',
  baselineDate: '2026-05-01',
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
  metrics: [
    {
      metricTypeKey: 'memory_gb',
      metricTypeDisplayName: 'Memory',
      unit: 'GB',
      baselineConsumption: 400,
      baselineCapacity: 1000,
      currentConsumption: 400,
      currentCapacity: 1000,
      utilization: 0.4,
    },
  ],
};

function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('<ClusterIdentityForm>', () => {
  beforeEach(() => {
    vi.spyOn(api.clusters, 'get').mockResolvedValue(baseCluster);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and displays current name + description', async () => {
    renderWithClient(<ClusterIdentityForm clusterId={CLUSTER_ID} />);
    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toHaveValue('CL-Original');
      expect(screen.getByLabelText(/description/i)).toHaveValue('Original description');
    });
  });

  it('disables Save until a field changes', async () => {
    renderWithClient(<ClusterIdentityForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/name/i)).toHaveValue('CL-Original'));
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText(/name/i));
    await userEvent.type(screen.getByLabelText(/name/i), 'CL-Renamed');
    expect(screen.getByRole('button', { name: /save/i })).toBeEnabled();
  });

  it('submits only the changed name field', async () => {
    const updateSpy = vi.spyOn(api.clusters, 'update').mockResolvedValue({
      ...baseCluster,
      name: 'CL-Renamed',
    });
    renderWithClient(<ClusterIdentityForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/name/i)).toHaveValue('CL-Original'));
    await userEvent.clear(screen.getByLabelText(/name/i));
    await userEvent.type(screen.getByLabelText(/name/i), 'CL-Renamed');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(CLUSTER_ID, { name: 'CL-Renamed' });
    });
  });

  it('submits description=null when description is cleared', async () => {
    const updateSpy = vi.spyOn(api.clusters, 'update').mockResolvedValue({
      ...baseCluster,
      description: null,
    });
    renderWithClient(<ClusterIdentityForm clusterId={CLUSTER_ID} />);
    await waitFor(() =>
      expect(screen.getByLabelText(/description/i)).toHaveValue('Original description'),
    );
    await userEvent.clear(screen.getByLabelText(/description/i));
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(CLUSTER_ID, { description: null });
    });
  });

  it('shows an inline error when name is empty on submit', async () => {
    renderWithClient(<ClusterIdentityForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/name/i)).toHaveValue('CL-Original'));
    await userEvent.clear(screen.getByLabelText(/name/i));
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(screen.getByText(/name is required/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @lcm/web test cluster-identity-form
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the form**

Create `apps/web/src/components/clusters/cluster-identity-form.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, type ClusterUpdateInputWire } from '@/lib/api-client';

interface ClusterIdentityFormProps {
  clusterId: string;
}

export function ClusterIdentityForm({ clusterId }: ClusterIdentityFormProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const clusterQuery = useQuery({
    queryKey: ['cluster', clusterId],
    queryFn: () => api.clusters.get(clusterId),
  });

  // Edit state overlays server data. null = use server value; string = user-edited.
  const [nameEdit, setNameEdit] = React.useState<string | null>(null);
  const [descriptionEdit, setDescriptionEdit] = React.useState<string | null>(null);
  const [validationError, setValidationError] = React.useState<string | null>(null);

  const serverName = clusterQuery.data?.name ?? '';
  const serverDescription = clusterQuery.data?.description ?? '';
  const name = nameEdit ?? serverName;
  const description = descriptionEdit ?? serverDescription;

  const mutation = useMutation({
    mutationFn: (input: ClusterUpdateInputWire) => api.clusters.update(clusterId, input),
    onSuccess: (data) => {
      queryClient.setQueryData(['cluster', clusterId], data);
      setNameEdit(null);
      setDescriptionEdit(null);
    },
  });

  const dirty =
    (nameEdit !== null && nameEdit !== serverName) ||
    (descriptionEdit !== null && descriptionEdit !== serverDescription);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setValidationError(null);

    if (name.trim().length === 0) {
      setValidationError('Name is required.');
      return;
    }

    const input: ClusterUpdateInputWire = {};
    if (nameEdit !== null && nameEdit !== serverName) {
      input.name = nameEdit;
    }
    if (descriptionEdit !== null && descriptionEdit !== serverDescription) {
      input.description = descriptionEdit === '' ? null : descriptionEdit;
    }
    mutation.mutate(input);
  };

  return (
    <Card className="p-4">
      <header className="mb-4">
        <h2 className="text-base font-semibold">Cluster identity</h2>
        <p className="text-sm text-fg-muted">Rename or update the description for this cluster.</p>
      </header>
      <form onSubmit={handleSubmit} className="space-y-3">
        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Name
          </span>
          <Input
            aria-label="Name"
            value={name}
            onChange={(e) => setNameEdit(e.target.value)}
            maxLength={120}
            className="mt-1"
          />
        </label>
        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Description
          </span>
          <textarea
            aria-label="Description"
            value={description}
            onChange={(e) => setDescriptionEdit(e.target.value)}
            maxLength={2000}
            rows={3}
            className="mt-1 flex w-full rounded-[var(--radius)] border border-input bg-background px-2.5 py-1.5 text-sm placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          />
        </label>
        {validationError ? (
          <p className="text-sm text-destructive" role="alert">
            {validationError}
          </p>
        ) : null}
        <div className="flex items-center justify-end">
          <Button type="submit" variant="accent" size="sm" disabled={!dirty || mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @lcm/web test cluster-identity-form
```

Expected: 5/5 PASS.

- [ ] **Step 5: Run full web suite**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web test
```

Expected: typecheck PASS, lint PASS, 88 + 5 = 93 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/clusters/cluster-identity-form.tsx apps/web/src/components/clusters/cluster-identity-form.test.tsx
git commit -m "feat(web): ClusterIdentityForm — name + description editor"
```

---

## Task 3: Build `BaselineEditForm` with confirm dialog

**Files:**

- Create: `apps/web/src/components/clusters/baseline-edit-form.tsx`
- Create: `apps/web/src/components/clusters/baseline-edit-form.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/clusters/baseline-edit-form.test.tsx`:

```tsx
import type { ClusterResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { BaselineEditForm } from './baseline-edit-form';

const CLUSTER_ID = 'clu_test_001';

const baseCluster: ClusterResponse = {
  id: CLUSTER_ID,
  name: 'CL-Test',
  description: null,
  baselineDate: '2026-05-01',
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
  metrics: [
    {
      metricTypeKey: 'memory_gb',
      metricTypeDisplayName: 'Memory',
      unit: 'GB',
      baselineConsumption: 400,
      baselineCapacity: 1000,
      currentConsumption: 400,
      currentCapacity: 1000,
      utilization: 0.4,
    },
  ],
};

function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('<BaselineEditForm>', () => {
  beforeEach(() => {
    vi.spyOn(api.clusters, 'get').mockResolvedValue(baseCluster);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and displays current baseline date + per-metric values', async () => {
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => {
      expect(screen.getByLabelText(/baseline date/i)).toHaveValue('2026-05-01');
      expect(screen.getByLabelText(/memory.*consumption/i)).toHaveValue(400);
      expect(screen.getByLabelText(/memory.*capacity/i)).toHaveValue(1000);
    });
  });

  it('disables Save until a field changes', async () => {
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/baseline date/i)).toHaveValue('2026-05-01'));
    expect(screen.getByRole('button', { name: /save baseline/i })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText(/memory.*consumption/i));
    await userEvent.type(screen.getByLabelText(/memory.*consumption/i), '500');
    expect(screen.getByRole('button', { name: /save baseline/i })).toBeEnabled();
  });

  it('opens a confirm dialog on save instead of submitting immediately', async () => {
    const updateSpy = vi.spyOn(api.clusters, 'update').mockResolvedValue(baseCluster);
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/memory.*consumption/i)).toHaveValue(400));
    await userEvent.clear(screen.getByLabelText(/memory.*consumption/i));
    await userEvent.type(screen.getByLabelText(/memory.*consumption/i), '500');
    await userEvent.click(screen.getByRole('button', { name: /save baseline/i }));
    expect(screen.getByRole('dialog', { name: /rewrite baseline/i })).toBeInTheDocument();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('cancel button in the dialog does not submit', async () => {
    const updateSpy = vi.spyOn(api.clusters, 'update').mockResolvedValue(baseCluster);
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/memory.*consumption/i)).toHaveValue(400));
    await userEvent.clear(screen.getByLabelText(/memory.*consumption/i));
    await userEvent.type(screen.getByLabelText(/memory.*consumption/i), '500');
    await userEvent.click(screen.getByRole('button', { name: /save baseline/i }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('confirm submits the full baselines array even when only one value changed', async () => {
    const updateSpy = vi.spyOn(api.clusters, 'update').mockResolvedValue(baseCluster);
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/memory.*consumption/i)).toHaveValue(400));
    await userEvent.clear(screen.getByLabelText(/memory.*consumption/i));
    await userEvent.type(screen.getByLabelText(/memory.*consumption/i), '500');
    await userEvent.click(screen.getByRole('button', { name: /save baseline/i }));
    await userEvent.click(screen.getByRole('button', { name: /rewrite baseline/i }));
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(CLUSTER_ID, {
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 500, baselineCapacity: 1000 },
        ],
      });
    });
  });

  it('includes baselineDate in PUT when only the date changed', async () => {
    const updateSpy = vi.spyOn(api.clusters, 'update').mockResolvedValue(baseCluster);
    renderWithClient(<BaselineEditForm clusterId={CLUSTER_ID} />);
    await waitFor(() => expect(screen.getByLabelText(/baseline date/i)).toHaveValue('2026-05-01'));
    const dateInput = screen.getByLabelText(/baseline date/i);
    await userEvent.clear(dateInput);
    await userEvent.type(dateInput, '2026-06-01');
    await userEvent.click(screen.getByRole('button', { name: /save baseline/i }));
    await userEvent.click(screen.getByRole('button', { name: /rewrite baseline/i }));
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(CLUSTER_ID, { baselineDate: '2026-06-01' });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @lcm/web test baseline-edit-form
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the form**

Create `apps/web/src/components/clusters/baseline-edit-form.tsx`:

```tsx
import type { MetricStateResponse } from '@lcm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import { ConfirmDialog } from '@/components/form/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, type ClusterUpdateInputWire } from '@/lib/api-client';

interface BaselineEditFormProps {
  clusterId: string;
}

interface MetricEdit {
  consumption: number | null;
  capacity: number | null;
}

function parseNumber(value: string): number | null {
  if (value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function BaselineEditForm({ clusterId }: BaselineEditFormProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const clusterQuery = useQuery({
    queryKey: ['cluster', clusterId],
    queryFn: () => api.clusters.get(clusterId),
  });

  const [dateEdit, setDateEdit] = React.useState<string | null>(null);
  const [metricEdits, setMetricEdits] = React.useState<Record<string, MetricEdit>>({});
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const serverDate = clusterQuery.data?.baselineDate ?? '';
  const metrics = clusterQuery.data?.metrics ?? [];

  const date = dateEdit ?? serverDate;

  const getMetricValue = (
    metric: MetricStateResponse,
    field: 'consumption' | 'capacity',
  ): number => {
    const edit = metricEdits[metric.metricTypeKey];
    if (edit && edit[field] !== null) return edit[field] as number;
    return field === 'consumption' ? metric.baselineConsumption : metric.baselineCapacity;
  };

  const setMetricValue = (key: string, field: 'consumption' | 'capacity', raw: string): void => {
    setMetricEdits((prev) => {
      const current = prev[key] ?? { consumption: null, capacity: null };
      return { ...prev, [key]: { ...current, [field]: parseNumber(raw) } };
    });
  };

  const mutation = useMutation({
    mutationFn: (input: ClusterUpdateInputWire) => api.clusters.update(clusterId, input),
    onSuccess: (data) => {
      queryClient.setQueryData(['cluster', clusterId], data);
      void queryClient.invalidateQueries({ queryKey: ['forecast', clusterId] });
      setDateEdit(null);
      setMetricEdits({});
      setConfirmOpen(false);
    },
  });

  const dateChanged = dateEdit !== null && dateEdit !== serverDate;
  const baselinesChanged = metrics.some((m) => {
    const edit = metricEdits[m.metricTypeKey];
    if (!edit) return false;
    return (
      (edit.consumption !== null && edit.consumption !== m.baselineConsumption) ||
      (edit.capacity !== null && edit.capacity !== m.baselineCapacity)
    );
  });
  const dirty = dateChanged || baselinesChanged;

  const handleSave = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!dirty) return;
    setConfirmOpen(true);
  };

  const handleConfirm = (): void => {
    const input: ClusterUpdateInputWire = {};
    if (dateChanged) input.baselineDate = date;
    if (baselinesChanged) {
      input.baselines = metrics.map((m) => ({
        metricTypeKey: m.metricTypeKey,
        baselineConsumption: getMetricValue(m, 'consumption'),
        baselineCapacity: getMetricValue(m, 'capacity'),
      }));
    }
    mutation.mutate(input);
  };

  return (
    <Card className="p-4">
      <header className="mb-4">
        <h2 className="text-base font-semibold">Baseline</h2>
        <p className="text-sm text-fg-muted">
          The starting date and per-metric values that every forecast point is computed from.
        </p>
      </header>
      <form onSubmit={handleSave} className="space-y-3">
        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Baseline date
          </span>
          <Input
            type="date"
            aria-label="Baseline date"
            value={date}
            onChange={(e) => setDateEdit(e.target.value)}
            className="mt-1"
          />
        </label>
        {metrics.map((m) => (
          <div
            key={m.metricTypeKey}
            className="space-y-2 rounded-[var(--radius)] border border-border p-3"
          >
            <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
              {m.metricTypeDisplayName} ({m.unit})
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[11px] text-fg-muted">Baseline consumption</span>
                <Input
                  type="number"
                  step="any"
                  min={0}
                  aria-label={`${m.metricTypeDisplayName} baseline consumption`}
                  value={getMetricValue(m, 'consumption')}
                  onChange={(e) => setMetricValue(m.metricTypeKey, 'consumption', e.target.value)}
                  className="mt-1"
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-fg-muted">Baseline capacity</span>
                <Input
                  type="number"
                  step="any"
                  min={0}
                  aria-label={`${m.metricTypeDisplayName} baseline capacity`}
                  value={getMetricValue(m, 'capacity')}
                  onChange={(e) => setMetricValue(m.metricTypeKey, 'capacity', e.target.value)}
                  className="mt-1"
                />
              </label>
            </div>
          </div>
        ))}
        <div className="flex items-center justify-end">
          <Button
            type="submit"
            variant="destructive"
            size="sm"
            disabled={!dirty || mutation.isPending}
          >
            Save baseline
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Rewrite baseline?"
        description="Changing the baseline date or values rewrites every forecast point for this cluster. Confirm only if you intentionally want to reset historical assumptions."
        confirmLabel="Rewrite baseline"
        destructive
        pending={mutation.isPending}
        onConfirm={handleConfirm}
      />
    </Card>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @lcm/web test baseline-edit-form
```

Expected: 6/6 PASS.

- [ ] **Step 5: Run full web suite**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web test
```

Expected: typecheck PASS, lint PASS, 93 + 6 = 99 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/clusters/baseline-edit-form.tsx apps/web/src/components/clusters/baseline-edit-form.test.tsx
git commit -m "feat(web): BaselineEditForm — confirm-guarded baseline date + per-metric editor"
```

---

## Task 4: Wire both forms into `SettingsTab`

**Files:**

- Modify: `apps/web/src/components/clusters/settings-tab.tsx`

- [ ] **Step 1: Read current contents**

```bash
cat apps/web/src/components/clusters/settings-tab.tsx
```

Currently:

```tsx
import { ThresholdOverridesForm } from './threshold-overrides-form';

interface SettingsTabProps {
  clusterId: string;
}

export function SettingsTab({ clusterId }: SettingsTabProps): React.JSX.Element {
  return (
    <div className="space-y-6 py-4">
      <ThresholdOverridesForm clusterId={clusterId} />
    </div>
  );
}
```

- [ ] **Step 2: Add the two new sections**

Replace the file with:

```tsx
import { BaselineEditForm } from './baseline-edit-form';
import { ClusterIdentityForm } from './cluster-identity-form';
import { ThresholdOverridesForm } from './threshold-overrides-form';

interface SettingsTabProps {
  clusterId: string;
}

export function SettingsTab({ clusterId }: SettingsTabProps): React.JSX.Element {
  return (
    <div className="space-y-6 py-4">
      <ThresholdOverridesForm clusterId={clusterId} />
      <ClusterIdentityForm clusterId={clusterId} />
      <BaselineEditForm clusterId={clusterId} />
    </div>
  );
}
```

(Order matters: thresholds → identity → baseline, with destructive section last.)

- [ ] **Step 3: Run typecheck + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web test
```

Expected: PASS, 99 tests.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/clusters/settings-tab.tsx
git commit -m "feat(web): mount ClusterIdentityForm + BaselineEditForm in Settings tab"
```

---

## Task 5: E2E walkthrough — identity + baseline edit

**Files:**

- Modify: `apps/web/playwright/settings.spec.ts`

- [ ] **Step 1: Confirm dev DB + API are running**

```bash
docker compose -f docker-compose.dev.yml ps 2>&1 | head -3
curl -sf http://localhost:8090/healthz >/dev/null && echo "api ready" || echo "api not running"
```

If API is down:

```bash
pnpm --filter @lcm/api dev > /tmp/lcm-api-e2e.log 2>&1 &
until curl -sf http://localhost:8090/healthz >/dev/null 2>&1; do sleep 1; done && echo "api ready"
```

- [ ] **Step 2: Add the e2e test block**

Open `apps/web/playwright/settings.spec.ts`. After the existing `test.describe('configurable thresholds', ...)` block, add a new describe:

```ts
test.describe('cluster identity + baseline edit', () => {
  test('renames cluster — header updates immediately', async ({ page, request }) => {
    const clustersRes = await request.get('/api/clusters');
    const clusters = (await clustersRes.json()) as Array<{ id: string; name: string }>;
    test.skip(clusters.length === 0, 'requires seeded clusters');
    const cluster = clusters[0]!;
    const originalName = cluster.name;
    const newName = `${originalName}-renamed`;

    try {
      await page.goto(`/clusters/${cluster.id}`);
      await expect(page.getByRole('heading', { name: originalName, level: 1 })).toBeVisible();

      await page.getByRole('tab', { name: 'Settings' }).click();

      const nameInput = page.getByLabel('Name');
      await expect(nameInput).toHaveValue(originalName);
      await nameInput.fill(newName);

      const putResponse = page.waitForResponse(
        (r) => r.url().includes(`/api/clusters/${cluster.id}`) && r.request().method() === 'PUT',
      );
      await page
        .locator('form')
        .filter({ hasText: 'Cluster identity' })
        .getByRole('button', { name: /^save$/i })
        .click();
      await putResponse;

      await expect(page.getByRole('heading', { name: newName, level: 1 })).toBeVisible();
    } finally {
      // Restore the cluster name so subsequent runs are deterministic.
      await request.put(`/api/clusters/${cluster.id}`, { data: { name: originalName } });
    }
  });

  test('confirm dialog gates baseline edits', async ({ page, request }) => {
    const clustersRes = await request.get('/api/clusters');
    const clusters = (await clustersRes.json()) as Array<{
      id: string;
      metrics: Array<{
        metricTypeKey: string;
        baselineConsumption: number;
        baselineCapacity: number;
      }>;
    }>;
    test.skip(clusters.length === 0, 'requires seeded clusters');
    const cluster = clusters[0]!;
    const memory = cluster.metrics.find((m) => m.metricTypeKey === 'memory_gb');
    test.skip(!memory, 'requires memory_gb metric');
    const originalConsumption = memory!.baselineConsumption;
    const newConsumption = originalConsumption + 100;

    try {
      await page.goto(`/clusters/${cluster.id}`);
      await page.getByRole('tab', { name: 'Settings' }).click();

      const consumptionInput = page.getByLabel(/memory.*baseline consumption/i);
      await consumptionInput.fill(String(newConsumption));
      await page.getByRole('button', { name: /save baseline/i }).click();

      await expect(page.getByRole('dialog', { name: /rewrite baseline/i })).toBeVisible();

      // Cancel first — verify no PUT goes out.
      await page.getByRole('button', { name: /cancel/i }).click();
      await expect(page.getByRole('dialog', { name: /rewrite baseline/i })).not.toBeVisible();

      // Now confirm.
      await page.getByRole('button', { name: /save baseline/i }).click();
      await expect(page.getByRole('dialog', { name: /rewrite baseline/i })).toBeVisible();

      const putResponse = page.waitForResponse(
        (r) => r.url().includes(`/api/clusters/${cluster.id}`) && r.request().method() === 'PUT',
      );
      await page.getByRole('button', { name: /rewrite baseline/i }).click();
      await putResponse;

      // Dialog closes, page persists.
      await expect(page.getByRole('dialog', { name: /rewrite baseline/i })).not.toBeVisible();

      // Verify server now reports the new value.
      const updated = await request.get(`/api/clusters/${cluster.id}`);
      const updatedBody = (await updated.json()) as {
        metrics: Array<{ metricTypeKey: string; baselineConsumption: number }>;
      };
      const updatedMemory = updatedBody.metrics.find((m) => m.metricTypeKey === 'memory_gb');
      expect(updatedMemory?.baselineConsumption).toBeCloseTo(newConsumption);
    } finally {
      // Restore the original baseline so subsequent runs are deterministic.
      await request.put(`/api/clusters/${cluster.id}`, {
        data: {
          baselines: cluster.metrics.map((m) => ({
            metricTypeKey: m.metricTypeKey,
            baselineConsumption: m.baselineConsumption,
            baselineCapacity: m.baselineCapacity,
          })),
        },
      });
    }
  });
});
```

- [ ] **Step 3: Run e2e**

```bash
pnpm --filter @lcm/web test:e2e settings.spec.ts
```

Expected: 4/4 PASS (2 from sub-project 1 + 2 new).

If the second test fails on `expect(updatedMemory?.baselineConsumption).toBeCloseTo(newConsumption)` because the response still has the old value, the `setQueryData` after mutation may have raced with the API fetch — add `await page.waitForResponse(...)` for the GET that follows.

- [ ] **Step 4: Run the full e2e suite**

```bash
pnpm --filter @lcm/web test:e2e
```

Expected: all tests PASS (golden-path + mobile + settings).

- [ ] **Step 5: Commit**

```bash
git add apps/web/playwright/settings.spec.ts
git commit -m "test(web): e2e for cluster identity rename + baseline edit confirm flow"
```

---

## Task 6: Final verification + PR

**Files:** none — verification + git ops only.

- [ ] **Step 1: Workspace-wide checks**

```bash
pnpm -r typecheck
pnpm -r lint
pnpm --filter @lcm/web test
pnpm --filter @lcm/api test
pnpm --filter @lcm/web test:e2e
```

Expected: all PASS.

- [ ] **Step 2: Visual sanity check (optional but recommended)**

Start the dev stack if not running:

```bash
docker compose -f docker-compose.dev.yml up -d
pnpm --filter @lcm/api dev &
pnpm --filter @lcm/web dev
```

Browser walkthrough at `http://localhost:5173/clusters/<id>` → Settings tab:

- Three sections visible: Thresholds, Cluster identity, Baseline (in that order).
- Edit the name in the Identity card → click Save → page H1 updates.
- Edit a baseline value → click Save baseline → confirm dialog appears → click Cancel → dialog closes, no change. Click Save baseline again → confirm with Rewrite baseline → dialog closes, forecast chart refetches.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin <branch-name>
gh pr create --title "feat: cluster identity + baseline edit (sub-project 2 of 3)" --body "$(cat <<'EOF'
## Summary

Adds two new sections to the cluster Settings tab:

- **Cluster identity** — edit name and description with a direct Save button.
- **Baseline** — edit baseline date and per-metric consumption/capacity. Save opens a confirm dialog ("Rewrite baseline?") because the change recomputes every forecast point.

Backend already supported the full edit surface via `PUT /api/clusters/:id`; this work is purely web-side (one missing api-client method + two forms + e2e coverage).

Sub-project 2 of 3. Sub-project 3 shrinks to delete + archive only (baseline reset is absorbed here).

## Changes

- `api.clusters.update(id, input)` added to the web client with `ClusterUpdateInputWire` typing
- `ClusterIdentityForm` + `BaselineEditForm` components, both following the "edit overrides server" pattern from sub-project 1
- `SettingsTab` extended to stack Thresholds → Identity → Baseline
- `BaselineEditForm` reuses the existing `ConfirmDialog` primitive
- E2e tests for both flows (rename header updates immediately; baseline edit gated by confirm)

## Spec / Plan

- Spec: `docs/superpowers/specs/2026-05-24-cluster-identity-baseline-edit-design.md`
- Plan: `docs/superpowers/plans/2026-05-24-cluster-identity-baseline-edit.md`

## Test plan

- [x] `pnpm --filter @lcm/web test` — added 11 unit tests (5 identity + 6 baseline)
- [x] `pnpm --filter @lcm/web test:e2e` — added 2 e2e tests (rename + baseline confirm)
- [x] `pnpm -r typecheck` + `pnpm -r lint` clean
- [x] Visual walkthrough on cluster Settings tab

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Apply PR label**

```bash
gh pr edit <PR_NUMBER> --add-label "PR:Approved"
```

(If labels don't exist, see the global CLAUDE.md PR labeling convention.)

---

## Definition of done

- All 6 tasks complete and committed.
- `pnpm -r typecheck`, `pnpm -r lint`, `pnpm --filter @lcm/web test`, `pnpm --filter @lcm/api test`, `pnpm --filter @lcm/web test:e2e` all green.
- Visual walkthrough confirms:
  - Three sections on Settings tab in order: Thresholds, Cluster identity, Baseline.
  - Identity edit updates name/description; page H1 updates immediately.
  - Baseline edit opens confirm dialog; cancel closes without saving; confirm submits and forecast chart refetches.
- PR open with spec/plan links + test-plan checklist.
