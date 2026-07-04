import { authConfigUpdateSchema, type AuthConfigTest, type AuthConfigUpdate } from '@lcm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { api, describeApiError } from '@/lib/api-client';

type NumInput = number | '';

// Local edits override the server-derived config. A key absent from `edits`
// means "not edited — use the server value" — same decoupled-edit pattern as
// ForecastThresholdsForm, just consolidated into one object given the field
// count here.
interface AuthFormEdits {
  mode?: 'disabled' | 'oidc';
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

  // Enabling OIDC is gated on a successful Test-connection this session —
  // unless the server already has it enabled, in which case flipping the
  // local checkbox back on (without editing connection fields) needs no
  // fresh proof.
  const canEnable = testedOk || data?.mode === 'oidc';
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

  const handleToggleEnabled = (nextChecked: boolean): void => {
    setValidationError(null);
    editField('mode', nextChecked ? 'oidc' : 'disabled');
  };

  const handleTestConnection = (): void => {
    setValidationError(null);
    testMutation.mutate({
      issuerUrl: computed.issuerUrl,
      clientId: computed.clientId,
      allowInsecure: computed.allowInsecure,
      ...(secretInputValue.trim() !== '' ? { clientSecret: secretInputValue } : {}),
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
    if (secretInputValue.trim() !== '') {
      candidate.clientSecret = secretInputValue;
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

    updateMutation.mutate(parsed.data);
  };

  const parseNum = (raw: string): NumInput => (raw === '' ? '' : Number(raw));
  const pill = statusPill(data?.discoveryStatus, data?.lastDiscoveryError);

  return (
    <Card className="p-4">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Authentication</h2>
          <p className="text-sm text-fg-muted">
            Configure single sign-on via OIDC. Test the connection before enabling it.
          </p>
        </div>
        <Badge variant={pill.variant} dot>
          {pill.label}
        </Badge>
      </header>

      {authConfigQuery.isPending ? <p className="text-sm text-fg-subtle">Loading…</p> : null}
      {authConfigQuery.isError ? (
        <p className="text-sm text-destructive">Could not load authentication settings.</p>
      ) : null}

      {data ? (
        <form onSubmit={handleSubmit} className="space-y-3" noValidate>
          {data.discoveryStatus === 'unavailable' && data.lastDiscoveryError ? (
            <p className="text-xs text-warning">{data.lastDiscoveryError}</p>
          ) : null}

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="auth-enable-toggle"
              role="switch"
              aria-checked={computed.mode === 'oidc'}
              checked={computed.mode === 'oidc'}
              disabled={computed.mode !== 'oidc' && !canEnable}
              onChange={(e) => handleToggleEnabled(e.target.checked)}
              className="h-4 w-4 accent-accent disabled:opacity-50"
            />
            <label htmlFor="auth-enable-toggle" className="text-sm font-medium">
              Enable OIDC authentication
            </label>
          </div>
          {computed.mode !== 'oidc' && !canEnable ? (
            <p className="text-xs text-fg-subtle">
              Run a successful connection test below to enable.
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
  );
}
