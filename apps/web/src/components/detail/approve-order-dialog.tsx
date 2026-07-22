import type { ProcurementInfo } from '@lcm/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError, api, describeApiError } from '@/lib/api-client';
import { formatDateShort } from '@/lib/format-month';

const NOTE_MAX = 2000;

interface ApproveOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clusterId: string;
  clusterName: string;
  /** The live recommendation being approved — shown so the admin approves a specific order. */
  procurement: ProcurementInfo;
}

/**
 * Collects an optional note and records an order approval (#292). The server
 * snapshots the CURRENT breach, so nothing about the order is sent — only the
 * note. On success it invalidates every forecast query for this cluster, so the
 * recommendation chip flips to its "Acknowledged" annotation on the next render.
 * State resets across re-opens via a `key` from the parent (per this codebase's
 * no-`useEffect`-reset convention).
 */
export function ApproveOrderDialog({
  open,
  onOpenChange,
  clusterId,
  clusterName,
  procurement,
}: ApproveOrderDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const formRef = useRef<HTMLFormElement>(null);

  const mutation = useMutation({
    mutationFn: (payload: { note?: string }) => api.orderApprovals.create(clusterId, payload),
    onSuccess: async () => {
      // Prefix match invalidates the base AND scenario forecast queries for this
      // cluster (queryKey ['forecast', clusterId, …]).
      await queryClient.invalidateQueries({ queryKey: ['forecast', clusterId] });
      toast.success('Order acknowledged');
      onOpenChange(false);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'NO_LIVE_BREACH') {
        setError('This cluster no longer has a live breach to approve — refresh the forecast.');
        return;
      }
      setError(describeApiError(err, 'Could not record the approval'));
    },
  });

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setError(undefined);
    const trimmed = note.trim();
    mutation.mutate(trimmed.length > 0 ? { note: trimmed } : {});
  };

  const orderByLabel = procurement.orderByDate ? formatDateShort(procurement.orderByDate) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve order for {clusterName}</DialogTitle>
          <DialogDescription>
            Records that this order recommendation has been reviewed. It is an annotation only — it
            never changes the forecast. A later capacity change, threshold change, or a materially
            earlier order date re-surfaces the order for a fresh approval.
          </DialogDescription>
        </DialogHeader>
        <form ref={formRef} onSubmit={onSubmit} className="space-y-4">
          {orderByLabel ? (
            <p className="text-sm text-fg-muted">
              Last safe order date <strong className="text-fg">{orderByLabel}</strong>
              {procurement.leadTimeWeeks > 0 ? ` · ${procurement.leadTimeWeeks}-wk lead` : ''}.
            </p>
          ) : null}
          <div className="space-y-1.5">
            <label htmlFor="approve-order-note" className="text-sm font-medium">
              Note <span className="font-normal text-fg-subtle">(optional)</span>
            </label>
            <textarea
              id="approve-order-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={NOTE_MAX}
              rows={3}
              placeholder="e.g. PO raised, 2 nodes ordered, ETA Q3"
              className="flex w-full rounded-[var(--radius)] border border-input bg-background px-2.5 py-1.5 text-sm placeholder:text-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
              aria-describedby={error ? 'approve-order-error' : undefined}
              aria-invalid={error ? 'true' : undefined}
            />
            {error ? (
              <p id="approve-order-error" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={mutation.isPending}>
              {mutation.isPending ? 'Approving…' : 'Approve order'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
