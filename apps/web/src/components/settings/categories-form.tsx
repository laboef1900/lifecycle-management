import type { CategoryResponse } from '@lcm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/form/confirm-dialog';
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

export function CategoriesForm(): React.JSX.Element {
  const queryClient = useQueryClient();
  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.settings.categories.list(),
  });

  const [name, setName] = React.useState('');
  const [deleteTarget, setDeleteTarget] = React.useState<CategoryResponse | null>(null);
  const [deleteError, setDeleteError] = React.useState<DeleteError | null>(null);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['categories'] });
  };

  const createMutation = useMutation({
    mutationFn: (input: string) => api.settings.categories.create(input),
    onSuccess: () => {
      invalidate();
      setName('');
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

  const handleAdd = (e: React.FormEvent): void => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') return;
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
                  onClick={() => setDeleteTarget(category)}
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

      {/* `noValidate` even though nothing here can currently raise a bubble — the
          input carries `maxLength` (which caps typing rather than validating)
          and no `required`/`min`. It is the invariant that matters: every form
          in this app answers for its own errors, so adding a native constraint
          later cannot silently hand the error path back to the browser. */}
      <form onSubmit={handleAdd} className="flex max-w-sm items-end gap-2" noValidate>
        <label className="block flex-1">
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
            New category
          </span>
          <Input
            aria-label="New category"
            placeholder="e.g. Growth"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            className="mt-1"
          />
        </label>
        <Button
          type="submit"
          variant="accent"
          size="sm"
          disabled={name.trim() === '' || createMutation.isPending}
        >
          {createMutation.isPending ? 'Adding…' : 'Add'}
        </Button>
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
        error={
          deleteError !== null && deleteError.id === deleteTarget?.id ? deleteError.message : null
        }
        pending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
      />
    </Card>
  );
}
