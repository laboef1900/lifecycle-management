import { hostUpdateInputSchema } from '@lcm/shared';
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Field } from '@/components/form/field';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api, describeApiError, type HostUpdateInputWire } from '@/lib/api-client';

import { AssetFieldset, type AssetValues } from './asset-fieldset';
import {
  mapIssuesToFieldErrors,
  optionalDate,
  optionalText,
  useHostMutations,
  type WithHostProps,
} from './shared';

export function EditHostDialog({
  open,
  onOpenChange,
  clusterId,
  host,
}: WithHostProps): React.JSX.Element {
  const { invalidate } = useHostMutations(clusterId);
  const [name, setName] = useState(host.name);
  const [description, setDescription] = useState(host.description ?? '');
  const [asset, setAsset] = useState<AssetValues>({
    serialNumber: host.serialNumber ?? '',
    vendor: host.vendor ?? '',
    model: host.model ?? '',
    purchasedAt: host.purchasedAt ?? '',
    warrantyEndsAt: host.warrantyEndsAt ?? '',
    eolAt: host.eolAt ?? '',
    runPastEol: host.runPastEol,
  });
  const [errors, setErrors] = useState<{ name?: string }>({});

  const mutation = useMutation({
    mutationFn: (payload: HostUpdateInputWire) => api.hosts.update(host.id, payload),
    onSuccess: () => {
      invalidate();
      toast.success('Host updated');
      onOpenChange(false);
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not update host')),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setErrors({});
    const trimmed = description.trim();
    const payload: HostUpdateInputWire = {
      name,
      description: trimmed.length > 0 ? trimmed : null,
      serialNumber: optionalText(asset.serialNumber),
      vendor: optionalText(asset.vendor),
      model: optionalText(asset.model),
      purchasedAt: optionalDate(asset.purchasedAt),
      warrantyEndsAt: optionalDate(asset.warrantyEndsAt),
      eolAt: optionalDate(asset.eolAt),
      runPastEol: asset.runPastEol,
    };
    const parsed = hostUpdateInputSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors = mapIssuesToFieldErrors(parsed.error.issues, { name: 'name' });
      setErrors(fieldErrors);
      if (Object.keys(fieldErrors).length === 0) {
        toast.error(parsed.error.issues[0]?.message ?? 'Invalid input');
      }
      return;
    }
    mutation.mutate(payload);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit host</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={errors.name}
            maxLength={120}
            required
          />
          <Field
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
          />
          <AssetFieldset
            values={asset}
            onChange={(patch) => setAsset((prev) => ({ ...prev, ...patch }))}
          />
          <DialogFooter>
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
