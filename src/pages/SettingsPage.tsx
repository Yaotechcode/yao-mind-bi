/**
 * SettingsPage — Tab layout routing to Standard, Enhanced, and Formulas sub-pages.
 */

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useConfig } from '@/hooks/useConfig';
import { DashboardSkeleton } from '@/components/common/DashboardSkeleton';
import { AlertCard } from '@/components/common/AlertCard';
import { StandardSettings } from '@/components/settings/StandardSettings';
import { EnhancedSettings } from '@/components/settings/EnhancedSettings';
import { FormulaLibrary } from '@/components/settings/FormulaLibrary';

const TABS = [
  { key: 'standard', label: 'Standard' },
  { key: 'enhanced', label: 'Enhanced' },
  { key: 'formulas', label: 'Formulas' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export default function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const activeTab = (params.get('tab') as TabKey) || 'standard';
  const { config, isLoading, error, refetch } = useConfig();

  const setTab = (tab: TabKey) => setParams({ tab });

  if (isLoading) return <DashboardSkeleton />;

  if (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-foreground">Settings</h1>
        <AlertCard
          type="error"
          title="Failed to load settings"
          message={error.message}
          action={{ label: 'Retry', onClick: refetch }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Settings</h1>

      {/* Tabs */}
      <div className="border-b border-border">
        <nav className="flex gap-6">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              className={cn(
                'pb-2.5 text-[15px] font-medium transition-colors border-b-2',
                activeTab === tab.key
                  ? 'text-foreground border-primary'
                  : 'text-muted-foreground border-transparent hover:text-foreground',
              )}
              onClick={() => setTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Content */}
      {activeTab === 'standard' && <StandardSettings />}
      {activeTab === 'enhanced' && <EnhancedSettings />}
      {activeTab === 'formulas' && <FormulaLibrary />}
    </div>
  );
}
