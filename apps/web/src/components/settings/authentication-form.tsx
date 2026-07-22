import {
  authConfigUpdateSchema,
  type AuthConfigTest,
  type AuthConfigUpdate,
  type AuthForceDisabledReason,
} from '@lcm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Copy, ShieldAlert } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/form/confirm-dialog';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { api, describeApiError } from '@/lib/api-client';

import { LocalAccountsPanel } from './local-accounts-panel';

type NumInput = number | '';
type AuthMode = 'disabled' | 'local' | 'oidc';

// Local edits override the server-derived config. A key absent from `edits`
// means "not edited — use the server value" — same decoupled-edit pattern as
// ForecastThresholdsForm, just consolidated into one object given the field
// count here.
interface AuthFormEdits {
  mode?: AuthMode;
  issuerUrl?: string;
  clientId?: string;
  appBaseUrl?: string;
  scopes?: string;
  roleClaim?: string;
  adminValues?: string;
  defaultRole?: 'admin' | 'viewer';
  allowedEmailDomains?: string;
  allowedEmails?: string;
  sessionTtlHours?: NumInput;
  allowInsecure?: boolean;
}

const FIELD_LABELS: Record<string, string> = {
  mode: 'Mode',
  issuerUrl: 'Issuer URL',
  clientId: 'Client ID',
  clientSecret: 'Client secret',
  appBaseUrl: 'App base URL',
  scopes: 'Scopes',
  roleClaim: 'Role claim',
  adminValues: 'Admin values',
  defaultRole: 'Default role',
  allowedEmailDomains: 'Allowed email domains',
  allowedEmails: 'Allowed emails',
  sessionTtlHours: 'Session TTL (hours)',
  allowInsecure: 'Allow insecure',
};

// @ai-note `AuthConfigResponse.mode` is the mode as STORED in auth_config,
// not the mode being enforced (#222). Whenever `forceDisabledReason` is
// non-null the enforced mode is always 'disabled'; the form must keep
// defaulting from — and echoing back — the stored value, or saving during an
// override would clobber the operator's real configuration with 'disabled'.
const MODE_LABELS: Record<AuthMode, string> = {
  disabled: 'Disabled',
  local: 'Local accounts',
  oidc: 'OIDC',
};

// @ai-warning Both causes must be surfaced. `secret_decrypt_failure` used to
// be invisible here because the alert gated on a break-glass-only boolean,
// which rendered a normal, secured-looking OIDC page over a fully
// unauthenticated API. The recovery differs per cause, so the copy branches.
const FORCE_DISABLED_COPY: Record<
  AuthForceDisabledReason,
  { title: string; cause: React.ReactNode; recovery: React.ReactNode }
> = {
  break_glass: {
    title: 'Break-glass override active — authentication is force-disabled',
    cause: (
      <>
        <code className="font-mono text-xs">RECOVERY_DISABLE_AUTH</code> is set for this boot.
      </>
    ),
    recovery: (
      <>
        Changes saved here are stored, but take effect only after you clear{' '}
        <code className="font-mono text-xs">RECOVERY_DISABLE_AUTH</code> in the environment and
        restart the server.
      </>
    ),
  },
  secret_decrypt_failure: {
    title: 'Stored auth secret could not be decrypted — authentication is force-disabled',
    cause: (
      <>
        A stored auth secret could not be decrypted, so the server failed safe and disabled
        authentication for this boot.{' '}
        <code className="font-mono text-xs">CONFIG_ENCRYPTION_KEY</code> is missing, wrong, or was
        rotated.
      </>
    ),
    // @ai-warning Two claims here were wrong before and must not come back.
    //
    // 1. "Changes saved here take effect only after" restoring the key and
    //    restarting. FALSE, and it prolongs an open API: the decrypt degrade is
    //    recorded ONCE in the auth-config plugin's boot catch and is never
    //    re-applied (only `breakGlass` is, via `enforce()`), so the first
    //    successful `reload()` — which every `PUT /settings/auth` runs —
    //    replaces `authConfig.current`, and `plugins/auth.ts` reads that per
    //    request. `settings-auth-routes.test.ts` pins it: on a rotated-key boot
    //    the enforced mode is 'oidc' immediately after the PUT, no restart.
    //    Telling an operator sitting on an anonymous-ADMIN API that a save
    //    cannot help is telling them to leave it open while they hunt the key.
    // 2. "Never wiped", stated unscoped. That guarantee belongs to the DEGRADE,
    //    not to the deployment: since #241 an explicit save of a non-oidc mode
    //    DELETES both stored secret columns, and this panel is where an operator
    //    is most likely to try switching mode as a way out.
    //
    // Hence the three parts: what the degrade did (nothing), what a save does
    // (applies at once — and which modes actually close the API), and what it
    // costs. Saving `disabled` is deliberately called out as NOT closing the
    // API: it applies just as immediately, but disabled mode is open by design,
    // so lumping it in with `local` would swap one falsehood for another.
    recovery: (
      <>
        <span className="block">
          The degrade itself writes nothing — the encrypted secrets are intact and are never wiped
          by it. Restore or roll back{' '}
          <code className="font-mono text-xs">CONFIG_ENCRYPTION_KEY</code> to the value the secrets
          were encrypted with and restart the server, and this deployment comes back exactly as it
          is now, with nothing to re-enter.
        </span>
        <span className="mt-1 block">
          You do not have to wait for that to close the open API: saving here takes effect
          immediately, with no restart. Re-enter the client secret with OIDC still selected and
          enforcement resumes on the spot — the save re-encrypts under whatever{' '}
          <code className="font-mono text-xs">CONFIG_ENCRYPTION_KEY</code> is set now, so a rotated
          key works and only a missing one blocks it. Switching to Local accounts closes the API
          without needing a key at all. Saving Disabled applies just as immediately, but leaves the
          API open by design.
        </span>
        <span className="mt-1 block font-medium text-foreground">
          Saving either non-OIDC mode permanently deletes the stored OIDC client secret, and
          restoring the key will not bring it back — you would have to re-enter it from your
          identity provider.
        </span>
      </>
    ),
  },
};

function statusPill(
  status: 'connected' | 'unavailable' | 'disabled' | undefined,
  lastError: string | null | undefined,
): { variant: NonNullable<BadgeProps['variant']>; label: string } {
  if (status === 'connected') return { variant: 'success', label: 'Connected' };
  if (status === 'unavailable') {
    return { variant: 'warning', label: lastError ? 'Unavailable' : 'Waiting for issuer' };
  }
  return { variant: 'outline', label: 'Disabled' };
}

export function AuthenticationForm(): React.JSX.Element {
  const queryClient = useQueryClient();
  const authConfigQuery = useQuery({
    queryKey: ['auth-config'],
    queryFn: () => api.settings.auth.get(),
  });
  const data = authConfigQuery.data;

  const [edits, setEdits] = React.useState<AuthFormEdits>({});
  const [secretInputValue, setSecretInputValue] = React.useState('');
  const [secretReplacing, setSecretReplacing] = React.useState(false);
  const [testedOk, setTestedOk] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{ ok: boolean; error: string | null } | null>(
    null,
  );
  const [validationError, setValidationError] = React.useState<string | null>(null);
  // A validated update held back pending confirmation of the secret deletion it
  // would cause — see the guard in `handleSubmit`. Holding the parsed payload
  // (rather than a boolean) keeps the confirmed save byte-identical to the one
  // that was described in the dialog.
  const [pendingSecretDeletion, setPendingSecretDeletion] = React.useState<AuthConfigUpdate | null>(
    null,
  );

  const computed = {
    mode: edits.mode ?? data?.mode ?? 'disabled',
    issuerUrl: edits.issuerUrl ?? data?.issuerUrl ?? '',
    clientId: edits.clientId ?? data?.clientId ?? '',
    appBaseUrl: edits.appBaseUrl ?? data?.appBaseUrl ?? '',
    scopes: edits.scopes ?? data?.scopes ?? 'openid profile email',
    roleClaim: edits.roleClaim ?? data?.roleClaim ?? '',
    adminValues: edits.adminValues ?? data?.adminValues ?? '',
    defaultRole: edits.defaultRole ?? data?.defaultRole ?? 'admin',
    allowedEmailDomains: edits.allowedEmailDomains ?? data?.allowedEmailDomains ?? '',
    allowedEmails: edits.allowedEmails ?? data?.allowedEmails ?? '',
    sessionTtlHours: edits.sessionTtlHours ?? data?.sessionTtlHours ?? 12,
    allowInsecure: edits.allowInsecure ?? data?.allowInsecure ?? false,
  };

  // The fields the /test call actually verifies. If any of them currently
  // differ from what the server last verified — including "a replacement
  // secret is being typed" — the server's last-known-good state no longer
  // covers the config on screen, so it can't stand in for a fresh test.
  const criticalFieldsDirty =
    computed.issuerUrl !== (data?.issuerUrl ?? '') ||
    computed.clientId !== (data?.clientId ?? '') ||
    computed.allowInsecure !== (data?.allowInsecure ?? false) ||
    secretInputValue.trim() !== '';

  // Enabling OIDC is gated on a successful Test-connection this session —
  // unless the server already has it enabled AND none of the critical
  // fields have been edited away from that verified state, in which case
  // selecting 'oidc' again (or saving other, non-critical edits) needs no
  // fresh proof. Switching to 'disabled' or 'local' is never gated here —
  // the server enforces its own guard (NO_LOCAL_ADMIN) for 'local'.
  const canEnable = testedOk || (data?.mode === 'oidc' && !criticalFieldsDirty);
  const showSecretInput = !data?.clientSecretSet || secretReplacing;

  const editField = <K extends keyof AuthFormEdits>(key: K, value: AuthFormEdits[K]): void => {
    setEdits((prev) => ({ ...prev, [key]: value }));
  };

  // Changing anything the /test call actually sends invalidates a prior
  // "tested ok" result — otherwise a stale pass could unlock enabling a
  // config that was never actually verified.
  const resetTestedOk = (): void => {
    setTestedOk(false);
    setTestResult(null);
  };

  const testMutation = useMutation({
    mutationFn: (input: AuthConfigTest) => api.settings.auth.test(input),
    onSuccess: (result) => {
      setTestResult(result);
      setTestedOk(result.ok);
    },
    onError: (err) => {
      setTestResult({ ok: false, error: describeApiError(err, 'Connection test failed.') });
      setTestedOk(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: (input: AuthConfigUpdate) => api.settings.auth.update(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['auth-config'] });
      setEdits({});
      setSecretInputValue('');
      setSecretReplacing(false);
      setPendingSecretDeletion(null);
      toast.success('Authentication settings saved');
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not save authentication settings')),
  });

  const rotateMutation = useMutation({
    mutationFn: () => api.settings.auth.rotateSigningSecret(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['auth-config'] });
      toast.success('Signing secret rotated');
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not rotate signing secret')),
  });

  const handleModeChange = (next: AuthMode): void => {
    setValidationError(null);
    editField('mode', next);
  };

  const handleTestConnection = (): void => {
    setValidationError(null);
    testMutation.mutate({
      issuerUrl: computed.issuerUrl,
      clientId: computed.clientId,
      allowInsecure: computed.allowInsecure,
      ...(secretInputValue.trim() !== '' ? { clientSecret: secretInputValue.trim() } : {}),
    });
  };

  const handleCopyRedirectUri = async (): Promise<void> => {
    if (!data?.redirectUri) return;
    try {
      await navigator.clipboard.writeText(data.redirectUri);
      toast.success('Copied');
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setValidationError(null);

    const candidate: Record<string, unknown> = {
      mode: computed.mode,
      issuerUrl: computed.issuerUrl,
      clientId: computed.clientId,
      appBaseUrl: computed.appBaseUrl,
      scopes: computed.scopes,
      roleClaim: computed.roleClaim,
      adminValues: computed.adminValues,
      defaultRole: computed.defaultRole,
      allowedEmailDomains: computed.allowedEmailDomains,
      allowedEmails: computed.allowedEmails,
      sessionTtlHours: computed.sessionTtlHours,
      allowInsecure: computed.allowInsecure,
    };
    // Write-only: blank means unchanged. Only include clientSecret when the
    // admin actually typed a replacement, never send '' (that would clear it).
    //
    // @ai-warning Deliberately NOT gated on the mode being saved. A typed
    // secret submitted with a non-oidc mode is refused server-side with 422
    // CLIENT_SECRET_NOT_APPLICABLE (#241), and that refusal is the point: it
    // tells the operator their input was not stored. Dropping the field here
    // instead would answer 200 and discard the secret silently — reproducing on
    // the client exactly the silent drop `AuthConfigService.update()` refuses to
    // perform. The one place it IS dropped is the confirmed-deletion path
    // below, where the dialog has already said the secret is being deleted.
    if (secretInputValue.trim() !== '') {
      candidate.clientSecret = secretInputValue.trim();
    }

    const parsed = authConfigUpdateSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = typeof issue?.path[0] === 'string' ? issue.path[0] : undefined;
      const label = (field && FIELD_LABELS[field]) || field || 'Value';
      setValidationError(`${label}: ${issue?.message ?? 'Invalid value.'}`);
      return;
    }

    if (parsed.data.mode === 'oidc') {
      if (!canEnable) {
        setValidationError('Test the connection successfully before enabling OIDC.');
        return;
      }
      if (!parsed.data.appBaseUrl) {
        setValidationError('App base URL is required to enable OIDC.');
        return;
      }
    }

    // Saving a non-oidc mode CLEARS both stored secret columns server-side
    // (#241). That deletion is irreversible and, unlike every other failure
    // this panel describes, is specifically NOT undone by restoring
    // CONFIG_ENCRYPTION_KEY — so it takes a confirmation step rather than
    // happening on a single click.
    //
    // @ai-note Gated on the STORED mode, deliberately not on
    // `data.clientSecretSet`: that flag reports whether a secret is currently
    // IN EFFECT (contract in @lcm/shared), so it reads false in the two states
    // where stored ciphertext is most at risk — a decrypt-degraded boot, and a
    // row carrying leftover ciphertext from an earlier configuration. Keying
    // off it would skip the warning precisely when it matters most.
    //
    // KNOWN GAP: this does not "only over-ask". It UNDER-asks for one state — a
    // pre-#241 row that switched oidc -> local and kept its ciphertext. Its
    // stored mode is 'local', so any other non-oidc save (a session-TTL tweak
    // alone) skips this dialog while `update()` still nulls both columns: an
    // irreversible deletion with no confirmation. Nothing in the response can
    // detect it — both *SecretSet flags come from the mode-gated decrypt, so
    // both read false on exactly that row. The real fix is a non-secret boolean
    // derived from the RAW row (columns populated, independent of mode); that
    // is an additive change to a high-risk shared contract and belongs in its
    // own reviewed change. Bounded meanwhile: pre-#241 rows only, the secret is
    // unread in that mode, and the first such save clears it for good.
    //
    // @ai-warning Do NOT approximate the missing signal from `issuerUrl`/
    // `clientId` being set — those also survive on rows this build writes, whose
    // columns are already null, so it would confirm a deletion that is not
    // happening on every later non-oidc save. A false warning is worse than a
    // missing one.
    if (data?.mode === 'oidc' && parsed.data.mode !== 'oidc') {
      // Drop a typed replacement secret from BOTH the held payload and the
      // form. Keeping it made the confirmed save fail with 422
      // CLIENT_SECRET_NOT_APPLICABLE — so the operator authorised an
      // irreversible deletion and then nothing was saved and nothing deleted.
      // Silent here only: the dialog they are about to see states that the
      // client secret is being deleted and must be re-entered from the IdP, so
      // discarding the one they typed is what it already promises. Clearing the
      // input keeps the screen behind the dialog telling the same story.
      const { clientSecret: _discarded, ...withoutSecret } = parsed.data;
      setSecretInputValue('');
      setSecretReplacing(false);
      setPendingSecretDeletion(withoutSecret);
      return;
    }

    updateMutation.mutate(parsed.data);
  };

  const parseNum = (raw: string): NumInput => (raw === '' ? '' : Number(raw));
  const pill = statusPill(data?.discoveryStatus, data?.lastDiscoveryError);

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">Authentication</h3>
            <p className="text-sm text-fg-muted">
              Choose how users sign in — open access, local username/password accounts, or single
              sign-on via OIDC. Test the connection before enabling OIDC.
            </p>
          </div>
          <Badge variant={pill.variant} dot>
            {pill.label}
          </Badge>
        </header>

        {authConfigQuery.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        ) : null}
        {authConfigQuery.isError ? (
          <p className="text-sm text-destructive">Could not load authentication settings.</p>
        ) : null}

        {data ? (
          <form onSubmit={handleSubmit} className="space-y-3" noValidate>
            {data.discoveryStatus === 'unavailable' && data.lastDiscoveryError ? (
              <p className="text-xs text-warning">{data.lastDiscoveryError}</p>
            ) : null}

            {data.forceDisabledReason !== null ? (
              <div
                role="alert"
                aria-labelledby="force-disabled-alert-title"
                className="rounded-[var(--radius)] border border-warning/40 bg-warning/5 p-3"
              >
                <div className="flex items-start gap-2">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
                  <div className="space-y-1 text-sm">
                    <p id="force-disabled-alert-title" className="font-medium text-warning">
                      {FORCE_DISABLED_COPY[data.forceDisabledReason].title}
                    </p>
                    <p className="text-fg-muted">
                      {FORCE_DISABLED_COPY[data.forceDisabledReason].cause}{' '}
                      <strong className="font-medium text-foreground">
                        The API is currently unauthenticated
                      </strong>{' '}
                      — every request is treated as an anonymous admin until the server restarts.
                    </p>
                    <p className="text-fg-muted">
                      Your stored configuration is untouched — the saved mode is{' '}
                      <strong className="font-medium text-foreground">
                        {MODE_LABELS[data.mode]}
                      </strong>
                      . While the override is active the connection status above reads “Disabled”
                      regardless of the saved mode.
                    </p>
                    <p className="text-fg-muted">
                      {FORCE_DISABLED_COPY[data.forceDisabledReason].recovery}
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            <div>
              <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
                Mode
              </span>
              <div className="mt-1">
                <SegmentedControl
                  value={computed.mode}
                  onValueChange={handleModeChange}
                  ariaLabel="Authentication mode"
                  options={[
                    { value: 'disabled', label: 'Disabled' },
                    { value: 'local', label: 'Local accounts' },
                    {
                      value: 'oidc',
                      label: 'OIDC',
                      disabled: computed.mode !== 'oidc' && !canEnable,
                    },
                  ]}
                />
              </div>
              <p className="mt-1 text-xs text-fg-subtle">
                {computed.mode === 'disabled'
                  ? 'Every request is treated as an anonymous admin — no sign-in required.'
                  : computed.mode === 'local'
                    ? 'Sign in with a local username and password, managed below.'
                    : 'Single sign-on via an external identity provider.'}
              </p>
            </div>
            {!canEnable ? (
              <p className="text-xs text-fg-subtle">
                Run a successful connection test below to enable OIDC.
              </p>
            ) : null}

            <label className="block">
              <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
                Issuer URL
              </span>
              <Input
                aria-label="Issuer URL"
                placeholder="https://idp.example.com"
                value={computed.issuerUrl}
                onChange={(e) => {
                  editField('issuerUrl', e.target.value);
                  resetTestedOk();
                }}
                className="mt-1"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
                  Client ID
                </span>
                <Input
                  aria-label="Client ID"
                  value={computed.clientId}
                  onChange={(e) => {
                    editField('clientId', e.target.value);
                    resetTestedOk();
                  }}
                  className="mt-1"
                />
              </label>
              <div>
                <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
                  Client secret
                </span>
                {showSecretInput ? (
                  <Input
                    type="password"
                    aria-label="Client secret"
                    placeholder={data.clientSecretSet ? 'Enter new client secret' : 'Client secret'}
                    value={secretInputValue}
                    onChange={(e) => {
                      setSecretInputValue(e.target.value);
                      resetTestedOk();
                    }}
                    className="mt-1"
                  />
                ) : (
                  <div className="mt-1 flex h-8 items-center gap-2">
                    <span className="text-sm text-fg-subtle">•••••••• configured</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setSecretReplacing(true)}
                    >
                      Replace
                    </Button>
                  </div>
                )}
                {data.clientSecretSet && secretReplacing ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSecretReplacing(false);
                      setSecretInputValue('');
                    }}
                    className="mt-1 text-xs text-fg-subtle underline-offset-2 hover:underline"
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            </div>

            <div>
              <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
                Redirect URI
              </span>
              <div className="mt-1 flex items-center gap-2">
                <Input
                  readOnly
                  aria-label="Redirect URI"
                  value={data.redirectUri}
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Copy redirect URI"
                  onClick={() => {
                    void handleCopyRedirectUri();
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  computed.issuerUrl.trim() === '' ||
                  computed.clientId.trim() === '' ||
                  testMutation.isPending
                }
                onClick={handleTestConnection}
              >
                {testMutation.isPending ? 'Testing…' : 'Test connection'}
              </Button>
              {testResult ? (
                <p
                  role={testResult.ok ? 'status' : 'alert'}
                  className={testResult.ok ? 'text-sm text-success' : 'text-sm text-destructive'}
                >
                  {testResult.ok
                    ? 'Connection succeeded.'
                    : (testResult.error ?? 'Connection failed.')}
                </p>
              ) : null}
            </div>

            <label className="block">
              <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
                App base URL
              </span>
              <Input
                aria-label="App base URL"
                placeholder="https://app.example.com"
                value={computed.appBaseUrl}
                onChange={(e) => editField('appBaseUrl', e.target.value)}
                className="mt-1"
              />
              <span className="mt-1 block text-[11px] text-fg-subtle">
                Required to enable OIDC — used to build the redirect URI.
              </span>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
                  Scopes
                </span>
                <Input
                  aria-label="Scopes"
                  value={computed.scopes}
                  onChange={(e) => editField('scopes', e.target.value)}
                  className="mt-1"
                />
              </label>
              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
                  Role claim
                </span>
                <Input
                  aria-label="Role claim"
                  placeholder="e.g. roles"
                  value={computed.roleClaim}
                  onChange={(e) => editField('roleClaim', e.target.value)}
                  className="mt-1"
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
                  Admin values
                </span>
                <Input
                  aria-label="Admin values"
                  placeholder="e.g. admin,superuser"
                  value={computed.adminValues}
                  onChange={(e) => editField('adminValues', e.target.value)}
                  className="mt-1"
                />
              </label>
              <div>
                <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
                  Default role
                </span>
                <div className="mt-1">
                  <SegmentedControl
                    value={computed.defaultRole}
                    onValueChange={(v) => editField('defaultRole', v)}
                    ariaLabel="Default role"
                    options={[
                      { value: 'admin', label: 'Admin' },
                      { value: 'viewer', label: 'Viewer' },
                    ]}
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
                  Allowed email domains
                </span>
                <Input
                  aria-label="Allowed email domains"
                  placeholder="e.g. example.com"
                  value={computed.allowedEmailDomains}
                  onChange={(e) => editField('allowedEmailDomains', e.target.value)}
                  className="mt-1"
                />
              </label>
              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
                  Allowed emails
                </span>
                <Input
                  aria-label="Allowed emails"
                  placeholder="e.g. a@example.com,b@example.com"
                  value={computed.allowedEmails}
                  onChange={(e) => editField('allowedEmails', e.target.value)}
                  className="mt-1"
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
                  Session TTL (hours)
                </span>
                <Input
                  type="number"
                  min={1}
                  max={720}
                  aria-label="Session TTL (hours)"
                  value={computed.sessionTtlHours}
                  onChange={(e) => editField('sessionTtlHours', parseNum(e.target.value))}
                  className="mt-1"
                />
              </label>
              <label className="mt-5 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={computed.allowInsecure}
                  onChange={(e) => {
                    editField('allowInsecure', e.target.checked);
                    resetTestedOk();
                  }}
                  className="h-3.5 w-3.5 accent-accent"
                />
                Allow insecure issuer (HTTP) — testing only
              </label>
            </div>

            {data.mode === 'oidc' ? (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={rotateMutation.isPending}
                  onClick={() => rotateMutation.mutate()}
                >
                  {rotateMutation.isPending ? 'Rotating…' : 'Rotate signing secret'}
                </Button>
              </div>
            ) : null}

            {validationError ? (
              <p className="text-sm text-destructive" role="alert">
                {validationError}
              </p>
            ) : null}

            <div className="flex items-center justify-end">
              <Button type="submit" variant="accent" size="sm" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </form>
        ) : null}
      </Card>

      <ConfirmDialog
        open={pendingSecretDeletion !== null}
        onOpenChange={(open) => {
          // Cancel/dismiss drops the held update but keeps the pending field
          // edits, so the operator lands back on the form where they were. The
          // one thing not restored is a typed replacement secret: it was
          // cleared when the dialog opened, because a non-oidc save cannot
          // carry one (see `handleSubmit`).
          if (!open) setPendingSecretDeletion(null);
        }}
        title="Delete the stored OIDC client secret?"
        description={
          `Saving ${MODE_LABELS[pendingSecretDeletion?.mode ?? 'disabled']} deletes the stored ` +
          'OIDC client secret and login-state signing secret from the database. This cannot be ' +
          'undone: restoring CONFIG_ENCRYPTION_KEY will not bring them back, and you must ' +
          're-enter the client secret from your identity provider to turn OIDC back on.'
        }
        confirmLabel="Delete secret and save"
        destructive
        pending={updateMutation.isPending}
        onConfirm={() => {
          if (pendingSecretDeletion !== null) updateMutation.mutate(pendingSecretDeletion);
        }}
      />

      {computed.mode === 'local' ? <LocalAccountsPanel /> : null}

      {computed.mode === 'oidc' ? (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-fg-muted transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden
              className="h-3.5 w-3.5 transition-transform duration-150 group-open:rotate-90"
            />
            Local admin (break-glass)
          </summary>
          <div className="mt-3">
            <LocalAccountsPanel />
          </div>
        </details>
      ) : null}
    </div>
  );
}
