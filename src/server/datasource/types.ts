/**
 * types.ts — Yao API response shapes and derived map types.
 *
 * These model what the Yao API returns **after client-side field pruning**.
 * Only fields present in the corresponding KEEP_FIELDS lists (pruner.ts) are
 * declared here. Sensitive fields (password, email_default_signature) and all
 * fields not needed for KPI calculation are intentionally omitted.
 */

// =============================================================================
// Raw API shapes (pruned)
// =============================================================================

export interface YaoAttorney {
  _id: string;
  name: string;
  surname: string;
  status: 'ACTIVE' | 'PENDING' | 'DISABLED';
  job_title?: string;
  rates: Array<{ label: string; value: number; default: boolean }>;
  email?: string;
  integration_account_id?: string;
}

export interface YaoDepartment {
  _id: string;
  title: string;
  is_deleted: boolean;
}

export interface YaoCaseType {
  _id: string;
  title: string;
  fixed_fee?: number;
  department: { _id: string; title: string };
  is_deleted: boolean;
}

type NestedAttorney = {
  _id: string;
  name: string;
  surname: string;
  rates?: Array<{ label: string; value: number; default: boolean }>;
};

export interface YaoMatter {
  _id: string;
  number: number;
  status: string;
  case_name: string;
  financial_limit: number;
  office_account_balance: number;
  source?: string;
  source_contact_name?: string;
  responsible_lawyer?: NestedAttorney | null;
  responsible_supervisor?: NestedAttorney | null;
  paralegal?: NestedAttorney | null;
  department?: { _id: string; title: string } | null;
  case_type?: { _id: string; title: string } | null;
  clients: Array<{
    contact: {
      _id: string;
      type: string;
      display_name: string;
      company_name?: string;
    };
  }>;
  last_status_update?: string;
  in_progress_date?: string;
  completed_date?: string;
  created_at: string;
  updated_at: string;
}

export interface YaoTimeEntry {
  _id: string;
  do_not_bill: boolean;
  billable: number;
  write_off: number;
  duration_minutes: number;
  matter: { _id: string; number: number };
  assignee?: { _id: string; name: string; surname: string } | null;
  activity?: { title: string } | null;
  work_type?: string;
  date: string;
  department?: { _id: string; title: string } | null;
}

export interface YaoInvoice {
  _id: string;
  invoice_number: number;
  invoice_date: string;
  due_date: string;
  subtotal: number;
  total_firm_fees: number;
  write_off: number;
  total: number;
  outstanding: number;
  paid: number;
  written_off: number;
  vat: number;
  billing_amount?: number;
  billable_entries?: number;
  total_disbursements?: number;
  credited?: number;
  vat_percentage?: number;
  // status kept for aggregation filtering (DRAFT/CANCELED/ERROR exclusions)
  status?: string;
  clients: Array<{ _id: string; display_name: string }>;
  solicitor?: { _id: string; name: string; surname: string } | null;
  matter?: { _id: string; number: number } | null;
}

export interface YaoInvoiceSummary {
  unpaid: number;
  paid: number;
  total: number;
}

export interface YaoLedger {
  _id: string;
  type:
    | 'OFFICE_PAYMENT'
    | 'CLIENT_TO_OFFICE'
    | 'OFFICE_RECEIPT'
    | 'CLIENT_RECEIPT'
    | 'CLIENT_PAYMENT'
    | 'OFFICE_TO_CLIENT'
    | 'CLIENT_TRANSFER'
    | 'INVOICE'
    | 'OFFICE_CREDIT'
    | 'CREDIT_NOTE'
    | 'REVERSAL'
    | 'INTEREST'
    | 'LINKED_PAYMENT'
    | 'LINKED_RECEIPT'
    | 'CLIENT_TO_LINKED'
    | 'LINKED_TO_CLIENT'
    | 'LINKED_TO_OFFICE'
    | 'OFFICE_TO_LINKED'
    | 'REGULATORY_DEPOSIT'
    | 'REGULATORY_WITHDRAWAL'
    | 'WRITE_OFF'
    | 'WRITE_OFF_BILL'
    | 'TAX'
    | 'OPENING_BALANCE'
    | string;
  value: number;
  vat: number;
  outstanding: number;
  reference?: string;
  payee?: string;
  date: string;
  // status kept for REVERSED payment filtering
  status?: string;
  matter?: { _id: string; number: number } | null;
  department?: { _id: string; title: string } | null;
  responsible_lawyer?: { _id: string } | null;
  contact?: { _id: string; display_name: string } | null;
  /** Invoice _id as a string reference */
  invoice?: string;
  disbursements?: Array<{ _id: string; value: number }>;
}

export interface RoutedLedgers {
  /** OFFICE_PAYMENT records — source of disbursement entities */
  disbursements: YaoLedger[];
  /** CLIENT_TO_OFFICE or OFFICE_RECEIPT with invoice populated — used to derive datePaid */
  invoicePayments: YaoLedger[];
  /** CLIENT_TO_OFFICE or OFFICE_RECEIPT with disbursements[] populated */
  disbursementRecoveries: YaoLedger[];
}

export interface YaoTask {
  _id: string;
  title: string;
  priority: string;
  status: string;
  due_date?: string | null;
  matter?: { _id: string; number: number } | null;
  assigned_to?: { _id: string; name: string; surname: string } | null;
}

export interface YaoContact {
  _id: string;
  type: 'Person' | 'Company';
  display_name: string;
  company_name?: string;
}

// =============================================================================
// Derived in-memory maps
// =============================================================================

export interface AttorneyMap {
  [id: string]: {
    fullName: string;
    firstName: string;
    lastName: string;
    status: string;
    defaultRate: number | null;
    allRates: Array<{ label: string; value: number; default: boolean }>;
    jobTitle: string | null;
    email: string | null;
    integrationAccountId: string | null;
  };
}

/** id → title (deleted departments excluded) */
export interface DepartmentMap {
  [id: string]: string;
}

export interface CaseTypeMap {
  [id: string]: {
    title: string;
    departmentId: string;
    departmentTitle: string;
    isFixedFee: boolean;
    fixedFeeValue: number | null;
  };
}

export interface LookupTables {
  attorneys: YaoAttorney[];
  departments: YaoDepartment[];
  caseTypes: YaoCaseType[];
  attorneyMap: AttorneyMap;
  departmentMap: DepartmentMap;
  caseTypeMap: CaseTypeMap;
}
