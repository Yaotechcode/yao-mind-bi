// src/shared/types/enriched.ts
// Enriched entity types — output of Stage 4 (Join) + Stage 5 (Enrich).
// Each type extends NormalisedRecord with resolved references and derived fields.

import type { NormalisedRecord } from './pipeline.js';

// =============================================================================
// Time Entry
// =============================================================================

export interface EnrichedTimeEntry extends NormalisedRecord {
  // --- Join-stage fields ---
  hasMatchedMatter: boolean;
  _orphanReason?: string;          // set when hasMatchedMatter = false
  _lawyerResolved: boolean;
  lawyerGrade?: string | null;
  lawyerPayModel?: string | null;
  clientName?: string | null;

  // --- Enrich-stage derived fields ---
  durationHours?: number | null;   // durationMinutes / 60
  isChargeable?: boolean;          // billableValue > 0 AND doNotBill === false
  recordedValue?: number | null;   // rate × durationHours (gross before write-offs)
  ageInDays?: number | null;       // daysBetween(entry.date, today)
  weekNumber?: number | null;      // ISO week number of entry.date
  monthKey?: string | null;        // 'YYYY-MM' from entry.date
}

// =============================================================================
// Matter
// =============================================================================

export interface EnrichedMatter extends NormalisedRecord {
  // --- Join-stage fields ---
  hasClosedMatterData: boolean;
  _clientResolved: boolean;
  clientName?: string | null;
  isActive: boolean;
  isClosed: boolean;
  isFixedFee?: boolean | null;

  // Supplemented from closed matters (null when hasClosedMatterData = false)
  invoiceNetBilling?: number | null;
  invoicedDisbursements?: number | null;
  invoiceOutstanding?: number | null;
  wipBillable?: number | null;
  wipWriteOff?: number | null;
}

// =============================================================================
// Fee Earner
// =============================================================================

export interface EnrichedFeeEarner extends NormalisedRecord {
  // Fee earner enrichment comes from aggregation in Stage 6 (1B-06)
  // No extra fields added in Stages 4/5
}

// =============================================================================
// Invoice
// =============================================================================

export interface EnrichedInvoice extends NormalisedRecord {
  // --- Join-stage fields ---
  matterId?: string;
  matterStatus?: string | null;
  department?: string;
  clientName?: string | null;
  isOverdue: boolean;
  daysOutstanding?: number | null;
  ageBand?: string | null;         // '0-30' | '31-60' | '61-90' | '91-120' | '120+'
}

// =============================================================================
// Client
// =============================================================================

export interface EnrichedClient extends NormalisedRecord {
  // Clients are pass-through in Stages 4/5; enriched by aggregation in Stage 6
}

// =============================================================================
// Disbursement
// =============================================================================

export interface EnrichedDisbursement extends NormalisedRecord {
  // --- Join-stage fields ---
  department?: string;
  firmExposure?: number | null;    // Math.abs(outstanding)
  ageInDays?: number | null;       // daysBetween(disbursement.date, today)
}

// =============================================================================
// Task
// =============================================================================

export interface EnrichedTask extends NormalisedRecord {
  // --- Join-stage fields ---
  isOverdue?: boolean;
  daysUntilDue?: number | null;   // negative if overdue
  daysOverdue?: number | null;    // Math.abs(daysUntilDue) when overdue
}

// =============================================================================
// Department
// =============================================================================

export interface EnrichedDepartment {
  name: string;
  departmentId?: string | null;
}
