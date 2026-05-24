import { capacityRowInputSchema, hostCreateInputSchema, hostUpdateInputSchema } from '@lcm/shared';
import type { HostResponse } from '@lcm/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/form/confirm-dialog';
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
  ApiError,
  api,
  type CapacityAppendInputWire,
  type HostCreateInputWire,
  type HostUpdateInputWire,
} from '@/lib/api-client';
import { todayIso } from '@/lib/format';

interface CommonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clusterId: string;
}

interface WithHostProps extends CommonDialogProps {
  host: HostResponse;
}

function useHostMutations(clusterId: string): {
  invalidate: () => void;
} {
  const queryClient = useQueryClient();
  return {
    invalidate: () => {
      void queryClient.invalidateQueries({ queryKey: ['hosts', clusterId] });
      void queryClient.invalidateQueries({ queryKey: ['forecast', clusterId] });
    },
  };
}

function describeApiError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// ---------- Create host ----------

interface HostFormState {
  name: string;
  description: string;
  commissionedAt: string;
  capacityAmount: string;
}

const blankHostForm = (): HostFormState => ({
  name: '',
  description: '',
  commissionedAt: todayIso(),
  capacityAmount: '0',
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
    };
    const parsed = hostCreateInputSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors: Partial<Record<keyof HostFormState, string>> = {};
      for (const issue of parsed.error.issues) {
        const root = issue.path[0];
        if (root === 'name') fieldErrors.name = issue.message;
        else if (root === 'commissionedAt') fieldErrors.commissionedAt = issue.message;
        else if (root === 'capacities') fieldErrors.capacityAmount = issue.message;
      }
      setErrors(fieldErrors);
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
      <DialogContent>
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
            required
          />
          <Field
            label="Description"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Optional"
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

// ---------- Edit host (name + description) ----------

export function EditHostDialog({
  open,
  onOpenChange,
  clusterId,
  host,
}: WithHostProps): React.JSX.Element {
  const { invalidate } = useHostMutations(clusterId);
  const [name, setName] = useState(host.name);
  const [description, setDescription] = useState(host.description ?? '');
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
    };
    const parsed = hostUpdateInputSchema.safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      if (issue?.path[0] === 'name') setErrors({ name: issue.message });
      return;
    }
    mutation.mutate(payload);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit host</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={errors.name}
            required
          />
          <Field
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
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

// ---------- Resize host (append capacity row) ----------

export function ResizeHostDialog({
  open,
  onOpenChange,
  clusterId,
  host,
}: WithHostProps): React.JSX.Element {
  const { invalidate } = useHostMutations(clusterId);
  const latest = host.capacities[host.capacities.length - 1];
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [amount, setAmount] = useState(String(latest?.amount ?? 0));
  const [errors, setErrors] = useState<{ effectiveFrom?: string; amount?: string }>({});

  const mutation = useMutation({
    mutationFn: (payload: CapacityAppendInputWire) => api.hosts.appendCapacity(host.id, payload),
    onSuccess: () => {
      invalidate();
      toast.success('Capacity updated');
      onOpenChange(false);
    },
    onError: (err) => {
      const message = describeApiError(err, 'Resize failed');
      toast.error(message);
      if (err instanceof ApiError) {
        if (err.code === 'EFFECTIVE_BEFORE_COMMISSION' || err.code === 'EFFECTIVE_NOT_MONOTONIC') {
          setErrors({ effectiveFrom: err.message });
        }
      }
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setErrors({});
    const payload: CapacityAppendInputWire = {
      metricTypeKey: latest?.metricTypeKey ?? 'memory_gb',
      effectiveFrom,
      amount: Number(amount),
    };
    const parsed = capacityRowInputSchema.safeParse(payload);
    if (!parsed.success) {
      const next: { effectiveFrom?: string; amount?: string } = {};
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'effectiveFrom') next.effectiveFrom = issue.message;
        if (issue.path[0] === 'amount') next.amount = issue.message;
      }
      setErrors(next);
      return;
    }
    mutation.mutate(payload);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resize {host.name}</DialogTitle>
          <DialogDescription>
            Appends a new capacity row; the previous row stays in the timeline.
            {latest
              ? ` Most recent: ${latest.amount} ${latest.unit} from ${latest.effectiveFrom}.`
              : null}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field
            label="Effective from"
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            error={errors.effectiveFrom}
            required
          />
          <Field
            label="New capacity (GB)"
            type="number"
            min="0"
            step="1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={errors.amount}
            required
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : 'Add resize'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Decommission host ----------

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

// ---------- Delete host ----------

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
