import type {
  ClusterResponse,
  ForecastResponse,
  MetricStateResponse,
  ProcurementInfo,
} from '@lcm/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { AlertTriangle, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
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
import { RecommendationBanner } from '@/components/detail/recommendation-banner';
import { BulletMeter } from '@/components/fleet/bullet-meter';
import { baselineAgeDays, isBaselineStale } from '@/components/fleet/stale-baseline';
import { KpiTile } from '@/components/overview/kpi-tile';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
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

/** Panel motion (spec §3): enter 280ms ease-out, exit 200ms ease-in. */
const ENTER_TRANSITION = { duration: 0.28, ease: [0, 0, 0.38, 0.9] as const };
const EXIT_TRANSITION = { duration: 0.2, ease: [0.4, 0, 1, 1] as const };
const EXIT_MS = 200;

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
 * Cluster detail slide-in panel (spec §5). Fixed right overlay rendered
 * alongside the fleet console, as a true modal dialog (`aria-modal="true"`)
 * — the route (`_app.clusters.$id.tsx`) makes the console `inert` while this
 * panel is mounted, so it's excluded from the tab order and assistive tech
 * (PR review fix 3, review round 2 finding 3: `aria-modal="false"` used to
 * contradict the hand-rolled Tab trap below, which already scoped focus to
 * the panel — this makes the accessibility contract match the real
 * behavior instead of the reverse). Owns the entire former detail-page
 * composition: header, recommendation banner, KPI strip, forecast chart +
 * scenario controls, and the Hosts/Apps & Events/Settings tabs.
 */
export function ClusterPanel({ clusterId }: ClusterPanelProps): React.JSX.Element {
  const navigate = useNavigate();
  const headingId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<number | null>(null);

  const [isClosing, setIsClosing] = useState(false);
  // Overridden by close/scenario-change event handlers; otherwise derived
  // from the loaded cluster name each render (no effect needed for the
  // "opened" announcement — it falls out of the query resolving).
  const [announcementOverride, setAnnouncementOverride] = useState<string | null>(null);
  const [windowSelection, setWindowSelection] = useState<ForecastWindow>('24mo');
  const [scenario, setScenario] = useState<ScenarioWire | null>(null);
  const isWide = useMediaQuery('(min-width: 640px)');
  const canManage = useIsAdmin();

  const clusterQuery = useQuery({
    queryKey: ['cluster', clusterId],
    queryFn: () => api.clusters.get(clusterId),
  });
  const clusterName = clusterQuery.data?.name;

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  // Focus management (spec §5): move focus to the close button on open,
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
      if (lastFocusRef.current && document.contains(lastFocusRef.current)) {
        lastFocusRef.current.focus();
      }
    };
  }, []);

  // Tab trap (spec §5 "focus trap in"): cycles Tab/Shift+Tab within the
  // panel's own focusable elements while it's open. Deliberately hand-rolled
  // rather than FocusScope (see above) — this only reacts to an actual Tab
  // keydown, so it can't fight other focus movement (e.g. the mount/unmount
  // effect above, or a dialog opened from within a tab).
  const handleTabTrap = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const container = panelRef.current;
    if (!container) return;
    const focusable = Array.from(
      container.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.getClientRects().length > 0);
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

  // MINOR fix (review round 1): reduced motion forbids *animation*, not a
  // deferred navigation — `<MotionConfig reducedMotion="user">` (app.tsx)
  // already makes the m.div's own exit transition skip its actual duration
  // for reduced-motion users, so this delay only ever gates the *navigate*,
  // giving the "detail closed" live-region announcement above time to be
  // read before the panel unmounts either way.
  const requestClose = useCallback(() => {
    if (isClosing) return;
    setAnnouncementOverride(
      clusterName ? `Cluster ${clusterName} detail closed.` : 'Cluster detail closed.',
    );
    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      void navigate({ to: '/' });
    }, EXIT_MS);
  }, [isClosing, navigate, clusterName]);

  const handleScenarioChange = useCallback((next: ScenarioWire | null): void => {
    setScenario(next);
    setAnnouncementOverride(
      next ? `Scenario active: ${describeScenario(next)}.` : 'Baseline forecast restored.',
    );
  }, []);

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
  const scenarioDeltaLabel =
    scenario && forecastQuery.data && scenarioQuery.data
      ? computeScenarioDeltaLabel(forecastQuery.data, scenarioQuery.data)
      : undefined;

  return (
    <m.div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      className="cluster-panel fixed bottom-0 right-0 top-14 z-40 overflow-y-auto border-l border-border"
      style={{ background: 'var(--surface-card)', boxShadow: 'var(--overlay-shadow)' }}
      initial={{ x: '100%' }}
      animate={{ x: isClosing ? '100%' : 0 }}
      transition={isClosing ? EXIT_TRANSITION : ENTER_TRANSITION}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          if (
            !event.defaultPrevented &&
            isEscapeTargetInsidePanel(panelRef.current, event.target)
          ) {
            requestClose();
          }
          return;
        }
        handleTabTrap(event);
      }}
    >
      <div className="sr-only" role="status" aria-live="polite">
        {liveMessage}
      </div>

      <div className="space-y-6 p-5 sm:p-6">
        {/* The close button is a single, stable element outside the
            loading-state branching below (deliberately never swapped for a
            different button instance) — the skeleton/error/loaded header
            content around it reflows freely without ever unmounting it, so
            it can't lose the focus the mount effect above placed on it when
            the cluster query resolves and the skeleton gives way to the real
            header. */}
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {clusterQuery.isPending ? (
              <HeaderSkeletonContent headingId={headingId} />
            ) : clusterQuery.isError || !clusterQuery.data ? (
              <ErrorCard message={clusterQuery.error?.message ?? 'Cluster not found'} />
            ) : (
              <PanelHeaderContent cluster={clusterQuery.data} headingId={headingId} />
            )}
          </div>
          <CloseButton ref={closeButtonRef} onClose={requestClose} />
        </header>

        {clusterQuery.data && metric ? (
          <>
            {activeForecast ? (
              <RecommendationBanner procurement={activeForecast.procurement} />
            ) : null}

            {forecastQuery.data ? (
              <ClusterDetailKpiStrip
                forecast={activeForecast ?? forecastQuery.data}
                metric={metric}
                isScenario={Boolean(scenario && scenarioQuery.data)}
              />
            ) : null}

            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Forecast
                </p>
                <h3 className="text-base font-semibold">
                  {activeForecast
                    ? forecastHeading(activeForecast.procurement)
                    : 'Capacity forecast'}
                </h3>
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

            <ScenarioControls active={scenario} onChange={handleScenarioChange} />

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
    </m.div>
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

function forecastHeading(procurement: ProcurementInfo): string {
  if (procurement.breachMonth === null) return 'Forecast — no breach in window';
  const monthLabel = formatMonthLong(procurement.breachMonth);
  const orderPart = procurement.orderByDate ? ` · order by ${procurement.orderByDate}` : '';
  return `Forecast — warn ≈ ${monthLabel}${orderPart}`;
}

const CloseButton = ({
  onClose,
  ref,
}: {
  onClose: () => void;
  ref: React.RefObject<HTMLButtonElement | null>;
}): React.JSX.Element => (
  <button
    ref={ref}
    type="button"
    onClick={onClose}
    className="ml-auto flex shrink-0 items-center gap-2 rounded-[var(--radius)] border border-border px-2.5 py-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em] text-fg-muted transition-colors hover:border-border-strong hover:text-foreground"
  >
    <X className="h-3.5 w-3.5" aria-hidden />
    Close
    <kbd
      aria-hidden
      className="rounded border border-border px-1 py-0.5 text-[9px] font-semibold text-fg-subtle"
    >
      Esc
    </kbd>
  </button>
);

function PanelHeaderContent({
  cluster,
  headingId,
}: {
  cluster: ClusterResponse;
  headingId: string;
}): React.JSX.Element {
  const stale = isBaselineStale(cluster.baselineDate);
  const ageDays = baselineAgeDays(cluster.baselineDate);
  return (
    <>
      <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">Cluster</p>
      <div className="mt-1 flex flex-wrap items-baseline gap-2">
        <h2
          id={headingId}
          className="font-display text-[21px] font-semibold leading-[1.1] tracking-[-0.01em] [overflow-wrap:anywhere]"
        >
          {cluster.name}
        </h2>
        {cluster.archivedAt ? (
          <Badge variant="outline">Archived {cluster.archivedAt.slice(0, 10)}</Badge>
        ) : null}
      </div>
      {cluster.description ? (
        <p className="mt-1 text-sm text-fg-muted [overflow-wrap:anywhere]">{cluster.description}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {stale ? (
          <FlagChip tone="warn">⚠ BASELINE {ageDays} D OLD</FlagChip>
        ) : (
          <FlagChip tone="muted">BASELINE {cluster.baselineDate}</FlagChip>
        )}
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
  isScenario = false,
}: {
  forecast: ForecastResponse;
  metric: MetricStateResponse;
  isScenario?: boolean;
}): React.JSX.Element {
  const headroom = Math.max(0, metric.currentCapacity - metric.currentConsumption);
  const summary = runwayToWarn(forecast.months, forecast.effectiveThresholds);
  const procurementKpi = deriveProcurementKpi(forecast.procurement);
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
          <p className="font-mono text-xl font-medium tabular-nums text-foreground sm:text-2xl">
            {(metric.utilization * 100).toFixed(1)}%
          </p>
          <BulletMeter
            value={metric.utilization * 100}
            warn={forecast.effectiveThresholds.warn * 100}
            crit={forecast.effectiveThresholds.crit * 100}
          />
          <p className="font-mono text-[11px] tabular-nums text-fg-muted">
            {numberFormat.format(Math.round(metric.currentConsumption))} GB used
          </p>
        </Card>
        <KpiTile
          className="col-span-12 sm:col-span-6 lg:col-span-3"
          label="Headroom"
          value={`${numberFormat.format(Math.round(headroom))} GB`}
          caption={`of ${numberFormat.format(Math.round(metric.currentCapacity))} GB capacity`}
          status={utilStatus(metric.utilization, forecast.effectiveThresholds)}
        />
        <Card className="col-span-12 flex flex-col justify-between p-3.5 sm:col-span-6 lg:col-span-3">
          <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Runway
          </p>
          <div className="mt-1.5">
            <RunwayPill
              summary={summary}
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

function HeaderSkeletonContent({ headingId }: { headingId: string }): React.JSX.Element {
  return (
    <div className="space-y-2">
      {/* Keeps the dialog's aria-labelledby pointed at a real element while
          the cluster query is still pending (MINOR fix, review round 1) —
          otherwise the dialog is briefly unlabeled for assistive tech. */}
      <h2 id={headingId} className="sr-only">
        Loading cluster…
      </h2>
      <div className="h-7 w-48 animate-pulse rounded bg-muted" />
      <div className="h-4 w-64 animate-pulse rounded bg-muted" />
    </div>
  );
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
