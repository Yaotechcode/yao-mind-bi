import { describe, it, expect } from 'vitest';

import { buildClientProfiles } from '../../../../src/server/datasource/enrich/client-profile-builder.js';

import type { NormalisedContact } from '../../../../src/server/datasource/normalise/types.js';
import type { NormalisedMatter } from '../../../../src/server/datasource/normalise/types.js';
import type { NormalisedInvoice } from '../../../../src/server/datasource/normalise/types.js';

// =============================================================================
// Fixture builders
// =============================================================================

function makeContact(o: Partial<NormalisedContact> = {}): NormalisedContact {
  return {
    contactId: 'c-1',
    type: 'Person',
    displayName: 'Alice Jones',
    isCompany: false,
    firstName: 'Alice',
    middleName: null,
    lastName: 'Jones',
    companyName: null,
    primaryEmail: 'alice@example.com',
    primaryPhone: '07700900000',
    tags: [],
    isArchived: false,
    lawFirm: 'firm-1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...o,
  };
}

function makeMatter(o: Partial<NormalisedMatter> = {}): NormalisedMatter {
  return {
    _id: 'matter-1',
    number: 1001,
    numberString: '1001',
    caseName: 'Smith v Jones',
    status: 'IN_PROGRESS',
    budget: 5000,
    isActive: true,
    isClosed: false,
    isFixedFee: false,
    isPrivate: false,
    source: null,
    sourceContactName: null,
    responsibleLawyerId: 'att-1',
    responsibleLawyerName: 'Bob Smith',
    responsibleLawyerRate: 250,
    supervisorId: null,
    supervisorName: null,
    paralegalId: null,
    paralegalName: null,
    departmentId: 'dept-1',
    departmentName: 'Litigation',
    caseTypeId: 'ct-1',
    caseTypeName: 'Civil Litigation',
    primaryClientId: 'c-1',
    primaryClientName: 'Alice Jones',
    clientIds: ['c-1'],
    clientNames: ['Alice Jones'],
    lawFirmId: 'firm-1',
    lastStatusUpdate: null,
    inProgressDate: null,
    completedDate: null,
    archivedDate: null,
    createdAt: '2024-03-01T00:00:00Z',
    updatedAt: '2024-03-15T00:00:00Z',
    ...o,
  };
}

function makeInvoice(o: Partial<NormalisedInvoice> = {}): NormalisedInvoice {
  return {
    _id: 'inv-1',
    invoiceNumber: 1001,
    invoiceDate: '2024-03-10',
    dueDate: '2024-03-31',
    subtotal: 1000,
    totalDisbursements: 0,
    totalOtherFees: 0,
    totalFirmFees: 1000,
    writeOff: 0,
    total: 1000,
    outstanding: 0,
    paid: 1000,
    credited: 0,
    writtenOff: 0,
    vat: 200,
    vatPercentage: 20,
    status: 'PAID',
    type: 'STANDARD',
    responsibleLawyerId: 'att-1',
    responsibleLawyerName: 'Bob Smith',
    matterId: 'matter-1',
    matterNumber: 1001,
    primaryClientId: 'c-1',
    primaryClientName: 'Alice Jones',
    clientIds: ['c-1'],
    clientNames: ['Alice Jones'],
    datePaid: '2024-03-15',
    narrative: null,
    reference: null,
    integrationId: null,
    createdAt: '2024-03-10T00:00:00Z',
    updatedAt: '2024-03-15T00:00:00Z',
    ...o,
  };
}

// =============================================================================
// Basic structure
// =============================================================================

describe('buildClientProfiles()', () => {
  it('returns one profile per contact', () => {
    const contacts = [makeContact({ contactId: 'c-1' }), makeContact({ contactId: 'c-2' })];
    const result = buildClientProfiles(contacts, [], []);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.clientId)).toEqual(['c-1', 'c-2']);
  });

  it('maps contact identity fields correctly', () => {
    const contact = makeContact({
      contactId: 'c-1',
      displayName: 'Alice Jones',
      type: 'Person',
      primaryEmail: 'alice@example.com',
      primaryPhone: '07700900000',
      tags: ['vip'],
      isArchived: false,
    });
    const [profile] = buildClientProfiles([contact], [], []);
    expect(profile.clientId).toBe('c-1');
    expect(profile.displayName).toBe('Alice Jones');
    expect(profile.type).toBe('Person');
    expect(profile.email).toBe('alice@example.com');
    expect(profile.phone).toBe('07700900000');
    expect(profile.tags).toEqual(['vip']);
    expect(profile.isArchived).toBe(false);
    expect(profile.address).toBeNull();
  });

  it('client with no matters still appears with zero aggregates', () => {
    const contacts = [makeContact({ contactId: 'c-1' })];
    const [profile] = buildClientProfiles(contacts, [], []);
    expect(profile.matterCount).toBe(0);
    expect(profile.activeMatterCount).toBe(0);
    expect(profile.totalInvoiced).toBe(0);
    expect(profile.totalOutstanding).toBe(0);
    expect(profile.totalPaid).toBe(0);
    expect(profile.firstMatterDate).toBeNull();
    expect(profile.lastMatterDate).toBeNull();
    expect(profile.departmentIds).toEqual([]);
    expect(profile.departmentNames).toEqual([]);
  });
});

// =============================================================================
// Matter aggregation
// =============================================================================

describe('matter aggregation', () => {
  it('counts matters correctly', () => {
    const contacts = [makeContact({ contactId: 'c-1' })];
    const matters = [
      makeMatter({ _id: 'matter-1', clientIds: ['c-1'] }),
      makeMatter({ _id: 'matter-2', clientIds: ['c-1'] }),
      makeMatter({ _id: 'matter-3', clientIds: ['c-2'] }), // different client
    ];
    const [profile] = buildClientProfiles(contacts, matters, []);
    expect(profile.matterCount).toBe(2);
  });

  it('counts only active matters in activeMatterCount', () => {
    const contacts = [makeContact({ contactId: 'c-1' })];
    const matters = [
      makeMatter({ _id: 'matter-1', clientIds: ['c-1'], isActive: true }),
      makeMatter({ _id: 'matter-2', clientIds: ['c-1'], isActive: false }),
      makeMatter({ _id: 'matter-3', clientIds: ['c-1'], isActive: true }),
    ];
    const [profile] = buildClientProfiles(contacts, matters, []);
    expect(profile.matterCount).toBe(3);
    expect(profile.activeMatterCount).toBe(2);
  });

  it('tracks firstMatterDate and lastMatterDate from createdAt', () => {
    const contacts = [makeContact({ contactId: 'c-1' })];
    const matters = [
      makeMatter({ _id: 'matter-1', clientIds: ['c-1'], createdAt: '2024-01-15T00:00:00Z' }),
      makeMatter({ _id: 'matter-2', clientIds: ['c-1'], createdAt: '2024-03-20T00:00:00Z' }),
      makeMatter({ _id: 'matter-3', clientIds: ['c-1'], createdAt: '2024-02-10T00:00:00Z' }),
    ];
    const [profile] = buildClientProfiles(contacts, matters, []);
    expect(profile.firstMatterDate).toBe('2024-01-15');
    expect(profile.lastMatterDate).toBe('2024-03-20');
  });

  it('deduplicates departments across matters', () => {
    const contacts = [makeContact({ contactId: 'c-1' })];
    const matters = [
      makeMatter({ _id: 'matter-1', clientIds: ['c-1'], departmentId: 'dept-1', departmentName: 'Litigation' }),
      makeMatter({ _id: 'matter-2', clientIds: ['c-1'], departmentId: 'dept-1', departmentName: 'Litigation' }),
      makeMatter({ _id: 'matter-3', clientIds: ['c-1'], departmentId: 'dept-2', departmentName: 'Property' }),
    ];
    const [profile] = buildClientProfiles(contacts, matters, []);
    expect(profile.departmentIds).toHaveLength(2);
    expect(profile.departmentIds).toContain('dept-1');
    expect(profile.departmentIds).toContain('dept-2');
    expect(profile.departmentNames).toHaveLength(2);
    expect(profile.departmentNames).toContain('Litigation');
    expect(profile.departmentNames).toContain('Property');
  });

  it('excludes null departmentId from department lists', () => {
    const contacts = [makeContact({ contactId: 'c-1' })];
    const matters = [
      makeMatter({ clientIds: ['c-1'], departmentId: null, departmentName: null }),
    ];
    const [profile] = buildClientProfiles(contacts, matters, []);
    expect(profile.departmentIds).toHaveLength(0);
    expect(profile.departmentNames).toHaveLength(0);
  });

  it('handles a matter linked to multiple clients', () => {
    const contacts = [
      makeContact({ contactId: 'c-1' }),
      makeContact({ contactId: 'c-2' }),
    ];
    const matters = [
      makeMatter({ _id: 'matter-1', clientIds: ['c-1', 'c-2'] }),
    ];
    const result = buildClientProfiles(contacts, matters, []);
    expect(result.find((p) => p.clientId === 'c-1')?.matterCount).toBe(1);
    expect(result.find((p) => p.clientId === 'c-2')?.matterCount).toBe(1);
  });
});

// =============================================================================
// Invoice aggregation
// =============================================================================

describe('invoice aggregation', () => {
  it('sums invoice financial totals correctly', () => {
    const contacts = [makeContact({ contactId: 'c-1' })];
    const invoices = [
      makeInvoice({ _id: 'inv-1', clientIds: ['c-1'], total: 1000, outstanding: 0,  paid: 1000, status: 'PAID' }),
      makeInvoice({ _id: 'inv-2', clientIds: ['c-1'], total: 500,  outstanding: 300, paid: 200, status: 'ISSUED' }),
    ];
    const [profile] = buildClientProfiles(contacts, [], invoices);
    expect(profile.totalInvoiced).toBe(1500);
    expect(profile.totalOutstanding).toBe(300);
    expect(profile.totalPaid).toBe(1200);
  });

  it('excludes DRAFT invoices from totals', () => {
    const contacts = [makeContact({ contactId: 'c-1' })];
    const invoices = [
      makeInvoice({ _id: 'inv-1', clientIds: ['c-1'], total: 1000, status: 'PAID' }),
      makeInvoice({ _id: 'inv-2', clientIds: ['c-1'], total: 500,  status: 'DRAFT' }),
    ];
    const [profile] = buildClientProfiles(contacts, [], invoices);
    expect(profile.totalInvoiced).toBe(1000);
  });

  it('excludes CANCELED invoices from totals', () => {
    const contacts = [makeContact({ contactId: 'c-1' })];
    const invoices = [
      makeInvoice({ _id: 'inv-1', clientIds: ['c-1'], total: 1000, status: 'ISSUED' }),
      makeInvoice({ _id: 'inv-2', clientIds: ['c-1'], total: 999,  status: 'CANCELED' }),
    ];
    const [profile] = buildClientProfiles(contacts, [], invoices);
    expect(profile.totalInvoiced).toBe(1000);
  });

  it('includes CREDITED invoices', () => {
    const contacts = [makeContact({ contactId: 'c-1' })];
    const invoices = [
      makeInvoice({ _id: 'inv-1', clientIds: ['c-1'], total: 800, status: 'CREDITED' }),
    ];
    const [profile] = buildClientProfiles(contacts, [], invoices);
    expect(profile.totalInvoiced).toBe(800);
  });

  it('only counts invoices belonging to the client', () => {
    const contacts = [makeContact({ contactId: 'c-1' })];
    const invoices = [
      makeInvoice({ _id: 'inv-1', clientIds: ['c-1'], total: 1000, status: 'PAID' }),
      makeInvoice({ _id: 'inv-2', clientIds: ['c-2'], total: 500,  status: 'PAID' }),
    ];
    const [profile] = buildClientProfiles(contacts, [], invoices);
    expect(profile.totalInvoiced).toBe(1000);
  });
});

// =============================================================================
// lastActivityDate
// =============================================================================

describe('lastActivityDate', () => {
  it('derives lastActivityDate from most recent invoice date', () => {
    const contacts = [makeContact({ contactId: 'c-1' })];
    const invoices = [
      makeInvoice({ _id: 'inv-1', clientIds: ['c-1'], invoiceDate: '2024-03-10', status: 'PAID' }),
      makeInvoice({ _id: 'inv-2', clientIds: ['c-1'], invoiceDate: '2024-01-05', status: 'PAID' }),
    ];
    const [profile] = buildClientProfiles(contacts, [], invoices);
    expect(profile.lastActivityDate).toBe('2024-03-10');
  });

  it('uses matter updatedAt as activity when later than invoice date', () => {
    const contacts = [makeContact({ contactId: 'c-1' })];
    const matters = [
      makeMatter({ clientIds: ['c-1'], updatedAt: '2024-04-01T00:00:00Z' }),
    ];
    const invoices = [
      makeInvoice({ clientIds: ['c-1'], invoiceDate: '2024-03-10', status: 'PAID' }),
    ];
    const [profile] = buildClientProfiles(contacts, matters, invoices);
    expect(profile.lastActivityDate).toBe('2024-04-01');
  });

  it('is null when no matters or invoices', () => {
    const [profile] = buildClientProfiles([makeContact()], [], []);
    expect(profile.lastActivityDate).toBeNull();
  });
});

// =============================================================================
// Empty inputs
// =============================================================================

describe('empty inputs', () => {
  it('returns empty array when no contacts', () => {
    expect(buildClientProfiles([], [], [])).toEqual([]);
  });
});
