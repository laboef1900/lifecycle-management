# Cluster identity + baseline edit — design spec

**Date:** 2026-05-24
**Status:** Approved, ready for implementation plan
**Sub-project:** 2 of 3 (preceded by configurable thresholds; followed by delete/archive)
**Scope:** Let operators edit a cluster's name, description, baseline date, and per-metric baseline (consumption + capacity) from the Settings tab on the cluster detail page. The PUT endpoint already exists; this work is purely the web-side form + a missing api-client method.

## Why

Today the only way to change a cluster's name is to drop into the database. The Settings tab introduced in sub-project 1 is the natural home for identity edits — same place users go to override thresholds. Baseline edits are rarer but happen when an operator realizes the original baseline numbers were wrong, or when a major hardware change resets the cluster's "starting point." The PUT endpoint already supports both; only the UI is missing.

The baseline edit is meaningfully more dangerous than the identity edit: it rewrites every forecast point. The design treats it as a separate section with a confirm dialog so users can't fat-finger their forecast history away.

## Design principles

1. **Two scopes, two saves.** Identity (name + description) and baseline (date + values) are independent operations. One Save button each, scoped to its own fields. Avoids accidental cross-field saves and matches how users think about the operations.
2. **Confirm the destructive case.** Identity edits go straight through. Baseline edits prompt a confirmation dialog before submitting. The dialog spells out the consequence ("rewrites every forecast point") so users understand what they're agreeing to.
3. **Invalidate the right caches.** Identity edits invalidate `['cluster', id]`. Baseline edits invalidate both `['cluster', id]` and `['forecast', id, ...]` because the forecast must recompute.
4. **No backend changes.** Everything is plumbing on top of the existing `PUT /api/clusters/:id`. Don't grow the API just because we have a new UI.

## What changes

### 1. Web client method

Add `api.clusters.update(id, input)` to `apps/web/src/lib/api-client.ts`. The shape mirrors the wire format already used by `api.clusters.create`:

```ts
update: (id: string, input: ClusterUpdateInputWire) =>
  request<ClusterResponse>(`/api/clusters/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  }),
```

`ClusterUpdateInputWire` is the wire variant of `ClusterUpdateInput` from `@lcm/shared`, mirroring how `ClusterCreateInputWire` is defined today (any `Date` fields serialize as ISO strings; per-metric baselines come through as `metricTypeKey + baselineConsumption + baselineCapacity`).

The endpoint already enforces "at least one of name/description/baselineDate/baselines provided" via the schema's `.refine()`. The web client passes only the fields the user changed.

### 2. Identity form (Section A)

`apps/web/src/components/clusters/cluster-identity-form.tsx` — a Card containing:

- **Name** — `<Input>`, required, server-validates 1–120 chars. Inline error on blur if empty or too long.
- **Description** — `<textarea>` (or a multiline-styled `<Input>` if that's the codebase convention), optional, 0–2000 chars. Empty input sends `null` to clear an existing description.
- **Save** button — disabled when no field differs from server state OR while mutation is pending.

The dirty check anchors on the cluster query data the form loads from. Use the "edit overrides server" pattern from sub-project 1's `ForecastThresholdsForm` (lint enforces no useEffect-driven state sync):

```ts
const cluster = useQuery({
  queryKey: ['cluster', clusterId],
  queryFn: () => api.clusters.get(clusterId),
});
const [nameEdit, setNameEdit] = useState<string | null>(null);
const [descriptionEdit, setDescriptionEdit] = useState<string | null>(null);
const name = nameEdit ?? cluster.data?.name ?? '';
const description = descriptionEdit ?? cluster.data?.description ?? '';
```

Submit handler sends only changed fields:

```ts
const input: ClusterUpdateInputWire = {};
if (nameEdit !== null && nameEdit !== cluster.data?.name) input.name = nameEdit;
if (descriptionEdit !== null && descriptionEdit !== (cluster.data?.description ?? '')) {
  input.description = descriptionEdit === '' ? null : descriptionEdit;
}
mutation.mutate(input);
```

On success: clear edit state, write to `['cluster', clusterId]` cache. The page header (which reads `clusterQuery.data.name`) re-renders automatically.

### 3. Baseline form (Section B)

`apps/web/src/components/clusters/baseline-edit-form.tsx` — a Card containing:

- **Baseline date** — `<Input type="date">` with the cluster's current baseline date as default. Inline validation: must be a valid date.
- **Per-metric block** — one block per metric in `cluster.metrics` (today only `memory_gb`):
  - Heading: the metric's display name (e.g. "Memory (GB)")
  - Two `<Input type="number">` fields: `Baseline consumption`, `Baseline capacity`
  - Both required, positive, accept decimals. Server schema is `positiveAmount`.
- **Save** button — disabled when no field changed OR mutation pending. On click: opens the confirm dialog.

The confirm dialog (a `<Dialog>`):

- **Title:** "Rewrite baseline?"
- **Body:** "Changing the baseline date or values rewrites every forecast point for this cluster. Confirm only if you intentionally want to reset historical assumptions."
- **Buttons:** "Cancel" (closes the dialog), "Rewrite baseline" (variant=destructive; closes the dialog AND submits the mutation).
- Dialog uses the existing `Dialog` primitive — same component as `confirm-dialog.tsx` uses today.

Submit handler builds the PUT body with whichever fields changed:

```ts
const input: ClusterUpdateInputWire = {};
if (dateEdit !== null && dateEdit !== cluster.data?.baselineDate) input.baselineDate = dateEdit;
if (baselinesDirty) input.baselines = buildBaselinesPayload();
mutation.mutate(input);
```

`baselinesDirty` is true if any per-metric field changed. `buildBaselinesPayload()` returns the full array — the schema requires `baselines` to be a non-empty array, not a partial diff. Send all baselines even if only one changed.

On success: clear edit state, write to `['cluster', clusterId]` cache, invalidate `['forecast', clusterId]` queries (any `from`/`to` permutation) so the chart refetches.

### 4. SettingsTab — stack the three sections

`apps/web/src/components/clusters/settings-tab.tsx` currently mounts only `ThresholdOverridesForm`. Extend to three sections stacked with `space-y-6`:

```tsx
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

Order: thresholds (most-used) → identity (occasional) → baseline (rare + destructive). Destructive section at the bottom matches common UI conventions for cluster/repo settings pages.

## Files

**New:**

- `apps/web/src/components/clusters/cluster-identity-form.tsx`
- `apps/web/src/components/clusters/cluster-identity-form.test.tsx`
- `apps/web/src/components/clusters/baseline-edit-form.tsx`
- `apps/web/src/components/clusters/baseline-edit-form.test.tsx`

**Modified:**

- `apps/web/src/lib/api-client.ts` — add `api.clusters.update(id, input)`
- `apps/web/src/components/clusters/settings-tab.tsx` — mount the two new sections
- `apps/web/playwright/settings.spec.ts` — add an e2e test for the identity + baseline flow

**No changes:**

- Backend (`apps/api/`, `packages/shared/`) — `PUT /api/clusters/:id` and the schemas already support the full edit surface.
- Prisma — no migration.

## Testing

**Unit (web):**

- `cluster-identity-form.test.tsx`:
  - Loads and displays current name/description
  - Disables Save until a field changes
  - Submits only changed fields (name only / description only / both)
  - Description cleared to empty submits as `null`
  - Inline error when name is empty after blur
  - On save success, edit state clears and cache updates
- `baseline-edit-form.test.tsx`:
  - Loads and displays current baselineDate + per-metric values
  - Disables Save until a field changes
  - Save click opens the confirm dialog (does NOT submit immediately)
  - Cancel in the dialog closes it without submitting
  - Confirm in the dialog submits the PUT with the changed fields
  - On save success, edit state clears and BOTH cluster + forecast caches update

**E2E (Playwright):**
Extend `apps/web/playwright/settings.spec.ts` with one new test:

1. Open `/clusters/<id>` → Settings tab.
2. Edit name → "Renamed CL". Click Save. Header H1 updates within one refetch.
3. Edit baseline consumption from N to N×2. Click Save → confirm dialog appears. Click "Rewrite baseline". Dialog closes.
4. Verify the Capacity forecast chart's first month value reflects the new baseline (chart fetches twice — initial + after invalidation).

## Definition of done

- All three forms (Thresholds + Identity + Baseline) render on the Settings tab.
- Identity edit updates name/description without a confirm dialog; the page header H1 updates immediately.
- Baseline edit opens a confirm dialog; on confirm, both the cluster header and the forecast chart reflect the new values.
- All form unit tests pass; e2e walkthrough passes.
- `pnpm -r typecheck`, `pnpm -r lint`, `pnpm --filter @lcm/web test`, `pnpm --filter @lcm/web test:e2e` all green.
- `api.clusters.update(id, input)` exists with `ClusterUpdateInputWire` typing matching the existing wire-format pattern.

## Out of scope

- Delete / archive a cluster (sub-project 3).
- Adding a new metric to an existing cluster (the current data model assumes one metric per cluster at v1).
- Soft-delete or audit trail of edits.
- Bulk identity edits across multiple clusters.
