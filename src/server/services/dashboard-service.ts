/**
 * dashboard-service.ts — Dashboard Data Aggregation Service
 *
 * One function per dashboard. Each function loads data in parallel,
 * applies filters in-memory, and returns a typed payload.
 *
 * Data sources (post-migration):
 *  - kpi_snapshots (Supabase): formula results + RAG statuses per entity
 *  - enriched_entities (MongoDB): aggregated metrics, time entries, invoices,
 *    matter attributes — anything not yet in kpi_snapshots
 *
 * RAG statuses come FROM kpi_snapshots — never recalculated here.
 */

import type { AggregatedFeeEarner, AggregatedMatter, AggregatedClient, AggregatedDepartment, AggregatedFirm } from '../../shared/types/pipeline.js';
import type { EnrichedTimeEntry, EnrichedInvoice, EnrichedDisbursement } from '../../shared/types/enriched.js';
import type {
  FirmOverviewPayload, FeeEarnerPerformancePayload, WipPayload,
  BillingPayload, MatterPayload, ClientPayload, MatterRow,
} from '../../shared/types/dashboard-payloads.js';
import { RagStatus } from '../../shared/types/index.js';
import type { RagThresholdSet } from '../../shared/types/index.js';
import { getLatestEnrichedEntities } from '../lib/mongodb-operations.js';
import { getKpiSnapshots } from './kpi-snapshot-service.js';
import type { KpiSnapshotRow } from './kpi-snapshot-service.js';
import { getFirmConfig } from './config-service.js';

// ---------------------------------------------------------------------------
// Date coercion helper
// ---------------------------------------------------------------------------

/** Safely coerce any date-like value (Date object, BSON $date, string) to an
 *  ISO string. Returns null for null / undefined / empty values so callers
 *  can keep their existing `if (!dateStr) continue` guards. */
function toDateString(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === 'string') return val;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'object' && val !== null && '$date' in val) {
    return new Date((val as { $date: string }).$date).toISOString();
  }
  return String(val);
}

// ---------------------------------------------------------------------------
// Filter / pagination types
// ---------------------------------------------------------------------------

export interface DashboardFilters {
  department?: string;
  grade?: string;
  payModel?: string;
  activeOnly?: boolean;
  feeEarner?: string;
  caseType?: string;
  status?: string;
  lawyer?: string;
  minValue?: number;
  minMatters?: number;
  minRevenue?: number;
  hasBudget?: boolean;
  period?: string;
  groupBy?: 'matter' | 'feeEarner' | 'client';
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

/**
 * Returns the distinct kpi_key values present in kpi_snapshots for a given
 * entity type. Call at the start of each dashboard function for diagnostics.
 */
async function getAvailableKpiKeys(firmId: string, entityType: string): Promise<string[]> {
  const rows = await getKpiSnapshots(firmId, { entityType, period: 'current' });
  const keys = [...new Set(rows.map((r) => r.kpi_key))].sort();
  return keys;
}

/**
 * Groups a flat array of KpiSnapshotRows by entity_id.
 * Returns Map<entity_id, Map<kpi_key, KpiSnapshotRow>>.
 */
function groupSnapshotsByEntity(
  snapshots: KpiSnapshotRow[],
): Map<string, Map<string, KpiSnapshotRow>> {
  const map = new Map<string, Map<string, KpiSnapshotRow>>();
  for (const row of snapshots) {
    if (!map.has(row.entity_id)) map.set(row.entity_id, new Map());
    map.get(row.entity_id)!.set(row.kpi_key, row);
  }
  return map;
}

/** Pull a numeric kpi_value from an entity snapshot map, defaulting to 0. */
function kpiNum(entitySnap: Map<string, KpiSnapshotRow> | undefined, key: string): number {
  return entitySnap?.get(key)?.kpi_value ?? 0;
}

/** Pull a nullable numeric kpi_value (null when missing). */
function kpiNumOrNull(entitySnap: Map<string, KpiSnapshotRow> | undefined, key: string): number | null {
  return entitySnap?.get(key)?.kpi_value ?? null;
}

/** Pull the rag_status string from an entity snapshot map. */
function kpiRag(entitySnap: Map<string, KpiSnapshotRow> | undefined, key: string): string {
  return entitySnap?.get(key)?.rag_status ?? RagStatus.NEUTRAL;
}

// ---------------------------------------------------------------------------
// Internal: loaded dashboard data (MongoDB-backed aggregated entities)
// ---------------------------------------------------------------------------

interface DashboardData {
  feeEarners: AggregatedFeeEarner[];
  matters: AggregatedMatter[];
  clients: AggregatedClient[];
  departments: AggregatedDepartment[];
  firm: AggregatedFirm;
  dataQuality: { overallScore: number; entityIssues: unknown[]; knownGaps: unknown[] };
  timeEntries: EnrichedTimeEntry[];
  invoices: EnrichedInvoice[];
  disbursements: EnrichedDisbursement[];
  enrichedMatters: Record<string, unknown>[];
  calculatedAt: string | null;
}

const EMPTY_FIRM: AggregatedFirm = {
  feeEarnerCount: 0, activeFeeEarnerCount: 0, salariedFeeEarnerCount: 0,
  feeShareFeeEarnerCount: 0, matterCount: 0, activeMatterCount: 0,
  inProgressMatterCount: 0, completedMatterCount: 0, otherMatterCount: 0,
  totalWipHours: 0, totalChargeableHours: 0, totalWipValue: 0,
  totalWriteOffValue: 0, totalInvoicedRevenue: 0, totalOutstanding: 0, totalPaid: 0,
  orphanedWip: { orphanedWipEntryCount: 0, orphanedWipHours: 0, orphanedWipValue: 0, orphanedWipPercent: 0, orphanedWipNote: '' },
};

/**
 * Loads raw aggregated entity data from MongoDB (legacy pipeline output).
 * Note: formula results and RAG statuses now come from kpi_snapshots (Supabase),
 * not from the MongoDB KPI document. This function no longer calls
 * getLatestCalculatedKpis — that path is replaced by direct kpi_snapshot queries.
 */
async function loadDashboardData(firmId: string): Promise<DashboardData> {
  const [timeEntryDoc, invoiceDoc, disbursementDoc, matterDoc, kpisDoc] = await Promise.all([
    getLatestEnrichedEntities(firmId, 'timeEntry'),
    getLatestEnrichedEntities(firmId, 'invoice'),
    getLatestEnrichedEntities(firmId, 'disbursement'),
    getLatestEnrichedEntities(firmId, 'matter'),
    // kpisDoc for legacy aggregated-entity data only (not formula results)
    getLatestEnrichedEntities(firmId, 'calculatedKpis'),
  ]);

  const agg = (kpisDoc as unknown as Record<string, unknown> | null)?.['aggregate'] as Record<string, unknown> | undefined;

  return {
    feeEarners:     (agg?.['feeEarners'] as AggregatedFeeEarner[] | undefined) ?? [],
    matters:        (agg?.['matters']    as AggregatedMatter[]    | undefined) ?? [],
    clients:        (agg?.['clients']    as AggregatedClient[]    | undefined) ?? [],
    departments:    (agg?.['departments'] as AggregatedDepartment[] | undefined) ?? [],
    firm:           (agg?.['firm']       as AggregatedFirm        | undefined) ?? EMPTY_FIRM,
    dataQuality:    (agg?.['dataQuality'] as { overallScore: number; entityIssues: unknown[]; knownGaps: unknown[] } | undefined) ?? { overallScore: 0, entityIssues: [], knownGaps: [] },
    timeEntries:    ((timeEntryDoc?.records ?? []) as unknown as EnrichedTimeEntry[]),
    invoices:       ((invoiceDoc?.records    ?? []) as unknown as EnrichedInvoice[]),
    disbursements:  ((disbursementDoc?.records ?? []) as unknown as EnrichedDisbursement[]),
    enrichedMatters: (matterDoc?.records ?? []) as Record<string, unknown>[],
    calculatedAt:   null,
  };
}

/** Paginate an array; returns { items, totalCount }. */
function paginate<T>(items: T[], limit = 50, offset = 0): { items: T[]; totalCount: number } {
  return { items: items.slice(offset, offset + limit), totalCount: items.length };
}

// ---------------------------------------------------------------------------
// WIP Age Band helper
// ---------------------------------------------------------------------------

const WIP_BANDS = [
  { band: '0–30 days',   min: 0,   max: 30,  colour: '#09B5B5', recoveryProb: 0.95 },
  { band: '31–60 days',  min: 31,  max: 60,  colour: '#4BC8C8', recoveryProb: 0.85 },
  { band: '61–90 days',  min: 61,  max: 90,  colour: '#E49060', recoveryProb: 0.70 },
  { band: '91–180 days', min: 91,  max: 180, colour: '#E4607B', recoveryProb: 0.50 },
  { band: '180+ days',   min: 181, max: null, colour: '#C04060', recoveryProb: 0.25 },
];

function classifyWipAge(ageInDays: number | null): typeof WIP_BANDS[0] {
  if (ageInDays === null) return WIP_BANDS[0];
  return WIP_BANDS.find(b => ageInDays >= b.min && (b.max === null || ageInDays <= b.max)) ?? WIP_BANDS[WIP_BANDS.length - 1];
}

/** Generate last N working days (Mon–Fri) as YYYY-MM-DD strings. */
function lastNWorkingDays(n: number): string[] {
  const days: string[] = [];
  const d = new Date();
  while (days.length < n) {
    d.setDate(d.getDate() - 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) {
      days.unshift(d.toISOString().slice(0, 10));
    }
  }
  return days;
}

// ---------------------------------------------------------------------------
// RAG threshold helpers
// ---------------------------------------------------------------------------

type ThresholdDefaults = RagThresholdSet['defaults'];

/** Hardcoded fallbacks used when a metricKey isn't present in firm config. */
const FALLBACK_THRESHOLDS: Record<string, ThresholdDefaults> = {
  wipAge: {
    [RagStatus.GREEN]: { max: 15 },
    [RagStatus.AMBER]: { min: 15, max: 30 },
    [RagStatus.RED]:   { min: 30 },
  },
  writeOffRate: {
    [RagStatus.GREEN]: { max: 5 },
    [RagStatus.AMBER]: { min: 5, max: 10 },
    [RagStatus.RED]:   { min: 10 },
  },
  budgetBurn: {
    [RagStatus.GREEN]: { max: 80 },
    [RagStatus.AMBER]: { min: 80, max: 100 },
    [RagStatus.RED]:   { min: 100 },
  },
};

/** Look up threshold defaults from firm config by metricKey, falling back to hardcoded values. */
function getThresholdDefaults(ragThresholds: RagThresholdSet[], metricKey: string): ThresholdDefaults {
  const found = ragThresholds.find(t => t.metricKey === metricKey);
  return found?.defaults ?? FALLBACK_THRESHOLDS[metricKey] ?? FALLBACK_THRESHOLDS['wipAge'];
}

/**
 * Apply a threshold set to a value and return the matching RagStatus.
 */
function applyRagThreshold(value: number, defaults: ThresholdDefaults): RagStatus {
  const inRange = (t: { min?: number; max?: number }) =>
    (t.min === undefined || value >= t.min) && (t.max === undefined || value < t.max);

  if (inRange(defaults[RagStatus.RED]))   return RagStatus.RED;
  if (inRange(defaults[RagStatus.AMBER])) return RagStatus.AMBER;
  if (inRange(defaults[RagStatus.GREEN])) return RagStatus.GREEN;
  return RagStatus.NEUTRAL;
}

// ---------------------------------------------------------------------------
// 1. getFirmOverviewData
// ---------------------------------------------------------------------------

export async function getFirmOverviewData(firmId: string): Promise<FirmOverviewPayload> {
  // Diagnostic: log available kpi_keys for each entity type
  const [feeEarnerKeys, matterKeys, firmKeys] = await Promise.all([
    getAvailableKpiKeys(firmId, 'feeEarner'),
    getAvailableKpiKeys(firmId, 'matter'),
    getAvailableKpiKeys(firmId, 'firm'),
  ]);
  console.log('[dashboard/firm-overview] feeEarner kpi_keys:', feeEarnerKeys);
  console.log('[dashboard/firm-overview] matter kpi_keys:', matterKeys);
  console.log('[dashboard/firm-overview] firm kpi_keys:', firmKeys);

  const [feeEarnerSnaps, matterSnaps, firmSnaps, data] = await Promise.all([
    getKpiSnapshots(firmId, { entityType: 'feeEarner', period: 'current' }),
    getKpiSnapshots(firmId, { entityType: 'matter', period: 'current' }),
    getKpiSnapshots(firmId, { entityType: 'firm', period: 'current' }),
    loadDashboardData(firmId),
  ]);

  const feeEarnerByEntity = groupSnapshotsByEntity(feeEarnerSnaps);
  const matterByEntity    = groupSnapshotsByEntity(matterSnaps);
  const firmByEntity      = groupSnapshotsByEntity(firmSnaps);
  const firmSnap          = firmByEntity.get(firmId) ?? firmByEntity.values().next().value;

  const { invoices } = data;

  // KPI cards from kpi_snapshots
  const firmUtilisation = kpiNumOrNull(firmSnap, 'F-TU-01');
  const firmRealisation = kpiNumOrNull(firmSnap, 'F-RB-01');
  const combinedLockup  = kpiNumOrNull(firmSnap, 'F-WL-04');
  const totalUnbilledWip = kpiNum(firmSnap, 'totalWipValue') || data.firm.totalWipValue;

  // Utilisation snapshot from fee earner snapshots
  let green = 0, amber = 0, red = 0;
  const utilisationFeeEarners = [...feeEarnerByEntity.entries()].map(([entityId, snap]) => {
    const rag = kpiRag(snap, 'F-TU-01');
    if (rag === RagStatus.GREEN) green++;
    else if (rag === RagStatus.AMBER) amber++;
    else if (rag === RagStatus.RED) red++;
    return {
      name: snap.get('F-TU-01')?.entity_name ?? entityId,
      utilisation: kpiNumOrNull(snap, 'F-TU-01'),
      ragStatus: rag,
    };
  });

  // WIP age bands from matter kpi_snapshots (wipAge key) or fallback to MongoDB
  const bandMap = new Map<string, { value: number; count: number }>(
    WIP_BANDS.map(b => [b.band, { value: 0, count: 0 }]),
  );
  if (matterSnaps.some(r => r.kpi_key === 'wipAge')) {
    // Use wipAge from kpi_snapshots
    for (const [, snap] of matterByEntity) {
      const wipAge = kpiNumOrNull(snap, 'wipAge');
      const wipValue = kpiNum(snap, 'wipValue') || kpiNum(snap, 'wipTotalBillable');
      const band = classifyWipAge(wipAge);
      const entry = bandMap.get(band.band)!;
      entry.value += wipValue;
      entry.count += 1;
    }
  } else {
    // Fallback: MongoDB aggregated matters
    for (const m of data.matters) {
      const band = classifyWipAge(m.wipAgeInDays ?? null);
      const entry = bandMap.get(band.band)!;
      entry.value += m.wipTotalBillable;
      entry.count += 1;
    }
  }
  const wipAgeBands = WIP_BANDS.map(b => ({
    ...b, value: bandMap.get(b.band)?.value ?? 0, count: bandMap.get(b.band)?.count ?? 0,
  }));

  // Revenue trend from invoices grouped by month
  const trendMap = new Map<string, number>();
  for (const inv of invoices) {
    const invRec = inv as unknown as Record<string, unknown>;
    const dateStr = toDateString(invRec['invoiceDate']);
    if (!dateStr) continue;
    const period = dateStr.slice(0, 7);
    const total = (invRec['total'] as number | undefined) ?? 0;
    trendMap.set(period, (trendMap.get(period) ?? 0) + total);
  }
  const revenueTrend = [...trendMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([period, billed]) => ({ period, billed }));

  // Top leakage risks from matter kpi_snapshots or MongoDB matters
  const leakageSource = matterSnaps.some(r => r.kpi_key === 'wipAge')
    ? [...matterByEntity.entries()].map(([entityId, snap]) => ({
        matterId: entityId,
        matterNumber: snap.get('F-WL-01')?.entity_name ?? entityId,
        clientName: 'Unknown',
        lawyerName: 'Unknown',
        wipValue: kpiNum(snap, 'wipValue') || kpiNum(snap, 'wipTotalBillable'),
        wipAge: kpiNum(snap, 'wipAge'),
        ragStatus: kpiRag(snap, 'F-WL-01'),
        riskScore: Math.round(kpiNum(snap, 'wipAge') * (kpiNum(snap, 'wipValue') || kpiNum(snap, 'wipTotalBillable')) / 1000),
      }))
    : data.matters
        .filter(m => (m.wipTotalBillable ?? 0) > 0)
        .map(m => {
          const wipAge = m.wipAgeInDays ?? 0;
          const wipValue = m.wipTotalBillable;
          return {
            matterId: m.matterId ?? '',
            matterNumber: m.matterNumber ?? '',
            clientName: 'Unknown',
            lawyerName: 'Unknown',
            wipValue,
            wipAge,
            ragStatus: RagStatus.NEUTRAL,
            riskScore: Math.round(wipAge * wipValue / 1000),
          };
        });

  const topLeakageRisks = leakageSource
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 10);

  // Department summary from matter snapshots or MongoDB
  const departmentSummary = data.departments.map(dept => ({
    name: dept.name,
    wipValue: dept.wipChargeableValue,
    matterCount: dept.activeMatterCount,
    utilisation: null,
    ragStatus: RagStatus.NEUTRAL,
  }));

  const issueCount = (data.dataQuality.entityIssues as unknown[]).length + (data.dataQuality.knownGaps as unknown[]).length;

  return {
    kpiCards: {
      totalUnbilledWip: { value: totalUnbilledWip, ragStatus: RagStatus.NEUTRAL },
      firmRealisation:  { value: firmRealisation,  ragStatus: kpiRag(firmSnap, 'F-RB-01') },
      firmUtilisation:  { value: firmUtilisation,  ragStatus: kpiRag(firmSnap, 'F-TU-01') },
      combinedLockup:   { value: combinedLockup,   ragStatus: kpiRag(firmSnap, 'F-WL-04') },
    },
    wipAgeBands,
    revenueTrend,
    topLeakageRisks,
    utilisationSnapshot: { green, amber, red, feeEarners: utilisationFeeEarners },
    departmentSummary,
    dataQuality: { issueCount, criticalCount: (data.dataQuality.entityIssues as unknown[]).length },
    lastCalculated: feeEarnerSnaps[0]?.pulled_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// 2. getFeeEarnerPerformanceData
// ---------------------------------------------------------------------------

export async function getFeeEarnerPerformanceData(
  firmId: string,
  filters: DashboardFilters = {},
): Promise<FeeEarnerPerformancePayload> {
  const availableKeys = await getAvailableKpiKeys(firmId, 'feeEarner');
  console.log('[dashboard/fee-earner-performance] feeEarner kpi_keys:', availableKeys);

  // Load only from kpi_snapshots — MongoDB enriched_entities for 'feeEarner'
  // contains stale CSV pipeline data that contaminates names and attributes.
  // All required data (entity_id, entity_name, KPI values) is in kpi_snapshots.
  const [feeEarnerSnaps, firmConfig] = await Promise.all([
    getKpiSnapshots(firmId, { entityType: 'feeEarner', period: 'current' }),
    getFirmConfig(firmId),
  ]);

  const weeklyTarget = firmConfig.weeklyTargetHours ?? 37.5;

  // Group kpi_snapshot rows by entity_id
  const byEntity = groupSnapshotsByEntity(feeEarnerSnaps);

  // Build row list from kpi_snapshots — one row per entity_id.
  // Name: prefer F-TU-01 entity_name (most reliably set from attorney fullName),
  // fall back to any snapshot's entity_name, then bare entity_id.
  let allRows = [...byEntity.entries()].map(([entityId, snap]) => {
    const name =
      snap.get('F-TU-01')?.entity_name ??
      snap.values().next().value?.entity_name ??
      entityId;

    // Attributes not yet stored in kpi_snapshots — default to safe values.
    // department, grade, payModel will be added when enrichment is extended.
    const department: string | null = null;
    const grade: string | null      = null;
    const payModel: string | null   = null;
    const isActive                  = true;   // all API-pulled attorneys are active

    // KPI values from kpi_snapshots (formula IDs)
    const utilisation      = kpiNumOrNull(snap, 'F-TU-01');
    const utilisationRag   = kpiRag(snap, 'F-TU-01');
    const effectiveRate    = kpiNumOrNull(snap, 'F-RB-02');
    const billedRevenue    = kpiNumOrNull(snap, 'F-RB-03');
    const recordingGapDays = kpiNumOrNull(snap, 'F-TU-02');
    const scorecard        = kpiNumOrNull(snap, 'F-CS-02');
    const scorecardRag     = kpiRag(snap, 'F-CS-02');
    const profit           = kpiNumOrNull(snap, 'F-PR-02');
    // F-WL-02 has matter-level rows (575 rows); not yet aggregated per fee earner
    const writeOffRate     = 0;
    // chargeableHours / totalHours / wipValue / matterCount not yet in kpi_snapshots
    const chargeableHours  = 0;
    const totalHours       = 0;
    const wipValueRecorded = 0;
    const matterCount      = 0;
    const employmentCost: number | null   = null;
    const revenueMultiple: number | null  = null;

    return {
      id: entityId,
      name,
      department,
      grade,
      payModel,
      isActive,
      chargeableHours,
      totalHours,
      utilisation,
      utilisationRag,
      wipValueRecorded,
      billedRevenue,
      effectiveRate,
      writeOffRate,
      recordingGapDays,
      matterCount,
      scorecard,
      scorecardRag,
      employmentCost,
      revenueMultiple,
      profit,
      // Recording pattern not available from kpi_snapshots — requires raw time entries
      recordingPattern: lastNWorkingDays(20).map(date => ({ date, hasEntries: false })),
    };
  });

  // Apply filters — department/grade/payModel now null so those filters are no-ops
  // until enrichment is extended; activeOnly is safe since all rows have isActive=true
  if (filters.department) allRows = allRows.filter(r => r.department === filters.department);
  if (filters.grade)      allRows = allRows.filter(r => r.grade === filters.grade);
  if (filters.payModel)   allRows = allRows.filter(r => r.payModel === filters.payModel);
  if (filters.activeOnly) allRows = allRows.filter(r => r.isActive);

  const { items: paged, totalCount } = paginate(allRows, filters.limit, filters.offset);

  // Alerts: recording gap > 5 days
  const alerts = allRows
    .filter(r => (r.recordingGapDays ?? 0) > 5)
    .map(r => ({
      feeEarnerId: r.id,
      name: r.name,
      type: 'recording_gap',
      message: `No time entries for ${r.recordingGapDays} days`,
    }));

  const allDepts     = [...new Set(allRows.map(r => r.department).filter(Boolean))];
  const allGrades    = [...new Set(allRows.map(r => r.grade).filter(Boolean))];
  const allPayModels = [...new Set(allRows.map(r => r.payModel).filter(Boolean))];

  const utilisationTarget = (weeklyTarget / (weeklyTarget + 7.5)) * 100;

  return {
    alerts,
    feeEarners: paged,
    pagination: { totalCount, limit: filters.limit ?? 50, offset: filters.offset ?? 0 },
    charts: {
      utilisationBars: paged.map(r => ({ name: r.name, value: r.utilisation, target: utilisationTarget, ragStatus: r.utilisationRag })),
      chargeableStack: paged.map(r => ({ name: r.name, chargeable: r.chargeableHours, nonChargeable: r.totalHours - r.chargeableHours })),
    },
    filters: { departments: allDepts, grades: allGrades, payModels: allPayModels },
  };
}

// ---------------------------------------------------------------------------
// 3. getWipData
// ---------------------------------------------------------------------------

export async function getWipData(
  firmId: string,
  filters: DashboardFilters = {},
): Promise<WipPayload> {
  const availableKeys = await getAvailableKpiKeys(firmId, 'matter');
  console.log('[dashboard/wip] matter kpi_keys:', availableKeys);

  const [data, firmConfig] = await Promise.all([loadDashboardData(firmId), getFirmConfig(firmId)]);
  const { matters, timeEntries, disbursements, enrichedMatters } = data;
  const ragThresholds = firmConfig.ragThresholds ?? [];

  const enrichedMatterMap = new Map<string, Record<string, unknown>>();
  for (const em of enrichedMatters) {
    const id = (em['matterId'] ?? em['matterNumber']) as string | undefined;
    if (id) enrichedMatterMap.set(id, em);
  }

  // Apply filters
  let filteredMatters = matters;
  if (filters.department) {
    filteredMatters = filteredMatters.filter(m => {
      const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
      return em?.['department'] === filters.department;
    });
  }
  if (filters.feeEarner) {
    filteredMatters = filteredMatters.filter(m => {
      const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
      return em?.['responsibleLawyer'] === filters.feeEarner;
    });
  }
  if (filters.caseType) {
    filteredMatters = filteredMatters.filter(m => {
      const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
      return em?.['caseType'] === filters.caseType;
    });
  }
  if (filters.minValue != null) {
    filteredMatters = filteredMatters.filter(m => m.wipTotalBillable >= (filters.minValue ?? 0));
  }

  // Age bands
  const bandAcc = new Map<string, { value: number; count: number }>(WIP_BANDS.map(b => [b.band, { value: 0, count: 0 }]));
  for (const m of filteredMatters) {
    const band = classifyWipAge(m.wipAgeInDays ?? null);
    const acc = bandAcc.get(band.band)!;
    acc.value += m.wipTotalBillable;
    acc.count += 1;
  }
  const ageBands = WIP_BANDS.map(b => ({
    ...b, value: bandAcc.get(b.band)?.value ?? 0, count: bandAcc.get(b.band)?.count ?? 0,
  }));

  // By department
  const deptMap = new Map<string, { value: number; count: number }>();
  for (const m of filteredMatters) {
    const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
    const dept = (em?.['department'] as string | undefined) ?? 'Unknown';
    const acc = deptMap.get(dept) ?? { value: 0, count: 0 };
    acc.value += m.wipTotalBillable;
    acc.count += 1;
    deptMap.set(dept, acc);
  }
  const byDepartment = [...deptMap.entries()].map(([name, { value, count }]) => ({ name, value, count }));

  // Write-off analysis
  const totalWipValue = filteredMatters.reduce((s, m) => s + m.wipTotalBillable, 0);
  const totalWriteOff = filteredMatters.reduce((s, m) => s + m.wipTotalWriteOff, 0);
  const writeOffRate = totalWipValue > 0 ? (totalWriteOff / totalWipValue) * 100 : 0;

  // Disbursement exposure
  const totalExposure = disbursements.reduce((s, d) => {
    const dr = d as unknown as Record<string, unknown>;
    return s + ((dr['firmExposure'] as number | undefined) ?? 0);
  }, 0);
  const disbByMatter = new Map<string, { value: number; age: number; clientName: string }>();
  for (const d of disbursements) {
    const dr = d as unknown as Record<string, unknown>;
    const mNum = (dr['matterNumber'] as string | undefined) ?? '';
    const exposure = (dr['firmExposure'] as number | undefined) ?? 0;
    const age = (d.ageInDays ?? 0) as number;
    const existing = disbByMatter.get(mNum) ?? { value: 0, age: 0, clientName: (dr['clientName'] as string | undefined) ?? 'Unknown' };
    disbByMatter.set(mNum, { value: existing.value + exposure, age: Math.max(existing.age, age), clientName: existing.clientName });
  }

  // Entries grouped
  const groupBy = filters.groupBy ?? 'matter';
  const groupMap = new Map<string, { label: string; value: number; hours: number; ageSum: number; count: number; entries: typeof timeEntries }>();

  for (const te of timeEntries) {
    const teRec = te as unknown as Record<string, unknown>;
    let groupKey = '';
    let groupLabel = '';
    if (groupBy === 'feeEarner') {
      groupKey = (te.lawyerName ?? teRec['responsibleLawyer'] as string | undefined) ?? 'Unknown';
      groupLabel = groupKey;
    } else if (groupBy === 'client') {
      groupKey = (te.clientName ?? 'Unknown') as string;
      groupLabel = groupKey;
    } else {
      groupKey = (teRec['matterNumber'] as string | undefined) ?? (teRec['matterId'] as string | undefined) ?? 'Unknown';
      groupLabel = `Matter ${groupKey}`;
    }
    const existing = groupMap.get(groupKey) ?? { label: groupLabel, value: 0, hours: 0, ageSum: 0, count: 0, entries: [] };
    existing.value += (te.recordedValue ?? 0) as number;
    existing.hours += (te.durationHours ?? 0) as number;
    existing.ageSum += (te.ageInDays ?? 0) as number;
    existing.count += 1;
    existing.entries.push(te);
    groupMap.set(groupKey, existing);
  }

  const allGroups = [...groupMap.entries()].map(([key, g]) => ({
    groupKey: key,
    groupLabel: g.label,
    totalValue: g.value,
    totalHours: g.hours,
    avgAge: g.count > 0 ? g.ageSum / g.count : 0,
    entryCount: g.count,
    ragStatus: RagStatus.NEUTRAL,
    details: g.entries.slice(0, 20).map(te => {
      const teRec = te as unknown as Record<string, unknown>;
      return {
        entryId: (teRec['id'] as string | undefined) ?? '',
        date: (teRec['date'] as string | undefined) ?? '',
        lawyerName: (te.lawyerName ?? 'Unknown') as string,
        hours: (te.durationHours ?? 0) as number,
        value: (te.recordedValue ?? 0) as number,
        age: (te.ageInDays ?? 0) as number,
        rate: (teRec['rate'] as number | undefined) ?? 0,
        doNotBill: (teRec['doNotBill'] as boolean | undefined) ?? false,
      };
    }),
  }));

  const { items: pagedGroups, totalCount } = paginate(allGroups, filters.limit, filters.offset);

  const atRiskValue = ageBands.slice(2).reduce((s, b) => s + b.value, 0);
  const totalUnbilledWip = totalWipValue;
  const atRiskPct = totalUnbilledWip > 0 ? (atRiskValue / totalUnbilledWip) * 100 : 0;

  const allDepts    = [...new Set(enrichedMatters.map(em => (em['department'] as string | undefined) ?? '').filter(Boolean))];
  const allLawyers  = [...new Set(enrichedMatters.map(em => (em['responsibleLawyer'] as string | undefined) ?? '').filter(Boolean))];
  const allCaseTypes = [...new Set(enrichedMatters.map(em => (em['caseType'] as string | undefined) ?? '').filter(Boolean))];

  return {
    headlines: {
      totalUnbilledWip: { value: totalUnbilledWip, grossValue: totalUnbilledWip + totalWriteOff, netValue: totalUnbilledWip },
      atRisk: { value: atRiskValue, percentage: atRiskPct, ragStatus: applyRagThreshold(atRiskPct, getThresholdDefaults(ragThresholds, 'wipAge')) },
      estimatedLeakage: { value: Math.round(atRiskValue * 0.3), methodology: 'average-of-ages × 30% loss rate for 61+ day WIP' },
    },
    ageBands,
    byDepartment,
    entries: pagedGroups,
    pagination: { totalCount, limit: filters.limit ?? 50, offset: filters.offset ?? 0 },
    writeOffAnalysis: {
      totalWriteOff,
      writeOffRate,
      ragStatus: applyRagThreshold(writeOffRate, getThresholdDefaults(ragThresholds, 'writeOffRate')),
      byFeeEarner: [],
      byCaseType: [],
    },
    disbursementExposure: {
      totalExposure,
      byMatter: [...disbByMatter.entries()].map(([matterNumber, { value, age, clientName }]) => ({ matterNumber, clientName, value, age })),
    },
    filters: { departments: allDepts, feeEarners: allLawyers, caseTypes: allCaseTypes },
  };
}

// ---------------------------------------------------------------------------
// 4. getBillingCollectionsData
// ---------------------------------------------------------------------------

export async function getBillingCollectionsData(
  firmId: string,
  filters: DashboardFilters = {},
): Promise<BillingPayload> {
  const availableKeys = await getAvailableKpiKeys(firmId, 'invoice');
  console.log('[dashboard/billing] invoice kpi_keys:', availableKeys);

  const [firmSnaps, data] = await Promise.all([
    getKpiSnapshots(firmId, { entityType: 'firm', period: 'current' }),
    loadDashboardData(firmId),
  ]);
  const { firm, invoices } = data;

  const firmByEntity = groupSnapshotsByEntity(firmSnaps);
  const firmSnap     = firmByEntity.get(firmId) ?? firmByEntity.values().next().value;

  // Apply filters
  let filteredInvoices = invoices;
  if (filters.department) {
    filteredInvoices = filteredInvoices.filter(inv => {
      const invRec = inv as unknown as Record<string, unknown>;
      return invRec['department'] === filters.department;
    });
  }
  if (filters.feeEarner) {
    filteredInvoices = filteredInvoices.filter(inv => {
      const invRec = inv as unknown as Record<string, unknown>;
      return invRec['responsibleLawyer'] === filters.feeEarner;
    });
  }

  // Invoice metrics
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const currentPeriod = filteredInvoices.filter(inv => {
    const invRec = inv as unknown as Record<string, unknown>;
    const dateStr = toDateString(invRec['invoiceDate']);
    if (!dateStr) return false;
    return new Date(dateStr) >= periodStart;
  });
  const invoicedPeriodValue = currentPeriod.reduce((s, inv) => s + ((inv as unknown as Record<string, unknown>)['total'] as number ?? 0), 0);
  const collectedPeriodValue = currentPeriod.reduce((s, inv) => s + ((inv as unknown as Record<string, unknown>)['paid'] as number ?? 0), 0);

  // Aged debtors
  const DEBTOR_BANDS = [
    { band: '0–30 days',   colour: '#09B5B5', min: 0,   max: 30  },
    { band: '31–60 days',  colour: '#4BC8C8', min: 31,  max: 60  },
    { band: '61–90 days',  colour: '#E49060', min: 61,  max: 90  },
    { band: '91–120 days', colour: '#E4607B', min: 91,  max: 120 },
    { band: '120+ days',   colour: '#C04060', min: 121, max: null as number | null },
  ];
  const debtorBandMap = new Map<string, { value: number; count: number }>(DEBTOR_BANDS.map(b => [b.band, { value: 0, count: 0 }]));
  for (const inv of filteredInvoices) {
    const invRec = inv as unknown as Record<string, unknown>;
    const outstanding = (invRec['outstanding'] as number | undefined) ?? 0;
    if (outstanding <= 0) continue;
    const days = (inv.daysOutstanding ?? 0) as number;
    const band = DEBTOR_BANDS.find(b => days >= b.min && (b.max === null || days <= b.max)) ?? DEBTOR_BANDS[DEBTOR_BANDS.length - 1];
    const acc = debtorBandMap.get(band.band)!;
    acc.value += outstanding;
    acc.count += 1;
  }
  const agedDebtors = DEBTOR_BANDS.map(b => ({
    band: b.band, colour: b.colour,
    value: debtorBandMap.get(b.band)?.value ?? 0,
    count: debtorBandMap.get(b.band)?.count ?? 0,
  }));

  // Billing trend (group by month)
  const trendMap = new Map<string, { invoiced: number; collected: number; writeOff: number }>();
  for (const inv of filteredInvoices) {
    const invRec = inv as unknown as Record<string, unknown>;
    const dateStr = toDateString(invRec['invoiceDate']);
    if (!dateStr) continue;
    const period = dateStr.slice(0, 7);
    const acc = trendMap.get(period) ?? { invoiced: 0, collected: 0, writeOff: 0 };
    acc.invoiced += (invRec['total'] as number | undefined) ?? 0;
    acc.collected += (invRec['paid'] as number | undefined) ?? 0;
    acc.writeOff += (invRec['writtenOff'] as number | undefined) ?? 0;
    trendMap.set(period, acc);
  }
  const billingTrend = [...trendMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([period, v]) => ({ period, ...v }));

  // Invoice rows
  const allInvoiceRows = filteredInvoices.map(inv => {
    const invRec = inv as unknown as Record<string, unknown>;
    const outstanding = (invRec['outstanding'] as number | undefined) ?? 0;
    const rag = outstanding > 0 && inv.isOverdue ? RagStatus.RED : outstanding > 0 ? RagStatus.AMBER : RagStatus.GREEN;
    return {
      invoiceNumber: (invRec['invoiceNumber'] as string | null | undefined) ?? null,
      clientName: (inv.clientName as string | undefined) ?? (invRec['clients'] as string | undefined) ?? 'Unknown',
      matterNumber: String((invRec['matterNumber'] as unknown) ?? ''),
      invoiceDate: toDateString(invRec['invoiceDate']) ?? '',
      total: (invRec['total'] as number | undefined) ?? 0,
      outstanding,
      paid: (invRec['paid'] as number | undefined) ?? 0,
      daysOutstanding: inv.daysOutstanding ?? null,
      ageBand: inv.ageBand ?? null,
      ragStatus: rag,
      isOverdue: inv.isOverdue,
    };
  });

  const { items: pagedInvoices, totalCount } = paginate(allInvoiceRows, filters.limit, filters.offset);

  const hasDatePaid = filteredInvoices.some(inv => !!(inv as unknown as Record<string, unknown>)['datePaid']);
  const slowPayers = hasDatePaid ? [] : null;

  // Firm totals — prefer kpi_snapshots, fall back to MongoDB aggregate
  const totalWipValue     = kpiNum(firmSnap, 'totalWipValue') || firm.totalWipValue;
  const totalOutstanding  = kpiNum(firmSnap, 'totalOutstanding') || firm.totalOutstanding;
  const totalInvoiced     = kpiNum(firmSnap, 'totalInvoicedRevenue') || firm.totalInvoicedRevenue;
  const totalPaid         = kpiNum(firmSnap, 'totalPaid') || firm.totalPaid;
  const totalWriteOffValue = kpiNum(firmSnap, 'totalWriteOffValue') || firm.totalWriteOffValue;
  const lockupDays        = kpiNumOrNull(firmSnap, 'F-WL-04');

  const allDepts   = [...new Set(filteredInvoices.map(inv => ((inv as unknown as Record<string, unknown>)['department'] as string | undefined) ?? '').filter(Boolean))];
  const allLawyers = [...new Set(filteredInvoices.map(inv => ((inv as unknown as Record<string, unknown>)['responsibleLawyer'] as string | undefined) ?? '').filter(Boolean))];

  const collectionRate = invoicedPeriodValue > 0 ? (collectedPeriodValue / invoicedPeriodValue) * 100 : 0;

  return {
    headlines: {
      invoicedPeriod:  { value: invoicedPeriodValue,  count: currentPeriod.length },
      collectedPeriod: { value: collectedPeriodValue, rate: collectionRate },
      totalOutstanding: { value: totalOutstanding },
    },
    pipeline: {
      wip:       { value: totalWipValue,  avgDays: lockupDays },
      invoiced:  { value: totalInvoiced,  avgDaysToPayment: null },
      paid:      { value: totalPaid },
      writtenOff: { value: totalWriteOffValue, rate: totalWipValue > 0 ? (totalWriteOffValue / totalWipValue) * 100 : 0 },
      totalLockup: lockupDays ?? 0,
    },
    agedDebtors,
    billingTrend,
    invoices: pagedInvoices,
    pagination: { totalCount, limit: filters.limit ?? 50, offset: filters.offset ?? 0 },
    slowPayers,
    filters: { departments: allDepts, feeEarners: allLawyers },
  };
}

// ---------------------------------------------------------------------------
// 5. getMatterAnalysisData
// ---------------------------------------------------------------------------

export async function getMatterAnalysisData(
  firmId: string,
  filters: DashboardFilters = {},
): Promise<MatterPayload> {
  const availableKeys = await getAvailableKpiKeys(firmId, 'matter');
  console.log('[dashboard/matters] matter kpi_keys:', availableKeys);

  const [matterSnaps, data, firmConfig] = await Promise.all([
    getKpiSnapshots(firmId, { entityType: 'matter', period: 'current' }),
    loadDashboardData(firmId),
    getFirmConfig(firmId),
  ]);

  const { matters, enrichedMatters, timeEntries, invoices } = data;
  const ragThresholds = firmConfig.ragThresholds ?? [];
  const matterByEntity = groupSnapshotsByEntity(matterSnaps);

  const enrichedMatterMap = new Map<string, Record<string, unknown>>();
  for (const em of enrichedMatters) {
    const id = (em['matterId'] ?? em['matterNumber']) as string | undefined;
    if (id) enrichedMatterMap.set(id, em);
  }

  // Apply filters
  let filtered = matters;
  if (filters.department) filtered = filtered.filter(m => { const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? ''); return em?.['department'] === filters.department; });
  if (filters.caseType)   filtered = filtered.filter(m => { const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? ''); return em?.['caseType'] === filters.caseType; });
  if (filters.status)     filtered = filtered.filter(m => { const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? ''); return em?.['matterStatus'] === filters.status; });
  if (filters.lawyer)     filtered = filtered.filter(m => { const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? ''); return em?.['responsibleLawyer'] === filters.lawyer; });
  if (filters.hasBudget)  filtered = filtered.filter(m => { const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? ''); return ((em?.['matterBudget'] as number | undefined) ?? 0) > 0; });

  // Matters at risk
  const mattersAtRisk = filtered
    .filter(m => {
      const wipAge = m.wipAgeInDays ?? 0;
      const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
      const budget = (em?.['matterBudget'] as number | undefined) ?? 0;
      const budgetBurn = budget > 0 ? (m.wipTotalBillable / budget) * 100 : null;
      const realisation = m.invoicedNetBilling > 0 && m.wipTotalBillable > 0 ? (m.invoicedNetBilling / m.wipTotalBillable) * 100 : null;
      return wipAge > 60 || (budgetBurn !== null && budgetBurn > 100) || (realisation !== null && realisation < 70);
    })
    .map(m => {
      const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
      const wipAge = m.wipAgeInDays ?? 0;
      const budget = (em?.['matterBudget'] as number | undefined) ?? 0;
      const budgetBurn = budget > 0 ? (m.wipTotalBillable / budget) * 100 : null;
      const realisation = m.invoicedNetBilling > 0 && m.wipTotalBillable > 0 ? (m.invoicedNetBilling / m.wipTotalBillable) * 100 : null;
      let primaryIssue = `WIP age ${wipAge} days`;
      if (budgetBurn !== null && budgetBurn > 100) primaryIssue = `Budget ${Math.round(budgetBurn)}% consumed`;
      else if (realisation !== null && realisation < 70) primaryIssue = `Realisation ${Math.round(realisation)}%`;
      const snap = matterByEntity.get(m.matterId ?? m.matterNumber ?? '');
      const ragStatus = kpiRag(snap, 'F-WL-01');
      return {
        matterId: m.matterId ?? '',
        matterNumber: m.matterNumber ?? '',
        clientName: (em?.['clientName'] as string | undefined) ?? 'Unknown',
        caseType: (em?.['caseType'] as string | undefined) ?? 'Unknown',
        responsibleLawyer: (em?.['responsibleLawyer'] as string | undefined) ?? 'Unknown',
        supervisor: (em?.['responsibleSupervisor'] as string | undefined) ?? '',
        primaryIssue,
        ragStatus,
        wipValue: m.wipTotalBillable,
        wipAge,
      };
    })
    .slice(0, 20);

  // Build time entry / invoice index per matter
  const teByMatter = new Map<string, typeof timeEntries>();
  for (const te of timeEntries) {
    const teRec = te as unknown as Record<string, unknown>;
    const key = (teRec['matterNumber'] as string | undefined) ?? (teRec['matterId'] as string | undefined) ?? '';
    if (!teByMatter.has(key)) teByMatter.set(key, []);
    teByMatter.get(key)!.push(te);
  }
  const invByMatter = new Map<string, typeof invoices>();
  for (const inv of invoices) {
    const invRec = inv as unknown as Record<string, unknown>;
    const key = String((invRec['matterNumber'] as unknown) ?? '');
    if (!invByMatter.has(key)) invByMatter.set(key, []);
    invByMatter.get(key)!.push(inv);
  }

  const { items: paged, totalCount } = paginate(filtered, filters.limit, filters.offset);

  const rows: MatterRow[] = paged.map(m => {
    const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
    const snap = matterByEntity.get(m.matterId ?? m.matterNumber ?? '');
    const budget = (em?.['matterBudget'] as number | undefined) ?? null;
    const budgetBurn = budget && budget > 0 ? (m.wipTotalBillable / budget) * 100 : null;
    const realisation = m.wipTotalBillable > 0 ? (m.invoicedNetBilling / m.wipTotalBillable) * 100 : null;
    const profit = kpiNumOrNull(snap, 'F-PR-01');
    const healthScore = kpiNumOrNull(snap, 'F-CS-03');
    const matterKey = m.matterNumber ?? m.matterId ?? '';
    const matterTEs = teByMatter.get(matterKey) ?? [];
    const matterInvs = invByMatter.get(matterKey) ?? [];

    return {
      matterId: m.matterId ?? '',
      matterNumber: m.matterNumber ?? '',
      clientName: (em?.['clientName'] as string | undefined) ?? 'Unknown',
      caseType: (em?.['caseType'] as string | undefined) ?? 'Unknown',
      department: (em?.['department'] as string | undefined) ?? 'Unknown',
      responsibleLawyer: (em?.['responsibleLawyer'] as string | undefined) ?? 'Unknown',
      supervisor: (em?.['responsibleSupervisor'] as string | undefined) ?? '',
      status: (em?.['matterStatus'] as string | undefined) ?? 'Unknown',
      budget,
      wipTotalBillable: m.wipTotalBillable,
      netBilling: m.invoicedNetBilling,
      unbilledBalance: m.wipTotalBillable - m.invoicedNetBilling,
      wipAge: m.wipAgeInDays,
      budgetBurn,
      budgetBurnRag: budgetBurn !== null ? applyRagThreshold(budgetBurn, getThresholdDefaults(ragThresholds, 'budgetBurn')) : null,
      realisation,
      realisationRag: kpiRag(snap, 'F-RB-01'),
      healthScore,
      healthRag: kpiRag(snap, 'F-CS-03'),
      wipEntries: matterTEs.slice(0, 20).map(te => {
        const teRec = te as unknown as Record<string, unknown>;
        return { date: toDateString(teRec['date']) ?? '', lawyerName: (te.lawyerName ?? 'Unknown') as string, hours: (te.durationHours ?? 0) as number, value: (te.recordedValue ?? 0) as number, rate: (teRec['rate'] as number | undefined) ?? 0 };
      }),
      invoices: matterInvs.slice(0, 10).map(inv => {
        const invRec = inv as unknown as Record<string, unknown>;
        return { invoiceNumber: (invRec['invoiceNumber'] as string | null | undefined) ?? null, date: toDateString(invRec['invoiceDate']) ?? '', total: (invRec['total'] as number | undefined) ?? 0, outstanding: (invRec['outstanding'] as number | undefined) ?? 0, paid: (invRec['paid'] as number | undefined) ?? 0 };
      }),
      profitability: {
        revenue: m.invoicedNetBilling,
        revenueSource: m.invoicedNetBilling > 0 ? 'invoiced' : 'wip_billable',
        labourCost: 0,
        labourBreakdown: [],
        disbursementCost: m.invoicedDisbursements,
        overhead: null,
        profit: profit ?? (m.invoicedNetBilling - m.invoicedDisbursements),
        margin: m.invoicedNetBilling > 0 ? ((m.invoicedNetBilling - m.invoicedDisbursements) / m.invoicedNetBilling) * 100 : 0,
        discrepancy: m.discrepancy ? { yaoValue: m.invoicedNetBilling, derivedValue: m.wipTotalBillable, difference: m.discrepancy.billingDifference } : null,
      },
    };
  });

  // By case type
  const caseTypeMap = new Map<string, { count: number; totWip: number; realisations: number[]; ages: number[] }>();
  for (const m of filtered) {
    const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
    const ct = (em?.['caseType'] as string | undefined) ?? 'Unknown';
    const acc = caseTypeMap.get(ct) ?? { count: 0, totWip: 0, realisations: [], ages: [] };
    acc.count++;
    acc.totWip += m.wipTotalBillable;
    if (m.wipTotalBillable > 0 && m.invoicedNetBilling > 0) acc.realisations.push((m.invoicedNetBilling / m.wipTotalBillable) * 100);
    if (m.wipAgeInDays != null) acc.ages.push(m.wipAgeInDays);
    caseTypeMap.set(ct, acc);
  }
  const byCaseType = [...caseTypeMap.entries()].map(([name, v]) => ({
    name,
    count: v.count,
    avgRealisation: v.realisations.length > 0 ? v.realisations.reduce((s, x) => s + x, 0) / v.realisations.length : null,
    avgWipAge: v.ages.length > 0 ? v.ages.reduce((s, x) => s + x, 0) / v.ages.length : null,
    totalWip: v.totWip,
    ragStatus: RagStatus.NEUTRAL,
  }));

  // By department
  const deptMatterMap = new Map<string, { count: number; totalWip: number }>();
  for (const m of filtered) {
    const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
    const dept = (em?.['department'] as string | undefined) ?? 'Unknown';
    const acc = deptMatterMap.get(dept) ?? { count: 0, totalWip: 0 };
    acc.count++;
    acc.totalWip += m.wipTotalBillable;
    deptMatterMap.set(dept, acc);
  }
  const byDepartment = [...deptMatterMap.entries()].map(([name, v]) => ({ name, count: v.count, totalWip: v.totalWip, avgMargin: null }));

  const allDepts     = [...new Set(enrichedMatters.map(em => (em['department'] as string | undefined) ?? '').filter(Boolean))];
  const allCaseTypes = [...new Set(enrichedMatters.map(em => (em['caseType'] as string | undefined) ?? '').filter(Boolean))];
  const allStatuses  = [...new Set(enrichedMatters.map(em => (em['matterStatus'] as string | undefined) ?? '').filter(Boolean))];
  const allLawyers   = [...new Set(enrichedMatters.map(em => (em['responsibleLawyer'] as string | undefined) ?? '').filter(Boolean))];

  return {
    mattersAtRisk,
    matters: rows,
    pagination: { totalCount, limit: filters.limit ?? 50, offset: filters.offset ?? 0 },
    byCaseType,
    byDepartment,
    filters: { departments: allDepts, caseTypes: allCaseTypes, statuses: allStatuses, lawyers: allLawyers },
  };
}

// ---------------------------------------------------------------------------
// 6. getClientIntelligenceData
// ---------------------------------------------------------------------------

export async function getClientIntelligenceData(
  firmId: string,
  filters: DashboardFilters = {},
): Promise<ClientPayload> {
  const availableKeys = await getAvailableKpiKeys(firmId, 'client');
  console.log('[dashboard/clients] client kpi_keys:', availableKeys);

  const data = await loadDashboardData(firmId);
  const { clients, matters, enrichedMatters, invoices } = data;

  const enrichedMatterMap = new Map<string, Record<string, unknown>>();
  for (const em of enrichedMatters) {
    const id = (em['matterId'] ?? em['matterNumber']) as string | undefined;
    if (id) enrichedMatterMap.set(id, em);
  }

  // Index matters and invoices by client
  const mattersByClient = new Map<string, AggregatedMatter[]>();
  for (const m of matters) {
    const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
    const clientName = (em?.['clientName'] as string | undefined) ?? (em?.['displayName'] as string | undefined) ?? 'Unknown';
    if (!mattersByClient.has(clientName)) mattersByClient.set(clientName, []);
    mattersByClient.get(clientName)!.push(m);
  }
  const invoicesByClient = new Map<string, (typeof invoices)[0][]>();
  for (const inv of invoices) {
    const invRec = inv as unknown as Record<string, unknown>;
    const clientName = (inv.clientName as string | undefined) ?? (invRec['clients'] as string | undefined) ?? 'Unknown';
    if (!invoicesByClient.has(clientName)) invoicesByClient.set(clientName, []);
    invoicesByClient.get(clientName)!.push(inv);
  }

  // Apply filters
  let filteredClients = clients;
  if (filters.minMatters != null) filteredClients = filteredClients.filter(c => c.matterCount >= (filters.minMatters ?? 0));
  if (filters.minRevenue != null) filteredClients = filteredClients.filter(c => c.totalInvoiced >= (filters.minRevenue ?? 0));
  if (filters.department) {
    filteredClients = filteredClients.filter(c => {
      const clientName = c.clientName ?? c.displayName ?? '';
      const clientMatters = mattersByClient.get(clientName) ?? [];
      return clientMatters.some(m => {
        const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
        return em?.['department'] === filters.department;
      });
    });
  }

  const { items: paged, totalCount } = paginate(filteredClients, filters.limit, filters.offset);

  const rows = paged.map(c => {
    const clientName = c.clientName ?? c.displayName ?? 'Unknown';
    const clientMatters = mattersByClient.get(clientName) ?? [];
    const clientInvoices = invoicesByClient.get(clientName) ?? [];
    const totalRevenue = c.totalInvoiced;
    const depts = [...new Set(clientMatters.flatMap(m => {
      const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
      return [(em?.['department'] as string | undefined) ?? 'Unknown'];
    }))];

    return {
      clientName,
      contactId: c.contactId ?? null,
      matterCount: c.matterCount,
      departments: depts,
      totalRevenue,
      totalCost: null,
      grossMargin: null,
      marginPercent: null,
      marginRag: null,
      totalOutstanding: c.totalOutstanding,
      avgLockupDays: null,
      matters: clientMatters.slice(0, 10).map(m => {
        const em = enrichedMatterMap.get(m.matterId ?? '') ?? enrichedMatterMap.get(m.matterNumber ?? '');
        return {
          matterNumber: m.matterNumber ?? '',
          caseType: (em?.['caseType'] as string | undefined) ?? 'Unknown',
          status: (em?.['matterStatus'] as string | undefined) ?? 'Unknown',
          netBilling: m.invoicedNetBilling,
          wipValue: m.wipTotalBillable,
          realisation: m.wipTotalBillable > 0 ? (m.invoicedNetBilling / m.wipTotalBillable) * 100 : null,
        };
      }),
      feeEarners: [],
      invoices: clientInvoices.slice(0, 10).map(inv => {
        const invRec = inv as unknown as Record<string, unknown>;
        return {
          invoiceNumber: (invRec['invoiceNumber'] as string | null | undefined) ?? null,
          date: toDateString(invRec['invoiceDate']) ?? '',
          total: (invRec['total'] as number | undefined) ?? 0,
          outstanding: (invRec['outstanding'] as number | undefined) ?? 0,
        };
      }),
    };
  });

  const sortedByRevenue     = [...filteredClients].sort((a, b) => b.totalInvoiced - a.totalInvoiced);
  const sortedByOutstanding = [...filteredClients].sort((a, b) => b.totalOutstanding - a.totalOutstanding);
  const allDepts = [...new Set(enrichedMatters.map(em => (em['department'] as string | undefined) ?? '').filter(Boolean))];

  return {
    headlines: {
      totalClients: filteredClients.length,
      topClient: sortedByRevenue[0] ? { name: sortedByRevenue[0].clientName ?? sortedByRevenue[0].displayName ?? 'Unknown', revenue: sortedByRevenue[0].totalInvoiced } : null,
      mostAtRisk: sortedByOutstanding[0]?.totalOutstanding > 0 ? { name: sortedByOutstanding[0].clientName ?? sortedByOutstanding[0].displayName ?? 'Unknown', outstanding: sortedByOutstanding[0].totalOutstanding, oldestDebt: 0 } : null,
    },
    clients: rows,
    pagination: { totalCount, limit: filters.limit ?? 50, offset: filters.offset ?? 0 },
    topByRevenue: sortedByRevenue.slice(0, 10).map(c => ({ name: c.clientName ?? c.displayName ?? 'Unknown', value: c.totalInvoiced })),
    topByOutstanding: sortedByOutstanding.slice(0, 10).map(c => ({ name: c.clientName ?? c.displayName ?? 'Unknown', value: c.totalOutstanding })),
    filters: { departments: allDepts, minMattersOptions: [1, 2, 5, 10] },
  };
}
