import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
      invalidate();
      toast.success('Category removed');
    },
    onError: (err, id) => {
      if (err instanceof ApiError && err.code === 'CATEGORY_IN_USE') {
        setDeleteError({ id, message: err.message });
        toast.error(err.message);
        return;
      }
      toast.error(err instanceof ApiError ? err.message : 'Could not remove category');
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
        <p className="text-sm text-fg-subtle">No categories yet. Add one below.</p>
      ) : (
        <ul className="mb-4 max-w-sm divide-y divide-border rounded-[var(--radius)] border border-border">
          {categories.map((category) => (
            <li key={category.id} className="px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm">{category.name}</span>
                <button
                  type="button"
                  onClick={() => deleteMutation.mutate(category.id)}
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
              {deleteError?.id === category.id ? (
                <p className="mt-1 text-xs text-destructive" role="alert">
                  {deleteError.message}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleAdd} className="flex max-w-sm items-end gap-2">
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
    </Card>
  );
}
