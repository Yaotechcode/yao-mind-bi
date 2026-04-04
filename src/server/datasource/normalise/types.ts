/**
 * normalise/types.ts — Normalised entity shapes.
 *
 * These are the outputs of the transformation layer. Each Normalised* type is
 * a flattened, denormalised view of the raw API record with computed fields
 * added and ObjectId references resolved where possible.
 *
 * Rules:
 *  - No null fields from missing required data — use null explicitly
 *  - All IDs are strings
 *  - Financial values are numbers (never strings)
 *  - Dates remain as ISO strings; computed booleans (isActive etc.) are booleans
 */

import type { AttorneyMap, DepartmentMap, CaseTypeMap } from '../types.js';

// =============================================================================
// Shared utility types
// =============================================================================

/** The three in-memory lookup maps passed to transformMatter. */
export interface LookupMaps {
  attorneyMap: AttorneyMap;
  departmentMap: DepartmentMap;
  caseTypeMap: CaseTypeMap;
}

// =============================================================================
// Normalised entity types
// =============================================================================

export interface NormalisedAttorney {
  _id: string;
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
  phone: string | null;
  lawFirm: string;
  createdAt: string;
  updatedAt: string;
}

export interface NormalisedMatter {
  _id: string;
  number: number;
  numberString: string | null;
  caseName: string;
  status: string;
  budget: number;
  isActive: boolean;
  isClosed: boolean;
  isFixedFee: boolean;
  isPrivate: boolean;
  source: string | null;
  sourceContactName: string | null;
  // Responsible lawyer
  responsibleLawyerId: string | null;
  responsibleLawyerName: string | null;
  responsibleLawyerRate: number | null;
  // Supervisor
  supervisorId: string | null;
  supervisorName: string | null;
  // Paralegal
  paralegalId: string | null;
  paralegalName: string | null;
  // Department + case type
  departmentId: string | null;
  departmentName: string | null;
  caseTypeId: string | null;
  caseTypeName: string | null;
  // Client
  primaryClientId: string | null;
  primaryClientName: string | null;
  clientIds: string[];
  clientNames: string[];
  // Meta
  lawFirmId: string;
  lastStatusUpdate: string | null;
  inProgressDate: string | null;
  completedDate: string | null;
  archivedDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NormalisedTimeEntry {
  _id: string;
  description: string;
  activityType: string | null;
  durationHours: number;
  isChargeable: boolean;
  doNotBill: boolean;
  rate: number;
  clientRate: number | null;
  units: number;
  billable: number;
  writeOff: number;
  recordedValue: number;
  status: string;
  lawyerId: string | null;
  lawyerName: string | null;
  matterId: string;
  matterNumber: number;
  invoice: string | null;
  date: string;
  createdAt: string;
  updatedAt: string;
}

export interface NormalisedInvoice {
  _id: string;
  invoiceNumber: number;
  invoiceDate: string;
  dueDate: string;
  subtotal: number;
  totalDisbursements: number;
  totalOtherFees: number;
  totalFirmFees: number;
  writeOff: number;
  total: number;
  outstanding: number;
  paid: number;
  credited: number;
  writtenOff: number;
  vat: number;
  vatPercentage: number;
  status: string;
  type: string;
  responsibleLawyerId: string | null;
  responsibleLawyerName: string | null;
  matterId: string | null;
  matterNumber: number | null;
  primaryClientId: string | null;
  primaryClientName: string | null;
  clientIds: string[];
  clientNames: string[];
  /** Populated later in enrichment from ledger records. Null at transform time. */
  datePaid: string | null;
  narrative: string | null;
  reference: string | null;
  integrationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NormalisedDisbursement {
  transactionId: string;
  type: string;
  subtotal: number;
  vatAmount: number;
  vatPercentage: number;
  outstanding: number;
  firmExposure: number;
  isRecovered: boolean;
  description: string | null;
  supplierId: string | null;
  matterId: string | null;
  matterNumber: number | null;
  responsibleLawyerId: string | null;
  responsibleLawyerName: string | null;
  date: string;
  createdAt: string;
  updatedAt: string;
}

export interface NormalisedTask {
  taskId: string;
  title: string;
  priority: string;
  status: string;
  category: string | null;
  dueDate: string | null;
  completedDate: string | null;
  description: string | null;
  estimateTime: number | null;
  notifyFlag: boolean;
  isOverdue: boolean;
  lawyerId: string | null;
  lawyerName: string | null;
  matterId: string | null;
  matterNumber: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface NormalisedContact {
  contactId: string;
  type: 'Person' | 'Company';
  displayName: string;
  isCompany: boolean;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  companyName: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  tags: string[];
  isArchived: boolean;
  lawFirm: string;
  createdAt: string;
  updatedAt: string;
}
