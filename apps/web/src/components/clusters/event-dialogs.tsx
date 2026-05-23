import { eventCategorySchema, eventCreateInputSchema, eventUpdateInputSchema } from '@lcm/shared';
import type { EventCategory, EventResponse } from '@lcm/shared';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ApiError,
  api,
  type EventCreateInputWire,
  type EventUpdateInputWire,
} from '@/lib/api-client';
import { todayIso } from '@/lib/format';

interface CommonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clusterId: string;
}

interface WithEventProps extends CommonDialogProps {
  event: EventResponse;
}

function useEventMutations(clusterId: string): { invalidate: () => void } {
  const queryClient = useQueryClient();
  return {
    invalidate: () => {
      void queryClient.invalidateQueries({ queryKey: ['events', clusterId] });
      void queryClient.invalidateQueries({ queryKey: ['forecast', clusterId] });
    },
  };
}

function describeApiError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const CATEGORY_OPTIONS = eventCategorySchema.options;

const CATEGORY_LABEL: Record<EventCategory, string> = {
  growth: 'Growth',
  hardware_change: 'Hardware change',
  openshift: 'OpenShift',
  note: 'Note',
};

// ---------- Create event ----------

interface EventFormState {
  effectiveDate: string;
  category: EventCategory;
  title: string;
  description: string;
  consumptionDelta: string;
  capacityDelta: string;
}

const blankEventForm = (): EventFormState => ({
  effectiveDate: todayIso(),
  category: 'growth',
  title: '',
  description: '',
  consumptionDelta: '',
  capacityDelta: '',
});

function parseDelta(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function CreateEventDialog({
  open,
  onOpenChange,
  clusterId,
}: CommonDialogProps): React.JSX.Element {
  const { invalidate } = useEventMutations(clusterId);
  const [form, setForm] = useState<EventFormState>(blankEventForm());
  const [errors, setErrors] = useState<Partial<Record<keyof EventFormState, string>>>({});

  const mutation = useMutation({
    mutationFn: (payload: EventCreateInputWire) => api.events.create(clusterId, payload),
    onSuccess: () => {
      invalidate();
      toast.success('Event added');
      onOpenChange(false);
      setForm(blankEventForm());
      setErrors({});
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not add event')),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setErrors({});
    const description = form.description.trim();
    const payload: EventCreateInputWire = {
      metricTypeKey: 'memory_gb',
      effectiveDate: form.effectiveDate,
      category: form.category,
      title: form.title,
      consumptionDelta: parseDelta(form.consumptionDelta),
      capacityDelta: parseDelta(form.capacityDelta),
      ...(description.length > 0 && { description }),
    };
    const parsed = eventCreateInputSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors: Partial<Record<keyof EventFormState, string>> = {};
      for (const issue of parsed.error.issues) {
        const root = issue.path[0];
        if (root === 'title') fieldErrors.title = issue.message;
        else if (root === 'effectiveDate') fieldErrors.effectiveDate = issue.message;
        else if (root === 'consumptionDelta') fieldErrors.consumptionDelta = issue.message;
        else if (root === 'capacityDelta') fieldErrors.capacityDelta = issue.message;
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
          setForm(blankEventForm());
          setErrors({});
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add event</DialogTitle>
          <DialogDescription>
            Annotation or un-attributed capacity/consumption delta. At least one delta is required
            unless the category is &quot;Note&quot;.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field
            label="Title"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            error={errors.title}
            placeholder="Wachstum Q4"
            required
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Effective date"
              type="date"
              value={form.effectiveDate}
              onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })}
              error={errors.effectiveDate}
              required
            />
            <div className="space-y-1.5">
              <label htmlFor="event-category" className="text-sm font-medium">
                Category
              </label>
              <Select
                value={form.category}
                onValueChange={(value) => setForm({ ...form, category: value as EventCategory })}
              >
                <SelectTrigger id="event-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORY_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {CATEGORY_LABEL[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Field
            label="Description"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Optional"
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Consumption Δ (GB)"
              type="number"
              step="1"
              value={form.consumptionDelta}
              onChange={(e) => setForm({ ...form, consumptionDelta: e.target.value })}
              error={errors.consumptionDelta}
              placeholder="e.g. 750"
            />
            <Field
              label="Capacity Δ (GB)"
              type="number"
              step="1"
              value={form.capacityDelta}
              onChange={(e) => setForm({ ...form, capacityDelta: e.target.value })}
              error={errors.capacityDelta}
              placeholder="e.g. 4096"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Adding…' : 'Add event'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Edit event ----------

export function EditEventDialog({
  open,
  onOpenChange,
  clusterId,
  event,
}: WithEventProps): React.JSX.Element {
  const { invalidate } = useEventMutations(clusterId);
  const [title, setTitle] = useState(event.title);
  const [description, setDescription] = useState(event.description ?? '');
  const [effectiveDate, setEffectiveDate] = useState(event.effectiveDate);
  const [category, setCategory] = useState<EventCategory>(event.category);
  const [consumptionDelta, setConsumptionDelta] = useState(
    event.consumptionDelta === null ? '' : String(event.consumptionDelta),
  );
  const [capacityDelta, setCapacityDelta] = useState(
    event.capacityDelta === null ? '' : String(event.capacityDelta),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const mutation = useMutation({
    mutationFn: (payload: EventUpdateInputWire) => api.events.update(event.id, payload),
    onSuccess: () => {
      invalidate();
      toast.success('Event updated');
      onOpenChange(false);
    },
    onError: (err) => {
      const message = describeApiError(err, 'Could not update event');
      toast.error(message);
      if (err instanceof ApiError && err.code === 'EVENT_REQUIRES_PAYLOAD') {
        setErrors({ consumptionDelta: message });
      }
    },
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    setErrors({});
    const trimmed = description.trim();
    const payload: EventUpdateInputWire = {
      title,
      effectiveDate,
      category,
      description: trimmed.length > 0 ? trimmed : null,
      consumptionDelta: parseDelta(consumptionDelta),
      capacityDelta: parseDelta(capacityDelta),
    };
    const parsed = eventUpdateInputSchema.safeParse(payload);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === 'string') next[key] = issue.message;
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
          <DialogTitle>Edit event</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field
            label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            error={errors.title}
            required
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Effective date"
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
              error={errors.effectiveDate}
              required
            />
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Category</label>
              <Select value={category} onValueChange={(v) => setCategory(v as EventCategory)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORY_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {CATEGORY_LABEL[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Field
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Consumption Δ (GB)"
              type="number"
              step="1"
              value={consumptionDelta}
              onChange={(e) => setConsumptionDelta(e.target.value)}
              error={errors.consumptionDelta}
            />
            <Field
              label="Capacity Δ (GB)"
              type="number"
              step="1"
              value={capacityDelta}
              onChange={(e) => setCapacityDelta(e.target.value)}
              error={errors.capacityDelta}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Delete event ----------

export function DeleteEventDialog({
  open,
  onOpenChange,
  clusterId,
  event,
}: WithEventProps): React.JSX.Element {
  const { invalidate } = useEventMutations(clusterId);
  const mutation = useMutation({
    mutationFn: () => api.events.delete(event.id),
    onSuccess: () => {
      invalidate();
      toast.success('Event deleted');
      onOpenChange(false);
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not delete event')),
  });

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete "${event.title}"?`}
      description="This event will no longer affect the forecast."
      confirmLabel="Delete event"
      destructive
      pending={mutation.isPending}
      onConfirm={() => mutation.mutate()}
    />
  );
}
