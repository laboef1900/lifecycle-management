import type { ClusterResponse, LiveUsage, LiveUsageStaleReason } from '@lcm/shared';
import { AlertTriangle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusDot } from '@/components/ui/status-dot';
import { cn } from '@/lib/utils';

/**
 * Live-usage + sync-state surfaces (#193, epic #172).
 *
 * @ai-warning `LiveUsage` is a discriminated union on purpose. `never_fetched`
 * carries NO numbers, and this module must never invent one: "0% used" (or
 * "0 GiB used") for a cluster we have not measured is indistinguishable from
 * "healthy, plenty of headroom" — the single most dangerous wrong answer in a
 * tool that buys hardware. Render "not yet measured", never a zero.
 *
 * @ai-warning Live usage has NO capacity denominator here — the cache
 * deliberately stores none (D25a: capacity is inventory, one owner). So this is
 * shown as an ABSOLUTE reading (GiB used + host coverage + freshness), never as
 * a percentage and never through `BulletMeter` — a meter would need the very
 * denominator the cache omits and would reintroduce the 0%-lie. The forecast's
 * utilization meter is a separate axis and is untouched by this file.
 *
 * @ai-warning Staleness is computed SERVER-side (`state`/`ageSeconds`); never
 * recompute it from `measuredAt` in the browser, or clock skew makes the UI
 * disagree with the API.
 */

type HealthTone = 'ok' | 'warn' | 'crit' | 'neutral';

type Connection = NonNullable<ClusterResponse['connection']>;

const numberFormat = new Intl.NumberFormat('en-US');

/** Absolute GiB reading, rounded to a whole GiB. Never a percentage. */
export function formatUsedGiB(gib: number): string {
  return `${numberFormat.format(Math.round(gib))} GiB`;
}

/**
 * Relative freshness from the SERVER-computed `ageSeconds`. Deliberately does
 * not touch `measuredAt` — the server already decided how old the reading is.
 */
export function formatLiveAge(ageSeconds: number): string {
  if (ageSeconds < 45) return 'just now';
  const minutes = Math.round(ageSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(ageSeconds / 3600);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(ageSeconds / 86_400);
  return `${days}d ago`;
}

/**
 * Human label per stale reason. Each stays distinct — collapsing them would
 * tell the operator something is wrong but not what to do about it.
 */
export function staleReasonLabel(reason: LiveUsageStaleReason): string {
  switch (reason) {
    case 'unreachable':
      return 'vCenter unreachable';
    case 'auth_failed':
      return 'sign-in failed';
    case 'tls_untrusted':
      return 'certificate not trusted';
    case 'identity_mismatch':
      return 'vCenter identity changed';
    case 'disabled':
      return 'sync paused';
  }
}

/**
 * Connection health for the source badge, straight off `connection.status` —
 * which (unlike the live-usage union's `never_fetched` member) preserves every
 * degraded state, including `secret_undecryptable`, whose remedy (restore
 * CONFIG_ENCRYPTION_KEY) differs from every other. `showLabel` is false only
 * for the plain healthy case, so a healthy tile stays quiet.
 */
export function connectionHealth(connection: Connection): {
  tone: HealthTone;
  label: string;
  showLabel: boolean;
} {
  if (!connection.enabled) return { tone: 'neutral', label: 'paused', showLabel: true };
  switch (connection.status) {
    case 'active':
      return { tone: 'ok', label: 'connected', showLabel: false };
    case 'never_connected':
      return { tone: 'neutral', label: 'not connected', showLabel: true };
    case 'unreachable':
      return { tone: 'crit', label: 'unreachable', showLabel: true };
    case 'auth_failed':
      return { tone: 'crit', label: 'sign-in failed', showLabel: true };
    case 'tls_untrusted':
      return { tone: 'warn', label: 'certificate not trusted', showLabel: true };
    case 'cert_mismatch':
      return { tone: 'crit', label: 'certificate changed', showLabel: true };
    case 'identity_mismatch':
      return { tone: 'crit', label: 'different vCenter', showLabel: true };
    case 'secret_undecryptable':
      return { tone: 'crit', label: 'credential unreadable', showLabel: true };
    case 'disabled':
      return { tone: 'neutral', label: 'paused', showLabel: true };
  }
}

const toneBadgeVariant: Record<HealthTone, 'success' | 'warning' | 'danger' | 'outline'> = {
  ok: 'outline',
  warn: 'warning',
  crit: 'danger',
  neutral: 'outline',
};

/**
 * The source badge: "vSphere" plus the connection's health in WORDS (not colour
 * alone) whenever it is anything other than plainly connected. Renders nothing
 * for a manual cluster, which must look exactly as it does today.
 */
export function SyncStateBadge({
  cluster,
  className,
}: {
  cluster: ClusterResponse;
  className?: string;
}): React.JSX.Element | null {
  const connection = cluster.connection;
  if (!connection) return null;
  const health = connectionHealth(connection);
  return (
    <Badge variant={toneBadgeVariant[health.tone]} className={cn('gap-1.5', className)}>
      <StatusDot tone={health.tone} />
      <span>vSphere{health.showLabel ? ` · ${health.label}` : ''}</span>
    </Badge>
  );
}

/**
 * One accessible sentence describing the live reading + connection health, for
 * a tile whose `aria-label` overrides its visible content (so the visible live
 * line below would otherwise be silent to assistive tech).
 */
export function describeLiveUsage(cluster: ClusterResponse, live: LiveUsage | undefined): string {
  const connection = cluster.connection;
  if (!connection) return '';
  const health = connectionHealth(connection);
  const source = `synced from vSphere${health.showLabel ? ` (${health.label})` : ''}`;
  if (!live) return source;
  if (live.state === 'never_fetched') return `${source}; live usage not yet measured`;
  const coverage =
    live.hostsSampled < live.hostsTotal
      ? `, ${live.hostsSampled} of ${live.hostsTotal} hosts reporting`
      : '';
  const age = formatLiveAge(live.ageSeconds);
  if (live.state === 'stale') {
    return `${source}; live usage ${formatUsedGiB(live.memoryUsedGiB)}${coverage}, stale (${staleReasonLabel(live.reason)}), last measured ${age}`;
  }
  return `${source}; live usage ${formatUsedGiB(live.memoryUsedGiB)}${coverage}, updated ${age}`;
}

/** Partial-read note — a real signal, never a silent drop in consumption. */
function coverageNote(live: Extract<LiveUsage, { state: 'fresh' | 'stale' }>): string | null {
  return live.hostsSampled < live.hostsTotal
    ? `${live.hostsSampled}/${live.hostsTotal} hosts`
    : null;
}

/**
 * Compact live-usage line for a fleet-console tile. Renders for SYNCED clusters
 * only; a manual cluster (no connection) shows nothing new.
 */
export function LiveUsageInline({
  cluster,
  live,
  isPending,
}: {
  cluster: ClusterResponse;
  live: LiveUsage | undefined;
  isPending: boolean;
}): React.JSX.Element | null {
  if (!cluster.connection) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] tracking-[0.04em]">
      <span className="font-semibold text-fg-subtle">LIVE</span>
      {live ? (
        <LiveUsageInlineBody live={live} />
      ) : isPending ? (
        <Skeleton className="h-2.5 w-24" />
      ) : (
        <span className="text-fg-muted">unavailable</span>
      )}
    </div>
  );
}

function LiveUsageInlineBody({ live }: { live: LiveUsage }): React.JSX.Element {
  if (live.state === 'never_fetched') {
    // NOT "0 GiB" — the number does not exist, and inventing one is the whole
    // bug this union prevents.
    return <span className="text-fg-muted">not yet measured</span>;
  }
  const coverage = coverageNote(live);
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="tabular-nums text-foreground">{formatUsedGiB(live.memoryUsedGiB)}</span>
      {coverage ? <span className="text-warning">· {coverage}</span> : null}
      {live.state === 'stale' ? (
        <span className="text-warning">· stale ({staleReasonLabel(live.reason)})</span>
      ) : null}
      <span className="text-fg-subtle">· {formatLiveAge(live.ageSeconds)}</span>
    </span>
  );
}

/**
 * "N hosts need commissioning dates" hint (#193; the confirm action is #194).
 * Colour is never the only signal — a warning glyph plus words.
 */
export function ProvisionalHostHint({
  count,
  className,
}: {
  count: number;
  className?: string;
}): React.JSX.Element | null {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border border-warning/35 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-[0.05em] text-warning',
        className,
      )}
    >
      <AlertTriangle aria-hidden className="h-2.5 w-2.5" />
      {count} HOST{count === 1 ? '' : 'S'} NEED DATES
    </span>
  );
}

/**
 * Full live-usage panel for the cluster detail slide-in. Renders for SYNCED
 * clusters only. Skeleton while the batch is loading; an EmptyState "not yet
 * measured" for `never_fetched`; the reading otherwise.
 */
export function LiveUsageSection({
  cluster,
  live,
  isPending,
}: {
  cluster: ClusterResponse;
  live: LiveUsage | undefined;
  isPending: boolean;
}): React.JSX.Element | null {
  const connection = cluster.connection;
  if (!connection) return null;

  const synced = cluster.lastSyncedAt ? cluster.lastSyncedAt.slice(0, 10) : null;

  return (
    <section aria-label="Live usage" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Live usage
        </p>
        <SyncStateBadge cluster={cluster} />
      </div>

      {isPending && !live ? (
        <Skeleton className="h-24 w-full" />
      ) : live && live.state !== 'never_fetched' ? (
        <LiveUsageReadingCard live={live} />
      ) : (
        <EmptyState
          className="p-6"
          title="Not yet measured"
          description={`No live sample from ${connection.name} yet — the poller has not reported for this cluster. This is not "0% used".`}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[10.5px] text-fg-subtle">
          {synced ? `Inventory synced ${synced}` : 'Not yet synced'}
        </p>
        <ProvisionalHostHint count={cluster.provisionalHostCount ?? 0} />
      </div>
    </section>
  );
}

function LiveUsageReadingCard({
  live,
}: {
  live: Extract<LiveUsage, { state: 'fresh' | 'stale' }>;
}): React.JSX.Element {
  const coverage = coverageNote(live);
  const partial = live.hostsSampled < live.hostsTotal;
  return (
    <Card className="flex flex-col gap-1.5 p-3.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
        Live memory used
      </p>
      <p className="font-mono text-xl font-medium tabular-nums text-foreground sm:text-2xl">
        {formatUsedGiB(live.memoryUsedGiB)}
      </p>
      <p
        className={cn(
          'font-mono text-[11px] tabular-nums',
          partial ? 'text-warning' : 'text-fg-muted',
        )}
      >
        {coverage ?? `${live.hostsTotal}/${live.hostsTotal} hosts`} reporting
      </p>
      <p
        className={cn(
          'flex items-center gap-1 font-mono text-[11px]',
          live.state === 'stale' ? 'text-warning' : 'text-fg-subtle',
        )}
      >
        {live.state === 'stale' ? (
          <>
            <AlertTriangle aria-hidden className="h-3 w-3" />
            Stale ({staleReasonLabel(live.reason)}) · last measured {formatLiveAge(live.ageSeconds)}
          </>
        ) : (
          <>Updated {formatLiveAge(live.ageSeconds)}</>
        )}
      </p>
    </Card>
  );
}
