import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// =============================================================================
// Types
// =============================================================================

export interface HelpQueryCategory {
  id: string;
  name: string;
  color: string;
  description: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
}

// =============================================================================
// useQueryCategories
// Fetches active categories ordered by sort_order.
// Long staleTime: categories change rarely.
// =============================================================================

export function useQueryCategories() {
  return useQuery({
    queryKey: ['help-query-categories'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('help_query_categories')
        .select('*')
        .eq('is_active', true)
        .order('sort_order', { ascending: true });

      if (error) throw error;
      return (data ?? []) as HelpQueryCategory[];
    },
    staleTime: 10 * 60 * 1000, // 10 minutes — categories change rarely
  });
}
