import {
  FirmConfig,
  RagStatus,
  RagThresholdSet,
  EntityType,
} from '../types/index.js';
import { SCHEMA_VERSION } from '../constants/defaults.js';

// ---------------------------------------------------------------------------
// RAG threshold helpers
// ---------------------------------------------------------------------------

type RagDefaults = Record<RagStatus.GREEN | RagStatus.AMBER | RagStatus.RED, { min?: number; max?: number }>;

function higherBetter(green: number, amber: number): RagThresholdSet['defaults'] {
  return {
    [RagStatus.GREEN]: { min: green },
    [RagStatus.AMBER]: { min: amber, max: green },
    [RagStatus.RED]: { max: amber },
  } as RagDefaults;
}

function lowerBetter(green: number, amber: number): RagThresholdSet['defaults'] {
  return {
    [RagStatus.GREEN]: { max: green },
    [RagStatus.AMBER]: { min: green, max: amber },
    [RagStatus.RED]: { min: amber },
  } as RagDefaults;
}

// ---------------------------------------------------------------------------
// 13 RAG threshold definitions
// ---------------------------------------------------------------------------

const DEFAULT_RAG_THRESHOLDS: RagThresholdSet[] = [
  {
    metricKey: 'utilisation',
    label: 'Utilisation Rate',
    higherIsBetter: true,
    defaults: higherBetter(0.75, 0.60),
    overrides: {
      // Partner: slightly lower threshold accepted
      partner: {
        [RagStatus.GREEN]: { min: 0.70 },
        [RagStatus.AMBER]: { min: 0.55, max: 0.70 },
        [RagStatus.RED]: { max: 0.55 },
      } as RagDefaults,
      // Fee share earners: higher target expected
      feeShare: {
        [RagStatus.GREEN]: { min: 0.80 },
        [RagStatus.AMBER]: { min: 0.65, max: 0.80 },
        [RagStatus.RED]: { max: 0.65 },
      } as RagDefaults,
      // Paralegals: lower target
      paralegal: {
        [RagStatus.GREEN]: { min: 0.65 },
        [RagStatus.AMBER]: { min: 0.50, max: 0.65 },
        [RagStatus.RED]: { max: 0.50 },
      } as RagDefaults,
    },
  },
  {
    metricKey: 'realisation',
    label: 'Realisation Rate',
    higherIsBetter: true,
    defaults: higherBetter(0.85, 0.70),
  },
  {
    metricKey: 'wipAge',
    label: 'WIP Age (Days)',
    higherIsBetter: false,
    defaults: lowerBetter(30, 60),
  },
  {
    metricKey: 'debtorDays',
    label: 'Debtor Days',
    higherIsBetter: false,
    defaults: lowerBetter(30, 60),
  },
  {
    metricKey: 'lockup',
    label: 'Lock-Up (Days)',
    higherIsBetter: false,
    defaults: lowerBetter(60, 90),
  },
  {
    metricKey: 'writeOffRate',
    label: 'Write-Off Rate',
    higherIsBetter: false,
    defaults: lowerBetter(0.05, 0.10),
  },
  {
    metricKey: 'disbursementRecovery',
    label: 'Disbursement Recovery Rate',
    higherIsBetter: true,
    defaults: higherBetter(0.90, 0.75),
  },
  {
    metricKey: 'nonChargeablePercent',
    label: 'Non-Chargeable Time %',
    higherIsBetter: false,
    defaults: lowerBetter(0.25, 0.40),
  },
  {
    metricKey: 'budgetBurn',
    label: 'Budget Burn Rate',
    higherIsBetter: false,
    defaults: lowerBetter(0.80, 0.95),
  },
  {
    metricKey: 'matterMargin',
    label: 'Matter Margin',
    higherIsBetter: true,
    defaults: higherBetter(0.40, 0.25),
  },
  {
    metricKey: 'revenueMultiple',
    label: 'Revenue Multiple',
    higherIsBetter: true,
    defaults: higherBetter(3.0, 2.0),
  },
  {
    metricKey: 'effectiveRate',
    label: 'Effective Rate (£/hr)',
    higherIsBetter: true,
    defaults: higherBetter(200, 150),
  },
  {
    metricKey: 'recordingGap',
    label: 'Recording Gap (Days)',
    higherIsBetter: false,
    defaults: lowerBetter(2, 5),
  },
];

// ---------------------------------------------------------------------------
// Default FirmConfig factory
// ---------------------------------------------------------------------------

/**
 * Returns a complete FirmConfig with sensible UK law firm defaults.
 * All firm-specific identity fields are populated from the arguments.
 */
export function getDefaultFirmConfig(firmId: string, firmName: string = ''): FirmConfig {
  const now = new Date();

  return {
    // --- Tier 1: Firm Profile ---
    firmId,
    firmName,
    jurisdiction: 'England & Wales',
    currency: 'GBP',
    financialYearStartMonth: 4, // April
    weekStartDay: 1, // Monday
    timezone: 'Europe/London',
    // Working time defaults
    workingDaysPerWeek: 5,
    dailyTargetHours: 7.5,
    weeklyTargetHours: 37.5,
    chargeableWeeklyTarget: 26.25,
    annualLeaveEntitlement: 25,
    bankHolidaysPerYear: 8,
    // Pay model & cost config
    costRateMethod: 'fully_loaded',
    defaultFeeSharePercent: 60,
    defaultFirmRetainPercent: 40,
    utilisationApproach: 'assume_fulltime',
    fteCountMethod: 'full',
    revenueAttribution: 'responsible_lawyer',
    showLawyerPerspective: true,
    showDiscrepancies: true,
    dataPullLookbackMonths: 3,
    billingMethodConfig: {
      effectiveRateBase: 'chargeable_hours',
      realisationHandling: 'invoice_over_wip',
      calculationWindowMonths: 12,
    },

    // --- Tier 2: Data & Schema ---
    entityDefinitions: {} as Partial<Record<EntityType, import('../types/index.js').EntityDefinition>>,
    columnMappingTemplates: [],
    customFields: [],
    ragThresholds: DEFAULT_RAG_THRESHOLDS,

    // --- Tier 3: Formulas & Overrides ---
    formulas: [],
    snippets: [],
    feeEarnerOverrides: [],

    schemaVersion: SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
  };
}

/** Exported for use in tests and seed scripts. */
export { DEFAULT_RAG_THRESHOLDS };
