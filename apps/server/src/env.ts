import { z } from 'zod';

/** docker-compose passes unset vars as empty strings; treat '' as absent. */
const emptyToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);
const optionalString = (): z.ZodType<string | undefined> =>
  z.preprocess(emptyToUndefined, z.string().optional());

/**
 * Treat '' as absent, then lowercase string values, so the closed-set enum vars
 * (AUTH_MODE, OIDC_DEFAULT_ROLE, OIDC_ALLOW_INSECURE) match case-insensitively —
 * `AUTH_MODE=OIDC` or `OIDC_ALLOW_INSECURE=TRUE` parse instead of failing. Only
 * these fixed-vocabulary vars are lowercased; free-form values are untouched.
 */
const emptyToLowerUndefined = (value: unknown): unknown => {
  const normalized = emptyToUndefined(value);
  return typeof normalized === 'string' ? normalized.toLowerCase() : normalized;
};

export const envSchema = z
  .object({
    DATABASE_URL: z.url(),
    PORT: z.coerce.number().int().positive().max(65535).default(8080),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    CORS_ORIGIN: optionalString(),
    TRUST_PROXY: z.string().default('loopback,uniquelocal'),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    AUTH_MODE: z.preprocess(emptyToLowerUndefined, z.enum(['disabled', 'oidc']).optional()),
    OIDC_ISSUER_URL: z.preprocess(emptyToUndefined, z.url().optional()),
    OIDC_CLIENT_ID: optionalString(),
    OIDC_CLIENT_SECRET: optionalString(),
    APP_BASE_URL: z.preprocess(emptyToUndefined, z.url().optional()),
    LOGIN_STATE_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
    SESSION_TTL_HOURS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().max(720).default(12),
    ),
    OIDC_SCOPES: z.preprocess(emptyToUndefined, z.string().default('openid profile email')),
    OIDC_ROLE_CLAIM: optionalString(),
    OIDC_ADMIN_VALUES: optionalString(),
    OIDC_DEFAULT_ROLE: z.preprocess(
      emptyToLowerUndefined,
      z.enum(['admin', 'viewer']).default('admin'),
    ),
    OIDC_ALLOWED_EMAIL_DOMAINS: optionalString(),
    OIDC_ALLOWED_EMAILS: optionalString(),
    OIDC_ALLOW_INSECURE: z.preprocess(
      emptyToLowerUndefined,
      z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
    ),
    CONFIG_ENCRYPTION_KEY: optionalString(),
    RECOVERY_DISABLE_AUTH: z.preprocess(
      emptyToUndefined,
      z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
    ),
  })
  .transform((env) => ({ ...env, AUTH_MODE: env.AUTH_MODE ?? ('disabled' as const) }));

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(issues: z.core.$ZodIssue[]) {
    super(`Invalid environment configuration:\n${formatIssues(issues)}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(result.error.issues);
  }
  return result.data;
}

function formatIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}
