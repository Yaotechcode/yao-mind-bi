/**
 * built-in-snippets.ts
 *
 * The 5 core reusable calculation sub-steps consumed by formulas.
 * These are DEFINITION OBJECTS — no executable code.
 * The formula engine (Phase 1C) reads these and implements the logic.
 */

import { EntityType } from '../types/index.js';
import { BuiltInSnippetDefinition } from './types.js';

// =============================================================================
// Snippet definitions
// =============================================================================

const BUILT_IN_SNIPPETS: BuiltInSnippetDefinition[] = [

  // ---------------------------------------------------------------------------
  // SN-001: Fully Loaded Cost Rate
  // ---------------------------------------------------------------------------
  {
    snippetId: 'SN-001',
    name: 'Fully Loaded Cost Rate',
    description:
      'Calculates the all-in hourly cost for a salaried fee earner by dividing total ' +
      'annual employment expenditure (salary, employer NI, pension, variable pay) by ' +
      'available working hours. Returns null for fee share earners as the firm bears ' +
      'no fixed employment cost.',
    entityType: EntityType.FEE_EARNER,
    resultType: 'currency',
    definition: {
      approach:
        'Sum all annual employment cost components — annualSalary plus monthlyEmployerNI × 12 ' +
        'plus monthlyPension × 12 plus monthlyVariablePay × 12 — then divide by the available ' +
        'working hours figure produced by SN-002',
      numeratorFields: [
        'annualSalary',
        'monthlyEmployerNI',
        'monthlyPension',
        'monthlyVariablePay',
      ],
      denominatorFields: ['availableWorkingHours'],
      filters: [
        'Applies only to fee earners with payModel = Salaried',
        'Return null immediately if payModel = FeeShare',
      ],
      configDependencies: [],
      dataRequirements: ['feeEarner'],
      nullHandling:
        'Return null for fee share earners; return null if annualSalary is missing; ' +
        'treat missing NI, pension, or variable pay as zero when annualSalary is present',
      aggregationLevel: 'feeEarner',
    },
    dependsOn: ['SN-002'],
  },

  // ---------------------------------------------------------------------------
  // SN-002: Available Working Hours
  // ---------------------------------------------------------------------------
  {
    snippetId: 'SN-002',
    name: 'Available Working Hours',
    description:
      'Calculates total available working hours for a fee earner in a given year. ' +
      'Uses the fee earner\'s personal working-time fields when present, falling back ' +
      'to firm config defaults. Always returns a value — it is the denominator for ' +
      'utilisation and cost rate calculations.',
    entityType: EntityType.FEE_EARNER,
    resultType: 'hours',
    definition: {
      approach:
        'Calculate working weeks as 52 minus (annualLeaveEntitlement divided by workingDaysPerWeek) ' +
        'minus (bankHolidaysPerYear divided by workingDaysPerWeek). ' +
        'Multiply working weeks by targetWeeklyHours to get annual available hours. ' +
        'Use the fee earner\'s personal fields first; fall back to firm config for any missing value.',
      numeratorFields: ['targetWeeklyHours', 'workingDaysPerWeek'],
      denominatorFields: [],
      filters: [],
      configDependencies: [
        'workingDaysPerWeek',
        'annualLeaveEntitlement',
        'bankHolidaysPerYear',
        'dailyTargetHours',
        'weeklyTargetHours',
      ],
      dataRequirements: ['feeEarner'],
      nullHandling:
        'Never returns null; uses firm config defaults for all missing fee earner fields, ' +
        'ensuring at least the firm-wide average is returned',
      aggregationLevel: 'feeEarner',
    },
    dependsOn: [],
  },

  // ---------------------------------------------------------------------------
  // SN-003: Firm Retain Amount
  // ---------------------------------------------------------------------------
  {
    snippetId: 'SN-003',
    name: 'Firm Retain Amount',
    description:
      'Calculates the portion of a billed amount that the firm retains. ' +
      'For fee share earners, this is firmRetainPercent of the billed value. ' +
      'For salaried earners, the firm retains the full amount. ' +
      'Used as a modifier in revenue and profitability formulas.',
    entityType: EntityType.FEE_EARNER,
    resultType: 'currency',
    definition: {
      approach:
        'Branch on payModel: if FeeShare, multiply amount by firmRetainPercent and divide by 100; ' +
        'if Salaried, return the full amount unchanged since the firm retains all billed revenue',
      numeratorFields: ['netBilling', 'paid'],
      denominatorFields: [],
      filters: [],
      configDependencies: ['defaultFirmRetainPercent'],
      dataRequirements: ['feeEarner'],
      nullHandling:
        'Return null if payModel is missing; return null if firmRetainPercent is missing ' +
        'for a fee share earner; return 0 if amount is 0',
      aggregationLevel: 'record',
    },
    dependsOn: [],
  },

  // ---------------------------------------------------------------------------
  // SN-004: Employment Cost (Annual)
  // ---------------------------------------------------------------------------
  {
    snippetId: 'SN-004',
    name: 'Employment Cost (Annual)',
    description:
      'Calculates the total annual cost of employing a salaried fee earner. ' +
      'Sums gross salary with all employer-side payroll costs. ' +
      'Returns null for fee share earners — they have no fixed employment cost.',
    entityType: EntityType.FEE_EARNER,
    resultType: 'currency',
    definition: {
      approach:
        'Sum annualSalary plus (monthlyEmployerNI × 12) plus (monthlyPension × 12) ' +
        'plus (monthlyVariablePay × 12). Each monthly component defaults to zero if absent.',
      numeratorFields: [
        'annualSalary',
        'monthlyEmployerNI',
        'monthlyPension',
        'monthlyVariablePay',
      ],
      denominatorFields: [],
      filters: ['Applies only to fee earners with payModel = Salaried'],
      configDependencies: [],
      dataRequirements: ['feeEarner'],
      nullHandling:
        'Return null for fee share earners; return null if annualSalary is absent; ' +
        'treat missing monthlyEmployerNI, monthlyPension, monthlyVariablePay as zero',
      aggregationLevel: 'feeEarner',
    },
    dependsOn: [],
  },

  // ---------------------------------------------------------------------------
  // SN-005: Cost Rate by Pay Model
  // ---------------------------------------------------------------------------
  {
    snippetId: 'SN-005',
    name: 'Cost Rate by Pay Model',
    description:
      'Returns the appropriate hourly cost rate for a fee earner based on their pay model ' +
      'and the firm\'s configured cost rate method. For salaried earners, uses fully loaded, ' +
      'direct, or market rate as configured. For fee share earners, the cost is the earner\'s ' +
      'share of billed value per hour.',
    entityType: EntityType.FEE_EARNER,
    resultType: 'currency',
    definition: {
      approach:
        'Branch on payModel. If Salaried: apply the firm\'s costRateMethod — ' +
        '\'fully_loaded\' uses SN-001 result; \'direct\' uses annualSalary only divided by SN-002; ' +
        '\'market_rate\' uses the firm config override rate. ' +
        'If FeeShare: the earner\'s cost is their billingRate multiplied by feeSharePercent divided by 100 ' +
        '(the share that flows to the lawyer represents the firm\'s cost for that earner).',
      numeratorFields: ['annualSalary', 'rate', 'feeSharePercent'],
      denominatorFields: ['availableWorkingHours'],
      filters: [],
      configDependencies: ['costRateMethod', 'defaultFeeSharePercent'],
      dataRequirements: ['feeEarner'],
      nullHandling:
        'Return null if payModel is missing; return null if costRateMethod is not set in config; ' +
        'return null if required fields for the configured method are absent',
      aggregationLevel: 'feeEarner',
    },
    dependsOn: ['SN-001'],
  },
];

// =============================================================================
// Public API
// =============================================================================

/** Returns all 5 built-in snippet definitions. */
export function getBuiltInSnippetDefinitions(): BuiltInSnippetDefinition[] {
  return BUILT_IN_SNIPPETS;
}
