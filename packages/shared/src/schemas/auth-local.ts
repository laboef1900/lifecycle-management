import { z } from 'zod';

import { cuid } from './common.js';

export const localUserIdParamsSchema = z.object({ id: cuid });
export type LocalUserIdParams = z.infer<typeof localUserIdParamsSchema>;

export const localUsernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, 'Username may contain only letters, numbers, and . _ -');

/** Server-enforced password policy — length beats composition rules (OWASP). */
export const passwordSchema = z.string().min(12).max(200);

const roleSchema = z.enum(['ADMIN', 'VIEWER']);

export const localLoginSchema = z.strictObject({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});
export type LocalLogin = z.infer<typeof localLoginSchema>;

export const createLocalUserSchema = z.strictObject({
  username: localUsernameSchema,
  password: passwordSchema,
  role: roleSchema.default('ADMIN'),
});
export type CreateLocalUser = z.infer<typeof createLocalUserSchema>;

export const updateLocalUserSchema = z.strictObject({
  disabled: z.boolean().optional(),
  role: roleSchema.optional(),
});
export type UpdateLocalUser = z.infer<typeof updateLocalUserSchema>;

export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});
export type ChangePassword = z.infer<typeof changePasswordSchema>;

export const resetPasswordSchema = z.strictObject({ newPassword: passwordSchema });
export type ResetPassword = z.infer<typeof resetPasswordSchema>;

export const localUserSummarySchema = z.object({
  id: z.string(),
  username: z.string(),
  role: roleSchema,
  disabled: z.boolean(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});
export type LocalUserSummary = z.infer<typeof localUserSummarySchema>;
