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
import { api, describeApiError, type HostUpdateInputWire } from '@/lib/api-client';
import { todayIso } from '@/lib/format';

import { useHostMutations, type WithHostProps } from './shared';

export function DecommissionHostDialog({
  open,
  onOpenChange,
  clusterId,
  host,
}: WithHostProps): React.JSX.Element {
  const { invalidate } = useHostMutations(clusterId);
  const [decommissionedAt, setDecommissionedAt] = useState(host.decommissionedAt ?? todayIso());

  const mutation = useMutation({
    mutationFn: (payload: HostUpdateInputWire) => api.hosts.update(host.id, payload),
    onSuccess: () => {
      invalidate();
      toast.success(host.decommissionedAt ? 'Host updated' : 'Host decommissioned');
      onOpenChange(false);
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not decommission host')),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    mutation.mutate({ decommissionedAt });
  };

  const onClear = (): void => {
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
        <form onSubmit={onSubmit} className="space-y-4">
          <Field
            label="Decommissioned at"
            type="date"
            value={decommissionedAt}
            onChange={(e) => setDecommissionedAt(e.target.value)}
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
