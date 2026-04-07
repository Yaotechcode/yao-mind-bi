export function pruneFields<T extends Record<string, unknown>>(
  record: T,
  keepFields: string[]
): Partial<T> {
  const result: Partial<T> = {};
  for (const key of keepFields) {
    if (key in record) {
      (result as Record<string, unknown>)[key] = record[key];
    }
  }
  return result;
}

export function pruneArray<T extends Record<string, unknown>>(
  records: T[],
  keepFields: string[]
): Partial<T>[] {
  return records.map(r => pruneFields(r, keepFields));
}

export const ATTORNEY_KEEP_FIELDS = [
  '_id', 'name', 'surname', 'status',
  'job_title',
  'rates',
  'email',                  // needed by fee-earner-merger for name+email matching
  'integration_account_id', // needed by fee-earner-merger for Xero ID matching
];

export const DEPARTMENT_KEEP_FIELDS = [
  '_id', 'title', 'is_deleted',
];

export const CASE_TYPE_KEEP_FIELDS = [
  '_id', 'title', 'fixed_fee', 'department', 'is_deleted',
];

export const MATTER_KEEP_FIELDS = [
  '_id', 'number', 'status', 'case_name',
  'financial_limit',
  'office_account_balance',
  'source',
  'source_contact_name',
  'responsible_lawyer',
  'responsible_supervisor',
  'paralegal',
  'department',
  'case_type',
  'clients',
  'last_status_update',
  'in_progress_date',
  'completed_date',
  'created_at',
  'updated_at',
];

export const TIME_ENTRY_KEEP_FIELDS = [
  '_id', 'do_not_bill', 'billable', 'write_off', 'duration_minutes', 'units',
  'matter', 'assignee', 'activity', 'work_type', 'date', 'department',
];

export const INVOICE_KEEP_FIELDS = [
  '_id', 'invoice_number', 'invoice_date', 'due_date',
  'subtotal', 'write_off', 'vat', 'total_firm_fees', 'total',
  'outstanding', 'paid', 'written_off',
  'clients', 'solicitor', 'matter',
  // additional fields for feeEarnerRevenue calculation
  'billing_amount', 'billable_entries', 'total_disbursements', 'credited', 'vat_percentage',
  // status kept for invoice aggregation filtering (DRAFT/CANCELED/ERROR exclusions)
  'status',
];

export const LEDGER_KEEP_FIELDS = [
  '_id', 'type', 'value', 'vat', 'outstanding',
  'reference', 'payee', 'matter', 'date',
  'department', 'responsible_lawyer', 'contact',
  // invoice and disbursements kept for routeLedgers routing logic
  'invoice', 'disbursements',
  // status kept for REVERSED payment filtering in invoice enricher
  'status',
];

export const TASK_KEEP_FIELDS = [
  '_id', 'title', 'due_date', 'status', 'priority',
  'matter', 'assigned_to',
];

export const CONTACT_KEEP_FIELDS = [
  '_id', 'type', 'display_name', 'company_name',
];
