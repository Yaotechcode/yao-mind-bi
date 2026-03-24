// src/server/pipeline/enricher.ts
// Stage 5: Enrich — pure functions only. No database calls.

import type { JoinResult } from '../../shared/types/pipeline.js';
import type { EnrichedTimeEntry, EnrichedDepartment } from '../../shared/types/enriched.js';

function isoWeekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7; // Mon=1, Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function enrichTimeEntry(entry: EnrichedTimeEntry, today: Date): EnrichedTimeEntry {
  const durationMinutes = typeof entry.durationMinutes === 'number' ? entry.durationMinutes : null;
  const durationHours =
    durationMinutes !== null
      ? Math.round((durationMinutes / 60) * 10000) / 10000
      : null;

  const billableValue = entry.billableValue as number | null | undefined;
  const doNotBill = entry.doNotBill as boolean | null | undefined;
  const isChargeable = (billableValue ?? 0) > 0 && doNotBill !== true;

  const rate = typeof entry.rate === 'number' ? entry.rate : null;
  const recordedValue =
    rate !== null && durationHours !== null
      ? Math.round(rate * durationHours * 100) / 100
      : null;

  const date = entry.date instanceof Date ? entry.date : null;
  const ageInDays =
    date !== null
      ? Math.floor((today.getTime() - date.getTime()) / 86400000)
      : null;
  const weekNumber = date !== null ? isoWeekNumber(date) : null;
  const monthKey =
    date !== null
      ? `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`
      : null;

  return {
    ...entry,
    durationHours,
    isChargeable,
    recordedValue,
    ageInDays,
    weekNumber,
    monthKey,
  };
}

function synthesiseDepartments(joinResult: JoinResult): EnrichedDepartment[] {
  const existing = joinResult.departments;
  const existingNames = new Set(existing.map(d => d.name));

  const allNames = new Set<string>();

  for (const matter of joinResult.matters) {
    const dept = matter.department as string | null | undefined;
    if (dept && typeof dept === 'string' && dept.trim() !== '') {
      allNames.add(dept);
    }
  }

  for (const feeEarner of joinResult.feeEarners) {
    const dept = feeEarner.department as string | null | undefined;
    if (dept && typeof dept === 'string' && dept.trim() !== '') {
      allNames.add(dept);
    }
  }

  const newDepts: EnrichedDepartment[] = [];
  for (const name of allNames) {
    if (!existingNames.has(name)) {
      newDepts.push({ name, departmentId: null });
    }
  }

  return [...existing, ...newDepts];
}

export function enrichRecords(joinResult: JoinResult, today: Date): JoinResult {
  const enrichedTimeEntries = joinResult.timeEntries.map(entry =>
    enrichTimeEntry(entry, today)
  );

  const departments = synthesiseDepartments(joinResult);

  return {
    ...joinResult,
    timeEntries: enrichedTimeEntries,
    departments,
  };
}
