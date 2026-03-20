import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { toast } from 'sonner';

// =============================================================================
// Types
// =============================================================================

export interface HelpQueryMessage {
  id: string;
  query_id: string;
  author_id: string;
  body: string;
  is_internal: boolean;
  created_at: string;
  // Joined
  author?: { id: string; full_name: string | null } | null;
}

// =============================================================================
// useQueryMessages
// Fetches thread messages for a query, oldest first.
// Yao admins see is_internal messages too; regular users see only public ones.
// =============================================================================

export function useQueryMessages(queryId: string) {
  const { isYaoAdmin } = useAuth();

  return useQuery({
    queryKey: ['help-query-messages', queryId],
    queryFn: async () => {
      let query = supabase
        .from('help_query_messages')
        .select(`
          *,
          author:author_id(id, full_name)
        `)
        .eq('query_id', queryId)
        .order('created_at', { ascending: true });

      if (!isYaoAdmin) {
        query = query.eq('is_internal', false);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as HelpQueryMessage[];
    },
    enabled: !!queryId,
  });
}

// =============================================================================
// useAddMessage
// event_type is "admin_responded" when the author is a yao_admin,
// "customer_replied" otherwise.
// =============================================================================

export function useAddMessage() {
  const queryClient = useQueryClient();
  const { profile, isYaoAdmin } = useAuth();

  return useMutation({
    mutationFn: async (input: {
      query_id: string;
      body: string;
      is_internal?: boolean;
    }) => {
      if (!profile?.id) throw new Error('No profile found');

      const { data, error } = await supabase
        .from('help_query_messages')
        .insert({
          query_id: input.query_id,
          author_id: profile.id,
          body: input.body,
          is_internal: input.is_internal ?? false,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: async (data) => {
      queryClient.invalidateQueries({ queryKey: ['help-query-messages', data.query_id] });

      const event_type = isYaoAdmin ? 'admin_responded' : 'customer_replied';
      try {
        await supabase.functions.invoke('send-help-notification', {
          body: {
            event_type,
            query_id: data.query_id,
            message_id: data.id,
            author_id: data.author_id,
          },
        });
      } catch (err) {
        console.error('[useAddMessage] Notification error:', err);
      }
    },
    onError: (e: Error) => toast.error('Failed to send message: ' + e.message),
  });
}
