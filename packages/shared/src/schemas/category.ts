import { z } from 'zod';

import { cuid } from './common.js';

export const categoryCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
});

export const categoryIdParamsSchema = z.object({ id: cuid });

export type CategoryCreateInput = z.infer<typeof categoryCreateInputSchema>;

export interface CategoryResponse {
  id: string;
  name: string;
}
