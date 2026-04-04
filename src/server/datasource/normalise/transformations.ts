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
    email: raw.email,
    status: raw.status,
    defaultRate: defaultRate(raw.rates),
    allRates: raw.rates ?? [],
    integrationAccountId: raw.integration_account_id ?? null,
    integrationAccountCode: raw.integration_account_code ?? null,
    jobTitle: raw.job_title ?? null,
    phone: raw.phone ?? null,
    lawFirm: raw.law_firm,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function transformMatter(raw: YaoMatter, maps: LookupMaps): NormalisedMatter {
  const caseTypeId = raw.case_type?._id ?? null;
  const departmentId = raw.department?._id ?? null;

  return {
    _id: raw._id,
    number: raw.number,
    numberString: raw.number_string ?? null,
    caseName: raw.case_name,
    status: raw.status,

    // Field transformations
    budget: raw.financial_limit,
    isActive: ACTIVE_STATUSES.has(raw.status),
    isClosed: CLOSED_STATUSES.has(raw.status),
    isFixedFee: maps.caseTypeMap[caseTypeId ?? '']?.isFixedFee ?? false,
    isPrivate: raw.private ?? false,
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

    // Firm
    lawFirmId: typeof raw.law_firm === 'object' ? raw.law_firm._id : raw.law_firm,

    // Dates
    lastStatusUpdate: raw.last_status_update ?? null,
    inProgressDate: raw.in_progress_date ?? null,
    completedDate: raw.completed_date ?? null,
    archivedDate: raw.archived_date ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function transformTimeEntry(raw: YaoTimeEntry): NormalisedTimeEntry {
  return {
    _id: raw._id,
    description: raw.description,
    activityType: raw.activity?.title ?? raw.work_type ?? null,
    durationHours: raw.duration_minutes / 60,
    isChargeable: !raw.do_not_bill && raw.billable > 0,
    doNotBill: raw.do_not_bill,
    rate: raw.rate,
    clientRate: raw.client_rate ?? null,
    units: raw.units,
    billable: raw.billable,
    writeOff: raw.write_off,
    recordedValue: raw.billable + raw.write_off,
    status: raw.status,
    lawyerId: raw.assignee?._id ?? null,
    lawyerName: raw.assignee
      ? fullName(raw.assignee.name, raw.assignee.surname)
      : null,
    lawyerDefaultRate: null,   // populated by resolution layer
    lawyerStatus: null,        // populated by resolution layer
    lawyerIntegrationId: null, // populated by resolution layer
    matterId: raw.matter._id,
    matterNumber: raw.matter.number,
    invoice: raw.invoice ?? null,
    date: raw.date,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function transformInvoice(raw: YaoInvoice): NormalisedInvoice {
  return {
    _id: raw._id,
    invoiceNumber: raw.invoice_number,
    invoiceDate: raw.invoice_date,
    dueDate: raw.due_date,
    subtotal: raw.subtotal,
    totalDisbursements: raw.total_disbursements,
    totalOtherFees: raw.total_other_fees,
    totalFirmFees: raw.total_firm_fees,
    writeOff: raw.write_off,
    total: raw.total,
    outstanding: raw.outstanding,
    paid: raw.paid,
    credited: raw.credited,
    writtenOff: raw.written_off,
    vat: raw.vat,
    vatPercentage: raw.vat_percentage,
    status: raw.status,
    type: raw.type,
    responsibleLawyerId: raw.solicitor?._id ?? null,
    responsibleLawyerName: raw.solicitor?.name ?? null,
    matterId: raw.matter?._id ?? null,
    matterNumber: raw.matter?.number ?? null,
    primaryClientId: raw.clients?.[0]?._id ?? null,
    primaryClientName: raw.clients?.[0]?.display_name ?? null,
    clientIds: raw.clients?.map((c) => c._id) ?? [],
    clientNames: raw.clients?.map((c) => c.display_name) ?? [],
    datePaid: null, // populated later in enrichment from ledger records
    narrative: raw.narrative ?? null,
    reference: raw.reference ?? null,
    integrationId: raw.integration_id ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function transformDisbursement(raw: YaoLedger): NormalisedDisbursement {
  return {
    transactionId: raw._id,
    type: raw.type,
    subtotal: Math.abs(raw.value),
    vatAmount: Math.abs(raw.vat),
    vatPercentage: raw.vat_percentage,
    outstanding: raw.outstanding,
    firmExposure: raw.outstanding < 0 ? Math.abs(raw.outstanding) : 0,
    isRecovered: raw.outstanding === 0,
    description: raw.reference ?? null,
    supplierId: raw.payee ?? null,
    matterId: raw.matter?._id ?? null,
    matterNumber: raw.matter?.number ?? null,
    responsibleLawyerId: raw.author?._id ?? null,
    responsibleLawyerName: raw.author?.name ?? null,
    date: raw.date,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
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
    category: raw.category ?? null,
    dueDate: raw.due_date ?? null,
    completedDate: raw.completed_date ?? null,
    description: raw.description ?? null,
    estimateTime: raw.estimate_time ?? null,
    notifyFlag: raw.notify_flag,
    isOverdue,
    lawyerId: raw.assigned_to?._id ?? null,
    lawyerName: raw.assigned_to
      ? fullName(raw.assigned_to.name, raw.assigned_to.surname)
      : null,
    matterId: raw.matter?._id ?? null,
    matterNumber: raw.matter?.number ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function transformContact(raw: YaoContact): NormalisedContact {
  return {
    contactId: raw._id,
    type: raw.type,
    displayName: raw.display_name,
    isCompany: raw.type === 'Company',
    firstName: raw.first_name ?? null,
    middleName: raw.middle_name ?? null,
    lastName: raw.last_name ?? null,
    companyName: raw.company_name ?? null,
    primaryEmail: raw.email ?? null,
    primaryPhone: raw.mobile_phone ?? raw.work_phone ?? null,
    tags: raw.tags ?? [],
    isArchived: raw.is_archived,
    lawFirm: raw.law_firm,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}
