/**
 * DataQualityBanner — shows critical data quality issues.
 * Dismissible per session.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface DataQualityBannerProps {
  issueCount: number;
  criticalCount: number;
}

export function DataQualityBanner({ issueCount, criticalCount }: DataQualityBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || criticalCount === 0) return null;

  return (
    <div className="flex items-center justify-between px-4 py-2.5 bg-destructive/5 border-b border-destructive/20">
      <Link to="/data" className="flex items-center gap-2 hover:underline">
        <AlertTriangle className="h-4 w-4 text-destructive" />
        <span className="text-xs font-medium text-foreground">
          {criticalCount} critical data issue{criticalCount !== 1 ? 's' : ''} detected — click to review
        </span>
      </Link>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
