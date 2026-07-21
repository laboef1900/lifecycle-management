-- Existing pins are chain-root fingerprints and cannot match a leaf pin.
-- Reset them so the operator re-confirms the leaf once (dev-only; no prod data).
UPDATE "vsphere_connections"
SET "tls_pinned_sha256" = NULL,
    "status" = 'tls_untrusted'
WHERE "tls_mode" = 'pinned' AND "tls_pinned_sha256" IS NOT NULL;

-- Leaf pinning stores only the fingerprint; the PEM anchor is gone.
ALTER TABLE "vsphere_connections" DROP COLUMN "tls_pinned_ca_pem";
