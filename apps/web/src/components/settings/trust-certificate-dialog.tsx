import type { VsphereConnectionResponse } from '@lcm/shared';
import { useMutation } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import * as React from 'react';

import { CertificateFingerprint } from '@/components/settings/certificate-fingerprint';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api, describeApiError } from '@/lib/api-client';

/** The two connection states this dialog can repair. */
export type TrustableStatus = 'tls_untrusted' | 'cert_mismatch';

export function isTrustableStatus(status: VsphereConnectionResponse['status']): boolean {
  return status === 'tls_untrusted' || status === 'cert_mismatch';
}

/**
 * Copy differs by status because the *act* differs. `tls_untrusted` establishes
 * trust for the first time. `cert_mismatch` REPLACES trust material that a human
 * already confirmed once — the admin has to be told that, because the benign
 * cause (someone regenerated the VMCA root) and the hostile one (a re-pin to an
 * attacker's root, which delivers the credential on the next poll) look identical
 * from here. Collapsing the two into one message hides the only decision that
 * matters.
 */
const COPY: Record<TrustableStatus, { title: string; description: string; confirm: string }> = {
  tls_untrusted: {
    title: 'Trust this certificate',
    description:
      'LCM will pin this exact certificate as the trust anchor for this connection. Compare the fingerprint against your vCenter before you confirm.',
    confirm: 'Trust certificate',
  },
  cert_mismatch: {
    title: 'Replace the trusted certificate',
    description:
      'This connection already has a confirmed certificate, and vCenter is now presenting a different one. Confirming REPLACES the previously trusted certificate — the old one stops being accepted.',
    confirm: 'Replace trusted certificate',
  },
};

interface TrustCertificateDialogProps {
  /** The connection being repaired; the dialog is mounted only while non-null. */
  connection: VsphereConnectionResponse;
  onOpenChange: (open: boolean) => void;
  onTrusted: () => void;
}

/**
 * Two-step trust repair for a saved connection: probe, then confirm.
 *
 * @ai-warning The probe uses the STORED hostname and port — never a typed-in
 * one, and there is no field to type one into. This dialog must never become a
 * "probe an arbitrary URL" affordance, and the password must never become
 * optional "because it's already saved": re-pinning trust material is exactly
 * what a DNS-spoof-plus-repin attack needs, which is why the endpoint demands it.
 */
export function TrustCertificateDialog({
  connection,
  onOpenChange,
  onTrusted,
}: TrustCertificateDialogProps): React.JSX.Element {
  const [password, setPassword] = React.useState('');
  const copy = COPY[connection.status === 'cert_mismatch' ? 'cert_mismatch' : 'tls_untrusted'];

  // Read-only, sends no credential. Fired once on mount: the dialog is mounted
  // only while open, so re-opening always re-probes rather than showing a cached
  // fingerprint for a certificate that may have changed since.
  const probeMutation = useMutation({
    mutationFn: () =>
      api.settings.vsphere.probe({ hostname: connection.hostname, port: connection.port }),
  });
  const { mutate: startProbe } = probeMutation;
  React.useEffect(() => {
    startProbe();
  }, [startProbe]);

  const trustMutation = useMutation({
    mutationFn: (fingerprint: string) =>
      api.settings.vsphere.connections.trustCert(connection.id, {
        leafFingerprintSha256: fingerprint,
        password,
      }),
    onSuccess: onTrusted,
  });

  const probe = probeMutation.data;
  const fingerprint = probe?.reachable ? probe.leafFingerprintSha256 : null;
  const trustError = trustMutation.error;

  // Every close path is sealed while the trust submission is in flight, matching
  // the already-disabled Cancel button. React Query does not cancel a mutation on
  // unmount, so a dialog dismissed mid-submit still fires `onSuccess` afterwards —
  // which clears the parent's target and force-closes whatever dialog is open by
  // then, possibly a *different* connection's, discarding a typed password. The
  // guard covers the X button too (it lives in the shared DialogContent and routes
  // through here); the preventDefaults stop Radix dismissing before it asks.
  // Gated on the TRUST mutation only — the probe is read-only and safe to abandon.
  const sealed = trustMutation.isPending;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (sealed) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        onEscapeKeyDown={(e) => {
          if (sealed) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (sealed) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>

        <p className="text-muted-foreground font-mono text-xs">
          {connection.hostname}
          {connection.port !== 443 ? `:${connection.port}` : ''}
        </p>

        {probeMutation.isPending ? (
          <p className="text-muted-foreground text-sm">Reading the certificate…</p>
        ) : fingerprint === null ? (
          <p className="text-destructive flex items-center gap-2 text-sm">
            <ShieldAlert className="size-4" aria-hidden />
            {probeMutation.isError
              ? describeApiError(probeMutation.error, 'Certificate check failed')
              : 'Could not reach that host, or it did not present a certificate.'}
          </p>
        ) : (
          <div className="border-warning/40 bg-warning/5 rounded-lg border p-3 text-sm">
            <p className="flex items-center gap-2 font-medium">
              <ShieldAlert className="text-warning size-4" aria-hidden />
              Confirm this fingerprint
            </p>
            <p className="text-muted-foreground mt-1">
              On the vCenter host,{' '}
              <code className="font-mono text-xs">govc about.cert -thumbprint</code> prints the same
              value.
            </p>
            <CertificateFingerprint fingerprint={fingerprint} validTo={probe?.validTo ?? null} />
          </div>
        )}

        <form
          id="trust-certificate-form"
          className="flex flex-col gap-1 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (fingerprint !== null) trustMutation.mutate(fingerprint);
          }}
        >
          <label className="flex flex-col gap-1" htmlFor="trust-certificate-password">
            <span>Password for {connection.username}</span>
            <Input
              id="trust-certificate-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <p className="text-muted-foreground text-xs">
            Re-pinning trust material needs the connection&rsquo;s own password.
          </p>
        </form>

        {/* The endpoint's own words (PASSWORD_MISMATCH / FINGERPRINT_MISMATCH /
            VCENTER_UNREACHABLE) — each one points at a different fix, so a
            generic "failed" would cost the admin the diagnosis. role="alert"
            announces it; the icon and text carry it without colour. */}
        {trustError ? (
          <p className="text-destructive flex items-center gap-2 text-sm" role="alert">
            <ShieldAlert className="size-4 shrink-0" aria-hidden />
            {describeApiError(trustError, 'Could not trust the certificate')}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={sealed}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="trust-certificate-form"
            variant={connection.status === 'cert_mismatch' ? 'destructive' : 'accent'}
            disabled={fingerprint === null || password.length === 0 || trustMutation.isPending}
          >
            {trustMutation.isPending ? 'Working…' : copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
