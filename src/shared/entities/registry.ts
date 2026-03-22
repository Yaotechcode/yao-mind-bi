import {
  EntityDefinition,
  EntityType,
  FieldDefinition,
  FieldType,
  MissingBehaviour,
  RelationshipDefinition,
  RelationshipType,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Helper to create a FieldDefinition concisely
// ---------------------------------------------------------------------------

function f(
  key: string,
  label: string,
  type: FieldType,
  required: boolean,
  opts?: {
    missingBehaviour?: MissingBehaviour;
    defaultValue?: unknown;
    options?: string[];
    referencesEntity?: EntityType;
    enablesFeatures?: string[];
    description?: string;
  },
): FieldDefinition {
  return {
    key,
    label,
    type,
    required,
    builtIn: true,
    missingBehaviour: opts?.missingBehaviour ?? MissingBehaviour.USE_DEFAULT,
    ...(opts?.defaultValue !== undefined ? { defaultValue: opts.defaultValue } : {}),
    ...(opts?.options ? { options: opts.options } : {}),
    ...(opts?.referencesEntity ? { referencesEntity: opts.referencesEntity } : {}),
    ...(opts?.enablesFeatures ? { enablesFeatures: opts.enablesFeatures } : {}),
    ...(opts?.description ? { description: opts.description } : {}),
  };
}

// Derived field: computed during pipeline enrichment
function derived(
  key: string,
  label: string,
  type: FieldType,
  opts?: { enablesFeatures?: string[]; options?: string[]; description?: string },
): FieldDefinition {
  return f(key, label, type, false, {
    missingBehaviour: MissingBehaviour.EXCLUDE_FROM_ANALYSIS,
    ...opts,
  });
}

// Extensible field: defined but not yet populated in source data
function extensible(
  key: string,
  label: string,
  type: FieldType,
  missingBehaviour: MissingBehaviour,
  enablesFeatures: string[],
  description?: string,
): FieldDefinition {
  return f(key, label, type, false, {
    missingBehaviour,
    enablesFeatures,
    description,
  });
}

// ---------------------------------------------------------------------------
// Entity 1: Fee Earner
// ---------------------------------------------------------------------------

const feeEarnerEntity: EntityDefinition = {
  entityType: EntityType.FEE_EARNER,
  label: 'Fee Earner',
  labelPlural: 'Fee Earners',
  icon: '👤',
  description: 'A fee-earning or support member of staff who records time and generates revenue',
  isBuiltIn: true,
  dataSource: 'feeEarnerCsv',
  primaryKey: 'id',
  displayField: 'name',
  supportsCustomFields: true,
  fields: [
    f('id', 'ID', FieldType.STRING, true),
    f('name', 'Name', FieldType.STRING, true),
    f('department', 'Department', FieldType.STRING, true),
    f('grade', 'Grade', FieldType.STRING, false, {
      options: ['Partner', 'Senior Associate', 'Solicitor', 'Paralegal', 'Administration'],
    }),
    f('payModel', 'Pay Model', FieldType.SELECT, true, {
      options: ['Salaried', 'FeeShare'],
    }),
    f('isActive', 'Is Active', FieldType.BOOLEAN, true),
    f('rate', 'Charge-Out Rate (£/hr)', FieldType.CURRENCY, false, {
      description: 'Standard charge-out rate in £ per hour',
    }),
    f('allRates', 'All Rate Tiers', FieldType.STRING, false, {
      description: 'JSON string of all rate tiers keyed by matter/case type',
    }),
    f('costsCentre', 'Costs Centre', FieldType.STRING, false),
    f('annualSalary', 'Annual Salary', FieldType.CURRENCY, false, {
      description: 'Gross annual salary. Null for fee share earners.',
    }),
    f('monthlySalary', 'Monthly Salary', FieldType.CURRENCY, false),
    f('monthlyVariablePay', 'Monthly Variable Pay', FieldType.CURRENCY, false),
    f('monthlyPension', 'Monthly Pension', FieldType.CURRENCY, false),
    f('monthlyEmployerNI', 'Monthly Employer NI', FieldType.CURRENCY, false),
    f('annualTarget', 'Annual Billing Target', FieldType.CURRENCY, false, {
      description: 'Annual billing target. Null for fee share earners.',
    }),
    f('adminSupportFTE', 'Admin Support FTE', FieldType.NUMBER, false),
    f('workingDaysPerWeek', 'Working Days Per Week', FieldType.NUMBER, false),
    f('annualLeaveEntitlement', 'Annual Leave Entitlement (Days)', FieldType.NUMBER, false),
    f('targetWeeklyHours', 'Target Weekly Hours', FieldType.NUMBER, false),
    f('chargeableWeeklyTarget', 'Chargeable Weekly Target (Hours)', FieldType.NUMBER, false),
    f('startDate', 'Start Date', FieldType.DATE, false),
    f('endDate', 'End Date', FieldType.DATE, false),
    f('feeSharePercent', 'Fee Share Percent', FieldType.PERCENTAGE, false, {
      description: 'Percentage of billed fees retained by the earner. Null for salaried.',
    }),
    f('firmLeadPercent', 'Firm Lead Percent', FieldType.PERCENTAGE, false),
    f('isSystemAccount', 'Is System Account', FieldType.BOOLEAN, false, {
      defaultValue: false,
    }),
  ],
  relationships: [
    {
      key: 'timeEntries',
      type: RelationshipType.HAS_MANY,
      targetEntity: EntityType.TIME_ENTRY,
      localKey: 'id',
      foreignKey: 'lawyerId',
      label: 'Time Entries',
    },
    {
      key: 'responsibleMatters',
      type: RelationshipType.HAS_MANY,
      targetEntity: EntityType.MATTER,
      localKey: 'id',
      foreignKey: 'responsibleLawyerId',
      label: 'Responsible Matters',
    },
    {
      key: 'supervisedMatters',
      type: RelationshipType.HAS_MANY,
      targetEntity: EntityType.MATTER,
      localKey: 'id',
      foreignKey: 'responsibleSupervisorId',
      label: 'Supervised Matters',
    },
    {
      key: 'invoices',
      type: RelationshipType.HAS_MANY,
      targetEntity: EntityType.INVOICE,
      localKey: 'id',
      foreignKey: 'responsibleLawyerId',
      label: 'Invoices',
    },
    {
      key: 'department',
      type: RelationshipType.BELONGS_TO,
      targetEntity: EntityType.DEPARTMENT,
      localKey: 'department',
      foreignKey: 'name',
      label: 'Department',
    },
  ],
};

// ---------------------------------------------------------------------------
// Entity 2: Matter
// ---------------------------------------------------------------------------

const matterEntity: EntityDefinition = {
  entityType: EntityType.MATTER,
  label: 'Matter',
  labelPlural: 'Matters',
  icon: '📁',
  description: 'A client matter or case managed by the firm',
  isBuiltIn: true,
  dataSource: 'fullMattersJson',
  primaryKey: 'matterId',
  displayField: 'matterNumber',
  supportsCustomFields: true,
  fields: [
    f('matterId', 'Matter ID', FieldType.STRING, true),
    f('matterNumber', 'Matter Number', FieldType.NUMBER, true),
    f('status', 'Status', FieldType.SELECT, true, {
      options: [
        'IN_PROGRESS',
        'COMPLETED',
        'ARCHIVED',
        'NOT_PROCEEDING',
        'ON_HOLD',
        'EXCHANGED',
        'QUOTE',
        'CLOSED',
      ],
    }),
    f('budget', 'Budget', FieldType.CURRENCY, false),
    f('officeAccountBalance', 'Office Account Balance', FieldType.CURRENCY, false, {
      description: 'Negative = owed to firm; positive = client credit',
    }),
    f('lastStatusUpdate', 'Last Status Update', FieldType.DATE, false),
    f('inProgressDate', 'In Progress Date', FieldType.DATE, false),
    f('createdDate', 'Created Date', FieldType.DATE, true),
    f('completedDate', 'Completed Date', FieldType.DATE, false),
    f('responsibleLawyer', 'Responsible Lawyer', FieldType.STRING, true),
    f('responsibleLawyerId', 'Responsible Lawyer ID', FieldType.STRING, false),
    f('responsibleSupervisor', 'Responsible Supervisor', FieldType.STRING, false),
    f('responsibleSupervisorId', 'Responsible Supervisor ID', FieldType.STRING, false),
    f('department', 'Department', FieldType.STRING, true),
    f('departmentId', 'Department ID', FieldType.STRING, false),
    f('caseType', 'Case Type', FieldType.STRING, false),
    f('caseTypeId', 'Case Type ID', FieldType.STRING, false),
    f('source', 'Source', FieldType.STRING, false),
    f('sourceContact', 'Source Contact', FieldType.STRING, false),
    f('clientIds', 'Client IDs', FieldType.STRING, false, {
      description: 'JSON array of client contact IDs',
    }),
    f('clientNames', 'Client Names', FieldType.STRING, false, {
      description: 'JSON array of client display names',
    }),
    f('netBilling', 'Net Billing', FieldType.CURRENCY, false),
    f('totalDisbursements', 'Total Disbursements', FieldType.CURRENCY, false),
    f('outstanding', 'Outstanding', FieldType.CURRENCY, false),
    f('paid', 'Paid', FieldType.CURRENCY, false),
    f('totalUnits', 'Total Units', FieldType.NUMBER, false),
    f('totalDurationMinutes', 'Total Duration (Minutes)', FieldType.NUMBER, false),
    f('totalBillable', 'Total Billable', FieldType.CURRENCY, false),
    f('totalWriteOff', 'Total Write Off', FieldType.CURRENCY, false),
    // From Closed Matters
    f('invoiceNetBilling', 'Invoice Net Billing', FieldType.CURRENCY, false),
    f('invoicedDisbursements', 'Invoiced Disbursements', FieldType.CURRENCY, false),
    f('invoiceOutstanding', 'Invoice Outstanding', FieldType.CURRENCY, false),
    f('wipBillable', 'WIP Billable', FieldType.CURRENCY, false),
    f('wipWriteOff', 'WIP Write Off', FieldType.CURRENCY, false),
    // Derived
    derived('hasClosedMatterData', 'Has Closed Matter Data', FieldType.BOOLEAN),
    derived('isActive', 'Is Active', FieldType.BOOLEAN),
    derived('isClosed', 'Is Closed', FieldType.BOOLEAN),
    derived('isFixedFee', 'Is Fixed Fee', FieldType.BOOLEAN),
    derived('clientName', 'Client Name', FieldType.STRING, {
      description: 'Resolved from client joins',
    }),
  ],
  relationships: [
    {
      key: 'timeEntries',
      type: RelationshipType.HAS_MANY,
      targetEntity: EntityType.TIME_ENTRY,
      localKey: 'matterId',
      foreignKey: 'matterId',
      label: 'Time Entries',
    },
    {
      key: 'invoices',
      type: RelationshipType.HAS_MANY,
      targetEntity: EntityType.INVOICE,
      localKey: 'matterNumber',
      foreignKey: 'matterNumber',
      label: 'Invoices',
    },
    {
      key: 'disbursements',
      type: RelationshipType.HAS_MANY,
      targetEntity: EntityType.DISBURSEMENT,
      localKey: 'matterId',
      foreignKey: 'matterId',
      label: 'Disbursements',
    },
    {
      key: 'tasks',
      type: RelationshipType.HAS_MANY,
      targetEntity: EntityType.TASK,
      localKey: 'matterId',
      foreignKey: 'matterId',
      label: 'Tasks',
    },
    {
      key: 'responsibleFeeEarner',
      type: RelationshipType.BELONGS_TO,
      targetEntity: EntityType.FEE_EARNER,
      localKey: 'responsibleLawyerId',
      foreignKey: 'id',
      label: 'Responsible Fee Earner',
    },
    {
      key: 'supervisorFeeEarner',
      type: RelationshipType.BELONGS_TO,
      targetEntity: EntityType.FEE_EARNER,
      localKey: 'responsibleSupervisorId',
      foreignKey: 'id',
      label: 'Supervisor',
    },
    {
      key: 'department',
      type: RelationshipType.BELONGS_TO,
      targetEntity: EntityType.DEPARTMENT,
      localKey: 'department',
      foreignKey: 'name',
      label: 'Department',
    },
    {
      key: 'client',
      type: RelationshipType.BELONGS_TO,
      targetEntity: EntityType.CLIENT,
      localKey: 'clientName',
      foreignKey: 'displayName',
      label: 'Client',
    },
  ],
};

// ---------------------------------------------------------------------------
// Entity 3: Time Entry
// ---------------------------------------------------------------------------

const timeEntryEntity: EntityDefinition = {
  entityType: EntityType.TIME_ENTRY,
  label: 'Time Entry',
  labelPlural: 'Time Entries',
  icon: '⏱️',
  description: 'A recorded unit of time worked on a matter by a fee earner',
  isBuiltIn: true,
  dataSource: 'wipJson',
  primaryKey: 'entryId',
  displayField: 'entryId',
  supportsCustomFields: true,
  fields: [
    f('entryId', 'Entry ID', FieldType.STRING, true),
    f('doNotBill', 'Do Not Bill', FieldType.BOOLEAN, true),
    f('rate', 'Rate (£/hr)', FieldType.CURRENCY, true),
    f('durationMinutes', 'Duration (Minutes)', FieldType.NUMBER, true),
    f('billableValue', 'Billable Value', FieldType.CURRENCY, true),
    f('writeOffValue', 'Write Off Value', FieldType.CURRENCY, false, {
      defaultValue: 0,
    }),
    f('matterId', 'Matter ID', FieldType.STRING, true),
    f('matterNumber', 'Matter Number', FieldType.NUMBER, true),
    f('departmentId', 'Department ID', FieldType.STRING, false),
    f('department', 'Department', FieldType.STRING, false),
    f('caseTypeId', 'Case Type ID', FieldType.STRING, false),
    f('caseType', 'Case Type', FieldType.STRING, false),
    f('lawyerId', 'Lawyer ID', FieldType.STRING, true),
    f('date', 'Date', FieldType.DATE, true),
    // Derived
    derived('durationHours', 'Duration (Hours)', FieldType.NUMBER),
    derived('isChargeable', 'Is Chargeable', FieldType.BOOLEAN),
    derived('recordedValue', 'Recorded Value', FieldType.CURRENCY),
    derived('ageInDays', 'Age (Days)', FieldType.NUMBER),
    derived('weekNumber', 'Week Number', FieldType.NUMBER),
    derived('monthKey', 'Month Key', FieldType.STRING),
    derived('hasMatchedMatter', 'Has Matched Matter', FieldType.BOOLEAN),
    // Enriched from joins
    f('lawyerName', 'Lawyer Name', FieldType.STRING, false, {
      missingBehaviour: MissingBehaviour.EXCLUDE_FROM_ANALYSIS,
      description: 'Resolved via join to feeEarner',
    }),
    f('lawyerGrade', 'Lawyer Grade', FieldType.STRING, false, {
      missingBehaviour: MissingBehaviour.EXCLUDE_FROM_ANALYSIS,
      description: 'Resolved via join to feeEarner',
    }),
    f('lawyerPayModel', 'Lawyer Pay Model', FieldType.SELECT, false, {
      missingBehaviour: MissingBehaviour.EXCLUDE_FROM_ANALYSIS,
      options: ['Salaried', 'FeeShare'],
      description: 'Resolved via join to feeEarner',
    }),
    f('clientName', 'Client Name', FieldType.STRING, false, {
      missingBehaviour: MissingBehaviour.EXCLUDE_FROM_ANALYSIS,
      description: 'Resolved via join to matter → client',
    }),
    // Extensible (not yet populated)
    extensible(
      'activityType',
      'Activity Type',
      FieldType.STRING,
      MissingBehaviour.EXCLUDE_FROM_ANALYSIS,
      ['nonChargeableBreakdown', 'activityAnalysis'],
      'Category of work performed (e.g. drafting, advising, attending)',
    ),
    extensible(
      'description',
      'Time Entry Description',
      FieldType.STRING,
      MissingBehaviour.HIDE_COLUMN,
      ['matterDetailView', 'aiContextBuilder'],
      'Narrative description of work carried out',
    ),
  ],
  relationships: [
    {
      key: 'matter',
      type: RelationshipType.BELONGS_TO,
      targetEntity: EntityType.MATTER,
      localKey: 'matterId',
      foreignKey: 'matterId',
      label: 'Matter',
    },
    {
      key: 'feeEarner',
      type: RelationshipType.BELONGS_TO,
      targetEntity: EntityType.FEE_EARNER,
      localKey: 'lawyerId',
      foreignKey: 'id',
      label: 'Fee Earner',
    },
    {
      key: 'department',
      type: RelationshipType.BELONGS_TO,
      targetEntity: EntityType.DEPARTMENT,
      localKey: 'department',
      foreignKey: 'name',
      label: 'Department',
    },
  ],
};

// ---------------------------------------------------------------------------
// Entity 4: Invoice
// ---------------------------------------------------------------------------

const invoiceEntity: EntityDefinition = {
  entityType: EntityType.INVOICE,
  label: 'Invoice',
  labelPlural: 'Invoices',
  icon: '🧾',
  description: 'A bill raised against a client for work done on a matter',
  isBuiltIn: true,
  dataSource: 'invoicesJson',
  primaryKey: 'invoiceNumber',
  displayField: 'invoiceNumber',
  supportsCustomFields: true,
  fields: [
    f('invoiceId', 'Invoice ID', FieldType.STRING, false),
    f('invoiceNumber', 'Invoice Number', FieldType.STRING, false, {
      description: 'Null indicates a draft/unposted invoice',
    }),
    f('invoiceDate', 'Invoice Date', FieldType.DATE, true),
    f('dueDate', 'Due Date', FieldType.DATE, true),
    f('subtotal', 'Subtotal', FieldType.CURRENCY, true),
    f('totalDisbursements', 'Total Disbursements', FieldType.CURRENCY, false),
    f('totalOtherFees', 'Total Other Fees', FieldType.CURRENCY, false),
    f('writeOff', 'Write Off', FieldType.CURRENCY, false),
    f('vat', 'VAT', FieldType.CURRENCY, false),
    f('totalFirmFees', 'Total Firm Fees', FieldType.CURRENCY, false),
    f('total', 'Total', FieldType.CURRENCY, true),
    f('outstanding', 'Outstanding', FieldType.CURRENCY, true),
    f('paid', 'Paid', FieldType.CURRENCY, true),
    f('writtenOff', 'Written Off', FieldType.CURRENCY, false, {
      description: 'Numeric 0/1 — use === 1, not truthy check',
    }),
    f('clientIds', 'Client IDs', FieldType.STRING, false, {
      description: 'JSON array of client contact IDs',
    }),
    f('responsibleLawyer', 'Responsible Lawyer', FieldType.STRING, true),
    f('responsibleLawyerId', 'Responsible Lawyer ID', FieldType.STRING, false),
    f('matterNumber', 'Matter Number', FieldType.NUMBER, true),
    f('matterId', 'Matter ID', FieldType.STRING, false),
    f('matterStatus', 'Matter Status', FieldType.STRING, false),
    // Extensible
    extensible(
      'datePaid',
      'Date Paid',
      FieldType.DATE,
      MissingBehaviour.EXCLUDE_FROM_ANALYSIS,
      ['debtorDaysExact', 'paymentBehaviour', 'slowPayerRanking'],
      'Actual date payment was received. Enables precise debtor day calculations.',
    ),
    // Derived
    derived('isOverdue', 'Is Overdue', FieldType.BOOLEAN),
    derived('daysOutstanding', 'Days Outstanding', FieldType.NUMBER),
    derived('ageBand', 'Age Band', FieldType.STRING),
    derived('clientName', 'Client Name', FieldType.STRING),
  ],
  relationships: [
    {
      key: 'matter',
      type: RelationshipType.BELONGS_TO,
      targetEntity: EntityType.MATTER,
      localKey: 'matterNumber',
      foreignKey: 'matterNumber',
      label: 'Matter',
    },
    {
      key: 'feeEarner',
      type: RelationshipType.BELONGS_TO,
      targetEntity: EntityType.FEE_EARNER,
      localKey: 'responsibleLawyerId',
      foreignKey: 'id',
      label: 'Responsible Fee Earner',
    },
    {
      key: 'client',
      type: RelationshipType.BELONGS_TO,
      targetEntity: EntityType.CLIENT,
      localKey: 'clientName',
      foreignKey: 'displayName',
      label: 'Client',
    },
  ],
};

// ---------------------------------------------------------------------------
// Entity 5: Client
// ---------------------------------------------------------------------------

const clientEntity: EntityDefinition = {
  entityType: EntityType.CLIENT,
  label: 'Client',
  labelPlural: 'Clients',
  icon: '🏢',
  description: 'A client of the firm whose matters and invoices are tracked',
  isBuiltIn: true,
  dataSource: 'contactsJson',
  primaryKey: 'contactId',
  displayField: 'displayName',
  supportsCustomFields: true,
  fields: [
    f('contactId', 'Contact ID', FieldType.STRING, true),
    f('displayName', 'Display Name', FieldType.STRING, true),
    // All other client metrics are derived from aggregation across matters/invoices
  ],
  relationships: [
    {
      key: 'matters',
      type: RelationshipType.HAS_MANY,
      targetEntity: EntityType.MATTER,
      localKey: 'displayName',
      foreignKey: 'clientName',
      label: 'Matters',
    },
    {
      key: 'invoices',
      type: RelationshipType.HAS_MANY,
      targetEntity: EntityType.INVOICE,
      localKey: 'contactId',
      foreignKey: 'clientIds',
      label: 'Invoices',
    },
    {
      key: 'disbursements',
      type: RelationshipType.HAS_MANY,
      targetEntity: EntityType.DISBURSEMENT,
      localKey: 'contactId',
      foreignKey: 'clientId',
      label: 'Disbursements',
    },
  ],
};

// ---------------------------------------------------------------------------
// Entity 6: Disbursement
// ---------------------------------------------------------------------------

const disbursementEntity: EntityDefinition = {
  entityType: EntityType.DISBURSEMENT,
  label: 'Disbursement',
  labelPlural: 'Disbursements',
  icon: '💸',
  description: 'An out-of-pocket expense incurred on behalf of a client',
  isBuiltIn: true,
  dataSource: 'disbursementsJson',
  primaryKey: 'transactionId',
  displayField: 'transactionId',
  supportsCustomFields: true,
  fields: [
    f('transactionId', 'Transaction ID', FieldType.STRING, true),
    f('outstanding', 'Outstanding', FieldType.CURRENCY, true),
    f('subtotal', 'Subtotal', FieldType.CURRENCY, true),
    f('date', 'Date', FieldType.DATE, true),
    f('matterId', 'Matter ID', FieldType.STRING, true),
    f('matterNumber', 'Matter Number', FieldType.NUMBER, true),
    f('responsibleLawyerId', 'Responsible Lawyer ID', FieldType.STRING, true),
    f('departmentId', 'Department ID', FieldType.STRING, false),
    f('clientId', 'Client ID', FieldType.STRING, false, {
      description: 'JSON array with contact ID and display name',
    }),
    // Extensible
    extensible(
      'description',
      'Disbursement Description',
      FieldType.STRING,
      MissingBehaviour.HIDE_COLUMN,
      ['disbursementCategorisation'],
      'Description of the expense (e.g. court fee, search fee)',
    ),
    // Derived
    derived('clientName', 'Client Name', FieldType.STRING),
    derived('responsibleLawyerName', 'Responsible Lawyer Name', FieldType.STRING),
    derived('departmentName', 'Department Name', FieldType.STRING),
    derived('firmExposure', 'Firm Exposure', FieldType.CURRENCY, {
      description: 'Absolute value of outstanding — firm\'s unrecovered cost',
    }),
    derived('ageInDays', 'Age (Days)', FieldType.NUMBER),
  ],
  relationships: [
    {
      key: 'matter',
      type: RelationshipType.BELONGS_TO,
      targetEntity: EntityType.MATTER,
      localKey: 'matterId',
      foreignKey: 'matterId',
      label: 'Matter',
    },
    {
      key: 'feeEarner',
      type: RelationshipType.BELONGS_TO,
      targetEntity: EntityType.FEE_EARNER,
      localKey: 'responsibleLawyerId',
      foreignKey: 'id',
      label: 'Responsible Fee Earner',
    },
  ],
};

// ---------------------------------------------------------------------------
// Entity 7: Department
// ---------------------------------------------------------------------------

const departmentEntity: EntityDefinition = {
  entityType: EntityType.DEPARTMENT,
  label: 'Department',
  labelPlural: 'Departments',
  icon: '🏛️',
  description: 'A practice area or organisational unit within the firm',
  isBuiltIn: true,
  dataSource: 'derived',
  primaryKey: 'name',
  displayField: 'name',
  supportsCustomFields: true,
  fields: [
    f('departmentId', 'Department ID', FieldType.STRING, false),
    f('name', 'Name', FieldType.STRING, true),
    // User-enrichable fields
    f('headOfDepartment', 'Head of Department', FieldType.REFERENCE, false, {
      referencesEntity: EntityType.FEE_EARNER,
    }),
    f('overheadBudget', 'Overhead Budget', FieldType.CURRENCY, false),
    f('revenueTarget', 'Revenue Target', FieldType.CURRENCY, false),
    f('headcount', 'Headcount', FieldType.NUMBER, false),
    // All KPI fields are derived via aggregation
  ],
  relationships: [
    {
      key: 'feeEarners',
      type: RelationshipType.HAS_MANY,
      targetEntity: EntityType.FEE_EARNER,
      localKey: 'name',
      foreignKey: 'department',
      label: 'Fee Earners',
    },
    {
      key: 'matters',
      type: RelationshipType.HAS_MANY,
      targetEntity: EntityType.MATTER,
      localKey: 'name',
      foreignKey: 'department',
      label: 'Matters',
    },
    {
      key: 'timeEntries',
      type: RelationshipType.HAS_MANY,
      targetEntity: EntityType.TIME_ENTRY,
      localKey: 'name',
      foreignKey: 'department',
      label: 'Time Entries',
    },
  ],
};

// ---------------------------------------------------------------------------
// Entity 8: Task
// ---------------------------------------------------------------------------

const taskEntity: EntityDefinition = {
  entityType: EntityType.TASK,
  label: 'Task',
  labelPlural: 'Tasks',
  icon: '✅',
  description: 'A to-do item associated with a matter and assigned to a fee earner',
  isBuiltIn: true,
  dataSource: 'tasksJson',
  primaryKey: 'taskId',
  displayField: 'title',
  supportsCustomFields: true,
  fields: [
    f('taskId', 'Task ID', FieldType.STRING, true),
    f('dueDate', 'Due Date', FieldType.DATE, true),
    f('matterId', 'Matter ID', FieldType.STRING, true),
    f('matterNumber', 'Matter Number', FieldType.NUMBER, true),
    f('title', 'Title', FieldType.STRING, true),
    f('description', 'Description', FieldType.STRING, false),
    f('lawyerId', 'Lawyer ID', FieldType.STRING, true),
    f('priority', 'Priority', FieldType.SELECT, true, {
      options: ['STANDARD', 'HIGH', 'URGENT'],
    }),
    f('status', 'Status', FieldType.SELECT, true, {
      options: ['IN_PROGRESS', 'COMPLETED', 'OVERDUE'],
    }),
    // Derived
    derived('isOverdue', 'Is Overdue', FieldType.BOOLEAN),
    derived('daysUntilDue', 'Days Until Due', FieldType.NUMBER),
    derived('daysOverdue', 'Days Overdue', FieldType.NUMBER),
    derived('lawyerName', 'Lawyer Name', FieldType.STRING),
  ],
  relationships: [
    {
      key: 'matter',
      type: RelationshipType.BELONGS_TO,
      targetEntity: EntityType.MATTER,
      localKey: 'matterId',
      foreignKey: 'matterId',
      label: 'Matter',
    },
    {
      key: 'feeEarner',
      type: RelationshipType.BELONGS_TO,
      targetEntity: EntityType.FEE_EARNER,
      localKey: 'lawyerId',
      foreignKey: 'id',
      label: 'Assigned Fee Earner',
    },
  ],
};

// ---------------------------------------------------------------------------
// Entity 9: Firm
// ---------------------------------------------------------------------------

const firmEntity: EntityDefinition = {
  entityType: EntityType.FIRM,
  label: 'Firm',
  labelPlural: 'Firms',
  icon: '⚖️',
  description: 'Singleton entity representing the firm itself; all fields are aggregated',
  isBuiltIn: true,
  dataSource: 'aggregated',
  primaryKey: 'firmId',
  displayField: 'firmName',
  supportsCustomFields: false,
  fields: [
    // Firm is a singleton aggregation — no direct source fields.
    // All KPI fields are computed by the aggregation stage.
    f('firmId', 'Firm ID', FieldType.STRING, true),
    f('firmName', 'Firm Name', FieldType.STRING, true),
  ],
  relationships: [
    {
      key: 'feeEarners',
      type: RelationshipType.HAS_MANY,
      targetEntity: EntityType.FEE_EARNER,
      localKey: 'firmId',
      foreignKey: 'firmId',
      label: 'All Fee Earners',
    },
    {
      key: 'matters',
      type: RelationshipType.HAS_MANY,
      targetEntity: EntityType.MATTER,
      localKey: 'firmId',
      foreignKey: 'firmId',
      label: 'All Matters',
    },
    {
      key: 'departments',
      type: RelationshipType.HAS_MANY,
      targetEntity: EntityType.DEPARTMENT,
      localKey: 'firmId',
      foreignKey: 'firmId',
      label: 'All Departments',
    },
    {
      key: 'clients',
      type: RelationshipType.HAS_MANY,
      targetEntity: EntityType.CLIENT,
      localKey: 'firmId',
      foreignKey: 'firmId',
      label: 'All Clients',
    },
  ],
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const BUILT_IN_ENTITIES: EntityDefinition[] = [
  feeEarnerEntity,
  matterEntity,
  timeEntryEntity,
  invoiceEntity,
  clientEntity,
  disbursementEntity,
  departmentEntity,
  taskEntity,
  firmEntity,
];

/** Returns all 9 built-in entity definitions. */
export function getBuiltInEntityDefinitions(): EntityDefinition[] {
  return BUILT_IN_ENTITIES;
}

/** Returns a single built-in entity definition by its EntityType. */
export function getBuiltInEntityDefinition(entityType: EntityType): EntityDefinition | undefined {
  return BUILT_IN_ENTITIES.find((e) => e.entityType === entityType);
}
