import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/form/confirm-dialog';
import { api, describeApiError } from '@/lib/api-client';

import { useItemMutations, type WithItemProps } from './shared';

export function DeleteItemDialog({
  open,
  onOpenChange,
  clusterId,
  item,
}: WithItemProps): React.JSX.Element {
  const { invalidate } = useItemMutations(clusterId);
  const isApp = item.kind === 'application';
  const mutation = useMutation({
    mutationFn: () => api.items.delete(item.id),
    onSuccess: () => {
      invalidate();
      toast.success(isApp ? 'Application deleted' : 'Event deleted');
      onOpenChange(false);
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not delete item')),
  });

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${item.name}?`}
      description={
        isApp
          ? 'Allocation history will be removed. This cannot be undone.'
          : 'This event will no longer affect the forecast.'
      }
      confirmLabel={isApp ? 'Delete application' : 'Delete event'}
      destructive
      pending={mutation.isPending}
      onConfirm={() => mutation.mutate()}
    />
  );
}
