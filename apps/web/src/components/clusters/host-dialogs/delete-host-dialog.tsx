import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/form/confirm-dialog';
import { api, describeApiError } from '@/lib/api-client';

import { useHostMutations, type WithHostProps } from './shared';

export function DeleteHostDialog({
  open,
  onOpenChange,
  clusterId,
  host,
}: WithHostProps): React.JSX.Element {
  const { invalidate } = useHostMutations(clusterId);
  const mutation = useMutation({
    mutationFn: () => api.hosts.delete(host.id),
    onSuccess: () => {
      invalidate();
      toast.success('Host deleted');
      onOpenChange(false);
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not delete host')),
  });

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${host.name}?`}
      description="Capacity history will be removed. This cannot be undone."
      confirmLabel="Delete host"
      destructive
      pending={mutation.isPending}
      onConfirm={() => mutation.mutate()}
    />
  );
}
