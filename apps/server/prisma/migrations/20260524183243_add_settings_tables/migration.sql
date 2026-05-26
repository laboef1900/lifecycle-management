-- CreateTable
CREATE TABLE "tenant_settings" (
    "tenant_id" TEXT NOT NULL,
    "warn_threshold" DECIMAL(4,3) NOT NULL DEFAULT 0.70,
    "crit_threshold" DECIMAL(4,3) NOT NULL DEFAULT 0.90,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "cluster_settings" (
    "cluster_id" TEXT NOT NULL,
    "warn_threshold" DECIMAL(4,3),
    "crit_threshold" DECIMAL(4,3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cluster_settings_pkey" PRIMARY KEY ("cluster_id")
);

-- AddForeignKey
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cluster_settings" ADD CONSTRAINT "cluster_settings_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE tenant_settings ADD CONSTRAINT tenant_settings_warn_lt_crit
  CHECK (warn_threshold > 0 AND warn_threshold < crit_threshold AND crit_threshold <= 1);

ALTER TABLE cluster_settings ADD CONSTRAINT cluster_settings_warn_lt_crit_when_both_set
  CHECK (
    warn_threshold IS NULL
    OR crit_threshold IS NULL
    OR (warn_threshold > 0 AND warn_threshold < crit_threshold AND crit_threshold <= 1)
  );
