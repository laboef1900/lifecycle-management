# Bulk date-shift idempotency — design

- **Issue:** [#263](https://github.com/laboef1900/lifecycle-management/issues/263)
- **Date:** 2026-07-20
- **Risk:** High (introduces a Prisma migration; see CLAUDE.md's Change Risk table)
- **Status:** Approved design; implementation not started

## Problem

`POST /api/items/bulk-shift-dates` (`ItemsService.bulkShiftDates`, `apps/server/src/services/items.ts`) applies a **relative** date delta to a set of items and their allocations. Applying the same request twice moves the dates twice — silently. Both requests return 200; nothing in the response or the UI signals that a double-submit happened. `effectiveDate` feeds the forecast directly, and the forecast drives hardware purchasing decisions, so this is a plausible-looking projection built on dates nobody chose, not just an annoying re-click.

Realistic triggers: an operator double-clicking "Shift N entries" before the dialog closes, or manually retrying after an ambiguous outcome (timeout, dropped connection, 500) where the UI can't tell them whether the first request landed. A genuine Postgres serialization conflict (`40001`) is already safe — it aborts the transaction and leaves data untouched. The risk is specifically about requests that _did_ commit.

Two `@ai-warning` markers already document the hazard (`packages/shared/src/schemas/item.ts` on `itemBulkShiftDatesInputSchema`, `apps/server/src/services/items.ts` on `bulkShiftDates`) — a note to future developers, not a guard.

## Decision

Full request-level idempotency via a client-supplied idempotency key, built as a **general mechanism** other mutating routes can opt into later — not hard-coded to this one endpoint — because a second migration later would cost more than designing for reuse now. `POST /api/items/bulk-shift-dates` is the first (and, for now, only) consumer.

This supersedes the cheaper alternative considered (an optimistic-concurrency guard on `Item.updatedAt`, Normal risk, no migration) — the owner chose the stronger guarantee, accepting the migration's High-risk classification and the rigor that comes with it.

## Architecture

### Data model

New table, purely additive:

```prisma
model IdempotencyKey {
  key            String   @id                          // client-supplied UUID v4
  route          String   @map("route")                // e.g. "POST /items/bulk-shift-dates"
  requestHash    String   @map("request_hash")          // sha256 of the normalized payload
  responseStatus Int      @map("response_status")
  responseBody   Json     @map("response_body")
  createdAt      DateTime @default(now()) @map("created_at")
  expiresAt      DateTime @map("expires_at")

  @@index([expiresAt])   // drives the cleanup sweep
  @@map("idempotency_keys")
}
```

`TenantSettings` (`apps/server/prisma/schema.prisma`) gains one field, following the existing `warnThreshold`/`critThreshold`/`procurementLeadTimeWeeks` pattern exactly:

```prisma
idempotencyKeyRetentionHours Int @default(24) @map("idempotency_key_retention_hours")
```

`expiresAt` is computed at **insert time** from the retention value in effect then. If the setting changes later, already-stored rows keep their original TTL — only new rows pick up the new value. This is a deliberate invariant, not an oversight.

No `tenantId` column: this app has no cross-tenant boundary in v1 by design (see "Resource ownership" in CLAUDE.md — every authenticated user shares the same tenant's data). Adding one here would be inventing an isolation property the rest of the schema doesn't have.

### Shared contract

New `packages/shared/src/schemas/idempotency.ts`:

```ts
export const idempotencyKeyHeaderSchema = z.string().uuid();
```

Exported so both the server (header validation) and the web client (key generation/typing) share one definition, per the shared-contract rule in CLAUDE.md.

### Service layer

A small `IdempotencyService` (constructor takes `PrismaClient`, matching every other service in `apps/server/src/services/`) with two methods, both designed to run **inside a caller's own transaction** rather than owning one itself:

- `lookup(tx, key, requestHash): Promise<{ status: number; body: unknown } | 'conflict' | null>`
- `record(tx, key, route, requestHash, status, body, retentionHours): Promise<void>`

This is deliberately not a generic Fastify-level "wrap any route" abstraction. Building that framework layer before a second consumer exists would be speculative generality the codebase doesn't need yet (YAGNI, per CLAUDE.md's guidance against designing for hypothetical future requirements). The "general mechanism" goal is satisfied by the table being keyed on `route` and the service being trivially reusable — a second endpoint adopts this by calling the same two methods inside its own transaction, no migration required.

### Route

Route handlers stay thin, matching every other route in `apps/server/src/routes/items.ts`:

```ts
fastify.post('/items/bulk-shift-dates', async (request) => {
  const idempotencyKey = idempotencyKeyHeaderSchema.parse(request.headers['idempotency-key']);
  const input = itemBulkShiftDatesInputSchema.parse(request.body);
  return service.bulkShiftDates(request.tenantId, input, idempotencyKey);
});
```

Missing or malformed header → 400, rejected before any transaction opens. The header, not a body field, carries the key — it's metadata about the request's delivery, not part of the domain payload, and keeping it out of `itemBulkShiftDatesInputSchema` avoids polluting that contract for every existing caller.

## Request flow

Inside `bulkShiftDates`'s existing `Serializable` transaction, **before** any item lookup or write:

1. **Normalize the payload for hashing.** `bulkShiftDates` today does `Array.from(new Set(input.itemIds))`, which dedupes but preserves first-occurrence order — so `[A,B,A]` and `[B,A,A]` (the same logical selection, submitted in a different order) would hash differently under a naive `JSON.stringify`. The hash instead dedupes **and sorts** `itemIds` ascending, pairs the result with `shift`, and SHA-256s that. Two requests naming the same items with the same shift always hash identically regardless of UI selection order.
2. **`IdempotencyService.lookup(tx, key, requestHash)`:**
   - No row → proceed with the shift exactly as today.
   - Row found, hash matches → return the stored `responseBody` immediately. Zero additional writes to `Item`/`ItemAllocation`.
   - Row found, hash differs → throw `409 IDEMPOTENCY_KEY_CONFLICT`. Nothing executes.
3. If it proceeded: run the existing find/validate/update logic unchanged, then — still inside the same transaction, immediately before returning — call `IdempotencyService.record(tx, key, route, requestHash, 200, responseBody, retentionHours)`.

**Why non-2xx responses are never cached, as an explicit invariant rather than an implementation accident:** every failure path (`NotFoundError`, `SHIFT_BATCH_TOO_LARGE`, a genuine `40001` serialization abort) throws before step 3, so the whole transaction — including any idempotency row — rolls back. A corrected retry under the _same_ key after a real failure sees no row and simply runs fresh. This is what makes "retry after a failed request still succeeds" true with no special-casing.

**Concurrent duplicates (double-click / two tabs):** both requests pass the lookup (neither sees the other's uncommitted row), both run the shift, both attempt to insert the same `key` at step 3. Postgres's serializable-snapshot-isolation detects the conflict and aborts one with `40001` — the same mechanism the existing code already relies on for its pre-existing "a genuine serialization conflict leaves data untouched" guarantee. The loser's request fails with a transient error; if the client retries with the _same_ key, it now sees the winner's committed row and gets the cached response instead of double-applying. This is documented as the expected behavior rather than built as new server-side retry logic — it reuses a guarantee the transaction isolation level already provides.

## Cleanup

Deliberately simpler than `apps/server/src/services/vsphere-scheduler.ts`. That scheduler needs claim/lease/backoff because it coordinates exclusive outbound calls to external vCenters. Cleanup here is just:

```sql
DELETE FROM idempotency_keys WHERE expires_at < now()
```

A plain `DELETE` is naturally safe to run concurrently from multiple instances with no coordination needed. The new piece borrows only the _shape_ of the existing pattern — `setInterval` + `.unref()`, started by a Fastify plugin with `autostart` gated off in test (mirroring every other background task in this codebase), drained via an `onClose` hook — at a fixed, non-configurable 15-minute tick. Fifteen minutes is cheap and more than tight enough given retention is measured in hours. The sweep is driven purely by each row's own stored `expiresAt`; it does not need to re-read `idempotencyKeyRetentionHours` to decide what to delete.

## Threat model / misuse cases

- **Same key reused with a different payload** → rejected with 409, never executed.
- **Header omitted** → 400, request refused before any DB work.
- **Cross-tenant replay** → not applicable; this app has no cross-tenant boundary in v1 by design, so the table keys on `key` alone with no `tenantId` — a deliberate decision, not an oversight, consistent with the rest of the schema.
- **Storage growth / abuse** → bounded by the existing `RATE_LIMIT_MAX` (300/min/IP) and the retention TTL; not a materially new DoS surface beyond what rate-limiting already bounds.
- **Stale replay data** → a replay can return a response that no longer matches live DB state if enough time passed within the retention window. Accepted by design (see "Replay staleness" below) and documented here rather than silently hidden.

## Invariants

1. A given `key` maps to at most one committed outcome, ever.
2. An unexpired replay with an unchanged payload returns the exact original response and performs zero writes to `Item`/`ItemAllocation`.
3. No idempotency record is ever persisted for a request that did not commit.
4. Expired keys are eventually purged. A well-behaved client never intentionally reuses a key past expiry, so post-expiry "reuse" is a fresh request, not a meaningful replay.
5. One TTL serves both cleanup and replay staleness — there is no separate, shorter "meaningful replay" window. Replay responses may be up to `idempotencyKeyRetentionHours` (default 24h) stale by design; this was chosen over a second, shorter window because the actual trigger scenarios (double-click, timeout retry) don't need finer granularity, and a second knob would add a code path to reason about for a case that doesn't call for it.

## Migration & rollback

Purely additive: one new table, one new `TenantSettings` column with a default — no existing data touched, since this is an ephemeral dedup cache, not business data. Rollback is a straightforward revert PR (route stops requiring the header, service stops calling `lookup`/`record`) plus a down-migration dropping the table/column.

## Settings UI

`TenantSettings.idempotencyKeyRetentionHours` is exposed in the existing Settings page alongside `warnThreshold`/`critThreshold`/`procurementLeadTimeWeeks` (`apps/web/src/components/settings/forecast-thresholds-form.tsx` is the pattern to extend, or a sibling form), following CLAUDE.md's rule that app configuration lives in the Settings UI, never a new env var.

## Testing

Testcontainers integration tests (`apps/server/src/__tests__/`):

- Replay with an unchanged payload returns the original response; no new writes to `Item`/`ItemAllocation`.
- Same key + different payload → 409, not executed.
- A genuinely failed request retried under the same key succeeds normally (no stale idempotency row survives the rollback).
- Concurrent duplicate submissions under the same key result in exactly one applied shift.
- Cleanup sweep deletes expired rows and leaves unexpired ones untouched.
- Hash normalization treats differently-ordered/duplicated `itemIds` as identical (unit test on the normalization function).
- Settings UI: the new retention field renders, validates, and saves (colocated Vitest + RTL, following `forecast-thresholds-form.test.tsx`'s pattern if one exists, else the nearest settings-form test).

## Out of scope

- A second mutating endpoint adopting this mechanism — the schema and service are shaped to allow it, but no other route is being changed as part of this work.
- A shorter/separate replay-staleness window (see invariant 5).
- Any change to the existing near-free UX mitigations discussed alongside this issue (hardening the dialog against re-submit, surfacing resulting dates in the success toast) — those remain optional, non-blocking companion improvements, not part of this design's acceptance criteria.
