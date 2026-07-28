# Compound scenario stack — design (#323)

Status: implemented, PR 1 of 2 (contract + server fold). PR 2 is the stack UI.
Risk: **High** — changes a shared `@lcm/shared` API contract and is
forecast-adjacent. Approval per CLAUDE.md _Automated high-risk approval_.

## Problem

`Scenario` is a single discriminated union and `applyScenario` applies exactly
one member. The scenario rail therefore models one what-if at a time, but the
question operators actually ask is compound: _if we lose two hosts **and** the
order slips three months, when do we breach?_ Answering it today means running
two previews and doing the arithmetic by eye — which is precisely the kind of
manual capacity arithmetic this app replaced.

## Decision

Make the request contract composable **additively**, fold the steps
deterministically on the server, and leave the response shape untouched.

1. `@lcm/shared` gains `scenarioStackSchema` (`{ steps: Scenario[] }`) and
   `scenarioRequestSchema`, a union that accepts **either** the existing bare
   `Scenario` **or** a stack, normalising the bare form to `{ steps: [single] }`.
2. `applyScenarioStack` folds the steps in a fixed canonical order —
   `lose_hosts` → `add_vms` → `delay_procurement` — regardless of the order the
   client sent them in.
3. The route keeps its existing path and its existing response.

### Why additive rather than a clean cutover

`web` and `server` are separately-tagged GHCR images pinned by
`LCM_IMAGE_TAG`, so a hard cutover to `{ steps }` breaks any mixed-tag
deployment: a new SPA against an old server would 400. The union costs one
`.transform()` and matches how `acknowledgment` (#292) and `uncertainty` (#316)
were evolved. An old SPA keeps working against a new server forever.

### Why canonicalise the order when the steps commute

They **do** commute today — verified, not assumed. `loseLargestHosts` ranks by
`capacityAt(host, baselineDate)`, which reads only `host.capacities[].effectiveFrom`;
`delayFutureCommissions` moves only `commissionedAt` / `projectedDecommissionAt`;
`addSyntheticVms` touches only `applications`. All six permutations of the three
kinds produce byte-identical output, including array ordering (`filter` and `map`
both preserve it), even for an adversarial host that is future-commissioned but
carries a large capacity row effective in the past.

So the fixed order buys nothing _today_ — it is a forward-looking guarantee that
the answer never depends on which order a client happened to serialise. The risk
that creates is a vacuous test: an "order matters" assertion would pass whatever
the implementation did. This design therefore pins **permutation-invariance of
the current kinds** instead, so the day a non-commuting kind is added, the test
fails and forces the author to think about the fold order.

### Why "each kind at most once" is a correctness rule, not a UI convenience

`addSyntheticVms` mints a deterministic id, `` `__scenario:add_vms:${count}x${sizeGb}` ``,
and `computeForecast` keys `applicationContributions` on a `Map<id, …>`:
`set(app.id, [])` per application, then `get(app.id)?.push(…)` per month, then
`get(app.id) ?? []` per output entry. Two `add_vms` steps sharing an id therefore
emit **two response entries carrying the same aliased array**, with two amounts
per month under one id and one name — a wrong response, not a rejected request.
Month totals stay correct (the consumption sum iterates the array, not the Map),
which is exactly why no existing assertion catches it.

Two independent defences, both implemented:

- **Primary:** `scenarioStackSchema` rejects a duplicate `kind` in Zod, so the
  collision is unreachable through the API.
- **Defence in depth:** the synthetic id is now step-index-scoped
  (`__scenario:<i>:add_vms:…`), so relaxing the uniqueness rule later cannot
  silently corrupt the response. Nothing reads this id — it appears exactly once
  in the codebase, at its definition — so scoping it is not a contract change.

## Architecture

### Shared contract (`packages/shared/src/schemas/forecast.ts`)

```
MAX_SCENARIO_STEPS = 3

scenarioSchema            unchanged — one step
scenarioStackSchema       { steps: Scenario[] }, 1..MAX_SCENARIO_STEPS, unique kind
scenarioRequestSchema     union(stack, single→{steps:[single]})
```

`scenarioSchema` stays exported and unchanged: a step _is_ a scenario. Types:
`ScenarioStack`, `ScenarioRequest`, and the wire-side `ScenarioStackWire` /
`ScenarioRequestWire` (`z.input`, so `startMonth` is `'YYYY-MM'` rather than a
`Date`).

The cap is expressed as `.max(MAX_SCENARIO_STEPS)` **and** a uniqueness refine.
They are independent rules: uniqueness happens to imply ≤ 3 while there are
exactly three kinds, and stops implying it the moment a fourth is added.

### Server fold (`apps/server/src/services/scenario.ts`)

`applyScenario(input, scenario)` is unchanged and still exported — it is the
per-step body. New: `applyScenarioStack(input, steps)`, which sorts a copy of the
steps into canonical order and reduces `applyScenario` over them.

`addSyntheticVms` gains a step index, which scopes its synthetic **id** only. The
user-visible `name` stays unindexed: one `add_vms` per stack means it is already
unambiguous, and an index would just be noise on screen.

### Loader (`apps/server/src/services/forecast-loader.ts`)

`forClusterWithScenario`'s 4th parameter widens from `Scenario` to
`readonly Scenario[]`. The method body stays three statements —
`prepare()` → `applyScenarioStack()` → `finalize()`. `prepare()` is still called
**once**, which matters beyond efficiency: `prepared.capacitySignature`,
`anchorMonth`, and `baselineHistory` describe the real loaded state, and the
order-approval coverage rule (#292) depends on the signature being scenario-free.

### Route (`apps/server/src/routes/forecast.ts`)

`scenarioRequestSchema.parse(request.body)` replaces `scenarioSchema.parse(...)`,
and the normalised `steps` array is passed through. **The path does not change** —
`/api/clusters/:id/forecast/scenario` is on `READ_ONLY_MUTATION_ROUTES`
(`plugins/auth.ts`), the allowlist that exempts this one mutating route from the
admin gate so VIEWERs can run previews. A new path would 403 every VIEWER.

## Invariants

- **INV-1 — a hypothetical carries no measured evidence.** A compound scenario
  response has `acknowledgment === null` and no `uncertainty` key. This holds
  _structurally_: `finalize` hardcodes `acknowledgment: null` and
  `computeUncertainty` has exactly one call site, inside `forCluster`.
  `forClusterWithScenario` must keep returning `finalize(...)` directly. Merging
  the two entry points into one shared method — tempting while adding a stack —
  would silently hand scenarios a band and an acknowledgment.
- **INV-2 — no mutation of the caller's input.** Every step returns a new
  `ForecastInput`; the loader recomputes the baseline from the same read. Note
  that `applyScenario` returns the _identical reference_ for its no-op branches
  (`count <= 0`, `months <= 0`), so the fold must not assume a fresh object per
  step. Those branches are unreachable through the API (both schemas are
  `int().min(1)`).
- **INV-3 — one `prepare()` per request** (see Loader above).
- **INV-4 — at most one step per kind, ≤ 3 steps**, enforced in Zod.
- **INV-5 — the answer is independent of step order** for the current three
  kinds, pinned by a permutation test rather than assumed.
- **INV-6 — bounded compute.** ≤ 3 steps × the existing
  `MAX_FORECAST_SPAN_MONTHS = 120` window cap, one synthetic application per
  `add_vms`.

## Threat model / misuse cases

Trust boundary: the HTTP request body, parsed by Zod _inside_ the handler before
anything touches the database. The route is read-only — it computes and returns a
forecast and writes nothing.

| Misuse                                                                      | Defence                                                                                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Unbounded `steps` array as a compute-amplification lever                    | `.max(3)` in Zod; the 1 MiB body limit and the 120-month window cap are unchanged                                              |
| Duplicate `add_vms` to corrupt `applicationContributions`                   | Zod uniqueness (primary) + step-scoped synthetic id (defence in depth)                                                         |
| VIEWER escalation via a new route path                                      | Path unchanged, so the `READ_ONLY_MUTATION_ROUTES` allowlist and its two tests still apply                                     |
| Unknown/typo'd key (`parts` instead of `steps`) silently dropping the stack | The union has no branch that accepts an object without `steps` or `kind`, so a typo is a 400, not a silent single-step preview |
| A hypothetical acquiring measured evidence and reading as a real forecast   | INV-1, re-proved on the compound path                                                                                          |

No new persistence, no new external calls, no secrets, no PII. Nothing about the
request is logged beyond the existing request-id-correlated access log.

## Failure & recovery

- Invalid body → 400 from the in-handler Zod parse, generic sanitised message
  from the `error-handler` plugin. No partial application: the fold never starts.
- Unknown cluster → 404, unchanged.
- There is no new failure mode with state: the endpoint is a pure read, so a
  failed request leaves nothing behind and a retry is safe. No idempotency key is
  needed (contrast #263, which is about mutating routes).

## Rollback

Fully additive and stateless — no migration, no data, no config. Reverting the
commit restores the previous behaviour with no cleanup, and because the old bare
`Scenario` body stays valid throughout, an old SPA works against the new server
and a new SPA (PR 2) works against a rolled-back server only for single-step
previews (it would 400 on a stack, visibly, not silently). Deployments pin
`LCM_IMAGE_TAG`, so rollback is a tag change.

## Testing

- `packages/shared` — first scenario contract tests in that package: bare
  scenario normalises to one step; stack round-trips; 4 steps rejected;
  duplicate kind rejected; empty `steps` rejected; typo'd key rejected.
- `apps/server` unit — fold applies all three kinds; **all six permutations
  produce identical output** (INV-5); canonical order is applied regardless of
  input order; no mutation of the input across steps (INV-2); step-scoped
  synthetic ids are distinct.
- `apps/server` integration — compound 200 with a consumption delta that is the
  composition of its parts; legacy bare body still 200 (back-compat); over-cap
  and duplicate-kind → 400; INV-1 re-proof on a compound with the band enabled.
- Clock: any stack test pins the clock (`vi.useFakeTimers`) because
  `addSyntheticVms` defaults `startedAt` to `new Date()` and
  `delayFutureCommissions` compares against `new Date()`.

## Out of scope

- Per-step evidence in the response. The response shape is deliberately
  unchanged; the UI composes its own compound label from the steps it sent.
- Repeated same-kind steps (stacking two `lose_hosts`). Rejected by INV-4; it
  composes meaningfully for `lose_hosts` and `delay_procurement` but not for
  `add_vms`, and a per-kind rule is the honest cap until there is a reason to
  split it.
- The stack UI — PR 2.
