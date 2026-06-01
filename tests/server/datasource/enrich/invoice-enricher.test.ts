import { describe, it, expect } from 'vitest';

import {
  deriveInvoiceDatePaid,
  enrichInvoicesWithDatePaid,
  aggregateInvoicesByMatter,
  aggregateInvoicesByFeeEarner,
} from '../../../../src/server/datasource/enrich/invoice-enricher.js';

import type {
  NormalisedInvoice,
  NormalisedTimeEntry,
} from '../../../../src/server/datasource/normalise/types.js';
import type { YaoLedger } from '../../../../src/server/datasource/types.js';

// =============================================================================
// Fixture builders
// =============================================================================

function makeInvoice(o: Partial<NormalisedInvoice> = {}): NormalisedInvoice {
  return {
    _id: 'inv-1',
    invoiceNumber: 1001,
    invoiceDate: '2024-03-01',
    dueDate: '2024-03-31',
    subtotal: 1000,
    billingAmount: 0,
    billableEntries: 0,
    feeEarnerRevenue: 0,
    totalDisbursements: 0,
    totalOtherFees: 0,
    totalFirmFees: 1000,
    timeEntriesOverrideValue: 0,
    timeEntryIds: [],
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
    responsibleLawyerName: 'Alice Smith',
    matterId: 'matter-1',
    matterNumber: 1001,
    primaryClientId: 'client-1',
    primaryClientName: 'Acme Ltd',
    clientIds: ['client-1'],
    clientNames: ['Acme Ltd'],
    datePaid: null,
    narrative: null,
    reference: null,
    integrationId: null,
    createdAt: '2024-03-01T00:00:00Z',
    updatedAt: '2024-03-01T00:00:00Z',
    ...o,
  };
}

function makeLedger(o: Partial<YaoLedger> = {}): YaoLedger {
  return {
    _id: 'led-1',
    type: 'CLIENT_TO_OFFICE',
    value: 1000,
    vat: 0,
    outstanding: 0,
    date: '2024-03-15',
    invoice: 'inv-1',
    ...o,
  };
}

function makeTimeEntry(o: Partial<NormalisedTimeEntry> = {}): NormalisedTimeEntry {
  return {
    _id: 'te-1',
    description: '',
    activityType: null,
    durationHours: 1,
    isChargeable: true,
    doNotBill: false,
    rate: 0,
    clientRate: null,
    units: 10,
    billable: 1000,
    writeOff: 0,
    recordedValue: 1000,
    status: 'ACTIVE',
    entryStatus: 'ACTIVE',
    lawyerId: 'att-1',
    lawyerName: 'Alice Smith',
    lawyerDefaultRate: null,
    lawyerStatus: null,
    lawyerIntegrationId: null,
    matterId: 'matter-1',
    matterNumber: 1001,
    invoiceId: 'inv-1',
    date: '2024-03-01',
    createdAt: '',
    updatedAt: '',
    ...o,
  };
}

// =============================================================================
// deriveInvoiceDatePaid
// =============================================================================

describe('deriveInvoiceDatePaid()', () => {
  it('returns the ledger date when a matching payment exists', () => {
    const invoice = makeInvoice({ _id: 'inv-1' });
    const payments = [makeLedger({ invoice: 'inv-1', date: '2024-03-15' })];
    expect(deriveInvoiceDatePaid(invoice, payments)).toBe('2024-03-15');
  });

  it('returns null when no matching ledger exists', () => {
    const invoice = makeInvoice({ _id: 'inv-1' });
    const payments = [makeLedger({ invoice: 'inv-2', date: '2024-03-15' })];
    expect(deriveInvoiceDatePaid(invoice, payments)).toBeNull();
  });

  it('returns null for empty payments array', () => {
    const invoice = makeInvoice({ _id: 'inv-1' });
    expect(deriveInvoiceDatePaid(invoice, [])).toBeNull();
  });

  it('excludes REVERSED ledger records', () => {
    const invoice = makeInvoice({ _id: 'inv-1' });
    const payments = [
      makeLedger({ invoice: 'inv-1', status: 'REVERSED', date: '2024-03-10' }),
    ];
    expect(deriveInvoiceDatePaid(invoice, payments)).toBeNull();
  });

  it('returns non-reversed date when mix of REVERSED and ACTIVE exist', () => {
    const invoice = makeInvoice({ _id: 'inv-1' });
    const payments = [
      makeLedger({ invoice: 'inv-1', status: 'REVERSED', date: '2024-03-10' }),
      makeLedger({ _id: 'led-2', invoice: 'inv-1', status: 'ACTIVE', date: '2024-03-20', outstanding: 0 }),
    ];
    expect(deriveInvoiceDatePaid(invoice, payments)).toBe('2024-03-20');
  });

  it('prefers the record with outstanding === 0 when multiple matches exist', () => {
    const invoice = makeInvoice({ _id: 'inv-1' });
    const payments = [
      makeLedger({ _id: 'led-1', invoice: 'inv-1', date: '2024-03-10', outstanding: 500 }),
      makeLedger({ _id: 'led-2', invoice: 'inv-1', date: '2024-03-20', outstanding: 0 }),
    ];
    expect(deriveInvoiceDatePaid(invoice, payments)).toBe('2024-03-20');
  });

  it('falls back to latest date when no record has outstanding === 0', () => {
    const invoice = makeInvoice({ _id: 'inv-1' });
    const payments = [
      makeLedger({ _id: 'led-1', invoice: 'inv-1', date: '2024-03-05', outstanding: 700 }),
      makeLedger({ _id: 'led-2', invoice: 'inv-1', date: '2024-03-18', outstanding: 200 }),
      makeLedger({ _id: 'led-3', invoice: 'inv-1', date: '2024-03-10', outstanding: 400 }),
    ];
    expect(deriveInvoiceDatePaid(invoice, payments)).toBe('2024-03-18');
  });

  it('does not match on a different invoice _id', () => {
    const invoice = makeInvoice({ _id: 'inv-99' });
    const payments = [makeLedger({ invoice: 'inv-1' })];
    expect(deriveInvoiceDatePaid(invoice, payments)).toBeNull();
  });
});

// =============================================================================
// enrichInvoicesWithDatePaid
// =============================================================================

describe('enrichInvoicesWithDatePaid()', () => {
  it('populates datePaid where a matching payment exists', () => {
    const invoices = [makeInvoice({ _id: 'inv-1', datePaid: null })];
    const payments = [makeLedger({ invoice: 'inv-1', date: '2024-03-15', outstanding: 0 })];
    const result = enrichInvoicesWithDatePaid(invoices, payments);
    expect(result[0].datePaid).toBe('2024-03-15');
  });

  it('leaves datePaid null when no matching payment', () => {
    const invoices = [makeInvoice({ _id: 'inv-1', datePaid: null })];
    const result = enrichInvoicesWithDatePaid(invoices, []);
    expect(result[0].datePaid).toBeNull();
  });

  it('does not overwrite an already-set datePaid', () => {
    const invoices = [makeInvoice({ _id: 'inv-1', datePaid: '2024-01-01' })];
    const payments = [makeLedger({ invoice: 'inv-1', date: '2024-03-15', outstanding: 0 })];
    const result = enrichInvoicesWithDatePaid(invoices, payments);
    expect(result[0].datePaid).toBe('2024-01-01');
  });

  it('returns a new array and does not mutate input', () => {
    const invoices = [makeInvoice({ _id: 'inv-1', datePaid: null })];
    const payments = [makeLedger({ invoice: 'inv-1', date: '2024-03-15', outstanding: 0 })];
    const result = enrichInvoicesWithDatePaid(invoices, payments);
    expect(result).not.toBe(invoices);
    expect(invoices[0].datePaid).toBeNull(); // original unchanged
  });

  it('handles multiple invoices, resolving each independently', () => {
    const invoices = [
      makeInvoice({ _id: 'inv-1', datePaid: null }),
      makeInvoice({ _id: 'inv-2', datePaid: null }),
      makeInvoice({ _id: 'inv-3', datePaid: null }),
    ];
    const payments = [
      makeLedger({ invoice: 'inv-1', date: '2024-03-10', outstanding: 0 }),
      makeLedger({ _id: 'led-2', invoice: 'inv-3', date: '2024-03-20', outstanding: 0 }),
    ];
    const result = enrichInvoicesWithDatePaid(invoices, payments);
    expect(result[0].datePaid).toBe('2024-03-10');
    expect(result[1].datePaid).toBeNull();
    expect(result[2].datePaid).toBe('2024-03-20');
  });

  it('handles empty invoices array', () => {
    expect(enrichInvoicesWithDatePaid([], [])).toEqual([]);
  });
});

// =============================================================================
// aggregateInvoicesByMatter
// =============================================================================

describe('aggregateInvoicesByMatter()', () => {
  it('groups invoices by matterId', () => {
    const invoices = [
      makeInvoice({ _id: 'inv-1', matterId: 'matter-1', status: 'PAID' }),
      makeInvoice({ _id: 'inv-2', matterId: 'matter-2', status: 'ISSUED' }),
      makeInvoice({ _id: 'inv-3', matterId: 'matter-1', status: 'PAID' }),
    ];
    const result = aggregateInvoicesByMatter(invoices);
    expect(result.size).toBe(2);
    expect(result.get('matter-1')?.invoiceCount).toBe(2);
    expect(result.get('matter-2')?.invoiceCount).toBe(1);
  });

  it('excludes DRAFT invoices', () => {
    const invoices = [
      makeInvoice({ matterId: 'matter-1', status: 'PAID' }),
      makeInvoice({ _id: 'inv-2', matterId: 'matter-1', status: 'DRAFT' }),
    ];
    const result = aggregateInvoicesByMatter(invoices);
    expect(result.get('matter-1')?.invoiceCount).toBe(1);
  });

  it('excludes CANCELED invoices', () => {
    const invoices = [
      makeInvoice({ matterId: 'matter-1', status: 'ISSUED' }),
      makeInvoice({ _id: 'inv-2', matterId: 'matter-1', status: 'CANCELED' }),
    ];
    const result = aggregateInvoicesByMatter(invoices);
    expect(result.get('matter-1')?.invoiceCount).toBe(1);
  });

  it('excludes ERROR invoices', () => {
    const invoices = [
      makeInvoice({ matterId: 'matter-1', status: 'ERROR' }),
    ];
    const result = aggregateInvoicesByMatter(invoices);
    expect(result.size).toBe(0);
  });

  it('includes ISSUED, PAID, CREDITED invoices', () => {
    const invoices = [
      makeInvoice({ _id: 'inv-1', matterId: 'matter-1', status: 'ISSUED' }),
      makeInvoice({ _id: 'inv-2', matterId: 'matter-1', status: 'PAID' }),
      makeInvoice({ _id: 'inv-3', matterId: 'matter-1', status: 'CREDITED' }),
    ];
    const result = aggregateInvoicesByMatter(invoices);
    expect(result.get('matter-1')?.invoiceCount).toBe(3);
  });

  it('sums financial fields correctly across multiple invoices', () => {
    const invoices = [
      makeInvoice({
        _id: 'inv-1', matterId: 'matter-1', status: 'PAID',
        total: 1000, outstanding: 0, paid: 1000, writtenOff: 0,
      }),
      makeInvoice({
        _id: 'inv-2', matterId: 'matter-1', status: 'ISSUED',
        total: 500, outstanding: 300, paid: 200, writtenOff: 50,
      }),
    ];
    const result = aggregateInvoicesByMatter(invoices);
    const summary = result.get('matter-1')!;
    expect(summary.invoicedNetBilling).toBe(1500);
    expect(summary.invoicedOutstanding).toBe(300);
    expect(summary.invoicedPaid).toBe(1200);
    expect(summary.invoicedWrittenOff).toBe(50);
  });

  it('tracks latestInvoiceDate', () => {
    const invoices = [
      makeInvoice({ _id: 'inv-1', matterId: 'matter-1', status: 'PAID', invoiceDate: '2024-01-15' }),
      makeInvoice({ _id: 'inv-2', matterId: 'matter-1', status: 'PAID', invoiceDate: '2024-03-20' }),
      makeInvoice({ _id: 'inv-3', matterId: 'matter-1', status: 'PAID', invoiceDate: '2024-02-10' }),
    ];
    const result = aggregateInvoicesByMatter(invoices);
    expect(result.get('matter-1')?.latestInvoiceDate).toBe('2024-03-20');
  });

  it('excludes invoices with no matterId', () => {
    const invoices = [
      makeInvoice({ matterId: 'matter-1', status: 'PAID' }),
      makeInvoice({ _id: 'inv-2', matterId: null, status: 'PAID' }),
    ];
    const result = aggregateInvoicesByMatter(invoices);
    expect(result.size).toBe(1);
  });

  it('returns empty map for empty input', () => {
    expect(aggregateInvoicesByMatter([])).toEqual(new Map());
  });
});

// =============================================================================
// aggregateInvoicesByFeeEarner
// =============================================================================

describe('aggregateInvoicesByFeeEarner()', () => {
  it('groups invoices by responsibleLawyerId (Branch 3 fixed/other fees)', () => {
    const invoices = [
      makeInvoice({ _id: 'inv-1', responsibleLawyerId: 'att-1', status: 'PAID', billingAmount: 1000 }),
      makeInvoice({ _id: 'inv-2', responsibleLawyerId: 'att-2', status: 'ISSUED', billingAmount: 500 }),
      makeInvoice({ _id: 'inv-3', responsibleLawyerId: 'att-1', status: 'PAID', billingAmount: 250 }),
    ];
    const result = aggregateInvoicesByFeeEarner(invoices, []);
    expect(result.size).toBe(2);
    expect(result.get('att-1')?.invoiceCount).toBe(2);
    expect(result.get('att-2')?.invoiceCount).toBe(1);
  });

  it('sums invoice-level financials (outstanding, paid) per fee earner', () => {
    const invoices = [
      makeInvoice({ _id: 'inv-1', responsibleLawyerId: 'att-1', status: 'PAID', outstanding: 0, paid: 800 }),
      makeInvoice({ _id: 'inv-2', responsibleLawyerId: 'att-1', status: 'ISSUED', outstanding: 400, paid: 200 }),
    ];
    const result = aggregateInvoicesByFeeEarner(invoices, []);
    const summary = result.get('att-1')!;
    expect(summary.invoicedOutstanding).toBe(400);
    expect(summary.invoicedPaid).toBe(1000);
  });

  it('excludes DRAFT invoices', () => {
    const invoices = [
      makeInvoice({ responsibleLawyerId: 'att-1', status: 'DRAFT', billingAmount: 1000 }),
    ];
    const result = aggregateInvoicesByFeeEarner(invoices, []);
    expect(result.size).toBe(0);
  });

  it('excludes invoices with no responsibleLawyerId from invoice-level branches', () => {
    const invoices = [
      makeInvoice({ responsibleLawyerId: null, status: 'PAID', billingAmount: 1000 }),
    ];
    const result = aggregateInvoicesByFeeEarner(invoices, []);
    expect(result.size).toBe(0);
  });

  it('returns empty map for empty input', () => {
    expect(aggregateInvoicesByFeeEarner([], [])).toEqual(new Map());
  });

  // --- Branch 1: time entry billable values, attributed to the assignee ---

  it('attributes time entry billable to the assignee, NOT the responsible solicitor', () => {
    // Invoice responsible = att-1, but att-2 did £6,000 of the work.
    const invoices = [
      makeInvoice({ _id: 'inv-1', responsibleLawyerId: 'att-1', status: 'ISSUED', billingAmount: 0 }),
    ];
    const timeEntries = [
      makeTimeEntry({ _id: 'te-1', invoiceId: 'inv-1', lawyerId: 'att-2', billable: 6000 }),
    ];
    const result = aggregateInvoicesByFeeEarner(invoices, timeEntries);
    expect(result.get('att-2')?.invoicedFromTimeEntries).toBe(6000);
    expect(result.get('att-1')?.invoicedFromTimeEntries ?? 0).toBe(0);
  });

  it('ignores time entries that are not yet invoiced (invoiceId null)', () => {
    const invoices = [makeInvoice({ _id: 'inv-1', responsibleLawyerId: 'att-1', status: 'ISSUED', billingAmount: 0 })];
    const timeEntries = [makeTimeEntry({ _id: 'te-1', invoiceId: null, lawyerId: 'att-2', billable: 6000 })];
    const result = aggregateInvoicesByFeeEarner(invoices, timeEntries);
    expect(result.get('att-2')?.invoicedFromTimeEntries ?? 0).toBe(0);
  });

  it('ignores time entries whose invoice is not in a billable status', () => {
    const invoices = [makeInvoice({ _id: 'inv-1', responsibleLawyerId: 'att-1', status: 'DRAFT', billingAmount: 0 })];
    const timeEntries = [makeTimeEntry({ _id: 'te-1', invoiceId: 'inv-1', lawyerId: 'att-2', billable: 6000 })];
    const result = aggregateInvoicesByFeeEarner(invoices, timeEntries);
    expect(result.size).toBe(0);
  });

  it('does not subtract write_off from billable (no double-counting)', () => {
    const invoices = [makeInvoice({ _id: 'inv-1', responsibleLawyerId: 'att-1', status: 'ISSUED', billingAmount: 0 })];
    const timeEntries = [makeTimeEntry({ _id: 'te-1', invoiceId: 'inv-1', lawyerId: 'att-2', billable: 4000, writeOff: 1000 })];
    const result = aggregateInvoicesByFeeEarner(invoices, timeEntries);
    expect(result.get('att-2')?.invoicedFromTimeEntries).toBe(4000);
  });

  // --- Branch 3: fixed fees and other fee lines, attributed to the solicitor ---

  it('attributes a fixed-fee invoice (no time entries) to the solicitor', () => {
    const invoices = [
      makeInvoice({ _id: 'inv-1', responsibleLawyerId: 'att-1', status: 'ISSUED', billingAmount: 5000, billableEntries: 0 }),
    ];
    const result = aggregateInvoicesByFeeEarner(invoices, []);
    expect(result.get('att-1')?.invoicedFixedAndOtherFees).toBe(5000);
    expect(result.get('att-1')?.invoicedNetBilling).toBe(5000);
  });

  it('includes total_other_fees in Branch 3', () => {
    const invoices = [
      makeInvoice({ _id: 'inv-1', responsibleLawyerId: 'att-1', status: 'PAID', billingAmount: 1000, totalOtherFees: 250 }),
    ];
    const result = aggregateInvoicesByFeeEarner(invoices, []);
    expect(result.get('att-1')?.invoicedFixedAndOtherFees).toBe(1250);
  });

  // --- Branch 2: override uplift, attributed to the solicitor ---

  it('attributes override uplift above the sum of entry values to the solicitor', () => {
    // billable_entries (£) overridden to 10000; entries sum to 6000 → uplift 4000.
    const invoices = [
      makeInvoice({
        _id: 'inv-1', responsibleLawyerId: 'att-1', status: 'ISSUED', billingAmount: 0,
        timeEntriesOverrideValue: 10000, billableEntries: 10000, timeEntryIds: ['te-1', 'te-2'],
      }),
    ];
    const timeEntries = [
      makeTimeEntry({ _id: 'te-1', invoiceId: 'inv-1', lawyerId: 'att-2', billable: 4000 }),
      makeTimeEntry({ _id: 'te-2', invoiceId: 'inv-1', lawyerId: 'att-3', billable: 2000 }),
    ];
    const result = aggregateInvoicesByFeeEarner(invoices, timeEntries);
    expect(result.get('att-1')?.invoicedOverrideUplift).toBe(4000);
    // Branch 1 still attributes the underlying entries to their assignees.
    expect(result.get('att-2')?.invoicedFromTimeEntries).toBe(4000);
    expect(result.get('att-3')?.invoicedFromTimeEntries).toBe(2000);
  });

  it('floors override uplift at 0 (downward overrides ignored)', () => {
    const invoices = [
      makeInvoice({
        _id: 'inv-1', responsibleLawyerId: 'att-1', status: 'ISSUED', billingAmount: 0,
        timeEntriesOverrideValue: 5000, billableEntries: 5000, timeEntryIds: ['te-1'],
      }),
    ];
    const timeEntries = [makeTimeEntry({ _id: 'te-1', invoiceId: 'inv-1', lawyerId: 'att-2', billable: 8000 })];
    const result = aggregateInvoicesByFeeEarner(invoices, timeEntries);
    expect(result.get('att-1')?.invoicedOverrideUplift).toBe(0);
  });

  // --- WRITTEN_OFF inclusion ---

  it('includes WRITTEN_OFF invoices in attribution', () => {
    const invoices = [
      makeInvoice({ _id: 'inv-1', responsibleLawyerId: 'att-1', status: 'WRITTEN_OFF', billingAmount: 3000 }),
    ];
    const timeEntries = [makeTimeEntry({ _id: 'te-1', invoiceId: 'inv-1', lawyerId: 'att-2', billable: 1500 })];
    const result = aggregateInvoicesByFeeEarner(invoices, timeEntries);
    expect(result.get('att-1')?.invoicedFixedAndOtherFees).toBe(3000);
    expect(result.get('att-2')?.invoicedFromTimeEntries).toBe(1500);
  });

  // --- invoicedNetBilling = sum of the three branches ---

  it('invoicedNetBilling equals the sum of the three component fields', () => {
    const invoices = [
      makeInvoice({
        _id: 'inv-1', responsibleLawyerId: 'att-1', status: 'ISSUED',
        billingAmount: 2000, totalOtherFees: 500,
        timeEntriesOverrideValue: 12000, billableEntries: 12000, timeEntryIds: ['te-1'],
      }),
    ];
    const timeEntries = [makeTimeEntry({ _id: 'te-1', invoiceId: 'inv-1', lawyerId: 'att-1', billable: 9000 })];
    const result = aggregateInvoicesByFeeEarner(invoices, timeEntries);
    const s = result.get('att-1')!;
    // Branch 1 = 9000, Branch 2 = max(0, 12000-9000) = 3000, Branch 3 = 2500
    expect(s.invoicedNetBilling).toBe(
      s.invoicedFromTimeEntries + s.invoicedOverrideUplift + s.invoicedFixedAndOtherFees,
    );
    expect(s.invoicedFromTimeEntries).toBe(9000);
    expect(s.invoicedOverrideUplift).toBe(3000);
    expect(s.invoicedFixedAndOtherFees).toBe(2500);
    expect(s.invoicedNetBilling).toBe(14500);
  });
});
