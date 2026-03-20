import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { HelpQueryStatus } from './useHelpQueries';

// =============================================================================
// Types
// =============================================================================

export interface QueryStats {
  new: number;
  in_review: number;
  responded: number;
  closed: number;
  total: number;
}

// =============================================================================
// useQueryStats
// Returns counts grouped by status.
// If projectId provided, scoped to that project; otherwise global.
// =============================================================================

export function useQueryStats(projectId?: string) {
  return useQuery({
    queryKey: ['help-query-stats', projectId ?? 'all'],
    queryFn: async () => {
      let query = supabase
        .from('help_queries')
        .select('status');

      if (projectId) {
        query = query.eq('project_id', projectId);
      }

      const { data, error } = await query;
      if (error) throw error;

      const counts: QueryStats = { new: 0, in_review: 0, responded: 0, closed: 0, total: 0 };

      for (const row of data ?? []) {
        const s = row.status as HelpQueryStatus;
        if (s in counts) (counts[s] as number)++;
        counts.total++;
      }

      return counts;
    },
  });
}
