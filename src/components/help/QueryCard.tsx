import { formatDistanceToNow } from "date-fns";
import { MessageSquare } from "lucide-react";
import { QueryStatusBadge } from "./QueryStatusBadge";
import { CategoryPill } from "./CategoryPill";
import { PriorityBadge } from "./PriorityBadge";
import { cn } from "@/lib/utils";
import type { HelpQuery } from "@/hooks/useHelpQueries";

interface QueryCardProps {
  query: HelpQuery;
  messageCount?: number;
  onClick: () => void;
  className?: string;
}

export function QueryCard({ query, messageCount = 0, onClick, className }: QueryCardProps) {
  const createdAgo = formatDistanceToNow(new Date(query.created_at), { addSuffix: true });

  return (
    <button
      onClick={onClick}
      className={cn(
        // Card shell — matches project card pattern
        "w-full text-left bg-card border border-border rounded-lg p-4",
        "shadow-card hover:shadow-md hover:border-primary/30",
        "transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className,
      )}
    >
      {/* Row 1: badges */}
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <QueryStatusBadge status={query.status} />
        <PriorityBadge priority={query.priority} />
        {query.category && <CategoryPill category={query.category} />}
      </div>

      {/* Row 2: title */}
      <p className="text-sm font-semibold text-foreground leading-snug line-clamp-2 mb-1">
        {query.title}
      </p>

      {/* Row 3: project name */}
      {query.project && (
        <p className="text-[11px] text-muted-foreground mb-2">
          {query.project.title}
        </p>
      )}

      {/* Row 4: meta row */}
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-border">
        {/* Submitter + timestamp */}
        <div className="flex items-center gap-1.5 min-w-0">
          {/* Initials avatar */}
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-[3px] bg-muted text-menu-foreground text-[10px] font-medium shrink-0">
            {getInitials(query.submitter?.full_name)}
          </span>
          <span className="text-[11px] text-muted-foreground truncate">
            {query.submitter?.full_name ?? "Unknown"}
          </span>
          <span className="text-[11px] text-muted-foreground/60 shrink-0">· {createdAgo}</span>
        </div>

        {/* Message count */}
        {messageCount > 0 && (
          <div className="flex items-center gap-1 text-muted-foreground shrink-0 ml-2">
            <MessageSquare className="h-3 w-3" />
            <span className="text-[11px]">{messageCount}</span>
          </div>
        )}
      </div>
    </button>
  );
}

function getInitials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
