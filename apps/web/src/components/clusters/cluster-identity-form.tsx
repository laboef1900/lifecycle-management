import { clusterUpdateInputSchema } from '@lcm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { toast } from 'sonner';

import { useFocusFirstInvalidField } from '@/components/form/field';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, describeApiError, type ClusterUpdateInputWire } from '@/lib/api-client';

interface ClusterIdentityFormProps {
  clusterId: string;
}

type FieldErrors = Partial<Record<'name', string>>;

const NAME_ID = 'cluster-identity-name';
const NAME_ERROR_ID = `${NAME_ID}-error`;

export function ClusterIdentityForm({ clusterId }: ClusterIdentityFormProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const clusterQuery = useQuery({
    queryKey: ['cluster', clusterId],
    queryFn: () => api.clusters.get(clusterId),
  });

  const [nameEdit, setNameEdit] = React.useState<string | null>(null);
  const [descriptionEdit, setDescriptionEdit] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const formRef = React.useRef<HTMLFormElement>(null);
  useFocusFirstInvalidField(formRef, errors);

  const serverName = clusterQuery.data?.name ?? '';
  const serverDescription = clusterQuery.data?.description ?? '';
  const name = nameEdit ?? serverName;
  const description = descriptionEdit ?? serverDescription;

  const mutation = useMutation({
    mutationFn: (input: ClusterUpdateInputWire) => api.clusters.update(clusterId, input),
    onSuccess: (data) => {
      queryClient.setQueryData(['cluster', clusterId], data);
      void queryClient.invalidateQueries({ queryKey: ['clusters'] });
      setNameEdit(null);
      setDescriptionEdit(null);
      setErrors({});
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not save cluster')),
  });

  const dirty =
    (nameEdit !== null && nameEdit !== serverName) ||
    (descriptionEdit !== null && descriptionEdit !== serverDescription);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    setErrors({});

    // The form is `noValidate`, so this is the only gate. The blank case keeps
    // the form's own words: the schema's `min(1)` text is wire copy, not
    // something to show an operator.
    if (name.trim().length === 0) {
      setErrors({ name: 'Name is required.' });
      return;
    }

    const input: ClusterUpdateInputWire = {};
    if (nameEdit !== null && nameEdit !== serverName) {
      input.name = nameEdit;
    }
    if (descriptionEdit !== null && descriptionEdit !== serverDescription) {
      input.description = descriptionEdit === '' ? null : descriptionEdit;
    }

    // The shared contract is the authority on bounds; `maxLength` on the inputs
    // is a courtesy, not a guarantee (paste and autofill both route around it).
    const parsed = clusterUpdateInputSchema.safeParse(input);
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'name') next.name = issue.message;
      }
      setErrors(next);
      // Issues with no field to point at — the "at least one field" refine, or a
      // description bound — would otherwise fail silently.
      if (next.name === undefined) {
        toast.error(parsed.error.issues[0]?.message ?? 'Could not save cluster');
      }
      return;
    }
    mutation.mutate(input);
  };

  return (
    <Card className="p-4">
      <header className="mb-4">
        <h2 className="text-base font-semibold">Cluster identity</h2>
        <p className="text-sm text-fg-muted">Rename or update the description for this cluster.</p>
      </header>
      {/* `noValidate`: the browser's own bubble is transient, unstyled, and shows
          one field at a time. The submit handler above is the single error path,
          rendered through the same markup contract as `Field`.

          The two controls keep this tab's caption label style (a `<textarea>` is
          outside `Field`'s remit, and splitting one card between two label
          typographies to reuse the primitive for the `<input>` alone would trade
          a visible inconsistency for no accessibility gain — the aria contract
          below is `Field`'s, verbatim). */}
      <form ref={formRef} onSubmit={handleSubmit} className="space-y-3" noValidate>
        {/* The label is a sibling of the control, not a wrapper: a wrapping
            `<label>` would fold the error paragraph into the field's own label
            text, so the accessible name would change the moment validation
            failed. Same reason `Field` keeps its `*` marker outside the label. */}
        <div>
          <div className="flex items-baseline gap-0.5">
            <label
              htmlFor={NAME_ID}
              className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle"
            >
              Name
            </label>
            {/* The glyph, not just its colour, carries "required", so it survives
                a forced-colours palette; `aria-required` is what AT announces. */}
            <span aria-hidden className="text-destructive">
              *
            </span>
          </div>
          <Input
            id={NAME_ID}
            value={name}
            onChange={(e) => setNameEdit(e.target.value)}
            maxLength={120}
            aria-required="true"
            aria-invalid={errors.name ? 'true' : undefined}
            aria-describedby={errors.name ? NAME_ERROR_ID : undefined}
            className="mt-1"
          />
          {errors.name ? (
            <p id={NAME_ERROR_ID} className="mt-1 text-xs text-destructive">
              {errors.name}
            </p>
          ) : null}
        </div>
        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Description
          </span>
          <textarea
            aria-label="Description"
            value={description}
            onChange={(e) => setDescriptionEdit(e.target.value)}
            maxLength={2000}
            rows={3}
            className="mt-1 flex w-full rounded-[var(--radius)] border border-input bg-background px-2.5 py-1.5 text-sm placeholder:text-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
          />
        </label>
        <div className="flex items-center justify-end">
          <Button type="submit" variant="accent" size="sm" disabled={!dirty || mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
