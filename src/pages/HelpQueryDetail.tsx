import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, ChevronRight, AlertCircle, Loader2 } from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import { AppLayout } from '@/components/layout/AppLayout';
import { QueryThread } from '@/components/help/QueryThread';
import { AdminSidebar } from '@/components/help/AdminSidebar';
import { QueryStatusBadge } from '@/components/help/QueryStatusBadge';
import { PriorityBadge } from '@/components/help/PriorityBadge';
import { CategoryPill } from '@/components/help/CategoryPill';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useHelpQuery } from '@/hooks/useHelpQueries';
import { useAuth } from '@/hooks/useAuth';

export default function HelpQueryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isYaoAdmin } = useAuth();

  const { data: query, isLoading, isError, refetch } = useHelpQuery(id ?? '');

  // ── Loading state ─────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <AppLayout>
        <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-4">
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-4 w-48" />
          <div className="flex gap-6 mt-8">
            <Skeleton className="flex-1 h-[500px] rounded-lg" />
            {isYaoAdmin && <Skeleton className="w-72 h-[500px] rounded-lg" />}
          </div>
        </div>
      </AppLayout>
    );
  }

  // ── Error / not found state ───────────────────────────────────────────────
  if (isError || !query) {
    return (
      <AppLayout>
        <div className="p-6 lg:p-8 max-w-6xl mx-auto">
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <AlertCircle className="w-10 h-10 text-destructive mb-3" />
            <h2 className="text-lg font-semibold text-foreground mb-1">Query not found</h2>
            <p className="text-sm text-muted-foreground mb-6">
              This query may have been removed or you may not have access.
            </p>
            <Button variant="outline" size="sm" onClick={() => navigate('/help')}>
              <ArrowLeft className="w-4 h-4" />
              Back to Help &amp; Queries
            </Button>
          </div>
        </div>
      </AppLayout>
    );
  }

  const createdAgo = formatDistanceToNow(new Date(query.created_at), { addSuffix: true });
  const createdFull = format(new Date(query.created_at), 'dd MMM yyyy, HH:mm');

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <AppLayout>
      <div className="p-6 lg:p-8 max-w-6xl mx-auto">

        {/* Breadcrumb */}
        <nav className="flex items-center gap-1.5 text-[12px] text-muted-foreground mb-5 flex-wrap">
          <Link
            to="/help"
            className="hover:text-foreground transition-colors"
          >
            Help &amp; Queries
          </Link>
          {query.project && (
            <>
              <ChevronRight className="w-3 h-3 flex-shrink-0" />
              <span className="text-muted-foreground">{query.project.title}</span>
            </>
          )}
          <ChevronRight className="w-3 h-3 flex-shrink-0" />
          <span className="text-foreground font-medium truncate max-w-[240px]">
            {query.title}
          </span>
        </nav>

        {/* Two-column layout: left=main, right=admin sidebar */}
        <div className="flex gap-6 items-start">

          {/* ── Left column: query content + thread ── */}
          <div className="flex-1 min-w-0 space-y-6">

            {/* Query header */}
            <div className="bg-card border border-border rounded-lg p-6 shadow-card">
              {/* Badges row */}
              <div className="flex items-center gap-2 flex-wrap mb-3">
                <QueryStatusBadge status={query.status} />
                <PriorityBadge priority={query.priority} />
                {query.category && <CategoryPill category={query.category} />}
              </div>

              {/* Title */}
              <h1 className="text-xl font-bold text-foreground leading-snug mb-1">
                {query.title}
              </h1>

              {/* Meta: submitter, project, time */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground mt-2 mb-4">
                <span>
                  By{' '}
                  <span className="font-medium text-foreground">
                    {query.submitter?.full_name ?? 'Unknown'}
                  </span>
                </span>
                {query.project && (
                  <>
                    <span className="text-border">·</span>
                    <span>{query.project.title}</span>
                  </>
                )}
                <span className="text-border">·</span>
                <time
                  dateTime={query.created_at}
                  title={createdFull}
                  className="tabular-nums"
                >
                  {createdAgo}
                </time>
                {query.assignee && (
                  <>
                    <span className="text-border">·</span>
                    <span>
                      Assigned to{' '}
                      <span className="font-medium text-foreground">
                        {query.assignee.full_name}
                      </span>
                    </span>
                  </>
                )}
              </div>

              {/* Body */}
              {query.description && (
                <div className="prose prose-sm max-w-none text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap border-t border-border pt-4">
                  {query.description}
                </div>
              )}
            </div>

            {/* Thread */}
            <div className="bg-card border border-border rounded-lg shadow-card overflow-hidden">
              <div className="px-5 py-3 border-b border-border">
                <h2 className="text-sm font-semibold text-foreground">Thread</h2>
              </div>
              <QueryThread
                queryId={query.id}
                className="min-h-[300px] max-h-[600px]"
              />
            </div>

          </div>

          {/* ── Right column: AdminSidebar (admin only) ── */}
          {isYaoAdmin && (
            <div className="w-72 flex-shrink-0 hidden lg:block">
              <div className="bg-card border border-border rounded-lg shadow-card p-5 sticky top-8">
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-4">
                  Query Settings
                </h2>
                <AdminSidebar
                  query={query}
                  onUpdate={() => refetch()}
                />
              </div>
            </div>
          )}

        </div>
      </div>
    </AppLayout>
  );
}
