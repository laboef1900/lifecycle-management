import type { CategoryResponse } from '@lcm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/form/confirm-dialog';
import { useFocusFirstInvalidField } from '@/components/form/field';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, api } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface DeleteError {
  id: string;
  message: string;
}

const NAME_ID = 'new-category-name';
const NAME_ERROR_ID = `${NAME_ID}-error`;

export function CategoriesForm(): React.JSX.Element {
  const queryClient = useQueryClient();
  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.settings.categories.list(),
  });

  const [name, setName] = React.useState('');
  // An object, not a bare string: `useFocusFirstInvalidField` keys off the
  // reference, so a fresh one per rejected submit is what re-fires the focus
  // move when the operator submits the same blank field twice.
  const [addErrors, setAddErrors] = React.useState<{ name?: string }>({});
  const [deleteTarget, setDeleteTarget] = React.useState<CategoryResponse | null>(null);
  const [deleteError, setDeleteError] = React.useState<DeleteError | null>(null);
  /**
   * Whether a delete was confirmed in the CURRENTLY open dialog.
   *
   * `deleteError` is deliberately durable — the row keeps showing the reason
   * after the dialog is dismissed — so it cannot also be what the dialog reads,
   * or reopening would greet the operator with the previous attempt's failure
   * before they had retried anything. Reset on open; set on confirm.
   */
  const [confirmAttempted, setConfirmAttempted] = React.useState(false);
  const addFormRef = React.useRef<HTMLFormElement>(null);
  useFocusFirstInvalidField(addFormRef, addErrors);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['categories'] });
  };

  const createMutation = useMutation({
    mutationFn: (input: string) => api.settings.categories.create(input),
    onSuccess: () => {
      invalidate();
      setName('');
      setAddErrors({});
      toast.success('Category added');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not add category'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.settings.categories.delete(id),
    onSuccess: () => {
      setDeleteError(null);
      setDeleteTarget(null);
      invalidate();
      toast.success('Category removed');
    },
    // ConfirmDialog seals every close path while the mutation is in flight, so a
    // failure is guaranteed to land with the dialog still open: the in-dialog
    // `error` is the primary signal (and the reason no toast fires here — the
    // same sentence three times over is noise). The row keeps its own copy so
    // the reason survives dismissing the dialog, which matters most for
    // CATEGORY_IN_USE: retrying cannot help, reassigning the items can.
    onError: (err, id) => {
      setDeleteError({
        id,
        message: err instanceof ApiError ? err.message : 'Could not remove category',
      });
    },
  });

  // The form is `noValidate`, so this is the only gate. It used to `return`
  // silently behind a disabled button, which is the same failure story the rest
  // of this sweep removed: nothing happens and nothing says why.
  const handleAdd = (e: React.FormEvent): void => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') {
      setAddErrors({ name: 'Enter a category name.' });
      return;
    }
    setAddErrors({});
    createMutation.mutate(trimmed);
  };

  const categories = categoriesQuery.data ?? [];

  return (
    <Card className="max-w-2xl p-4">
      <header className="mb-4">
        <h3 className="text-base font-semibold">Categories</h3>
        <p className="text-sm text-fg-muted">
          Labels for applications and events. Add or remove the options that appear in the item
          category dropdown.
        </p>
      </header>

      {/* max-w-sm on the list and the add-row: a category name plus its
          delete button in one eye-span, not spread across the full
          (already width-capped) card. */}
      {categoriesQuery.isPending ? (
        <div className="mb-4 max-w-sm space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : categories.length === 0 ? (
        <EmptyState
          className="mb-4 max-w-sm"
          title="No categories yet"
          description="Add one below to fill the item category dropdown."
        />
      ) : (
        <ul className="mb-4 max-w-sm divide-y divide-border rounded-[var(--radius)] border border-border">
          {categories.map((category) => (
            <li key={category.id} className="px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm">{category.name}</span>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmAttempted(false);
                    setDeleteTarget(category);
                  }}
                  disabled={deleteMutation.isPending}
                  title={`Remove ${category.name}`}
                  aria-label={`Remove ${category.name}`}
                  className={cn(
                    'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors',
                    'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
                    'disabled:pointer-events-none disabled:opacity-50',
                  )}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {/* Only once the dialog is gone: while it is open it shows this
                  same sentence itself, and two live regions announcing one
                  failure is noise, not emphasis. */}
              {deleteTarget === null && deleteError?.id === category.id ? (
                <p className="mt-1 text-xs text-destructive" role="alert">
                  {deleteError.message}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {/* `noValidate` is load-bearing here: the input carries `required` so the
          field announces as required, and without the opt-out the browser's
          transient, unstyled bubble would fire before submit and preempt the
          inline error below — the app's own words, tied to the field. */}
      <form ref={addFormRef} onSubmit={handleAdd} className="max-w-sm space-y-1" noValidate>
        {/* The message lives OUTSIDE this row: the row is `items-end`, so a
            paragraph inside the field column would drag Add down to sit level
            with the message instead of the control it acts on.
            `aria-describedby` is an id reference, so the association survives
            the move. */}
        <div className="flex items-end gap-2">
          {/* Label and control are siblings, not nested: a wrapping `<label>`
              would fold the error paragraph into the field's own label text. */}
          <div className="flex-1">
            <div className="flex items-baseline gap-0.5">
              <label
                htmlFor={NAME_ID}
                className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle"
              >
                New category
              </label>
              {/* The glyph, not just its colour, carries "required". */}
              <span aria-hidden className="text-destructive">
                *
              </span>
            </div>
            <Input
              id={NAME_ID}
              placeholder="e.g. Growth"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              required
              aria-required="true"
              aria-invalid={addErrors.name ? 'true' : undefined}
              aria-describedby={addErrors.name ? NAME_ERROR_ID : undefined}
              className="mt-1"
            />
          </div>
          {/* Not disabled on a blank name: a dead button explains nothing, and
              "nothing happens" was this form's entire failure story. Only the
              in-flight case disables. */}
          <Button type="submit" variant="accent" size="sm" disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Adding…' : 'Add'}
          </Button>
        </div>
        {addErrors.name ? (
          <p id={NAME_ERROR_ID} className="text-xs text-destructive">
            {addErrors.name}
          </p>
        ) : null}
      </form>

      {/* Scope and consequence stated from the server's actual behaviour
          (`CategoriesService.delete`): items store their category by *name*, so
          removing the row only withdraws the dropdown option, and a category any
          item still uses is refused outright (CATEGORY_IN_USE) rather than
          cascading. */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={deleteTarget ? `Remove ${deleteTarget.name}?` : ''}
        description="This only withdraws the label from the item category dropdown — no application or event is deleted or relabelled. A category that any item still uses cannot be removed until those items are reassigned."
        confirmLabel="Remove category"
        destructive
        // Gated on `confirmAttempted`, not on `deleteError` alone: the error is
        // durable by design (the row keeps it after dismissal), so without the
        // gate a reopened dialog would state a failure the operator has not yet
        // caused in this session.
        error={
          confirmAttempted && deleteError !== null && deleteError.id === deleteTarget?.id
            ? deleteError.message
            : null
        }
        pending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) {
            setConfirmAttempted(true);
            deleteMutation.mutate(deleteTarget.id);
          }
        }}
      />
    </Card>
  );
}
