import { hostMoveInputSchema } from '@lcm/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError, api, describeApiError, type HostMoveInputWire } from '@/lib/api-client';
import { formatMonthLong } from '@/lib/format-month';
import { todayIso } from '@/lib/format';

import {
  filterMoveDestinations,
  mapIssuesToFieldErrors,
  useHostMutations,
  type WithHostProps,
} from './shared';

type Step = 'form' | 'confirm';

/** `'2026-07-01'` → `'2026-07'`, the value an `<input type="month">` wants. */
function currentMonthValue(): string {
  return todayIso().slice(0, 7);
}

/**
 * Moves a MANUAL host to a different cluster, effective a chosen month (#289
 * backend, #301 this UI). A two-step flow — pick destination + month, then an
 * explicit confirmation screen restating the scope and consequence — before the
 * mutation ever fires: this changes which cluster the host's capacity counts
 * toward from the move date forward, so it is treated as a consequential action
 * per the project's accessibility rules, not a one-click toggle.
 *
 * Destination choices exclude the host's current cluster and any cluster whose
 * `source` is `'vsphere'` — a UX affordance only (mirrors `AdminOnly`/`canManage`
 * elsewhere): the server is the real enforcement point and still returns a 409
 * `SYNC_OWNED_FIELD` if a synced destination somehow reaches it (e.g. stale
 * cache), which the error handling below surfaces rather than swallows.
 */
export function HostMoveDialog({
  open,
  onOpenChange,
  clusterId,
  host,
}: WithHostProps): React.JSX.Element {
  const { invalidate } = useHostMutations(clusterId);
  const clustersQuery = useQuery({
    queryKey: ['clusters', { includeArchived: false }],
    queryFn: () => api.clusters.list({ includeArchived: false }),
  });
  const allClusters = clustersQuery.data?.items ?? [];
  const candidates = filterMoveDestinations(allClusters, host.clusterId);
  const sourceCluster = allClusters.find((candidate) => candidate.id === host.clusterId);

  const [step, setStep] = useState<Step>('form');
  const [destinationClusterId, setDestinationClusterId] = useState('');
  const [moveMonth, setMoveMonth] = useState(currentMonthValue());
  const [errors, setErrors] = useState<{ destinationClusterId?: string; moveMonth?: string }>({});

  // The <Select> needs a non-empty default once candidates load; re-picking here
  // (rather than a useEffect) keeps this a plain render-time derivation.
  const selectedDestinationId =
    destinationClusterId || (candidates.length > 0 ? candidates[0]!.id : '');
  const destinationCluster = candidates.find((c) => c.id === selectedDestinationId);

  const mutation = useMutation({
    mutationFn: (payload: HostMoveInputWire) => api.hosts.move(host.id, payload),
    onSuccess: () => {
      invalidate();
      toast.success('Host moved');
      onOpenChange(false);
    },
    onError: (err) => {
      // Surface the two server-side rejections a stale UI could still trigger
      // as a field error the operator can act on; everything else falls back
      // to a toast. Either way, land back on the form — the confirmation
      // screen is describing state that turned out not to hold.
      if (err instanceof ApiError && err.code === 'INVALID_MOVE_DATE') {
        setErrors({ moveMonth: err.message });
      } else if (err instanceof ApiError && err.code === 'SYNC_OWNED_FIELD') {
        setErrors({ destinationClusterId: err.message });
      }
      toast.error(describeApiError(err, 'Could not move host'));
      setStep('form');
    },
  });

  const pending = mutation.isPending;

  const onContinue = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setErrors({});
    const moveDate = moveMonth.length > 0 ? `${moveMonth}-01` : '';
    const parsed = hostMoveInputSchema.safeParse({
      clusterId: selectedDestinationId,
      moveDate,
    });
    if (!parsed.success) {
      setErrors(
        mapIssuesToFieldErrors(parsed.error.issues, {
          clusterId: 'destinationClusterId',
          moveDate: 'moveMonth',
        }),
      );
      return;
    }
    setStep('confirm');
  };

  const onConfirm = (): void => {
    const moveDate = `${moveMonth}-01`;
    mutation.mutate({ clusterId: selectedDestinationId, moveDate });
  };

  const monthLabel = moveMonth.length > 0 ? formatMonthLong(`${moveMonth}-01`) : moveMonth;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Same seal as ConfirmDialog (#262): don't let a dismissal mid-submit
        // discard state the onSuccess/onError handlers are about to act on.
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        onEscapeKeyDown={(e) => {
          if (pending) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (pending) e.preventDefault();
        }}
      >
        {step === 'form' ? (
          <>
            <DialogHeader>
              <DialogTitle>Move {host.name}</DialogTitle>
              <DialogDescription>
                Moves this host to a different cluster from the chosen month forward. Capacity
                before that month stays attributed to the current cluster; history is never
                rewritten.
              </DialogDescription>
            </DialogHeader>
            {candidates.length === 0 ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  No other cluster is available as a move destination.
                </p>
                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                    Close
                  </Button>
                </DialogFooter>
              </div>
            ) : (
              <form onSubmit={onContinue} className="space-y-4">
                <div className="space-y-1.5">
                  <label htmlFor="move-destination-cluster" className="text-sm font-medium">
                    Destination cluster
                  </label>
                  <Select
                    value={selectedDestinationId}
                    onValueChange={(value) => setDestinationClusterId(value)}
                  >
                    <SelectTrigger
                      id="move-destination-cluster"
                      aria-invalid={errors.destinationClusterId ? 'true' : undefined}
                      aria-describedby={
                        errors.destinationClusterId ? 'move-destination-cluster-error' : undefined
                      }
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {candidates.map((candidate) => (
                        <SelectItem key={candidate.id} value={candidate.id}>
                          {candidate.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {errors.destinationClusterId ? (
                    <p id="move-destination-cluster-error" className="text-xs text-destructive">
                      {errors.destinationClusterId}
                    </p>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="move-effective-month" className="text-sm font-medium">
                    Effective month
                  </label>
                  <input
                    id="move-effective-month"
                    type="month"
                    value={moveMonth}
                    onChange={(e) => setMoveMonth(e.target.value)}
                    required
                    aria-invalid={errors.moveMonth ? 'true' : undefined}
                    aria-describedby={errors.moveMonth ? 'move-effective-month-error' : undefined}
                    className="flex h-8 w-full rounded-[var(--radius)] border border-input bg-background px-2.5 py-1 text-sm transition-colors hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  {errors.moveMonth ? (
                    <p id="move-effective-month-error" className="text-xs text-destructive">
                      {errors.moveMonth}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Must be the first of a month; matches the forecast's monthly granularity.
                    </p>
                  )}
                </div>
                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" variant="accent">
                    Continue
                  </Button>
                </DialogFooter>
              </form>
            )}
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Confirm move</DialogTitle>
              <DialogDescription>
                Review the scope of this change before it takes effect.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 rounded-[var(--radius)] border border-warning/40 bg-warning/5 p-3 text-sm">
              <p>
                <strong>{host.name}</strong> will move from{' '}
                <strong>{sourceCluster?.name ?? 'its current cluster'}</strong> to{' '}
                <strong>{destinationCluster?.name ?? 'the selected cluster'}</strong>, effective{' '}
                <strong>{monthLabel}</strong>.
              </p>
              <p className="text-fg-muted">
                From that month forward, its capacity counts toward{' '}
                {destinationCluster?.name ?? 'the destination cluster'} instead of{' '}
                {sourceCluster?.name ?? 'the current cluster'}. Months before {monthLabel} are
                unaffected for both clusters — history is not rewritten.
              </p>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep('form')}
                disabled={pending}
              >
                Back
              </Button>
              <Button type="button" variant="accent" onClick={onConfirm} disabled={pending}>
                {pending ? 'Moving…' : 'Move host'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
