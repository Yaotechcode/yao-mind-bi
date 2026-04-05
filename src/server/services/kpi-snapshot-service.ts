/**
 * kpi-snapshot-service.ts — Reads and writes pre-computed KPIs to/from the
 * kpi_snapshots Supabase table.
 *
 * Rules:
 *  - Uses service-role client only — dashboards must never call this directly
 *  - writeKpiSnapshots is atomic-replace: DELETE then batch INSERT
 *  - All queries are firm-scoped (firm_id is always in the filter)
 *  - formatDisplayValue is a pure function — no I/O
 */

import { getServerClient } from '../lib/supabase.js';

// =============================================================================
// Types
// =============================================================================

export interface KpiSnapshotRow {
  firm_id: string;
  pulled_at: string;     // ISO timestamp
  entity_type: string;
  entity_id: string;
  entity_name: string;
  kpi_key: string;
  kpi_value: number | null;
  rag_status: 'green' | 'amber' | 'red' | 'neutral' | null;
  period: string;
  display_value: string | null;
}

export interface GetKpiSnapshotsOptions {
  entityType?: string;
  period?: string;
  kpiKeys?: string[];
  entityIds?: string[];
}

// =============================================================================
// Insert batch size
// =============================================================================

const INSERT_BATCH_SIZE = 500;

// =============================================================================
// Write
// =============================================================================

/**
 * Atomically replaces all KPI snapshots for a firm.
 *
 * 1. DELETE all existing rows for firmId
 * 2. INSERT new rows in batches of INSERT_BATCH_SIZE
 *
 * If any insert batch fails, attempts a compensating DELETE to avoid a
 * partially-written state, then re-throws the original error.
 */
export async function writeKpiSnapshots(
  firmId: string,
  snapshots: KpiSnapshotRow[],
): Promise<void> {
  const db = getServerClient();

  // Step 1 — delete existing snapshot rows for this firm
  const { error: deleteError } = await db
    .from('kpi_snapshots')
    .delete()
    .eq('firm_id', firmId);

  if (deleteError) {
    throw new Error(
      `writeKpiSnapshots: failed to delete existing rows for firm ${firmId}: ${deleteError.message}`,
    );
  }

  if (snapshots.length === 0) {
    console.log(`[kpi-snapshot-service] Wrote 0 rows for firm ${firmId} (empty snapshot set)`);
    return;
  }

  // Step 2 — insert in batches
  const batches: KpiSnapshotRow[][] = [];
  for (let i = 0; i < snapshots.length; i += INSERT_BATCH_SIZE) {
    batches.push(snapshots.slice(i, i + INSERT_BATCH_SIZE));
  }

  let insertedCount = 0;
  for (const batch of batches) {
    const { error: insertError } = await db.from('kpi_snapshots').insert(batch);

    if (insertError) {
      // Best-effort rollback — remove partially inserted rows
      await db.from('kpi_snapshots').delete().eq('firm_id', firmId);
      throw new Error(
        `writeKpiSnapshots: batch insert failed for firm ${firmId} ` +
          `(after ${insertedCount} rows inserted): ${insertError.message}`,
      );
    }

    insertedCount += batch.length;
  }

  console.log(
    `[kpi-snapshot-service] Wrote ${insertedCount} KPI snapshot rows for firm ${firmId}`,
  );

  // Verification: confirm rows are actually present in the table.
  // This surfaces silent failures (e.g. wrong env key, RLS misconfiguration)
  // that would otherwise only show up as missing dashboard data.
  const { count, error: countError } = await db
    .from('kpi_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('firm_id', firmId);

  if (countError) {
    console.warn(
      `[kpi-snapshot-service] Verification count failed for firm ${firmId}: ${countError.message}`,
    );
  } else {
    console.log(
      `[kpi-snapshot-service] Verified ${count ?? 0} rows in kpi_snapshots for firm ${firmId}` +
        (count !== insertedCount ? ` — WARNING: expected ${insertedCount}` : ''),
    );
  }
}

// =============================================================================
// Read
// =============================================================================

/**
 * Reads KPI snapshots for a firm with optional filters.
 * Results are ordered by entity_type → entity_name → kpi_key.
 */
export async function getKpiSnapshots(
  firmId: string,
  options: GetKpiSnapshotsOptions = {},
): Promise<KpiSnapshotRow[]> {
  const db = getServerClient();

  let query = db
    .from('kpi_snapshots')
    .select('*')
    .eq('firm_id', firmId);

  if (options.entityType) {
    query = query.eq('entity_type', options.entityType);
  }
  if (options.period) {
    query = query.eq('period', options.period);
  }
  if (options.kpiKeys && options.kpiKeys.length > 0) {
    query = query.in('kpi_key', options.kpiKeys);
  }
  if (options.entityIds && options.entityIds.length > 0) {
    query = query.in('entity_id', options.entityIds);
  }

  const { data, error } = await query
    .order('entity_type', { ascending: true })
    .order('entity_name', { ascending: true })
    .order('kpi_key', { ascending: true });

  if (error) {
    throw new Error(
      `getKpiSnapshots: query failed for firm ${firmId}: ${error.message}`,
    );
  }

  return (data ?? []) as KpiSnapshotRow[];
}

/**
 * Returns the most recent pulled_at timestamp for a firm, or null if none exist.
 */
export async function getLatestPullTime(firmId: string): Promise<string | null> {
  const db = getServerClient();

  const { data, error } = await db
    .from('kpi_snapshots')
    .select('pulled_at')
    .eq('firm_id', firmId)
    .order('pulled_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      `getLatestPullTime: query failed for firm ${firmId}: ${error.message}`,
    );
  }

  return (data as { pulled_at: string } | null)?.pulled_at ?? null;
}

// =============================================================================
// Display value formatting
// =============================================================================

/**
 * Maps known formula keys to their result type for formatting.
 * Built from the built-in-formulas registry.
 */
const KPI_RESULT_TYPES: Record<string, 'percentage' | 'currency' | 'hours' | 'days' | 'number' | 'ratio'> = {
  // Utilisation & Time
  'F-TU-01': 'percentage',
  'F-TU-02': 'percentage',
  'F-TU-03': 'percentage',
  // Revenue & Billing
  'F-RB-01': 'percentage',
  'F-RB-02': 'currency',
  'F-RB-03': 'currency',
  'F-RB-04': 'days',
  // WIP & Leakage
  'F-WL-01': 'days',
  'F-WL-02': 'percentage',
  'F-WL-03': 'percentage',
  'F-WL-04': 'days',
  // Profitability
  'F-PR-01': 'currency',
  'F-PR-02': 'currency',
  'F-PR-03': 'currency',
  'F-PR-04': 'currency',
  'F-PR-05': 'currency',
  // Budget & Scope
  'F-BS-01': 'percentage',
  'F-BS-02': 'number',
  // Debtors
  'F-DM-01': 'currency',
  'F-DM-02': 'number',
  // Composites
  'F-CS-01': 'currency',
  'F-CS-02': 'number',
  'F-CS-03': 'number',
};

const GBP = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Formats a KPI value for display based on the formula's result type.
 * Returns null when value is null — never returns "null%" or "£null".
 */
export function formatDisplayValue(value: number | null, kpiKey: string): string | null {
  if (value === null) return null;

  const resultType = KPI_RESULT_TYPES[kpiKey];

  switch (resultType) {
    case 'percentage':
      return `${value.toFixed(1)}%`;

    case 'currency':
      return GBP.format(value);

    case 'hours':
      return `${value.toFixed(1)} hrs`;

    case 'days':
      return `${Math.round(value)} days`;

    case 'ratio':
      return `${value.toFixed(1)}x`;

    case 'number':
    default:
      // Whole numbers render without decimals; fractional numbers keep 1dp
      return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
}
