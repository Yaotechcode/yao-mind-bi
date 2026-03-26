/**
 * FormulaLibrary — Browse, search, and manage formulas and snippets.
 */

import { useState, useMemo } from 'react';
import {
  Search, ChevronDown, ChevronRight, Copy, Archive, ArchiveRestore,
  Sparkles, Zap, Code2, Beaker,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useConfig } from '@/hooks/useConfig';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/common/EmptyState';
import { AlertCard } from '@/components/common/AlertCard';
import type { FormulaDefinition, SnippetDefinition } from '@/shared/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FormulaTab = 'all' | 'built_in' | 'custom' | 'snippet';

// ---------------------------------------------------------------------------
// Formula Card
// ---------------------------------------------------------------------------

function FormulaCard({ formula }: { formula: FormulaDefinition }) {
  const [expanded, setExpanded] = useState(false);

  const categoryIcon = formula.type === 'built_in'
    ? <Zap className="h-3.5 w-3.5 text-primary" />
    : <Code2 className="h-3.5 w-3.5 text-purple" />;

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <button
        className="w-full flex items-start gap-3 p-4 text-left hover:bg-standard-background transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="mt-0.5">
          {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {categoryIcon}
            <span className="text-[13px] font-semibold text-foreground">{formula.label}</span>
            <span className="text-[10px] text-muted-foreground font-mono bg-standard-background px-1.5 py-0.5 rounded">{formula.id}</span>
            <span className={cn(
              'text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded-sm',
              formula.type === 'built_in' ? 'bg-accent text-primary' : 'bg-muted text-purple',
            )}>
              {formula.type.replace('_', '-')}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">{formula.description}</p>
          <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground">
            <span>Entity: {formula.appliesTo.join(', ')}</span>
            <span>Output: {formula.outputType}</span>
            <span>Variants: {formula.variants.length}</span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border px-4 py-3 bg-standard-background">
          <div className="space-y-3">
            {/* Variants */}
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground uppercase mb-1.5">Variants</p>
              {formula.variants.map((v) => (
                <div key={v.id} className="flex items-start gap-2 py-1">
                  <span className="text-xs font-mono text-foreground">{v.id}</span>
                  <span className="text-xs text-muted-foreground">— {v.label}</span>
                </div>
              ))}
            </div>

            {/* Dependencies */}
            {formula.variants.some((v) => v.dependencies.length > 0) && (
              <div>
                <p className="text-[11px] font-semibold text-muted-foreground uppercase mb-1">Dependencies</p>
                <div className="flex flex-wrap gap-1">
                  {[...new Set(formula.variants.flatMap((v) => v.dependencies))].map((dep) => (
                    <span key={dep} className="text-[10px] bg-muted text-foreground px-1.5 py-0.5 rounded font-mono">{dep}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2 pt-2 border-t border-border">
              <Button variant="outline" size="sm" disabled>
                <Sparkles className="h-3.5 w-3.5 mr-1" /> Edit
                <span className="ml-1 text-[9px] text-muted-foreground">(Coming soon)</span>
              </Button>
              <Button variant="ghost" size="sm" onClick={() => toast.success('Formula duplicated')}>
                <Copy className="h-3.5 w-3.5 mr-1" /> Duplicate
              </Button>
              <Button variant="ghost" size="sm" onClick={() => toast.success('Formula archived')}>
                <Archive className="h-3.5 w-3.5 mr-1" /> Archive
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Snippet Card
// ---------------------------------------------------------------------------

function SnippetCard({ snippet }: { snippet: SnippetDefinition }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <button
        className="w-full flex items-start gap-3 p-4 text-left hover:bg-standard-background transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="mt-0.5">
          {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Beaker className="h-3.5 w-3.5 text-teal" />
            <span className="text-[13px] font-semibold text-foreground">{snippet.label}</span>
            <span className="text-[10px] text-muted-foreground font-mono bg-standard-background px-1.5 py-0.5 rounded">{snippet.id}</span>
            <span className="text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded-sm bg-accent text-teal">snippet</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">{snippet.description}</p>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border px-4 py-3 bg-standard-background">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase mb-1">Expression</p>
          <pre className="text-xs font-mono text-foreground bg-card border border-border rounded p-2 overflow-x-auto">
            {snippet.expression}
          </pre>
          {snippet.dependencies.length > 0 && (
            <div className="mt-2">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase mb-1">Dependencies</p>
              <div className="flex flex-wrap gap-1">
                {snippet.dependencies.map((dep) => (
                  <span key={dep} className="text-[10px] bg-muted text-foreground px-1.5 py-0.5 rounded font-mono">{dep}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function FormulaLibrary() {
  const { config } = useConfig();
  const [tab, setTab] = useState<FormulaTab>('all');
  const [search, setSearch] = useState('');

  const formulas = config?.formulas ?? [];
  const snippets = config?.snippets ?? [];

  const filteredFormulas = useMemo(() => {
    let list = formulas;
    if (tab === 'built_in') list = list.filter((f) => f.type === 'built_in');
    if (tab === 'custom') list = list.filter((f) => f.type === 'custom');
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (f) =>
          f.label.toLowerCase().includes(q) ||
          f.id.toLowerCase().includes(q) ||
          f.description.toLowerCase().includes(q),
      );
    }
    return list;
  }, [formulas, tab, search]);

  const filteredSnippets = useMemo(() => {
    if (tab !== 'all' && tab !== 'snippet') return [];
    if (!search) return snippets;
    const q = search.toLowerCase();
    return snippets.filter(
      (s) =>
        s.label.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [snippets, tab, search]);

  const tabs: { key: FormulaTab; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: formulas.length + snippets.length },
    { key: 'built_in', label: 'Built-in', count: formulas.filter((f) => f.type === 'built_in').length },
    { key: 'custom', label: 'Custom', count: formulas.filter((f) => f.type === 'custom').length },
    { key: 'snippet', label: 'Snippets', count: snippets.length },
  ];

  return (
    <div className="space-y-4 max-w-3xl">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex rounded-md border border-border bg-muted p-0.5">
          {tabs.map((t) => (
            <button
              key={t.key}
              className={cn(
                'px-3 py-1.5 text-[11px] font-semibold rounded-sm transition-all',
                tab === t.key
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => setTab(t.key)}
            >
              {t.label} ({t.count})
            </button>
          ))}
        </div>

        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-icon-main" />
          <input
            type="text"
            placeholder="Search formulas…"
            className="h-8 w-full rounded-input border border-input bg-background pl-8 pr-3 text-xs text-foreground focus:ring-2 focus:ring-ring"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <Button variant="outline" size="sm" disabled>
          <Sparkles className="h-3.5 w-3.5 mr-1" />
          Create New Formula
          <span className="ml-1 text-[9px] text-muted-foreground">(Coming soon)</span>
        </Button>
      </div>

      {/* Formula list */}
      {(tab === 'all' || tab === 'built_in' || tab === 'custom') && filteredFormulas.length > 0 && (
        <div className="space-y-2">
          {filteredFormulas.map((f) => (
            <FormulaCard key={f.id} formula={f} />
          ))}
        </div>
      )}

      {/* Snippet list */}
      {(tab === 'all' || tab === 'snippet') && filteredSnippets.length > 0 && (
        <div className="space-y-2">
          {filteredSnippets.map((s) => (
            <SnippetCard key={s.id} snippet={s} />
          ))}
        </div>
      )}

      {/* Empty */}
      {filteredFormulas.length === 0 && filteredSnippets.length === 0 && (
        <EmptyState
          title="No formulas found"
          message={search ? 'Try a different search term.' : 'Upload data and configure your firm to see available formulas.'}
        />
      )}
    </div>
  );
}
