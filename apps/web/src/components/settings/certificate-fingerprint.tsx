/**
 * A probed certificate's SHA-256 root fingerprint, and nothing else about it.
 *
 * @ai-warning The privacy stance lives here, in one place: fingerprint and
 * expiry only — never subject, issuer, or SANs. A fingerprint is a hash, useless
 * for enumerating a network but sufficient for the admin to compare against
 * `govc about.cert -thumbprint`. Rendering more would turn every surface that
 * uses this into an internal TLS scanner. Both callers (the add-connection probe
 * and the trust-certificate dialog) share it so the stance cannot drift apart.
 */
export function CertificateFingerprint({
  fingerprint,
  validTo,
}: {
  fingerprint: string;
  validTo: string | null;
}): React.JSX.Element {
  return (
    <>
      <p className="mt-2 font-mono text-xs break-all">{fingerprint}</p>
      {validTo ? <p className="text-muted-foreground mt-1 text-xs">Expires {validTo}</p> : null}
    </>
  );
}
