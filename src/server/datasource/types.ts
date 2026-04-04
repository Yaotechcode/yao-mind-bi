/**
 * types.ts — Yao API response shapes and derived map types.
 *
 * These model what the Yao API returns. Sensitive fields (password,
 * email_default_signature) are intentionally omitted — they are stripped
 * before any record leaves the fetch layer.
 */

// =============================================================================
// Raw API shapes
// =============================================================================

export interface YaoAttorney {
  _id: string;
  name: string;
  surname: string;
  status: 'ACTIVE' | 'PENDING' | 'DISABLED';
  email: string;
  job_title?: string;
  phone?: string;
  integration_account_id?: string;
  integration_account_code?: string;
  rates: Array<{ label: string; value: number; default: boolean }>;
  law_firm: string;
  created_at: string;
  updated_at: string;
  // password and email_default_signature are explicitly excluded
}

export interface YaoDepartment {
  _id: string;
  title: string;
  law_firm: string;
  is_deleted: boolean;
}

export interface YaoCaseType {
  _id: string;
  title: string;
  fixed_fee?: number;
  law_firm: string;
  department: { _id: string; title: string; is_deleted: boolean };
  is_deleted: boolean;
}

type NestedAttorney = {
  _id: string;
  name: string;
  surname: string;
  rates: Array<{ label: string; value: number; default: boolean }>;
};

export interface YaoMatter {
  _id: string;
  number: number;
  number_string?: string;
  status: string;
  case_name: string;
  financial_limit: number;
  rate: number | null;
  client_account_balance: number;
  office_account_balance: number;
  linked_account_balance: number;
  source?: string;
  source_contact_name?: string;
  private?: boolean;
  responsible_lawyer?: NestedAttorney;
  responsible_supervisor?: NestedAttorney;
  paralegal?: NestedAttorney;
  department?: { _id: string; title: string };
  case_type?: { _id: string; title: string };
  clients: Array<{
    contact: {
      _id: string;
      type: string;
      display_name: string;
      first_name?: string;
      last_name?: string;
      company_name?: string;
    };
  }>;
  case_contacts: Array<{
    category: string;
    contact: { _id: string; display_name: string; type: string };
    reference?: string;
  }>;
  last_status_update?: string;
  in_progress_date?: string;
  completed_date?: string;
  archived_date?: string;
  created_at: string;
  updated_at: string;
  law_firm: { _id: string; name: string } | string;
}

export interface YaoTimeEntry {
  _id: string;
  description: string;
  do_not_bill: boolean;
  rate: number;
  client_rate?: number;
  units: number;
  duration_minutes: number;
  billable: number;
  write_off: number;
  status: 'ACTIVE' | 'CONSOLIDATED' | 'CONSOLIDATION_TARGET';
  work_type?: string;
  activity?: { _id: string; title: string; measure: string };
  matter: { _id: string; number: number; case_name: string; law_firm: string };
  assignee?: {
    _id: string;
    name: string;
    surname: string;
    // password and email_default_signature are stripped before returning
  };
  invoice?: string;
  date: string;
  created_at: string;
  updated_at: string;
}

export interface YaoInvoice {
  _id: string;
  invoice_number: number;
  invoice_date: string;
  due_date: string;
  subtotal: number;
  total_disbursements: number;
  total_other_fees: number;
  total_firm_fees: number;
  write_off: number;
  total: number;
  outstanding: number;
  paid: number;
  credited: number;
  written_off: number;
  vat: number;
  vat_percentage: number;
  less_paid_on_account: number;
  billable_entries: number;
  time_entries_override_value: number;
  status: string;
  type: string;
  clients: Array<{
    _id: string;
    display_name: string;
    first_name?: string;
    last_name?: string;
  }>;
  solicitor?: { _id: string; name: string };
  matter?: { _id: string; number: number; case_name: string };
  narrative?: string;
  reference?: string;
  integration_id?: string;
  account_code?: string;
  history?: Array<{
    _id: string;
    name?: string;
    description: string;
    created_at: string;
    type: string;
  }>;
  created_at: string;
  updated_at: string;
}

export interface YaoInvoiceSummary {
  unpaid: number;
  paid: number;
  total: number;
}

export interface YaoLedger {
  _id: string;
  type: string;
  value: number;
  vat: number;
  vat_percentage: number;
  subtotal: number;
  outstanding: number;
  paid: number;
  status: string;
  notes?: string;
  reference?: string;
  payee?: string;
  tax_treatment?: string;
  supplier_vat?: number;
  date: string;
  law_firm: string;
  author?: { _id: string; name: string };
  bank_account?: { _id: string; name: string; account_number?: string };
  account_type?: string;
  matter?: { _id: string; number: number; case_name: string };
  /** Invoice _id as a string reference */
  invoice?: string;
  transfer_id?: string;
  disbursements?: Array<{ _id: string; value: number }>;
  integration_id?: string;
  account_id?: string;
  created_at: string;
  updated_at: string;
}

export interface RoutedLedgers {
  /** OFFICE_PAYMENT records — source of disbursement entities */
  disbursements: YaoLedger[];
  /** CLIENT_TO_OFFICE or OFFICE_RECEIPT with invoice populated — used to derive datePaid */
  invoicePayments: YaoLedger[];
  /** CLIENT_TO_OFFICE or OFFICE_RECEIPT with disbursements[] populated */
  disbursementRecoveries: YaoLedger[];
}

// =============================================================================
// Derived in-memory maps
// =============================================================================

export interface AttorneyMap {
  [id: string]: {
    fullName: string;
    firstName: string;
    lastName: string;
    email: string;
    status: string;
    defaultRate: number | null;
    allRates: Array<{ label: string; value: number; default: boolean }>;
    integrationAccountId: string | null;
    integrationAccountCode: string | null;
    jobTitle: string | null;
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
