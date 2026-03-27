/**
 * useCalculationStatus — Polls calculation status every 30s when stale.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchCalculationStatus,
  triggerCalculation,
  type CalculationStatus,
  type CalculationResult,
} from '@/lib/api-client';

const CALC_STATUS_KEY = ['calculation-status'] as const;

export function useCalculationStatus() {
  const queryClient = useQueryClient();

  const query = useQuery<CalculationStatus, Error>({
    queryKey: CALC_STATUS_KEY,
    queryFn: fetchCalculationStatus,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const mutation = useMutation<CalculationResult, Error>({
    mutationFn: () => triggerCalculation(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CALC_STATUS_KEY });
      // Also invalidate all dashboard data so they refetch with fresh calculations
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  return {
    status: query.data ?? null,
    lastCalculated: query.data?.lastCalculated ?? null,
    isStale: query.data?.isStale ?? false,
    isLoading: query.isLoading,
    triggerRecalculate: mutation.mutateAsync,
    isRecalculating: mutation.isPending,
  };
}
