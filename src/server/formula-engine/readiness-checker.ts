/**
 * readiness-checker.ts — Formula Readiness Checker
 *
 * Assesses whether each formula has the data it needs BEFORE execution.
 * Firms upload data progressively, so formulas must gracefully handle
 * missing sources rather than failing silently or producing misleading zeros.
 *
 * Readiness states (lowest → highest):
 *   BLOCKED  — critical data missing; formula must not execute
 *   PARTIAL  — required data present but optional data or config is absent;
 *               formula can execute with reduced accuracy
 *   READY    — all required data and config are present
 *   ENHANCED — READY plus optional enrichment data is also available
 *
 * Usage:
 *   1. Call deriveConfigPaths(firmConfig) to produce the configPaths map.
 *   2. Build entityTypes from the AggregateResult record counts.
 *   3. Call checkAllReadiness (or checkSingleReadiness) with the above.
 *   4. Pass BLOCKED results to the formula engine — it will skip them.
 *   5. Store all results alongside calculated KPIs for dashboard confidence indicators.
 */

import type { FirmConfig } from '../../shared/types/index.js';
import type {
  BuiltInFormulaDefinition,
  BuiltInSnippetDefinition,
} from '../../shared/formulas/types.js';

// =============================================================================
// Public Types
// =============================================================================

export enum FormulaReadiness {
  READY = 'READY',
  PARTIAL = 'PARTIAL',
  BLOCKED = 'BLOCKED',
  ENHANCED = 'ENHANCED',
}

export interface InputReadiness {
  /** Human-readable name, e.g. "WIP / Time Entries". */
  inputName: string;
  /** Entity type key, e.g. "timeEntry". */
  entityType: string;
  required: boolean;
  present: boolean;
  recordCount: number;
  /** Non-blocking data quality note, e.g. about orphaned WIP percentage. */
  qualityNote?: string;
}

export interface FormulaReadinessResult {
  formulaId: string;
  readiness: FormulaReadiness;
  requiredInputs: InputReadiness[];
  optionalInputs: InputReadiness[];
  /** Human-readable summary, always present. */
  message: string;
  /** Why the formula is blocked. Only present when readiness === BLOCKED. */
  blockedReason?: string;
  /** What is missing that reduces accuracy. Only present when readiness === PARTIAL. */
  partialDetails?: string[];
  /** What extra data unlocks enhanced analysis. Only present when readiness === ENHANCED. */
  enhancedDetails?: string[];
}

// =============================================================================
// Internal Requirement Spec Types
// =============================================================================

interface EntitySpec {
  entityType: string;
  label: string;
  /** true → BLOCKED if absent; false → PARTIAL if absent. */
  required: boolean;
  blockedMessage?: string;
  partialMessage?: string;
  /** Message surfaced in enhancedDetails when this optional entity IS present. */
  enhancedMessage?: string;
}

interface ConfigSpec {
  path: string;
  label: string;
  /** true → BLOCKED if absent; false → PARTIAL if absent. */
  required: boolean;
  blockedMessage?: string;
  partialMessage?: string;
}

interface FormulaReq {
  entities: EntitySpec[];
  config: ConfigSpec[];
}

type AvailableData = {
  entityTypes: Record<string, { present: boolean; recordCount: number }>;
  configPaths: Record<string, boolean>;
};

// =============================================================================
// Input Requirements Map (all 23 formulas + 5 snippets)
// =============================================================================

// Shorthand builders for common entity specs
const req = (
  entityType: string,
  label: string,
  blockedMessage: string,
): EntitySpec => ({ entityType, label, required: true, blockedMessage });

const opt = (
  entityType: string,
  label: string,
  partialMessage: string,
  enhancedMessage?: string,
): EntitySpec => ({
  entityType,
  label,
  required: false,
  partialMessage,
  enhancedMessage,
});

const cfgRequired = (
  path: string,
  label: string,
  blockedMessage: string,
): ConfigSpec => ({ path, label, required: true, blockedMessage });

const cfgPartial = (
  path: string,
  label: string,
  partialMessage: string,
): ConfigSpec => ({ path, label, required: false, partialMessage });

// Common entity specs reused across formulas
const E_FEE_EARNER = (msg?: string) =>
  req('feeEarner', 'Fee Earner Data', msg ?? 'Upload fee earner data to enable this formula.');
const E_TIME_ENTRY = (msg?: string) =>
  req('timeEntry', 'WIP / Time Entries', msg ?? 'Upload WIP time entry data to enable this formula.');
const E_MATTER = (msg?: string) =>
  req('matter', 'Matter Data', msg ?? 'Upload matter data to enable this formula.');
const E_INVOICE = (msg?: string) =>
  req('invoice', 'Invoice Data', msg ?? 'Upload invoice data to enable this formula.');
const E_CLIENT = (msg?: string) =>
  req('client', 'Client Data', msg ?? 'Upload client data to enable this formula.');
const E_DEPARTMENT = (msg?: string) =>
  req('department', 'Department Data', msg ?? 'Upload department data to enable this formula.');
const E_DISBURSEMENT = (msg?: string) =>
  req('disbursement', 'Disbursement Data', msg ?? 'Upload disbursement data to enable this formula.');

const OPT_MATTER = opt(
  'matter',
  'Matter Data',
  'Matter data absent — fixed-fee filtering and matter-level joins unavailable.',
  'Matter data present — fixed-fee filtering and matter-level analysis enabled.',
);
const OPT_INVOICE = opt(
  'invoice',
  'Invoice Data',
  'Invoice data absent — revenue figures based on WIP billable value only.',
  'Invoice data present — revenue uses actual invoiced amounts.',
);
const OPT_DISBURSEMENT = opt(
  'disbursement',
  'Disbursement Data',
  'Disbursement data absent — disbursement leakage not factored in.',
  'Disbursement data present — full leakage analysis enabled.',
);

const CFG_WEEKLY_HOURS = cfgPartial(
  'weeklyTargetHours',
  'Weekly Target Hours',
  'weeklyTargetHours not configured — using system default (37.5 hrs). Set firm-wide or per-earner targets for accuracy.',
);
const CFG_WORKING_DAYS = cfgPartial(
  'workingDaysPerWeek',
  'Working Days Per Week',
  'workingDaysPerWeek not configured — using system default (5 days).',
);
const CFG_LEAVE = cfgPartial(
  'annualLeaveEntitlement',
  'Annual Leave Entitlement',
  'annualLeaveEntitlement not configured — using system default (25 days).',
);
const CFG_BANK_HOLIDAYS = cfgPartial(
  'bankHolidaysPerYear',
  'Bank Holidays Per Year',
  'bankHolidaysPerYear not configured — using system default (8 days).',
);
const CFG_COST_RATE = cfgRequired(
  'costRateMethod',
  'Cost Rate Method',
  'costRateMethod not configured — set to fully_loaded, direct, or market_rate to enable profitability formulas.',
);
const CFG_RETAIN_PERCENT = cfgPartial(
  'defaultFirmRetainPercent',
  'Firm Retain Percent',
  'defaultFirmRetainPercent not configured — fee-share revenue calculation will use 0%. Set this to ensure accurate profitability for fee share earners.',
);
const CFG_FEE_SHARE_PERCENT = cfgPartial(
  'defaultFeeSharePercent',
  'Default Fee Share Percent',
  'defaultFeeSharePercent not configured — fee share cost calculation will use 0%.',
);
const CFG_UTILISATION_APPROACH = cfgPartial(
  'utilisationApproach',
  'Utilisation Approach',
  'utilisationApproach not configured — using assume_fulltime default.',
);
const CFG_REVENUE_ATTRIBUTION = cfgPartial(
  'revenueAttribution',
  'Revenue Attribution',
  'revenueAttribution not configured — defaulting to responsible_lawyer.',
);
const CFG_SCORECARD_WEIGHTS = cfgPartial(
  'scorecardWeights',
  'Scorecard Weights',
  'scorecardWeights not configured — using equal weights for all components.',
);

/**
 * Static requirements map for all built-in formulas and snippets.
 * Keyed by formulaId or snippetId.
 */
const FORMULA_INPUT_REQUIREMENTS: Record<string, FormulaReq> = {

  // ---------------------------------------------------------------------------
  // Snippets
  // ---------------------------------------------------------------------------

  'SN-001': {
    entities: [E_FEE_EARNER('Upload fee earner data — SN-001 requires fee earner salary fields.')],
    config: [
      cfgPartial(
        'feeEarner.salaryData',
        'Fee Earner Salary Data',
        'Salary data absent — SN-001 will return null for salaried earners. Upload a fee earner file with annualSalary populated.',
      ),
    ],
  },

  'SN-002': {
    entities: [E_FEE_EARNER('Upload fee earner data — SN-002 calculates available working hours per earner.')],
    config: [CFG_WEEKLY_HOURS, CFG_WORKING_DAYS, CFG_LEAVE, CFG_BANK_HOLIDAYS],
  },

  'SN-003': {
    entities: [E_FEE_EARNER('Upload fee earner data — SN-003 requires payModel for retain calculation.')],
    config: [CFG_RETAIN_PERCENT],
  },

  'SN-004': {
    entities: [E_FEE_EARNER('Upload fee earner data — SN-004 requires salary cost fields.')],
    config: [
      cfgPartial(
        'feeEarner.salaryData',
        'Fee Earner Salary Data',
        'Salary data absent — SN-004 will return null for salaried earners. Populate annualSalary in fee earner data.',
      ),
    ],
  },

  'SN-005': {
    entities: [E_FEE_EARNER('Upload fee earner data — SN-005 requires payModel and cost fields.')],
    config: [CFG_COST_RATE, CFG_FEE_SHARE_PERCENT],
  },

  // ---------------------------------------------------------------------------
  // Utilisation
  // ---------------------------------------------------------------------------

  'F-TU-01': {
    entities: [
      E_FEE_EARNER('Upload fee earner data to calculate utilisation rates.'),
      E_TIME_ENTRY('Upload WIP time entries to calculate utilisation rates.'),
    ],
    config: [CFG_WEEKLY_HOURS, CFG_WORKING_DAYS, CFG_LEAVE, CFG_BANK_HOLIDAYS,
      cfgPartial(
        'feeEarner.perEarnerTargets',
        'Per-Earner Working Time Targets',
        'Per-earner targets not configured — firm-wide defaults applied to all fee earners. Set individual targets for accuracy.',
      ),
    ],
  },

  'F-TU-02': {
    entities: [
      E_FEE_EARNER('Upload fee earner data to measure recording consistency.'),
      E_TIME_ENTRY('Upload WIP time entries to measure recording consistency.'),
    ],
    config: [CFG_WORKING_DAYS, CFG_BANK_HOLIDAYS],
  },

  'F-TU-03': {
    entities: [
      E_FEE_EARNER('Upload fee earner data to analyse time breakdown.'),
      E_TIME_ENTRY('Upload WIP time entries to analyse non-chargeable time.'),
    ],
    config: [],
  },

  // ---------------------------------------------------------------------------
  // Revenue & Billing
  // ---------------------------------------------------------------------------

  'F-RB-01': {
    entities: [
      E_FEE_EARNER('Upload fee earner data to calculate realisation rate.'),
      E_TIME_ENTRY('Upload WIP time entries — these provide the billable denominator.'),
      E_INVOICE('Upload invoice data — this provides the billed numerator for realisation.'),
      opt(
        'matter',
        'Matter Data',
        'Matter data absent — cannot filter fixed-fee matters. All matters treated identically.',
        'Matter data present — fixed-fee matters can be handled per the active variant.',
      ),
    ],
    config: [CFG_UTILISATION_APPROACH],
  },

  'F-RB-02': {
    entities: [
      E_FEE_EARNER('Upload fee earner data to calculate effective hourly rate.'),
      E_TIME_ENTRY('Upload WIP time entries — these provide chargeable hours.'),
      opt(
        'matter',
        'Matter Data',
        'Matter data absent — using fee earner aggregate billing rather than matter-level netBilling.',
        'Matter data present — effective rate uses matter-level billing figures.',
      ),
    ],
    config: [],
  },

  'F-RB-03': {
    entities: [
      E_FEE_EARNER('Upload fee earner data to calculate revenue per earner.'),
      E_INVOICE('Upload invoice data — this provides the billing figures.'),
      opt(
        'matter',
        'Matter Data',
        'Matter data absent — cannot apply revenueAttribution filtering; billing summed directly from invoice data.',
        'Matter data present — revenue attribution by responsible/billing lawyer enabled.',
      ),
    ],
    config: [CFG_REVENUE_ATTRIBUTION],
  },

  'F-RB-04': {
    entities: [
      E_MATTER('Upload matter data to measure billing velocity.'),
      E_TIME_ENTRY('Upload WIP time entries — the last entry date is required.'),
      E_INVOICE('Upload invoice data — the invoice date is required.'),
    ],
    config: [],
  },

  // ---------------------------------------------------------------------------
  // WIP & Leakage
  // ---------------------------------------------------------------------------

  'F-WL-01': {
    entities: [
      E_MATTER('Upload matter data to measure WIP age.'),
      E_TIME_ENTRY('Upload WIP time entries — entry dates are required to measure age.'),
      opt(
        'invoice',
        'Invoice Data',
        'Invoice data absent — cannot distinguish billed from unbilled WIP. All WIP treated as unbilled.',
        'Invoice data present — only genuinely unbilled entries included in age calculation.',
      ),
    ],
    config: [],
  },

  'F-WL-02': {
    entities: [
      E_FEE_EARNER('Upload fee earner data to analyse write-offs.'),
      E_TIME_ENTRY('Upload WIP time entries — write-off fields are required.'),
      opt(
        'matter',
        'Matter Data',
        'Matter data absent — write-off analysis at fee earner level only, no matter breakdown.',
        'Matter data present — write-off breakdown by matter enabled.',
      ),
      opt(
        'invoice',
        'Invoice Data',
        'Invoice data absent — invoice-level write-offs not included in analysis.',
        'Invoice data present — invoice write-offs included alongside WIP write-offs.',
      ),
    ],
    config: [],
  },

  'F-WL-03': {
    entities: [
      E_MATTER('Upload matter data to measure disbursement recovery.'),
      E_DISBURSEMENT('Upload disbursement data — incurred disbursements are the denominator.'),
      E_INVOICE('Upload invoice data — billed disbursements are the numerator.'),
    ],
    config: [],
  },

  'F-WL-04': {
    entities: [
      E_MATTER('Upload matter data to calculate lock-up days.'),
      E_TIME_ENTRY('Upload WIP time entries — unbilled WIP value is required.'),
      E_INVOICE('Upload invoice data — outstanding invoice value is required.'),
    ],
    config: [],
  },

  // ---------------------------------------------------------------------------
  // Profitability
  // ---------------------------------------------------------------------------

  'F-PR-01': {
    entities: [
      E_MATTER('Upload matter data — matter-level billing is required for profitability.'),
      E_FEE_EARNER('Upload fee earner data — cost rate calculation requires fee earner fields.'),
      E_TIME_ENTRY('Upload WIP time entries — hours worked on the matter are required.'),
      opt(
        'invoice',
        'Invoice Data',
        'Invoice data absent — revenue based on WIP billable value only, not actual invoiced amounts.',
        'Invoice data present — profitability uses actual invoiced revenue.',
      ),
      opt(
        'disbursement',
        'Disbursement Data',
        'Disbursement data absent — disbursement costs not included in matter profitability.',
        'Disbursement data present — disbursement leakage factored into profitability.',
      ),
    ],
    config: [
      CFG_COST_RATE,
      CFG_RETAIN_PERCENT,
      cfgPartial(
        'feeEarner.salaryData',
        'Fee Earner Salary Data',
        'Salary data absent — cost rates will be null for salaried earners, reducing profitability accuracy.',
      ),
    ],
  },

  'F-PR-02': {
    entities: [
      E_FEE_EARNER('Upload fee earner data — pay model and cost fields are required.'),
      E_INVOICE('Upload invoice data — invoiced revenue is required for profitability.'),
      opt(
        'matter',
        'Matter Data',
        'Matter data absent — revenue attribution to fee earners may be less accurate.',
        'Matter data present — revenue attribution per responsible lawyer enabled.',
      ),
    ],
    config: [
      CFG_COST_RATE,
      CFG_RETAIN_PERCENT,
      cfgPartial(
        'feeEarner.salaryData',
        'Fee Earner Salary Data',
        'Salary data absent — salaried earner profitability will return null. Populate annualSalary to enable.',
      ),
    ],
  },

  'F-PR-03': {
    entities: [
      E_DEPARTMENT('Upload department data to calculate department profitability.'),
      E_FEE_EARNER('Upload fee earner data — fee earners must be assigned to departments.'),
      E_MATTER('Upload matter data for billing attribution.'),
      E_INVOICE('Upload invoice data for invoiced revenue.'),
    ],
    config: [],
  },

  'F-PR-04': {
    entities: [
      E_CLIENT('Upload client data to calculate client profitability.'),
      E_MATTER('Upload matter data — matters must be linked to clients.'),
      E_FEE_EARNER('Upload fee earner data for cost rate calculation.'),
      E_INVOICE('Upload invoice data for invoiced revenue.'),
    ],
    config: [],
  },

  'F-PR-05': {
    entities: [
      E_FEE_EARNER('Upload fee earner data for firm-level profitability.'),
      E_DEPARTMENT('Upload department data — department totals cross-checked against fee earner totals.'),
      E_MATTER('Upload matter data for billing attribution.'),
      E_INVOICE('Upload invoice data for invoiced revenue.'),
    ],
    config: [],
  },

  // ---------------------------------------------------------------------------
  // Budget & Scope
  // ---------------------------------------------------------------------------

  'F-BS-01': {
    entities: [
      E_MATTER('Upload matter data — financialLimit (budget) is required for burn rate.'),
      E_TIME_ENTRY('Upload WIP time entries — recorded time drives the burn rate numerator.'),
      opt(
        'invoice',
        'Invoice Data',
        'Invoice data absent — burn rate by value uses WIP billable only, not invoiced amounts.',
        'Invoice data present — burn rate by value includes invoiced amounts.',
      ),
    ],
    config: [],
  },

  'F-BS-02': {
    entities: [
      E_MATTER('Upload matter data — budget (F-BS-01) and billing (F-RB-01) are both required.'),
      E_TIME_ENTRY('Upload WIP time entries for budget burn calculation.'),
      E_INVOICE('Upload invoice data for realisation rate calculation.'),
    ],
    config: [],
  },

  // ---------------------------------------------------------------------------
  // Debtors
  // ---------------------------------------------------------------------------

  'F-DM-01': {
    entities: [
      E_INVOICE('Upload invoice data — outstanding invoices are required for aged debtor analysis.'),
      opt(
        'matter',
        'Matter Data',
        'Matter data absent — aged debtors cannot be broken down by client or department.',
        'Matter data present — aged debtors can be attributed to matters, clients, and departments.',
      ),
    ],
    config: [],
  },

  'F-DM-02': {
    entities: [
      E_CLIENT('Upload client data to score payment behaviour.'),
      E_INVOICE('Upload invoice data — invoice history is required for payment scoring.'),
    ],
    config: [
      cfgPartial(
        'invoice.datePaid',
        'Invoice Payment Date (datePaid)',
        'datePaid not yet available in invoice exports — average days-to-pay cannot be computed. This formula will return null for most clients until payment date data is available.',
      ),
    ],
  },

  // ---------------------------------------------------------------------------
  // Composite / Scorecard
  // ---------------------------------------------------------------------------

  'F-CS-01': {
    entities: [
      E_FEE_EARNER('Upload fee earner data to calculate recovery opportunity.'),
      E_TIME_ENTRY('Upload WIP time entries — chargeable hours and rate are required.'),
      E_MATTER('Upload matter data for billing and realisation calculation.'),
      E_INVOICE('Upload invoice data — realisation rate requires invoiced amounts.'),
    ],
    config: [CFG_WEEKLY_HOURS, CFG_UTILISATION_APPROACH],
  },

  'F-CS-02': {
    entities: [
      E_FEE_EARNER('Upload fee earner data for the scorecard composite.'),
      E_TIME_ENTRY('Upload WIP time entries for utilisation and consistency components.'),
      E_MATTER('Upload matter data for realisation and write-off components.'),
      E_INVOICE('Upload invoice data for the realisation component.'),
    ],
    config: [CFG_SCORECARD_WEIGHTS],
  },

  'F-CS-03': {
    entities: [
      E_MATTER('Upload matter data — WIP age, budget burn, and realisation are all matter-level.'),
      E_TIME_ENTRY('Upload WIP time entries for WIP age and budget burn components.'),
      E_INVOICE('Upload invoice data for realisation rate component.'),
      E_DISBURSEMENT('Upload disbursement data for disbursement recovery component.'),
    ],
    config: [CFG_SCORECARD_WEIGHTS],
  },
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Derive a configPaths map from a FirmConfig.
 * Call this before checkAllReadiness or checkSingleReadiness when you have
 * a FirmConfig but not a pre-built configPaths map.
 */
export function deriveConfigPaths(firmConfig: FirmConfig): Record<string, boolean> {
  return {
    weeklyTargetHours: firmConfig.weeklyTargetHours !== undefined && firmConfig.weeklyTargetHours !== null,
    workingDaysPerWeek: firmConfig.workingDaysPerWeek !== undefined && firmConfig.workingDaysPerWeek !== null,
    annualLeaveEntitlement: firmConfig.annualLeaveEntitlement !== undefined && firmConfig.annualLeaveEntitlement !== null,
    bankHolidaysPerYear: firmConfig.bankHolidaysPerYear !== undefined && firmConfig.bankHolidaysPerYear !== null,
    chargeableWeeklyTarget: firmConfig.chargeableWeeklyTarget !== undefined && firmConfig.chargeableWeeklyTarget !== null,
    costRateMethod: firmConfig.costRateMethod !== undefined && firmConfig.costRateMethod !== null,
    defaultFeeSharePercent: firmConfig.defaultFeeSharePercent !== undefined && firmConfig.defaultFeeSharePercent !== null,
    defaultFirmRetainPercent: firmConfig.defaultFirmRetainPercent !== undefined && firmConfig.defaultFirmRetainPercent !== null,
    utilisationApproach: firmConfig.utilisationApproach !== undefined && firmConfig.utilisationApproach !== null,
    revenueAttribution: firmConfig.revenueAttribution !== undefined && firmConfig.revenueAttribution !== null,
    // Fields below are synthetic — not directly in FirmConfig.
    // Callers set these based on data quality checks or entity-field inspection.
    'invoice.datePaid': false,     // extensible field, not yet in exports
    'feeEarner.salaryData': false, // present only if fee earner CSV with salary was uploaded
    'feeEarner.perEarnerTargets': false,
    'feeEarner.gradeData': false,
    'matter.isFixedFee': false,
    scorecardWeights: firmConfig.ragThresholds.length > 0, // heuristic: thresholds set → weights configured
  };
}

// =============================================================================
// Core Evaluation
// =============================================================================

/**
 * Evaluate readiness for a single formula or snippet.
 * Returns a default READY result if the formula has no registered requirements
 * (e.g. custom formulas added at runtime).
 */
export function checkSingleReadiness(
  formulaId: string,
  availableData: AvailableData,
  _firmConfig: FirmConfig,
): FormulaReadinessResult {
  const req = FORMULA_INPUT_REQUIREMENTS[formulaId];

  if (!req) {
    // No requirements registered — assume ready (e.g. custom formulas)
    return {
      formulaId,
      readiness: FormulaReadiness.READY,
      requiredInputs: [],
      optionalInputs: [],
      message: 'Ready — no data requirements registered for this formula.',
    };
  }

  const { entityTypes, configPaths } = availableData;

  // ------------------------------------------------------------------
  // Build InputReadiness for each entity spec
  // ------------------------------------------------------------------
  const requiredInputs: InputReadiness[] = [];
  const optionalInputs: InputReadiness[] = [];

  for (const spec of req.entities) {
    const data = entityTypes[spec.entityType] ?? { present: false, recordCount: 0 };
    const ir: InputReadiness = {
      inputName: spec.label,
      entityType: spec.entityType,
      required: spec.required,
      present: data.present,
      recordCount: data.recordCount,
    };
    // Add known quality note for timeEntry (high orphan rate)
    if (spec.entityType === 'timeEntry' && data.present && data.recordCount > 0) {
      ir.qualityNote = 'Note: ~49% of WIP entries may be orphaned from matters if the cross-reference registry is incomplete.';
    }
    if (spec.required) {
      requiredInputs.push(ir);
    } else {
      optionalInputs.push(ir);
    }
  }

  // ------------------------------------------------------------------
  // Evaluate BLOCKED: any required entity absent
  // ------------------------------------------------------------------
  const blockedEntities = req.entities.filter(
    (s) => s.required && !(entityTypes[s.entityType]?.present ?? false),
  );
  const blockedConfigs = req.config.filter(
    (c) => c.required && !(configPaths[c.path] ?? false),
  );

  if (blockedEntities.length > 0 || blockedConfigs.length > 0) {
    const reasons: string[] = [
      ...blockedEntities.map((s) => s.blockedMessage ?? `${s.label} not available.`),
      ...blockedConfigs.map((c) => c.blockedMessage ?? `${c.label} not configured.`),
    ];
    return {
      formulaId,
      readiness: FormulaReadiness.BLOCKED,
      requiredInputs,
      optionalInputs,
      message: `Blocked — ${reasons[0]}`,
      blockedReason: reasons.join(' '),
    };
  }

  // ------------------------------------------------------------------
  // Evaluate PARTIAL: optional entities absent or optional config missing
  // ------------------------------------------------------------------
  const partialDetails: string[] = [];

  const missingOptionalEntities = req.entities.filter(
    (s) => !s.required && !(entityTypes[s.entityType]?.present ?? false),
  );
  for (const s of missingOptionalEntities) {
    if (s.partialMessage) partialDetails.push(s.partialMessage);
  }

  const missingOptionalConfigs = req.config.filter(
    (c) => !c.required && !(configPaths[c.path] ?? false),
  );
  for (const c of missingOptionalConfigs) {
    if (c.partialMessage) partialDetails.push(c.partialMessage);
  }

  if (partialDetails.length > 0) {
    return {
      formulaId,
      readiness: FormulaReadiness.PARTIAL,
      requiredInputs,
      optionalInputs,
      message: `Partial — ${partialDetails[0]}`,
      partialDetails,
    };
  }

  // ------------------------------------------------------------------
  // Evaluate ENHANCED: all required + optional present; check enhanced messages
  // ------------------------------------------------------------------
  const enhancedDetails: string[] = [];

  for (const s of req.entities) {
    if (!s.required && s.enhancedMessage && (entityTypes[s.entityType]?.present ?? false)) {
      enhancedDetails.push(s.enhancedMessage);
    }
  }

  if (enhancedDetails.length > 0) {
    return {
      formulaId,
      readiness: FormulaReadiness.ENHANCED,
      requiredInputs,
      optionalInputs,
      message: `Enhanced — all data present. ${enhancedDetails[0]}`,
      enhancedDetails,
    };
  }

  // ------------------------------------------------------------------
  // READY
  // ------------------------------------------------------------------
  return {
    formulaId,
    readiness: FormulaReadiness.READY,
    requiredInputs,
    optionalInputs,
    message: 'Ready — all required data and configuration are present.',
  };
}

// =============================================================================
// Check All
// =============================================================================

/**
 * Assess readiness for all provided formula and snippet definitions.
 * Returns a map keyed by formulaId / snippetId.
 *
 * Formulas with no entry in FORMULA_INPUT_REQUIREMENTS default to READY.
 * The formulaDefinitions and snippetDefinitions parameters are used to enumerate
 * which IDs to assess — the requirements themselves come from the static map.
 */
export function checkAllReadiness(
  formulaDefinitions: BuiltInFormulaDefinition[],
  snippetDefinitions: BuiltInSnippetDefinition[],
  availableData: AvailableData,
  firmConfig: FirmConfig,
): Record<string, FormulaReadinessResult> {
  const results: Record<string, FormulaReadinessResult> = {};

  for (const formula of formulaDefinitions) {
    results[formula.formulaId] = checkSingleReadiness(
      formula.formulaId,
      availableData,
      firmConfig,
    );
  }

  for (const snippet of snippetDefinitions) {
    results[snippet.snippetId] = checkSingleReadiness(
      snippet.snippetId,
      availableData,
      firmConfig,
    );
  }

  return results;
}
