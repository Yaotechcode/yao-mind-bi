/**
 * built-in-formulas.ts
 *
 * The 23 core formula definitions consumed by the dashboards.
 * These are DEFINITION OBJECTS — no executable code.
 * The formula engine (Phase 1C) reads these and implements the logic.
 */

import { EntityType } from '../types/index.js';
import { BuiltInFormulaDefinition } from './types.js';

// =============================================================================
// Formula definitions
// =============================================================================

const BUILT_IN_FORMULAS: BuiltInFormulaDefinition[] = [

  // ---------------------------------------------------------------------------
  // F-TU-01: Chargeable Utilisation Rate
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-TU-01',
    name: 'Chargeable Utilisation Rate',
    description:
      'Measures what proportion of a fee earner\'s available working time was spent on chargeable work. ' +
      'The active variant controls which time entries count as chargeable. ' +
      'Expressed as a percentage and compared against per-grade RAG thresholds.',
    category: 'utilisation',
    formulaType: 'built_in',
    entityType: EntityType.FEE_EARNER,
    resultType: 'percentage',
    definition: {
      approach:
        'Divide total chargeable hours by available working hours (from SN-002), then multiply by 100. ' +
        'Chargeable hours are derived from time entries filtered according to the active variant. ' +
        'durationMinutes is converted to hours by dividing by 60.',
      numeratorFields: ['durationMinutes', 'billable', 'writeOff', 'doNotBill'],
      denominatorFields: ['availableWorkingHours'],
      filters: [
        'Include only time entries belonging to the fee earner',
        'Apply variant filter to determine which entries count as chargeable',
      ],
      configDependencies: ['weeklyTargetHours', 'workingDaysPerWeek', 'annualLeaveEntitlement', 'bankHolidaysPerYear'],
      dataRequirements: ['feeEarner', 'timeEntry'],
      nullHandling:
        'Return null if the fee earner has no time entries in the period; ' +
        'return null if SN-002 returns zero or null; ' +
        'never divide by zero',
      aggregationLevel: 'feeEarner',
    },
    activeVariant: 'strict_chargeable',
    variants: {
      strict_chargeable: {
        name: 'Strict Chargeable',
        description: 'Only time entries where doNotBill is false AND billable > 0.',
        logic:
          'Filter time entries to those where doNotBill === false and billable > 0. ' +
          'Sum their durationMinutes and divide by 60 for chargeable hours.',
      },
      broad_chargeable: {
        name: 'Broad Chargeable',
        description: 'All time entries recorded against a chargeable matter, regardless of billing flag.',
        logic:
          'Filter time entries to those recorded against matters with a chargeable case type. ' +
          'Includes entries marked doNotBill or with zero billable value.',
      },
      recorded: {
        name: 'Recorded',
        description: 'All recorded time, including internal and non-chargeable entries.',
        logic:
          'Sum durationMinutes across all time entries for the fee earner. ' +
          'No billing-flag filter applied.',
      },
    },
    modifiers: [],
    dependsOn: ['SN-002'],
    displayConfig: {
      dashboard: 'fee-earner',
      position: 'primary',
      chartType: 'gauge',
    },
  },

  // ---------------------------------------------------------------------------
  // F-TU-02: Recording Consistency
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-TU-02',
    name: 'Recording Consistency',
    description:
      'Identifies gaps in a fee earner\'s time recording by comparing expected working days ' +
      'with days that have at least one time entry. A low score indicates potential under-recording, ' +
      'compliance risk, or WIP leakage.',
    category: 'utilisation',
    formulaType: 'built_in',
    entityType: EntityType.FEE_EARNER,
    resultType: 'percentage',
    definition: {
      approach:
        'Count the number of distinct calendar dates within the period that have at least one time entry ' +
        'for the fee earner. Divide by the number of expected working days in the same period, then multiply by 100. ' +
        'Expected working days excludes weekends and bank holidays.',
      numeratorFields: ['date'],
      denominatorFields: [],
      filters: [
        'Count only working days (Mon–Fri, excluding bank holidays)',
        'A day counts as recorded if at least one time entry exists for that date',
      ],
      configDependencies: ['bankHolidaysPerYear', 'workingDaysPerWeek'],
      dataRequirements: ['feeEarner', 'timeEntry'],
      nullHandling:
        'Return null if there are no time entries in the period; ' +
        'return null if expected working days is zero',
      aggregationLevel: 'feeEarner',
    },
    activeVariant: 'default',
    variants: {
      default: {
        name: 'Default',
        description: 'Days with at least one entry versus expected working days.',
        logic:
          'Count distinct entry dates within the period. ' +
          'Divide by expected working days (calendar days minus weekends and firm bank holidays).',
      },
    },
    modifiers: [],
    dependsOn: [],
    displayConfig: {
      dashboard: 'fee-earner',
      position: 'secondary',
      chartType: 'scorecard',
    },
  },

  // ---------------------------------------------------------------------------
  // F-TU-03: Non-Chargeable Time Breakdown
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-TU-03',
    name: 'Non-Chargeable Time Breakdown',
    description:
      'Splits a fee earner\'s total recorded time into chargeable and non-chargeable components. ' +
      'Non-chargeable time is further categorised by reason (do-not-bill, write-off, internal). ' +
      'Used to surface hidden cost and inform training or process improvements.',
    category: 'utilisation',
    formulaType: 'built_in',
    entityType: EntityType.FEE_EARNER,
    resultType: 'percentage',
    definition: {
      approach:
        'Group all time entries by their billing disposition: ' +
        'chargeable (doNotBill=false, billable>0), ' +
        'do-not-bill (doNotBill=true), ' +
        'write-off (writeOff>0), ' +
        'and internal (no matter). ' +
        'Express each group as a percentage of total recorded hours.',
      numeratorFields: ['durationMinutes', 'doNotBill', 'writeOff', 'billable'],
      denominatorFields: [],
      filters: ['No pre-filters — includes all time entries for the fee earner'],
      configDependencies: [],
      dataRequirements: ['feeEarner', 'timeEntry'],
      nullHandling:
        'Return null if there are no time entries in the period; ' +
        'an entry can belong to only one category — precedence: do-not-bill, then write-off, then chargeable',
      aggregationLevel: 'feeEarner',
    },
    activeVariant: 'default',
    variants: {
      default: {
        name: 'Default',
        description: 'Four-way split: chargeable, do-not-bill, write-off, internal.',
        logic:
          'Group entries by billing disposition. ' +
          'Sum durationMinutes per group. ' +
          'Divide each group total by the overall total and multiply by 100.',
      },
    },
    modifiers: [],
    dependsOn: [],
    displayConfig: {
      dashboard: 'fee-earner',
      position: 'detail',
      chartType: 'donut',
    },
  },

  // ---------------------------------------------------------------------------
  // F-RB-01: Realisation Rate
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-RB-01',
    name: 'Realisation Rate',
    description:
      'Measures how much of the potential billable value is actually billed and collected. ' +
      'A low rate indicates leakage through write-offs, discounting, or unbilled WIP. ' +
      'Expressed as a percentage; compared against firm and per-grade RAG thresholds.',
    category: 'revenue',
    formulaType: 'built_in',
    entityType: EntityType.FEE_EARNER,
    resultType: 'percentage',
    definition: {
      approach:
        'Divide the net billed amount by the total potential billable value, then multiply by 100. ' +
        'Potential billable value is the sum of billable amounts across all relevant time entries. ' +
        'Net billed is the invoiced amount after write-offs.',
      numeratorFields: ['netBilling', 'paid'],
      denominatorFields: ['billable'],
      filters: [
        'Active variant determines which matters and entries are included',
      ],
      configDependencies: ['utilisationApproach'],
      dataRequirements: ['feeEarner', 'timeEntry', 'matter', 'invoice'],
      nullHandling:
        'Return null if total billable value is zero or null; ' +
        'return null if there are no time entries in the period',
      aggregationLevel: 'feeEarner',
    },
    activeVariant: 'time_billed_only',
    variants: {
      time_billed_only: {
        name: 'Time-Billed Only',
        description: 'Uses only time-based billing — excludes fixed fees and disbursements.',
        logic:
          'Numerator: sum of netBilling on invoiced time entries. ' +
          'Denominator: sum of billable across all recorded time entries in the period.',
      },
      all_matters: {
        name: 'All Matters',
        description: 'Includes fixed-fee matters and disbursements in both numerator and denominator.',
        logic:
          'Numerator: total net billing across all matter types. ' +
          'Denominator: total potential billing including fixed-fee uplift.',
      },
      adjusted_fixed_fee: {
        name: 'Adjusted Fixed Fee',
        description: 'Fixed-fee matters use the agreed fee as potential value rather than time × rate.',
        logic:
          'For time matters: billable is rate × hours. ' +
          'For fixed-fee matters: potential value is the agreed fixed fee amount.',
      },
    },
    modifiers: [],
    dependsOn: [],
    displayConfig: {
      dashboard: 'fee-earner',
      position: 'primary',
      chartType: 'gauge',
    },
  },

  // ---------------------------------------------------------------------------
  // F-RB-02: Effective Hourly Rate
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-RB-02',
    name: 'Effective Hourly Rate',
    description:
      'Calculates the actual revenue earned per hour worked by dividing net billed value ' +
      'by total chargeable hours. Compares against the fee earner\'s standard rate to reveal ' +
      'discounting, under-billing, or fixed-fee underperformance.',
    category: 'revenue',
    formulaType: 'built_in',
    entityType: EntityType.FEE_EARNER,
    resultType: 'currency',
    definition: {
      approach:
        'Divide total net billing by total chargeable hours. ' +
        'Chargeable hours are derived from time entries where doNotBill is false and billable > 0, ' +
        'converting durationMinutes to hours.',
      numeratorFields: ['netBilling'],
      denominatorFields: ['durationMinutes'],
      filters: [
        'Only chargeable time entries (doNotBill=false, billable>0) contribute to the denominator',
      ],
      configDependencies: [],
      dataRequirements: ['feeEarner', 'timeEntry', 'matter'],
      nullHandling:
        'Return null if chargeable hours is zero or null; ' +
        'return null if net billing is null',
      aggregationLevel: 'feeEarner',
    },
    activeVariant: 'default',
    variants: {
      default: {
        name: 'Default',
        description: 'Net billing divided by chargeable hours.',
        logic:
          'Sum netBilling across all invoiced matters for the fee earner. ' +
          'Sum durationMinutes for chargeable entries and convert to hours. ' +
          'Divide net billing by chargeable hours.',
      },
    },
    modifiers: [],
    dependsOn: [],
    displayConfig: {
      dashboard: 'fee-earner',
      position: 'secondary',
      chartType: 'scorecard',
    },
  },

  // ---------------------------------------------------------------------------
  // F-RB-03: Revenue per Fee Earner
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-RB-03',
    name: 'Revenue per Fee Earner',
    description:
      'Total net billing attributed to a fee earner in the period. ' +
      'Provides an absolute revenue figure for ranking, benchmarking, and trend analysis. ' +
      'Aggregated to department or firm level for comparative views.',
    category: 'revenue',
    formulaType: 'built_in',
    entityType: EntityType.FEE_EARNER,
    resultType: 'currency',
    definition: {
      approach:
        'Sum netBilling across all matters where the fee earner is the responsible lawyer ' +
        'within the selected period. Attribution follows the firm\'s revenueAttribution config setting.',
      numeratorFields: ['netBilling'],
      denominatorFields: [],
      filters: [
        'Include only matters attributed to the fee earner per revenueAttribution setting',
        'Include only billing events within the selected date range',
      ],
      configDependencies: ['revenueAttribution'],
      dataRequirements: ['feeEarner', 'matter', 'invoice'],
      nullHandling:
        'Return 0 if the fee earner has no attributed billing in the period; ' +
        'never return null — a zero is meaningful',
      aggregationLevel: 'feeEarner',
    },
    activeVariant: 'default',
    variants: {
      default: {
        name: 'Default',
        description: 'Sum of net billing attributed to the fee earner.',
        logic:
          'Sum netBilling from all matters where responsibleLawyer matches the fee earner. ' +
          'Apply date range filter to billing events.',
      },
    },
    modifiers: [],
    dependsOn: [],
    displayConfig: {
      dashboard: 'fee-earner',
      position: 'primary',
      chartType: 'bar',
    },
  },

  // ---------------------------------------------------------------------------
  // F-RB-04: Billing Velocity
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-RB-04',
    name: 'Billing Velocity',
    description:
      'Measures the rate at which WIP is converted to invoices. ' +
      'Calculated as the average number of days between the last time entry on a matter ' +
      'and the date the invoice is raised. A high velocity indicates slow billing cycles ' +
      'and potential cash flow risk.',
    category: 'revenue',
    formulaType: 'built_in',
    entityType: EntityType.MATTER,
    resultType: 'days',
    definition: {
      approach:
        'For each invoiced matter, compute the gap between the date of the last time entry ' +
        'and the invoice date. Average this gap across all matters in the period.',
      numeratorFields: ['invoiceDate', 'date'],
      denominatorFields: [],
      filters: [
        'Include only matters that have at least one invoice in the period',
        'Exclude matters with no time entries',
      ],
      configDependencies: [],
      dataRequirements: ['matter', 'timeEntry', 'invoice'],
      nullHandling:
        'Return null if no invoiced matters exist in the period; ' +
        'exclude individual matters where invoiceDate or last entry date is missing',
      aggregationLevel: 'matter',
    },
    activeVariant: 'default',
    variants: {
      default: {
        name: 'Default',
        description: 'Average days from last time entry to invoice date.',
        logic:
          'For each matter, find the maximum entry date and the earliest invoice date. ' +
          'Compute the difference in calendar days. ' +
          'Average across all qualifying matters.',
      },
    },
    modifiers: [],
    dependsOn: [],
    displayConfig: {
      dashboard: 'firm',
      position: 'secondary',
      chartType: 'trend',
    },
  },

  // ---------------------------------------------------------------------------
  // F-WL-01: WIP Age
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-WL-01',
    name: 'WIP Age',
    description:
      'Measures how old unbilled work in progress is. Old WIP indicates billing delays, ' +
      'potential write-off risk, and cash flow pressure. The active variant controls ' +
      'whether age is measured from the oldest, average, or weighted-average entry.',
    category: 'leakage',
    formulaType: 'built_in',
    entityType: EntityType.MATTER,
    resultType: 'days',
    definition: {
      approach:
        'For each matter with unbilled time entries, compute the age of those entries ' +
        'relative to today according to the active variant. ' +
        'Unbilled entries are those not yet associated with a posted invoice.',
      numeratorFields: ['date'],
      denominatorFields: [],
      filters: [
        'Include only time entries not yet associated with a posted invoice',
        'Exclude time entries with doNotBill=true from age calculations',
      ],
      configDependencies: [],
      dataRequirements: ['matter', 'timeEntry', 'invoice'],
      nullHandling:
        'Return null if the matter has no unbilled time entries; ' +
        'return null if entry dates are missing',
      aggregationLevel: 'matter',
    },
    activeVariant: 'oldest_entry',
    variants: {
      oldest_entry: {
        name: 'Oldest Entry',
        description: 'Age measured from the date of the oldest unbilled time entry.',
        logic:
          'Find the minimum entry date among unbilled time entries for the matter. ' +
          'Subtract from today\'s date to get age in calendar days.',
      },
      average_entry: {
        name: 'Average Entry',
        description: 'Age measured from the arithmetic mean of all unbilled entry dates.',
        logic:
          'Compute the average of all unbilled entry dates (mean of date values). ' +
          'Subtract from today\'s date to get age in calendar days.',
      },
      weighted_average: {
        name: 'Weighted Average',
        description: 'Age measured from the billable-value-weighted mean entry date.',
        logic:
          'Weight each unbilled entry date by its billable value. ' +
          'Compute the weighted mean date. ' +
          'Subtract from today\'s date to get age in calendar days.',
      },
    },
    modifiers: [],
    dependsOn: [],
    displayConfig: {
      dashboard: 'matter',
      position: 'primary',
      chartType: 'bar',
    },
  },

  // ---------------------------------------------------------------------------
  // F-WL-02: Write-Off Analysis
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-WL-02',
    name: 'Write-Off Analysis',
    description:
      'Quantifies the total value written off and expresses it as a percentage of gross billing. ' +
      'Breaks down write-offs by matter, fee earner, and reason where available. ' +
      'A leading indicator of pricing, scope, and client-relation problems.',
    category: 'leakage',
    formulaType: 'built_in',
    entityType: EntityType.FEE_EARNER,
    resultType: 'percentage',
    definition: {
      approach:
        'Sum all writeOff amounts for the fee earner in the period. ' +
        'Divide by the sum of gross billing (billable value before write-offs) and multiply by 100. ' +
        'Also surface the absolute write-off amount alongside the percentage.',
      numeratorFields: ['writeOff'],
      denominatorFields: ['billable'],
      filters: [
        'Include only time entries and invoice adjustments with writeOff > 0',
      ],
      configDependencies: [],
      dataRequirements: ['feeEarner', 'timeEntry', 'matter', 'invoice'],
      nullHandling:
        'Return 0 (not null) when there are no write-offs; ' +
        'return null if gross billing is zero or null',
      aggregationLevel: 'feeEarner',
    },
    activeVariant: 'default',
    variants: {
      default: {
        name: 'Default',
        description: 'Write-off value and percentage of gross billing.',
        logic:
          'Sum writeOff across all entries and invoice adjustments. ' +
          'Divide by sum of billable (gross potential billing). ' +
          'Multiply by 100 for the percentage output.',
      },
    },
    modifiers: [],
    dependsOn: [],
    displayConfig: {
      dashboard: 'fee-earner',
      position: 'secondary',
      chartType: 'bar',
    },
  },

  // ---------------------------------------------------------------------------
  // F-WL-03: Disbursement Recovery
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-WL-03',
    name: 'Disbursement Recovery',
    description:
      'Measures what proportion of disbursements incurred are recovered from clients. ' +
      'Unrecovered disbursements are a direct cost to the firm. ' +
      'Expressed as a percentage; low recovery highlights billing process gaps.',
    category: 'leakage',
    formulaType: 'built_in',
    entityType: EntityType.MATTER,
    resultType: 'percentage',
    definition: {
      approach:
        'Divide total disbursements billed to the client by total disbursements incurred, ' +
        'then multiply by 100. ' +
        'Disbursements incurred come from disbursement records; ' +
        'disbursements billed come from invoice line items.',
      numeratorFields: ['totalDisbursements', 'invoicedDisbursements'],
      denominatorFields: ['totalDisbursements'],
      filters: [
        'Include only disbursements within the selected date range',
      ],
      configDependencies: [],
      dataRequirements: ['matter', 'disbursement', 'invoice'],
      nullHandling:
        'Return null if no disbursements were incurred in the period; ' +
        'return 0 if disbursements were incurred but none billed',
      aggregationLevel: 'matter',
    },
    activeVariant: 'default',
    variants: {
      default: {
        name: 'Default',
        description: 'Billed disbursements as a percentage of incurred disbursements.',
        logic:
          'Sum invoicedDisbursements from closed matter records and invoice line items. ' +
          'Sum totalDisbursements incurred from disbursement records. ' +
          'Divide and multiply by 100.',
      },
    },
    modifiers: [],
    dependsOn: [],
    displayConfig: {
      dashboard: 'matter',
      position: 'secondary',
      chartType: 'scorecard',
    },
  },

  // ---------------------------------------------------------------------------
  // F-WL-04: Lock-Up Days
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-WL-04',
    name: 'Lock-Up Days',
    description:
      'Measures total capital tied up in unbilled WIP and unpaid invoices, expressed in days of revenue. ' +
      'Combines WIP age (F-WL-01) and debtor days (F-DM-01) to give a complete cash cycle picture. ' +
      'A firm KPI used by management and finance teams.',
    category: 'leakage',
    formulaType: 'built_in',
    entityType: EntityType.FIRM,
    resultType: 'days',
    definition: {
      approach:
        'Lock-up days is the sum of WIP days and debtor days. ' +
        'WIP days is total unbilled WIP value divided by average daily revenue. ' +
        'Debtor days is total outstanding invoices divided by average daily revenue. ' +
        'Average daily revenue is annualised billing divided by 365.',
      numeratorFields: ['netBilling', 'outstanding', 'billable'],
      denominatorFields: [],
      filters: [
        'Active variant determines the reference date for invoice age',
      ],
      configDependencies: [],
      dataRequirements: ['matter', 'timeEntry', 'invoice'],
      nullHandling:
        'Return null if average daily revenue is zero; ' +
        'return null if there are no active matters',
      aggregationLevel: 'firm',
    },
    activeVariant: 'from_due_date',
    variants: {
      from_due_date: {
        name: 'From Due Date',
        description: 'Debtor age measured from invoice due date.',
        logic:
          'For aged debtors, compute days outstanding as today minus dueDate. ' +
          'For WIP, use the F-WL-01 oldest_entry result. ' +
          'Sum both components.',
      },
      from_invoice_date: {
        name: 'From Invoice Date',
        description: 'Debtor age measured from invoice issue date.',
        logic:
          'For aged debtors, compute days outstanding as today minus invoiceDate. ' +
          'For WIP, use the F-WL-01 oldest_entry result. ' +
          'Sum both components.',
      },
      from_payment_date: {
        name: 'From Payment Date',
        description: 'Uses actual payment date where available; falls back to due date.',
        logic:
          'Where datePaid is present, use it to compute settled debtor days. ' +
          'Where datePaid is absent, fall back to dueDate.',
      },
    },
    modifiers: [],
    dependsOn: ['F-WL-01', 'F-DM-01'],
    displayConfig: {
      dashboard: 'firm',
      position: 'primary',
      chartType: 'scorecard',
    },
  },

  // ---------------------------------------------------------------------------
  // F-PR-01: Matter Profitability
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-PR-01',
    name: 'Matter Profitability',
    description:
      'Calculates the profit generated by a single matter. ' +
      'Revenue is the firm-retained portion of billing (SN-003); ' +
      'cost is derived from SN-005 per fee earner per hour. ' +
      'The active variant controls cost allocation depth.',
    category: 'profitability',
    formulaType: 'built_in',
    entityType: EntityType.MATTER,
    resultType: 'currency',
    definition: {
      approach:
        'Profit = firm-retained revenue minus total employment cost for the matter. ' +
        'Firm-retained revenue uses SN-003 applied to netBilling. ' +
        'Employment cost sums SN-005 hourly cost rate multiplied by hours worked, ' +
        'per fee earner, across all time entries on the matter.',
      numeratorFields: ['netBilling', 'paid', 'durationMinutes'],
      denominatorFields: [],
      filters: [
        'Include all time entries linked to the matter',
        'Apply SN-003 to determine retained revenue for fee share earners',
      ],
      configDependencies: ['costRateMethod', 'defaultFirmRetainPercent'],
      dataRequirements: ['matter', 'feeEarner', 'timeEntry', 'invoice'],
      nullHandling:
        'Return null if the matter has no billing; ' +
        'return null if cost rate cannot be determined for any contributing fee earner; ' +
        'partial costs where one earner\'s rate is missing should surface as a warning flag, not null',
      aggregationLevel: 'matter',
    },
    activeVariant: 'standard',
    variants: {
      simple: {
        name: 'Simple',
        description: 'Revenue minus direct salary cost only; no overheads.',
        logic:
          'Revenue: firm-retained billing via SN-003. ' +
          'Cost: annualSalary ÷ available hours (SN-002) × hours on matter, per earner.',
      },
      standard: {
        name: 'Standard',
        description: 'Revenue minus fully loaded cost (SN-001) per hour worked.',
        logic:
          'Revenue: firm-retained billing via SN-003. ' +
          'Cost: SN-005 cost rate × hours worked per earner, summed across all earners on the matter.',
      },
      full: {
        name: 'Full',
        description: 'Standard cost plus an overhead allocation based on fee earner FTE share.',
        logic:
          'Revenue: firm-retained billing via SN-003. ' +
          'Cost: SN-005 fully loaded rate × hours, plus overhead allocation from firm config overhead rate.',
      },
    },
    modifiers: [],
    dependsOn: ['SN-001', 'SN-003', 'SN-005'],
    displayConfig: {
      dashboard: 'matter',
      position: 'primary',
      chartType: 'waterfall',
    },
  },

  // ---------------------------------------------------------------------------
  // F-PR-02: Fee Earner Profitability
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-PR-02',
    name: 'Fee Earner Profitability',
    description:
      'Net profit contribution of a fee earner over a period. ' +
      'Revenue is firm-retained billing; cost is annual employment cost (SN-004) ' +
      'prorated to the period. Used for performance reviews and resource planning.',
    category: 'profitability',
    formulaType: 'built_in',
    entityType: EntityType.FEE_EARNER,
    resultType: 'currency',
    definition: {
      approach:
        'Profit = firm-retained billing minus prorated employment cost. ' +
        'Firm-retained billing sums SN-003 across all matters for the fee earner. ' +
        'Prorated employment cost scales SN-004 annual cost to the period duration.',
      numeratorFields: ['netBilling', 'paid'],
      denominatorFields: [],
      filters: [
        'Include only billing attributed to the fee earner',
        'Prorate employment cost to the selected period',
      ],
      configDependencies: ['costRateMethod', 'defaultFirmRetainPercent'],
      dataRequirements: ['feeEarner', 'matter', 'invoice'],
      nullHandling:
        'Return null for fee share earners if firmRetainPercent is missing; ' +
        'return null for salaried earners if annualSalary is missing',
      aggregationLevel: 'feeEarner',
    },
    activeVariant: 'default',
    variants: {
      default: {
        name: 'Default',
        description: 'Firm-retained billing minus prorated employment cost.',
        logic:
          'Revenue: sum SN-003 across all matters for the fee earner in the period. ' +
          'Cost: SN-004 annual cost × (period days ÷ 365). ' +
          'Profit = revenue − cost.',
      },
    },
    modifiers: [],
    dependsOn: ['SN-001', 'SN-004'],
    displayConfig: {
      dashboard: 'fee-earner',
      position: 'primary',
      chartType: 'bar',
    },
  },

  // ---------------------------------------------------------------------------
  // F-PR-03: Department Profitability
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-PR-03',
    name: 'Department Profitability',
    description:
      'Aggregate profitability for a department, summing fee earner profits (F-PR-02) ' +
      'for all earners in that department. Enables cross-department comparison ' +
      'and resource allocation decisions.',
    category: 'profitability',
    formulaType: 'built_in',
    entityType: EntityType.DEPARTMENT,
    resultType: 'currency',
    definition: {
      approach:
        'Sum F-PR-02 results for all fee earners belonging to the department in the period. ' +
        'Department membership is determined by the fee earner\'s department field.',
      numeratorFields: ['netBilling'],
      denominatorFields: [],
      filters: [
        'Include only fee earners whose department matches the target department',
      ],
      configDependencies: [],
      dataRequirements: ['department', 'feeEarner', 'matter', 'invoice'],
      nullHandling:
        'Return null if the department has no fee earners; ' +
        'exclude individual earners with null F-PR-02 results from the sum but flag the gap',
      aggregationLevel: 'department',
    },
    activeVariant: 'default',
    variants: {
      default: {
        name: 'Default',
        description: 'Sum of F-PR-02 for all fee earners in the department.',
        logic:
          'Retrieve F-PR-02 for every fee earner in the department. ' +
          'Sum the results. Exclude nulls but record a warning if any are null.',
      },
    },
    modifiers: [],
    dependsOn: ['F-PR-02'],
    displayConfig: {
      dashboard: 'firm',
      position: 'primary',
      chartType: 'bar',
    },
  },

  // ---------------------------------------------------------------------------
  // F-PR-04: Client Profitability
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-PR-04',
    name: 'Client Profitability',
    description:
      'Measures total profit from all matters associated with a client. ' +
      'Sums fee earner profitability contributions (F-PR-02) across all matters ' +
      'linked to that client. Identifies the most and least profitable client relationships.',
    category: 'profitability',
    formulaType: 'built_in',
    entityType: EntityType.CLIENT,
    resultType: 'currency',
    definition: {
      approach:
        'For each matter linked to the client, sum F-PR-02 contributions from all fee earners ' +
        'who worked on it. Client linkage comes from the matter\'s client field.',
      numeratorFields: ['netBilling'],
      denominatorFields: [],
      filters: [
        'Include only matters linked to the target client',
      ],
      configDependencies: [],
      dataRequirements: ['client', 'matter', 'feeEarner', 'invoice'],
      nullHandling:
        'Return null if the client has no matters with billing in the period; ' +
        'a client with matters but no billing returns 0',
      aggregationLevel: 'matter',
    },
    activeVariant: 'default',
    variants: {
      default: {
        name: 'Default',
        description: 'Sum of matter-level profitability across all client matters.',
        logic:
          'Find all matters where clients includes the target client. ' +
          'For each matter, sum F-PR-02 contributions from all responsible fee earners. ' +
          'Sum across all matters.',
      },
    },
    modifiers: [],
    dependsOn: ['F-PR-02'],
    displayConfig: {
      dashboard: 'matter',
      position: 'secondary',
      chartType: 'bar',
    },
  },

  // ---------------------------------------------------------------------------
  // F-PR-05: Firm Profitability
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-PR-05',
    name: 'Firm Profitability',
    description:
      'Total net profit for the firm in the period. ' +
      'Aggregates fee earner profitability (F-PR-02) and department profitability (F-PR-03) ' +
      'to provide firm-wide P&L visibility. Used for board reporting and financial planning.',
    category: 'profitability',
    formulaType: 'built_in',
    entityType: EntityType.FIRM,
    resultType: 'currency',
    definition: {
      approach:
        'Sum F-PR-02 across all fee earners in the firm for the period. ' +
        'Cross-check against F-PR-03 department totals to confirm consistency. ' +
        'The firm-level result is the canonical figure.',
      numeratorFields: ['netBilling'],
      denominatorFields: [],
      filters: ['Include all fee earners and billing in the period'],
      configDependencies: [],
      dataRequirements: ['feeEarner', 'department', 'matter', 'invoice'],
      nullHandling:
        'Return null if the firm has no billing in the period; ' +
        'flag if F-PR-02 and F-PR-03 totals are inconsistent',
      aggregationLevel: 'firm',
    },
    activeVariant: 'default',
    variants: {
      default: {
        name: 'Default',
        description: 'Sum of all fee earner F-PR-02 results for the firm.',
        logic:
          'Retrieve F-PR-02 for every active fee earner. ' +
          'Sum results. Exclude nulls but surface a discrepancy warning.',
      },
    },
    modifiers: [],
    dependsOn: ['F-PR-02', 'F-PR-03'],
    displayConfig: {
      dashboard: 'firm',
      position: 'primary',
      chartType: 'waterfall',
    },
  },

  // ---------------------------------------------------------------------------
  // F-BS-01: Budget Burn Rate
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-BS-01',
    name: 'Budget Burn Rate',
    description:
      'Tracks how much of a matter\'s budget has been consumed relative to expected progress. ' +
      'A burn rate above 100% at mid-matter indicates scope creep or underpricing. ' +
      'Only available for matters with a financial limit set.',
    category: 'budget',
    formulaType: 'built_in',
    entityType: EntityType.MATTER,
    resultType: 'percentage',
    definition: {
      approach:
        'Divide the amount consumed (by value or hours depending on the active variant) ' +
        'by the budget limit, then multiply by 100. ' +
        'Amount consumed uses actual billing or recorded time to date.',
      numeratorFields: ['netBilling', 'durationMinutes', 'billable'],
      denominatorFields: ['financialLimit'],
      filters: [
        'Only compute for matters where financialLimit > 0 (hasBudget = true)',
        'Include all billing and time entries up to today',
      ],
      configDependencies: [],
      dataRequirements: ['matter', 'timeEntry', 'invoice'],
      nullHandling:
        'Return null if financialLimit is 0 or absent; ' +
        'return null if no billing or time has been recorded on the matter',
      aggregationLevel: 'matter',
    },
    activeVariant: 'by_value',
    variants: {
      by_value: {
        name: 'By Value',
        description: 'Budget consumption measured in billing value (£).',
        logic:
          'Numerator: sum of netBilling and billable WIP on the matter. ' +
          'Denominator: financialLimit. ' +
          'Multiply by 100.',
      },
      by_hours: {
        name: 'By Hours',
        description: 'Budget consumption measured in hours against a target hour budget.',
        logic:
          'Numerator: sum of durationMinutes for all time entries, converted to hours. ' +
          'Denominator: budget expressed in hours (financialLimit ÷ average fee earner rate). ' +
          'Multiply by 100.',
      },
    },
    modifiers: [],
    dependsOn: [],
    displayConfig: {
      dashboard: 'matter',
      position: 'primary',
      chartType: 'gauge',
    },
  },

  // ---------------------------------------------------------------------------
  // F-BS-02: Scope Creep Indicator
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-BS-02',
    name: 'Scope Creep Indicator',
    description:
      'Combines budget burn rate (F-BS-01) with realisation rate (F-RB-01) ' +
      'to identify matters where work is exceeding budget AND billing is being discounted. ' +
      'A composite flag — matters scoring high on both are high-risk for profitability.',
    category: 'budget',
    formulaType: 'built_in',
    entityType: EntityType.MATTER,
    resultType: 'score',
    definition: {
      approach:
        'Scope creep score is derived from two inputs: ' +
        'budget overrun (F-BS-01 result minus 100, clamped at 0) and ' +
        'realisation shortfall (100 minus F-RB-01 result, clamped at 0). ' +
        'Combine the two components to produce a 0–100 composite score.',
      numeratorFields: [],
      denominatorFields: [],
      filters: [
        'Only compute for matters with hasBudget = true',
        'Only compute for matters with at least one invoice',
      ],
      configDependencies: [],
      dataRequirements: ['matter', 'timeEntry', 'invoice'],
      nullHandling:
        'Return null if F-BS-01 or F-RB-01 returns null for the matter; ' +
        'a score of 0 means no scope creep detected',
      aggregationLevel: 'matter',
    },
    activeVariant: 'default',
    variants: {
      default: {
        name: 'Default',
        description: 'Combined overrun and realisation shortfall score.',
        logic:
          'overrun = max(0, F-BS-01 − 100). ' +
          'shortfall = max(0, 100 − F-RB-01). ' +
          'Score = average of normalised overrun and shortfall, scaled to 0–100.',
      },
    },
    modifiers: [],
    dependsOn: ['F-BS-01', 'F-RB-01'],
    displayConfig: {
      dashboard: 'matter',
      position: 'secondary',
      chartType: 'scorecard',
    },
  },

  // ---------------------------------------------------------------------------
  // F-DM-01: Aged Debtor Analysis
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-DM-01',
    name: 'Aged Debtor Analysis',
    description:
      'Analyses outstanding invoices by age band (0–30, 31–60, 61–90, 90+ days). ' +
      'Provides a breakdown of unpaid invoices to support credit control and cash forecasting. ' +
      'A firm-level KPI with matter and client drill-down.',
    category: 'debtors',
    formulaType: 'built_in',
    entityType: EntityType.INVOICE,
    resultType: 'currency',
    definition: {
      approach:
        'For each unpaid or partially paid invoice, compute the number of days since the reference date ' +
        '(dueDate by default). Assign to an age band. Sum outstanding amounts per band.',
      numeratorFields: ['outstanding', 'dueDate', 'invoiceDate'],
      denominatorFields: [],
      filters: [
        'Include only invoices where outstanding > 0',
        'Exclude fully paid invoices',
        'Exclude draft invoices (invoiceNumber is null)',
      ],
      configDependencies: [],
      dataRequirements: ['invoice', 'matter'],
      nullHandling:
        'Return null if there are no outstanding invoices; ' +
        'exclude invoices with missing dueDate from age banding but include in an unassigned bucket',
      aggregationLevel: 'firm',
    },
    activeVariant: 'default',
    variants: {
      default: {
        name: 'Default',
        description: 'Age banded from invoice due date.',
        logic:
          'Compute days outstanding as today minus dueDate for each invoice. ' +
          'Assign to bands: 0–30, 31–60, 61–90, 91+. ' +
          'Sum outstanding amounts per band.',
      },
    },
    modifiers: [],
    dependsOn: [],
    displayConfig: {
      dashboard: 'firm',
      position: 'primary',
      chartType: 'bar',
    },
  },

  // ---------------------------------------------------------------------------
  // F-DM-02: Payment Behaviour Score
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-DM-02',
    name: 'Payment Behaviour Score',
    description:
      'Scores clients on their historical payment behaviour using aged debtor data (F-DM-01). ' +
      'Considers average days to pay, proportion of late invoices, and maximum debt age. ' +
      'Produces a 0–100 score for credit risk and client relationship management.',
    category: 'debtors',
    formulaType: 'built_in',
    entityType: EntityType.CLIENT,
    resultType: 'score',
    definition: {
      approach:
        'Three inputs: average days to pay (historical), proportion of invoices paid late, ' +
        'and current maximum outstanding age from F-DM-01. ' +
        'Each input is normalised to a 0–100 component and combined using equal weights.',
      numeratorFields: ['dueDate', 'invoiceDate', 'outstanding'],
      denominatorFields: [],
      filters: [
        'Include all invoices (paid and outstanding) for the client in a trailing 12-month window',
      ],
      configDependencies: [],
      dataRequirements: ['client', 'invoice'],
      nullHandling:
        'Return null if the client has fewer than 3 historical invoices; ' +
        'return null if datePaid is absent for all historical invoices (cannot compute average days to pay)',
      aggregationLevel: 'matter',
    },
    activeVariant: 'default',
    variants: {
      default: {
        name: 'Default',
        description: 'Equal-weighted score from days-to-pay, late rate, and current age.',
        logic:
          'avgDaysToPay: mean of (datePaid − dueDate) for settled invoices. ' +
          'lateRate: proportion of invoices paid after dueDate. ' +
          'currentAge: F-DM-01 maximum age band for this client. ' +
          'Score = 100 − average of three normalised components.',
      },
    },
    modifiers: [],
    dependsOn: ['F-DM-01'],
    displayConfig: {
      dashboard: 'firm',
      position: 'secondary',
      chartType: 'scorecard',
    },
  },

  // ---------------------------------------------------------------------------
  // F-CS-01: Recovery Opportunity
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-CS-01',
    name: 'Recovery Opportunity',
    description:
      'Estimates the revenue recoverable if a fee earner\'s utilisation and realisation ' +
      'were raised to their RAG green threshold. ' +
      'A monetary figure that prioritises coaching and process investment by impact.',
    category: 'composite',
    formulaType: 'built_in',
    entityType: EntityType.FEE_EARNER,
    resultType: 'currency',
    definition: {
      approach:
        'Gap analysis: compute target utilisation hours from the RAG green threshold, ' +
        'subtract actual chargeable hours (F-TU-01 denominator), and multiply the gap ' +
        'by the fee earner\'s standard rate and the realisation rate (F-RB-01). ' +
        'Combine the utilisation gap and realisation gap into a total opportunity figure.',
      numeratorFields: ['rate', 'durationMinutes', 'netBilling'],
      denominatorFields: [],
      filters: [
        'Only compute for fee earners who are below the RAG green threshold on F-TU-01 or F-RB-01',
      ],
      configDependencies: ['weeklyTargetHours', 'utilisationApproach'],
      dataRequirements: ['feeEarner', 'timeEntry', 'matter', 'invoice'],
      nullHandling:
        'Return 0 if the fee earner is at or above both green thresholds; ' +
        'return null if rate is missing for the fee earner; ' +
        'return null if F-TU-01 or F-RB-01 returns null',
      aggregationLevel: 'feeEarner',
    },
    activeVariant: 'default',
    variants: {
      default: {
        name: 'Default',
        description: 'Utilisation and realisation gap revenue, combined.',
        logic:
          'utilisationGap = (greenThresholdHours − actualChargeableHours) × rate. ' +
          'realisationGap = actual billing × (1 − F-RB-01 / 100). ' +
          'Total opportunity = utilisationGap + realisationGap.',
      },
    },
    modifiers: [],
    dependsOn: ['F-RB-01', 'F-TU-01', 'F-WL-01'],
    displayConfig: {
      dashboard: 'fee-earner',
      position: 'detail',
      chartType: 'scorecard',
    },
  },

  // ---------------------------------------------------------------------------
  // F-CS-02: Fee Earner Scorecard
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-CS-02',
    name: 'Fee Earner Scorecard',
    description:
      'Composite performance score (0–100) for a fee earner across four dimensions: ' +
      'utilisation, realisation, recording consistency, and write-off rate. ' +
      'Each dimension is normalised against its RAG thresholds and combined using config weights.',
    category: 'composite',
    formulaType: 'built_in',
    entityType: EntityType.FEE_EARNER,
    resultType: 'score',
    definition: {
      approach:
        'Score each of the four component formulas (F-TU-01, F-RB-01, F-TU-02, F-WL-02) ' +
        'against their RAG thresholds: green = 100, amber = 50, red = 0. ' +
        'Apply config-defined weights to each component and sum to produce the overall score.',
      numeratorFields: [],
      denominatorFields: [],
      filters: ['Compute for fee earners with at least one time entry in the period'],
      configDependencies: ['scorecardWeights'],
      dataRequirements: ['feeEarner', 'timeEntry', 'matter', 'invoice'],
      nullHandling:
        'Return null if any component formula returns null; ' +
        'flag which component was missing to assist investigation',
      aggregationLevel: 'feeEarner',
    },
    activeVariant: 'default',
    variants: {
      default: {
        name: 'Default',
        description: 'Weighted average of four normalised component scores.',
        logic:
          'For each component: map green→100, amber→50, red→0 using RAG threshold boundaries. ' +
          'Multiply each score by its weight from scorecardWeights config. ' +
          'Sum weighted scores and divide by total weight.',
      },
    },
    modifiers: [],
    dependsOn: ['F-TU-01', 'F-RB-01', 'F-TU-02', 'F-WL-02'],
    displayConfig: {
      dashboard: 'fee-earner',
      position: 'primary',
      chartType: 'scorecard',
    },
  },

  // ---------------------------------------------------------------------------
  // F-CS-03: Matter Health Score
  // ---------------------------------------------------------------------------
  {
    formulaId: 'F-CS-03',
    name: 'Matter Health Score',
    description:
      'Composite score (0–100) reflecting the overall health of a matter. ' +
      'Combines WIP age, budget burn, realisation rate, and disbursement recovery. ' +
      'Used on the matter dashboard to surface at-risk matters for early intervention.',
    category: 'composite',
    formulaType: 'built_in',
    entityType: EntityType.MATTER,
    resultType: 'score',
    definition: {
      approach:
        'Score each of the four components (F-WL-01, F-BS-01, F-RB-01, F-WL-03) ' +
        'against their RAG thresholds, normalising to 0–100. ' +
        'Apply equal weights (25% each) unless overridden by scorecardWeights config.',
      numeratorFields: [],
      denominatorFields: [],
      filters: [
        'Only compute for active or recently closed matters',
        'F-BS-01 component is excluded (and weight redistributed) when hasBudget = false',
      ],
      configDependencies: ['scorecardWeights'],
      dataRequirements: ['matter', 'timeEntry', 'invoice', 'disbursement'],
      nullHandling:
        'Return null if all component formulas return null; ' +
        'if F-BS-01 is null (no budget), redistribute its weight equally to remaining components',
      aggregationLevel: 'matter',
    },
    activeVariant: 'default',
    variants: {
      default: {
        name: 'Default',
        description: 'Equal-weighted composite of WIP age, budget burn, realisation, and disbursement recovery.',
        logic:
          'Normalise each component score to 0–100 using RAG thresholds. ' +
          'If F-BS-01 is excluded, use three-way equal weights (33.3% each). ' +
          'Sum weighted scores.',
      },
    },
    modifiers: [],
    dependsOn: ['F-WL-01', 'F-BS-01', 'F-RB-01', 'F-WL-03'],
    displayConfig: {
      dashboard: 'matter',
      position: 'primary',
      chartType: 'scorecard',
    },
  },

];

// =============================================================================
// Public API
// =============================================================================

/** Returns all 23 built-in formula definitions. */
export function getBuiltInFormulaDefinitions(): BuiltInFormulaDefinition[] {
  return BUILT_IN_FORMULAS;
}
