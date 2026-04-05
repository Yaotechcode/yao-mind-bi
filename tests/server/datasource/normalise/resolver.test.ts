import { describe, it, expect } from 'vitest';

import {
  resolveTimeEntryEnrichment,
  resolveMatterEnrichment,
  resolveInvoiceEnrichment,
  resolveAll,
} from '../../../../src/server/datasource/normalise/resolver.js';

import type { LookupMaps } from '../../../../src/server/datasource/normalise/types.js';
import type {
  NormalisedTimeEntry,
  NormalisedMatter,
  NormalisedInvoice,
  NormalisedDisbursement,
  NormalisedTask,
} from '../../../../src/server/datasource/normalise/types.js';

// =============================================================================
// Fixtures
// =============================================================================

const MAPS: LookupMaps = {
  attorneyMap: {
    'att-1': {
      fullName: 'Alice Smith', firstName: 'Alice', lastName: 'Smith',
      status: 'ACTIVE', defaultRate: 250,
      allRates: [{ label: 'Standard', value: 250, default: true }],
      jobTitle: null,
    },
    'att-2': {
      fullName: 'Bob Brown', firstName: 'Bob', lastName: 'Brown',
      status: 'PENDING', defaultRate: null,
      allRates: [],
      jobTitle: null,
    },
  },
  departmentMap: { 'dept-1': 'Conveyancing', 'dept-2': 'Litigation' },
  caseTypeMap: {
    'ct-1': {
      title: 'Residential Purchase', departmentId: 'dept-1',
      departmentTitle: 'Conveyancing', isFixedFee: false, fixedFeeValue: null,
    },
  },
};

const EMPTY_MAPS: LookupMaps = {
  attorneyMap: {},
  departmentMap: {},
  caseTypeMap: {},
};

function makeTimeEntry(o: Partial<NormalisedTimeEntry> = {}): NormalisedTimeEntry {
  return {
    _id: 'te-1', description: 'Drafting', activityType: null, durationHours: 0.5,
    isChargeable: true, doNotBill: false, rate: 250, clientRate: null,
    units: 6, billable: 125, writeOff: 0, recordedValue: 125, status: 'ACTIVE',
    lawyerId: null, lawyerName: null,
    lawyerDefaultRate: null, lawyerStatus: null, lawyerIntegrationId: null,
    matterId: 'matter-1', matterNumber: 1001, invoice: null,
    date: '2024-03-01', createdAt: '2024-03-01T00:00:00Z', updatedAt: '2024-03-01T00:00:00Z',
    ...o,
  };
}

function makeMatter(o: Partial<NormalisedMatter> = {}): NormalisedMatter {
  return {
    _id: 'matter-1', number: 1001, numberString: null, caseName: 'Smith v Jones',
    status: 'IN_PROGRESS', budget: 5000, isActive: true, isClosed: false,
    isFixedFee: false, isPrivate: false, source: null, sourceContactName: null,
    responsibleLawyerId: null, responsibleLawyerName: null, responsibleLawyerRate: null,
    supervisorId: null, supervisorName: null,
    paralegalId: null, paralegalName: null,
    departmentId: null, departmentName: null,
    caseTypeId: null, caseTypeName: null,
    primaryClientId: null, primaryClientName: null, clientIds: [], clientNames: [],
    lawFirmId: 'firm-1', lastStatusUpdate: null, inProgressDate: null,
    completedDate: null, archivedDate: null,
    createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
    ...o,
  };
}

function makeInvoice(o: Partial<NormalisedInvoice> = {}): NormalisedInvoice {
  return {
    _id: 'inv-1', invoiceNumber: 101, invoiceDate: '2024-03-01', dueDate: '2024-04-01',
    subtotal: 1000, totalDisbursements: 0, totalOtherFees: 0, totalFirmFees: 1000,
    writeOff: 0, total: 1200, outstanding: 1200, paid: 0,
    credited: 0, writtenOff: 0, vat: 200, vatPercentage: 20,
    status: 'ISSUED', type: 'TAX',
    responsibleLawyerId: null, responsibleLawyerName: null,
    matterId: null, matterNumber: null,
    primaryClientId: null, primaryClientName: null, clientIds: [], clientNames: [],
    datePaid: null, narrative: null, reference: null, integrationId: null,
    createdAt: '2024-03-01T00:00:00Z', updatedAt: '2024-03-01T00:00:00Z',
    ...o,
  };
}

function makeDisbursement(o: Partial<NormalisedDisbursement> = {}): NormalisedDisbursement {
  return {
    transactionId: 'ledger-1', type: 'OFFICE_PAYMENT',
    subtotal: 500, vatAmount: 0, vatPercentage: 0, outstanding: 0,
    firmExposure: 0, isRecovered: true, description: null, supplierId: null,
    matterId: null, matterNumber: null,
    responsibleLawyerId: null, responsibleLawyerName: null,
    date: '2024-03-01', createdAt: '2024-03-01T00:00:00Z', updatedAt: '2024-03-01T00:00:00Z',
    ...o,
  };
}

function makeTask(o: Partial<NormalisedTask> = {}): NormalisedTask {
  return {
    taskId: 'task-1', title: 'Review contract', priority: 'MEDIUM',
    status: 'TO_DO', category: null, dueDate: null, completedDate: null,
    description: null, estimateTime: null, notifyFlag: false, isOverdue: false,
    lawyerId: null, lawyerName: null, matterId: null, matterNumber: null,
    createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
    ...o,
  };
}

// =============================================================================
// resolveTimeEntryEnrichment
// =============================================================================

describe('resolveTimeEntryEnrichment()', () => {
  it('fills lawyerDefaultRate from attorney map', () => {
    const entry = makeTimeEntry({ lawyerId: 'att-1' });
    const result = resolveTimeEntryEnrichment(entry, MAPS);
    expect(result.lawyerDefaultRate).toBe(250);
  });

  it('fills lawyerStatus from attorney map', () => {
    const entry = makeTimeEntry({ lawyerId: 'att-1' });
    const result = resolveTimeEntryEnrichment(entry, MAPS);
    expect(result.lawyerStatus).toBe('ACTIVE');
  });

  it('leaves lawyerIntegrationId null (integration_account_id not in keep list)', () => {
    const entry = makeTimeEntry({ lawyerId: 'att-1' });
    const result = resolveTimeEntryEnrichment(entry, MAPS);
    expect(result.lawyerIntegrationId).toBeNull();
  });

  it('leaves lawyerDefaultRate null when attorney has no default rate', () => {
    const entry = makeTimeEntry({ lawyerId: 'att-2' });
    const result = resolveTimeEntryEnrichment(entry, MAPS);
    expect(result.lawyerDefaultRate).toBeNull();
  });

  it('leaves lawyerIntegrationId null when attorney has no integration id', () => {
    const entry = makeTimeEntry({ lawyerId: 'att-2' });
    const result = resolveTimeEntryEnrichment(entry, MAPS);
    expect(result.lawyerIntegrationId).toBeNull();
  });

  it('returns same entry object when lawyerId is null', () => {
    const entry = makeTimeEntry({ lawyerId: null });
    const result = resolveTimeEntryEnrichment(entry, MAPS);
    expect(result).toBe(entry); // exact same reference — no work done
  });

  it('returns same entry object when attorney not in map', () => {
    const entry = makeTimeEntry({ lawyerId: 'unknown-att' });
    const result = resolveTimeEntryEnrichment(entry, MAPS);
    expect(result).toBe(entry);
  });

  it('does not mutate input entry', () => {
    const entry = makeTimeEntry({ lawyerId: 'att-1' });
    const original = { ...entry };
    resolveTimeEntryEnrichment(entry, MAPS);
    expect(entry.lawyerDefaultRate).toBe(original.lawyerDefaultRate); // still null
  });

  it('does not overwrite already-set lawyerDefaultRate', () => {
    const entry = makeTimeEntry({ lawyerId: 'att-1', lawyerDefaultRate: 300 });
    const result = resolveTimeEntryEnrichment(entry, MAPS);
    expect(result.lawyerDefaultRate).toBe(300); // not overwritten to 250
  });
});

// =============================================================================
// resolveMatterEnrichment
// =============================================================================

describe('resolveMatterEnrichment()', () => {
  it('fills departmentName from map when null', () => {
    const matter = makeMatter({ departmentId: 'dept-1', departmentName: null });
    const result = resolveMatterEnrichment(matter, MAPS);
    expect(result.departmentName).toBe('Conveyancing');
  });

  it('fills caseTypeName from map when null', () => {
    const matter = makeMatter({ caseTypeId: 'ct-1', caseTypeName: null });
    const result = resolveMatterEnrichment(matter, MAPS);
    expect(result.caseTypeName).toBe('Residential Purchase');
  });

  it('fills responsibleLawyerName from map when null', () => {
    const matter = makeMatter({ responsibleLawyerId: 'att-1', responsibleLawyerName: null });
    const result = resolveMatterEnrichment(matter, MAPS);
    expect(result.responsibleLawyerName).toBe('Alice Smith');
  });

  it('fills responsibleLawyerRate from map when null', () => {
    const matter = makeMatter({ responsibleLawyerId: 'att-1', responsibleLawyerRate: null });
    const result = resolveMatterEnrichment(matter, MAPS);
    expect(result.responsibleLawyerRate).toBe(250);
  });

  it('fills supervisorName from map when null', () => {
    const matter = makeMatter({ supervisorId: 'att-1', supervisorName: null });
    const result = resolveMatterEnrichment(matter, MAPS);
    expect(result.supervisorName).toBe('Alice Smith');
  });

  it('fills paralegalName from map when null', () => {
    const matter = makeMatter({ paralegalId: 'att-2', paralegalName: null });
    const result = resolveMatterEnrichment(matter, MAPS);
    expect(result.paralegalName).toBe('Bob Brown');
  });

  it('does not overwrite existing departmentName', () => {
    const matter = makeMatter({ departmentId: 'dept-1', departmentName: 'Already Set' });
    const result = resolveMatterEnrichment(matter, MAPS);
    expect(result.departmentName).toBe('Already Set');
  });

  it('returns same object when nothing to fill', () => {
    const matter = makeMatter(); // all IDs null
    const result = resolveMatterEnrichment(matter, MAPS);
    expect(result).toBe(matter);
  });

  it('handles missing map entry gracefully — field stays null', () => {
    const matter = makeMatter({ departmentId: 'dept-unknown', departmentName: null });
    const result = resolveMatterEnrichment(matter, MAPS);
    expect(result.departmentName).toBeNull();
  });

  it('does not mutate input matter', () => {
    const matter = makeMatter({ departmentId: 'dept-1', departmentName: null });
    const original = { ...matter };
    resolveMatterEnrichment(matter, MAPS);
    expect(matter.departmentName).toBe(original.departmentName); // still null
  });
});

// =============================================================================
// resolveInvoiceEnrichment
// =============================================================================

describe('resolveInvoiceEnrichment()', () => {
  it('fills responsibleLawyerName when ID set and name null', () => {
    const invoice = makeInvoice({ responsibleLawyerId: 'att-1', responsibleLawyerName: null });
    const result = resolveInvoiceEnrichment(invoice, MAPS);
    expect(result.responsibleLawyerName).toBe('Alice Smith');
  });

  it('does not overwrite existing responsibleLawyerName', () => {
    const invoice = makeInvoice({
      responsibleLawyerId: 'att-1', responsibleLawyerName: 'Original Name',
    });
    const result = resolveInvoiceEnrichment(invoice, MAPS);
    expect(result.responsibleLawyerName).toBe('Original Name');
  });

  it('returns same object when no lawyerId set', () => {
    const invoice = makeInvoice({ responsibleLawyerId: null });
    expect(resolveInvoiceEnrichment(invoice, MAPS)).toBe(invoice);
  });

  it('returns same object when attorney not in map', () => {
    const invoice = makeInvoice({ responsibleLawyerId: 'unknown', responsibleLawyerName: null });
    expect(resolveInvoiceEnrichment(invoice, MAPS)).toBe(invoice);
  });

  it('does not mutate input invoice', () => {
    const invoice = makeInvoice({ responsibleLawyerId: 'att-1', responsibleLawyerName: null });
    const original = { ...invoice };
    resolveInvoiceEnrichment(invoice, MAPS);
    expect(invoice.responsibleLawyerName).toBe(original.responsibleLawyerName);
  });
});

// =============================================================================
// resolveAll — immutability + completeness
// =============================================================================

describe('resolveAll()', () => {
  it('returns new arrays — does not mutate inputs', () => {
    const entries = [makeTimeEntry({ lawyerId: 'att-1' })];
    const matters = [makeMatter({ departmentId: 'dept-1', departmentName: null })];
    const invoices = [makeInvoice({ responsibleLawyerId: 'att-1', responsibleLawyerName: null })];

    const data = {
      timeEntries: entries,
      matters,
      invoices,
      disbursements: [makeDisbursement()],
      tasks: [makeTask()],
    };

    const result = resolveAll(data, MAPS);

    // Arrays are new
    expect(result.timeEntries).not.toBe(entries);
    expect(result.matters).not.toBe(matters);
    expect(result.invoices).not.toBe(invoices);

    // Original records unchanged
    expect(entries[0].lawyerDefaultRate).toBeNull();
    expect(matters[0].departmentName).toBeNull();
    expect(invoices[0].responsibleLawyerName).toBeNull();
  });

  it('disbursements and tasks are passed through unchanged', () => {
    const disbursements = [makeDisbursement()];
    const tasks = [makeTask()];
    const data = {
      timeEntries: [], matters: [], invoices: [],
      disbursements, tasks,
    };

    const result = resolveAll(data, EMPTY_MAPS);
    expect(result.disbursements).toBe(disbursements);
    expect(result.tasks).toBe(tasks);
  });

  it('applies time entry enrichment across all entries', () => {
    const data = {
      timeEntries: [
        makeTimeEntry({ _id: 'te-1', lawyerId: 'att-1' }),
        makeTimeEntry({ _id: 'te-2', lawyerId: 'att-2' }),
        makeTimeEntry({ _id: 'te-3', lawyerId: null }),
      ],
      matters: [], invoices: [], disbursements: [], tasks: [],
    };

    const result = resolveAll(data, MAPS);
    expect(result.timeEntries[0].lawyerDefaultRate).toBe(250);    // att-1 has rate
    expect(result.timeEntries[0].lawyerStatus).toBe('ACTIVE');
    expect(result.timeEntries[1].lawyerDefaultRate).toBeNull();   // att-2 has no default rate
    expect(result.timeEntries[1].lawyerStatus).toBe('PENDING');
    expect(result.timeEntries[2].lawyerDefaultRate).toBeNull();   // no lawyerId
  });

  it('applies matter enrichment across all matters', () => {
    const data = {
      timeEntries: [], invoices: [], disbursements: [], tasks: [],
      matters: [
        makeMatter({ _id: 'm-1', departmentId: 'dept-1', departmentName: null }),
        makeMatter({ _id: 'm-2', caseTypeId: 'ct-1', caseTypeName: null }),
      ],
    };

    const result = resolveAll(data, MAPS);
    expect(result.matters[0].departmentName).toBe('Conveyancing');
    expect(result.matters[1].caseTypeName).toBe('Residential Purchase');
  });

  it('handles completely empty maps gracefully', () => {
    const data = {
      timeEntries: [makeTimeEntry({ lawyerId: 'att-1' })],
      matters: [makeMatter({ departmentId: 'dept-1', departmentName: null })],
      invoices: [makeInvoice({ responsibleLawyerId: 'att-1', responsibleLawyerName: null })],
      disbursements: [], tasks: [],
    };

    expect(() => resolveAll(data, EMPTY_MAPS)).not.toThrow();
    const result = resolveAll(data, EMPTY_MAPS);
    expect(result.timeEntries[0].lawyerDefaultRate).toBeNull();
    expect(result.matters[0].departmentName).toBeNull();
    expect(result.invoices[0].responsibleLawyerName).toBeNull();
  });

  it('resolution stats track counts correctly', () => {
    // Use the individual resolvers with explicit stats objects to test counting
    const stats = { lawyerRate: 0, lawyerStatus: 0, lawyerIntegrationId: 0, total: 0 };
    const entry1 = makeTimeEntry({ lawyerId: 'att-1' });
    const entry2 = makeTimeEntry({ lawyerId: 'att-1' });
    const entry3 = makeTimeEntry({ lawyerId: null });

    resolveTimeEntryEnrichment(entry1, MAPS, stats);
    resolveTimeEntryEnrichment(entry2, MAPS, stats);
    resolveTimeEntryEnrichment(entry3, MAPS, stats);

    expect(stats.lawyerStatus).toBe(2); // att-1 status filled for both
    expect(stats.lawyerRate).toBe(2);   // att-1 rate filled for both
    expect(stats.total).toBe(2);        // only entries that were enriched
  });

  it('matter stats track correctly', () => {
    const stats = {
      departmentName: 0, caseTypeName: 0,
      responsibleLawyerName: 0, responsibleLawyerRate: 0,
      supervisorName: 0, paralegalName: 0, total: 0,
    };

    // This matter has department and lawyer missing
    resolveMatterEnrichment(
      makeMatter({ departmentId: 'dept-1', departmentName: null, responsibleLawyerId: 'att-1', responsibleLawyerName: null }),
      MAPS,
      stats,
    );
    // This matter has nothing to fill
    resolveMatterEnrichment(makeMatter(), MAPS, stats);

    expect(stats.departmentName).toBe(1);
    expect(stats.responsibleLawyerName).toBe(1);
    expect(stats.total).toBe(1); // only the first matter triggered enrichment
  });
});
