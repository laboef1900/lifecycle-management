import type {
  ClusterResponse,
  ForecastAcknowledgment,
  ForecastResponse,
  MetricStateResponse,
  ProcurementInfo,
} from '@lcm/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { AlertTriangle, Info, SlidersHorizontal, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { ForecastChart } from '@/components/clusters/forecast-chart';
import { HostsTab } from '@/components/clusters/hosts-tab';
import { ItemsTab } from '@/components/clusters/items-tab';
import {
  ScenarioControls,
  describeScenario,
  type BlockedPresets,
} from '@/components/clusters/scenario-controls';
import { SettingsTab } from '@/components/clusters/settings-tab';
import {
  resolveWindow,
  WindowControls,
  type ForecastWindow,
} from '@/components/clusters/window-controls';
import { ApproveOrderDialog } from '@/components/detail/approve-order-dialog';
import { RecommendationChip } from '@/components/detail/recommendation-chip';
import { BulletMeter } from '@/components/fleet/bullet-meter';
import { LiveUsageSection } from '@/components/fleet/live-usage';
import { baselineAgeDays, isBaselineStale } from '@/components/fleet/stale-baseline';
import { KpiTile } from '@/components/overview/kpi-tile';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Kbd } from '@/components/ui/kbd';
import { deriveRunwayTone } from '@/components/ui/runway-pill';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, type ScenarioWire } from '@/lib/api-client';
import { HOSTS_TAB_HASH, useAnchorFocusRequest } from '@/lib/anchors';
import { useIsAdmin } from '@/lib/auth';
import { runwayToWarn, utilStatus, type RunwaySummary } from '@/lib/forecast-summary';
import { todayIso } from '@/lib/format';
import { formatMonthLong, formatMonthShort } from '@/lib/format-month';
import { deriveProcurementKpi } from '@/lib/procurement-kpi';
import { useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';

export interface ClusterPanelProps {
  clusterId: string;
}

const numberFormat = new Intl.NumberFormat('en-US');

/** Below this width the Scenario rail can't dock beside the content column, so
 *  it stacks inline under the chart instead. One constant so the JS media query
 *  and the render gate can't drift apart. Nothing animates (#243): the panel
 *  and the rail both render on the next frame. */
const PANE_SIDE_BY_SIDE_QUERY = '(min-width: 1024px)';

/**
 * Active-scenario tone for the Scenario toggle. It uses the consumption token
 * so the indicator is coloured like the violet scenario line it labels, rather
 * than like the steel `--accent` (which would read as a generic CTA) or amber
 * `--warning` (which is the warn hairline on the very same chart). Everything
 * else about the chip look comes from `Button`'s `chip` variant + `chip` size,
 * which is the single source.
 */
const SCENARIO_ACTIVE_TONE =
  'border-[var(--chart-consumption)] text-[var(--chart-consumption)] hover:border-[var(--chart-consumption)]';

/** The panel's own tab set. Controlled (not `Tabs`' uncontrolled `defaultValue`)
 *  so the unknown-capacity recommendation chip can switch to 'hosts' itself
 *  (#243 Part B item 4). */
type PanelTab = 'hosts' | 'items' | 'settings';

/**
 * Focusable elements the panel's Tab trap may cycle through.
 *
 * Two exclusions, both about elements that exist but must not receive focus:
 * `getClientRects()` drops `display: none` subtrees (e.g. the inactive tab
 * panels), and `[inert]` drops anything inside an inert subtree, since inert
 * elements still report client rects and Tab must not park focus on them.
 *
 * Nothing the panel renders is inert today — the Scenario rail is a docked
 * column that covers nothing, so the covering-sheet containment that first
 * motivated the `[inert]` filter is gone. It is kept as a general rule about
 * what "focusable" means rather than a fact about the current layout, so a
 * future overlay inside the panel can't quietly reintroduce the bug.
 *
 * @ai-note jsdom has no layout, so `getClientRects()` is empty for every
 * element there; tests that exercise the trap must stub it.
 */
export function collectFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.closest('[inert]') === null && el.getClientRects().length > 0);
}

/**
 * Scopes Escape handling to keydowns whose real DOM target is inside the
 * panel's own subtree (CRITICAL fix — panel Escape handler vs nested
 * dialogs, review round 1). HostsTab's dialogs (Radix `Dialog.Content`) are
 * rendered via `createPortal` directly into `document.body`, *outside*
 * `.cluster-panel`'s DOM subtree — so a real DOM-containment check (rather
 * than guessing at Radix internals) is the version-independent signal here.
 * Radix 1.6.1's `Dialog.Content` carries no `data-radix-dialog-content`-style
 * marker attribute to select on (verified by inspecting the rendered DOM),
 * so `closest('[data-radix-dialog-content]')` isn't viable.
 *
 * Verified in a real browser (Playwright against the dev stack, see the fix
 * report) that pressing Escape while focus is inside a nested host dialog
 * (e.g. the Delete-host confirmation) does NOT reach this handler at all —
 * Radix's own `DismissableLayer` already dismisses that dialog itself before
 * the keydown would ever bubble here, with or without any guard. This check
 * is deliberately kept anyway as defense-in-depth: it doesn't depend on that
 * behavior continuing to hold for every current and future nested overlay
 * (e.g. one that doesn't self-manage Escape the way Radix's Dialog does).
 */
export function isEscapeTargetInsidePanel(
  container: HTMLElement | null,
  target: EventTarget | null,
): boolean {
  return Boolean(container && target instanceof Node && container.contains(target));
}

/**
 * Cluster detail panel (spec §5). Fullscreen takeover rendered alongside the
 * fleet console with an instant entrance — no slide-in (#243) — as a true
 * modal dialog (`aria-modal="true"`)
 * — the route (`_app.clusters.$id.tsx`) makes the console `inert` while this
 * panel is mounted, so it's excluded from the tab order and assistive tech
 * (PR review fix 3, review round 2 finding 3: `aria-modal="false"` used to
 * contradict the hand-rolled Tab trap below, which already scoped focus to
 * the panel — this makes the accessibility contract match the real
 * behavior instead of the reverse). Owns the entire former detail-page
 * composition: header (with the Scenario pane toggle), recommendation banner,
 * KPI strip, forecast chart, the Hosts/Apps & Events/Settings tabs, and the
 * Scenario rail (redesigned 2026-07-24) — a plain docked side column at `lg`+
 * and an inline section under the chart below `lg`; it never covers the content
 * column, so there is no `inert`/focus-trap/slide-in machinery here anymore.
 */
export function ClusterPanel({ clusterId }: ClusterPanelProps): React.JSX.Element {
  const navigate = useNavigate();
  const paneHeadingId = useId();
  const paneId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLAnchorElement>(null);
  const scenarioButtonRef = useRef<HTMLButtonElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  const paneCloseRef = useRef<HTMLButtonElement>(null);
  const restorePaneFocusRef = useRef(false);
  const hostsTabRef = useRef<HTMLButtonElement>(null);

  // The Scenario rail is a plain docked column now (not a slide-in modal sheet),
  // so its presence is a single boolean — no exit-animation "exiting" state to
  // track, no covering, no inert.
  const [paneOpen, setPaneOpen] = useState(false);
  // Overridden by close/scenario-change event handlers; otherwise derived
  // from the loaded cluster name each render (no effect needed for the
  // "opened" announcement — it falls out of the query resolving).
  const [announcementOverride, setAnnouncementOverride] = useState<string | null>(null);
  const [windowSelection, setWindowSelection] = useState<ForecastWindow>('24mo');
  const [scenario, setScenario] = useState<ScenarioWire | null>(null);
  const [activeTab, setActiveTab] = useState<PanelTab>('hosts');
  const [approveOpen, setApproveOpen] = useState(false);
  const isWide = useMediaQuery('(min-width: 640px)');
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  // Below `lg` the rail stacks inline under the chart; at `lg`+ it docks as a
  // side column. This drives WHERE the single rail instance renders.
  const paneIsSideBySide = useMediaQuery(PANE_SIDE_BY_SIDE_QUERY);
  const canManage = useIsAdmin();

  const clusterQuery = useQuery({
    queryKey: ['cluster', clusterId],
    queryFn: () => api.clusters.get(clusterId),
  });
  const clusterName = clusterQuery.data?.name;

  // Reuses the fleet console's batch live-usage cache (identical query key) and
  // picks out this cluster's item — no per-cluster endpoint (#193). Absent =
  // manual cluster; the section renders nothing in that case.
  const liveUsageQuery = useQuery({
    queryKey: ['clusters', 'live-usage'],
    queryFn: () => api.clusters.liveUsage(),
  });
  const liveUsage = liveUsageQuery.data?.items.find((u) => u.clusterId === clusterId);

  // Focus management (spec §5): move focus to the back button on open,
  // restore it to whatever was previously focused on close — a single
  // synchronous effect, deliberately not Radix's FocusScope: FocusScope's
  // `trapped` mode installs a MutationObserver that, whenever focus is on
  // <body> during a DOM-removal mutation, yanks focus onto its own (visually
  // unfocusable, `display:contents`) wrapper — actively fighting a manual
  // close-button focus during the query-driven skeleton→content DOM churn
  // this panel goes through while loading. `document.contains` guards the
  // restore so a since-removed trigger element is a no-op, not an error.
  const lastFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    lastFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    return () => {
      const last = lastFocusRef.current;
      if (last && last !== document.body && document.contains(last)) {
        last.focus();
        return;
      }
      // The route makes the console `inert` in the same commit that mounts
      // this panel, and a real browser blurs the focused tile the moment it
      // goes inert — so by the time the capture above ran, `activeElement`
      // was already <body> and there is nothing recorded to restore
      // (observed in Playwright; jsdom never blurs inert subtrees, which is
      // why the unit suite can't see it). Fall back to the tile that opens
      // this cluster — the trigger in every pointer/keyboard path through
      // the console, and still the best landing spot after a ⌘K jump.
      // CSS.escape: clusterId is raw (percent-decoded) URL text — a crafted
      // /clusters/x%22y would otherwise make this selector throw mid-unmount.
      document.querySelector<HTMLElement>(`a[data-cluster-id="${CSS.escape(clusterId)}"]`)?.focus();
    };
  }, [clusterId]);

  // Tab trap (spec §5 "focus trap in"): cycles Tab/Shift+Tab within the
  // panel's own focusable elements while it's open. Deliberately hand-rolled
  // rather than FocusScope (see above) — this only reacts to an actual Tab
  // keydown, so it can't fight other focus movement (e.g. the mount/unmount
  // effect above, or a dialog opened from within a tab).
  const handleTabTrap = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const container = panelRef.current;
    if (!container) return;
    const focusable = collectFocusable(container);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  // The dialog names itself rather than pointing `aria-labelledby` at the
  // cluster heading. That heading only exists once the cluster query resolves,
  // so a referenced-node label would be unresolvable through the whole pending
  // and error states — exactly when a dialog most needs a name. An attribute on
  // the dialog itself always resolves, in every state, and carries more context
  // than the bare cluster name would.
  const dialogLabel = clusterName ? `Cluster ${clusterName} detail` : 'Cluster detail';

  // Instant close (#243): navigate on the same frame — no exit animation, no
  // deferred navigate, and with them no "detail closed" announcement (it only
  // existed because the 200ms delay gave it time to be read). Focus returning
  // to the trigger tile (the unmount effect above) is the assistive-tech cue
  // that the dialog closed.
  const requestClose = useCallback(() => {
    void navigate({ to: '/' });
  }, [navigate]);

  // Scenario rail (#226): the header button toggles it; Esc and the rail's own
  // close control return focus to the button. Closing the rail never clears an
  // active scenario — the header button keeps that visible. Open/close is
  // deliberately NOT announced on the shared polite live region: it would clobber
  // the scenario-change announcements, and moving focus into the labeled rail is
  // itself the assistive-tech cue.
  //
  // Focus is driven from the `paneOpen` *state* rather than the rail body's
  // mount, because the body has two mount sites (docked at `lg`+, inline below)
  // and remounts when the viewport crosses the breakpoint — a mount-keyed effect
  // would re-steal focus on a resize the user never asked anything of.
  const closePane = useCallback(() => {
    // Only reclaim focus if it currently sits inside the rail that is about to
    // hide (or nowhere at all). At `lg` and up the content column stays
    // interactive beside the rail, so an Esc pressed while the user is working
    // in the hosts table must close the rail without yanking them back up to
    // the header (review finding: the unconditional focus steal).
    const active = document.activeElement;
    const focusInsidePane =
      active instanceof HTMLElement &&
      (paneRef.current?.contains(active) ?? false) &&
      document.contains(active);
    restorePaneFocusRef.current = focusInsidePane || active === document.body || active === null;
    setPaneOpen(false);
  }, []);
  const openPane = useCallback(() => {
    setPaneOpen(true);
  }, []);
  const togglePane = useCallback(() => {
    if (paneOpen) {
      closePane();
      return;
    }
    openPane();
  }, [paneOpen, closePane, openPane]);

  // Scenario edits are LIVE (presets + sliders, no Apply): the forecast redraws
  // as the user drags, so the rail STAYS OPEN during editing at every width —
  // auto-closing on change would slam it shut on the first slider tick. The
  // rail never covers the chart at either width (docked column at `lg`+, inline
  // under the chart below `lg`), so the redraw is visible while editing in both
  // layouts. The change is announced on the live region regardless, since the
  // chart is not an assistive-tech affordance.
  const handleScenarioChange = useCallback((next: ScenarioWire | null): void => {
    setScenario(next);
    setAnnouncementOverride(
      next ? `Scenario active: ${describeScenario(next)}.` : 'Baseline forecast restored.',
    );
  }, []);

  useEffect(() => {
    if (paneOpen) {
      paneCloseRef.current?.focus();
      return;
    }
    // On close, hand focus back to the Scenario toggle — but only if the rail
    // held it (see `closePane`). The rail hides immediately now (no exit
    // animation), so there is no "wait for the exit" gate.
    if (restorePaneFocusRef.current) {
      restorePaneFocusRef.current = false;
      scenarioButtonRef.current?.focus();
    }
  }, [paneOpen]);

  // Hosts-tab deep link (#243 Part B item 4): the unknown-capacity
  // recommendation chip requests this anchor when clicked, so the panel
  // switches to and focuses its own Hosts tab — the only place capacity can
  // actually be recorded.
  //
  // `hostsFocusBaselineRef` snapshots the counter's value at MOUNT, not 0:
  // `useAnchorFocusRequest`'s count is global module state that only ever
  // increases and is never reset between tests (see lib/anchors.ts), so a
  // freshly-mounted panel can see a nonzero leftover count from an earlier
  // interaction (or an earlier test) that has nothing to do with this
  // instance. `add-cluster-panel.tsx` guards the same hazard by also
  // requiring the URL hash to match; this anchor has no hash to check (chip
  // and tabs are already mounted together on the same page), so the mount-time
  // snapshot is what stands in for that gate — only a genuine post-mount
  // increase counts as "new".
  const hostsFocusRequests = useAnchorFocusRequest(HOSTS_TAB_HASH);
  const hostsFocusBaselineRef = useRef(hostsFocusRequests);
  useEffect(() => {
    if (hostsFocusRequests === hostsFocusBaselineRef.current) return;
    hostsFocusBaselineRef.current = hostsFocusRequests;
    setActiveTab('hosts');
    hostsTabRef.current?.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'nearest',
    });
    hostsTabRef.current?.focus({ preventScroll: true });
  }, [hostsFocusRequests, prefersReducedMotion]);

  const baselineDate = clusterQuery.data?.baselineDate;
  const metric = clusterQuery.data?.metrics[0];
  const range = baselineDate ? resolveWindow(windowSelection, baselineDate) : null;

  const forecastQuery = useQuery({
    queryKey: ['forecast', clusterId, metric?.metricTypeKey, range?.from, range?.to],
    queryFn: () =>
      api.clusters.forecast(clusterId, {
        metric: metric!.metricTypeKey,
        from: range!.from,
        to: range!.to,
      }),
    enabled: Boolean(metric && range),
  });

  const scenarioQuery = useQuery({
    queryKey: [
      'forecast',
      clusterId,
      metric?.metricTypeKey,
      range?.from,
      range?.to,
      'scenario',
      scenario,
    ],
    queryFn: () =>
      api.clusters.forecastScenario(
        clusterId,
        { metric: metric!.metricTypeKey, from: range!.from, to: range!.to },
        scenario!,
      ),
    enabled: Boolean(metric && range && scenario),
    // Scenario edits are LIVE: every debounced slider settle is a new `scenario`
    // object, hence a new query key, hence — without this — an `undefined` data
    // window on every single tick. That window collapses `activeForecast` back
    // to the baseline, so the violet scenario line, the "Scenario active" KPI
    // badge, and all four KPI numbers would blink out and back on each edit.
    // Holding the last good scenario forecast across the refetch is what makes
    // dragging read as one continuously redrawing chart.
    //
    // @ai-note The placeholder must NOT survive a failure: the inline error
    // below says "showing baseline forecast", so the chart under it has to
    // actually BE the baseline, never the previous slider position's what-if.
    // TanStack substitutes a placeholder only while the query is `pending` — so
    // it correctly rides out the `retry` attempt and is dropped once the query
    // settles into `error`, leaving `data` undefined and the gates below intact.
    // That is library behaviour this panel's honesty depends on, so it is pinned
    // by a test ("drops the held scenario forecast when the next one fails"),
    // not by a redundant conditional here.
    placeholderData: keepPreviousData,
  });

  const activeForecast = scenario && scenarioQuery.data ? scenarioQuery.data : forecastQuery.data;
  const activeCapacityKnown = metric?.utilization !== null;
  // Preset applicability is judged against the BASELINE forecast, never the
  // active one: the question is "can this what-if move the real forecast at
  // all", and a scenario's own output must not be able to change the answer
  // (e.g. a delay that pushes the breach out of the window would otherwise
  // disable the very control that produced it).
  const blockedPresets = useMemo(
    () => deriveBlockedPresets(forecastQuery.data),
    [forecastQuery.data],
  );
  const scenarioDeltaLabel =
    scenario && forecastQuery.data && scenarioQuery.data
      ? computeScenarioDeltaLabel(forecastQuery.data, scenarioQuery.data)
      : undefined;
  // A scenario is set but its forecast fetch failed (#243 Part B item 1).
  // `activeForecast`, the KPI strip's `isScenario` flag, and the chart's own
  // `scenario` prop below are already correctly gated on `scenarioQuery.data`
  // — none of them silently claim scenario data that never arrived. What
  // was NOT gated is the header button's active tint/indicator (keyed on
  // `scenario` alone), which is why it kept announcing a hypothetical
  // forecast over what the rest of the panel had already, correctly, fallen
  // back to showing: the baseline.
  const scenarioFailed = Boolean(scenario && scenarioQuery.isError);
  // The scenario computed successfully and reproduced the baseline exactly —
  // an un-modelable what-if (see `scenarioChangesNothing`). Nothing on the
  // chart or in the KPI numbers can show this by itself: an unchanged forecast
  // looks precisely like a forecast that was never disturbed, which is the one
  // reading this tool must never leave a purchaser with.
  const scenarioIsNoop = Boolean(
    scenario &&
    forecastQuery.data &&
    scenarioQuery.data &&
    scenarioChangesNothing(forecastQuery.data, scenarioQuery.data),
  );
  // Derived on every render, not set from an effect: the correction must
  // track `scenarioFailed` live (an unchanged failed-retry re-render must
  // keep showing it, and a Clear must drop it the instant `scenario` goes
  // null), and a value an effect merely mirrors back into state is exactly
  // the "you might not need an effect" case — plus setState-in-effect is an
  // ESLint error here (react-hooks/set-state-in-effect). The `aria-live`
  // region only re-announces on an actual text change, so this never repeats
  // itself while the same failure persists, and a differing announcement in
  // between (e.g. a subsequent "Scenario active: …" for a new attempt) is
  // what makes a *second* failure's identical text register as new again.
  //
  // The no-op correction is derived the same way and for the same reason: the
  // visual "it changed nothing" cue is a badge and a notice, neither of which
  // a screen-reader user hears from the announcement alone. It EXTENDS the
  // activation sentence rather than replacing it, so the scenario is still
  // named — only now with what it did.
  const liveMessage = scenarioFailed
    ? 'Scenario could not be computed — showing baseline.'
    : scenarioIsNoop && scenario
      ? `Scenario active: ${describeScenario(scenario)}. It changes nothing in this window.`
      : (announcementOverride ?? (clusterName ? `Cluster ${clusterName} detail opened.` : ''));

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={dialogLabel}
      className="cluster-panel fixed bottom-0 right-0 top-14 z-40 flex overflow-hidden"
      style={{ background: 'var(--surface-card)' }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          if (
            !event.defaultPrevented &&
            isEscapeTargetInsidePanel(panelRef.current, event.target)
          ) {
            // Esc layering (#226): an open rail swallows the first Esc and
            // closes itself; only then does Esc dismiss the whole panel. The
            // scoping guard above still lets nested Radix overlays (e.g. a
            // host dialog opened from the Hosts tab) handle their own Escape
            // first.
            if (paneOpen) {
              closePane();
            } else {
              requestClose();
            }
          }
          return;
        }
        handleTabTrap(event);
      }}
    >
      <div data-testid="panel-live-region" className="sr-only" role="status" aria-live="polite">
        {liveMessage}
      </div>

      {/* Non-scrolling shell (#226): the panel root doesn't scroll — this
          content column does — so the Scenario rail can dock beside it as a
          full-height flex sibling at `lg`+. The rail is a plain docked column
          now (not a covering modal sheet), so this column is never `inert` and
          needs no focus containment against it; below `lg` the rail stacks
          inline inside this column (rendered after the chart). */}
      <div data-testid="panel-content" className="min-w-0 flex-1 overflow-y-auto">
        <div className="space-y-6 p-5 sm:p-6">
          {/* Two-line page header (#243, the Polaris/Primer/Carbon anatomy):
            line 1 is one flex row — icon-only back link hard left, h1 name,
            inline status chips, flexible spacer, action group right — and
            line 2 is the description, clamped so long text never pushes the
            KPI strip (pl-11 = the 32px back link + 12px gap-x-3, aligning it
            under the h1). The back link is a single, stable element outside the
            loading-state branching below (deliberately never swapped for a
            different element instance) — the skeleton/error/loaded header
            content around it reflows freely without ever unmounting it, so
            it can't lose the focus the mount effect above placed on it when
            the cluster query resolves and the skeleton gives way to the real
            header. It is also first in DOM and tab order, before the h1
            (WCAG 2.4.3). */}
          <header className="space-y-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <BackLink ref={closeButtonRef} />
              {clusterQuery.isPending ? (
                <HeaderSkeleton />
              ) : clusterQuery.isError || !clusterQuery.data ? (
                <div className="min-w-0 flex-1">
                  <ErrorCard message={clusterQuery.error?.message ?? 'Cluster not found'} />
                </div>
              ) : (
                <PanelTitle
                  cluster={clusterQuery.data}
                  procurement={activeForecast?.procurement}
                  capacityKnown={activeCapacityKnown}
                  // Acknowledgment reflects the REAL forecast, never a what-if:
                  // suppressed while a scenario is active (as is the approve
                  // action — you cannot approve a hypothetical order).
                  acknowledgment={scenario ? null : (forecastQuery.data?.acknowledgment ?? null)}
                  onApprove={canManage && !scenario ? () => setApproveOpen(true) : undefined}
                />
              )}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {clusterQuery.data && metric ? (
                  <ScenarioButton
                    ref={scenarioButtonRef}
                    active={scenarioFailed ? null : scenario}
                    open={paneOpen}
                    controlsId={paneId}
                    onClick={togglePane}
                  />
                ) : null}
              </div>
            </div>
            {clusterQuery.data?.description ? (
              <p className="line-clamp-1 pl-11 text-sm text-fg-muted [overflow-wrap:anywhere]">
                {clusterQuery.data.description}
              </p>
            ) : null}
          </header>

          {clusterQuery.data && metric ? (
            <>
              {forecastQuery.data ? (
                <ClusterDetailKpiStrip
                  forecast={activeForecast ?? forecastQuery.data}
                  // The real forecast, always — the strip compares the two to
                  // work out which KPIs a scenario actually moved.
                  baseline={forecastQuery.data}
                  metric={metric}
                  capacityKnown={activeCapacityKnown}
                  isScenario={Boolean(scenario && scenarioQuery.data)}
                  noChange={scenarioIsNoop}
                />
              ) : null}

              <LiveUsageSection
                cluster={clusterQuery.data}
                live={liveUsage}
                isPending={liveUsageQuery.isPending}
              />

              <div className="flex flex-wrap items-center justify-between gap-3">
                {/* h2: the h1 is the cluster name (#243), and this section
                    heading is a structural sibling of the tab panels' h2s —
                    h3 here skipped a level in the exposed outline. No eyebrow
                    above it (#243 Part B item 8): the heading already names
                    the section, and the eyebrow was a one-off text style with
                    no sibling to align to. `flex-wrap` (#243 Part B item 6):
                    below 390px there isn't room for the heading text plus
                    WindowControls on one row, so the control drops to its own
                    line instead of being compressed into internally-wrapping
                    segment labels. font-display/text-h2 (#243 Part B, type
                    scale): was plain Inter text-base — the same arbitrary,
                    unshared sizing the verdict h1/panel title/Settings h1
                    each carried, now the shared section-heading token
                    (matching Settings' own section h2s). */}
                <h2 className="font-display text-h2">
                  {activeForecast
                    ? forecastHeading(activeForecast.procurement, activeCapacityKnown)
                    : 'Capacity forecast'}
                </h2>
                <WindowControls value={windowSelection} onChange={setWindowSelection} />
              </div>

              {/* #243 Part B item 1: a failed scenario fetch must not leave
                  the chart below silently showing the baseline with nothing
                  said about it — the header indicator above is already
                  cleared (`scenarioFailed` gate), so this is the other half
                  of the correction: an inline, retryable error where the
                  user's eyes actually land, sub-`lg` where Apply just routed
                  them here. It renders alongside the chart, not instead of
                  it — the chart keeps showing the real (baseline) forecast
                  underneath, per the "showing baseline" wording below. */}
              {scenarioFailed ? (
                <ErrorCard
                  message="Scenario could not be computed — showing baseline forecast below."
                  onRetry={() => void scenarioQuery.refetch()}
                />
              ) : null}

              {forecastQuery.isPending ? (
                <ChartSkeleton />
              ) : forecastQuery.isError || !forecastQuery.data ? (
                <ErrorCard message={forecastQuery.error?.message ?? 'Could not load forecast'} />
              ) : (
                <ForecastChart
                  forecast={forecastQuery.data}
                  compact={!isWide}
                  scenario={
                    scenario && scenarioQuery.data
                      ? { label: describeScenario(scenario), forecast: scenarioQuery.data }
                      : null
                  }
                  {...(scenarioDeltaLabel ? { scenarioDeltaLabel } : {})}
                />
              )}

              {/* Below `lg`, the Scenario rail stacks inline right under the
                  chart it edits (no float, no cover). At `lg`+ it docks as a
                  side column instead — see the render below panel-content. */}
              {paneOpen && !paneIsSideBySide ? (
                <section
                  ref={paneRef}
                  id={paneId}
                  aria-labelledby={paneHeadingId}
                  className="rounded-[var(--radius-card)] border border-border"
                  style={{ background: 'var(--surface-card)' }}
                >
                  <ScenarioPaneBody
                    headingId={paneHeadingId}
                    scenario={scenario}
                    onChange={handleScenarioChange}
                    onClose={closePane}
                    closeRef={paneCloseRef}
                    maxHosts={forecastQuery.data?.hosts.length}
                    blocked={blockedPresets}
                  />
                </section>
              ) : null}

              <Tabs
                value={activeTab}
                onValueChange={(value) => setActiveTab(value as PanelTab)}
                className="pt-2"
              >
                <TabsList>
                  <TabsTrigger value="hosts" ref={hostsTabRef}>
                    Hosts
                  </TabsTrigger>
                  <TabsTrigger value="items">Apps &amp; Events</TabsTrigger>
                  <TabsTrigger value="settings">Cluster settings</TabsTrigger>
                </TabsList>
                <TabsContent value="hosts">
                  <HostsTab clusterId={clusterId} canManage={canManage} />
                </TabsContent>
                <TabsContent value="items">
                  <ItemsTab clusterId={clusterId} canManage={canManage} />
                </TabsContent>
                <TabsContent value="settings">
                  <SettingsTab clusterId={clusterId} />
                </TabsContent>
              </Tabs>
            </>
          ) : null}
        </div>
      </div>

      {/* At `lg`+ the Scenario rail docks as a real side column of the panel
          grid — a fixed-width flex sibling of the content column, part of the
          layout (no float, no slide, no glass, no cover). It appears/disappears
          instantly on toggle; the content column simply reflows beside it.
          Below `lg` this is null — the rail renders inline under the chart
          instead (see panel-content above). */}
      {paneOpen && paneIsSideBySide ? (
        <aside
          ref={paneRef}
          id={paneId}
          aria-labelledby={paneHeadingId}
          className="flex w-[340px] shrink-0 flex-col overflow-y-auto border-l border-border"
        >
          <ScenarioPaneBody
            headingId={paneHeadingId}
            scenario={scenario}
            onChange={handleScenarioChange}
            onClose={closePane}
            closeRef={paneCloseRef}
            maxHosts={forecastQuery.data?.hosts.length}
            blocked={blockedPresets}
          />
        </aside>
      ) : null}
      {/* Approve-order flow (#292). Keyed on the cluster so state resets across
          clusters; only mounted for admins with a resolved base forecast. The
          server re-derives the breach, so a stale open dialog cannot approve a
          gone breach — it 422s, surfaced inline. */}
      {canManage && clusterQuery.data && forecastQuery.data ? (
        <ApproveOrderDialog
          key={clusterId}
          open={approveOpen}
          onOpenChange={setApproveOpen}
          clusterId={clusterId}
          clusterName={clusterQuery.data.name}
          procurement={forecastQuery.data.procurement}
        />
      ) : null}
    </div>
  );
}

/**
 * Delta callout (spec §5.4): months between the baseline's and the active
 * scenario's warn-breach month, via `runwayToWarn` on both series — no
 * threshold math re-derived here. Handles breach introduced/resolved cases
 * symmetrically with the earlier/later delta.
 */
export function computeScenarioDeltaLabel(
  baseline: ForecastResponse,
  scenario: ForecastResponse,
): string | undefined {
  const baselineSummary = runwayToWarn(baseline.months, baseline.effectiveThresholds);
  const scenarioSummary = runwayToWarn(scenario.months, scenario.effectiveThresholds);

  if (baselineSummary.months === null && scenarioSummary.months === null) return undefined;

  if (baselineSummary.months !== null && scenarioSummary.months === null) {
    const baselineMonth = baseline.months[baselineSummary.months]?.month;
    return baselineMonth
      ? `▼ warn breach resolved (was ≈ ${formatMonthShort(baselineMonth)})`
      : '▼ warn breach resolved';
  }

  if (baselineSummary.months === null && scenarioSummary.months !== null) {
    const scenarioMonth = scenario.months[scenarioSummary.months]?.month;
    return scenarioMonth
      ? `▲ warn breach introduced ≈ ${formatMonthShort(scenarioMonth)}`
      : '▲ warn breach introduced';
  }

  const baselineIndex = baselineSummary.months as number;
  const scenarioIndex = scenarioSummary.months as number;
  const delta = baselineIndex - scenarioIndex;
  if (delta === 0) return undefined;
  const baselineMonth = baseline.months[baselineIndex]?.month;
  const direction = delta > 0 ? 'earlier' : 'later';
  const arrow = direction === 'earlier' ? '▲' : '▼';
  const monthLabel = baselineMonth ? ` (was ≈ ${formatMonthShort(baselineMonth)})` : '';
  return `${arrow} warn ${Math.abs(delta)} mo ${direction}${monthLabel}`;
}

/**
 * Which scenario presets this cluster's data cannot support, and why. Judged on
 * the baseline forecast only (see the call site).
 *
 * @ai-note The three presets differ in what they can reach, which is why this
 * exists at all. `add_vms` adds a synthetic application starting now, so it can
 * always move something. `lose_hosts` drops hosts from the window — but the
 * engine's `capacityAt` treats a host with no recorded capacity row as 0 GB, so
 * dropping such hosts subtracts nothing and returns the baseline verbatim.
 * `delay_procurement` shifts only commissions dated in the future, so with no
 * projected breach (hence no order-by date) there is nothing to shift.
 */
export function deriveBlockedPresets(forecast: ForecastResponse | undefined): BlockedPresets {
  if (!forecast) return {};
  const blocked: BlockedPresets = {};
  if (forecast.hosts.length === 0) {
    blocked.lose_hosts = 'this cluster has no tracked hosts to remove.';
  } else if (!forecast.hosts.some((host) => host.contributions.some((c) => c.amount > 0))) {
    blocked.lose_hosts =
      'no host has a recorded capacity in this window, so removing one cannot change the forecast. Record host capacity on the Hosts tab first.';
  }
  if (forecast.procurement.orderByDate === null) {
    blocked.delay_procurement =
      'there is no order date to delay — this forecast projects no warn breach in the window.';
  }
  return blocked;
}

/**
 * The present-month values behind "Current utilization" and "Headroom", and
 * where they came from.
 *
 * @ai-note `metric.currentConsumption/currentCapacity/utilization` are produced
 * server-side (`ClustersService`) by running the SAME forecast engine over the
 * window `today..today` and reading `months[0]`. Reading the active forecast's
 * current-month point is therefore the identical computation with the scenario
 * applied — not a different definition of "current" — and it provably agrees
 * with `metric` when no scenario is active.
 */
export interface PresentKpi {
  consumption: number;
  capacity: number;
  /** `null` = capacity 0 = unknowable. Never defaulted to 0 (Q9d, #200). */
  utilization: number | null;
  /** 'forecast': the active forecast's current-month point. 'metric': the
   *  window has no current-month point, so the cluster's stored current-month
   *  metric stands in — a baseline number, whatever is on the chart. */
  source: 'forecast' | 'metric';
  /** True only when these numbers are the scenario's own, i.e. a scenario is
   *  active AND it actually moves the present month. */
  hypothetical: boolean;
}

export function resolvePresentKpi(
  active: ForecastResponse,
  baseline: ForecastResponse,
  metric: MetricStateResponse,
  isScenario: boolean,
): PresentKpi {
  const currentMonth = todayIso();
  const activePoint = active.months.find((m) => m.month === currentMonth);
  if (!activePoint) {
    // No honest scenario value for "today": fall back to the stored metric and
    // let the tiles say that is what happened.
    return {
      consumption: metric.currentConsumption,
      capacity: metric.currentCapacity,
      utilization: metric.utilization,
      source: 'metric',
      hypothetical: false,
    };
  }
  const baselinePoint = baseline.months.find((m) => m.month === currentMonth);
  // Both forecasts are computed over the same window by the same engine, so a
  // present month in one is a present month in the other. If it somehow isn't,
  // the value on screen IS the scenario's own point and is labelled as such —
  // the failure mode to avoid is calling a scenario number "baseline".
  const moved =
    baselinePoint === undefined ||
    activePoint.consumption !== baselinePoint.consumption ||
    activePoint.capacity !== baselinePoint.capacity;
  return {
    consumption: activePoint.consumption,
    capacity: activePoint.capacity,
    utilization: activePoint.utilization,
    source: 'forecast',
    hypothetical: isScenario && moved,
  };
}

/** In-tile provenance line: only ever set when a scenario is on screen and the
 *  tile's number is NOT part of it. */
function presentSourceNote(present: PresentKpi, isScenario: boolean): string | null {
  if (!isScenario || present.hypothetical) return null;
  return present.source === 'metric'
    ? 'Baseline — this window does not cover the current month'
    : 'Baseline — unchanged by this scenario';
}

/**
 * The scenario badge's claim, scoped to what the wiring can actually deliver.
 * Runway and Order by are always scenario-derived; the present-tense tiles are
 * only hypothetical when the scenario moves the present month at all — which
 * `delay_procurement` (future commissions only) can never do.
 */
function scenarioBadgeText(present: PresentKpi, noChange: boolean): string {
  if (noChange) return 'Scenario active — it changes nothing in this window';
  if (present.hypothetical) return 'Scenario active — KPIs reflect the hypothetical forecast';
  return 'Scenario active — Runway and Order by are hypothetical; Current utilization and Headroom are baseline';
}

/**
 * Does the scenario forecast reproduce the baseline exactly? An un-modelable
 * what-if (e.g. losing hosts whose capacity was never recorded) returns the
 * baseline verbatim, which otherwise renders as "nothing changed, still
 * healthy" — a confident wrong answer on the surface that drives purchasing.
 */
export function scenarioChangesNothing(
  baseline: ForecastResponse,
  scenario: ForecastResponse,
): boolean {
  if (baseline.months.length !== scenario.months.length) return false;
  return scenario.months.every((point, index) => {
    const base = baseline.months[index];
    return (
      base !== undefined &&
      base.month === point.month &&
      base.consumption === point.consumption &&
      base.capacity === point.capacity
    );
  });
}

/** Neutral provenance tag inside a KPI tile. Bordered rather than tinted: it
 *  states where a number came from, which is not a status. */
function SourceTag({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="mt-1.5 inline-flex w-fit items-center rounded-[var(--radius)] border border-border px-1.5 py-0.5 text-[10px] font-medium text-fg-muted">
      {children}
    </span>
  );
}

function forecastHeading(procurement: ProcurementInfo, capacityKnown: boolean): string {
  if (!capacityKnown && procurement.breachMonth === null) return 'Forecast — capacity unknown';
  if (procurement.breachMonth === null) return 'Forecast — no breach in window';
  const monthLabel = formatMonthLong(procurement.breachMonth);
  const orderPart = procurement.orderByDate ? ` · order by ${procurement.orderByDate}` : '';
  return `Forecast — warn ≈ ${monthLabel}${orderPart}`;
}

/**
 * Header toggle for the Scenario pane (#226). When a scenario is active it
 * carries the scenario summary as visible text (not colour alone — the tint is
 * paired with the `describeScenario` label), so a closed pane never hides that
 * the displayed forecast is hypothetical. `aria-expanded` + `aria-controls`
 * expose the disclosure state to assistive tech.
 *
 * The active tint is `--chart-consumption` (violet), matching the scenario
 * series on the forecast chart directly below it — deliberately neither the
 * steel brand accent nor the amber warn hue, so the chip is colour-associated
 * with the line it actually describes.
 */
function ScenarioButton({
  active,
  open,
  controlsId,
  onClick,
  ref,
}: {
  active: ScenarioWire | null;
  open: boolean;
  controlsId: string;
  onClick: () => void;
  ref: React.RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
  return (
    <Button
      ref={ref}
      type="button"
      variant="chip"
      size="chip"
      onClick={onClick}
      aria-expanded={open}
      {...(open ? { 'aria-controls': controlsId } : {})}
      data-testid="scenario-button"
      {...(active ? { className: SCENARIO_ACTIVE_TONE } : {})}
    >
      <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
      Scenario
      {active ? (
        <span
          data-testid="scenario-active-indicator"
          className="rounded-sm border border-[color-mix(in_oklab,var(--chart-consumption)_40%,transparent)] px-1 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-[var(--chart-consumption)]"
        >
          {describeScenario(active)}
        </span>
      ) : null}
    </Button>
  );
}

/**
 * Body of the docked Scenario rail (redesigned 2026-07-24). Deliberately
 * chrome-less: the container that renders it owns the surface, border, radius,
 * and scrolling — the `<aside>` docked beside the content column at `lg`+, or
 * the inline `<section>` under the chart below `lg`. There is no glass, no
 * scrim, no floating card, and no motion; the rail is part of the layout, so it
 * appears and disappears with the toggle on the next frame.
 *
 * Focus-into-rail on open is owned by the parent's `paneOpen` effect rather
 * than this component's mount: it has two mount sites and genuinely remounts
 * when the viewport crosses `lg`, which must not be mistaken for an open.
 *
 * The single "Scenario" heading lives here and labels the container via
 * `aria-labelledby`; `ScenarioControls` renders no heading of its own (#243
 * de-duplication).
 */
function ScenarioPaneBody({
  headingId,
  scenario,
  onChange,
  onClose,
  closeRef,
  maxHosts,
  blocked,
}: {
  headingId: string;
  scenario: ScenarioWire | null;
  onChange: (next: ScenarioWire | null) => void;
  onClose: () => void;
  closeRef: React.RefObject<HTMLButtonElement | null>;
  maxHosts: number | undefined;
  blocked: BlockedPresets;
}): React.JSX.Element {
  // Plain docked body: the container (the docked `<aside>` at lg+, or the
  // inline `<section>` below lg) owns the surface, border, and scroll. No glass,
  // no motion — the rail is part of the layout now, not a floating popup.
  return (
    <div data-testid="scenario-pane-body" className="flex flex-col p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        {/* h2 like the other panel sections (#243 review — the outline under
            the cluster-name h1 must not skip a level); still labels the
            aside via aria-labelledby, which is level-agnostic. */}
        <h2
          id={headingId}
          className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-muted"
        >
          Scenario
        </h2>
        {/* Icon + "Close" + Esc keycap, built from the shared primitives (the
            `chip` Button + the `xs` Kbd) rather than hand-rolled classes.
            (The panel header's labeled BackButton this used to visually
            mirror is gone — #243 replaced it with the icon-only BackLink —
            but the pane keeps its visible keycap: it is the one on-screen
            Esc hint left in the panel.) `aria-hidden` on both the icon and
            the keycap keeps the accessible name exactly "Close scenario
            pane", which contains the visible "Close" (WCAG 2.5.3 Label in
            Name); `aria-keyshortcuts` states the binding machine-readably,
            since no browser surfaces it visually — that is what the keycap
            is for. */}
        <Button
          ref={closeRef}
          type="button"
          variant="chip"
          size="chip"
          onClick={onClose}
          aria-label="Close scenario pane"
          aria-keyshortcuts="Escape"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          Close
          <Kbd aria-hidden size="xs">
            Esc
          </Kbd>
        </Button>
      </div>
      <ScenarioControls
        active={scenario}
        onChange={onChange}
        maxHosts={maxHosts}
        blocked={blocked}
      />
    </div>
  );
}

/**
 * Title-row content of the two-line header (#243): the h1 (the panel's only
 * top-level heading — the "Cluster" eyebrow is deleted, not demoted; the back
 * control, KPI strip, and context already say "cluster") followed by the
 * ambient-state chip group. The recommendation chip leads it — proximity
 * binds status to the entity — with the baseline flag and archived badge as
 * the remaining "ambient state" chips this slot is for. `procurement` is
 * undefined until the forecast resolves; the chip simply appears then.
 */
function PanelTitle({
  cluster,
  procurement,
  capacityKnown,
  acknowledgment,
  onApprove,
}: {
  cluster: ClusterResponse;
  procurement: ProcurementInfo | undefined;
  capacityKnown: boolean;
  acknowledgment: ForecastAcknowledgment | null;
  onApprove: (() => void) | undefined;
}): React.JSX.Element {
  const stale = isBaselineStale(cluster.baselineDate);
  const ageDays = baselineAgeDays(cluster.baselineDate);
  return (
    <>
      <h1 className="min-w-0 font-display text-h1 [overflow-wrap:anywhere]">{cluster.name}</h1>
      <div className="flex flex-wrap items-center gap-1.5">
        {procurement ? (
          <RecommendationChip
            procurement={procurement}
            capacityKnown={capacityKnown}
            acknowledgment={acknowledgment}
            {...(onApprove ? { onApprove } : {})}
          />
        ) : null}
        {stale ? (
          <FlagChip tone="warn">⚠ BASELINE {ageDays} D OLD</FlagChip>
        ) : (
          <FlagChip tone="muted">BASELINE {cluster.baselineDate}</FlagChip>
        )}
        {cluster.archivedAt ? (
          <Badge variant="outline">Archived {cluster.archivedAt.slice(0, 10)}</Badge>
        ) : null}
      </div>
    </>
  );
}

function FlagChip({
  tone,
  children,
}: {
  tone: 'warn' | 'muted';
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'rounded-sm border px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-[0.05em]',
        tone === 'warn' ? 'border-warning/35 text-warning' : 'border-border text-fg-muted',
      )}
    >
      {children}
    </span>
  );
}

/**
 * Runway's `KpiTile` value/caption text (#243 Part B item 2). The tone
 * decision itself is `deriveRunwayTone` (`ui/runway-pill.tsx`), shared with
 * `RunwayPill`'s Badge variant; only the two-line numeral-plus-caption text
 * this tile needs — as opposed to `RunwayPill`'s single-line badge text — is
 * local to this KPI strip.
 */
function deriveRunwayKpiCopy(
  forecast: ForecastResponse,
  summary: RunwaySummary,
  unknown: boolean,
): { value: string; caption: string; status: ReturnType<typeof deriveRunwayTone> } {
  const status = deriveRunwayTone(summary, unknown);
  const warnPct = Math.round(forecast.effectiveThresholds.warn * 100);
  const critPct = Math.round(forecast.effectiveThresholds.crit * 100);

  if (unknown) {
    return { value: '—', caption: 'unknown — no capacity recorded', status };
  }
  if (summary.alreadyBreached === 'crit') {
    return { value: `Over ${critPct}%`, caption: 'already over threshold', status };
  }
  if (summary.alreadyBreached === 'warn') {
    return { value: `Over ${warnPct}%`, caption: 'already over threshold', status };
  }
  if (summary.months === null) {
    const horizon = forecast.months.length;
    return {
      value: horizon > 0 ? `${horizon}+ mo` : 'No breach',
      caption: 'no warn breach in horizon',
      status,
    };
  }
  const breachMonth = forecast.months[summary.months]?.month;
  const monthApprox = breachMonth ? ` ≈ ${formatMonthShort(breachMonth)}` : '';
  return { value: `${summary.months} mo`, caption: `to ${warnPct}%${monthApprox}`, status };
}

function ClusterDetailKpiStrip({
  forecast,
  baseline,
  metric,
  capacityKnown,
  isScenario = false,
  noChange = false,
}: {
  forecast: ForecastResponse;
  /** The real forecast — the reference the scenario's claims are measured against. */
  baseline: ForecastResponse;
  metric: MetricStateResponse;
  capacityKnown: boolean;
  isScenario?: boolean;
  /** The active scenario reproduces the baseline exactly (see `scenarioChangesNothing`). */
  noChange?: boolean;
}): React.JSX.Element {
  const present = resolvePresentKpi(forecast, baseline, metric, isScenario);
  const presentCapacityKnown = present.utilization !== null;
  const headroom = Math.max(0, present.capacity - present.consumption);
  const summary = runwayToWarn(forecast.months, forecast.effectiveThresholds);
  const runwayUnknown =
    !capacityKnown && summary.months === null && summary.alreadyBreached === false;
  const procurementKpi = deriveProcurementKpi(forecast.procurement, new Date(), capacityKnown);
  const runwayKpi = deriveRunwayKpiCopy(forecast, summary, runwayUnknown);
  const presentNote = presentSourceNote(present, isScenario);
  // Rendered inside BOTH present-tense tiles: whichever tile a reader lands on
  // has to say for itself that its number is the baseline, since the badge above
  // is easy to scroll past.
  const presentNoteTag = presentNote ? <SourceTag>{presentNote}</SourceTag> : null;
  return (
    <div data-testid="kpi-strip" className="space-y-2">
      {isScenario ? (
        <div className="space-y-2">
          <Badge variant="outline" data-testid="scenario-badge">
            {scenarioBadgeText(present, noChange)}
          </Badge>
          {noChange ? (
            // Same anatomy as this file's ErrorCard (icon + text in a Card), in
            // the neutral tone: nothing is broken and nothing is alarming — the
            // forecast simply cannot answer the question that was asked.
            <Card
              data-testid="scenario-noop-notice"
              className="flex items-start gap-3 p-3 text-[11px] leading-relaxed text-fg-muted shadow-none"
            >
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                This what-if does not change the forecast: every month below is identical to the
                baseline. That is a limit of the data on record for this cluster — not a finding
                that the scenario would be harmless.
              </span>
            </Card>
          ) : null}
        </div>
      ) : null}
      <div data-testid="kpi-grid" className="grid grid-cols-2 gap-2 sm:grid-cols-12">
        <Card className="col-span-1 flex flex-col justify-center gap-1.5 p-3.5 sm:col-span-6 lg:col-span-3">
          <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Current utilization
          </p>
          {present.utilization === null ? (
            // Capacity 0 ⇒ unknowable. Render an explicit gap — em-dash + reason,
            // never a meter (a 0-width bar is the "0% used, healthy" lie). Q9d (#200).
            <>
              <p
                className="font-mono text-xl font-medium tabular-nums text-fg-muted sm:text-2xl"
                aria-label="utilization unknown — no capacity recorded"
              >
                —
              </p>
              <p className="text-[11px] text-fg-muted">Unknown — no capacity recorded</p>
            </>
          ) : (
            <>
              <p className="font-mono text-xl font-medium tabular-nums text-foreground sm:text-2xl">
                {(present.utilization * 100).toFixed(1)}%
              </p>
              <BulletMeter
                value={present.utilization * 100}
                warn={forecast.effectiveThresholds.warn * 100}
                crit={forecast.effectiveThresholds.crit * 100}
              />
            </>
          )}
          <p className="font-mono text-[11px] tabular-nums text-fg-muted">
            {numberFormat.format(Math.round(present.consumption))} GB used
          </p>
          {presentNoteTag}
        </Card>
        <KpiTile
          className="col-span-1 sm:col-span-6 lg:col-span-3"
          label="Headroom"
          value={presentCapacityKnown ? `${numberFormat.format(Math.round(headroom))} GB` : '—'}
          caption={
            presentCapacityKnown
              ? `of ${numberFormat.format(Math.round(present.capacity))} GB capacity`
              : 'unknown — no capacity recorded'
          }
          note={presentNoteTag}
          status={utilStatus(present.utilization, forecast.effectiveThresholds)}
        />
        <KpiTile
          className="col-span-1 sm:col-span-6 lg:col-span-3"
          label="Runway"
          value={runwayKpi.value}
          caption={runwayKpi.caption}
          status={runwayKpi.status}
        />
        <KpiTile
          className="col-span-1 sm:col-span-6 lg:col-span-3"
          label="Order by"
          value={procurementKpi.value}
          caption={procurementKpi.caption}
          status={procurementKpi.status}
        />
      </div>
    </div>
  );
}

/** The dialog's own `aria-label` covers the pending state, so this no longer
 *  carries a stand-in heading purely to keep `aria-labelledby` resolvable.
 *  A single title-height bar: it stands in for the h1 inside the one-row
 *  title line (#243); the description line simply appears once loaded. */
function HeaderSkeleton(): React.JSX.Element {
  return <div className="h-7 w-48 animate-pulse rounded bg-muted" />;
}

function ChartSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <Card className="h-[320px] animate-pulse" />
      <Card className="h-[140px] animate-pulse" />
    </div>
  );
}

/** `onRetry` is optional (#243 Part B item 1) — only the scenario-fetch-error
 *  card above needs a retry affordance; the cluster/forecast-load error
 *  branches that already used this component keep their plain read-only
 *  form. */
function ErrorCard({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}): React.JSX.Element {
  return (
    <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive shadow-none">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span className="flex-1">{message}</span>
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </Card>
  );
}
