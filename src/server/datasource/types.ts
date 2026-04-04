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
