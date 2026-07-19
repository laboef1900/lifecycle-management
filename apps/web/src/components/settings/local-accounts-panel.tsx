import type { CreateLocalUser, LocalUserSummary } from '@lcm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/form/confirm-dialog';
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

const EMPTY_CREATE_FORM: CreateFormState = { username: '', password: '', role: 'ADMIN' };

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
  const [resettingId, setResettingId] = React.useState<string | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = React.useState('');
  const [deleteTarget, setDeleteTarget] = React.useState<LocalUserSummary | null>(null);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['local-users'] });
  };

  const createMutation = useMutation({
    mutationFn: (input: CreateLocalUser) => api.settings.auth.localUsers.create(input),
    onSuccess: () => {
      invalidate();
      setForm(EMPTY_CREATE_FORM);
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

  const handleCreate = (e: React.FormEvent): void => {
    e.preventDefault();
    const username = form.username.trim();
    const password = form.password;
    if (username === '' || password === '') return;
    createMutation.mutate({ username, password, role: form.role });
  };

  const handleResetSubmit = (e: React.FormEvent, id: string): void => {
    e.preventDefault();
    const trimmed = resetPasswordValue.trim();
    if (trimmed === '') return;
    resetPasswordMutation.mutate({ id, newPassword: trimmed });
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
                <form
                  onSubmit={(e) => handleResetSubmit(e, user.id)}
                  className="mt-2 flex flex-wrap items-end gap-2"
                >
                  <label className="block min-w-[10rem] flex-1">
                    <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
                      New password
                    </span>
                    <Input
                      type="password"
                      aria-label={`New password for ${user.username}`}
                      value={resetPasswordValue}
                      onChange={(e) => setResetPasswordValue(e.target.value)}
                      minLength={12}
                      className="mt-1"
                    />
                  </label>
                  <Button
                    type="submit"
                    variant="accent"
                    size="sm"
                    disabled={resetPasswordMutation.isPending || resetPasswordValue.trim() === ''}
                  >
                    {resetPasswordMutation.isPending ? 'Saving…' : 'Save'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setResettingId(null)}
                  >
                    Cancel
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-2">
        <label className="block min-w-[10rem] flex-1">
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Username
          </span>
          <Input
            aria-label="Username"
            placeholder="e.g. jsmith"
            value={form.username}
            onChange={(e) => setForm((prev) => ({ ...prev, username: e.target.value }))}
            className="mt-1"
          />
        </label>
        <label className="block min-w-[10rem] flex-1">
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Password
          </span>
          <Input
            type="password"
            aria-label="Password"
            placeholder="At least 12 characters"
            value={form.password}
            onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
            minLength={12}
            className="mt-1"
          />
        </label>
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
        <Button
          type="submit"
          variant="accent"
          size="sm"
          disabled={form.username.trim() === '' || form.password === '' || createMutation.isPending}
        >
          {createMutation.isPending ? 'Adding…' : 'Add account'}
        </Button>
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
