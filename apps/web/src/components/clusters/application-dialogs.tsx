import {
  allocationRowInputSchema,
  applicationCreateInputSchema,
  applicationUpdateInputSchema,
} from '@lcm/shared';
import type { ApplicationResponse } from '@lcm/shared';
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
  type AllocationAppendInputWire,
  type ApplicationCreateInputWire,
  type ApplicationUpdateInputWire,
} from '@/lib/api-client';
import { todayIso } from '@/lib/format';

interface CommonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clusterId: string;
}

interface WithAppProps extends CommonDialogProps {
  application: ApplicationResponse;
}

function useAppMutations(clusterId: string): { invalidate: () => void } {
  const queryClient = useQueryClient();
  return {
    invalidate: () => {
      void queryClient.invalidateQueries({ queryKey: ['applications', clusterId] });
      void queryClient.invalidateQueries({ queryKey: ['forecast', clusterId] });
    },
  };
}

function describeApiError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// ---------- Create application ----------

interface AppFormState {
  name: string;
  category: string;
  description: string;
  startedAt: string;
  allocationAmount: string;
}

const blankAppForm = (): AppFormState => ({
  name: '',
  category: 'openshift',
  description: '',
  startedAt: todayIso(),
  allocationAmount: '0',
});

export function CreateApplicationDialog({
  open,
  onOpenChange,
  clusterId,
}: CommonDialogProps): React.JSX.Element {
  const { invalidate } = useAppMutations(clusterId);
  const [form, setForm] = useState<AppFormState>(blankAppForm());
  const [errors, setErrors] = useState<Partial<Record<keyof AppFormState, string>>>({});

  const mutation = useMutation({
    mutationFn: (payload: ApplicationCreateInputWire) =>
      api.applications.create(clusterId, payload),
    onSuccess: () => {
      invalidate();
      toast.success('Application added');
      onOpenChange(false);
      setForm(blankAppForm());
      setErrors({});
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not add application')),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setErrors({});
    const description = form.description.trim();
    const payload: ApplicationCreateInputWire = {
      name: form.name,
      category: form.category,
      startedAt: form.startedAt,
      allocations: [
        {
          metricTypeKey: 'memory_gb',
          effectiveFrom: form.startedAt,
          amount: Number(form.allocationAmount),
        },
      ],
      ...(description.length > 0 && { description }),
    };
    const parsed = applicationCreateInputSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors: Partial<Record<keyof AppFormState, string>> = {};
      for (const issue of parsed.error.issues) {
        const root = issue.path[0];
        if (root === 'name') fieldErrors.name = issue.message;
        else if (root === 'category') fieldErrors.category = issue.message;
        else if (root === 'startedAt') fieldErrors.startedAt = issue.message;
        else if (root === 'allocations') fieldErrors.allocationAmount = issue.message;
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
          setForm(blankAppForm());
          setErrors({});
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add application</DialogTitle>
          <DialogDescription>
            Memory-consuming workload. Category is a free-form label (openshift, database, …).
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field
            label="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            error={errors.name}
            placeholder="openshift-lab"
            required
          />
          <Field
            label="Category"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            error={errors.category}
            required
          />
          <Field
            label="Description"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Optional"
          />
          <Field
            label="Started at"
            type="date"
            value={form.startedAt}
            onChange={(e) => setForm({ ...form, startedAt: e.target.value })}
            error={errors.startedAt}
            required
          />
          <Field
            label="Initial memory allocation (GB)"
            type="number"
            min="0"
            step="1"
            value={form.allocationAmount}
            onChange={(e) => setForm({ ...form, allocationAmount: e.target.value })}
            error={errors.allocationAmount}
            required
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={mutation.isPending}>
              {mutation.isPending ? 'Adding…' : 'Add application'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Edit application ----------

export function EditApplicationDialog({
  open,
  onOpenChange,
  clusterId,
  application,
}: WithAppProps): React.JSX.Element {
  const { invalidate } = useAppMutations(clusterId);
  const [name, setName] = useState(application.name);
  const [category, setCategory] = useState(application.category);
  const [description, setDescription] = useState(application.description ?? '');
  const [errors, setErrors] = useState<{ name?: string; category?: string }>({});

  const mutation = useMutation({
    mutationFn: (payload: ApplicationUpdateInputWire) =>
      api.applications.update(application.id, payload),
    onSuccess: () => {
      invalidate();
      toast.success('Application updated');
      onOpenChange(false);
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not update application')),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setErrors({});
    const trimmed = description.trim();
    const payload: ApplicationUpdateInputWire = {
      name,
      category,
      description: trimmed.length > 0 ? trimmed : null,
    };
    const parsed = applicationUpdateInputSchema.safeParse(payload);
    if (!parsed.success) {
      const next: { name?: string; category?: string } = {};
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'name') next.name = issue.message;
        if (issue.path[0] === 'category') next.category = issue.message;
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
          <DialogTitle>Edit application</DialogTitle>
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
            label="Category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            error={errors.category}
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

// ---------- Resize application allocation ----------

export function ResizeApplicationDialog({
  open,
  onOpenChange,
  clusterId,
  application,
}: WithAppProps): React.JSX.Element {
  const { invalidate } = useAppMutations(clusterId);
  const latest = application.allocations[application.allocations.length - 1];
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [amount, setAmount] = useState(String(latest?.amount ?? 0));
  const [errors, setErrors] = useState<{ effectiveFrom?: string; amount?: string }>({});

  const mutation = useMutation({
    mutationFn: (payload: AllocationAppendInputWire) =>
      api.applications.appendAllocation(application.id, payload),
    onSuccess: () => {
      invalidate();
      toast.success('Allocation updated');
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(describeApiError(err, 'Resize failed'));
      if (err instanceof ApiError) {
        if (err.code === 'EFFECTIVE_BEFORE_START' || err.code === 'EFFECTIVE_NOT_MONOTONIC') {
          setErrors({ effectiveFrom: err.message });
        }
      }
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setErrors({});
    const payload: AllocationAppendInputWire = {
      metricTypeKey: latest?.metricTypeKey ?? 'memory_gb',
      effectiveFrom,
      amount: Number(amount),
    };
    const parsed = allocationRowInputSchema.safeParse(payload);
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
          <DialogTitle>Resize {application.name}</DialogTitle>
          <DialogDescription>
            Appends a new allocation row.
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
            label="New allocation (GB)"
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

// ---------- End application ----------

export function EndApplicationDialog({
  open,
  onOpenChange,
  clusterId,
  application,
}: WithAppProps): React.JSX.Element {
  const { invalidate } = useAppMutations(clusterId);
  const [endedAt, setEndedAt] = useState(application.endedAt ?? todayIso());

  const mutation = useMutation({
    mutationFn: (payload: ApplicationUpdateInputWire) =>
      api.applications.update(application.id, payload),
    onSuccess: () => {
      invalidate();
      toast.success(application.endedAt ? 'Application updated' : 'Application ended');
      onOpenChange(false);
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not end application')),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    mutation.mutate({ endedAt });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>End {application.name}</DialogTitle>
          <DialogDescription>
            Allocation stops contributing on this date. History is preserved.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field
            label="Ended at"
            type="date"
            value={endedAt}
            onChange={(e) => setEndedAt(e.target.value)}
            required
          />
          <DialogFooter>
            {application.endedAt ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => mutation.mutate({ endedAt: null })}
                disabled={mutation.isPending}
              >
                Clear end date
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

// ---------- Delete application ----------

export function DeleteApplicationDialog({
  open,
  onOpenChange,
  clusterId,
  application,
}: WithAppProps): React.JSX.Element {
  const { invalidate } = useAppMutations(clusterId);
  const mutation = useMutation({
    mutationFn: () => api.applications.delete(application.id),
    onSuccess: () => {
      invalidate();
      toast.success('Application deleted');
      onOpenChange(false);
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not delete application')),
  });

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${application.name}?`}
      description="Allocation history will be removed. This cannot be undone."
      confirmLabel="Delete application"
      destructive
      pending={mutation.isPending}
      onConfirm={() => mutation.mutate()}
    />
  );
}
