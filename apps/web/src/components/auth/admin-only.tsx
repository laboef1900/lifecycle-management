import { useIsAdmin } from '@/lib/auth';

interface AdminOnlyProps {
  children: React.ReactNode;
  /** Rendered for non-admins instead of the children (default: nothing). */
  fallback?: React.ReactNode;
}

/**
 * Renders `children` only for admins; viewers get `fallback` (nothing by
 * default). A UX affordance for hiding mutation controls — the server still
 * enforces the 403, so this never needs to be exhaustive to be safe.
 */
export function AdminOnly({ children, fallback = null }: AdminOnlyProps): React.JSX.Element {
  const isAdmin = useIsAdmin();
  return <>{isAdmin ? children : fallback}</>;
}
