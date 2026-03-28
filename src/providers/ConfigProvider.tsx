/**
 * ConfigProvider — Wraps the app to provide firm configuration via useConfig().
 * Only fetches config when authenticated (user is non-null).
 */

import { type ReactNode, useCallback } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { fetchConfig, updateConfig as apiUpdateConfig } from '@/lib/api-client';
import { ConfigContext, type ConfigContextType } from '@/hooks/useConfig';
import { useAuth } from '@/hooks/useAuth';
import type { FirmConfig } from '@/shared/types';

const CONFIG_KEY = ['firm-config'] as const;

export function ConfigProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { user, loading } = useAuth();

  const query = useQuery<FirmConfig, Error>({
    queryKey: CONFIG_KEY,
    queryFn: fetchConfig,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    // Only fetch when authenticated and auth has resolved
    enabled: !loading && !!user,
  });

  const mutation = useMutation<FirmConfig, Error, { path: string; value: unknown }>({
    mutationFn: ({ path, value }) => apiUpdateConfig(path, value),
    onSuccess: (data) => {
      queryClient.setQueryData(CONFIG_KEY, data);
    },
  });

  const updateConfig = useCallback(
    async (path: string, value: unknown) => {
      await mutation.mutateAsync({ path, value });
    },
    [mutation],
  );

  const resetToDefaults = useCallback(async () => {
    await mutation.mutateAsync({ path: '__reset__', value: null });
  }, [mutation]);

  const refetch = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: CONFIG_KEY });
  }, [queryClient]);

  const value: ConfigContextType = {
    config: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    updateConfig,
    resetToDefaults,
    refetch,
  };

  return (
    <ConfigContext.Provider value={value}>
      {children}
    </ConfigContext.Provider>
  );
}
