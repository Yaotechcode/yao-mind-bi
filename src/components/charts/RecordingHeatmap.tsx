/**
 * RecordingHeatmap — Compact grid showing recording consistency.
 * Rows = weekdays (Mon–Fri), columns = weeks.
 */

import { cn } from '@/lib/utils';

export interface RecordingHeatmapDatum {
  date: string;   // 'YYYY-MM-DD'
  hasEntries: boolean;
}

export interface RecordingHeatmapProps {
  data: RecordingHeatmapDatum[];
  label?: string;
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

export function RecordingHeatmap({ data, label }: RecordingHeatmapProps) {
  // Group by week and day of week (Mon=0 .. Fri=4)
  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date));

  // Build week columns
  const weeks: Map<string, Map<number, boolean>> = new Map();

  sorted.forEach((d) => {
    const dt = new Date(d.date);
    const dayOfWeek = dt.getDay(); // 0=Sun .. 6=Sat
    if (dayOfWeek === 0 || dayOfWeek === 6) return; // skip weekends
    const dayIdx = dayOfWeek - 1; // Mon=0 .. Fri=4

    // Week key: ISO week start (Monday)
    const monday = new Date(dt);
    monday.setDate(dt.getDate() - dayIdx);
    const weekKey = monday.toISOString().slice(0, 10);

    if (!weeks.has(weekKey)) weeks.set(weekKey, new Map());
    weeks.get(weekKey)!.set(dayIdx, d.hasEntries);
  });

  const weekKeys = Array.from(weeks.keys()).sort();

  return (
    <div>
      {label && (
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
          {label}
        </p>
      )}
      <div className="flex gap-0.5">
        {/* Day labels */}
        <div className="flex flex-col gap-0.5 mr-1">
          {DAY_LABELS.map((d) => (
            <div key={d} className="w-5 h-3 flex items-center">
              <span className="text-[8px] text-muted-foreground">{d}</span>
            </div>
          ))}
        </div>
        {/* Week columns */}
        {weekKeys.map((wk) => {
          const days = weeks.get(wk)!;
          return (
            <div key={wk} className="flex flex-col gap-0.5">
              {[0, 1, 2, 3, 4].map((dayIdx) => {
                const has = days.get(dayIdx);
                return (
                  <div
                    key={dayIdx}
                    className={cn(
                      'w-3 h-3 rounded-[2px]',
                      has === true
                        ? 'bg-success'
                        : has === false
                          ? 'bg-error/30'
                          : 'bg-muted',
                    )}
                    title={`${DAY_LABELS[dayIdx]}, week of ${wk}: ${has ? 'Recorded' : has === false ? 'No entries' : 'N/A'}`}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
