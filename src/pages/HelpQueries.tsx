import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, HelpCircle } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { QueryCard } from '@/components/help/QueryCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useHelpQueries } from '@/hooks/useHelpQueries';
import { useQueryCategories } from '@/hooks/useQueryCategories';
import { useAllYaoAdmins } from '@/hooks/useAllYaoAdmins';
import { useProjects } from '@/hooks/useProjects';
import { useAuth } from '@/hooks/useAuth';
import type { HelpQueryStatus } from '@/hooks/useHelpQueries';

type StatusTab = 'all' | HelpQueryStatus;

export default function HelpQueriesPage() {
  const navigate = useNavigate();
  const { isYaoAdmin } = useAuth();

  // ── Filter state ──────────────────────────────────────────────────────────
  const [statusTab, setStatusTab]           = useState<StatusTab>('all');
  const [categoryId, setCategoryId]         = useState<string>('all');
  const [projectId, setProjectId]           = useState<string>('all');
  const [assignedTo, setAssignedTo]         = useState<string>('all');
  const [search, setSearch]                 = useState('');

  // ── Data ─────────────────────────────────────────────────────────────────
  const { data: queries = [], isLoading }   = useHelpQueries();       // no projectId → all queries
  const { data: categories = [] }           = useQueryCategories();
  const { data: projects = [] }             = useProjects();
  const { data: admins = [] }               = useAllYaoAdmins();

  // ── Derived counts for tab labels ─────────────────────────────────────────
  const countByStatus = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const q of queries) {
      counts[q.status] = (counts[q.status] ?? 0) + 1;
    }
    return counts;
  }, [queries]);

  // ── Client-side filtering ─────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return queries.filter(query => {
      if (statusTab !== 'all' && query.status !== statusTab) return false;
      if (categoryId !== 'all' && query.category_id !== categoryId) return false;
      if (projectId  !== 'all' && query.project_id  !== projectId)  return false;
      if (assignedTo !== 'all' && query.assigned_to !== assignedTo) return false;
      if (q && !query.title.toLowerCase().includes(q) &&
               !(query.description ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [queries, statusTab, categoryId, projectId, assignedTo, search]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <AppLayout>
      <div className="p-6 lg:p-8 max-w-5xl mx-auto">

        {/* Page header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Help &amp; Queries</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {queries.length} {queries.length === 1 ? 'query' : 'queries'} across all projects
            </p>
          </div>
          <Button onClick={() => navigate('/help/new')}>
            <Plus className="w-4 h-4" />
            New Query
          </Button>
        </div>

        {/* Status tabs */}
        <Tabs
          value={statusTab}
          onValueChange={v => setStatusTab(v as StatusTab)}
          className="mb-4"
        >
          <TabsList className="flex-wrap h-auto gap-1">
            <TabsTrigger value="all">
              All ({queries.length})
            </TabsTrigger>
            <TabsTrigger value="new">
              New ({countByStatus['new'] ?? 0})
            </TabsTrigger>
            <TabsTrigger value="in_review">
              In Review ({countByStatus['in_review'] ?? 0})
            </TabsTrigger>
            <TabsTrigger value="responded">
              Responded ({countByStatus['responded'] ?? 0})
            </TabsTrigger>
            <TabsTrigger value="closed">
              Closed ({countByStatus['closed'] ?? 0})
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Secondary filter bar */}
        <div className="flex flex-wrap gap-2 mb-6">
          {/* Search */}
          <div className="flex items-center gap-2 border border-border rounded-md px-3 py-2 bg-card flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <Input
              placeholder="Search queries…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="border-0 bg-transparent h-auto py-0 px-0 text-sm placeholder:text-muted-foreground focus-visible:ring-0 shadow-none"
            />
          </div>

          {/* Category filter */}
          {categories.length > 0 && (
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="All categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categories.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Project filter */}
          {projects.length > 0 && (
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="All projects" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All projects</SelectItem>
                {projects.map(p => (
                  <SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Assigned-to filter — admin only */}
          {isYaoAdmin && admins.length > 0 && (
            <Select value={assignedTo} onValueChange={setAssignedTo}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Any assignee" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any assignee</SelectItem>
                {admins.map(a => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.display_name ?? a.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* Query list */}
        {isLoading ? (
          <div className="space-y-3">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-[120px] rounded-lg" />
            ))}
          </div>
        ) : filtered.length > 0 ? (
          <div className="space-y-3">
            {filtered.map(query => (
              <QueryCard
                key={query.id}
                query={query}
                onClick={() => navigate(`/help/${query.id}`)}
              />
            ))}
          </div>
        ) : (
          <div className="text-center py-16 bg-standard-background rounded-lg border border-border">
            <HelpCircle className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <h3 className="text-base font-semibold text-foreground mb-1">
              {search || statusTab !== 'all' || categoryId !== 'all' || projectId !== 'all'
                ? 'No queries match your filters'
                : 'No queries yet'}
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              {search || statusTab !== 'all'
                ? 'Try adjusting your filters or search term'
                : 'Submit the first query to get started'}
            </p>
            {statusTab === 'all' && !search && (
              <Button size="sm" onClick={() => navigate('/help/new')}>
                <Plus className="w-4 h-4" />
                New Query
              </Button>
            )}
          </div>
        )}

      </div>
    </AppLayout>
  );
}
