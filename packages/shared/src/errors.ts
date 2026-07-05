import { z } from 'zod';

/**
 * Wire contract for every API error response, produced by the server's
 * error-handler plugin and consumed by the web api-client. Declared once here
 * (next to the `ServiceErrorCode` registry) so both sides share a single
 * source of truth. `code` is a plain string, not `ServiceErrorCode`, because
 * the envelope also carries handler-level codes (VALIDATION_ERROR,
 * INTERNAL_ERROR, CLIENT_ERROR, NOT_FOUND) that are not service errors.
 */
export const apiErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

/** Type guard: true when `value` structurally matches the API error envelope. */
export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return apiErrorBodySchema.safeParse(value).success;
}

/**
 * Central registry of service-level error codes returned in API error bodies.
 * Handler-level codes (VALIDATION_ERROR, INTERNAL_ERROR, CLIENT_ERROR) are not
 * service errors and live in the server's error handler.
 * Kept as a runtime array (not a pure type union) so later work can build
 * z.enum validators and client-side code guards from it.
 */
export const SERVICE_ERROR_CODES = [
  'ALLOCATION_DUPLICATE_DATE',
  'APP_BASE_URL_REQUIRED',
  'AUTH_RELOAD_FAILED',
  'CAPACITY_DUPLICATE_DATE',
  'CATEGORY_IN_USE',
  'CLUSTER_NAME_TAKEN',
  'CROSS_CLUSTER_REPLACEMENT',
  'EFFECTIVE_BEFORE_COMMISSION',
  'EFFECTIVE_BEFORE_START',
  'EFFECTIVE_NOT_MONOTONIC',
  'EFFECTIVE_THRESHOLDS_INVALID',
  'ENCRYPTION_KEY_REQUIRED',
  'FORBIDDEN',
  'HOST_NOT_FOUND',
  'INVALID_COMMISSIONED_AT',
  'INVALID_EFFECTIVE_DATE',
  'INVALID_RANGE',
  'INVALID_TRANSITION',
  'METRIC_NOT_TRACKED',
  'NOT_AN_APPLICATION',
  'NOT_FOUND',
  'RANGE_TOO_LARGE',
  'REPLACEMENT_DUPLICATE',
  'TEST_REQUIRED',
  'UNAUTHENTICATED',
  'UNKNOWN_METRIC',
  'WRITE_CONFLICT',
  'WRONG_KIND_FIELD',
] as const;

export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];
