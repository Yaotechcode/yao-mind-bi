/**
 * kpi-snapshot-builder.ts
 *
 * Converts formula engine output (CalculationResult / CalculatedKpisDocument)
 * into flat KpiSnapshotRow[] ready for insertion into the Supabase
 * kpi_snapshots table.
 *
 * Two entry points:
 *   buildSnapshotsFromKpiResults — entity-level rows from formulaResults
 *   buildFirmLevelSnapshots      — firm-level rows from a plain kpi object
 */

import { getBuiltInFormulaDefinitions } from '../../../shared/formulas/built-in-formulas.js';
import { formatDisplayValue } from '../../services/kpi-snapshot-service.js';
import type { KpiSnapshotRow } from '../../services/kpi-snapshot-service.js';
import type { FormulaResult } from '../../formula-engine/types.js';
import type { RagAssignment } from '../../formula-engine/rag-engine.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a map of formulaId → entity_type string from the built-in definitions. */
function buildEntityTypeMap(): Map<string, string> {
  const defs = getBuiltInFormulaDefinitions();
  const map = new Map<string, string>();
  for (const def of defs) {
    map.set(def.formulaId, def.entityType as string);
  }
  return map;
}

// ---------------------------------------------------------------------------
// buildSnapshotsFromKpiResults
// ---------------------------------------------------------------------------

/**
 * Convert the formula engine's result map into KpiSnapshotRow[].
 *
 * @param firmId     - firm identifier (written to every row for RLS)
 * @param pulledAt   - ISO timestamp when this calculation was triggered
 * @param kpiResults - the CalculatedKpisDocument stored in MongoDB (or its
 *                     equivalent from CalculationResult)
 * @param period     - defaults to 'current'
 */
export function buildSnapshotsFromKpiResults(
  firmId: string,
  pulledAt: string,
  kpiResults: {
    kpis: {
      formulaResults?: Record<string, FormulaResult>;
      ragAssignments?: Record<string, Record<string, RagAssignment>>;
    };
  },
  period = 'current',
): KpiSnapshotRow[] {
  const formulaResults = kpiResults.kpis['formulaResults'] ?? {};
  const ragAssignments = kpiResults.kpis['ragAssignments'] ?? {};

  console.log('[kpi-snapshot-builder] Input keys:', Object.keys(kpiResults.kpis ?? {}));
  console.log('[kpi-snapshot-builder] formulaResults sample:',
    JSON.stringify(Object.entries(formulaResults).slice(0, 3).map(([id, r]) => ({
      formulaId: id,
      entityCount: Object.keys(r.entityResults ?? {}).length,
      sampleEntityId: Object.keys(r.entityResults ?? {})[0],
      sampleEntityName: Object.values(r.entityResults ?? {})[0]?.entityName,
    })), null, 2));


  const entityTypeMap = buildEntityTypeMap();
  const rows: KpiSnapshotRow[] = [];

  for (const [formulaId, result] of Object.entries(formulaResults)) {
    const entityType = entityTypeMap.get(formulaId) ?? 'firm';
    const formulaRagMap = ragAssignments[formulaId] ?? {};

    for (const [entityId, entityResult] of Object.entries(result.entityResults)) {
      const ragAssignment = formulaRagMap[entityId];
      const ragStatus = (ragAssignment?.status ?? null) as KpiSnapshotRow['rag_status'];

      rows.push({
        firm_id: firmId,
        pulled_at: pulledAt,
        entity_type: entityType,
        entity_id: entityId,
        entity_name: entityResult.entityName,
        kpi_key: formulaId,
        kpi_value: entityResult.value,
        rag_status: ragStatus,
        period,
        display_value: formatDisplayValue(entityResult.value, formulaId),
      });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// buildFirmLevelSnapshots
// ---------------------------------------------------------------------------

/**
 * Build KpiSnapshotRow[] for firm-level KPIs stored as a flat key→value map.
 *
 * This covers KPIs that are not part of the entity-level formulaResults
 * structure (e.g. aggregate totals written by the pipeline stage).
 *
 * @param firmId    - firm identifier
 * @param pulledAt  - ISO timestamp
 * @param firmKpis  - plain object mapping kpi_key → numeric value
 * @param firmName  - display name for the firm entity (defaults to firmId)
 * @param period    - defaults to 'current'
 */
export function buildFirmLevelSnapshots(
  firmId: string,
  pulledAt: string,
  firmKpis: Record<string, number | null>,
  firmName = firmId,
  period = 'current',
): KpiSnapshotRow[] {
  return Object.entries(firmKpis).map(([kpiKey, value]) => ({
    firm_id: firmId,
    pulled_at: pulledAt,
    entity_type: 'firm',
    entity_id: firmId,
    entity_name: firmName,
    kpi_key: kpiKey,
    kpi_value: value,
    rag_status: null,
    period,
    display_value: formatDisplayValue(value, kpiKey),
  }));
}
