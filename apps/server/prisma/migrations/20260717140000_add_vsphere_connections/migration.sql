-- vCenter connections, one row per instance (#175, epic #172).
--
-- Purely additive: a new table, no existing column touched.
--
-- N rows, not a singleton. The deployment has two or more vCenters, so the
-- AuthConfig singleton this issue originally proposed cannot express it.
--
-- password_enc holds an AES-GCM envelope under CONFIG_ENCRYPTION_KEY. The TLS
-- columns are deliberately NOT encrypted: a CA certificate is public by
-- construction (vCenter serves it unauthenticated and presents it in every
-- handshake) and a fingerprint is a hash of public data, so encrypting either
-- would protect a secret that does not exist.
CREATE TABLE "vsphere_connections" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_enc" TEXT NOT NULL,
    "tls_mode" TEXT NOT NULL DEFAULT 'pinned',
    "tls_pinned_ca_pem" TEXT,
    "tls_pinned_sha256" TEXT,
    "instance_uuid" TEXT,
    "api_version" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'never_connected',
    "last_error" TEXT,
    "last_connected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vsphere_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vsphere_connections_tenant_id_name_key"
    ON "vsphere_connections"("tenant_id", "name");

-- Stops the same vCenter being registered twice under two names (e.g. its FQDN
-- and its IP). Without this, every cluster would import twice and fleet capacity
-- would silently double — a plausible, purchasing-relevant wrong answer rather
-- than an error. instance_uuid is NULL until the first successful connect, and
-- Postgres treats NULLs as distinct, so unconnected rows never collide (the same
-- property hosts_tenant_serial_unique already relies on).
CREATE UNIQUE INDEX "vsphere_connections_tenant_instance_unique"
    ON "vsphere_connections"("tenant_id", "instance_uuid");

ALTER TABLE "vsphere_connections" ADD CONSTRAINT "vsphere_connections_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
