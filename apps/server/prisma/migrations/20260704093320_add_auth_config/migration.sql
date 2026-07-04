-- CreateTable
CREATE TABLE "auth_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "mode" TEXT NOT NULL DEFAULT 'disabled',
    "issuer_url" TEXT,
    "client_id" TEXT,
    "client_secret_enc" TEXT,
    "signing_secret_enc" TEXT,
    "app_base_url" TEXT,
    "scopes" TEXT NOT NULL DEFAULT 'openid profile email',
    "role_claim" TEXT,
    "admin_values" TEXT,
    "default_role" TEXT NOT NULL DEFAULT 'admin',
    "allowed_email_domains" TEXT,
    "allowed_emails" TEXT,
    "session_ttl_hours" INTEGER NOT NULL DEFAULT 12,
    "allow_insecure" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" TEXT,

    CONSTRAINT "auth_config_pkey" PRIMARY KEY ("id")
);
