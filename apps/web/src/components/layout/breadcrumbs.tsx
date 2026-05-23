import { useQuery } from '@tanstack/react-query';
import { Link, useMatches } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { Fragment } from 'react';

import { api } from '@/lib/api-client';

interface Crumb {
  label: string;
  to?: string;
  /** Indicates the label is loading and should render a skeleton. */
  pending?: boolean;
}

function useClusterCrumb(clusterId: string | undefined): Crumb {
  const query = useQuery({
    queryKey: ['cluster', clusterId],
    queryFn: () => api.clusters.get(clusterId!),
    enabled: Boolean(clusterId),
  });
  if (!clusterId) return { label: '' };
  if (query.isPending) return { label: 'Loading…', pending: true };
  if (query.isError || !query.data) return { label: clusterId };
  return { label: query.data.name };
}

export function Breadcrumbs(): React.JSX.Element | null {
  const matches = useMatches();
  const last = matches[matches.length - 1];
  const path = last?.pathname ?? '';
  const clusterId =
    last && 'id' in (last.params as Record<string, unknown>)
      ? (last.params as { id?: string }).id
      : undefined;
  const clusterCrumb = useClusterCrumb(clusterId);

  if (!last) return null;

  const crumbs: Crumb[] = (() => {
    if (path === '/' || path === '') {
      return [{ label: 'Overview' }];
    }
    if (path.startsWith('/clusters/new')) {
      return [{ label: 'Clusters', to: '/clusters' }, { label: 'New cluster' }];
    }
    if (path.startsWith('/clusters/') && clusterId) {
      return [{ label: 'Clusters', to: '/clusters' }, clusterCrumb];
    }
    if (path === '/clusters' || path.startsWith('/clusters')) {
      return [{ label: 'Clusters' }];
    }
    if (path.startsWith('/settings')) {
      return [{ label: 'Settings' }];
    }
    return [{ label: 'Overview', to: '/' }];
  })();

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        return (
          <Fragment key={`${crumb.label}-${index}`}>
            {index > 0 && (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
            )}
            {crumb.pending ? (
              <span
                aria-hidden
                className="inline-block h-4 w-24 animate-pulse rounded bg-muted align-middle"
              />
            ) : crumb.to && !isLast ? (
              <Link
                to={crumb.to}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                {crumb.label}
              </Link>
            ) : (
              <span className={isLast ? 'font-medium text-foreground' : 'text-muted-foreground'}>
                {crumb.label}
              </span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
