import { hostCreateInputSchema } from '@lcm/shared';
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
import { api, describeApiError, type HostCreateInputWire } from '@/lib/api-client';
import { todayIso } from '@/lib/format';

import { AssetFieldset } from './asset-fieldset';
import {
  mapIssuesToFieldErrors,
  optionalDate,
  optionalText,
  useHostMutations,
  type CommonDialogProps,
} from './shared';

interface HostFormState {
  name: string;
  description: string;
  commissionedAt: string;
  capacityAmount: string;
  serialNumber: string;
  vendor: string;
  model: string;
  purchasedAt: string;
  warrantyEndsAt: string;
  eolAt: string;
  runPastEol: boolean;
}

const blankHostForm = (): HostFormState => ({
  name: '',
  description: '',
  commissionedAt: todayIso(),
  capacityAmount: '0',
  serialNumber: '',
  vendor: '',
  model: '',
  purchasedAt: '',
  warrantyEndsAt: '',
  eolAt: '',
  runPastEol: false,
});

export function CreateHostDialog({
  open,
  onOpenChange,
  clusterId,
}: CommonDialogProps): React.JSX.Element {
  const { invalidate } = useHostMutations(clusterId);
  const [form, setForm] = useState<HostFormState>(blankHostForm());
  const [errors, setErrors] = useState<Partial<Record<keyof HostFormState, string>>>({});

  const mutation = useMutation({
    mutationFn: (payload: HostCreateInputWire) => api.hosts.create(clusterId, payload),
    onSuccess: () => {
      invalidate();
      toast.success('Host added');
      onOpenChange(false);
      setForm(blankHostForm());
      setErrors({});
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not add host')),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setErrors({});
    const description = form.description.trim();
    const payload: HostCreateInputWire = {
      name: form.name,
      commissionedAt: form.commissionedAt,
      capacities: [
        {
          metricTypeKey: 'memory_gb',
          effectiveFrom: form.commissionedAt,
          amount: Number(form.capacityAmount),
        },
      ],
      ...(description.length > 0 && { description }),
      serialNumber: optionalText(form.serialNumber),
      vendor: optionalText(form.vendor),
      model: optionalText(form.model),
      purchasedAt: optionalDate(form.purchasedAt),
      warrantyEndsAt: optionalDate(form.warrantyEndsAt),
      eolAt: optionalDate(form.eolAt),
      runPastEol: form.runPastEol,
    };
    const parsed = hostCreateInputSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors = mapIssuesToFieldErrors(parsed.error.issues, {
        name: 'name',
        commissionedAt: 'commissionedAt',
        capacities: 'capacityAmount',
      });
      setErrors(fieldErrors);
      if (Object.keys(fieldErrors).length === 0) {
        toast.error(parsed.error.issues[0]?.message ?? 'Invalid input');
      }
      return;
    }
    mutation.mutate(payload);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value);
        if (!value) {
          setForm(blankHostForm());
          setErrors({});
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add host</DialogTitle>
          <DialogDescription>
            Capacity provider for this cluster. Initial memory capacity required.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field
            label="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            error={errors.name}
            placeholder="hpe-01"
            maxLength={120}
            required
          />
          <Field
            label="Description"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Optional"
            maxLength={2000}
          />
          <Field
            label="Commissioned at"
            type="date"
            value={form.commissionedAt}
            onChange={(e) => setForm({ ...form, commissionedAt: e.target.value })}
            error={errors.commissionedAt}
            required
          />
          <Field
            label="Initial memory capacity (GB)"
            type="number"
            min="0"
            step="1"
            value={form.capacityAmount}
            onChange={(e) => setForm({ ...form, capacityAmount: e.target.value })}
            error={errors.capacityAmount}
            required
          />
          <AssetFieldset
            values={{
              serialNumber: form.serialNumber,
              vendor: form.vendor,
              model: form.model,
              purchasedAt: form.purchasedAt,
              warrantyEndsAt: form.warrantyEndsAt,
              eolAt: form.eolAt,
              runPastEol: form.runPastEol,
            }}
            onChange={(patch) => setForm({ ...form, ...patch })}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={mutation.isPending}>
              {mutation.isPending ? 'Adding…' : 'Add host'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
