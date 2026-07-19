import type {
  ClusterResponse,
  ForecastResponse,
  MetricStateResponse,
  ProcurementInfo,
} from '@lcm/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { AlertTriangle, SlidersHorizontal, X } from 'lucide-react';
import { useCallback, useEffect, useId, useReducer, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import * as m from 'motion/react-m';

import { ForecastChart } from '@/components/clusters/forecast-chart';
import { HostsTab } from '@/components/clusters/hosts-tab';
import { ItemsTab } from '@/components/clusters/items-tab';
import { ScenarioControls, describeScenario } from '@/components/clusters/scenario-controls';
import { SettingsTab } from '@/components/clusters/settings-tab';
import {
  resolveWindow,
  WindowControls,
  type ForecastWindow,
} from '@/components/clusters/window-controls';
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
import { RunwayPill } from '@/components/ui/runway-pill';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, type ScenarioWire } from '@/lib/api-client';
import { useIsAdmin } from '@/lib/auth';
import { runwayToWarn, utilStatus } from '@/lib/forecast-summary';
import { formatMonthLong, formatMonthShort } from '@/lib/format-month';
import { deriveProcurementKpi } from '@/lib/procurement-kpi';
import { useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';

export interface ClusterPanelProps {
  clusterId: string;
}

const numberFormat = new Intl.NumberFormat('en-US');

/**
 * Scenario pane motion (spec §3): enter 280ms ease-out, exit 200ms ease-in.
 * The PANEL itself no longer animates (#243): open and close render on the
 * next frame. The asymmetry is deliberate and recorded in the spec §5
 * amendment — the panel is high-frequency navigation where animation is pure
 * wait time (NN/g, Apple HIG); the pane is an occasional mode change.
 */
const ENTER_TRANSITION = { duration: 0.28, ease: [0, 0, 0.38, 0.9] as const };
const EXIT_TRANSITION = { duration: 0.2, ease: [0.4, 0, 1, 1] as const };

/** Width of the slide-in Scenario pane (#226) at `lg` and up, in px. Animated
 *  from 0 → this so the forecast/tabs content column compresses to its left. */
const SCENARIO_PANE_WIDTH = 340;

/** Below this width the pane cannot sit beside the content column, so it
 *  overlays it instead (mirrors the `lg:` utilities on the `m.aside`). Kept as
 *  one constant so the media query and the Tailwind class can't drift apart. */
const PANE_SIDE_BY_SIDE_QUERY = '(min-width: 1024px)';

/**
 * Pane geometry per breakpoint. The two facts here MUST agree and are returned
 * together so they cannot drift: how wide the pane is, and whether it covers
 * the content column behind it.
 *
 * At `lg` and up the pane is a 340px flex sibling and the column simply
 * compresses beside it — nothing is covered, so the column stays interactive.
 * Below `lg` there is no room for a side-by-side editor, so the pane becomes a
 * modal sheet across the whole panel. It is `coversContent` that licenses the
 * `inert` on the column: a 340px strip over a 100vw panel would leave the rest
 * of the column visible on screen while unclickable and stripped from the
 * accessibility tree — worse than the focus-obscured bug the `inert` fixes.
 *
 * `100vw` rather than `100%`: the pane body is anchored inside the animating
 * `m.aside`, so a percentage would resolve against the pane's *current* width
 * and reflow the text on every animation frame. `.cluster-panel` is itself
 * `width: 100vw` (styles.css), so the viewport unit is the panel's width.
 */
export function scenarioPaneLayout(sideBySide: boolean): {
  width: number | string;
  coversContent: boolean;
} {
  return sideBySide
    ? { width: SCENARIO_PANE_WIDTH, coversContent: false }
    : { width: '100vw', coversContent: true };
}

/**
 * Active-scenario tone for the Scenario toggle. It uses the consumption token
 * rather than the amber accent so the indicator points at the violet scenario
 * line it labels — amber is double-booked as the warn-threshold color
 * (styles.css §chart tokens). Everything else about the chip look comes from
 * `Button`'s `chip` variant + `chip` size, which is the single source.
 */
const SCENARIO_ACTIVE_TONE =
  'border-[var(--chart-consumption)] text-[var(--chart-consumption)] hover:border-[var(--chart-consumption)]';

/**
 * The Scenario pane's presence state machine.
 *
 * Two booleans rather than one because AnimatePresence keeps the pane mounted —
 * and painting over the content column — for its 200ms exit *after* `open` has
 * already flipped false. `onScreen` (open OR exiting) is what the column's
 * `inert` and the focus restore must key on; `open` alone would hand the column
 * back while the sheet is still covering it.
 *
 * Extracted as a pure reducer (like `scenarioPaneLayout` and `collectFocusable`
 * below) because the `open` transition encodes an invariant that is otherwise
 * unobservable from outside the component: see the comment on that case.
 */
export type PanePresence = { open: boolean; exiting: boolean };
export type PanePresenceEvent = 'open' | 'close' | 'exit-complete';

export const PANE_CLOSED: PanePresence = { open: false, exiting: false };

export function panePresenceReducer(state: PanePresence, event: PanePresenceEvent): PanePresence {
  switch (event) {
    case 'open':
      // `exiting: false` is load-bearing, not incidental. A re-entry cancels
      // the exit, and a cancelled exit never calls `onExitComplete`:
      // AnimatePresence drops the key from its `exitComplete` map and stops
      // passing the callback down (framer-motion 12.42, AnimatePresence/
      // index.mjs). Nothing else would ever clear the flag, so a mid-exit
      // reopen would leave `exiting` true for the life of the recycled pane —
      // making `exiting` mean something other than what its name says, and
      // handing the next close a state it did not produce.
      return { open: true, exiting: false };
    case 'close':
      return { open: false, exiting: true };
    case 'exit-complete':
      return { ...state, exiting: false };
  }
}

/** The pane is on screen while it is open *or* still painting its exit. */
export function paneIsOnScreen(state: PanePresence): boolean {
  return state.open || state.exiting;
}

/**
 * Focusable elements the panel's Tab trap may cycle through.
 *
 * Two exclusions, both about elements that exist but must not receive focus:
 * `getClientRects()` drops `display: none` subtrees (e.g. the inactive tab
 * panels), and `[inert]` drops the content column while the Scenario pane's
 * modal sheet covers it below `lg` — covered elements still report client
 * rects, so without the `inert` filter Tab would park focus on controls hidden
 * behind the sheet (WCAG 2.2 AA 2.4.11 Focus Not Obscured).
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
 * slide-in Scenario pane (#226) — which compresses the content column beside
 * it at `lg` and up, and becomes a full-panel modal sheet below that
 * (`scenarioPaneLayout`).
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

  const [pane, dispatchPane] = useReducer(panePresenceReducer, PANE_CLOSED);
  const paneOpen = pane.open;
  // Overridden by close/scenario-change event handlers; otherwise derived
  // from the loaded cluster name each render (no effect needed for the
  // "opened" announcement — it falls out of the query resolving).
  const [announcementOverride, setAnnouncementOverride] = useState<string | null>(null);
  const [windowSelection, setWindowSelection] = useState<ForecastWindow>('24mo');
  const [scenario, setScenario] = useState<ScenarioWire | null>(null);
  const isWide = useMediaQuery('(min-width: 640px)');
  const paneIsSideBySide = useMediaQuery(PANE_SIDE_BY_SIDE_QUERY);
  const paneLayout = scenarioPaneLayout(paneIsSideBySide);
  // Derived from the pane being *on screen*, not merely open: dropping the
  // containment the instant `paneOpen` flips false would hand the column back
  // while the sheet is still painted over it for the exit animation — exactly
  // the focus-obscured condition the `inert` exists to prevent.
  const paneIsPresent = paneIsOnScreen(pane);
  const paneOverlaysContent = paneIsPresent && paneLayout.coversContent;
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

  const liveMessage =
    announcementOverride ?? (clusterName ? `Cluster ${clusterName} detail opened.` : '');

  // The dialog names itself rather than pointing `aria-labelledby` at the
  // cluster heading: that heading lives in the content column, which is `inert`
  // whenever the Scenario sheet covers it below `lg`, and inert subtrees are
  // removed from the accessibility tree. Whether a node referenced *directly*
  // by aria-labelledby survives that removal is implementation-defined (accname
  // only guarantees it for `hidden` nodes), so the label would be at the mercy
  // of the engine exactly when the sheet is open. An attribute on the dialog
  // itself always resolves, in every state, and carries more context than the
  // bare cluster name would.
  const dialogLabel = clusterName ? `Cluster ${clusterName} detail` : 'Cluster detail';

  // Instant close (#243): navigate on the same frame — no exit animation, no
  // deferred navigate, and with them no "detail closed" announcement (it only
  // existed because the 200ms delay gave it time to be read). Focus returning
  // to the trigger tile (the unmount effect above) is the assistive-tech cue
  // that the dialog closed.
  const requestClose = useCallback(() => {
    void navigate({ to: '/' });
  }, [navigate]);

  // Scenario pane (#226): the header button toggles it; Esc and the pane's own
  // close control return focus to the button. Closing the pane never clears an
  // active scenario — the header button keeps that visible. Pane open/close is
  // deliberately NOT announced on the shared polite live region: it would clobber
  // the scenario-change announcements, and moving focus into the labeled pane is
  // itself the assistive-tech cue.
  //
  // Focus is driven from the `paneOpen` *state*, not from the pane's mount
  // (review finding): AnimatePresence recycles a same-key child that re-enters
  // while its 200ms exit is still running, so a fast close→reopen never
  // remounts the body and a mount-only effect would silently skip moving focus
  // into the pane.
  const closePane = useCallback(() => {
    // Only reclaim focus if it currently sits inside the pane that is about to
    // disappear (or nowhere at all). At `lg` and up the content column stays
    // interactive beside the pane, so an Esc pressed while the user is working
    // in the hosts table must close the pane without yanking them back up to
    // the header (review finding: the unconditional focus steal).
    const active = document.activeElement;
    const focusInsidePane =
      active instanceof HTMLElement &&
      (paneRef.current?.contains(active) ?? false) &&
      document.contains(active);
    restorePaneFocusRef.current = focusInsidePane || active === document.body || active === null;
    dispatchPane('close');
  }, []);
  const openPane = useCallback(() => {
    // The `open` case of `panePresenceReducer` also clears `exiting` — see the
    // invariant documented there (a mid-exit re-entry cancels the exit, and a
    // cancelled exit never fires `onExitComplete`).
    dispatchPane('open');
  }, []);
  const togglePane = useCallback(() => {
    if (paneOpen) {
      closePane();
      return;
    }
    openPane();
  }, [paneOpen, closePane, openPane]);

  // Below `lg` the Scenario sheet covers the very chart a scenario edits
  // (#243 Part B): a successful Apply/Clear closes the sheet so the user
  // lands on the updated forecast with the header indicator visible. At
  // `lg`+ the chart updates live beside the pane, so it stays open. Guarded
  // on `paneOpen` so a change landing mid-exit cannot re-dispatch 'close'.
  // (Declared after `closePane` — it participates in the pane lifecycle.)
  const paneCoversContent = paneLayout.coversContent;
  const handleScenarioChange = useCallback(
    (next: ScenarioWire | null): void => {
      setScenario(next);
      setAnnouncementOverride(
        next ? `Scenario active: ${describeScenario(next)}.` : 'Baseline forecast restored.',
      );
      if (paneCoversContent && paneOpen) closePane();
    },
    [paneCoversContent, paneOpen, closePane],
  );

  useEffect(() => {
    if (paneOpen) {
      paneCloseRef.current?.focus();
      return;
    }
    // Restore only once the pane is fully gone, not the moment it starts
    // closing: below `lg` the Scenario button sits in the column that stays
    // inert until the exit finishes, and `focus()` on an element inside an
    // inert subtree is a no-op in a real browser — restoring early would drop
    // focus on <body> with nothing left to recover it.
    if (!paneIsPresent && restorePaneFocusRef.current) {
      restorePaneFocusRef.current = false;
      scenarioButtonRef.current?.focus();
    }
  }, [paneOpen, paneIsPresent]);

  // Re-home focus when the content column *becomes* covered. Crossing below
  // `lg` with the pane open (rotate, resize, split view) makes the column inert
  // under whatever the user had focused there; the browser blurs it and focus
  // falls to <body>. Nothing else recovers it — the effect above keys on
  // `paneOpen`, which did not change — and because the Tab trap is a React
  // `onKeyDown` on the panel root, a Tab from <body> never reaches it, so focus
  // would escape the `aria-modal` dialog entirely.
  //
  // Declared after the open effect so opening below `lg` is a no-op here: focus
  // is already inside the pane by then. The `[inert]` branch covers engines (and
  // jsdom) that leave `document.activeElement` on the now-inert element instead
  // of blurring it.
  useEffect(() => {
    if (!paneOverlaysContent) return;
    const active = document.activeElement;
    const focusWasLost =
      active === null ||
      active === document.body ||
      (active instanceof HTMLElement && active.closest('[inert]') !== null);
    if (focusWasLost) paneCloseRef.current?.focus();
  }, [paneOverlaysContent]);

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
  });

  const activeForecast = scenario && scenarioQuery.data ? scenarioQuery.data : forecastQuery.data;
  const activeCapacityKnown = metric?.utilization !== null;
  const scenarioDeltaLabel =
    scenario && forecastQuery.data && scenarioQuery.data
      ? computeScenarioDeltaLabel(forecastQuery.data, scenarioQuery.data)
      : undefined;

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
            // Esc layering (#226): an open pane swallows the first Esc and
            // closes itself; only then does Esc dismiss the whole panel. The
            // scoping guard above still lets nested Radix overlays (e.g. the
            // Scenario type Select) handle their own Escape first.
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

      {/* Non-scrolling shell (#226): the panel root no longer scrolls — this
          content column does — so the Scenario pane can sit beside it as a
          full-height flex sibling. */}
      {/* `inert` exactly while the Scenario sheet covers this column (below
          `lg`, see `scenarioPaneLayout`): the sheet — since #243 a scrim-
          tinted aside carrying the floating glass card — spans the whole
          panel, so nothing here is reachable by pointer (the scrim eats every
          hit). Covered controls keep their client rects, so without this they
          stay in the Tab cycle and focus lands on elements the user cannot
          operate — WCAG 2.2 AA 2.4.11 (Focus Not Obscured). `inert` also
          removes them from the accessibility tree — the honest description of
          a column that is dimmed under a modal sheet (the same contract as the
          app's Dialog overlays); the sheet's own close control and Esc are the
          way out. At
          `lg`+ the pane is a flex sibling that covers nothing, so the column
          stays fully interactive. `collectFocusable` skips `[inert]` subtrees
          so the hand-rolled Tab trap agrees with the browser.

          DELIBERATELY ASYMMETRIC between enter and exit. On exit the
          containment is held until `onExitComplete` (see below); on enter it is
          applied immediately, so for the 280ms `ENTER_TRANSITION` part of the
          column is still visible while already inert. That asymmetry is the
          safe direction, and deferring the enter side to match would be a
          regression:

          - Exit, released early: the Scenario button the focus restore targets
            is *inside* this column, and `focus()` on an element in an inert
            subtree is a no-op in a real browser. Focus lands on <body>, and a
            Tab from <body> never reaches the panel's React `onKeyDown` trap —
            focus escapes the `aria-modal` dialog with nothing to recover it.
            A hard, unrecoverable failure.
          - Enter, deferred: the column would stay *interactive* while the sheet
            progressively covers it, which is precisely the WCAG 2.2 AA 2.4.11
            (Focus Not Obscured) condition this `inert` exists to prevent — Tab
            could park focus on a control that is already behind the sheet.

          What the enter side actually costs is a ≤280ms window in which a
          pointer click on the not-yet-covered strip does nothing. It strands no
          focus (the open effect has already moved focus into the pane), it is
          user-initiated on the control that starts it, and it self-resolves
          when the sheet finishes painting. No enter animation can remove the
          window entirely — any transition that reveals the sheet over time has
          one — so the only alternative is dropping the sub-`lg` open animation,
          which is a design change and not this fix's call. */}
      <div
        data-testid="panel-content"
        inert={paneOverlaysContent}
        className="min-w-0 flex-1 overflow-y-auto"
      >
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
                />
              )}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {clusterQuery.data && metric ? (
                  <ScenarioButton
                    ref={scenarioButtonRef}
                    active={scenario}
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
                  metric={metric}
                  capacityKnown={activeCapacityKnown}
                  isScenario={Boolean(scenario && scenarioQuery.data)}
                />
              ) : null}

              <LiveUsageSection
                cluster={clusterQuery.data}
                live={liveUsage}
                isPending={liveUsageQuery.isPending}
              />

              <div className="flex items-center justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Forecast
                  </p>
                  {/* h2: the h1 is the cluster name (#243), and this section
                      heading is a structural sibling of the tab panels' h2s —
                      h3 here skipped a level in the exposed outline. */}
                  <h2 className="text-base font-semibold">
                    {activeForecast
                      ? forecastHeading(activeForecast.procurement, activeCapacityKnown)
                      : 'Capacity forecast'}
                  </h2>
                </div>
                <WindowControls value={windowSelection} onChange={setWindowSelection} />
              </div>

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

              <Tabs defaultValue="hosts" className="pt-2">
                <TabsList>
                  <TabsTrigger value="hosts">Hosts</TabsTrigger>
                  <TabsTrigger value="items">Apps &amp; Events</TabsTrigger>
                  <TabsTrigger value="settings">Settings</TabsTrigger>
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

      {/* `onExitComplete` is the paint-accurate end of the pane's life: it is
          what releases the content column, so the containment above outlives
          `paneOpen` for exactly as long as the sheet is still on screen (and no
          longer — a fixed timer would over-hold it for reduced-motion users,
          whose exit finishes immediately). */}
      <AnimatePresence onExitComplete={() => dispatchPane('exit-complete')}>
        {paneOpen ? (
          /* Since #243 the aside is no longer a visible surface: at `lg`+ it
             is the transparent 340px reserved gutter that compresses the
             content column (width animation unchanged); below `lg` it spans
             the panel with a scrim tint. The visible surface is the floating
             glass card (`ScenarioPaneBody`). `overflow-hidden` is gone so the
             card can overlap the column's right padding — the card carries
             its own enter/exit animation instead of relying on the clip. */
          <m.aside
            key="scenario-pane"
            ref={paneRef}
            id={paneId}
            aria-labelledby={paneHeadingId}
            className="absolute inset-y-0 right-0 z-10 max-lg:bg-black/40 lg:relative lg:inset-auto lg:z-auto"
            initial={{ width: 0 }}
            animate={{ width: paneLayout.width }}
            exit={{ width: 0, transition: EXIT_TRANSITION }}
            transition={ENTER_TRANSITION}
          >
            <ScenarioPaneBody
              headingId={paneHeadingId}
              scenario={scenario}
              onChange={handleScenarioChange}
              onClose={closePane}
              closeRef={paneCloseRef}
            />
          </m.aside>
        ) : null}
      </AnimatePresence>
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
 * series on the forecast chart directly below it. It used to be the amber
 * `--accent`, which since the chart-color split is the *warn threshold* hue —
 * the chip color-associated with the hairline it does not describe.
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
          className="rounded-sm border border-[color-mix(in_oklab,var(--chart-consumption)_40%,transparent)] px-1 py-0.5 text-[9px] font-semibold normal-case tracking-normal text-[var(--chart-consumption)]"
        >
          {describeScenario(active)}
        </span>
      ) : null}
    </Button>
  );
}

/**
 * The floating glass Scenario card (#243) — the one sanctioned glass surface
 * (`.scenario-card`, styles.css). Anchored to the aside's top-right corner
 * with a 16px inset, auto height, and its own opacity/x enter/exit (never the
 * blur radius); at `lg`+ it is 348px wide — the 340px gutter minus the 16px
 * right inset plus a 24px overlap under the content column's 24px right
 * padding, so real content peeks through the blur. (Recorded residual, #243
 * review: on classic-scrollbar platforms — Windows/Linux, macOS "always
 * show" — the column's vertical scrollbar renders inside that overlapped
 * strip, so the card blocks direct thumb drags along its own height while
 * the pane is open; wheel/trackpad/keyboard scrolling and the exposed track
 * below the card still work.) Because the card hangs off
 * the aside's fixed right edge, the aside's width animation never moves or
 * reflows it. Below `lg` it is a full-width sheet body (16px insets) over the
 * aside's scrim. Focus-into-pane on open is owned by the parent's `paneOpen`
 * effect, not by this component's mount — AnimatePresence can recycle the
 * body instead of remounting it (see `closePane`).
 *
 * The single "Scenario" heading lives here (labels the aside via
 * `aria-labelledby`); `ScenarioControls` no longer renders its own (#243
 * de-duplication). Only the form is width-capped below `lg`, because number
 * inputs stretched across ~900px read as broken.
 */
function ScenarioPaneBody({
  headingId,
  scenario,
  onChange,
  onClose,
  closeRef,
}: {
  headingId: string;
  scenario: ScenarioWire | null;
  onChange: (next: ScenarioWire | null) => void;
  onClose: () => void;
  closeRef: React.RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
  return (
    <m.div
      data-testid="scenario-pane-body"
      className="scenario-card absolute right-4 top-4 flex max-h-[calc(100%-2rem)] w-[calc(100vw-2rem)] flex-col overflow-y-auto p-4 lg:w-[348px]"
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 12, transition: EXIT_TRANSITION }}
      transition={ENTER_TRANSITION}
    >
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
      <div className="w-full max-w-sm">
        <ScenarioControls active={scenario} onChange={onChange} />
      </div>
    </m.div>
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
}: {
  cluster: ClusterResponse;
  procurement: ProcurementInfo | undefined;
  capacityKnown: boolean;
}): React.JSX.Element {
  const stale = isBaselineStale(cluster.baselineDate);
  const ageDays = baselineAgeDays(cluster.baselineDate);
  return (
    <>
      <h1 className="min-w-0 font-display text-[21px] font-semibold leading-[1.1] tracking-[-0.01em] [overflow-wrap:anywhere]">
        {cluster.name}
      </h1>
      <div className="flex flex-wrap items-center gap-1.5">
        {procurement ? (
          <RecommendationChip procurement={procurement} capacityKnown={capacityKnown} />
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

function ClusterDetailKpiStrip({
  forecast,
  metric,
  capacityKnown,
  isScenario = false,
}: {
  forecast: ForecastResponse;
  metric: MetricStateResponse;
  capacityKnown: boolean;
  isScenario?: boolean;
}): React.JSX.Element {
  const headroom = Math.max(0, metric.currentCapacity - metric.currentConsumption);
  const summary = runwayToWarn(forecast.months, forecast.effectiveThresholds);
  const runwayUnknown =
    !capacityKnown && summary.months === null && summary.alreadyBreached === false;
  const procurementKpi = deriveProcurementKpi(forecast.procurement, new Date(), capacityKnown);
  return (
    <div data-testid="kpi-strip" className="space-y-2">
      {isScenario ? (
        <Badge variant="outline" data-testid="scenario-badge">
          Scenario active — KPIs reflect the hypothetical forecast
        </Badge>
      ) : null}
      <div className="grid grid-cols-12 gap-2">
        <Card className="col-span-12 flex flex-col justify-center gap-1.5 p-3.5 sm:col-span-6 lg:col-span-3">
          <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Current utilization
          </p>
          {metric.utilization === null ? (
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
                {(metric.utilization * 100).toFixed(1)}%
              </p>
              <BulletMeter
                value={metric.utilization * 100}
                warn={forecast.effectiveThresholds.warn * 100}
                crit={forecast.effectiveThresholds.crit * 100}
              />
            </>
          )}
          <p className="font-mono text-[11px] tabular-nums text-fg-muted">
            {numberFormat.format(Math.round(metric.currentConsumption))} GB used
          </p>
        </Card>
        <KpiTile
          className="col-span-12 sm:col-span-6 lg:col-span-3"
          label="Headroom"
          value={capacityKnown ? `${numberFormat.format(Math.round(headroom))} GB` : '—'}
          caption={
            capacityKnown
              ? `of ${numberFormat.format(Math.round(metric.currentCapacity))} GB capacity`
              : 'unknown — no capacity recorded'
          }
          status={utilStatus(metric.utilization, forecast.effectiveThresholds)}
        />
        <Card className="col-span-12 flex flex-col justify-between p-3.5 sm:col-span-6 lg:col-span-3">
          <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Runway
          </p>
          <div className="mt-1.5">
            <RunwayPill
              summary={summary}
              unknown={runwayUnknown}
              horizonMonths={forecast.months.length}
              thresholds={forecast.effectiveThresholds}
            />
          </div>
        </Card>
        <KpiTile
          className="col-span-12 sm:col-span-6 lg:col-span-3"
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

function ErrorCard({ message }: { message: string }): React.JSX.Element {
  return (
    <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive shadow-none">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </Card>
  );
}
