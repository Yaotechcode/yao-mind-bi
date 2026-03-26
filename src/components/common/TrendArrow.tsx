/**
 * TrendArrow — Arrow coloured based on whether the trend is good or bad.
 */

import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface TrendArrowProps {
  direction: 'up' | 'down' | 'flat';
  value: string;
  label?: string;
  /** Which direction is considered good. Default 'up'. */
  goodDirection?: 'up' | 'down';
}

export function TrendArrow({ direction, value, label, goodDirection = 'up' }: TrendArrowProps) {
  const isGood =
    direction === 'flat'
      ? null
      : direction === goodDirection;

  const colorClass =
    isGood === null
      ? 'text-muted-foreground'
      : isGood
        ? 'text-success'
        : 'text-error';

  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium', colorClass)}>
      {direction === 'up' && <TrendingUp className="h-3.5 w-3.5" />}
      {direction === 'down' && <TrendingDown className="h-3.5 w-3.5" />}
      {direction === 'flat' && <Minus className="h-3.5 w-3.5" />}
      <span>{value}</span>
      {label && <span className="text-muted-foreground font-normal">{label}</span>}
    </span>
  );
}
