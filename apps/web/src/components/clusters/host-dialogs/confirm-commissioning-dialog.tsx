import type { HostResponse } from '@lcm/shared';
import { hostCommissioningConfirmInputSchema } from '@lcm/shared';
import { useMutation } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Field, useFocusFirstInvalidField } from '@/components/form/field';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api, describeApiError, type HostCommissioningConfirmInputWire } from '@/lib/api-client';

import { useHostMutations, type CommonDialogProps } from './shared';

interface ConfirmCommissioningDialogProps extends CommonDialogProps {
  /** The provisional synced hosts to confirm. Order is the display order. */
  hosts: HostResponse[];
}

/**
 * Confirm the provisional commissioning date on synced hosts (Q9c, #194).
 *
 * vCenter cannot tell us when a host was commissioned, so sync stamps a
 * provisional date and flags it. Each row is pre-filled with that imported date
 * — the honest default (owner decision: keep the import date, do NOT backdate) —
 * and the operator adjusts any that are wrong. Submitting confirms the whole
 * batch in one transactional request; the server rejects an out-of-range date and
 * aborts the batch rather than committing a partial result.
 */
export function ConfirmCommissioningDialog({
  open,
  onOpenChange,
  clusterId,
  hosts,
}: ConfirmCommissioningDialogProps): React.JSX.Element {
  const { invalidate } = useHostMutations(clusterId);
  const [dates, setDates] = useState<Record<string, string>>(() =>
    Object.fromEntries(hosts.map((h) => [h.id, h.commissionedAt])),
  );
  const [bulkDate, setBulkDate] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalidField(formRef, errors);

  // Set the same date on every host in one action (#283). A fleet vCenter
  // import is typically commissioned on a single day, so filling each row by
  // hand is repetitive; this applies one date to all rows while leaving each
  // row editable afterward for the exceptions. An empty value is ignored so
  // clearing this convenience field never blanks every row (which would only
  // block submit). Overwriting the rows also clears their now-stale errors.
  const applyToAll = (value: string): void => {
    setBulkDate(value);
    if (value.length === 0) return;
    setDates(Object.fromEntries(hosts.map((h) => [h.id, value])));
    setErrors({});
  };

  const mutation = useMutation({
    mutationFn: (payload: HostCommissioningConfirmInputWire) =>
      api.hosts.confirmCommissioning(payload),
    onSuccess: (confirmed) => {
      invalidate();
      toast.success(
        confirmed.length === 1
          ? 'Commissioning date confirmed'
          : `${confirmed.length} commissioning dates confirmed`,
      );
      onOpenChange(false);
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not confirm commissioning dates')),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setErrors({});
    const payload: HostCommissioningConfirmInputWire = {
      hosts: hosts.map((h) => ({ hostId: h.id, commissionedAt: dates[h.id] ?? '' })),
    };
    const parsed = hostCommissioningConfirmInputSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        // Issue paths look like ['hosts', <index>, 'commissionedAt']; map them
        // back to the host id so the error renders on the right row.
        if (issue.path[0] === 'hosts' && typeof issue.path[1] === 'number') {
          const host = hosts[issue.path[1]];
          if (host) fieldErrors[host.id] = issue.message;
        }
      }
      setErrors(fieldErrors);
      if (Object.keys(fieldErrors).length === 0) {
        toast.error(parsed.error.issues[0]?.message ?? 'Invalid input');
      }
      return;
    }
    mutation.mutate(payload);
  };

  const count = hosts.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Confirm commissioning dates</DialogTitle>
          <DialogDescription>
            vCenter cannot report when a host was commissioned, so{' '}
            {count === 1 ? 'this host' : 'these hosts'} {count === 1 ? 'was' : 'were'} imported with
            a provisional date. Review and confirm the real date for each. Nothing is saved until
            every date is valid.
          </DialogDescription>
        </DialogHeader>
        <form ref={formRef} onSubmit={onSubmit} className="space-y-4">
          {/* Bulk shortcut (#283) — only meaningful with 2+ hosts; a single
              host is edited directly in its own row below, where a separate
              "set all" control would just duplicate that field. */}
          {count > 1 ? (
            <div className="rounded-[var(--radius)] border border-border bg-muted/30 p-3">
              <Field
                label="Set all dates"
                name="bulk-commissioned-at"
                type="date"
                value={bulkDate}
                onChange={(e) => applyToAll(e.target.value)}
                hint="Applies this date to every host below. Adjust individual hosts afterward if needed."
              />
            </div>
          ) : null}
          <div className="space-y-3">
            {hosts.map((host) => (
              <Field
                key={host.id}
                label={host.name}
                type="date"
                value={dates[host.id] ?? ''}
                onChange={(e) => setDates((prev) => ({ ...prev, [host.id]: e.target.value }))}
                error={errors[host.id]}
                hint={`Imported ${host.commissionedAt}`}
                required
              />
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={mutation.isPending}>
              {mutation.isPending
                ? 'Confirming…'
                : count === 1
                  ? 'Confirm date'
                  : `Confirm ${count} dates`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
