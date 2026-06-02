import type { CategoryResponse } from '@lcm/shared';
import { type PrismaClient } from '@prisma/client';

import { ConflictError, NotFoundError } from './errors.js';

export class CategoriesService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(tenantId: string): Promise<CategoryResponse[]> {
    const rows = await this.prisma.category.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => ({ id: r.id, name: r.name }));
  }

  /** Idempotent: returns the existing row if the name already exists. */
  async create(tenantId: string, name: string): Promise<CategoryResponse> {
    const row = await this.prisma.category.upsert({
      where: { tenantId_name: { tenantId, name } },
      create: { tenantId, name },
      update: {},
    });
    return { id: row.id, name: row.name };
  }

  /** Used by ItemsService on save to keep the managed list in sync. */
  async ensure(tenantId: string, name: string): Promise<void> {
    await this.prisma.category.upsert({
      where: { tenantId_name: { tenantId, name } },
      create: { tenantId, name },
      update: {},
    });
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const category = await this.prisma.category.findFirst({ where: { id, tenantId } });
    if (!category) throw new NotFoundError('Category', id);
    const usageCount = await this.prisma.item.count({
      where: { tenantId, category: category.name },
    });
    if (usageCount > 0) {
      throw new ConflictError(
        'CATEGORY_IN_USE',
        `Category "${category.name}" is used by ${usageCount} item(s). Reassign them first.`,
      );
    }
    await this.prisma.category.delete({ where: { id } });
  }
}
