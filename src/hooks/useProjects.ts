import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface Project {
  id: string;
  title: string;
  firm_id: string | null;
}

/**
 * Fetches all projects — used to populate filter dropdowns.
 * If the projects table doesn't exist yet the query will fail gracefully
 * and the dropdown will render empty.
 */
export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('projects')
        .select('id, title, firm_id')
        .order('title', { ascending: true });

      if (error) throw error;
      return (data ?? []) as Project[];
    },
    // Don't hard-fail the page if the table isn't ready yet
    retry: false,
  });
}
