/**
 * client-profile-builder.ts — Builds unified client profiles for the client dashboard.
 *
 * Aggregates matter, invoice, and contact data into ClientProfile objects keyed
 * by Yao contact _id. Contacts with no associated matters or invoices still
 * appear with zeroed aggregates.
 *
 * Rules:
 *  - Pure function — no side effects, no async
 *  - A contact appears once regardless of how many matters it is linked to
 *  - Only ISSUED, PAID, CREDITED invoices are included in financial totals
 *  - Department lists are deduplicated
 *  - address is not carried through the normalise layer — always null
 */

import type { NormalisedContact } from '../normalise/types.js';
import type { NormalisedMatter } from '../normalise/types.js';
import type { NormalisedInvoice } from '../normalise/types.js';

// =============================================================================
// Types
// =============================================================================

export interface ClientProfile {
  clientId: string;
  displayName: string;
  type: 'Person' | 'Company';
  email: string | null;
  phone: string | null;
  address: object | null;
  tags: string[];
  isArchived: boolean;
  // Aggregated matter stats
  matterCount: number;
  activeMatterCount: number;
  firstMatterDate: string | null;
  lastMatterDate: string | null;
  lastActivityDate: string | null;
  departmentIds: string[];
  departmentNames: string[];
  // Aggregated invoice stats
  totalInvoiced: number;
  totalOutstanding: number;
  totalPaid: number;
}

const BILLABLE_STATUSES = new Set(['ISSUED', 'PAID', 'CREDITED']);

// =============================================================================
// Builder
// =============================================================================

/**
 * Builds a ClientProfile for each contact by joining matters and invoices.
 * Uses Set-based lookups for O(n) join performance.
 */
export function buildClientProfiles(
  contacts: NormalisedContact[],
  matters: NormalisedMatter[],
  invoices: NormalisedInvoice[],
): ClientProfile[] {
  // Pre-index: contactId → matters
  const mattersByClient = new Map<string, NormalisedMatter[]>();
  for (const matter of matters) {
    for (const cid of matter.clientIds) {
      let list = mattersByClient.get(cid);
      if (!list) {
        list = [];
        mattersByClient.set(cid, list);
      }
      list.push(matter);
    }
  }

  // Pre-index: contactId → invoices (billable only)
  const invoicesByClient = new Map<string, NormalisedInvoice[]>();
  for (const invoice of invoices) {
    if (!BILLABLE_STATUSES.has(invoice.status)) continue;
    for (const cid of invoice.clientIds) {
      let list = invoicesByClient.get(cid);
      if (!list) {
        list = [];
        invoicesByClient.set(cid, list);
      }
      list.push(invoice);
    }
  }

  return contacts.map((contact) => {
    const clientMatters = mattersByClient.get(contact.contactId) ?? [];
    const clientInvoices = invoicesByClient.get(contact.contactId) ?? [];

    // --- Matter aggregation ---
    let firstMatterDate: string | null = null;
    let lastMatterDate: string | null = null;
    let activeMatterCount = 0;
    const deptIdSet = new Set<string>();
    const deptNameSet = new Set<string>();

    for (const matter of clientMatters) {
      if (matter.isActive) activeMatterCount += 1;

      const mDate = matter.createdAt.slice(0, 10);
      if (firstMatterDate === null || mDate < firstMatterDate) firstMatterDate = mDate;
      if (lastMatterDate === null || mDate > lastMatterDate) lastMatterDate = mDate;

      if (matter.departmentId) deptIdSet.add(matter.departmentId);
      if (matter.departmentName) deptNameSet.add(matter.departmentName);
    }

    // --- Invoice aggregation ---
    let totalInvoiced = 0;
    let totalOutstanding = 0;
    let totalPaid = 0;
    let lastActivityDate: string | null = null;

    for (const invoice of clientInvoices) {
      totalInvoiced += invoice.total;
      totalOutstanding += invoice.outstanding;
      totalPaid += invoice.paid;

      if (lastActivityDate === null || invoice.invoiceDate > lastActivityDate) {
        lastActivityDate = invoice.invoiceDate;
      }
    }

    // Also consider matter update dates as activity
    for (const matter of clientMatters) {
      const mUpdated = matter.updatedAt.slice(0, 10);
      if (lastActivityDate === null || mUpdated > lastActivityDate) {
        lastActivityDate = mUpdated;
      }
    }

    return {
      clientId: contact.contactId,
      displayName: contact.displayName,
      type: contact.type,
      email: contact.primaryEmail,
      phone: contact.primaryPhone,
      address: null, // not carried through the normalise layer
      tags: contact.tags,
      isArchived: contact.isArchived,
      matterCount: clientMatters.length,
      activeMatterCount,
      firstMatterDate,
      lastMatterDate,
      lastActivityDate,
      departmentIds: Array.from(deptIdSet),
      departmentNames: Array.from(deptNameSet),
      totalInvoiced,
      totalOutstanding,
      totalPaid,
    };
  });
}
