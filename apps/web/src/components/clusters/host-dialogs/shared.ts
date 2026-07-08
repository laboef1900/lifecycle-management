import type { HostResponse, HostState } from '@lcm/shared';
import { useQueryClient } from '@tanstack/react-query';

export interface CommonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clusterId: string;
}

export interface WithHostProps extends CommonDialogProps {
  host: HostResponse;
}

export function useHostMutations(clusterId: string): {
  invalidate: () => void;
} {
  const queryClient = useQueryClient();
  return {
    invalidate: () => {
      void queryClient.invalidateQueries({ queryKey: ['hosts', clusterId] });
      void queryClient.invalidateQueries({ queryKey: ['forecast', clusterId] });
      void queryClient.invalidateQueries({ queryKey: ['cluster', clusterId] });
      void queryClient.invalidateQueries({ queryKey: ['clusters'] });
    },
  };
}

/**
 * Map Zod issues onto a dialog's field-error slots using a path-root → field
 * table. Issues whose path root has no entry are left unmapped — callers with
 * a fallback (Create/Edit) toast the first issue message when nothing mapped.
 */
export function mapIssuesToFieldErrors<K extends string>(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
  pathToField: Readonly<Record<string, K>>,
): Partial<Record<K, string>> {
  const fieldErrors: Partial<Record<K, string>> = {};
  for (const issue of issues) {
    const root = issue.path[0];
    if (typeof root !== 'string') continue;
    const field = pathToField[root];
    if (field !== undefined) fieldErrors[field] = issue.message;
  }
  return fieldErrors;
}

/**
 * Trim a string field and return it for wire submission, or `null` to clear it
 * if blank. Used by both CreateHostDialog and EditHostDialog when serializing
 * the Asset section's optional text fields.
 */
export function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Same helper for date inputs — empty string means "no date" and serializes to
 * null on the wire (matches dateOnly.nullable() in shared schemas).
 */
export function optionalDate(value: string): string | null {
  return value.length > 0 ? value : null;
}

/**
 * Allowed forward transitions per state. Mirrors the server-side guard so the
 * UI never offers a target the API would reject. `disposed` is terminal — when
 * a host is disposed the dialog renders an info message and a Close button.
 */
export const ALLOWED_TRANSITIONS: Record<HostState, HostState[]> = {
  ordered: ['racked'],
  racked: ['in_service'],
  in_service: ['degraded', 'decommissioned'],
  degraded: ['in_service', 'decommissioned'],
  decommissioned: ['disposed'],
  disposed: [],
};

export const STATE_LABELS: Record<HostState, string> = {
  ordered: 'Ordered',
  racked: 'Racked',
  in_service: 'In service',
  degraded: 'Degraded',
  decommissioned: 'Decommissioned',
  disposed: 'Disposed',
};
