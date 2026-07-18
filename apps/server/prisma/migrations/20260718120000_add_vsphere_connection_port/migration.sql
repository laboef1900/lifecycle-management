-- Configurable vCenter HTTPS port (#199).
--
-- Purely additive and backfill-free: NOT NULL DEFAULT 443 stamps every existing
-- row with the previously hardcoded value, so no connection changes behaviour on
-- deploy. Full 1-65535 is allowed by the application contract; TOFU root-pinning
-- (tls_pinned_ca_pem) remains the trust gate, not a port allow-list. Postgres adds
-- a NOT NULL column with a constant default as a metadata-only change (no table
-- rewrite), and DROP COLUMN reverses it cleanly.
ALTER TABLE "vsphere_connections"
    ADD COLUMN "port" INTEGER NOT NULL DEFAULT 443;
