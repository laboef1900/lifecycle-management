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
4. A body carrying **both** shapes is a 400, never a guess — see below.

### Why additive rather than a clean cutover

`web` and `server` are separately-tagged GHCR images pinned by
`LCM_IMAGE_TAG`, so a hard cutover to `{ steps }` breaks any mixed-tag
deployment: a new SPA against an old server would 400. The union costs one
`.transform()` and matches how `acknowledgment` (#292) and `uncertainty` (#316)
were evolved. An old SPA keeps working against a new server forever.

### Why an ambiguous body must be rejected, not resolved

The first implementation of this design was a plain
`z.union([stack, bare])`, and AI review found it silently wrong — reproduced end
to end, not argued. For a body carrying both shapes
(`{kind, count, steps:[…]}`), `scenarioStackSchema` is a `strictObject` so it
rejects the extra `kind`/`count`; the union then falls through to the bare
branch, which is a discriminated union of **stripping** `z.object`s and discards
`steps` entirely. Result: 200, with a one-step forecast, and no signal that
anything was ignored.

It was worse than a dropped stack. Because the whole `steps` key vanished before
any stack rule ran, prefixing a valid bare scenario bypassed **both** the
`.max(MAX_SCENARIO_STEPS)` cap and the duplicate-kind refine that the entire
id-collision defence rests on — over-cap, duplicate-kind, empty, and even
`steps: 'not-an-array'` all returned 200.

So `scenarioRequestSchema` now opens with a guard: if the body has both a `steps`
key and a `kind` key, that is a validation error. This is the CLAUDE.md rule that
integrity failures must not fall back to a weaker default — for an endpoint whose
output drives hardware purchasing, a well-formed wrong answer is strictly worse
than a 400.

### Why canonicalise the order when the steps commute

They **do** commute today — verified, not assumed. `loseLargestHosts` ranks by
`capacityAt(host, baselineDate)`, which reads only `host.capacities[].effectiveFrom`;
`delayFutureCommissions` moves only `commissionedAt` / `projectedDecommissionAt`;
`addSyntheticVms` touches only `applications`. All six permutations of the three
kinds produce byte-identical output, including array ordering (`filter` and `map`
both preserve it), even for an adversarial host that is future-commissioned but
carries a large capacity row effective in the past.

So the fixed order buys nothing _today_ — it is a forward-looking guarantee that
the answer never depends on which order a client happened to serialise.

The testing trap here is subtle, and the first draft fell into it. An "order
matters" assertion would pass whatever the implementation did, so that was
rejected in favour of a permutation test over `applyScenarioStack` — but AI review
pointed out that assertion is _also_ unfalsifiable for the interesting reason:
`applyScenarioStack` sorts before folding, so its output is a pure function of the
step multiset and no non-commuting kind can ever make it differ. Both tests now
exist, with their jobs stated: the sorted permutation test pins the **sort**, and a
second test folds the transforms **raw** (no sort) to pin **commutativity** — that
one goes red the day a kind stops commuting. See INV-5.

### Why "each kind at most once" is a correctness rule, not a UI convenience

`addSyntheticVms` mints a deterministic id from the step's own values — before
this change, `` `__scenario:add_vms:${count}x${sizeGb}` `` with no step
discriminator — and `computeForecast` keys `applicationContributions` on a
`Map<id, …>`:
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
  silently corrupt the response. No consumer reads this id — it appears only at
  its definition in `scenario.ts` and in the test that pins the scoping — so
  changing its shape is not a contract change.

## Architecture

### Shared contract (`packages/shared/src/schemas/forecast.ts`)

```
MAX_SCENARIO_STEPS = 3

scenarioSchema            unchanged — one step
scenarioStackSchema       { steps: Scenario[] }, 1..MAX_SCENARIO_STEPS, unique kind
scenarioRequestSchema     ambiguity guard  ->  union(stack, single->{steps:[single]})
SCENARIO_STEP_ORDER       canonical apply/render order, exhaustive over Scenario['kind']
compareScenarioSteps      sort comparator over the above
```

`SCENARIO_STEP_ORDER` lives in the shared package rather than beside the fold
because **both** sides need it: the server sorts by it, and the rail renders its
removable rows and composes its summary text by it. Two copies would let the UI
list one order while the forecast folds in another — the CLAUDE.md rule that
anything used by both server and web belongs here, not duplicated.

`scenarioSchema` stays exported: a step _is_ a scenario. Its three members are
`strictObject` like the container, so a step carrying another kind's fields is a
400 rather than a silent narrowing. Types:
`ScenarioStack`, `ScenarioRequest`, and the wire-side `ScenarioStackWire`.
`ScenarioRequestWire` is written out as `ScenarioStackWire | z.input<typeof
scenarioSchema>` rather than derived, because the schema now opens with the
ambiguity guard on `z.unknown()` and its `z.input` is therefore `unknown`. Being
hand-written it is the one wire type nothing type-checks against its schema, so a
test pins it in both directions: samples annotated `ScenarioRequestWire` (too
narrow ⇒ compile error) that are each parsed (too wide ⇒ test failure).

The cap is expressed as `.max(MAX_SCENARIO_STEPS)` **and** a uniqueness refine.
They are independent rules: uniqueness happens to imply ≤ 3 while there are
exactly three kinds, and stops implying it the moment a fourth is added.

### Server fold (`apps/server/src/services/scenario.ts`)

`applyScenarioStack(input, steps)` is new: it sorts a copy of the steps into
canonical order and reduces `applyScenario` over them.

`applyScenario` is **not** unchanged — an earlier draft of this document claimed
it was, which AI review correctly flagged. It gained a third parameter,
`stepIndex`, and the synthetic id it mints changed shape accordingly. That
parameter is **required**, deliberately: it briefly had a `= 0` default, which
meant a hand-rolled fold (`for (const s of steps) acc = applyScenario(acc, s)`)
typechecked, ran, and minted the same id for every step — silently defeating the
very defence the index exists to provide. Prefer `applyScenarioStack`; folding by
hand now forces you to state the index.

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
- **INV-4 — at most one step per kind, ≤ 3 steps.** Enforced in Zod at the route
  **and** re-checked inside `applyScenarioStack`, which throws. The fold is
  exported and takes a bare array, so it cannot assume its caller validated —
  today's single caller does, and the guard is for the next one.
- **INV-5 — the answer is independent of step order.** Pinned by TWO tests,
  because one of them cannot fail for the interesting reason. The permutation test
  over `applyScenarioStack` is true _by construction_ (sorting makes the output a
  pure function of the step multiset) and exists to pin the sort itself. The test
  that can actually fail folds the transforms **without** the sort, so the day a
  kind stops commuting it goes red — at which point the canonical order stops
  being an arbitrary tie-break and starts deciding the forecast. AI review caught
  the original single test claiming a tripwire it could never trip; the real
  tripwire for a _new_ kind is a pair of compile errors — TS2741 from the
  exhaustive `SCENARIO_STEP_ORDER: Record<Scenario['kind'], number>` in
  `@lcm/shared`, and TS2366 from `applyScenario`'s switch under its explicit
  return type. (An earlier draft credited `noFallthroughCasesInSwitch`; that flag
  only reports a case falling THROUGH to the next one and says nothing about a
  missing case. Both real errors were confirmed by adding a fourth kind during AI
  review.)
- **INV-6 — bounded compute.** ≤ 3 steps × the existing
  `MAX_FORECAST_SPAN_MONTHS = 120` window cap, one synthetic application per
  `add_vms`. Bounded at both the boundary and the fold (see INV-4).

## Threat model / misuse cases

Trust boundary: the HTTP request body, parsed by Zod _inside_ the handler before
anything touches the database. The route is read-only — it computes and returns a
forecast and writes nothing.

| Misuse                                                                                                                               | Defence                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unbounded `steps` array as a compute-amplification lever                                                                             | `.max(3)` in Zod at the boundary, **and** re-checked inside `applyScenarioStack` so the fold holds INV-6 for any caller; the 1 MiB body limit and the 120-month window cap are unchanged |
| Duplicate `add_vms` to corrupt `applicationContributions`                                                                            | Zod uniqueness at the boundary (primary), re-checked in `applyScenarioStack`, + step-scoped synthetic id (defence in depth)                                                              |
| VIEWER escalation via a new route path                                                                                               | Path unchanged, so the `READ_ONLY_MUTATION_ROUTES` allowlist and its two tests still apply                                                                                               |
| Unknown/typo'd key (`parts` instead of `steps`) silently dropping the stack                                                          | The union has no branch that accepts an object without `steps` or `kind`, so a typo is a 400, not a silent single-step preview                                                           |
| A step carrying another kind's fields (`{kind:'lose_hosts', count:1, months:3}`) being silently narrowed                             | The step schemas are `strictObject` too, not just the container, so the mismatch is a 400 rather than a dropped intent                                                                   |
| A body carrying BOTH shapes resolving to the narrower one — silently discarding the stack AND bypassing the cap and uniqueness rules | The ambiguity guard rejects it (see above). Reproduced against the first implementation; now covered at both the contract and HTTP layers                                                |
| A hypothetical acquiring measured evidence and reading as a real forecast                                                            | INV-1, re-proved on the compound path with a positive control on both halves                                                                                                             |

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
  scenario normalises to one step; stack round-trips; over-cap rejected;
  duplicate kind rejected; empty `steps` rejected; typo'd key rejected;
  ambiguous both-shapes body rejected, including each rule it used to bypass.
  The over-cap test asserts the cap's **own** `too_big` issue rather than mere
  rejection: with exactly three kinds, any over-length array necessarily repeats
  a kind, so a bare `success === false` passes with `.max()` deleted (AI review
  verified that confound).
- `apps/server` unit — fold applies all three kinds; **all six permutations
  produce identical output** (INV-5); canonical order is applied regardless of
  input order; no mutation of the input across steps (INV-2); step-scoped
  synthetic ids are distinct.
- `apps/server` integration — the compound fixture seeds **two real hosts** (one
  deployed with recorded capacity, one commissioning inside the window) so all
  three step kinds are provably effective. AI review found the first version ran
  against a host-less cluster, where `lose_hosts` and `delay_procurement` do
  nothing and a route folding only `steps[0]` kept every test green. Each single
  step is now asserted to move the forecast _before_ the compound is compared
  against it, and the compound must differ from every single step.
- `apps/server` integration — legacy bare body still 200 (back-compat); over-cap,
  duplicate-kind, and ambiguous bodies → 400; INV-1 shape re-proved on the HTTP
  response.
- **INV-1's real defence is a positive control** in `forecast-uncertainty.test.ts`:
  on one cluster with seeded snapshots, `forCluster` is asserted to EARN a band
  while `forClusterWithScenario` is asserted to refuse one. Without that, both
  sides are `undefined` regardless of wiring — AI review demonstrated the merged
  entry point leaving the whole suite green.
- **Mutation-verified.** Each of the four defences above was checked by breaking
  it and confirming the suite goes red: route folds `steps.slice(0, 1)` → 3
  failures; merged entry point → the INV-1 positive control fails; `.max()`
  deleted → the cap test fails; ambiguity guard removed → 2 failures at each of
  the contract and HTTP layers.
- Clock, two different strategies for two layers. The pure unit tests pin it
  (`vi.useFakeTimers`), because `addSyntheticVms` defaults `startedAt` to
  `new Date()` and `delayFutureCommissions` compares against it. The HTTP-level
  integration tests deliberately do NOT — fake timers fight `server.inject` — so
  their fixture is instead computed RELATIVE to the real clock (baseline at +0,
  deployed host at −6, commissioning at +6, window +1..+12). Hard-coded months
  would have re-introduced the vacuity they exist to prevent the moment the wall
  clock passed them; the first version had roughly an 11-month shelf life.

## Out of scope

- Per-step evidence in the response. The response shape is deliberately
  unchanged; the UI composes its own compound label from the steps it sent.
- Repeated same-kind steps (stacking two `lose_hosts`). Rejected by INV-4; it
  composes meaningfully for `lose_hosts` and `delay_procurement` but not for
  `add_vms`, and a per-kind rule is the honest cap until there is a reason to
  split it.
- The stack UI — PR 2.
