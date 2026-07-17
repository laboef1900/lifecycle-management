import type { HostResponse } from '@lcm/shared';
import { addUtcMonths } from '@lcm/shared';

import { daysUntil } from '@/lib/dates';

/** Shared time axis a `HostLifecycleGantt`/`HostLifecycleGanttRow` pair is drawn against. */
export interface GanttDomain {
  min: Date;
  max: Date;
}

/** Fixed SVG coordinate space every row/axis renders into — scales via CSS width. */
const VB_WIDTH = 600;
const ROW_HEIGHT = 32;
const AXIS_HEIGHT = 20;

function parseUtcDate(dateOnly: string): Date {
  return new Date(`${dateOnly}T00:00:00Z`);
}

/**
 * Shared time axis for a set of hosts (spec §5.6): min commissioned date to
 * the max of every host's eol/decommissioned/projected-decommission date,
 * padded a calendar month on each side so bars never touch the edge.
 */
export function ganttDomain(hosts: HostResponse[]): GanttDomain {
  if (hosts.length === 0) {
    const now = new Date();
    return { min: now, max: now };
  }
  const commissionedTimes = hosts.map((h) => parseUtcDate(h.commissionedAt).getTime());
  const endTimes = hosts.flatMap((h) =>
    [h.eolAt, h.decommissionedAt, h.projectedDecommissionAt]
      .filter((d): d is string => Boolean(d))
      .map((d) => parseUtcDate(d).getTime()),
  );
  const minTime = Math.min(...commissionedTimes);
  const maxTime = endTimes.length > 0 ? Math.max(...endTimes) : Math.max(...commissionedTimes);
  return {
    min: addUtcMonths(new Date(minTime), -1),
    max: addUtcMonths(new Date(Math.max(maxTime, minTime)), 1),
  };
}

/** Position of `date` within `domain`, as a 0-100 percentage. */
function positionPct(date: Date, domain: GanttDomain): number {
  const span = domain.max.getTime() - domain.min.getTime();
  if (span <= 0) return 0;
  return ((date.getTime() - domain.min.getTime()) / span) * 100;
}

function pctToX(pct: number): number {
  return (Math.max(0, Math.min(100, pct)) / 100) * VB_WIDTH;
}

function rowAriaLabel(host: HostResponse, warrantyExpired: boolean): string {
  const warrantyText = host.warrantyEndsAt
    ? `warranty ${warrantyExpired ? 'expired' : 'until'} ${host.warrantyEndsAt}`
    : 'warranty not recorded';
  const eolText = host.eolAt ? `hardware EOL ${host.eolAt}` : 'hardware EOL not projected';
  return `${host.name}: commissioned ${host.commissionedAt}, ${warrantyText}, ${eolText}.`;
}

export interface HostLifecycleGanttRowProps {
  host: HostResponse;
  domain: GanttDomain;
  today?: Date;
}

/**
 * One host's lifecycle bar (spec §5.6): commissioned→(EOL ?? domain max),
 * a warranty tick (warn-toned + "WTY EXPIRED" text once past), the EOL date
 * printed at the bar end, and an unlabeled NOW tick shared with every other
 * row on the same domain (the axis carries the labeled version).
 */
export function HostLifecycleGanttRow({
  host,
  domain,
  today = new Date(),
}: HostLifecycleGanttRowProps): React.JSX.Element {
  const commissioned = parseUtcDate(host.commissionedAt);
  const barEnd = host.eolAt ? parseUtcDate(host.eolAt) : domain.max;
  const startX = pctToX(positionPct(commissioned, domain));
  const endX = pctToX(positionPct(barEnd, domain));
  const nowX = pctToX(positionPct(today, domain));
  const warrantyDate = host.warrantyEndsAt ? parseUtcDate(host.warrantyEndsAt) : null;
  const warrantyX = warrantyDate ? pctToX(positionPct(warrantyDate, domain)) : null;
  const warrantyExpired = host.warrantyEndsAt ? daysUntil(host.warrantyEndsAt, today) < 0 : false;
  const eolFlip = endX > VB_WIDTH * 0.82;
  const label = rowAriaLabel(host, warrantyExpired);

  return (
    <svg
      viewBox={`0 0 ${VB_WIDTH} ${ROW_HEIGHT}`}
      className="h-8 w-full min-w-[230px]"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <line
        x1={nowX}
        x2={nowX}
        y1={2}
        y2={ROW_HEIGHT - 2}
        stroke="var(--fg-subtle)"
        strokeWidth={1}
        strokeDasharray="2 3"
      />
      <rect
        x={startX}
        y={13}
        width={Math.max(0, endX - startX)}
        height={6}
        rx={3}
        fill="var(--steel)"
        fillOpacity={0.4}
      />
      {warrantyX !== null ? (
        <line
          x1={warrantyX}
          x2={warrantyX}
          y1={9}
          y2={21}
          stroke={warrantyExpired ? 'var(--warning)' : 'var(--fg-subtle)'}
          strokeWidth={2}
        />
      ) : null}
      {warrantyExpired && warrantyX !== null ? (
        <text
          x={warrantyX}
          y={ROW_HEIGHT - 3}
          textAnchor="middle"
          fontSize={7}
          fontWeight={600}
          fill="var(--warning)"
          className="font-mono"
        >
          WTY EXPIRED
        </text>
      ) : null}
      <text
        x={endX + (eolFlip ? -4 : 4)}
        y={17}
        textAnchor={eolFlip ? 'end' : 'start'}
        fontSize={9}
        fill="var(--fg-muted)"
        className="font-mono"
      >
        {host.eolAt ?? '—'}
      </text>
    </svg>
  );
}

export interface HostLifecycleGanttAxisProps {
  domain: GanttDomain;
  today?: Date;
}

/** Year gridlines + labels and the labeled NOW line shared by every row (spec §5.6). */
export function HostLifecycleGanttAxis({
  domain,
  today = new Date(),
}: HostLifecycleGanttAxisProps): React.JSX.Element {
  const startYear = domain.min.getUTCFullYear() + 1;
  const endYear = domain.max.getUTCFullYear();
  const years: number[] = [];
  for (let y = startYear; y <= endYear; y++) years.push(y);
  const nowX = pctToX(positionPct(today, domain));

  return (
    <svg
      viewBox={`0 0 ${VB_WIDTH} ${AXIS_HEIGHT}`}
      className="h-5 w-full min-w-[230px]"
      aria-hidden="true"
    >
      {years.flatMap((y) => {
        const pct = positionPct(new Date(Date.UTC(y, 0, 1)), domain);
        if (pct < 1.5 || pct > 98.5) return [];
        const x = pctToX(pct);
        return [
          <line key={`gl-${y}`} x1={x} x2={x} y1={0} y2={AXIS_HEIGHT} stroke="var(--chart-grid)" />,
          <text
            key={`lbl-${y}`}
            x={x}
            y={9}
            textAnchor="middle"
            fontSize={8}
            fill="var(--fg-subtle)"
            className="font-mono"
          >
            {y}
          </text>,
        ];
      })}
      <line
        x1={nowX}
        x2={nowX}
        y1={0}
        y2={AXIS_HEIGHT}
        stroke="var(--steel)"
        strokeWidth={1}
        strokeDasharray="2 3"
      />
      <text
        x={nowX + 4}
        y={9}
        fontSize={8}
        fontWeight={600}
        fill="var(--steel)"
        className="font-mono"
      >
        NOW
      </text>
    </svg>
  );
}

export interface HostLifecycleGanttProps {
  hosts: HostResponse[];
  today?: Date;
}

/**
 * Full host lifecycle Gantt (spec §5.6): a shared year axis + one bar row per
 * host. `hosts-tab.tsx` uses `ganttDomain` + `HostLifecycleGanttRow` directly
 * so each row can live in its own table cell against one shared domain; this
 * component is the standalone composition of both.
 */
export function HostLifecycleGantt({
  hosts,
  today = new Date(),
}: HostLifecycleGanttProps): React.JSX.Element | null {
  if (hosts.length === 0) return null;
  const domain = ganttDomain(hosts);
  return (
    <div className="space-y-1">
      <HostLifecycleGanttAxis domain={domain} today={today} />
      <div className="space-y-0.5">
        {hosts.map((host) => (
          <HostLifecycleGanttRow key={host.id} host={host} domain={domain} today={today} />
        ))}
      </div>
    </div>
  );
}
