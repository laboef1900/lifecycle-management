import { hostReplacementCreateInputSchema } from '@lcm/shared';
import type { HostResponse } from '@lcm/shared';
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Field } from '@/components/form/field';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ApiError,
  api,
  describeApiError,
  type HostReplacementCreateInputWire,
} from '@/lib/api-client';
import { todayIso } from '@/lib/format';

import { mapIssuesToFieldErrors, useHostMutations, type WithHostProps } from './shared';

interface HostReplaceDialogProps extends WithHostProps {
  candidates: HostResponse[];
}

/**
 * Records a 1:1 host replacement (oldHostId → newHostId, swappedAt, reason?).
 * The candidate list is filtered down to "other hosts in the same cluster" by
 * the parent (HostsTab already has them in memory) and additionally filtered
 * here to exclude the old host itself defensively.
 *
 * Surfaces server validation:
 * - 422 CROSS_CLUSTER_REPLACEMENT — hosts are in different clusters (should be
 *   unreachable given the candidates filter, but stale data could trigger it).
 * - 409 REPLACEMENT_DUPLICATE — the (oldHostId, newHostId) pair already exists.
 *
 * Like HostTransitionDialog, state resets across re-opens via `key={host.id}`
 * supplied by the parent — `useEffect` resets are forbidden by lint rules.
 */
export function HostReplaceDialog({
  open,
  onOpenChange,
  clusterId,
  host,
  candidates,
}: HostReplaceDialogProps): React.JSX.Element {
  const { invalidate } = useHostMutations(clusterId);
  const eligible = candidates.filter((candidate) => candidate.id !== host.id);
  const [newHostId, setNewHostId] = useState<string>(eligible[0]?.id ?? '');
  const [swappedAt, setSwappedAt] = useState(todayIso());
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{
    newHostId?: string;
    swappedAt?: string;
    reason?: string;
  }>({});

  const mutation = useMutation({
    mutationFn: (payload: HostReplacementCreateInputWire) => api.hostReplacements.create(payload),
    onSuccess: () => {
      invalidate();
      toast.success('Replacement recorded');
      onOpenChange(false);
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        if (err.code === 'REPLACEMENT_DUPLICATE') {
          toast.error('This replacement has already been recorded for these two hosts.');
          return;
        }
        if (err.code === 'CROSS_CLUSTER_REPLACEMENT') {
          toast.error('Both hosts must belong to the same cluster.');
          return;
        }
      }
      toast.error(describeApiError(err, 'Could not record replacement'));
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setErrors({});
    const trimmedReason = reason.trim();
    const payload: HostReplacementCreateInputWire = {
      oldHostId: host.id,
      newHostId,
      swappedAt,
      ...(trimmedReason.length > 0 && { reason: trimmedReason }),
    };
    const parsed = hostReplacementCreateInputSchema.safeParse(payload);
    if (!parsed.success) {
      setErrors(
        mapIssuesToFieldErrors(parsed.error.issues, {
          newHostId: 'newHostId',
          swappedAt: 'swappedAt',
          reason: 'reason',
        }),
      );
      return;
    }
    mutation.mutate(payload);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Replace {host.name}</DialogTitle>
          <DialogDescription>
            Record a 1:1 hardware swap. Capacity stays attributed correctly on either side of the
            swap date.
          </DialogDescription>
        </DialogHeader>
        {eligible.length === 0 ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              No eligible hosts in this cluster to replace with.
            </p>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="replace-new-host" className="text-sm font-medium">
                Replacement host
              </label>
              <Select value={newHostId} onValueChange={(value) => setNewHostId(value)}>
                <SelectTrigger id="replace-new-host">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {eligible.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.newHostId ? (
                <p className="text-xs text-destructive">{errors.newHostId}</p>
              ) : null}
            </div>
            <Field
              label="Swapped at"
              type="date"
              value={swappedAt}
              onChange={(e) => setSwappedAt(e.target.value)}
              error={errors.swappedAt}
              required
            />
            <div className="space-y-1.5">
              <label htmlFor="replace-reason" className="text-sm font-medium">
                Reason
              </label>
              <textarea
                id="replace-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={2000}
                rows={3}
                placeholder="Optional context (e.g. RMA, capacity upgrade)"
                className="flex w-full rounded-[var(--radius)] border border-input bg-background px-2.5 py-1.5 text-sm placeholder:text-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
                aria-invalid={errors.reason ? 'true' : undefined}
              />
              {errors.reason ? <p className="text-xs text-destructive">{errors.reason}</p> : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="accent" disabled={mutation.isPending}>
                {mutation.isPending ? 'Saving…' : 'Record replacement'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
