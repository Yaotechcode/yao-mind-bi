import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { toast } from 'sonner';

// =============================================================================
// Types
// =============================================================================

export type HelpQueryStatus = 'new' | 'in_review' | 'responded' | 'closed';
export type HelpQueryPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface HelpQuery {
  id: string;
  project_id: string | null;
  submitted_by: string;
  assigned_to: string | null;
  category_id: string | null;
  status: HelpQueryStatus;
  priority: HelpQueryPriority;
  title: string;
  description: string | null;
  internal_notes: string | null;
  promote_to_kb: boolean;
  created_at: string;
  updated_at: string;
  // Joined
  category?: { id: string; name: string; color: string } | null;
  submitter?: { id: string; full_name: string | null } | null;
  assignee?: { id: string; full_name: string | null } | null;
  project?: { id: string; title: string } | null;
}

// =============================================================================
// Shared select fragment
// =============================================================================

const HELP_QUERY_SELECT = `
  *,
  category:category_id(id, name, color),
  submitter:submitted_by(id, full_name),
  assignee:assigned_to(id, full_name),
  project:project_id(id, title)
` as const;

// =============================================================================
// useHelpQueries
// If projectId provided → scoped view. Without it → admin view of all queries.
// =============================================================================

export function useHelpQueries(projectId?: string) {
  return useQuery({
    queryKey: ['help-queries', projectId ?? 'all'],
    queryFn: async () => {
      let query = supabase
        .from('help_queries')
        .select(HELP_QUERY_SELECT)
        .order('created_at', { ascending: false });

      if (projectId) {
        query = query.eq('project_id', projectId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as HelpQuery[];
    },
  });
}

// =============================================================================
// useHelpQuery — single record with same joins
// =============================================================================

export function useHelpQuery(id: string) {
  return useQuery({
    queryKey: ['help-queries', 'detail', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('help_queries')
        .select(HELP_QUERY_SELECT)
        .eq('id', id)
        .single();

      if (error) throw error;
      return data as HelpQuery;
    },
    enabled: !!id,
  });
}

// =============================================================================
// useCreateHelpQuery
// =============================================================================

export function useCreateHelpQuery() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();

  return useMutation({
    mutationFn: async (input: {
      title: string;
      description?: string;
      project_id?: string | null;
      category_id?: string | null;
      priority?: HelpQueryPriority;
    }) => {
      if (!profile?.id) throw new Error('No profile found');

      const { data, error } = await supabase
        .from('help_queries')
        .insert({
          submitted_by: profile.id,
          title: input.title,
          description: input.description ?? null,
          project_id: input.project_id ?? null,
          category_id: input.category_id ?? null,
          priority: input.priority ?? 'medium',
          status: 'new' as HelpQueryStatus,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: async (data) => {
      queryClient.invalidateQueries({ queryKey: ['help-queries'] });
      queryClient.invalidateQueries({ queryKey: ['help-query-stats'] });
      toast.success('Query submitted');

      try {
        await supabase.functions.invoke('send-help-notification', {
          body: {
            event_type: 'query_created',
            query_id: data.id,
            project_id: data.project_id,
            submitted_by: data.submitted_by,
          },
        });
      } catch (err) {
        // Non-blocking — query is already saved
        console.error('[useCreateHelpQuery] Notification error:', err);
      }
    },
    onError: (e: Error) => toast.error('Failed to submit query: ' + e.message),
  });
}

// =============================================================================
// useUpdateHelpQuery
// Pass _prev_status / _prev_assigned_to alongside updates so the hook can
// determine the correct notification event_type.
// =============================================================================

export function useUpdateHelpQuery() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      id: string;
      // Fields to update
      status?: HelpQueryStatus;
      category_id?: string | null;
      assigned_to?: string | null;
      priority?: HelpQueryPriority;
      internal_notes?: string;
      promote_to_kb?: boolean;
      // Previous values — used to detect what changed for notifications
      _prev_status?: HelpQueryStatus;
      _prev_assigned_to?: string | null;
    }) => {
      const { id, _prev_status, _prev_assigned_to, ...updates } = input;

      const { data, error } = await supabase
        .from('help_queries')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return { data, prevStatus: _prev_status, prevAssignedTo: _prev_assigned_to };
    },
    onSuccess: async ({ data, prevStatus, prevAssignedTo }) => {
      queryClient.invalidateQueries({ queryKey: ['help-queries'] });
      queryClient.invalidateQueries({ queryKey: ['help-queries', 'detail', data.id] });
      queryClient.invalidateQueries({ queryKey: ['help-query-stats'] });

      const statusChanged = prevStatus !== undefined && data.status !== prevStatus;
      const assigneeChanged = prevAssignedTo !== undefined && data.assigned_to !== prevAssignedTo;

      const event_type = statusChanged
        ? 'status_changed'
        : assigneeChanged
        ? 'query_assigned'
        : null;

      if (event_type) {
        try {
          await supabase.functions.invoke('send-help-notification', {
            body: {
              event_type,
              query_id: data.id,
              status: data.status,
              assigned_to: data.assigned_to,
            },
          });
        } catch (err) {
          console.error('[useUpdateHelpQuery] Notification error:', err);
        }
      }
    },
    onError: (e: Error) => toast.error('Failed to update query: ' + e.message),
  });
}
