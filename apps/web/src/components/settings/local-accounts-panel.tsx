import type { CreateLocalUser, LocalUserSummary } from '@lcm/shared';
import { localUsernameSchema, passwordSchema } from '@lcm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/form/confirm-dialog';
import { useFocusFirstInvalidField } from '@/components/form/field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { api, describeApiError } from '@/lib/api-client';

interface CreateFormState {
  username: string;
  password: string;
  role: 'ADMIN' | 'VIEWER';
}

type CreateFieldErrors = Partial<Record<'username' | 'password', string>>;

const EMPTY_CREATE_FORM: CreateFormState = { username: '', password: '', role: 'ADMIN' };

/**
 * The policy sentence an admin can act on, with the bound read from the contract
 * that enforces it (`passwordSchema` in `@lcm/shared`) rather than restated
 * here. Zod's own text — "Too small: expected string to have >=12 characters" —
 * describes a wire contract, not a choice a person is making.
 */
const PASSWORD_HINT =
  passwordSchema.minLength === null
    ? 'Choose a password.'
    : `At least ${passwordSchema.minLength} characters.`;

/**
 * Validate a password against the shared contract, in the panel's own words.
 *
 * @ai-warning Judges the value verbatim — no `.trim()`. A credential may
 * legitimately begin or end with whitespace, and trimming it here would store a
 * hash of something the operator never typed, locking them out of the account
 * they just set the password on. (`localUsernameSchema` trims on its own; that
 * is the schema's decision for a username, not this form's for a secret.)
 */
function validatePassword(value: string, blankMessage: string): string | undefined {
  if (value.length === 0) return blankMessage;
  const parsed = passwordSchema.safeParse(value);
  if (parsed.success) return undefined;
  const { minLength, maxLength } = passwordSchema;
  if (minLength !== null && value.length < minLength) {
    return `Too short — use at least ${minLength} characters.`;
  }
  if (maxLength !== null && value.length > maxLength) {
    return `Too long — use at most ${maxLength} characters.`;
  }
  return parsed.error.issues[0]?.message ?? 'That password was not accepted.';
}

/**
 * Settings panel for local (username/password) admin accounts. Rendered by
 * AuthenticationForm both as the primary account manager when mode is
 * 'local' and as a collapsed break-glass section when mode is 'oidc' — the
 * server enforces NO_LOCAL_ADMIN (can't disable/delete down to zero enabled
 * local admins while mode is 'local'); this panel just surfaces whatever
 * message that guard returns rather than re-implementing the check.
 */
export function LocalAccountsPanel(): React.JSX.Element {
  const queryClient = useQueryClient();
  const usersQuery = useQuery({
    queryKey: ['local-users'],
    queryFn: () => api.settings.auth.localUsers.list(),
  });

  const [form, setForm] = React.useState<CreateFormState>(EMPTY_CREATE_FORM);
  const [createErrors, setCreateErrors] = React.useState<CreateFieldErrors>({});
  const [resettingId, setResettingId] = React.useState<string | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = React.useState('');
  const [resetErrors, setResetErrors] = React.useState<{ password?: string }>({});
  const [deleteTarget, setDeleteTarget] = React.useState<LocalUserSummary | null>(null);
  const createFormRef = React.useRef<HTMLFormElement>(null);
  const resetFormRef = React.useRef<HTMLFormElement>(null);
  useFocusFirstInvalidField(createFormRef, createErrors);
  useFocusFirstInvalidField(resetFormRef, resetErrors);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['local-users'] });
  };

  const createMutation = useMutation({
    mutationFn: (input: CreateLocalUser) => api.settings.auth.localUsers.create(input),
    onSuccess: () => {
      invalidate();
      setForm(EMPTY_CREATE_FORM);
      setCreateErrors({});
      toast.success('Local account created');
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not create local account')),
  });

  const setDisabledMutation = useMutation({
    mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) =>
      api.settings.auth.localUsers.setDisabled(id, disabled),
    onSuccess: () => {
      invalidate();
      toast.success('Local account updated');
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not update local account')),
  });

  const resetPasswordMutation = useMutation({
    mutationFn: ({ id, newPassword }: { id: string; newPassword: string }) =>
      api.settings.auth.localUsers.resetPassword(id, newPassword),
    onSuccess: () => {
      setResettingId(null);
      setResetPasswordValue('');
      setResetErrors({});
      toast.success('Password reset');
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not reset password')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.settings.auth.localUsers.delete(id),
    onSuccess: () => {
      setDeleteTarget(null);
      invalidate();
      toast.success('Local account deleted');
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not delete local account')),
  });

  /**
   * Both forms are `noValidate`, so these handlers are the only gate. They used
   * to `return` silently on a blank value and leave the 12-character rule to a
   * `minLength` attribute — which meant the browser's transient, unstyled,
   * first-field-only bubble was the sole enforcement on the highest-stakes form
   * in the app, and a blank field produced no message at all.
   */
  const handleCreate = (e: React.FormEvent): void => {
    e.preventDefault();
    const username = form.username.trim();
    const password = form.password;

    const next: CreateFieldErrors = {};
    // `localUsernameSchema` owns what a username may contain (and its own
    // trimming); only "you left it blank" is this form's sentence to write.
    if (username === '') {
      next.username = 'Enter a username.';
    } else {
      const parsed = localUsernameSchema.safeParse(username);
      if (!parsed.success) {
        next.username = parsed.error.issues[0]?.message ?? 'That username was not accepted.';
      }
    }
    const passwordError = validatePassword(password, 'Enter a password.');
    if (passwordError !== undefined) next.password = passwordError;

    // A new object every failed submit — that reference change is what re-fires
    // the focus move in `useFocusFirstInvalidField`.
    if (next.username !== undefined || next.password !== undefined) {
      setCreateErrors(next);
      return;
    }

    setCreateErrors({});
    createMutation.mutate({ username, password, role: form.role });
  };

  const handleResetSubmit = (e: React.FormEvent, id: string): void => {
    e.preventDefault();
    const passwordError = validatePassword(resetPasswordValue, 'Enter the new password.');
    if (passwordError !== undefined) {
      setResetErrors({ password: passwordError });
      return;
    }
    setResetErrors({});
    resetPasswordMutation.mutate({ id, newPassword: resetPasswordValue });
  };

  const users = usersQuery.data ?? [];

  return (
    <Card className="p-4">
      <header className="mb-4">
        <h3 className="text-base font-semibold">Local accounts</h3>
        <p className="text-sm text-fg-muted">
          Username-and-password admin accounts, managed independently of OIDC.
        </p>
      </header>

      {usersQuery.isPending ? (
        <div className="mb-4 space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : usersQuery.isError ? (
        <p className="mb-4 text-sm text-destructive">Could not load local accounts.</p>
      ) : users.length === 0 ? (
        <EmptyState
          className="mb-4"
          title="No local accounts yet"
          description="Add one below to sign in with a username and password."
        />
      ) : (
        <ul className="mb-4 divide-y divide-border rounded-[var(--radius)] border border-border">
          {users.map((user) => (
            <li key={user.id} className="px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{user.username}</span>
                  <Badge variant={user.role === 'ADMIN' ? 'accent' : 'outline'}>
                    {user.role === 'ADMIN' ? 'Admin' : 'Viewer'}
                  </Badge>
                  <Badge variant={user.disabled ? 'outline' : 'success'} dot>
                    {user.disabled ? 'Disabled' : 'Active'}
                  </Badge>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={setDisabledMutation.isPending}
                    onClick={() =>
                      setDisabledMutation.mutate({ id: user.id, disabled: !user.disabled })
                    }
                  >
                    {user.disabled ? 'Enable' : 'Disable'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setResettingId((current) => (current === user.id ? null : user.id));
                      setResetPasswordValue('');
                      // One `resetErrors` serves whichever row is open, so it has
                      // to be cleared here too — otherwise opening a second row
                      // greets that admin with the first row's failure.
                      setResetErrors({});
                    }}
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    Reset
                  </Button>
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(user)}
                    title={`Delete ${user.username}`}
                    aria-label={`Delete ${user.username}`}
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              {resettingId === user.id ? (
                /* `noValidate` — see `handleResetSubmit`. */
                <form
                  ref={resetFormRef}
                  onSubmit={(e) => handleResetSubmit(e, user.id)}
                  className="mt-2 space-y-1"
                  noValidate
                >
                  {/* The message lives OUTSIDE this row, not under the input:
                      the row is `items-end`, so a paragraph inside the field
                      column would drag Save and Cancel down to sit level with
                      the message instead of the control they act on.
                      `aria-describedby` is an id reference, so the association
                      survives the move. */}
                  <div className="flex flex-wrap items-end gap-2">
                    {/* Label and control are siblings rather than nested: a
                        wrapping `<label>` would fold the message into the
                        field's own label text. */}
                    <div className="min-w-[10rem] flex-1">
                      <div className="flex items-baseline gap-0.5">
                        <label
                          htmlFor={`reset-password-${user.id}`}
                          className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle"
                        >
                          New password
                        </label>
                        {/* The glyph, not just its colour, carries "required". */}
                        <span aria-hidden className="text-destructive">
                          *
                        </span>
                      </div>
                      <Input
                        id={`reset-password-${user.id}`}
                        type="password"
                        aria-label={`New password for ${user.username}`}
                        value={resetPasswordValue}
                        onChange={(e) => setResetPasswordValue(e.target.value)}
                        required
                        aria-required="true"
                        aria-invalid={resetErrors.password ? 'true' : undefined}
                        aria-describedby={
                          resetErrors.password
                            ? `reset-password-${user.id}-error`
                            : `reset-password-${user.id}-hint`
                        }
                        className="mt-1"
                      />
                    </div>
                    {/* Not disabled on a blank value: the point of the sweep is
                        that the handler explains the problem, and a dead button
                        explains nothing. Only the in-flight case disables. */}
                    <Button
                      type="submit"
                      variant="accent"
                      size="sm"
                      disabled={resetPasswordMutation.isPending}
                    >
                      {resetPasswordMutation.isPending ? 'Saving…' : 'Save'}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setResettingId(null);
                        setResetErrors({});
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                  {resetErrors.password ? (
                    <p id={`reset-password-${user.id}-error`} className="text-xs text-destructive">
                      {resetErrors.password}
                    </p>
                  ) : (
                    <p
                      id={`reset-password-${user.id}-hint`}
                      className="text-xs text-muted-foreground"
                    >
                      {PASSWORD_HINT}
                    </p>
                  )}
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {/* `noValidate` — see `handleCreate`. The `minLength={12}` that used to sit
          on the password input is gone with it: it enforced nothing on its own
          and its only effect was the bubble. `passwordSchema` is the rule now,
          and it is stated up front in the hint below rather than only on
          failure. */}
      <form ref={createFormRef} onSubmit={handleCreate} className="space-y-1" noValidate>
        {/* Messages live outside this row — see the reset form above for why. */}
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[10rem] flex-1">
            <div className="flex items-baseline gap-0.5">
              <label
                htmlFor="local-account-username"
                className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle"
              >
                Username
              </label>
              <span aria-hidden className="text-destructive">
                *
              </span>
            </div>
            <Input
              id="local-account-username"
              // No `aria-label`: the `<label htmlFor>` above is the accessible
              // name now, and a duplicate that overrides it is one edit away
              // from disagreeing with the visible text (SC 2.5.3).
              placeholder="e.g. jsmith"
              value={form.username}
              onChange={(e) => setForm((prev) => ({ ...prev, username: e.target.value }))}
              required
              aria-required="true"
              aria-invalid={createErrors.username ? 'true' : undefined}
              aria-describedby={createErrors.username ? 'local-account-username-error' : undefined}
              className="mt-1"
            />
          </div>
          <div className="min-w-[10rem] flex-1">
            <div className="flex items-baseline gap-0.5">
              <label
                htmlFor="local-account-password"
                className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle"
              >
                Password
              </label>
              <span aria-hidden className="text-destructive">
                *
              </span>
            </div>
            <Input
              id="local-account-password"
              type="password"
              // No `aria-label` — see the username field above.
              value={form.password}
              onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
              required
              aria-required="true"
              aria-invalid={createErrors.password ? 'true' : undefined}
              aria-describedby={
                createErrors.password
                  ? 'local-account-password-error'
                  : 'local-account-password-hint'
              }
              className="mt-1"
            />
          </div>
          <div>
            <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
              Role
            </span>
            <div className="mt-1">
              <SegmentedControl
                ariaLabel="Role"
                value={form.role}
                onValueChange={(role) => setForm((prev) => ({ ...prev, role }))}
                options={[
                  { value: 'ADMIN', label: 'Admin' },
                  { value: 'VIEWER', label: 'Viewer' },
                ]}
              />
            </div>
          </div>
          {/* Not disabled on blank fields: a dead button explains nothing, and
              this form's whole failure story used to be "nothing happens". */}
          <Button type="submit" variant="accent" size="sm" disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Adding…' : 'Add account'}
          </Button>
        </div>
        {createErrors.username ? (
          <p id="local-account-username-error" className="text-xs text-destructive">
            {createErrors.username}
          </p>
        ) : null}
        {createErrors.password ? (
          <p id="local-account-password-error" className="text-xs text-destructive">
            {createErrors.password}
          </p>
        ) : (
          <p id="local-account-password-hint" className="text-xs text-muted-foreground">
            Password: {PASSWORD_HINT}
          </p>
        )}
      </form>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={deleteTarget ? `Delete ${deleteTarget.username}?` : ''}
        description="This account will no longer be able to sign in. This cannot be undone."
        confirmLabel="Delete account"
        destructive
        pending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
      />
    </Card>
  );
}
