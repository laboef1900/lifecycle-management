import { hostTransitionInputSchema } from '@lcm/shared';
import type { HostState } from '@lcm/shared';
import { useMutation } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Field, useFocusFirstInvalidField } from '@/components/form/field';
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
import { api, describeApiError, type HostTransitionInputWire } from '@/lib/api-client';
import { todayIso } from '@/lib/format';

import {
  ALLOWED_TRANSITIONS,
  STATE_LABELS,
  mapIssuesToFieldErrors,
  useHostMutations,
  type WithHostProps,
} from './shared';

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
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalidField(formRef, errors);

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
      setErrors(
        mapIssuesToFieldErrors(parsed.error.issues, {
          toState: 'toState',
          occurredAt: 'occurredAt',
          note: 'note',
        }),
      );
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
          <form ref={formRef} onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="transition-to-state" className="text-sm font-medium">
                Target state
              </label>
              <Select value={toState} onValueChange={(value) => setToState(value as HostState)}>
                <SelectTrigger
                  id="transition-to-state"
                  aria-invalid={errors.toState ? 'true' : undefined}
                  aria-describedby={errors.toState ? 'transition-to-state-error' : undefined}
                >
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
              {errors.toState ? (
                <p id="transition-to-state-error" className="text-xs text-destructive">
                  {errors.toState}
                </p>
              ) : null}
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
                className="flex w-full rounded-[var(--radius)] border border-input bg-background px-2.5 py-1.5 text-sm placeholder:text-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
                aria-invalid={errors.note ? 'true' : undefined}
                aria-describedby={errors.note ? 'transition-note-error' : undefined}
              />
              {errors.note ? (
                <p id="transition-note-error" className="text-xs text-destructive">
                  {errors.note}
                </p>
              ) : null}
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
