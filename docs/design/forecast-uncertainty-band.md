# Design proposal — Forecast uncertainty band (opt-in)

**Status:** Design APPROVED by owner 2026-07-24 (§9). **Risk:** High (forecast-engine, purchasing-critical). **Author:** AI (impeccable shape), 2026-07-24. Ready to become an implementation plan; the build still requires the full high-risk rigor in §7.

## 9. Owner decisions (2026-07-24)

1. **Methodology: A1 (snapshot-forward).** The band appears once a cluster has enough real anchors of measured error; no risky backfill.
2. **Minimum anchors (K): default 6, CONFIGURABLE** in Settings → Forecasting.
3. **Band width: CONFIGURABLE** in Settings → Forecasting, with a sensible default (proposed p10/p90 — the widest honest reading; confirm during build).
4. **Spec non-goal OVERRIDDEN.** Amend `2026-07-16-mission-bento-ui-design.md:107` to record "empirical, opt-in uncertainty band" as the superseding decision (cite this doc).

So Settings → Forecasting gains **three** controls, not one: an on/off toggle, the minimum-anchors number, and the band-width selector.

## 1. Problem

Both critique reviewers flagged the same gap: the measured consumption series is scrupulously honest (`connectNulls={false}`, no interpolation, unknown shown as unknown), but the **forecast projection** is a single confident dashed line with no expression of uncertainty — "the honesty stance stops exactly where the money is spent." The owner asked to add an **uncertainty band, gated behind a setting** (off by default), to reconcile it with the spec's non-goal.

## 2. The core tension (why this isn't a quick toggle)

- The forecast is a **deterministic pure function** over baselines/hosts/apps/events (PRODUCT.md). It has **no intrinsic statistical uncertainty** to draw. A band pulled from nothing would be _fabricated_ — violating the product's "confidently-wrong is worse than unknown; do not fabricate" principle and the tracked spec's explicit non-goal (`2026-07-16-mission-bento-ui-design.md:107`, "Forecast uncertainty bands (engine is deterministic — do not fabricate)").
- Making it a **setting, off by default** addresses the _spec-override_ half (the owner opts in deliberately) but **not** the _fabrication_ half. The band must be **measured, not invented**.

## 3. Methodology — DECISION NEEDED

The only honest band is **empirical**: derived from how wrong past forecasts turned out to be.

| Option                                         | What the band means                                                               | Honesty                                           | Feasible now?                               |
| ---------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- |
| **A. Empirical re-anchor error (recommended)** | The observed spread of (forecast − actual) at past monthly re-anchors, by horizon | ✅ measured                                       | ⚠️ needs error data we don't store yet (§4) |
| B. Labeled fixed ± envelope                    | A configured ±X% cone, labeled "illustrative, not measured"                       | ⚠️ honest only if labeled loudly; still arbitrary | ✅ trivial                                  |
| C. Do nothing                                  | —                                                                                 | ✅                                                | ✅                                          |

**Recommendation: Option A.** It's the only version that earns its place on a purchasing surface. B risks reintroducing exactly the "confident-looking but arbitrary" quality the honesty stance rejects; if chosen, its label must make "not a measured prediction" unmissable and it must never be the default.

## 4. Data prerequisite (the crux — surfaced during shaping)

**The system does not persist computed forecasts today** (schema has `ClusterBaselineHistory` but no forecast-snapshot table; nothing in `apps/server/src` stores a forecast). So the (forecast − actual) error series for Option A **does not exist yet**. Two ways to get it:

- **A1 — Snapshot forward (clean, slow):** at each monthly re-anchor, persist the forecast the engine produced. After N months, compare each stored forecast to the now-measured actual → real error distribution. Band is **empty/hidden until enough history accrues** (e.g. ≥6 anchors). Honest and simple; the feature ships "on" but shows nothing until it has earned a band.
- **A2 — Backfill by reconstruction (fast, complex, risky):** re-run the pure forecast function at past anchor months using the time-scoped historical state (`ClusterBaselineHistory` + time-scoped host membership + measurements) and compare to later actuals. Gives a band immediately but is error-prone and must exactly reproduce the engine's past behavior — a correctness minefield on a purchasing surface.

**Recommendation: A1** (snapshot forward). Start collecting now; reveal the band once each cluster has enough anchors. A2 only if the owner needs a band before ~6 months of accrual and accepts the reconstruction risk.

## 5. Proposed shape (if A1 approved)

- **Backend:**
  - New `ForecastSnapshot` model (clusterId, metricKey, anchorMonth, horizonMonth, projectedValue, capturedAt) written by the existing monthly re-anchor snapshot job.
  - A pure `computeForecastError(snapshots, measurements)` → per-horizon error quantiles (p10/p90 or ±1σ). Fully unit-tested; **it is forecast-engine code → full high-risk rigor.**
  - Expose `forecast.uncertainty?: { horizonMonth, low, high }[]` on the forecast response DTO (`@lcm/shared` schema) **only when** (a) the setting is on AND (b) enough anchors exist; otherwise omit (honest absence, not zeros).
- **Settings (`TenantSettings`, all in Settings → Forecasting):**
  - `forecastUncertaintyBandEnabled: boolean` — default **false** (satisfies the spec-override / opt-in requirement).
  - `forecastUncertaintyMinAnchors: number` — default **6**, bounded (e.g. 3–24); below this a cluster shows no band.
  - `forecastUncertaintyBandWidth: 'p10_p90' | 'p05_p95' | 'stddev'` — default **`p10_p90`**.
  - All three added to the `TenantSettings` Zod schema in `@lcm/shared` (contract-first), consumed by the settings form and the forecast service.
- **UI (`ForecastChart`, cluster detail only — NOT the fleet tile sparkline):** a translucent band (Recharts `Area` between low/high) behind the consumption line, in a muted neutral (not amber/violet/steel — it's context, not a series). Legend entry + caption: **"Range from N past forecasts' measured error"** so it's unmistakably empirical. No band on the tile charts.

## 6. Invariants & misuse cases

- **Never fabricate.** No band unless it is computed from ≥ K real anchors of measured error (K owner-set, e.g. 6). Fewer → omit entirely, with a one-line "not enough history yet" note if the setting is on.
- **Off by default.** The stored config starts `false`; enabling is a deliberate owner action.
- **Empirical labeling is mandatory.** The band's accessible name + visible caption state it is measured past error, never a guarantee.
- **Band ≠ the line's authority.** The measured series and the point forecast keep their current treatment; the band is added context, and never widens/narrows the actual projection.
- **Tile sparklines stay bandless** (too small; the fleet console already got the BulletMeter anchor).

## 7. Risk, approval, rollback

- **High-risk** (forecast correctness drives hardware spend). Per CLAUDE.md: written design (this doc) + threat/misuse cases (§6) + full verification + independent AI review (two reviewers) OR human sign-off, recorded in the PR.
- **Rollback:** settings-gated + off by default; flipping the setting off (or shipping with it off) fully hides the feature. The `ForecastSnapshot` collection is additive and harmless if unused.

## 8. Implementation order (contract-first)

1. **`@lcm/shared`** — extend `TenantSettings` (three fields, §5) + add optional `forecast.uncertainty` to the forecast response DTO. Contract + compat tests. _(lowest risk; unblocks both sides)_
2. **Migration** — `ForecastSnapshot` model (additive; verified backup per CLAUDE.md even though dev).
3. **Snapshot job** — persist the engine's forecast at each monthly re-anchor.
4. **Engine** — pure `computeForecastError` (per-horizon quantiles) + exhaustive unit tests. _(the high-risk core)_
5. **Forecast service** — attach `uncertainty` to the response only when enabled AND ≥K anchors exist.
6. **Settings → Forecasting UI** — the three controls.
7. **`ForecastChart`** — muted neutral band, empirical caption, both themes; tiles stay bandless.
8. **Amend the spec** (§9.4) + record the high-risk approval (two AI reviewers or human) in the PR.

Each step lands as its own commit on `feat/forecast-uncertainty-band`; steps 2 and 4 carry full high-risk rigor.

## 11. Integration map (discovered 2026-07-24, for the wiring pass)

- **Actuals**: `ForecastService.prepare()` already builds `baselineHistory[]` with per-period `utilization` — the measured actual per month. No new source needed.
- **Attach**: in `finalize()`, exposed only through `forCluster` (real read). NEVER `forClusterWithScenario` — a hypothetical has no measured error (INV-1). Attaching an optional `uncertainty` is additive and must not alter the pure `computeForecast` output (a **characterization snapshot** test guards this — keep it green).
- **Persist a `ForecastSnapshot`** at each re-anchor: the baseline-capture points — `clusters.ts` (manual baseline upsert ~L493) and `vsphere-snapshot.ts` (`createMany` ~L117). Compute the forecast once at capture and store per-horizon projected utilization %.
- **Read path**: on `forCluster`, gather matured `ForecastSnapshot` rows (horizonMonth ≤ current), pair each with the actual utilization from `baselineHistory` at that month → `ForecastErrorSample[]`, then `computeForecastErrorBands(samples, distinctAnchorCount, bandWidth, minAnchors)` → apply per-horizon offsets to the current forecast's future months → `forecast.uncertainty`.
- **DTO**: add optional `uncertainty?: { month, low, high }[]` to the forecast response schema in `@lcm/shared` (omit when the setting is off or the global floor is unmet — honest absence).
- **Chart** (`apps/web/src/components/clusters/forecast-chart.tsx`): a muted-neutral Recharts band between low/high, empirical caption; tiles stay bandless. Won't visibly render until real snapshots accrue — verify via unit/integration tests + synthetic data.
- **RISK**: `forecast-loader.ts` is invariant-heavy (INV-1, characterization snapshot, #292/#300/#303 anchor semantics). This wiring is the mandatory two-reviewer high-risk change (§7).
