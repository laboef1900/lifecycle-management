import type { ItemResponse } from '@lcm/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api-client';

export interface CommonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clusterId: string;
}

export interface WithItemProps extends CommonDialogProps {
  item: ItemResponse;
}

export function useItemMutations(clusterId: string): { invalidate: () => void } {
  const queryClient = useQueryClient();
  return {
    invalidate: () => {
      void queryClient.invalidateQueries({ queryKey: ['items', clusterId] });
      void queryClient.invalidateQueries({ queryKey: ['forecast', clusterId] });
      void queryClient.invalidateQueries({ queryKey: ['categories'] });
      void queryClient.invalidateQueries({ queryKey: ['cluster', clusterId] });
      void queryClient.invalidateQueries({ queryKey: ['clusters'] });
    },
  };
}

export function parseDelta(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function useCategories(): string[] {
  const query = useQuery({
    queryKey: ['categories'],
    queryFn: api.settings.categories.list,
  });
  return (query.data ?? []).map((c) => c.name);
}
