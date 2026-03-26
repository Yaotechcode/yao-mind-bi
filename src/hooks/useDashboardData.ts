/**
 * useDashboardData — Fetches typed dashboard data with automatic refetch on filter change.
 */

import { useQuery } from '@tanstack/react-query';
import {
  fetchDashboard,
  type DashboardId,
  type DashboardPayloadMap,
  type DashboardFilters,
} from '@/lib/api-client';

export function useDashboardData<D extends DashboardId>(
  dashboardId: D,
  filters?: DashboardFilters,
) {
  const query = useQuery<DashboardPayloadMap[D], Error>({
    queryKey: ['dashboard', dashboardId, filters],
    queryFn: () => fetchDashboard(dashboardId, filters),
    staleTime: 2 * 60 * 1000, // 2 minutes
  });

  return {
    data: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
