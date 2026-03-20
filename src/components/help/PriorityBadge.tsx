import { cn } from "@/lib/utils";

export type QueryPriority = "low" | "medium" | "high" | "urgent";

interface PriorityBadgeProps {
  priority: QueryPriority;
  className?: string;
}

const PRIORITY_CONFIG: Record<
  QueryPriority,
  { label: string; className: string }
> = {
  urgent: {
    label: "Urgent",
    // red — destructive/error token
    className: "bg-destructive/10 text-destructive",
  },
  high: {
    label: "High",
    // amber — warning token
    className: "bg-warning/10 text-warning",
  },
  medium: {
    label: "Normal",
    // default — secondary token
    className: "bg-secondary text-secondary-foreground",
  },
  low: {
    label: "Low",
    // muted token
    className: "bg-muted text-muted-foreground",
  },
};

export function PriorityBadge({ priority, className }: PriorityBadgeProps) {
  const { label, className: priorityClass } = PRIORITY_CONFIG[priority];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[3px] px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide leading-none",
        priorityClass,
        className,
      )}
    >
      {label}
    </span>
  );
}
