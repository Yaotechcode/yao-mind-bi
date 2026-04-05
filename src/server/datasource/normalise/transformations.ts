/**
 * transformations.ts — Pure field transformation functions.
 *
 * Each function takes a raw Yao API record and returns a normalised entity.
 * These are pure functions: no side effects, no network calls, no state mutation.
 * All return null (not throw) when required inputs are absent.
 *
 * Belt-and-suspenders: sensitive fields are excluded from all outputs even if
 * they somehow survived the fetch layer.
 */

import type {
  YaoAttorney,
  YaoMatter,
  YaoTimeEntry,
  YaoInvoice,
  YaoLedger,
  YaoTask,
  YaoContact,
} from '../types.js';

import type {
  LookupMaps,
  NormalisedAttorney,
  NormalisedMatter,
  NormalisedTimeEntry,
  NormalisedInvoice,
  NormalisedDisbursement,
  NormalisedTask,
  NormalisedContact,
} from './types.js';

// =============================================================================
// Status sets
// =============================================================================

const ACTIVE_STATUSES = new Set(['IN_PROGRESS', 'ON_HOLD', 'EXCHANGED', 'QUOTE']);
const CLOSED_STATUSES = new Set(['COMPLETED', 'ARCHIVED', 'CLOSED']);

// =============================================================================
// Shared helpers
// =============================================================================

function fullName(first: string, last: string): string {
  return `${first} ${last}`;
}

function defaultRate(rates: Array<{ value: number; default: boolean }> | undefined): number | null {
  return rates?.find((r) => r.default)?.value ?? null;
}

// =============================================================================
// Transformations
// =============================================================================

export function transformAttorney(raw: YaoAttorney): NormalisedAttorney {
  return {
    _id: raw._id,
    fullName: fullName(raw.name, raw.surname),
    firstName: raw.name,
    lastName: raw.surname,
    // Fields not in ATTORNEY_KEEP_FIELDS — always null/default after pruning
    email: '',
    integrationAccountId: null,
    integrationAccountCode: null,
    phone: null,
    lawFirm: '',
    createdAt: '',
    updatedAt: '',
    status: raw.status,
    defaultRate: defaultRate(raw.rates),
    allRates: raw.rates ?? [],
    jobTitle: raw.job_title ?? null,
  };
}

export function transformMatter(raw: YaoMatter, maps: LookupMaps): NormalisedMatter {
  const caseTypeId = raw.case_type?._id ?? null;
  const departmentId = raw.department?._id ?? null;

  return {
    _id: raw._id,
    number: raw.number,
    // number_string, private, archived_date, law_firm not in MATTER_KEEP_FIELDS
    numberString: null,
    caseName: raw.case_name,
    status: raw.status,

    // Field transformations
    budget: raw.financial_limit,
    isActive: ACTIVE_STATUSES.has(raw.status),
    isClosed: CLOSED_STATUSES.has(raw.status),
    isFixedFee: maps.caseTypeMap[caseTypeId ?? '']?.isFixedFee ?? false,
    isPrivate: false,
    source: raw.source ?? null,
    sourceContactName: raw.source_contact_name ?? null,

    // Responsible lawyer — name and rate come from the nested object
    responsibleLawyerId: raw.responsible_lawyer?._id ?? null,
    responsibleLawyerName: raw.responsible_lawyer
      ? fullName(raw.responsible_lawyer.name, raw.responsible_lawyer.surname)
      : null,
    responsibleLawyerRate: defaultRate(raw.responsible_lawyer?.rates),

    // Supervisor
    supervisorId: raw.responsible_supervisor?._id ?? null,
    supervisorName: raw.responsible_supervisor
      ? fullName(raw.responsible_supervisor.name, raw.responsible_supervisor.surname)
      : null,

    // Paralegal
    paralegalId: raw.paralegal?._id ?? null,
    paralegalName: raw.paralegal
      ? fullName(raw.paralegal.name, raw.paralegal.surname)
      : null,

    // Department — prefer nested title; || falls back on empty string too, not just null/undefined
    departmentId,
    departmentName: raw.department?.title || maps.departmentMap[departmentId ?? ''] || null,

    // Case type — prefer nested title; same empty-string fallback logic
    caseTypeId,
    caseTypeName: raw.case_type?.title || maps.caseTypeMap[caseTypeId ?? '']?.title || null,

    // Clients
    primaryClientId: raw.clients?.[0]?.contact?._id ?? null,
    primaryClientName: raw.clients?.[0]?.contact?.display_name ?? null,
    clientIds: raw.clients?.map((c) => c.contact._id) ?? [],
    clientNames: raw.clients?.map((c) => c.contact.display_name) ?? [],

    // law_firm not in MATTER_KEEP_FIELDS
    lawFirmId: '',

    // Dates
    lastStatusUpdate: raw.last_status_update ?? null,
    inProgressDate: raw.in_progress_date ?? null,
    completedDate: raw.completed_date ?? null,
    archivedDate: null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function transformTimeEntry(raw: YaoTimeEntry): NormalisedTimeEntry {
  return {
    _id: raw._id,
    // description, rate, client_rate, units, status, invoice, created_at, updated_at
    // not in TIME_ENTRY_KEEP_FIELDS — default to empty/zero/null
    description: '',
    activityType: raw.activity?.title ?? raw.work_type ?? null,
    durationHours: raw.duration_minutes / 60,
    isChargeable: !raw.do_not_bill && raw.billable > 0,
    doNotBill: raw.do_not_bill,
    rate: 0,
    clientRate: null,
    units: 0,
    billable: raw.billable,
    writeOff: raw.write_off,
    recordedValue: raw.billable + raw.write_off,
    status: 'ACTIVE',
    lawyerId: raw.assignee?._id ?? null,
    lawyerName: raw.assignee
      ? fullName(raw.assignee.name, raw.assignee.surname)
      : null,
    lawyerDefaultRate: null,   // populated by resolution layer
    lawyerStatus: null,        // populated by resolution layer
    lawyerIntegrationId: null, // populated by resolution layer
    matterId: raw.matter._id,
    matterNumber: raw.matter.number,
    invoice: null,
    date: raw.date,
    createdAt: '',
    updatedAt: '',
  };
}

export function transformInvoice(raw: YaoInvoice): NormalisedInvoice {
  return {
    _id: raw._id,
    invoiceNumber: raw.invoice_number,
    invoiceDate: raw.invoice_date,
    dueDate: raw.due_date,
    subtotal: raw.subtotal,
    // total_disbursements, total_other_fees, credited, vat_percentage, type, narrative,
    // reference, integration_id, created_at, updated_at not in INVOICE_KEEP_FIELDS
    totalDisbursements: 0,
    totalOtherFees: 0,
    totalFirmFees: raw.total_firm_fees,
    writeOff: raw.write_off,
    total: raw.total,
    outstanding: raw.outstanding,
    paid: raw.paid,
    credited: 0,
    writtenOff: raw.written_off,
    vat: raw.vat,
    vatPercentage: 0,
    status: raw.status ?? '',
    type: '',
    responsibleLawyerId: raw.solicitor?._id ?? null,
    responsibleLawyerName: raw.solicitor?.name ?? null,
    matterId: raw.matter?._id ?? null,
    matterNumber: raw.matter?.number ?? null,
    primaryClientId: raw.clients?.[0]?._id ?? null,
    primaryClientName: raw.clients?.[0]?.display_name ?? null,
    clientIds: raw.clients?.map((c) => c._id) ?? [],
    clientNames: raw.clients?.map((c) => c.display_name) ?? [],
    datePaid: null, // populated later in enrichment from ledger records
    narrative: null,
    reference: null,
    integrationId: null,
    createdAt: '',
    updatedAt: '',
  };
}

export function transformDisbursement(raw: YaoLedger): NormalisedDisbursement {
  return {
    transactionId: raw._id,
    type: raw.type,
    subtotal: Math.abs(raw.value),
    vatAmount: Math.abs(raw.vat),
    // vat_percentage, created_at, updated_at not in LEDGER_KEEP_FIELDS
    vatPercentage: 0,
    outstanding: raw.outstanding,
    firmExposure: raw.outstanding < 0 ? Math.abs(raw.outstanding) : 0,
    isRecovered: raw.outstanding === 0,
    description: raw.reference ?? null,
    supplierId: raw.payee ?? null,
    matterId: raw.matter?._id ?? null,
    matterNumber: raw.matter?.number ?? null,
    responsibleLawyerId: raw.responsible_lawyer?._id ?? null,
    responsibleLawyerName: null, // responsible_lawyer on ledger only has _id
    date: raw.date,
    createdAt: '',
    updatedAt: '',
  };
}

export function transformTask(raw: YaoTask): NormalisedTask {
  const isOverdue =
    raw.status !== 'COMPLETED' &&
    raw.due_date != null &&
    new Date(raw.due_date) < new Date();

  return {
    taskId: raw._id,
    title: raw.title,
    priority: raw.priority,
    status: raw.status,
    // category, completed_date, description, estimate_time, notify_flag,
    // created_at, updated_at not in TASK_KEEP_FIELDS
    category: null,
    dueDate: raw.due_date ?? null,
    completedDate: null,
    description: null,
    estimateTime: null,
    notifyFlag: false,
    isOverdue,
    lawyerId: raw.assigned_to?._id ?? null,
    lawyerName: raw.assigned_to
      ? fullName(raw.assigned_to.name, raw.assigned_to.surname)
      : null,
    matterId: raw.matter?._id ?? null,
    matterNumber: raw.matter?.number ?? null,
    createdAt: '',
    updatedAt: '',
  };
}

export function transformContact(raw: YaoContact): NormalisedContact {
  return {
    contactId: raw._id,
    type: raw.type,
    displayName: raw.display_name,
    isCompany: raw.type === 'Company',
    // first_name, middle_name, last_name, email, mobile_phone, work_phone,
    // tags, is_archived, law_firm, created_at, updated_at not in CONTACT_KEEP_FIELDS
    firstName: null,
    middleName: null,
    lastName: null,
    companyName: raw.company_name ?? null,
    primaryEmail: null,
    primaryPhone: null,
    tags: [],
    isArchived: false,
    lawFirm: '',
    createdAt: '',
    updatedAt: '',
  };
}
