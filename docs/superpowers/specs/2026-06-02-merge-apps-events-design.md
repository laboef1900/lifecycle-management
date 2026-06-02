# Merge Applications + Events into unified Items

**Date:** 2026-06-02
**Status:** Approved (design) — pending implementation plan
**Branch:** `feat/merge-apps-events`

## Summary

In the cluster detail view, Applications and Events are two separate tabs backed by
two separate tables. This change **physically merges them into one `items` entity**,
surfaces them in a single merged "Apps & Events" tab, and replaces the application's
free-form category string and the event's fixed category enum with a single
**tenant-managed category list** editable from the Settings page.

The category field in the item form becomes a **creatable combobox**: a dropdown of
managed categories that also accepts a freshly typed value, which is added to the
shared list on save.

### Confirmed decisions

- **Merge depth:** full physical merge — one real `items` table, data backfilled,
  forecast loader rewritten.
- **Forecast parity:** the forecast output must be **numerically identical** before
  and after the merge. This is a hard requirement and the primary safety constraint.
- **Removing a category that is in use:** **blocked** — the API refuses with a usage
  count; the user must reassign affected items first.
- **Typing a new category in the item form:** **added to the shared managed list**
  (auto-upserted on item save) so it appears in the dropdown everywhere afterward.

## Background: how the forecast uses each entity today

Confirmed from `apps/server/src/services/forecast.ts` and `forecast-loader.ts`:

- **Applications** contribute consumption as a **level**: for each forecast month, the
  active allocation amount (latest allocation `effectiveFrom <= month`, while the app
  is active between `startedAt`/`endedAt`) is summed into consumption.
- **Events** contribute as **step deltas**: `consumptionDelta` and `capacityDelta`
  accumulate permanently for every event with `effectiveDate <= month`.
- **Category does not drive forecast math.** It is a display label only. The single
  exception is a validation rule: a non-`note` event must carry at least one delta.

Because the two entities contribute differently, the merged `items` row must retain
**both** contribution modes (a tagged union in one table).

## 1. Data model (Prisma)

The `items` table **reuses the existing `applications` table** (renamed in-place) so
that existing application rows and ids are preserved and only events need to be copied
in. This makes application-side forecast parity trivial.

### `items` (was `applications`)

| column                                                    | applies to       | notes                                                            |
| --------------------------------------------------------- | ---------------- | ---------------------------------------------------------------- |
| `id`, `tenant_id`, `cluster_id`                           | both             | unchanged                                                        |
| `kind` _(new enum `item_kind`: `application` \| `event`)_ | both             | discriminator                                                    |
| `category` (String)                                       | both             | free-form name backed by the managed list                        |
| `name` (String)                                           | both             | application `name`; event `title` backfilled here                |
| `description` (String?)                                   | both             | unchanged                                                        |
| `effective_date` (Date)                                   | both             | **renamed from `started_at`**; for events = old `effective_date` |
| `ended_at` (Date?)                                        | application only | null for events                                                  |
| `metric_type_id` (String?) _(new)_                        | event only       | null for applications                                            |
| `consumption_delta` (Decimal?) _(new)_                    | event only       | null for applications                                            |
| `capacity_delta` (Decimal?) _(new)_                       | event only       | null for applications                                            |
| `created_at`, `updated_at`                                | both             | unchanged                                                        |

Indexes: keep `@@index([cluster_id])`; add `@@index([cluster_id, effective_date])`
(the events index) for date-sorted listing.

### `item_allocations` (was `application_metric_allocations`)

Renamed; FK `application_id` → `item_id`. Application-kind items only. Shape otherwise
unchanged (`metric_type_id`, `effective_from`, `amount`).

### `categories` _(new)_

```
id          String  @id @default(cuid())
tenant_id   String
name        String
created_at  DateTime @default(now())
@@unique([tenant_id, name])
```

### Dropped

- `events` table
- `event_category` enum

## 2. Backfill migration (custom SQL, `--create-only`)

Ordered steps, authored as raw SQL inside one Prisma migration:

1. `ALTER TABLE applications RENAME TO items;` then add `kind` (default `application`,
   then drop the default once backfilled), `metric_type_id`, `consumption_delta`,
   `capacity_delta`; `RENAME COLUMN started_at TO effective_date`. Create the
   `item_kind` enum first.
2. `ALTER TABLE application_metric_allocations RENAME TO item_allocations;`
   `RENAME COLUMN application_id TO item_id;` (rename FK constraint/index names).
3. Insert each `events` row into `items` with `kind='event'`: `title`→`name`,
   `effective_date`→`effective_date`, enum→display-name `category`
   (`growth`→`Growth`, `hardware_change`→`Hardware`, `openshift`→`OpenShift`,
   `note`→`Note`), copy `description`, `metric_type_id`, `consumption_delta`,
   `capacity_delta`; **reuse the event id**.
4. Create `categories`; seed with the **distinct `category` values now present in
   `items`** plus the four canonical event names (Growth / Hardware / OpenShift /
   Note) so they remain available even when unused. Backfill is faithful — no
   case-normalisation, so a free-form app `openshift` and an event-derived
   `OpenShift` may coexist; this is cleanable from Settings later.
5. `DROP TABLE events;` then `DROP TYPE event_category;`.

The seed script (`pnpm seed`) is updated to match the new schema and to seed the
default category set for a fresh database.

## 3. Forecast parity (hard requirement)

`computeForecast` and its in-memory `ForecastApplication` / `ForecastEvent` interfaces
stay **unchanged**. Only `forecast-loader.ts` changes: load `items` (with allocations),
partition by `kind`, and map each kind into the existing in-memory shape. The math is
byte-identical.

One type ripples outward: `ForecastEvent.category` and the forecast output
`events[].category` change from the `EventCategory` enum to `string`. The forecast
chart's category coloring switches to a **name-keyed palette** that preserves the
current looks (Growth = amber/warning, Hardware = green/success, OpenShift = default,
Note = outline) with a deterministic fallback for unknown names.

**Intentional behavior change:** the old "non-`note` event must carry a delta" rule is
dropped. With free-form categories there is no special `note` value, so any
`event`-kind item may be a pure annotation with both deltas null.

### Parity safety net

A test computes the forecast for the seeded reference clusters and asserts the output
is identical to a snapshot captured before the migration (or against a fixture derived
from the pre-merge code path). Loader partition tests cover the items→in-memory mapping.

## 4. Server (services + routes)

- New `ItemsService` and `CategoriesService`. Retire `applications` and `events`
  services.
- Routes:
  - `GET /clusters/:id/items` — merged, date-sorted list.
  - `POST /clusters/:id/items` — create (body discriminated by `kind`).
  - `PATCH /items/:id` — update (kind immutable).
  - `DELETE /items/:id`.
  - `POST /items/:id/allocations` — append allocation (application kind only;
    422 for event kind).
  - `GET /settings/categories` — list.
  - `POST /settings/categories` — add `{ name }` (idempotent upsert).
  - `DELETE /settings/categories/:id` — **409 with a usage count when in use**,
    otherwise deletes.
- Old `/applications` and `/events` routes are **removed** (the web app is the only
  client).
- On item create/update, the `ItemsService` **upserts the item's `category` into
  `categories`** for the tenant — this implements "typed category joins the shared
  list" with no extra UI wiring.

## 5. Shared schemas (`packages/shared`)

- New `schemas/item.ts`:
  - `itemKindSchema = z.enum(['application','event'])`.
  - `itemCreateInputSchema` — discriminated union on `kind`:
    - `application`: `name`, `category`, `description?`, `effectiveDate` (startedAt),
      `endedAt?`, `allocations[]` (min 1).
    - `event`: `name` (title), `category`, `description?`, `effectiveDate`,
      `metricTypeKey`, `consumptionDelta?`, `capacityDelta?` (both nullable; no
      note-only rule).
  - `itemUpdateInputSchema` — partial, kind not updatable.
  - `ItemResponse` — union type with `kind`, allocations present for applications.
- New category schemas: `categoryCreateInputSchema { name }`, `CategoryResponse
{ id, name }`.
- Remove `schemas/application.ts` and `schemas/event.ts` (fold needed types into
  `item.ts`); update `index.ts` exports and all importers.

## 6. Web UI (`apps/web`)

- **Merged tab "Apps & Events"** replaces the Applications and Events tabs in
  `clusters.$id.tsx`. A single date-sorted table:
  `Date · Type · Category · Name · Amount/Δ · Actions`. Application rows keep the
  expandable allocation timeline; the `Amount/Δ` cell shows current allocation for
  applications and the delta(s) for events. Row actions adapt to kind (applications
  keep resize/end; events keep edit/delete).
- **One "Add item" dialog** with an `Application | Event` segmented control at the top
  that reveals the relevant fields. Kind is **locked when editing**.
- **Category field = creatable combobox** via native `<input list>` + `<datalist>`
  populated from `GET /settings/categories`. Typing a new value is naturally allowed
  and persisted on save (server upsert).
- **Settings → new "Categories" card** (`apps/web/src/components/settings/`): lists
  managed categories, add (input + button), remove (blocked inline with the usage
  count surfaced from the 409 when in use).
- `api-client.ts` updated: replace `applications`/`events` clients with `items` +
  `settings.categories`. Old `applications-tab.tsx` / `events-tab.tsx` are removed or
  collapsed into the new merged tab component; their dialogs are merged into the new
  item dialog.

## 7. Testing

- Loader partition tests (items → in-memory app/event shapes).
- **Forecast-parity test** over seeded clusters (pre/post identical) — the key gate.
- `ItemsService` / `CategoriesService` unit tests (CRUD, category upsert on save,
  delete-blocked-when-in-use).
- Route tests for the new endpoints; removal of old route tests.
- Web tests: merged tab rendering, add-item dialog kind toggle, category combobox,
  Settings categories card (add + blocked-remove).

## 8. Out of scope (YAGNI)

- Per-category colors as stored config (deterministic palette instead).
- Per-cluster category lists (categories are tenant-wide, matching the Settings page).
- Backward-compatible `/applications` and `/events` API aliases.
- Bulk reassignment UI for categories (block-on-remove only; reassign is manual via
  editing items).

## Open implementation risks

- The rename-based migration must correctly rename FK constraints and indexes
  (`item_allocations.item_id`), and Prisma's migration history must stay consistent
  (author with `--create-only`, then verify `migrate diff` is clean against the schema).
- `Decimal` handling for the new event delta columns must mirror the existing
  `decimalToNullableNumber` conversions.
- The `category` type change from enum to string touches scenario/chart code paths —
  audit all `EventCategory` references.
