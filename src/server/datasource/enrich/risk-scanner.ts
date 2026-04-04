/**
 * risk-scanner.ts
 *
 * Scans computed KPI snapshot rows against thresholds and generates
 * RiskFlagDocument[] for any entities that breach risk rules.
 *
 * Runs after formula calculation and kpi_snapshots are written.
 * Caller stores the result via storeRiskFlags(firmId, flags).
 *
 * Seven risk rules implemented:
 *   WIP_AGE_HIGH         — matter WIP older than configured red threshold
 *   BUDGET_BURN_CRITICAL — matter budget consumption > 85% (high) or > 70% (medium)
 *   DEBTOR_DAYS_HIGH     — invoice outstanding > configured red debtor-days threshold
 *   UTILISATION_DROP     — fee earner utilisation dropped > 20% vs previous period
 *   DORMANT_MATTER       — matter has unbilled WIP older than 14 days
 *   BAD_DEBT_RISK        — invoice outstanding for > 90 days (120+ = high)
 *   WRITE_OFF_SPIKE      — fee earner write-off rate > configured red threshold
 */

import type { RiskFlagDocument } from '../../../shared/types/mongodb.js';
import type { FirmConfig, RagThresholdSet } from '../../../shared/types/index.js';
import { RagStatus } from '../../../shared/types/index.js';
import type { KpiSnapshotRow } from '../../services/kpi-snapshot-service.js';

// =============================================================================
// Public interface
// =============================================================================

export interface RiskScanInput {
  firmId: string;
  kpiSnapshots: KpiSnapshotRow[];
  config: FirmConfig;
  pulledAt: string;
}

// =============================================================================
// KPI key constants
// =============================================================================

/** Formula IDs used by each risk rule */
const KPI = {
  WIP_AGE:         'F-WL-01',  // days — matter
  LOCKUP_DAYS:     'F-WL-04',  // days — firm (WIP age + debtor days combined)
  WRITE_OFF_RATE:  'F-WL-02',  // percentage — feeEarner
  BUDGET_BURN:     'F-BS-01',  // percentage — matter
  DEBTOR_DAYS:     'F-DM-01',  // currency/days — invoice
  UTILISATION:     'F-TU-01',  // percentage — feeEarner
} as const;

// =============================================================================
// Fallback thresholds (used when firm config has no RAG threshold for a metric)
// =============================================================================

const DEFAULT_THRESHOLDS = {
  WIP_AGE_RED_DAYS:     30,
  WIP_AGE_AMBER_DAYS:   14,
  DEBTOR_DAYS_RED:      60,
  WRITE_OFF_RED_PCT:    10,
  WRITE_OFF_AMBER_PCT:   5,
} as const;

// =============================================================================
// Threshold helpers
// =============================================================================

function findThreshold(
  thresholds: RagThresholdSet[],
  metricKey: string,
): RagThresholdSet['defaults'] | null {
  return thresholds.find((t) => t.metricKey === metricKey)?.defaults ?? null;
}

function redMin(thresholds: RagThresholdSet[], metricKey: string, fallback: number): number {
  const t = findThreshold(thresholds, metricKey);
  return t?.[RagStatus.RED]?.min ?? fallback;
}

function amberMin(thresholds: RagThresholdSet[], metricKey: string, fallback: number): number {
  const t = findThreshold(thresholds, metricKey);
  return t?.[RagStatus.AMBER]?.min ?? fallback;
}

// =============================================================================
// Snapshot filtering helpers
// =============================================================================

type SnapshotMap = Map<string, KpiSnapshotRow[]>;

/** Index snapshots by `entity_type|kpi_key|period` for O(1) lookup. */
function buildIndex(snapshots: KpiSnapshotRow[]): SnapshotMap {
  const map: SnapshotMap = new Map();
  for (const row of snapshots) {
    const key = `${row.entity_type}|${row.kpi_key}|${row.period}`;
    const bucket = map.get(key) ?? [];
    bucket.push(row);
    map.set(key, bucket);
  }
  return map;
}

function getRows(
  index: SnapshotMap,
  entityType: string,
  kpiKey: string,
  period = 'current',
): KpiSnapshotRow[] {
  return index.get(`${entityType}|${kpiKey}|${period}`) ?? [];
}

// =============================================================================
// Flag factory
// =============================================================================

function makeFlag(
  input: RiskScanInput,
  row: KpiSnapshotRow,
  flagType: RiskFlagDocument['flag_type'],
  severity: RiskFlagDocument['severity'],
  detail: string,
  threshold: number,
): RiskFlagDocument {
  return {
    firm_id:     input.firmId,
    flagged_at:  new Date(input.pulledAt),
    entity_type: row.entity_type,
    entity_id:   row.entity_id,
    entity_name: row.entity_name,
    flag_type:   flagType,
    severity,
    detail,
    kpi_value:   row.kpi_value ?? 0,
    threshold,
    ai_summary:  undefined,
  };
}

function round1(n: number): string {
  return n.toFixed(1);
}

// =============================================================================
// Rule implementations
// =============================================================================

/** WIP_AGE_HIGH — matter + firm aggregate */
function checkWipAgeHigh(input: RiskScanInput, index: SnapshotMap): RiskFlagDocument[] {
  const { config } = input;
  const t = config.ragThresholds ?? [];

  const redDays   = redMin(t,   KPI.WIP_AGE, DEFAULT_THRESHOLDS.WIP_AGE_RED_DAYS);
  const amberDays = amberMin(t, KPI.WIP_AGE, DEFAULT_THRESHOLDS.WIP_AGE_AMBER_DAYS);

  const flags: RiskFlagDocument[] = [];

  // Matter-level
  for (const row of getRows(index, 'matter', KPI.WIP_AGE)) {
    const v = row.kpi_value;
    if (v === null || v === undefined) continue;

    if (v > redDays) {
      flags.push(makeFlag(
        input, row, 'WIP_AGE_HIGH', 'high',
        `WIP unbilled for ${Math.round(v)} days — recovery risk increasing`,
        redDays,
      ));
    } else if (v > amberDays) {
      flags.push(makeFlag(
        input, row, 'WIP_AGE_HIGH', 'medium',
        `WIP unbilled for ${Math.round(v)} days — recovery risk increasing`,
        amberDays,
      ));
    }
  }

  // Firm aggregate (F-WL-04 = lock-up days which includes WIP age)
  for (const row of getRows(index, 'firm', KPI.LOCKUP_DAYS)) {
    const v = row.kpi_value;
    if (v === null || v === undefined) continue;
    if (v > redDays) {
      flags.push(makeFlag(
        input, row, 'WIP_AGE_HIGH', 'high',
        `WIP unbilled for ${Math.round(v)} days — recovery risk increasing`,
        redDays,
      ));
    } else if (v > amberDays) {
      flags.push(makeFlag(
        input, row, 'WIP_AGE_HIGH', 'medium',
        `WIP unbilled for ${Math.round(v)} days — recovery risk increasing`,
        amberDays,
      ));
    }
  }

  return flags;
}

/** BUDGET_BURN_CRITICAL — matter */
function checkBudgetBurnCritical(input: RiskScanInput, index: SnapshotMap): RiskFlagDocument[] {
  const HIGH_THRESHOLD   = 85;
  const MEDIUM_THRESHOLD = 70;

  return getRows(index, 'matter', KPI.BUDGET_BURN)
    .filter((r) => r.kpi_value !== null && r.kpi_value !== undefined)
    .flatMap((row) => {
      const v = row.kpi_value as number;
      const remaining = round1(100 - v);

      if (v > HIGH_THRESHOLD) {
        return [makeFlag(
          input, row, 'BUDGET_BURN_CRITICAL', 'high',
          `Matter at ${round1(v)}% of budget — ${remaining}% remaining`,
          HIGH_THRESHOLD,
        )];
      }
      if (v > MEDIUM_THRESHOLD) {
        return [makeFlag(
          input, row, 'BUDGET_BURN_CRITICAL', 'medium',
          `Matter at ${round1(v)}% of budget — ${remaining}% remaining`,
          MEDIUM_THRESHOLD,
        )];
      }
      return [];
    });
}

/** DEBTOR_DAYS_HIGH — invoice */
function checkDebtorDaysHigh(input: RiskScanInput, index: SnapshotMap): RiskFlagDocument[] {
  const { config } = input;
  const t = config.ragThresholds ?? [];
  const redDays = redMin(t, KPI.DEBTOR_DAYS, DEFAULT_THRESHOLDS.DEBTOR_DAYS_RED);

  const flags: RiskFlagDocument[] = [];

  for (const entityType of ['invoice', 'client'] as const) {
    for (const row of getRows(index, entityType, KPI.DEBTOR_DAYS)) {
      const v = row.kpi_value;
      if (v === null || v === undefined) continue;
      if (v > redDays) {
        flags.push(makeFlag(
          input, row, 'DEBTOR_DAYS_HIGH', 'high',
          `Invoice ${Math.round(v)} days outstanding — above firm threshold`,
          redDays,
        ));
      }
    }
  }

  return flags;
}

/** UTILISATION_DROP — feeEarner (skipped when no previous-period data) */
function checkUtilisationDrop(input: RiskScanInput, index: SnapshotMap): RiskFlagDocument[] {
  const DROP_HIGH_PCT   = 30;
  const DROP_MEDIUM_PCT = 20;

  const currentRows  = getRows(index, 'feeEarner', KPI.UTILISATION, 'current');
  const previousRows = getRows(index, 'feeEarner', KPI.UTILISATION, 'previous');

  if (previousRows.length === 0) return [];  // no historical data — skip

  // Build previous-period lookup by entityId
  const prevMap = new Map<string, number>();
  for (const row of previousRows) {
    if (row.kpi_value !== null && row.kpi_value !== undefined) {
      prevMap.set(row.entity_id, row.kpi_value);
    }
  }

  const flags: RiskFlagDocument[] = [];

  for (const row of currentRows) {
    const curr = row.kpi_value;
    if (curr === null || curr === undefined) continue;

    const prev = prevMap.get(row.entity_id);
    if (prev === undefined || prev === 0) continue;

    const dropPct = ((prev - curr) / prev) * 100;
    if (dropPct <= DROP_MEDIUM_PCT) continue;

    const severity: RiskFlagDocument['severity'] = dropPct > DROP_HIGH_PCT ? 'high' : 'medium';
    flags.push(makeFlag(
      input, row, 'UTILISATION_DROP', severity,
      `Utilisation dropped from ${round1(prev)}% to ${round1(curr)}% — review workload`,
      prev * (1 - DROP_MEDIUM_PCT / 100),
    ));
  }

  return flags;
}

/** DORMANT_MATTER — matter with unbilled WIP older than 14 days */
function checkDormantMatter(input: RiskScanInput, index: SnapshotMap): RiskFlagDocument[] {
  const DORMANT_DAYS = 14;

  return getRows(index, 'matter', KPI.WIP_AGE)
    .filter((r) => r.kpi_value !== null && r.kpi_value !== undefined && (r.kpi_value as number) > DORMANT_DAYS)
    .map((row) => {
      const days = Math.round(row.kpi_value as number);
      return makeFlag(
        input, row, 'DORMANT_MATTER', 'medium',
        `No time recorded on this matter for ${days} days`,
        DORMANT_DAYS,
      );
    });
}

/** BAD_DEBT_RISK — invoice outstanding > 90 days (120+ = high) */
function checkBadDebtRisk(input: RiskScanInput, index: SnapshotMap): RiskFlagDocument[] {
  const HIGH_DAYS   = 120;
  const MEDIUM_DAYS = 90;

  return getRows(index, 'invoice', KPI.DEBTOR_DAYS)
    .filter((r) => r.kpi_value !== null && r.kpi_value !== undefined)
    .flatMap((row) => {
      const v = row.kpi_value as number;
      if (v > HIGH_DAYS) {
        return [makeFlag(
          input, row, 'BAD_DEBT_RISK', 'high',
          `Invoice outstanding ${Math.round(v)} days — potential bad debt`,
          HIGH_DAYS,
        )];
      }
      if (v > MEDIUM_DAYS) {
        return [makeFlag(
          input, row, 'BAD_DEBT_RISK', 'medium',
          `Invoice outstanding ${Math.round(v)} days — potential bad debt`,
          MEDIUM_DAYS,
        )];
      }
      return [];
    });
}

/** WRITE_OFF_SPIKE — feeEarner + firm aggregate */
function checkWriteOffSpike(input: RiskScanInput, index: SnapshotMap): RiskFlagDocument[] {
  const { config } = input;
  const t = config.ragThresholds ?? [];

  const redPct   = redMin(t,   KPI.WRITE_OFF_RATE, DEFAULT_THRESHOLDS.WRITE_OFF_RED_PCT);
  const amberPct = amberMin(t, KPI.WRITE_OFF_RATE, DEFAULT_THRESHOLDS.WRITE_OFF_AMBER_PCT);

  const flags: RiskFlagDocument[] = [];

  // Fee earner level
  for (const row of getRows(index, 'feeEarner', KPI.WRITE_OFF_RATE)) {
    const v = row.kpi_value;
    if (v === null || v === undefined) continue;

    if (v > redPct) {
      flags.push(makeFlag(
        input, row, 'WRITE_OFF_SPIKE', 'high',
        `Write-off rate ${round1(v)}% — exceeds firm threshold`,
        redPct,
      ));
    } else if (v > amberPct) {
      flags.push(makeFlag(
        input, row, 'WRITE_OFF_SPIKE', 'medium',
        `Write-off rate ${round1(v)}% — exceeds firm threshold`,
        amberPct,
      ));
    }
  }

  // Firm-level (synthesised from feeEarner average if no firm-level row)
  const firmRows = getRows(index, 'firm', KPI.WRITE_OFF_RATE);
  for (const row of firmRows) {
    const v = row.kpi_value;
    if (v === null || v === undefined) continue;
    if (v > redPct) {
      flags.push(makeFlag(
        input, row, 'WRITE_OFF_SPIKE', 'high',
        `Write-off rate ${round1(v)}% — exceeds firm threshold`,
        redPct,
      ));
    } else if (v > amberPct) {
      flags.push(makeFlag(
        input, row, 'WRITE_OFF_SPIKE', 'medium',
        `Write-off rate ${round1(v)}% — exceeds firm threshold`,
        amberPct,
      ));
    }
  }

  return flags;
}

// =============================================================================
// Main entry point
// =============================================================================

/**
 * Run all 7 risk rules against the provided KPI snapshot rows.
 *
 * Returns a flat array of RiskFlagDocument objects ready for storage.
 * ai_summary is always null at this stage (populated in future AI phase).
 */
export function scanForRiskFlags(input: RiskScanInput): RiskFlagDocument[] {
  if (input.kpiSnapshots.length === 0) return [];

  const index = buildIndex(input.kpiSnapshots);

  return [
    ...checkWipAgeHigh(input, index),
    ...checkBudgetBurnCritical(input, index),
    ...checkDebtorDaysHigh(input, index),
    ...checkUtilisationDrop(input, index),
    ...checkDormantMatter(input, index),
    ...checkBadDebtRisk(input, index),
    ...checkWriteOffSpike(input, index),
  ];
}
