import { hostUpdateInputSchema } from '@lcm/shared';
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
import { api, describeApiError, type HostUpdateInputWire } from '@/lib/api-client';
import { todayIso } from '@/lib/format';

import { mapIssuesToFieldErrors, useHostMutations, type WithHostProps } from './shared';

type FieldErrors = Partial<Record<'decommissionedAt', string>>;

export function DecommissionHostDialog({
  open,
  onOpenChange,
  clusterId,
  host,
}: WithHostProps): React.JSX.Element {
  const { invalidate } = useHostMutations(clusterId);
  const [decommissionedAt, setDecommissionedAt] = useState(host.decommissionedAt ?? todayIso());
  const [errors, setErrors] = useState<FieldErrors>({});
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalidField(formRef, errors);

  const mutation = useMutation({
    mutationFn: (payload: HostUpdateInputWire) => api.hosts.update(host.id, payload),
    onSuccess: () => {
      invalidate();
      toast.success(host.decommissionedAt ? 'Host updated' : 'Host decommissioned');
      setErrors({});
      onOpenChange(false);
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not decommission host')),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setErrors({});
    // The form is `noValidate`, so this is the only gate — a blank date must
    // never reach the mutation. The blank case gets the dialog's own words
    // because `dateOnly`'s "Must be a YYYY-MM-DD date" describes a wire format,
    // not the thing the operator forgot to do.
    if (decommissionedAt.length === 0) {
      setErrors({ decommissionedAt: 'Pick the date this host stops contributing capacity.' });
      return;
    }
    const payload: HostUpdateInputWire = { decommissionedAt };
    const parsed = hostUpdateInputSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors = mapIssuesToFieldErrors(parsed.error.issues, {
        decommissionedAt: 'decommissionedAt',
      });
      setErrors(fieldErrors);
      if (Object.keys(fieldErrors).length === 0) {
        toast.error(parsed.error.issues[0]?.message ?? 'Invalid input');
      }
      return;
    }
    mutation.mutate(payload);
  };

  // Clearing needs no date, so it needs no validation — but it must not leave a
  // stale error pointing at a field the operator is no longer being asked about.
  const onClear = (): void => {
    setErrors({});
    mutation.mutate({ decommissionedAt: null });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Decommission {host.name}</DialogTitle>
          <DialogDescription>
            Capacity stops contributing on this date. History is preserved.
          </DialogDescription>
        </DialogHeader>
        <form ref={formRef} onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field
            label="Decommissioned at"
            type="date"
            value={decommissionedAt}
            onChange={(e) => setDecommissionedAt(e.target.value)}
            error={errors.decommissionedAt}
            required
          />
          <DialogFooter>
            {host.decommissionedAt ? (
              <Button type="button" variant="ghost" onClick={onClear} disabled={mutation.isPending}>
                Clear decommission
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
