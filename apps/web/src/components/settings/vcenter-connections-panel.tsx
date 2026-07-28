import type {
  VsphereConnectionCreate,
  VsphereConnectionResponse,
  VsphereProbe,
  VsphereProbeResult,
  VsphereSyncOutcome,
} from '@lcm/shared';
import { vsphereConnectionCreateSchema, vsphereProbeSchema } from '@lcm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, ShieldCheck, ShieldAlert, Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { AdminOnly } from '@/components/auth/admin-only';
import { ConfirmDialog } from '@/components/form/confirm-dialog';
import { Field, useFocusFirstInvalidField } from '@/components/form/field';
import { CertificateFingerprint } from '@/components/settings/certificate-fingerprint';
import {
  isTrustableStatus,
  TrustCertificateDialog,
} from '@/components/settings/trust-certificate-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { api, describeApiError } from '@/lib/api-client';

interface AddFormState {
  name: string;
  hostname: string;
  /** String while typing; parsed to a number on submit/probe. Defaults to '443'. */
  port: string;
  username: string;
  password: string;
}

type AddFormField = keyof AddFormState;
type FieldErrors = Partial<Record<AddFormField, string>>;

const EMPTY_FORM: AddFormState = {
  name: '',
  hostname: '',
  port: '443',
  username: '',
  password: '',
};

/** Everything the probe is allowed to see. Notably: no credential. */
const PROBE_FIELDS: readonly AddFormField[] = ['hostname', 'port'];
const CREATE_FIELDS: readonly AddFormField[] = ['name', 'hostname', 'port', 'username', 'password'];

/**
 * Blank-field copy in the panel's own words. The shared schemas remain the
 * authority on what is *valid* — bounds are never restated here — but their
 * `min(1)` text ("Too small: expected string to have >=1 characters") is wire
 * copy describing a contract, not something to put in front of an admin.
 */
const BLANK_MESSAGES: Readonly<Record<AddFormField, string>> = {
  name: 'Give this connection a name.',
  hostname: 'Enter the vCenter hostname or IP address.',
  port: 'Enter the HTTPS port vCenter listens on.',
  username: 'Enter the read-only service account.',
  password: 'Enter the password for that account.',
};

/**
 * "Blank" the way each field's own contract measures it. `name`, `hostname`, and
 * `username` are `.trim()`ed by the schema, so whitespace-only is empty for them
 * — but `password` deliberately is NOT, because a credential may legitimately
 * contain leading or trailing whitespace. Measuring it uniformly would reject a
 * password the contract accepts.
 */
function isBlank(field: AddFormField, value: string): boolean {
  return field === 'password' ? value.length === 0 : value.trim().length === 0;
}

/** Blank (and non-integer port) cases, which the schemas can only describe in wire terms. */
function blankFieldErrors(form: AddFormState, fields: readonly AddFormField[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const field of fields) {
    if (isBlank(field, form[field])) errors[field] = BLANK_MESSAGES[field];
  }
  // `Number('')` is 0 and `Number('44.5')` is 44.5: both are number-typed, so the
  // schema would answer in `Too small`/`expected int` terms instead of plainly.
  if (fields.includes('port') && errors.port === undefined) {
    if (!Number.isInteger(Number(form.port))) {
      errors.port = 'Port must be a whole number.';
    }
  }
  return errors;
}

/** Zod issues → the field that owns each one, discarding anything unowned. */
function issuesToFieldErrors(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const root = issue.path[0];
    if (
      root === 'name' ||
      root === 'hostname' ||
      root === 'port' ||
      root === 'username' ||
      root === 'password'
    ) {
      errors[root] = issue.message;
    }
  }
  return errors;
}

/**
 * Settings panel for vCenter connections (#175, epic #172).
 *
 * The flow is deliberately two-step — **probe, then verify** — and the panel must
 * not "helpfully" collapse it into one action. Probing sends no credential, so the
 * certificate can be vetted *before* the password is ever transmitted. A merged
 * "test connection" would send the password to a certificate nobody has confirmed,
 * on first contact, which is the disclosure the whole design exists to prevent.
 *
 * @ai-warning Never add a UI affordance that re-tests a saved connection against a
 * typed-in URL, and never let the password field be optional "because it's already
 * saved". The stored credential goes to the stored host only.
 */
export function VcenterConnectionsPanel(): React.JSX.Element {
  const queryClient = useQueryClient();
  const connectionsQuery = useQuery({
    queryKey: ['vsphere-connections'],
    queryFn: () => api.settings.vsphere.connections.list(),
  });

  const [form, setForm] = React.useState<AddFormState>(EMPTY_FORM);
  const [probe, setProbe] = React.useState<VsphereProbeResult | null>(null);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [deleteTarget, setDeleteTarget] = React.useState<VsphereConnectionResponse | null>(null);
  const [trustTarget, setTrustTarget] = React.useState<VsphereConnectionResponse | null>(null);
  const formRef = React.useRef<HTMLFormElement>(null);
  useFocusFirstInvalidField(formRef, errors);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['vsphere-connections'] });
  };

  // Step 1 — reachability + certificate. No credential leaves the browser here.
  // Takes its payload as a mutation variable rather than reading `form`, so the
  // only thing that can reach the endpoint is a value `vsphereProbeSchema`
  // accepted (see `onCheckCertificate`).
  const probeMutation = useMutation({
    mutationFn: (input: VsphereProbe) => api.settings.vsphere.probe(input),
    onSuccess: (result) => {
      setProbe(result);
      if (result.outcome === 'unreachable') toast.error('Could not reach that host');
    },
    onError: (err) => toast.error(describeApiError(err, 'Certificate check failed')),
  });

  const createMutation = useMutation({
    mutationFn: (input: VsphereConnectionCreate) => api.settings.vsphere.connections.create(input),
    onSuccess: () => {
      invalidate();
      setForm(EMPTY_FORM);
      setProbe(null);
      setErrors({});
      toast.success('vCenter connection saved');
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not save the connection')),
  });

  /**
   * @ai-warning The probe must never fire with an unvalidated hostname or port.
   * It opens a TLS connection to whatever it is handed and returns the
   * fingerprint the admin then confirms — and that fingerprint becomes the trust
   * anchor the stored credential is later sent to. A parser-differential
   * hostname (`vcenter.corp.local@attacker.example`) is exactly what
   * `vcenterHostname` in `@lcm/shared` exists to reject, so it is validated here
   * before the request, not only after it.
   */
  const onCheckCertificate = (): void => {
    const blank = blankFieldErrors(form, PROBE_FIELDS);
    if (Object.keys(blank).length > 0) {
      setErrors(blank);
      return;
    }
    const parsed = vsphereProbeSchema.safeParse({
      hostname: form.hostname,
      port: Number(form.port),
    });
    if (!parsed.success) {
      setErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    probeMutation.mutate(parsed.data);
  };

  const onSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const blank = blankFieldErrors(form, CREATE_FIELDS);
    if (Object.keys(blank).length > 0) {
      setErrors(blank);
      return;
    }
    const parsed = vsphereConnectionCreateSchema.safeParse({
      name: form.name,
      hostname: form.hostname,
      port: Number(form.port),
      username: form.username,
      password: form.password,
      enabled: true,
    });
    if (!parsed.success) {
      const fieldErrors = issuesToFieldErrors(parsed.error.issues);
      setErrors(fieldErrors);
      if (Object.keys(fieldErrors).length === 0) {
        toast.error(parsed.error.issues[0]?.message ?? 'Could not save the connection');
      }
      return;
    }
    setErrors({});
    createMutation.mutate(parsed.data);
  };

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.settings.vsphere.connections.remove(id),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
      toast.success('Connection removed');
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not remove the connection')),
  });

  // "Sync now" (#192): queue an immediate sync. The request returns 202 at once —
  // the scheduler's next tick runs it. Refetch so the last-sync line updates once
  // the run lands (the mutation itself never waits for vCenter).
  const syncNowMutation = useMutation({
    mutationFn: (id: string) => api.settings.vsphere.connections.syncNow(id),
    onSuccess: () => {
      invalidate();
      toast.success('Sync queued — it runs within a minute');
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not queue a sync')),
  });

  const connections = connectionsQuery.data ?? [];

  return (
    <Card className="p-6">
      <header className="mb-4">
        <h3 className="font-display text-lg">vCenter connections</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          LCM reads capacity from vCenter and never writes to it.{' '}
          <strong>Use a read-only service account.</strong> Credentials are encrypted at rest and
          are only ever sent to the host saved with them.
        </p>
      </header>

      {connectionsQuery.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : connections.length === 0 ? (
        <EmptyState
          title="No vCenter connected"
          description="Add a connection to sync clusters and hosts automatically."
        />
      ) : (
        <ul className="mb-6 flex flex-col gap-2">
          {connections.map((c) => (
            <li
              key={c.id}
              className="border-border flex items-center justify-between rounded-lg border p-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{c.name}</span>
                  <ConnectionStatusBadge connection={c} />
                </div>
                <p className="text-muted-foreground font-mono text-xs">
                  {`${c.username}@${c.hostname}${c.port !== 443 ? `:${c.port}` : ''}`}
                  {c.apiVersion ? ` · vCenter ${c.apiVersion}` : ''}
                </p>
                <SyncStateLine syncState={c.syncState} />
                {c.lastError ? (
                  <p className="text-destructive mt-1 text-xs">{c.lastError}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {/* ADMIN-only: viewers never see the control, and the server 403s
                    it regardless. Disabled connections are never syncable — the
                    scheduler filters them out, so a queued run could never fire. */}
                {/* The recovery path out of an untrusted or changed certificate
                    (#259). Only offered where it means something — the other
                    statuses are not fixed by re-pinning. */}
                {isTrustableStatus(c.status) ? (
                  <AdminOnly>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Trust certificate: ${c.name}`}
                      onClick={() => setTrustTarget(c)}
                    >
                      <ShieldCheck className="size-3.5" aria-hidden />
                      Trust certificate
                    </Button>
                  </AdminOnly>
                ) : null}
                <AdminOnly>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Sync now: ${c.name}`}
                    disabled={
                      !c.enabled ||
                      (syncNowMutation.isPending && syncNowMutation.variables === c.id)
                    }
                    onClick={() => syncNowMutation.mutate(c.id)}
                  >
                    <RefreshCw className="size-3.5" aria-hidden />
                    Sync now
                  </Button>
                </AdminOnly>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${c.name}`}
                  onClick={() => setDeleteTarget(c)}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* `noValidate`: the browser's bubble is transient, unstyled, and stops at
          the first offending field — and on this surface it was the ONLY
          validation, so the handlers above had to become the real gate before it
          could be switched off. Errors now render through `Field`, and focus
          moves to the first invalid control. */}
      <form ref={formRef} className="flex flex-col gap-3" onSubmit={onSubmit} noValidate>
        {/* Every `Field` here carries an explicit `id`, and it is load-bearing
            rather than cosmetic. `Field` otherwise derives its id from
            `name ?? label`, so a bare `label="Name"` renders `id="field-name"` —
            and this panel shares `/settings/inventory` with `AddClusterPanel`,
            whose "Add cluster" dialog has a `Name` field of its own. With two
            `#field-name` in one document the dialog's `<label for>` resolves to
            THIS input instead: the dialog's own control loses its accessible
            name, clicking its label throws focus out of the modal, and its
            `aria-describedby` points at this form's error paragraph.

            @ai-warning Namespaced via `id`, deliberately NOT via `name`. Adding
            a `name` to a credential form is what turns a browser's autofill and
            save-password heuristics on for this vCenter service account, and
            that credential is the one thing the two-step probe/verify flow above
            exists to keep contained. Do not drop these, and do not "simplify"
            them into `name` props. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Name"
            id="vcenter-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            error={errors.name}
            placeholder="vc-prod"
            required
          />
          <Field
            label="Hostname"
            id="vcenter-hostname"
            value={form.hostname}
            onChange={(e) => {
              setForm({ ...form, hostname: e.target.value });
              setProbe(null); // a new host means the old certificate says nothing
            }}
            error={errors.hostname}
            placeholder="vcenter.corp.local"
            required
          />
          <Field
            label="Port"
            id="vcenter-port"
            type="number"
            min={1}
            max={65535}
            value={form.port}
            onChange={(e) => {
              setForm({ ...form, port: e.target.value });
              setProbe(null); // a different port is a different endpoint
            }}
            error={errors.port}
            placeholder="443"
            required
          />
          <Field
            label="Username"
            id="vcenter-username"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            error={errors.username}
            placeholder="svc-lcm@vsphere.local"
            required
          />
          <Field
            label="Password"
            id="vcenter-password"
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            error={errors.password}
            required
          />
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!form.hostname || probeMutation.isPending}
            onClick={onCheckCertificate}
          >
            {probeMutation.isPending ? 'Checking…' : 'Check certificate'}
          </Button>
          <Button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Saving…' : 'Save connection'}
          </Button>
        </div>

        {probe ? <ProbeResult probe={probe} /> : null}
      </form>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={`Remove ${deleteTarget?.name ?? ''}?`}
        description="Clusters already imported from this vCenter are kept and become manually managed. No capacity data or baselines are deleted."
        confirmLabel="Remove"
        destructive
        pending={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
      />

      {/* Mounted only while open, so every opening re-probes rather than
          reusing a fingerprint captured before the certificate changed. */}
      {trustTarget ? (
        <TrustCertificateDialog
          connection={trustTarget}
          onOpenChange={(open) => {
            if (!open) setTrustTarget(null);
          }}
          onTrusted={() => {
            invalidate();
            setTrustTarget(null);
            // The service resets status to `never_connected`, so the scheduler's
            // next tick retries on its own — no "Sync now" click required.
            toast.success('Certificate trusted — the next sync will retry automatically');
          }}
        />
      ) : null}
    </Card>
  );
}

function ConnectionStatusBadge({
  connection,
}: {
  connection: VsphereConnectionResponse;
}): React.JSX.Element {
  // Colour is never the only signal — each state carries its own words. A viewer
  // who cannot distinguish the hues still reads the status.
  if (!connection.enabled) return <Badge variant="default">Disabled</Badge>;
  switch (connection.status) {
    case 'active':
      return <Badge variant="success">Connected</Badge>;
    case 'never_connected':
      return <Badge variant="default">Not yet connected</Badge>;
    case 'auth_failed':
      return <Badge variant="danger">Sign-in failed</Badge>;
    case 'cert_mismatch':
      return <Badge variant="danger">Certificate changed</Badge>;
    case 'identity_mismatch':
      return <Badge variant="danger">Different vCenter</Badge>;
    case 'secret_undecryptable':
      return <Badge variant="danger">Credential unreadable</Badge>;
    case 'tls_untrusted':
      return <Badge variant="warning">Certificate not trusted</Badge>;
    default:
      return <Badge variant="warning">Unreachable</Badge>;
  }
}

/**
 * The connection's last scheduler-job outcome (#192): when it last synced and, if
 * that sync did not succeed, why — stated in words, never colour alone (house
 * style). Distinct from the status badge above, which reports reachability; a
 * connection can be reachable while its last sync was skipped or failed.
 */
function SyncStateLine({
  syncState,
}: {
  syncState: VsphereConnectionResponse['syncState'];
}): React.JSX.Element {
  if (!syncState || !syncState.lastSyncAt) {
    return <p className="text-muted-foreground mt-1 text-xs">Not synced yet</p>;
  }
  const status = syncState.lastSyncStatus;
  const problem = status !== null && status !== 'ok' ? describeSyncOutcome(status) : null;
  return (
    <p className="text-muted-foreground mt-1 text-xs">
      Last synced {new Date(syncState.lastSyncAt).toLocaleString()}
      {problem ? <span className="text-warning"> · {problem}</span> : null}
    </p>
  );
}

/** A vСenter sync outcome as a short human phrase. */
function describeSyncOutcome(outcome: VsphereSyncOutcome): string {
  switch (outcome) {
    case 'ok':
      return 'up to date';
    case 'unreachable':
      return 'vCenter unreachable';
    case 'auth_failed':
      return 'credentials rejected';
    case 'tls_untrusted':
      return 'certificate not trusted';
    case 'identity_mismatch':
      return 'different vCenter';
    case 'skipped':
      return 'skipped';
  }
}

/**
 * What the certificate check found.
 *
 * Shows the fingerprint and nothing else about the certificate — no subject, no
 * SANs. That is enough for the admin to compare against `govc about.cert
 * -thumbprint` or the vSphere Client, and not enough for anyone to enumerate a
 * network with.
 */
function ProbeResult({ probe }: { probe: VsphereProbeResult }): React.JSX.Element {
  if (!probe.reachable) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <ShieldAlert className="text-warning size-4" aria-hidden />
        Could not reach that host, or it did not present a certificate.
      </p>
    );
  }

  if (probe.trustedBySystemRoots) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <ShieldCheck className="text-success size-4" aria-hidden />
        Certificate is trusted by a public CA — nothing to confirm.
      </p>
    );
  }

  // Reachable, not publicly trusted, yet no readable chain — nothing to confirm,
  // and inventing a blank fingerprint box would invite confirming nothing at all.
  if (probe.leafFingerprintSha256 === null) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <ShieldAlert className="text-warning size-4" aria-hidden />
        The host answered but did not present a readable certificate chain.
      </p>
    );
  }

  return (
    <div className="border-warning/40 bg-warning/5 rounded-lg border p-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <ShieldAlert className="text-warning size-4" aria-hidden />
        Self-signed certificate — confirm this fingerprint
      </p>
      <p className="text-muted-foreground mt-1">
        Compare it against your vCenter before saving. On the vCenter host,{' '}
        <code className="font-mono text-xs">govc about.cert -thumbprint</code> prints the same
        value.
      </p>
      <CertificateFingerprint fingerprint={probe.leafFingerprintSha256} validTo={probe.validTo} />
    </div>
  );
}
