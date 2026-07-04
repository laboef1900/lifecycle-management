-- CreateTable
CREATE TABLE "auth_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "mode" TEXT NOT NULL DEFAULT 'disabled',
    "issuerUrl" TEXT,
    "clientId" TEXT,
    "clientSecretEnc" TEXT,
    "signingSecretEnc" TEXT,
    "appBaseUrl" TEXT,
    "scopes" TEXT NOT NULL DEFAULT 'openid profile email',
    "roleClaim" TEXT,
    "adminValues" TEXT,
    "defaultRole" TEXT NOT NULL DEFAULT 'admin',
    "allowedEmailDomains" TEXT,
    "allowedEmails" TEXT,
    "sessionTtlHours" INTEGER NOT NULL DEFAULT 12,
    "allowInsecure" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,

    CONSTRAINT "auth_config_pkey" PRIMARY KEY ("id")
);
