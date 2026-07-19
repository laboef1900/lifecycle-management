# UI/UX audit — further improvements beyond issue #243

Date: 2026-07-18/19 · Method: live-app inspection (Playwright, dark+light, 1440/768/390) + 5-lens multi-agent audit (visual hierarchy, accessibility, IA/microcopy, responsive, data-viz), adversarially verified against issue #243 scope, CLAUDE.md house style, and the Mission Bento spec so nothing here duplicates #243 or fights a documented decision.

Screenshots referenced: docs/mockups/ui-overhaul-2026-07/ and the audit set (session scratchpad).

## High (4)

### BulletMeter warn tick vanishes on the amber fill in dark theme exactly at warn breach

_Effort: S · Lens: dataviz_

**Evidence:** apps/web/src/components/fleet/bullet-meter.tsx:41 fills with [background:var(--meter-gradient)] (accent-derived amber) and :50 draws the warn tick as bg-warning/70; in dark theme --warning and --accent resolve to the identical #ffc53d (CLAUDE.md house style, spec §3), so once value >= warn the amber tick sits on amber fill at 0.7 alpha and disappears — precisely the state it exists to flag. Warn vs crit ticks also differ by hue alone (same 2px shape) — WCAG 1.4.1. Current screenshots (fleet-console-dark.png, audit-panel-390-dark.png) show meters at ~44-45% so the failure is latent, not visible yet. The same-hex overlap is a documented deliberate token decision — this is that decision executed badly in one primitive, not a token change request.

**Recommendation:** Give each threshold tick a 1px halo in the surface color (the paintOrder-stroke trick cluster-tile-chart.tsx:225 already uses for labels) so it survives any fill, and differentiate crit from warn by shape (e.g. taller tick or distinct protruding stubs), not hue alone. One shared primitive fixes the fleet verdict row and the panel KPI strip at once.

### Host lifecycle gantt paints ~8px date labels over the steel bar — contrast fails

_Effort: S · Lens: accessibility, dataviz_

**Evidence:** audit-panel-hosts-table-dark.png: '2029-01-15' rendered on top of the blue lifecycle bar. apps/web/src/components/detail/host-lifecycle-gantt.tsx: eolFlip anchors the label at endX-4 (on the bar when it ends past ~82% of the row) at fontSize 9 in a 600-unit viewBox (~8.4px rendered), fill var(--fg-muted). Computed: #8b93a7 on the steel-over-card blend ~2.5:1 dark, ~3.4:1 light — both fail SC 1.4.3 for small text. 'WTY EXPIRED' renders at fontSize 7 (~6.5px). The codebase already has the fix pattern: chart labels crossing marks get a paintOrder surface halo (cluster-tile-chart.tsx:225; spec §6 'charts get halos on labels crossing marks').

**Recommendation:** When eolFlip is true, drop the date below the bar or apply the established halo (style={{ paintOrder: 'stroke', stroke: 'var(--card)', strokeWidth: 3 }}); raise fontSize to >=10 viewBox units. Same pass for the 7px WTY EXPIRED text.

### hover:bg-accent on table icon buttons floods brand amber under a near-invisible icon

_Effort: S · Lens: accessibility_

**Evidence:** Verified by grep: apps/web/src/components/clusters/hosts-tab.tsx:164 ('rounded p-1 hover:bg-accent' on the expand-history chevron) and :387 (IconButton 'hover:bg-accent hover:text-foreground'), duplicated at items-tab.tsx:140 and :354. --color-accent here is brand amber, not shadcn's neutral: hovered icon becomes foreground-on-amber ~1.33:1 dark / ~3.2:1 light — SC 1.4.3 fails in the hover state, and the amber flood reads as a CTA. The correct house pairing exists: ghost Button uses hover:bg-card-hover (ui/button.tsx:16).

**Recommendation:** Replace all four occurrences with the ghost pattern (hover:bg-card-hover hover:text-foreground, or Button variant="ghost" size="icon"), then grep for any remaining bare hover:bg-accent shadcn leftovers.

### Below lg, Apply in the scenario sheet gives no visible result — the chart it edits stays covered

_Effort: S · Lens: responsive_

**Evidence:** audit-scenario-390-dark.png: the scenario pane is a 100vw takeover (scenarioPaneLayout coversContent, apps/web/src/components/detail/cluster-panel.tsx) over an inert content column. Apply only calls onChange (scenario-controls.tsx:109) and handleScenarioChange never closes the pane, so after tapping Apply the forecast chart, KPI strip, and delta callout — the point of applying a scenario — remain hidden; the only feedback is a tiny 'Active:' caption. At 1440 (cluster-panel-dark-scenario.png) the chart updates live beside the pane. Affects 768 tablets too (breakpoint is lg/1024). Complementary to #243 item 3, which restyles the pane but explicitly keeps the sub-lg full-width modal sheet. (The lens's alternative of a height-capped bottom sheet was dropped: it violates the documented #235 invariant that a pane not spanning 100vw must not cover/inert the column.)

**Recommendation:** When paneLayout.coversContent, dispatch close after a successful Apply (one-line change in handleScenarioChange or an onApplied callback) so the user lands on the chart with the violet scenario line and the existing 'Scenario active' indicators visible. Fold into the #243 item-3 work if convenient.

## Medium (19)

### Runway KPI tile breaks the strip's grammar: a small pill in a hollow card where siblings show numerals

_Effort: S · Lens: visual-hierarchy_

**Evidence:** Confirmed in cluster-panel.png and audit-panel-390-dark.png: Current utilization (44.0% + meter + caption), Headroom (4,302 GB + caption) and Order by (em-dash + caption) use large mono numerals; Runway is a near-empty card holding only a small '24+ mo' badge with no caption. Three constructions for four tiles (hand-rolled Card, KpiTile, Card-wrapping-RunwayPill in apps/web/src/components/detail/cluster-panel.tsx) — and runway is the headline purchasing number.

**Recommendation:** Render Runway through KpiTile: value '24+ mo' in the 2xl mono numeral, caption from the summary ('no warn breach in horizon' / 'to 70% ≈ Mar 2027'), status mapped from the variant logic RunwayPill already has (ui/runway-pill.tsx). Keep RunwayPill for dense contexts like tables.

### Empty order-by rail spends ~170px of prime viewport restating the verdict below it

_Effort: S · Lens: visual-hierarchy, dataviz_

**Evidence:** fleet-console-dark.png and audit-fleet-768-dark.png (verified): the page's first block is the rail with a fixed h-[86px] tick area (apps/web/src/components/fleet/order-by-rail.tsx:122) plus header and a 12-month axis that encodes nothing at zero ticks, containing one centered line — 'NO ORDER-BY DATES IN THE NEXT 12 MONTHS' — which restates the verdict h1 pushed ~340px down. The rail-first composition is spec-documented (§4), so this is the documented layout executed badly in the empty state, which is the common healthy case; the lens suggestion to move the rail below the verdict was dropped as contradicting §4.

**Recommendation:** Branch the empty state to a compact single-row strip (header + checkmark sentence inline; hide the 86px tick area and month axis) and restore full height only when ticks.length > 0, putting the verdict back above the fold at 768.

### Healthy fleet tiles restate the all-clear four ways; verdict copy leaks the runway '+' into the window description

_Effort: S · Lens: visual-hierarchy, ia-microcopy_

**Evidence:** fleet-console-dark.png (verified): every tile shows an OK badge, '24+ MO no breach', a chip reading '— · NO ORDER NEEDED', and '44.0% used — no breach in the 24+-month window.', while the page adds the rail line, verdict headline, and 'OPEN ORDERS nothing pending'; the identical 'BASELINE 2026-05-01' chip repeats on all four tiles although the verdict says 'BASELINES ✓ all fresh'. Two parts: (a) the chip/baseline anatomy is spec-mandated (§4.4 literally specifies '— · no order needed'), so gating them is a spec amendment — justified because the spec's own decision trail names the 'calm state' as a goal and alert-styled chips carrying zero information defeat it (the one tile that someday says ORDER BY won't stand out); (b) '24+-month window' is a plain execution bug — cluster-tile.tsx interpolates the runway value's '+' into a description of the exactly-24-month window.

**Recommendation:** Amend spec §4.4: render the order chip only when orderByDate is non-null (plus the unknown case) and the baseline chip only in its stale/warn variant. Fix the verdict template to 'no breach within {horizon} months' using the raw horizon length, not the runway value+plus.

### Verdict headline underlines non-links like links and overclaims the forecast horizon

_Effort: S · Lens: ia-microcopy_

**Evidence:** fleet-console-dark.png (verified): 'healthy' and 'June 2028' are green underlined strongs — the identical HL treatment the urgent branch applies to an actual cluster-name <Link> (apps/web/src/components/fleet/fleet-verdict.tsx), so the healthy headline advertises two clickable-looking dead targets. 'no orders due before June 2028' phrases the window edge as a guarantee, but horizonMonth is just fleetMonths.at(-1): a breach shortly past the horizon minus the 8-week lead time could still demand an order before that date. The all-clear sentence form is spec text (§4.3), so the rewording is a copy-level spec amendment.

**Recommendation:** Reserve the underline for real links (color+weight emphasis on the strongs), and scope the claim: 'Fleet is healthy — no orders due in the 24-month forecast window.'

### Light-theme success badge text ~4.4:1 — just under AA on every OK / In service chip

_Effort: S · Lens: accessibility_

**Evidence:** Recomputed independently: badge success variant is text-success on bg-success/10; light --success #1e7f4f over the 10% tint on white card ≈ 4.36:1 at 12px text — below the 4.5:1 SC 1.4.3 floor (passes on bare white; the tint sinks it). Dark passes (~5.9:1). The warning variant sits near ~4.6:1 with no margin. Visible on every OK badge in fleet-console.png.

**Recommendation:** Darken light --success one step (e.g. #176b45) or reduce the light badge tint to /5-/8; re-verify --warning light margin in the same pass. Token-only change; spec §3 explicitly permits small light-value adjustments to reach AA if recorded in the PR.

### Form field errors not programmatically associated; required fields unmarked

_Effort: S · Lens: accessibility_

**Evidence:** apps/web/src/components/form/field.tsx: the error <p> has no id and the Input gets aria-invalid but no aria-describedby, so screen readers announce 'invalid' without the reason (SC 3.3.1); no focus move or live region on failed submit (create-host-dialog.tsx just setErrors). audit-add-host-dialog-dark.png: Name, Commissioned at, and Initial memory capacity are required but carry no visible indicator (SC 3.3.2). All host/item dialogs share Field, so one fix propagates.

**Recommendation:** In Field: give the error/hint <p> an id wired via aria-describedby; add a required prop rendering a visible marker plus aria-required; focus the first invalid field on failed submit.

### Type-scale tokens defined but unused; Settings h1 drops the display font

_Effort: S · Lens: visual-hierarchy_

**Evidence:** Verified: styles.css:203-214 defines --text-display 28px / --text-h1 20px / --text-h2 16px with zero component usages (grep across components/ and routes/). _app.settings.tsx:115 renders the h1 as text-[26px] with no font-display — visible in audit-settings-page-dark.png where 'Settings' is Inter while the fleet verdict and panel titles are Space Grotesk; panel title is font-display text-[21px], verdict h1 clamp(22px,2.2vw,28px). Three sibling screens, three arbitrary sizes, two typefaces at the same heading level.

**Recommendation:** Adopt the existing tokens (text-display for verdict + Settings h1, text-h1 for the panel title, text-h2 for section titles), add font-display to the Settings h1, and delete the arbitrary values so the scale can't drift.

### Settings forms stretch 1-3 digit numeric inputs and row actions across ~1360px

_Effort: S · Lens: visual-hierarchy_

**Evidence:** audit-settings-page-dark.png: 'Warn %' / 'Crit %' inputs each ~660px wide, 'Procurement lead time (weeks)' ~1340px (forecast-thresholds-form.tsx grid-cols-2 with full-width fields in an uncapped Card); category rows place the delete icon ~1300px from the label it deletes (categories-form.tsx). The cluster panel's Settings tab repeats the pattern (audit-panel-settings-tab-dark.png). Field width signals expected input length.

**Recommendation:** Cap the form column (max-w-2xl on settings card content, matching the cap ScenarioPaneBody already uses) and give numeric inputs an intrinsic width (~w-24 / max-w-[10ch]); cap the category list width so label and delete stay in one eye-span.

### Unknown-capacity states name the problem but never the place to fix it — the default state for synced clusters

_Effort: S · Lens: ia-microcopy_

**Evidence:** recommendation-banner.tsx: 'Capacity unknown — record capacity before relying on procurement timing.' and cluster-tile.tsx: 'runway and breach timing cannot be calculated.' — neither says capacity is recorded per host on the Hosts tab (Add/Resize), the only fix path. Per the recorded #198 decision, vSphere sync writes no host capacity, so this dead end is the normal first-run experience for synced clusters on the surface that drives purchasing. Survives #243 (which compacts the banner into a chip+tooltip but doesn't change the guidance copy).

**Recommendation:** Name the destination: 'Capacity unknown — record host capacity on the Hosts tab to enable forecasting.'; in the panel, let the banner/chip focus the Hosts tab via the reusable anchor-focus mechanism (src/lib/anchors.ts). Tile verdict: 'add host capacity to calculate runway'.

### Primary forecast chart exposes zero data to assistive tech; tile chart narrates everything

_Effort: S · Lens: accessibility, dataviz_

**Evidence:** Verified: apps/web/src/components/clusters/forecast-chart.tsx:197-203 — role="img" with static label 'Capacity forecast chart' plus an acknowledged TODO(a11y), and :225 accessibilityLayer={false}. Meanwhile the tile chart computes a rich chartAriaLabel (breach month, thresholds, order-by — cluster-tile-chart.tsx). A screen-reader user gets a full summary on the fleet grid and nothing on the detailed purchasing chart — inverted priorities vs the WCAG 2.2 AA target (SC 1.1.1).

**Recommendation:** Port the tile's chartAriaLabel approach using data already in props (window, breach/no-breach month, warn/crit, ceiling, scenario active); optionally re-enable accessibilityLayer. A visually-hidden monthly table is the fuller follow-up.

### Forecast chart legend omits two visible encodings and mis-swatches Headroom

_Effort: S · Lens: dataviz_

**Evidence:** Verified in cluster-panel.png: legend shows only 'Consumption / Capacity ceiling / Headroom', with Headroom swatched as a faint dashed line while the mark it names is the gray filled band. The measured-baselines dotted series has no legend entry (forecast-chart.tsx renders it but legendType is absent), and the dashed forecast segment is legendType="none" — the solid/dashed convention is never explained on the chart that drives purchasing.

**Recommendation:** Swatch Headroom as a small filled square in the band's fill, add a 'Measured baseline' dotted entry, and split consumption into 'Actual —' and 'Forecast ⌁' swatches. LegendItem needs only an area variant plus two entries.

### Two 'Settings' surfaces cross-reference each other by name with no link either way

_Effort: S · Lens: ia-microcopy_

**Evidence:** audit-panel-settings-tab-dark.png: the cluster panel tab is 'Settings' while the topbar/⌘K 'Settings' is the global page. The global thresholds form says 'Per-cluster overrides apply on the cluster's Settings tab' and the cluster form says 'Override tenant defaults for this cluster' (threshold-overrides-form.tsx), but neither renders a link — the round-trip is manual on both ends. Not touched by #243.

**Recommendation:** Rename the panel tab 'Cluster settings' and make the cross-references navigable: link 'tenant defaults' in ThresholdOverridesForm to /settings (the anchor mechanism in src/lib/anchors.ts already supports deep links).

### 390px KPI strip stacks four sparse full-width cards, pushing the chart ~2 viewports down

_Effort: S · Lens: responsive_

**Evidence:** Verified in audit-panel-390-dark.png: below sm every KPI is col-span-12, so four tall full-width cards stack (Runway nearly empty, Order by a lone em-dash) and the Forecast section only just enters at the bottom of an 844px viewport. Each tile is only a micro-label plus one short mono value — half a card of content.

**Recommendation:** Give the tiles a 2-up base layout (grid-cols-2 at base, keeping sm:col-span-6 lg:col-span-3) to halve the scroll distance to the chart; KpiTile itself needs no changes.

### 'Order-by rail' heading is spec jargon; empty-state hint describes invisible chrome

_Effort: S · Lens: ia-microcopy_

**Evidence:** Verified: order-by-rail.tsx renders the literal spec name 'Order-by rail — next 12 months' ('rail' is a design-system term, not a user concept) and the empty-state hint 'the lead-time zone appears once a cluster has an order-by date in this window' explains a feature the user has never seen. The #218 amendment requires the populated hint to carry the lead-time meaning in text (it does: 'shaded = inside {n}-day lead time · tick = last safe order date') — that variant must stay; only the heading and the empty-state variant are in play.

**Recommendation:** Rename the heading to the user's mental model ('Order deadlines — next 12 months'); make the empty-state hint describe what a tick will mean ('each mark = a cluster's last safe order date'). Keep the #218-mandated populated hint unchanged.

### Host rows expose seven equal-weight icon actions with misleading glyphs and hover-only labels

_Effort: M · Lens: visual-hierarchy, accessibility_

**Evidence:** audit-panel-hosts-table-dark.png + verified code: each row ends in 7 undifferentiated 28px icon buttons (apps/web/src/components/clusters/hosts-tab.tsx:326-358). 'Decommission' uses MoreVertical — the universal kebab for 'more options' — and 'Resize' uses Plus, which also means 'Add host' in the header CTA (SC 3.2.4 consistent identification). All actions rely on native title tooltips — invisible to touch and keyboard focus — and the disabled Transition button's explanation is unreachable since disabled buttons don't focus. Frequent (Edit) and destructive (Delete) actions sit at identical weight.

**Recommendation:** Keep 1-2 primary actions inline (Edit, Transition) and fold the rest into a real DropdownMenu (ui/dropdown-menu.tsx exists) behind the MoreVertical glyph with text items; give Resize/Decommission honest icons (Scaling, PowerOff); use ui/tooltip.tsx (focus-triggered) instead of title=.

### Settings page is one flat scroll; Authentication is last and far below the fold

_Effort: M · Lens: ia-microcopy_

**Evidence:** audit-settings-page-dark.png shows only Forecast thresholds + Categories at 900px; vCenter connections, Add cluster, and Authentication are all below the fold with no in-page navigation (_app.settings.tsx render order), an object-creation action sits between configuration panels, and the header stacks 'CONFIGURATION' eyebrow over 'Settings' h1 for one idea. Spec's 'unchanged structurally' was a before/after note, not a prohibition on grouping.

**Recommendation:** Group the five panels under three labelled anchor-linked sections — Forecasting, Inventory (vCenter, Add cluster), Access (Authentication) — reusing the existing hash-anchor mechanism (lib/anchors.ts already deep-links #add-cluster). Drop the 'Configuration' eyebrow.

### Tile sparkline: the consumption series reads as just another dashed hairline

_Effort: M · Lens: dataviz_

**Evidence:** Verified in fleet-console-dark.png: each tile chart stacks up to 7 dashed/dotted horizontal lines — 3 gridlines, the dotted capacity line, warn and crit hairlines, and the violet consumption line itself, which renders entirely dashed when the window starts at the current month (no solid 'actual' segment, cluster-tile-chart.tsx currentIndex 0). With flat data the purchasing-relevant series is visually a gridline; the big chart's figure/ground device — the violet gradient area fill (confirmed in cluster-panel.png) — is absent from tiles. Partly amplified by flat seed data, but the missing fill and redundant grid are real. Consistent with the documented violet --chart-consumption decision (uses it, doesn't repoint it).

**Recommendation:** Add the same low-opacity --chart-consumption <Area> fill under the tile line, keep any actual segment solid 2px, and drop the horizontal CartesianGrid (the 50/75/100 tick labels already carry it) so warn/crit/capacity become the only reference lines.

### No NOW marker on either forecast chart; the solid/dashed convention has no anchor

_Effort: M · Lens: dataviz_

**Evidence:** Both charts encode 'today' only as the solid-to-dashed transition, and when the window opens at the current month there is no solid segment at all — in fleet-console-dark.png and cluster-panel.png the entire line is dashed with nothing marking the present in a 24-month span. The app's two other timeline visualizations both draw a labeled steel NOW rule (order-by-rail.tsx; host-lifecycle-gantt.tsx, visible in audit-panel-hosts-table-dark.png). Three timelines, one convention, two implementations.

**Recommendation:** Add the existing NOW treatment — vertical dashed var(--steel) ReferenceLine at the current month (labeled on ForecastChart, unlabeled on tiles) — anchoring the timeline and teaching the dashed-equals-forecast convention by construction.

### Scenario forecast fetch failure leaves the indicator and announcement claiming an active scenario over a baseline chart

_Effort: S · Lens: accessibility, correctness · Added 2026-07-19 (PR #246 round-2 review)_

**Evidence:** cluster-panel.tsx: `handleScenarioChange` announces 'Scenario active: …' and (sub-`lg`) dismisses the covering sheet synchronously, before `scenarioQuery` has started fetching — and `scenarioQuery.isError` is read nowhere: `activeForecast` silently falls back to `forecastQuery.data`, the KPI 'Scenario active' badge and the chart's scenario series are gated on `scenarioQuery.data`, and only `forecastQuery` has an ErrorCard branch; the app QueryClient (app.tsx) has retry:1 and no global error surface. If POST forecast/scenario fails, the user sees the header ScenarioButton's active chip (keyed on `scenario` alone) and the live-region announcement over baseline KPIs/chart, with no error and no retry affordance until they reopen the pane and re-apply. Pre-existing at `lg`+; #246's High-4 auto-close newly routes sub-`lg` users onto this surface with the explicit promise of landing on the updated forecast. Forecast scenarios drive purchasing decisions, so a silent indicator/data mismatch matters more here than cosmetics.

**Recommendation:** Read `scenarioQuery.isError`: surface an inline error state on the forecast section (ErrorCard tone) with a retry affordance, and either clear the scenario-active chip or pair it with an error glyph + a corrective announcement ('Scenario could not be computed — showing baseline.'). Alternatively (or additionally) defer/append the 'Scenario active' announcement until the scenario forecast actually resolves.

## Low (13)

### 390px: WindowControls segment labels wrap internally ('24' over 'mo')

_Effort: S · Lens: visual-hierarchy, accessibility_

**Evidence:** Verified in audit-panel-390-dark.png: the active '24 mo' segment wraps to two lines because window-controls.tsx buttons lack whitespace-nowrap (Button's base has it; this control doesn't use Button) and the Forecast heading row forces the control into leftover width. WindowControls is also a parallel implementation of ui/segmented-control.tsx with diverging active styling. (The companion claim about the panel-header BASELINE chip breaking mid-date is real in the same screenshot but is subsumed by #243's header redesign, which rebuilds that chip row.)

**Recommendation:** Add whitespace-nowrap to the WindowControls buttons (or rebuild on ui/SegmentedControl with an accent-active variant) and let the Forecast heading row flex-wrap so the control drops below the heading instead of compressing it.

### Fleet verdict instrument row strands a dangling divider when it wraps at 768

_Effort: S · Lens: visual-hierarchy, responsive_

**Evidence:** Verified in audit-fleet-768-dark.png: row one ends 'FLEET 4 CLUSTERS · 8 HOSTS' followed by a trailing vertical rule with nothing after it, while OPEN ORDERS and BASELINES wrap to a second line. Cause: fleet-verdict.tsx interleaves standalone <Separator /> spans as independent items in a flex-wrap container, so any wrap point can strand a divider.

**Recommendation:** Draw dividers structurally — border-l on each Instrument suppressed at row starts, or [&>_+_]:border-l / grouped divide-x — so wrapping can never orphan a rule.

### Four date dialects on adjacent surfaces: raw ISO in chips/banners vs formatted elsewhere

_Effort: S · Lens: ia-microcopy_

**Evidence:** fleet-console-dark.png 'BASELINE 2026-05-01' and 'ORDER BY {ISO}' chips (cluster-tile.tsx); recommendation-banner.tsx interpolates raw ISO into 'last safe order date ${orderByDate}'; the verdict uses formatDateShort ('June 2028'), charts use 'Jun 28', and the add-host dialog shows locale '01.07.2026'. The banner copy carries into #243's chip tooltip, so the fix survives the redesign.

**Recommendation:** Route every user-facing date through the existing formatDateShort/formatMonthShort helpers ('last safe order date Mar 14, 2027'); native date inputs stay locale-formatted.

### Sub-10px micro text on tiles violates the system's own 10px label floor

_Effort: S · Lens: accessibility_

**Evidence:** cluster-tile.tsx renders the order chip at text-[9.5px] and FlagChip at text-[9px]; cluster-panel.tsx has a text-[9px] scenario indicator — all below the design system's own --text-label 10px token (styles.css:217). Contrast passes (~5.4-5.9:1) so no SC failure, but 9px uppercase tracked mono is genuinely hard to read on the primary console.

**Recommendation:** Floor all chip/indicator text at the --text-label 10px token. (The '— ·' prefix critique is handled by the healthy-state redundancy finding, which removes the placeholder chip entirely.)

### 'Tenant' data-model jargon leaks into user copy in three places

_Effort: S · Lens: ia-microcopy_

**Evidence:** audit-panel-settings-tab-dark.png: 'Inherited from tenant defaults' and 'Override tenant defaults for this cluster' (threshold-overrides-form.tsx); audit-settings-page-dark.png: 'Source: Saved tenant settings' (forecast-thresholds-form.tsx). The app is explicitly single-tenant — 'tenant' names a Prisma model. Same panel: 'Set to 0 to hide the lead-time KPI' names an internal component class.

**Recommendation:** Say 'global defaults' / 'Saved settings' wherever 'tenant' appears; reword the helper to the visible artifact: 'Set to 0 to hide the lead-time zone on the fleet timeline.'

### Tab empty states carry no action; the real button says generic 'Add item'

_Effort: S · Lens: ia-microcopy_

**Evidence:** audit-panel-apps-events-dark.png: the empty box's only content is an instruction sentence while the actual control sits diagonally opposite in the card header labelled 'Add item' — a noun the domain never uses (the objects are apps and events). Hosts tab repeats the pattern ('Add host' header vs actionless empty state). The EmptyState primitive supports an action slot — the fleet console already uses it for 'Add a cluster in Settings'.

**Recommendation:** Move the CTA into the empty state via EmptyState's action prop ('Add app or event' / 'Add host') and rename the header button 'Add app or event'.

### Label consistency drift: runway unit casing, two badge casing systems, scenario verb mismatch

_Effort: S · Lens: ia-microcopy, dataviz_

**Evidence:** The same quantity wears three treatments: tile numeral 'MO' (cluster-tile.tsx, fleet-console-dark.png), RunwayPill '24+ mo' (cluster-panel.png), verdict lowercase 'mo'. Host state badges are sentence-case 'In service' beside ALL-CAPS 'OK/WARN/CRIT' status badges. Scenario type 'Lose hosts' pairs with field label 'Hosts to drop' (scenario-controls.tsx). (The stacked Scenario/Scenario heading from the same raw finding is already fixed by #243 item 3 and was dropped here.)

**Recommendation:** One shared runway formatter in lib/format (lowercase 'mo' has the 2-of-3 majority; small-caps via CSS text-transform if wanted); one casing rule for status-class badges; align the field label with its type ('Hosts lost').

### 'FORECAST' eyebrow repeats the heading's first word in a one-off label style

_Effort: S · Lens: visual-hierarchy_

**Evidence:** cluster-panel.png (verified): 'FORECAST' sits immediately above 'Forecast — no breach in window'. cluster-panel.tsx styles this one eyebrow differently from every sibling label (text-[11px] font-semibold tracking-wider vs the shared text-[10px] font-medium tracking-[0.12em] text-fg-subtle style). Distinct from #243's 'Cluster' eyebrow removal, which covers the panel header only.

**Recommendation:** Drop the eyebrow (the h3 names the section) or keep it and reduce the heading to the status alone; either way align to the shared eyebrow style.

### Dialog close X is a ~16px target whose focus: utilities suppress the house focus-visible ring

_Effort: S · Lens: accessibility_

**Evidence:** audit-add-host-dialog-dark.png top-right X; ui/dialog.tsx wraps an h-4 w-4 icon in a content-sized button (~16px, passing SC 2.5.8 only via the spacing exception) while every other icon control is 28-32px; it uses focus:outline-none focus:ring-2, which overrides the global two-layer :focus-visible ring (styles.css) and shows a ring on mouse click. Unaffected by #243 (that removes the panel's close, not the Dialog primitive's).

**Recommendation:** Give the close button the standard icon hit area (h-8 w-8 inline-flex items-center justify-center) and delete the focus: utilities so the global :focus-visible system applies.

### Theme toggle announces its current state, not the action it performs

_Effort: S · Lens: accessibility_

**Evidence:** theme-toggle.tsx: the icon-only button cycles system→light→dark with aria-label 'Theme: System' etc. — a screen-reader user hears what IS set, not what pressing does, and the name changes silently on the focused button after activation. Visible as monitor/moon glyph only in fleet-console.png vs fleet-console-dark.png.

**Recommendation:** Name action plus state ('Switch theme (current: system)'), or adopt the explicit three-action DropdownMenu pattern the command palette already ships.

### Forecast chart y-axis ticks are non-uniform: 0 / 2,500 / 5,000 / 8,064

_Effort: S · Lens: dataviz_

**Evidence:** Verified in cluster-panel.png: the axis reads 0, 2,500, 5,000 then jumps to a top tick of 8,064 because forecast-chart.tsx sets the domain top to maxCeiling * 1.05 (7,680 × 1.05) and Recharts appends the raw domain max as a tick. The odd top value reads like a data point and breaks the implied uniform interval.

**Recommendation:** Round the domain top to a nice step (next multiple of 500/1,000 above maxCeiling * 1.05) or pass explicit uniform ticks; keep the padding, lose the 8,064.

### Tile data clamped to the 40% floor lacks the off-scale cue the spec gives hairlines

_Effort: S · Lens: dataviz_

**Evidence:** fleet-console-dark.png third tile: CL-Prod-P2-Oracle reads '38.2% used' but its line plots pinned at the 40% window floor, indistinguishable from a true 40% cluster. The 40-125 clamp with tooltip-carries-truth is a documented spec decision (§4.4 #224) — but that same amendment marks clamped hairlines off-scale with a finer dash precisely so a pinned line 'cannot be misread as genuinely at 40%', and the data series never got the equivalent cue. Documented decision, inconsistently executed.

**Recommendation:** Extend the spec's own off-scale convention to the data series: render below-floor segments with the OFF_SCALE_DASH pattern or reduced opacity, and/or a small '<40%' edge marker.

### Hosts table at phone width hides the Actions column off-canvas with no scroll affordance

_Effort: M · Lens: responsive_

**Evidence:** Code-based (no 390 table screenshot): ui/table.tsx wraps rows in overflow-auto and the hosts table's six columns include a min-w-[230px] Lifecycle gantt column plus a right-aligned Actions column (hosts-tab.tsx) — at 390 the natural width far exceeds the viewport, so Edit/Decommission/Delete sit fully off-screen with no shadow/fade cue that more columns exist. audit-panel-hosts-table-dark.png confirms the wide column set.

**Recommendation:** Make the Actions cell sticky (sticky right-0 with the card surface color and a left border) inside the existing overflow wrapper, and/or add a masked-edge scroll cue. Desktop-first use keeps this low priority.
