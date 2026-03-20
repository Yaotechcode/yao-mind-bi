import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type QueryStatus = "new" | "in_review" | "responded" | "closed";

interface QueryStatusBadgeProps {
  status: QueryStatus;
  className?: string;
}

const STATUS_CONFIG: Record<
  QueryStatus,
  { label: string; className: string }
> = {
  new: {
    label: "New",
    // blue — primary token
    className: "border-transparent bg-primary/10 text-primary",
  },
  in_review: {
    label: "In Review",
    // amber — warning token
    className: "border-transparent bg-warning/10 text-warning",
  },
  responded: {
    label: "Responded",
    // teal — success token
    className: "border-transparent bg-success/10 text-success",
  },
  closed: {
    label: "Closed",
    // gray — muted token
    className: "border-transparent bg-muted text-muted-foreground",
  },
};

export function QueryStatusBadge({ status, className }: QueryStatusBadgeProps) {
  const { label, className: statusClass } = STATUS_CONFIG[status];
  return (
    <Badge className={cn(statusClass, className)}>
      {label}
    </Badge>
  );
}
