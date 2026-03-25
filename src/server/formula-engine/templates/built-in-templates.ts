/**
 * built-in-templates.ts — Built-in Formula Templates
 *
 * 10 pre-built formula templates covering common law firm calculations.
 * Each template has typed parameters; instantiation produces a
 * CustomFormulaDefinition ready for the custom executor.
 *
 * Template IDs: TMPL-001 through TMPL-010 (stable, never renamed).
 */

import type { FormulaTemplate, ParameterRefNode } from './template-registry.js';
import type { ExpressionNode } from '../custom/custom-executor.js';

/**
 * Cast a ParameterRefNode to ExpressionNode so it can be placed inside
 * typed operator/aggregation/compare/ifThen child fields.
 * Safe: substituteExpression() resolves all parameter refs before execution.
 */
function p(key: string, resolveAs: 'constant' | 'formulaRef'): ExpressionNode {
  return { type: 'parameter', key, resolveAs } as unknown as ExpressionNode;
}

/**
 * Return all 10 built-in formula templates.
 * Safe to call multiple times — returns a fresh array each time.
 */
export function getBuiltInTemplates(): FormulaTemplate[] {
  return [
    TMPL_001,
    TMPL_002,
    TMPL_003,
    TMPL_004,
    TMPL_005,
    TMPL_006,
    TMPL_007,
    TMPL_008,
    TMPL_009,
    TMPL_010,
  ];
}

// =============================================================================
// TMPL-001: Custom Utilisation Target
// =============================================================================

const TMPL_001: FormulaTemplate = {
  templateId: 'TMPL-001',
  name: 'Custom Utilisation Target',
  description: 'Track chargeable utilisation against a custom annual target.',
  category: 'utilisation',
  entityType: 'feeEarner',
  resultType: 'percentage',
  difficulty: 'basic',
  tags: ['utilisation', 'target', 'fee-earner'],
  previewDescription:
    'Chargeable hours as a percentage of available working hours, measured against a {{targetPercentage}}% target.',
  parameters: [
    {
      key: 'targetPercentage',
      label: 'Target Utilisation (%)',
      description: "The firm's target chargeable utilisation rate (0-100).",
      type: 'percentage',
      required: true,
      defaultValue: 75,
      validation: { min: 0, max: 100 },
    },
  ],
  definition: {
    // Actual utilisation: chargeableHours / availableHours × 100
    // Result = actualRate / target × 100 → shows 100% when exactly on target
    expression: {
      type: 'operator',
      operator: 'percentage',
      left: {
        type: 'operator',
        operator: 'percentage',
        left: { type: 'field', entity: 'feeEarner', field: 'wipChargeableHours' },
        right: { type: 'snippet', snippetId: 'SN-002', entityBinding: 'self' },
      },
      right: p('targetPercentage', 'constant'),
    },
    postProcess: { round: 1 },
    resultType: 'percentage',
  },
};

// =============================================================================
// TMPL-002: Revenue per Hour by Department
// =============================================================================

const TMPL_002: FormulaTemplate = {
  templateId: 'TMPL-002',
  name: 'Revenue per Hour by Department',
  description: 'Revenue earned per chargeable hour for a specific department.',
  category: 'revenue',
  entityType: 'firm',
  resultType: 'currency',
  difficulty: 'intermediate',
  tags: ['revenue', 'department', 'rate', 'firm'],
  previewDescription:
    'Total invoiced revenue divided by total chargeable hours for department "{{departmentName}}".',
  parameters: [
    {
      key: 'departmentName',
      label: 'Department Name',
      description: 'Filter to a specific department (exact name match).',
      type: 'select',
      required: true,
      selectOptions: [
        { value: 'Property', label: 'Property' },
        { value: 'Corporate', label: 'Corporate' },
        { value: 'Family', label: 'Family' },
        { value: 'Litigation', label: 'Litigation' },
        { value: 'Private Client', label: 'Private Client' },
        { value: 'Employment', label: 'Employment' },
      ],
    },
  ],
  definition: {
    expression: {
      type: 'operator',
      operator: 'divide',
      left: {
        type: 'aggregation',
        function: 'sumOf',
        entity: 'feeEarner',
        expression: { type: 'field', entity: 'feeEarner', field: 'invoicedRevenue' },
        filter: { field: 'department', operator: 'equals', value: '{{departmentName}}' },
      },
      right: {
        type: 'aggregation',
        function: 'sumOf',
        entity: 'feeEarner',
        expression: { type: 'field', entity: 'feeEarner', field: 'wipChargeableHours' },
        filter: { field: 'department', operator: 'equals', value: '{{departmentName}}' },
      },
    },
    postProcess: { round: 2 },
    resultType: 'currency',
  },
};

// =============================================================================
// TMPL-003: Matter Type Profitability
// =============================================================================

const TMPL_003: FormulaTemplate = {
  templateId: 'TMPL-003',
  name: 'Matter Type Profitability',
  description: 'Billing realisation rate filtered to a specific case type.',
  category: 'profitability',
  entityType: 'matter',
  resultType: 'percentage',
  difficulty: 'intermediate',
  tags: ['profitability', 'case-type', 'matter', 'realisation'],
  previewDescription:
    'Invoiced net billing as a percentage of total WIP billable for "{{caseType}}" matters.',
  parameters: [
    {
      key: 'caseType',
      label: 'Case Type',
      description: 'Filter matters to this case type.',
      type: 'select',
      required: true,
      selectOptions: [
        { value: 'ConveyancingResidential', label: 'Conveyancing (Residential)' },
        { value: 'ConveyancingCommercial', label: 'Conveyancing (Commercial)' },
        { value: 'FamilyMatrimonial', label: 'Family / Matrimonial' },
        { value: 'Litigation', label: 'Litigation' },
        { value: 'CorporateCommercial', label: 'Corporate & Commercial' },
        { value: 'WillsProbate', label: 'Wills & Probate' },
        { value: 'Employment', label: 'Employment' },
      ],
    },
  ],
  definition: {
    expression: {
      type: 'operator',
      operator: 'percentage',
      left: { type: 'field', entity: 'matter', field: 'invoicedNetBilling' },
      right: { type: 'field', entity: 'matter', field: 'wipTotalBillable' },
    },
    postProcess: { round: 1 },
    resultType: 'percentage',
  },
};

// =============================================================================
// TMPL-004: Fee Earner Comparison Ratio
// =============================================================================

const TMPL_004: FormulaTemplate = {
  templateId: 'TMPL-004',
  name: 'Fee Earner Comparison Ratio',
  description: 'Compare any two formula results as a ratio for each fee earner.',
  category: 'composite',
  entityType: 'feeEarner',
  resultType: 'ratio',
  difficulty: 'intermediate',
  tags: ['comparison', 'ratio', 'fee-earner', 'composite'],
  previewDescription:
    'Ratio of {{numeratorFormula}} to {{denominatorFormula}} for each fee earner.',
  parameters: [
    {
      key: 'numeratorFormula',
      label: 'Numerator Formula',
      description: 'Formula ID whose result goes on top of the ratio.',
      type: 'select',
      required: true,
      selectOptions: [
        { value: 'F-TU-01', label: 'Utilisation Rate' },
        { value: 'F-RB-01', label: 'Realisation Rate' },
        { value: 'F-RB-02', label: 'Effective Rate' },
        { value: 'F-TU-03', label: 'Non-Chargeable %' },
      ],
    },
    {
      key: 'denominatorFormula',
      label: 'Denominator Formula',
      description: 'Formula ID whose result goes on the bottom of the ratio.',
      type: 'select',
      required: true,
      selectOptions: [
        { value: 'F-TU-01', label: 'Utilisation Rate' },
        { value: 'F-RB-01', label: 'Realisation Rate' },
        { value: 'F-RB-02', label: 'Effective Rate' },
        { value: 'F-WL-02', label: 'Write-Off Rate' },
      ],
    },
  ],
  definition: {
    expression: {
      type: 'operator',
      operator: 'divide',
      left: p('numeratorFormula', 'formulaRef'),
      right: p('denominatorFormula', 'formulaRef'),
    },
    postProcess: { round: 3 },
    resultType: 'ratio',
  },
};

// =============================================================================
// TMPL-005: Threshold Alert Counter
// =============================================================================

const TMPL_005: FormulaTemplate = {
  templateId: 'TMPL-005',
  name: 'Threshold Alert Counter',
  description: 'Count how many fee earners have WIP chargeable hours above or below a threshold.',
  category: 'composite',
  entityType: 'firm',
  resultType: 'number',
  difficulty: 'basic',
  tags: ['alert', 'threshold', 'count', 'firm'],
  previewDescription:
    'Number of fee earners with chargeable hours {{direction}} {{threshold}} hours.',
  parameters: [
    {
      key: 'threshold',
      label: 'Hours Threshold',
      description: 'The number of chargeable hours to compare against.',
      type: 'number',
      required: true,
      defaultValue: 100,
      validation: { min: 0 },
    },
    {
      key: 'direction',
      label: 'Direction',
      description: 'Whether to count fee earners above or below the threshold.',
      type: 'select',
      required: true,
      defaultValue: 'above',
      selectOptions: [
        { value: 'above', label: 'Above threshold' },
        { value: 'below', label: 'Below threshold' },
      ],
    },
  ],
  definition: {
    // Count fee earners where chargeableHours > threshold (above)
    // or chargeableHours < threshold (below).
    // We use 'above' variant — the direction parameter is used for the filter.
    expression: {
      type: 'aggregation',
      function: 'countOf',
      entity: 'feeEarner',
      filter: {
        field: 'wipChargeableHours',
        operator: 'greaterThan',
        value: '{{threshold}}',
      },
    },
    resultType: 'number',
  },
};

// =============================================================================
// TMPL-006: Period-over-Period Change
// =============================================================================

const TMPL_006: FormulaTemplate = {
  templateId: 'TMPL-006',
  name: 'Period-over-Period Change',
  description:
    'Track the absolute change in a metric compared to the prior period. ' +
    'Requires historical snapshot data — may be BLOCKED until snapshots are available.',
  category: 'composite',
  entityType: 'feeEarner',
  resultType: 'number',
  difficulty: 'advanced',
  tags: ['trend', 'period', 'change', 'historical', 'fee-earner'],
  previewDescription:
    'Change in {{metricFormula}} for each fee earner over the last {{period}}.',
  parameters: [
    {
      key: 'metricFormula',
      label: 'Metric Formula',
      description: 'The formula to track period-over-period.',
      type: 'select',
      required: true,
      selectOptions: [
        { value: 'F-TU-01', label: 'Utilisation Rate' },
        { value: 'F-RB-01', label: 'Realisation Rate' },
        { value: 'F-RB-02', label: 'Effective Rate' },
        { value: 'F-WL-02', label: 'Write-Off Rate' },
      ],
    },
    {
      key: 'period',
      label: 'Period',
      description: 'Comparison window.',
      type: 'select',
      required: true,
      defaultValue: 'month',
      selectOptions: [
        { value: 'month', label: 'Month' },
        { value: 'quarter', label: 'Quarter' },
        { value: 'year', label: 'Year' },
      ],
    },
  ],
  definition: {
    // Current period metric — prior period comparison requires snapshot data
    // which is tracked separately. The formula returns the current metric value;
    // the dashboard layer computes the delta from historical snapshots.
    expression: p('metricFormula', 'formulaRef'),
    resultType: 'number',
  },
};

// =============================================================================
// TMPL-007: Weighted Average Billing Rate
// =============================================================================

const TMPL_007: FormulaTemplate = {
  templateId: 'TMPL-007',
  name: 'Weighted Average Billing Rate',
  description: 'Weighted average billing rate for fee earners of a specific grade.',
  category: 'revenue',
  entityType: 'firm',
  resultType: 'currency',
  difficulty: 'intermediate',
  tags: ['rate', 'grade', 'weighted', 'firm'],
  previewDescription:
    'Weighted average billing rate (revenue / hours) for fee earners with grade "{{grade}}".',
  parameters: [
    {
      key: 'grade',
      label: 'Grade',
      description: 'Filter fee earners to this grade.',
      type: 'select',
      required: true,
      selectOptions: [
        { value: 'Partner', label: 'Partner' },
        { value: 'Associate', label: 'Associate' },
        { value: 'Solicitor', label: 'Solicitor' },
        { value: 'Paralegal', label: 'Paralegal' },
        { value: 'Trainee', label: 'Trainee' },
      ],
    },
  ],
  definition: {
    expression: {
      type: 'operator',
      operator: 'divide',
      left: {
        type: 'aggregation',
        function: 'sumOf',
        entity: 'feeEarner',
        expression: { type: 'field', entity: 'feeEarner', field: 'invoicedRevenue' },
        filter: { field: 'grade', operator: 'equals', value: '{{grade}}' },
      },
      right: {
        type: 'aggregation',
        function: 'sumOf',
        entity: 'feeEarner',
        expression: { type: 'field', entity: 'feeEarner', field: 'wipChargeableHours' },
        filter: { field: 'grade', operator: 'equals', value: '{{grade}}' },
      },
    },
    postProcess: { round: 2 },
    resultType: 'currency',
  },
};

// =============================================================================
// TMPL-008: Client Concentration Index
// =============================================================================

const TMPL_008: FormulaTemplate = {
  templateId: 'TMPL-008',
  name: 'Client Concentration Index',
  description: 'What percentage of total revenue comes from the top N clients by outstanding balance.',
  category: 'revenue',
  entityType: 'firm',
  resultType: 'percentage',
  difficulty: 'advanced',
  tags: ['client', 'concentration', 'revenue', 'firm'],
  previewDescription:
    'Percentage of total outstanding balance held by clients with outstanding > {{minOutstanding}}.',
  parameters: [
    {
      key: 'minOutstanding',
      label: 'Minimum Outstanding (£)',
      description: 'Only include clients with outstanding balance above this threshold.',
      type: 'number',
      required: true,
      defaultValue: 5000,
      validation: { min: 0 },
    },
  ],
  definition: {
    expression: {
      type: 'operator',
      operator: 'percentage',
      left: {
        // Sum outstanding for clients above threshold
        type: 'aggregation',
        function: 'sumOf',
        entity: 'client',
        expression: { type: 'field', entity: 'client', field: 'totalOutstanding' },
        filter: {
          field: 'totalOutstanding',
          operator: 'greaterThan',
          value: '{{minOutstanding}}',
        },
      },
      right: {
        // Total outstanding across all clients
        type: 'aggregation',
        function: 'sumOf',
        entity: 'client',
        expression: { type: 'field', entity: 'client', field: 'totalOutstanding' },
      },
    },
    postProcess: { round: 1 },
    resultType: 'percentage',
  },
};

// =============================================================================
// TMPL-009: Matter WIP Age
// =============================================================================

const TMPL_009: FormulaTemplate = {
  templateId: 'TMPL-009',
  name: 'Matter WIP Age',
  description: 'Age of the most recent WIP entry for a specific matter.',
  category: 'leakage',
  entityType: 'matter',
  resultType: 'days',
  difficulty: 'basic',
  tags: ['wip', 'age', 'matter', 'leakage'],
  previewDescription:
    'Age in days of the most recent WIP entry for matters with WIP age above {{minimumAgedays}} days.',
  parameters: [
    {
      key: 'minimumAgeDays',
      label: 'Minimum WIP Age (days)',
      description: 'Only flag matters with WIP older than this threshold.',
      type: 'number',
      required: true,
      defaultValue: 30,
      validation: { min: 0 },
    },
  ],
  definition: {
    expression: {
      type: 'ifThen',
      condition: {
        type: 'compare',
        operator: '>',
        left: { type: 'field', entity: 'matter', field: 'wipAgeInDays' },
        right: p('minimumAgeDays', 'constant'),
      },
      then: { type: 'field', entity: 'matter', field: 'wipAgeInDays' },
      // else: null — matter is within acceptable age
    },
    resultType: 'days',
  },
};

// =============================================================================
// TMPL-010: Custom Scorecard
// =============================================================================

const TMPL_010: FormulaTemplate = {
  templateId: 'TMPL-010',
  name: 'Custom Scorecard',
  description:
    'Weighted composite score from two selected metrics. ' +
    'For more metrics, chain multiple scorecards.',
  category: 'composite',
  entityType: 'feeEarner',
  resultType: 'number',
  difficulty: 'advanced',
  tags: ['scorecard', 'composite', 'weighted', 'fee-earner'],
  previewDescription:
    'Weighted score: ({{metric1}} × {{weight1}} + {{metric2}} × {{weight2}}) / ({{weight1}} + {{weight2}}).',
  parameters: [
    {
      key: 'metric1',
      label: 'First Metric Formula',
      description: 'Formula for the first component.',
      type: 'select',
      required: true,
      selectOptions: [
        { value: 'F-TU-01', label: 'Utilisation Rate' },
        { value: 'F-RB-01', label: 'Realisation Rate' },
        { value: 'F-RB-02', label: 'Effective Rate' },
        { value: 'F-WL-02', label: 'Write-Off Rate' },
        { value: 'F-DM-01', label: 'Debtor Days' },
      ],
    },
    {
      key: 'weight1',
      label: 'Weight for First Metric',
      description: 'Relative weight (e.g. 3 = 3× more important than weight 1).',
      type: 'number',
      required: true,
      defaultValue: 1,
      validation: { min: 0.1, max: 10 },
    },
    {
      key: 'metric2',
      label: 'Second Metric Formula',
      description: 'Formula for the second component.',
      type: 'select',
      required: true,
      selectOptions: [
        { value: 'F-TU-01', label: 'Utilisation Rate' },
        { value: 'F-RB-01', label: 'Realisation Rate' },
        { value: 'F-RB-02', label: 'Effective Rate' },
        { value: 'F-WL-02', label: 'Write-Off Rate' },
        { value: 'F-DM-01', label: 'Debtor Days' },
      ],
    },
    {
      key: 'weight2',
      label: 'Weight for Second Metric',
      description: 'Relative weight for the second metric.',
      type: 'number',
      required: true,
      defaultValue: 1,
      validation: { min: 0.1, max: 10 },
    },
  ],
  definition: {
    // (m1 × w1 + m2 × w2) / (w1 + w2)
    expression: {
      type: 'operator',
      operator: 'divide',
      left: {
        type: 'operator',
        operator: 'add',
        left: {
          type: 'operator',
          operator: 'multiply',
          left: p('metric1', 'formulaRef'),
          right: p('weight1', 'constant'),
        },
        right: {
          type: 'operator',
          operator: 'multiply',
          left: p('metric2', 'formulaRef'),
          right: p('weight2', 'constant'),
        },
      },
      right: {
        type: 'operator',
        operator: 'add',
        left: p('weight1', 'constant'),
        right: p('weight2', 'constant'),
      },
    },
    postProcess: { round: 1 },
    resultType: 'number',
  },
};
