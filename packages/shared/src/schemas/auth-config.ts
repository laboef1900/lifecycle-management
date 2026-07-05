import { z } from 'zod';

const emptyToNull = (v: unknown): unknown => (v === '' ? null : v);
const csvField = z.preprocess(emptyToNull, z.string().max(2000).nullable().optional());
const urlOrNull = z.preprocess(emptyToNull, z.url().nullable().optional());

export const authConfigUpdateSchema = z.strictObject({
  mode: z.enum(['disabled', 'oidc']),
  issuerUrl: urlOrNull,
  clientId: z.preprocess(emptyToNull, z.string().max(255).nullable().optional()),
  // write-only: omitted = unchanged; null = clear; string = set
  clientSecret: z.preprocess(emptyToNull, z.string().max(2000).nullable().optional()),
  appBaseUrl: urlOrNull,
  scopes: z.string().min(1).max(500).default('openid profile email'),
  roleClaim: z.preprocess(emptyToNull, z.string().max(255).nullable().optional()),
  adminValues: csvField,
  defaultRole: z.enum(['admin', 'viewer']).default('admin'),
  allowedEmailDomains: csvField,
  allowedEmails: csvField,
  sessionTtlHours: z.coerce.number().int().min(1).max(720).default(12),
  allowInsecure: z.boolean().default(false),
});
export type AuthConfigUpdate = z.infer<typeof authConfigUpdateSchema>;

export const authConfigTestSchema = z.strictObject({
  issuerUrl: z.url(),
  clientId: z.string().min(1),
  // if omitted, the server uses the stored secret
  clientSecret: z.preprocess(emptyToNull, z.string().nullable().optional()),
  allowInsecure: z.boolean().default(false),
});
export type AuthConfigTest = z.infer<typeof authConfigTestSchema>;

export interface AuthConfigResponse {
  mode: 'disabled' | 'oidc';
  issuerUrl: string | null;
  clientId: string | null;
  appBaseUrl: string | null;
  scopes: string;
  roleClaim: string | null;
  adminValues: string | null;
  defaultRole: 'admin' | 'viewer';
  allowedEmailDomains: string | null;
  allowedEmails: string | null;
  sessionTtlHours: number;
  allowInsecure: boolean;
  clientSecretSet: boolean;
  signingSecretSet: boolean;
  redirectUri: string;
  discoveryStatus: 'connected' | 'unavailable' | 'disabled';
  lastDiscoveryError: string | null;
}

export const authConfigResponseSchema: z.ZodType<AuthConfigResponse> = z.object({
  mode: z.enum(['disabled', 'oidc']),
  issuerUrl: z.string().nullable(),
  clientId: z.string().nullable(),
  appBaseUrl: z.string().nullable(),
  scopes: z.string(),
  roleClaim: z.string().nullable(),
  adminValues: z.string().nullable(),
  defaultRole: z.enum(['admin', 'viewer']),
  allowedEmailDomains: z.string().nullable(),
  allowedEmails: z.string().nullable(),
  sessionTtlHours: z.number(),
  allowInsecure: z.boolean(),
  clientSecretSet: z.boolean(),
  signingSecretSet: z.boolean(),
  redirectUri: z.string(),
  discoveryStatus: z.enum(['connected', 'unavailable', 'disabled']),
  lastDiscoveryError: z.string().nullable(),
});
export const authConfigTestResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
});
export type AuthConfigTestResult = z.infer<typeof authConfigTestResultSchema>;

/** Response of POST /api/settings/auth/rotate-signing-secret. */
export const rotateSigningSecretResponseSchema = z.object({
  rotated: z.boolean(),
});
export type RotateSigningSecretResponse = z.infer<typeof rotateSigningSecretResponseSchema>;
