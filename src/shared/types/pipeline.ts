// src/shared/types/pipeline.ts
// Pipeline-specific types for Stages 2–8.
// Separate from index.ts (entity/config types) to avoid circular imports.

import type { ColumnMapping } from './index.js';
import type {
  EnrichedTimeEntry,
  EnrichedMatter,
  EnrichedFeeEarner,
  EnrichedInvoice,
  EnrichedClient,
  EnrichedDisbursement,
  EnrichedTask,
  EnrichedDepartment,
} from './enriched.js';

// =============================================================================
// Stage 2: Normalise
// =============================================================================

export type MappingSet = ColumnMapping[];

export interface NormaliseOptions {
  dateReferencePoint?: Date;           // used for age calculations — defaults to today
  currencySymbols?: string[];
  treatEmptyStringAsNull?: boolean;    // default true
  strictMode?: boolean;                // if true, reject rows with any null required field
                                       // if false (default), keep row + flag it
}

export interface RejectedRow {
  rowIndex: number;
  rawRow: Record<string, unknown>;
  reason: string;
}

export interface NormaliseWarning {
  field: string;
  message: string;
  affectedRowCount: number;
}

export interface FieldStats {
  fieldKey: string;
  totalRows: number;
  nullCount: number;
  nullPercent: number;
  uniqueValueCount: number;
  sampleValues: unknown[];
}

/**
 * A single normalised record. All identifier fields are optional — the
 * cross-reference engine fills in the missing forms. Fields prefixed with _
 * are metadata (data provenance) and must never be shown to end users.
 */
export interface NormalisedRecord {
  // --- Matter identifiers ---
  matterId?: string;
  matterNumber?: string;
  _matterIdSource?: 'original' | 'cross_reference';
  _matterNumberSource?: 'original' | 'cross_reference';

  // --- Fee earner identifiers (WIP / time entries) ---
  lawyerId?: string;
  lawyerName?: string;
  _lawyerIdSource?: 'original' | 'cross_reference';
  _lawyerNameSource?: 'original' | 'cross_reference';

  // --- Responsible lawyer (matters / invoices use this field name) ---
  responsibleLawyerId?: string;
  responsibleLawyer?: string;
  _responsibleLawyerIdSource?: 'original' | 'cross_reference';
  _responsibleLawyerNameSource?: 'original' | 'cross_reference';

  // --- Client identifiers ---
  contactId?: string;
  displayName?: string;
  _contactIdSource?: 'original' | 'cross_reference';
  _displayNameSource?: 'original' | 'cross_reference';

  // --- Department identifiers ---
  departmentId?: string;
  department?: string;
  _departmentIdSource?: 'original' | 'cross_reference';
  _departmentNameSource?: 'original' | 'cross_reference';

  // All other domain fields (billing, dates, etc.)
  [key: string]: unknown;
}

/** Output of Stage 2 (Normalise). One NormaliseResult per uploaded file type. */
export interface NormaliseResult {
  fileType: string;
  records: NormalisedRecord[];
  recordCount: number;
  normalisedAt: string; // ISO timestamp
  // Populated by normaliseRecords() — absent when NormaliseResult is constructed directly
  rejectedRows?: RejectedRow[];
  warnings?: NormaliseWarning[];
  fieldStats?: Record<string, FieldStats>;
}

// =============================================================================
// Stage 3: Cross-Reference
// =============================================================================

export interface CrossReferenceRegistry {
  firmId: string;
  builtAt: string; // ISO timestamp

  matters: {
    idToNumber: Map<string, string>;   // matterId (UUID) → matterNumber (string)
    numberToId: Map<string, string>;   // matterNumber → matterId
    confidence: Map<string, 'certain' | 'inferred'>;  // keyed by matterId
    sourceDatasets: Map<string, string[]>;             // matterId → dataset names
  };

  feeEarners: {
    idToName: Map<string, string>;     // lawyerId → canonical display name
    nameToId: Map<string, string>;     // normalised name variant → lawyerId
    nameVariants: Map<string, string>; // name variant → canonical name
    confidence: Map<string, 'certain' | 'inferred'>;
    sourceDatasets: Map<string, string[]>;
  };

  clients: {
    idToName: Map<string, string>;     // contactId → displayName
    nameToId: Map<string, string>;     // normalised displayName → contactId
    confidence: Map<string, 'certain' | 'inferred'>;
    sourceDatasets: Map<string, string[]>;
  };

  departments: {
    idToName: Map<string, string>;     // departmentId → name
    nameToId: Map<string, string>;     // normalised name → departmentId
    confidence: Map<string, 'certain' | 'inferred'>;
    sourceDatasets: Map<string, string[]>;
  };

  stats: CrossReferenceStats;
}

export interface CrossReferenceStats {
  matters: {
    totalMappings: number;
    certainMappings: number;
    inferredMappings: number;
    conflictingMappings: number;
    conflicts: CrossReferenceConflict[];
  };
  feeEarners: {
    totalMappings: number;
    certainMappings: number;
    nameVariantsResolved: number;
    unresolvedLawyerNames: string[];
  };
  clients: {
    totalMappings: number;
    certainMappings: number;
    inferredMappings: number;
  };
  departments: {
    totalMappings: number;
    certainMappings: number;
    inferredMappings: number;
  };
}

export interface CrossReferenceConflict {
  entityType: 'matter' | 'feeEarner' | 'client' | 'department';
  idForm: string;
  mappingA: string;
  sourceA: string;
  mappingB: string;
  sourceB: string;
  resolution: 'kept_a' | 'kept_b' | 'flagged';
  resolutionReason: string;
}

/**
 * Serialised form of CrossReferenceRegistry — all Maps converted to plain
 * objects so the registry can be stored as JSON in MongoDB.
 */
export interface CrossReferenceRegistrySerialised {
  firmId: string;
  builtAt: string;
  matters: {
    idToNumber: Record<string, string>;
    numberToId: Record<string, string>;
    confidence: Record<string, 'certain' | 'inferred'>;
    sourceDatasets: Record<string, string[]>;
  };
  feeEarners: {
    idToName: Record<string, string>;
    nameToId: Record<string, string>;
    nameVariants: Record<string, string>;
    confidence: Record<string, 'certain' | 'inferred'>;
    sourceDatasets: Record<string, string[]>;
  };
  clients: {
    idToName: Record<string, string>;
    nameToId: Record<string, string>;
    confidence: Record<string, 'certain' | 'inferred'>;
    sourceDatasets: Record<string, string[]>;
  };
  departments: {
    idToName: Record<string, string>;
    nameToId: Record<string, string>;
    confidence: Record<string, 'certain' | 'inferred'>;
    sourceDatasets: Record<string, string[]>;
  };
  stats: CrossReferenceStats;
}

/** Added to DataQualityReport.crossReference */
export interface CrossReferenceQualityStats {
  matterMappingCoverage: number;       // % of matter records with both ID forms
  feeEarnerMappingCoverage: number;    // % of fee earner refs with both ID + name
  conflicts: CrossReferenceConflict[];
  unresolvedMatterIds: number;
  unresolvedMatterNumbers: number;
  unresolvedLawyerNames: string[];
  wipOrphanCount: number;              // WIP entries with no matched matter
  wipTotalCount: number;               // Total WIP entries processed
  wipOrphanRate: number;               // % of WIP entries that are orphaned (0–100)
}

// =============================================================================
// Stage 4: Index
// =============================================================================

export interface PipelineIndexes {
  // Lookup maps — used in the JOIN stage
  feeEarnerById: Map<string, NormalisedRecord>;
  feeEarnerByName: Map<string, NormalisedRecord>;       // normalised name → record
  feeEarnerByNameFuzzy: Array<{ name: string; normalised: string; record: NormalisedRecord }>;

  matterById: Map<string, NormalisedRecord>;
  matterByNumber: Map<string, NormalisedRecord>;        // matterNumber (as string) → record

  invoiceByMatterNumber: Map<string, NormalisedRecord[]>;  // one matter → many invoices

  clientById: Map<string, NormalisedRecord>;
  clientByName: Map<string, NormalisedRecord>;          // normalised display name → record

  disbursementByMatterId: Map<string, NormalisedRecord[]>;
  taskByMatterId: Map<string, NormalisedRecord[]>;

  // Derived sets for data quality analysis
  matterNumbersInWip: Set<string>;            // all matterNumbers referenced in time entries
  matterNumbersInMatters: Set<string>;        // all matterNumbers in the matters export
  matterNumbersInInvoices: Set<string>;       // all matterNumbers in invoices
  lawyerIdsInWip: Set<string>;               // all lawyerIds referenced in time entries
  lawyerIdsInFeeEarners: Set<string>;        // all lawyerIds in fee earner file
}

// =============================================================================
// Stage 5: Join
// =============================================================================

export interface JoinStats {
  timeEntries: {
    total: number;
    matched: number;
    orphaned: number;
    orphanedValue: number;
    lawyerResolved: number;
    lawyerUnresolved: number;
  };
  matters: {
    total: number;
    closedMattersMerged: number;
    clientResolved: number;
    clientUnresolved: number;
  };
  invoices: {
    total: number;
    matterResolved: number;
    matterUnresolved: number;
  };
  disbursements: {
    total: number;
    matterResolved: number;
    matterUnresolved: number;
  };
}

export interface JoinResult {
  timeEntries: EnrichedTimeEntry[];
  matters: EnrichedMatter[];
  feeEarners: EnrichedFeeEarner[];
  invoices: EnrichedInvoice[];
  clients: EnrichedClient[];
  disbursements: EnrichedDisbursement[];
  tasks: EnrichedTask[];
  departments: EnrichedDepartment[];
  joinStats: JoinStats;
}

// Re-export Enriched types so consumers only need to import from pipeline.ts
export type {
  EnrichedTimeEntry,
  EnrichedMatter,
  EnrichedFeeEarner,
  EnrichedInvoice,
  EnrichedClient,
  EnrichedDisbursement,
  EnrichedTask,
  EnrichedDepartment,
};

// =============================================================================
// Stage 6: Aggregate
// =============================================================================

export interface WipVsInvoiceDiscrepancy {
  billingDifference: number;           // wipTotalBillable - invoicedNetBilling
  billingDifferencePercent: number;    // billingDifference / wipTotalBillable * 100
  hasMajorDiscrepancy: boolean;        // Math.abs(billingDifferencePercent) > 10
}

export interface AggregatedMatter {
  matterId?: string;
  matterNumber?: string;

  // WIP aggregates
  wipTotalDurationMinutes: number;
  wipTotalHours: number;
  wipTotalBillable: number;
  wipTotalWriteOff: number;
  wipTotalUnits: number;
  wipTotalChargeable: number;
  wipTotalNonChargeable: number;
  wipChargeableHours: number;
  wipNonChargeableHours: number;
  wipOldestEntryDate: Date | null;
  wipNewestEntryDate: Date | null;
  wipAgeInDays: number | null;

  // Invoice aggregates
  invoiceCount: number;
  invoicedNetBilling: number;
  invoicedDisbursements: number;
  invoicedTotal: number;
  invoicedOutstanding: number;
  invoicedPaid: number;
  invoicedWrittenOff: number;

  // Dual source of truth
  discrepancy?: WipVsInvoiceDiscrepancy;
}

export interface AggregatedFeeEarner {
  lawyerId?: string;
  lawyerName?: string;

  // WIP aggregates
  wipTotalHours: number;
  wipChargeableHours: number;
  wipNonChargeableHours: number;
  wipChargeableValue: number;
  wipTotalValue: number;
  wipWriteOffValue: number;
  wipMatterCount: number;
  wipOrphanedHours: number;
  wipOrphanedValue: number;
  wipOldestEntryDate: Date | null;
  wipNewestEntryDate: Date | null;
  wipEntryCount: number;
  recordingGapDays: number | null;   // calendar days since last entry

  // Invoice aggregates
  invoicedRevenue: number;
  invoicedOutstanding: number;
  invoicedCount: number;
}

export interface AggregatedClient {
  contactId?: string;
  displayName?: string;
  clientName?: string;

  matterCount: number;
  activeMatterCount: number;
  closedMatterCount: number;
  totalWipValue: number;
  totalInvoiced: number;
  totalOutstanding: number;
  totalPaid: number;
  oldestMatterDate: Date | null;
}

export interface AggregatedDepartment {
  name: string;
  departmentId?: string | null;

  feeEarnerCount: number;
  activeFeeEarnerCount: number;
  activeMatterCount: number;
  totalMatterCount: number;
  wipTotalHours: number;
  wipChargeableHours: number;
  wipChargeableValue: number;
  invoicedRevenue: number;
  invoicedOutstanding: number;
}

export interface OrphanedWipSummary {
  orphanedWipEntryCount: number;
  orphanedWipHours: number;
  orphanedWipValue: number;
  orphanedWipPercent: number;
  orphanedWipNote: string;
}

export interface AggregatedFirm {
  feeEarnerCount: number;
  activeFeeEarnerCount: number;
  salariedFeeEarnerCount: number;
  feeShareFeeEarnerCount: number;

  matterCount: number;
  activeMatterCount: number;
  inProgressMatterCount: number;
  completedMatterCount: number;
  otherMatterCount: number;

  totalWipHours: number;
  totalChargeableHours: number;
  totalWipValue: number;
  totalWriteOffValue: number;
  totalInvoicedRevenue: number;
  totalOutstanding: number;
  totalPaid: number;

  orphanedWip: OrphanedWipSummary;
}

// =============================================================================
// Stage 6: Data Quality
// =============================================================================

export interface FileCoverage {
  fileType: string;
  label: string;
  isPresent: boolean;
  recordCount?: number;
  impact: 'critical' | 'high' | 'medium' | 'low';
  missingImpact?: string;
}

export interface EntityIssue {
  entityKey: string;
  issueType: 'missing_required_field' | 'orphaned_records' | 'unresolved_references' | 'duplicate_ids';
  severity: 'error' | 'warning' | 'info';
  affectedCount: number;
  totalCount: number;
  percentage: number;
  description: string;
  resolution?: string;
}

export interface AggregateKnownGap {
  gapId: string;
  title: string;
  description: string;
  affectedFormulas: string[];
  degradedMode?: string;
  resolution: string;
  severity: 'error' | 'warning' | 'info';
}

export interface Discrepancy {
  type: 'wip_vs_invoice' | 'matter_billing_mismatch' | 'fee_earner_attribution';
  entityKey: string;
  entityId: string;
  description: string;
  valueA: number;
  sourceA: string;
  valueB: number;
  sourceB: string;
  difference: number;
  differencePercent: number;
  severity: 'high' | 'medium' | 'low';
}

export interface Recommendation {
  priority: 1 | 2 | 3;
  title: string;
  description: string;
  action: string;
  estimatedImpact: string;
}

export interface AggregateDataQualityReport {
  overallScore: number;
  filesCoverage: FileCoverage[];
  entityIssues: EntityIssue[];
  knownGaps: AggregateKnownGap[];
  discrepancies: Discrepancy[];
  recommendations: Recommendation[];
}

export interface AggregateResult {
  feeEarners: AggregatedFeeEarner[];
  matters: AggregatedMatter[];
  clients: AggregatedClient[];
  departments: AggregatedDepartment[];
  firm: AggregatedFirm;
  dataQuality: AggregateDataQualityReport;
}
