/**
 * useConfig — Fetches and caches firm configuration.
 * Must be used within ConfigProvider.
 */

import { createContext, useContext } from 'react';
import type { FirmConfig } from '@/shared/types';

export interface ConfigContextType {
  config: FirmConfig | null;
  isLoading: boolean;
  error: Error | null;
  updateConfig: (path: string, value: unknown) => Promise<void>;
  resetToDefaults: () => Promise<void>;
  refetch: () => void;
}

export const ConfigContext = createContext<ConfigContextType | undefined>(undefined);

export function useConfig(): ConfigContextType {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error('useConfig must be used within a ConfigProvider');
  return ctx;
}
