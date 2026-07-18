import { clusterCreateInputSchema } from '@lcm/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
  DialogTrigger,
} from '@/components/ui/dialog';
import { ApiError, api, type ClusterCreateInputWire } from '@/lib/api-client';

interface CreateClusterDialogProps {
  trigger?: React.ReactNode;
}

interface FormState {
  name: string;
  description: string;
  baselineDate: string;
  baselineConsumption: string;
  baselineCapacity: string;
}

const today = new Date();
const initialState: FormState = {
  name: '',
  description: '',
  baselineDate: `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-01`,
  baselineConsumption: '0',
  baselineCapacity: '0',
};

export function CreateClusterDialog({ trigger }: CreateClusterDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(initialState);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof FormState, string>>>({});

  const mutation = useMutation({
    mutationFn: (payload: ClusterCreateInputWire) => api.clusters.create(payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['clusters'] });
      toast.success('Cluster created');
      setOpen(false);
      setForm(initialState);
      setFieldErrors({});
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        toast.error(err.message);
        if (err.code === 'CLUSTER_NAME_TAKEN') {
          setFieldErrors({ name: err.message });
        }
      } else {
        toast.error('Could not create cluster');
      }
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setFieldErrors({});
    const description = form.description.trim();
    const candidate: ClusterCreateInputWire = {
      name: form.name,
      baselineDate: form.baselineDate,
      baselines: [
        {
          metricTypeKey: 'memory_gb',
          baselineConsumption: Number(form.baselineConsumption),
          baselineCapacity: Number(form.baselineCapacity),
        },
      ],
      ...(description.length > 0 && { description }),
    };
    const parsed = clusterCreateInputSchema.safeParse(candidate);
    if (!parsed.success) {
      const errors: Partial<Record<keyof FormState, string>> = {};
      for (const issue of parsed.error.issues) {
        const root = issue.path[0];
        if (root === 'name' || root === 'description' || root === 'baselineDate') {
          errors[root] = issue.message;
        } else if (root === 'baselines') {
          const field = issue.path[2];
          if (field === 'baselineConsumption') errors.baselineConsumption = issue.message;
          if (field === 'baselineCapacity') errors.baselineCapacity = issue.message;
        }
      }
      setFieldErrors(errors);
      return;
    }
    mutation.mutate(candidate);
  };

  const update =
    <K extends keyof FormState>(key: K) =>
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      setForm((prev) => ({ ...prev, [key]: event.target.value }));
    };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? <Button variant="accent">+ Add cluster</Button>}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New cluster</DialogTitle>
          <DialogDescription>
            Track a new vSphere cluster. Memory baselines are required.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field
            label="Name"
            value={form.name}
            onChange={update('name')}
            error={fieldErrors.name}
            placeholder="CL-DMZ-P1"
            required
          />
          <Field
            label="Description"
            value={form.description}
            onChange={update('description')}
            error={fieldErrors.description}
            placeholder="Optional"
          />
          <Field
            label="Baseline date"
            type="date"
            value={form.baselineDate}
            onChange={update('baselineDate')}
            error={fieldErrors.baselineDate}
            required
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Consumption (GB)"
              type="number"
              min="0"
              step="1"
              value={form.baselineConsumption}
              onChange={update('baselineConsumption')}
              error={fieldErrors.baselineConsumption}
              required
            />
            <Field
              label="Capacity (GB)"
              type="number"
              min="0"
              step="1"
              value={form.baselineCapacity}
              onChange={update('baselineCapacity')}
              error={fieldErrors.baselineCapacity}
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={mutation.isPending}>
              {mutation.isPending ? 'Creating…' : 'Create cluster'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
