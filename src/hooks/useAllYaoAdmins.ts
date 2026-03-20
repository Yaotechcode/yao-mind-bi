import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface YaoAdmin {
  id: string;
  email: string;
  display_name: string | null;
}

/**
 * Fetches all users with role 'yao_admin'.
 * Used to populate the "Assigned to" select in AdminSidebar.
 * Only ever called inside AdminSidebar (which itself guards on isYaoAdmin),
 * so RLS will naturally scope results to users visible to the caller.
 */
export function useAllYaoAdmins() {
  return useQuery({
    queryKey: ['yao-admins'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('users')
        .select('id, email, display_name')
        .eq('role', 'yao_admin')
        .order('display_name', { ascending: true });

      if (error) throw error;
      return (data ?? []) as YaoAdmin[];
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}
