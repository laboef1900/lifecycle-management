import {
  capacityRowInputSchema,
  hostCreateInputSchema,
  hostReplacementCreateInputSchema,
  hostTransitionInputSchema,
  hostUpdateInputSchema,
} from '@lcm/shared';
import type { HostResponse, HostState } from '@lcm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ApiError,
  api,
  type CapacityAppendInputWire,
  type HostCreateInputWire,
  type HostReplacementCreateInputWire,
  type HostTransitionInputWire,
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
      void queryClient.invalidateQueries({ queryKey: ['cluster', clusterId] });
      void queryClient.invalidateQueries({ queryKey: ['clusters'] });
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

/**
 * Trim a string field and return it for wire submission, or `null` to clear it
 * if blank. Used by both CreateHostDialog and EditHostDialog when serializing
 * the Asset section's optional text fields.
 */
function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Same helper for date inputs — empty string means "no date" and serializes to
 * null on the wire (matches dateOnly.nullable() in shared schemas).
 */
function optionalDate(value: string): string | null {
  return value.length > 0 ? value : null;
}

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

// ---------- Asset fieldset (shared by Create + Edit) ----------

interface AssetValues {
  serialNumber: string;
  vendor: string;
  model: string;
  purchasedAt: string;
  warrantyEndsAt: string;
  eolAt: string;
  runPastEol: boolean;
}

interface AssetFieldsetProps {
  values: AssetValues;
  onChange: (patch: Partial<AssetValues>) => void;
}

/**
 * Shared "Asset" fieldset used by both CreateHostDialog and EditHostDialog so
 * the optional asset-tracking fields (serial, vendor, model, purchase/warranty
 * /EOL dates, runPastEol opt-out) stay in sync between the two forms.
 */
function AssetFieldset({ values, onChange }: AssetFieldsetProps): React.JSX.Element {
  return (
    <fieldset className="mt-2 border-t border-border pt-4">
      <legend className="text-sm font-medium">Asset</legend>
      <p className="mt-1 text-xs text-fg-muted">
        Optional hardware metadata used for warranty and EOL reporting.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Serial number"
          value={values.serialNumber}
          onChange={(e) => onChange({ serialNumber: e.target.value })}
          placeholder="Optional"
        />
        <Field
          label="Vendor"
          value={values.vendor}
          onChange={(e) => onChange({ vendor: e.target.value })}
          placeholder="e.g. HPE"
        />
        <Field
          label="Model"
          value={values.model}
          onChange={(e) => onChange({ model: e.target.value })}
          placeholder="e.g. ProLiant DL380"
        />
        <Field
          label="Purchased at"
          type="date"
          value={values.purchasedAt}
          onChange={(e) => onChange({ purchasedAt: e.target.value })}
        />
        <Field
          label="Warranty ends"
          type="date"
          value={values.warrantyEndsAt}
          onChange={(e) => onChange({ warrantyEndsAt: e.target.value })}
        />
        <Field
          label="End of life"
          type="date"
          value={values.eolAt}
          onChange={(e) => onChange({ eolAt: e.target.value })}
        />
      </div>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-input"
          checked={values.runPastEol}
          onChange={(e) => onChange({ runPastEol: e.target.checked })}
        />
        <span>Plan to run past EOL (don&rsquo;t drop from forecast)</span>
      </label>
    </fieldset>
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
      const issue = parsed.error.issues[0];
      if (issue?.path[0] === 'name') setErrors({ name: issue.message });
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
            required
          />
          <Field
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
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

// ---------- Transition host (lifecycle state change) ----------

/**
 * Allowed forward transitions per state. Mirrors the server-side guard so the
 * UI never offers a target the API would reject. `disposed` is terminal — when
 * a host is disposed the dialog renders an info message and a Close button.
 */
const ALLOWED_TRANSITIONS: Record<HostState, HostState[]> = {
  ordered: ['racked'],
  racked: ['in_service'],
  in_service: ['degraded', 'decommissioned'],
  degraded: ['in_service', 'decommissioned'],
  decommissioned: ['disposed'],
  disposed: [],
};

const STATE_LABELS: Record<HostState, string> = {
  ordered: 'Ordered',
  racked: 'Racked',
  in_service: 'In service',
  degraded: 'Degraded',
  decommissioned: 'Decommissioned',
  disposed: 'Disposed',
};

export function HostTransitionDialog({
  open,
  onOpenChange,
  clusterId,
  host,
}: WithHostProps): React.JSX.Element {
  const { invalidate } = useHostMutations(clusterId);
  const choices = ALLOWED_TRANSITIONS[host.state];
  // `toState` defaults to the first allowed target, or the current state as a
  // harmless placeholder when there are no choices (the form branch below is
  // skipped in that case, so the placeholder is never submitted).
  // State resets naturally because the parent unmounts this dialog on close
  // (target → null) and supplies a stable `key={host.id}` per host — re-opening
  // mounts a fresh component, so `useState` initializers run again with the
  // latest props.
  const [toState, setToState] = useState<HostState>(choices[0] ?? host.state);
  const [occurredAt, setOccurredAt] = useState(todayIso());
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<{ toState?: string; occurredAt?: string; note?: string }>(
    {},
  );

  const mutation = useMutation({
    mutationFn: (payload: HostTransitionInputWire) => api.hosts.transition(host.id, payload),
    onSuccess: () => {
      invalidate();
      toast.success('Host transitioned');
      onOpenChange(false);
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not transition host')),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setErrors({});
    const trimmedNote = note.trim();
    const payload: HostTransitionInputWire = {
      toState,
      occurredAt,
      ...(trimmedNote.length > 0 && { note: trimmedNote }),
    };
    const parsed = hostTransitionInputSchema.safeParse(payload);
    if (!parsed.success) {
      const next: { toState?: string; occurredAt?: string; note?: string } = {};
      for (const issue of parsed.error.issues) {
        const root = issue.path[0];
        if (root === 'toState') next.toState = issue.message;
        else if (root === 'occurredAt') next.occurredAt = issue.message;
        else if (root === 'note') next.note = issue.message;
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
          <DialogTitle>Transition {host.name}</DialogTitle>
          <DialogDescription>
            Currently <strong>{STATE_LABELS[host.state]}</strong>. Records a lifecycle event and
            moves the host to the chosen state.
          </DialogDescription>
        </DialogHeader>
        {choices.length === 0 ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              No further transitions are available from <strong>{STATE_LABELS[host.state]}</strong>.
            </p>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="transition-to-state" className="text-sm font-medium">
                Target state
              </label>
              <Select value={toState} onValueChange={(value) => setToState(value as HostState)}>
                <SelectTrigger id="transition-to-state">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {choices.map((option) => (
                    <SelectItem key={option} value={option}>
                      {STATE_LABELS[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.toState ? <p className="text-xs text-destructive">{errors.toState}</p> : null}
            </div>
            <Field
              label="Occurred at"
              type="date"
              value={occurredAt}
              onChange={(e) => setOccurredAt(e.target.value)}
              error={errors.occurredAt}
              required
            />
            <div className="space-y-1.5">
              <label htmlFor="transition-note" className="text-sm font-medium">
                Note
              </label>
              <textarea
                id="transition-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
                rows={3}
                placeholder="Optional context for the audit trail"
                className="flex w-full rounded-[var(--radius)] border border-input bg-background px-2.5 py-1.5 text-sm placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                aria-invalid={errors.note ? 'true' : undefined}
              />
              {errors.note ? <p className="text-xs text-destructive">{errors.note}</p> : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="accent" disabled={mutation.isPending}>
                {mutation.isPending ? 'Saving…' : 'Transition'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------- Replace host ----------

interface HostReplaceDialogProps extends WithHostProps {
  candidates: HostResponse[];
}

/**
 * Records a 1:1 host replacement (oldHostId → newHostId, swappedAt, reason?).
 * The candidate list is filtered down to "other hosts in the same cluster" by
 * the parent (HostsTab already has them in memory) and additionally filtered
 * here to exclude the old host itself defensively.
 *
 * Surfaces server validation:
 * - 422 CROSS_CLUSTER_REPLACEMENT — hosts are in different clusters (should be
 *   unreachable given the candidates filter, but stale data could trigger it).
 * - 409 REPLACEMENT_DUPLICATE — the (oldHostId, newHostId) pair already exists.
 *
 * Like HostTransitionDialog, state resets across re-opens via `key={host.id}`
 * supplied by the parent — `useEffect` resets are forbidden by lint rules.
 */
export function HostReplaceDialog({
  open,
  onOpenChange,
  clusterId,
  host,
  candidates,
}: HostReplaceDialogProps): React.JSX.Element {
  const { invalidate } = useHostMutations(clusterId);
  const eligible = candidates.filter((candidate) => candidate.id !== host.id);
  const [newHostId, setNewHostId] = useState<string>(eligible[0]?.id ?? '');
  const [swappedAt, setSwappedAt] = useState(todayIso());
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{
    newHostId?: string;
    swappedAt?: string;
    reason?: string;
  }>({});

  const mutation = useMutation({
    mutationFn: (payload: HostReplacementCreateInputWire) => api.hostReplacements.create(payload),
    onSuccess: () => {
      invalidate();
      toast.success('Replacement recorded');
      onOpenChange(false);
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        if (err.code === 'REPLACEMENT_DUPLICATE') {
          toast.error('This replacement has already been recorded for these two hosts.');
          return;
        }
        if (err.code === 'CROSS_CLUSTER_REPLACEMENT') {
          toast.error('Both hosts must belong to the same cluster.');
          return;
        }
      }
      toast.error(describeApiError(err, 'Could not record replacement'));
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setErrors({});
    const trimmedReason = reason.trim();
    const payload: HostReplacementCreateInputWire = {
      oldHostId: host.id,
      newHostId,
      swappedAt,
      ...(trimmedReason.length > 0 && { reason: trimmedReason }),
    };
    const parsed = hostReplacementCreateInputSchema.safeParse(payload);
    if (!parsed.success) {
      const next: { newHostId?: string; swappedAt?: string; reason?: string } = {};
      for (const issue of parsed.error.issues) {
        const root = issue.path[0];
        if (root === 'newHostId') next.newHostId = issue.message;
        else if (root === 'swappedAt') next.swappedAt = issue.message;
        else if (root === 'reason') next.reason = issue.message;
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
          <DialogTitle>Replace {host.name}</DialogTitle>
          <DialogDescription>
            Record a 1:1 hardware swap. Capacity stays attributed correctly on either side of the
            swap date.
          </DialogDescription>
        </DialogHeader>
        {eligible.length === 0 ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              No eligible hosts in this cluster to replace with.
            </p>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="replace-new-host" className="text-sm font-medium">
                Replacement host
              </label>
              <Select value={newHostId} onValueChange={(value) => setNewHostId(value)}>
                <SelectTrigger id="replace-new-host">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {eligible.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.newHostId ? (
                <p className="text-xs text-destructive">{errors.newHostId}</p>
              ) : null}
            </div>
            <Field
              label="Swapped at"
              type="date"
              value={swappedAt}
              onChange={(e) => setSwappedAt(e.target.value)}
              error={errors.swappedAt}
              required
            />
            <div className="space-y-1.5">
              <label htmlFor="replace-reason" className="text-sm font-medium">
                Reason
              </label>
              <textarea
                id="replace-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={2000}
                rows={3}
                placeholder="Optional context (e.g. RMA, capacity upgrade)"
                className="flex w-full rounded-[var(--radius)] border border-input bg-background px-2.5 py-1.5 text-sm placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                aria-invalid={errors.reason ? 'true' : undefined}
              />
              {errors.reason ? <p className="text-xs text-destructive">{errors.reason}</p> : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="accent" disabled={mutation.isPending}>
                {mutation.isPending ? 'Saving…' : 'Record replacement'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------- History (lifecycle event log) ----------

/**
 * Read-only side panel that lists every lifecycle event recorded for a host,
 * oldest first (the API already returns them sorted by occurredAt). Uses a
 * Dialog for consistency with the other host actions — the codebase's Sheet
 * primitive is a fixed-width left-side nav drawer rather than a general
 * content panel, so reusing Dialog here keeps the look uniform across all
 * "host row" actions.
 *
 * Fetching is gated by `open` so the query doesn't fire until the user
 * actually opens the panel; the `host.id`-scoped key means re-opening a
 * different host reads its own cache entry. Action is shown for all states,
 * including disposed and fresh hosts (which simply render "No history yet.").
 */
export function HostHistoryDialog({
  open,
  onOpenChange,
  host,
}: Omit<WithHostProps, 'clusterId'>): React.JSX.Element {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['host-lifecycle', host.id],
    queryFn: () => api.hosts.listLifecycle(host.id),
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>History · {host.name}</DialogTitle>
          <DialogDescription>
            Lifecycle transitions recorded for this host, oldest first.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="space-y-2 py-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-muted/60" />
            ))}
          </div>
        ) : isError ? (
          <div className="rounded-[var(--radius)] border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error instanceof Error ? error.message : 'Could not load history'}
          </div>
        ) : !data || data.length === 0 ? (
          <p className="rounded-[var(--radius)] border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
            No history yet.
          </p>
        ) : (
          <ol className="space-y-2">
            {data.map((event) => (
              <li
                key={event.id}
                className="rounded-[var(--radius)] border border-border bg-background/50 p-3"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {event.occurredAt}
                  </span>
                  <span className="text-sm">
                    {event.fromState ? (
                      <span className="text-muted-foreground">{STATE_LABELS[event.fromState]}</span>
                    ) : (
                      <span className="text-muted-foreground italic">Initial</span>
                    )}
                    <span className="px-1.5 text-muted-foreground">&rarr;</span>
                    <span className="font-medium">{STATE_LABELS[event.toState]}</span>
                  </span>
                </div>
                {event.note ? (
                  <p className="mt-1.5 whitespace-pre-wrap text-sm text-muted-foreground">
                    {event.note}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
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
