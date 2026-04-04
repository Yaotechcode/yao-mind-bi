import { describe, it, expect } from 'vitest';

import {
  deriveInvoiceDatePaid,
  enrichInvoicesWithDatePaid,
  aggregateInvoicesByMatter,
  aggregateInvoicesByFeeEarner,
} from '../../../../src/server/datasource/enrich/invoice-enricher.js';

import type { NormalisedInvoice } from '../../../../src/server/datasource/normalise/types.js';
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
    vat_percentage: 0,
    subtotal: 1000,
    outstanding: 0,
    paid: 1000,
    status: 'ACTIVE',
    date: '2024-03-15',
    law_firm: 'firm-1',
    invoice: 'inv-1',
    created_at: '2024-03-15T00:00:00Z',
    updated_at: '2024-03-15T00:00:00Z',
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
  it('groups invoices by responsibleLawyerId', () => {
    const invoices = [
      makeInvoice({ _id: 'inv-1', responsibleLawyerId: 'att-1', status: 'PAID' }),
      makeInvoice({ _id: 'inv-2', responsibleLawyerId: 'att-2', status: 'ISSUED' }),
      makeInvoice({ _id: 'inv-3', responsibleLawyerId: 'att-1', status: 'PAID' }),
    ];
    const result = aggregateInvoicesByFeeEarner(invoices);
    expect(result.size).toBe(2);
    expect(result.get('att-1')?.invoiceCount).toBe(2);
    expect(result.get('att-2')?.invoiceCount).toBe(1);
  });

  it('sums financial fields per fee earner', () => {
    const invoices = [
      makeInvoice({ _id: 'inv-1', responsibleLawyerId: 'att-1', status: 'PAID', total: 800, outstanding: 0, paid: 800 }),
      makeInvoice({ _id: 'inv-2', responsibleLawyerId: 'att-1', status: 'ISSUED', total: 600, outstanding: 400, paid: 200 }),
    ];
    const result = aggregateInvoicesByFeeEarner(invoices);
    const summary = result.get('att-1')!;
    expect(summary.invoicedNetBilling).toBe(1400);
    expect(summary.invoicedOutstanding).toBe(400);
    expect(summary.invoicedPaid).toBe(1000);
  });

  it('excludes DRAFT invoices', () => {
    const invoices = [
      makeInvoice({ responsibleLawyerId: 'att-1', status: 'DRAFT' }),
    ];
    const result = aggregateInvoicesByFeeEarner(invoices);
    expect(result.size).toBe(0);
  });

  it('excludes invoices with no responsibleLawyerId', () => {
    const invoices = [
      makeInvoice({ responsibleLawyerId: null, status: 'PAID' }),
    ];
    const result = aggregateInvoicesByFeeEarner(invoices);
    expect(result.size).toBe(0);
  });

  it('returns empty map for empty input', () => {
    expect(aggregateInvoicesByFeeEarner([])).toEqual(new Map());
  });
});
