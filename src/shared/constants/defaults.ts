// =============================================================================
// Yao Mind — Default Configuration Values
// All default values used when creating a new firm or resetting config.
// =============================================================================

import type { FirmConfigTier1 } from '../types/index.js';

// =============================================================================
// Firm identity defaults
// =============================================================================

export const DEFAULT_FIRM_CONFIG_TIER1: Omit<FirmConfigTier1, 'firmId' | 'firmName'> = {
  jurisdiction: 'England and Wales',
  currency: 'GBP',
  financialYearStartMonth: 4, // April (common for UK firms)
  weekStartDay: 1,            // Monday
  timezone: 'Europe/London',
};

// =============================================================================
// Working time
// =============================================================================

export const DEFAULT_WORKING_TIME = {
  hoursPerDay: 7.5,
  daysPerWeek: 5,
  targetBillableHoursPerDay: 6.0,
  targetBillableHoursPerWeek: 30,
  weekStartDay: 'monday' as const,
} as const;

// =============================================================================
// Billing & pay models
// =============================================================================

export const DEFAULT_SALARIED_CONFIG = {
  useHourlyRate: false,
  targetUtilisation: 0.75,        // 75%
  overtimeThresholdHours: 7.5,
} as const;

export const DEFAULT_FEE_SHARE_CONFIG = {
  defaultFeeSharePct: 0.0,
  includeVatInBilling: false,
} as const;

// =============================================================================
// RAG thresholds
// =============================================================================

export interface RagBand {
  min?: number;
  max?: number;
}

export interface RagMetricThresholds {
  green: RagBand;
  amber: RagBand;
  red: RagBand;
}

export const DEFAULT_RAG_THRESHOLDS: Record<string, RagMetricThresholds> = {
  /** Billed hours / target hours */
  utilisation: {
    green: { min: 0.75 },
    amber: { min: 0.60, max: 0.75 },
    red:   { max: 0.60 },
  },
  /** Billed value / recorded value */
  realisationRate: {
    green: { min: 0.85 },
    amber: { min: 0.70, max: 0.85 },
    red:   { max: 0.70 },
  },
  /** Written-off value / recorded value */
  writeOffRate: {
    green: { max: 0.05 },
    amber: { min: 0.05, max: 0.10 },
    red:   { min: 0.10 },
  },
  /** Average days from invoice issue to payment */
  debtorDays: {
    green: { max: 30 },
    amber: { min: 30, max: 60 },
    red:   { min: 60 },
  },
  /** WIP age in days */
  wipAge: {
    green: { max: 30 },
    amber: { min: 30, max: 60 },
    red:   { min: 60 },
  },
  /** Matter budget burn: spent / budget */
  budgetBurn: {
    green: { max: 0.80 },
    amber: { min: 0.80, max: 0.95 },
    red:   { min: 0.95 },
  },
  /** Outstanding invoices as % of total billed */
  outstandingRate: {
    green: { max: 0.15 },
    amber: { min: 0.15, max: 0.30 },
    red:   { min: 0.30 },
  },
} as const;

// =============================================================================
// Overhead
// =============================================================================

export const DEFAULT_OVERHEAD_CONFIG = {
  enabled: false,
  annualOverhead: 0,
  allocationMethod: 'per_fee_earner' as 'per_fee_earner' | 'by_revenue' | 'by_hours',
} as const;

// =============================================================================
// Scorecard weights (must sum to 1.0)
// =============================================================================

export const DEFAULT_SCORECARD_WEIGHTS: Record<string, number> = {
  utilisation:        0.30,
  realisationRate:    0.25,
  writeOffRate:       0.20,
  debtorDays:         0.15,
  clientSatisfaction: 0.10,
} as const;

// =============================================================================
// Display preferences
// =============================================================================

export const DEFAULT_DISPLAY_PREFERENCES = {
  dateFormat: 'DD/MM/YYYY',
  currency: 'GBP',
  currencySymbol: '£',
  decimalPlaces: 2,
  thousandsSeparator: ',',
  decimalSeparator: '.',
} as const;

// =============================================================================
// Export settings
// =============================================================================

export const DEFAULT_EXPORT_SETTINGS = {
  defaultFormat: 'csv' as 'csv' | 'xlsx' | 'json',
  includeHeaders: true,
  dateFormat: 'DD/MM/YYYY',
} as const;

// =============================================================================
// Units / billing blocks
// =============================================================================

/** One unit = 6 minutes (1/10 of an hour). */
export const MINUTES_PER_UNIT = 6;
export const UNITS_PER_HOUR   = 10;

/** Convert units to hours. */
export const unitsToHours = (units: number): number => units / UNITS_PER_HOUR;

/** Convert hours to units (rounded up to nearest unit). */
export const hoursToUnits = (hours: number): number => Math.ceil(hours * UNITS_PER_HOUR);

// =============================================================================
// Schema version
// =============================================================================

export const SCHEMA_VERSION = 1;
