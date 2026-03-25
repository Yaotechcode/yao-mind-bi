/**
 * tests/server/services/pdf-export-service.test.ts
 *
 * Tests for the server-side PDF + formatting helpers.
 * The dashboard service is fully mocked so these tests stay fast and isolated.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the dashboard service (all 6 functions)
// ---------------------------------------------------------------------------

vi.mock('../../../src/server/services/dashboard-service.js', () => ({
  getFirmOverviewData:        vi.fn(),
  getFeeEarnerPerformanceData: vi.fn(),
  getWipData:                 vi.fn(),
  getBillingCollectionsData:  vi.fn(),
  getMatterAnalysisData:      vi.fn(),
  getClientIntelligenceData:  vi.fn(),
}));

import * as svc from '../../../src/server/services/dashboard-service.js';
import {
  generateDashboardPdf,
  formatCurrency,
  formatPct,
  formatNum,
} from '../../../src/server/services/pdf-export-service.js';
import type { FirmConfig } from '../../../src/shared/types/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFirmConfig(overrides: Partial<FirmConfig> = {}): FirmConfig {
  return {
    firmId:             'firm-1',
    firmName:           'Test Law LLP',
    workingDaysPerWeek: 5,
    workingHoursPerDay: 7.5,
    targetUtilisation:  75,
    defaultPayModel:    'salaried',
    revenueAttributionMethod: 'responsible_lawyer',
    feeSharePercent:    0,
    costRateMethod:     'fixed',
    fixedCostRate:      50,
    overheadMultiplier: 1.2,
    scorecardWeights:   { utilisation: 0.4, realisation: 0.3, writeOff: 0.3 },
    ragThresholds:      [],
    ...overrides,
  } as unknown as FirmConfig;
}

const EMPTY_PAGINATION = { totalCount: 0, limit: 50, offset: 0 };

function makeFirmOverview() {
  return {
    kpiCards: {
      totalUnbilledWip:  { value: 120000, ragStatus: 'amber' },
      firmRealisation:   { value: 82,     ragStatus: 'green' },
      firmUtilisation:   { value: 70,     ragStatus: 'amber' },
      combinedLockup:    { value: 45,     ragStatus: 'amber' },
    },
    wipAgeBands: [
      { band: '0-30 days', value: 80000, count: 40, recoveryProb: 0.95 },
      { band: '31-60 days', value: 25000, count: 12, recoveryProb: 0.75 },
      { band: '61-90 days', value: 10000, count: 5, recoveryProb: 0.50 },
      { band: '91-120 days', value: 4000, count: 2, recoveryProb: 0.25 },
      { band: '120+ days', value: 1000, count: 1, recoveryProb: 0.10 },
    ],
    revenueTrend: [],
    topLeakageRisks: [
      { matterNumber: 'M-001', clientName: 'ACME Ltd', lawyerName: 'J. Smith', wipValue: 15000, wipAge: 95, riskScore: 8, ragStatus: 'red' },
    ],
    utilisationSnapshot: { green: 3, amber: 5, red: 2, feeEarners: [
      { name: 'J. Smith', utilisation: 80, ragStatus: 'green' },
    ]},
    departmentSummary: [
      { name: 'Property', wipValue: 60000, matterCount: 20, utilisation: 72 },
    ],
    dataQuality: { issueCount: 0, criticalCount: 0 },
    lastCalculated: null,
  };
}

function makeFeeEarnerData() {
  return {
    alerts: [{ name: 'J. Smith', type: 'gap', message: 'No time recorded for 5 days' }],
    feeEarners: [
      {
        name: 'J. Smith', department: 'Property', grade: 'Senior', payModel: 'salaried',
        chargeableHours: 120, utilisation: 75, wipValueRecorded: 60000, billedRevenue: 55000,
        effectiveRate: 450, writeOffRate: 8, recordingGapDays: 3, scorecard: 78, utilisationRag: 'green',
      },
    ],
    pagination: EMPTY_PAGINATION,
    charts: { utilisationBars: [], chargeableStack: [] },
    filters: { departments: [], grades: [], payModels: [] },
  };
}

function makeWipData() {
  return {
    headlines: {
      totalUnbilledWip: { value: 120000 },
      atRisk: { value: 15000, percentage: 12.5 },
      estimatedLeakage: { value: 5000 },
    },
    ageBands: [
      { band: '0-30 days', value: 80000, count: 40, recoveryProb: 0.95 },
    ],
    byDepartment: [],
    entries: [
      { groupLabel: 'J. Smith', totalValue: 60000, totalHours: 130, avgAge: 22, entryCount: 45 },
    ],
    pagination: EMPTY_PAGINATION,
    writeOffAnalysis: { totalWriteOff: 5000, writeOffRate: 8, ragStatus: 'amber' },
    disbursementExposure: { totalExposure: 2000, byMatter: [
      { matterNumber: 'M-001', clientName: 'ACME Ltd', value: 2000, age: 40 },
    ]},
    filters: { departments: [], feeEarners: [], caseTypes: [] },
  };
}

function makeBillingData() {
  return {
    headlines: {
      invoicedPeriod:   { value: 80000, count: 12 },
      collectedPeriod:  { value: 70000, rate: 87.5 },
      totalOutstanding: { value: 30000 },
    },
    pipeline: {
      wip:        { value: 120000 },
      invoiced:   { value: 30000, avgDaysToPayment: null },
      paid:       { value: 70000 },
      writtenOff: { value: 5000, rate: 6.25 },
      avgDays:    45,
    },
    agedDebtors: [
      { band: '0-30 days', value: 15000, count: 8 },
    ],
    billingTrend: [],
    invoices: [
      {
        invoiceNumber: 'INV-001', clientName: 'ACME Ltd', matterNumber: 'M-001',
        invoiceDate: '2026-01-15T00:00:00Z', dueDate: '2026-02-14T00:00:00Z',
        total: 5000, outstanding: 5000, daysOutstanding: 40, ragStatus: 'amber',
      },
    ],
    pagination: EMPTY_PAGINATION,
    slowPayers: null,
    filters: { departments: [], feeEarners: [] },
  };
}

function makeMatterData() {
  return {
    mattersAtRisk: [
      {
        matterNumber: 'M-001', clientName: 'ACME Ltd', caseType: 'Conveyancing',
        responsibleLawyer: 'J. Smith', primaryIssue: 'High WIP age', wipValue: 15000, wipAge: 95, ragStatus: 'red',
      },
    ],
    matters: [
      {
        matterNumber: 'M-001', clientName: 'ACME Ltd', caseType: 'Conveyancing', department: 'Property',
        responsibleLawyer: 'J. Smith', status: 'Active', wipTotalBillable: 15000, netBilling: 12000,
        unbilledBalance: 3000, outstanding: 2000, wipAge: 95, realisation: 80, realisationRag: 'amber',
        budget: 20000, isFixedFee: false,
      },
    ],
    pagination: EMPTY_PAGINATION,
    byCaseType: [
      { name: 'Conveyancing', count: 10, totalWip: 60000, avgRealisation: 82, avgWipAge: 35 },
    ],
    byDepartment: [],
    filters: { departments: [], caseTypes: [], statuses: [], lawyers: [] },
  };
}

function makeClientData() {
  return {
    headlines: {
      totalClients: 15,
      topClient: { name: 'ACME Ltd', revenue: 80000 },
      mostAtRisk: { name: 'Globex Corp', outstanding: 12000 },
    },
    clients: [
      { clientName: 'ACME Ltd', matterCount: 5, departments: ['Property', 'Commercial'], totalRevenue: 80000, totalOutstanding: 3000 },
    ],
    pagination: EMPTY_PAGINATION,
    topByRevenue: [{ name: 'ACME Ltd', value: 80000 }],
    topByOutstanding: [{ name: 'Globex Corp', value: 12000 }],
    filters: { departments: [], minMattersOptions: [] },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(svc.getFirmOverviewData).mockResolvedValue(makeFirmOverview() as never);
  vi.mocked(svc.getFeeEarnerPerformanceData).mockResolvedValue(makeFeeEarnerData() as never);
  vi.mocked(svc.getWipData).mockResolvedValue(makeWipData() as never);
  vi.mocked(svc.getBillingCollectionsData).mockResolvedValue(makeBillingData() as never);
  vi.mocked(svc.getMatterAnalysisData).mockResolvedValue(makeMatterData() as never);
  vi.mocked(svc.getClientIntelligenceData).mockResolvedValue(makeClientData() as never);
});

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

describe('formatCurrency', () => {
  it('formats a positive number as £1,234.56', () => {
    expect(formatCurrency(1234.56)).toBe('£1,234.56');
  });

  it('formats zero as £0.00', () => {
    expect(formatCurrency(0)).toBe('£0.00');
  });

  it('returns em-dash for null', () => {
    expect(formatCurrency(null)).toBe('—');
  });

  it('returns em-dash for undefined', () => {
    expect(formatCurrency(undefined)).toBe('—');
  });

  it('formats large numbers with thousand separators', () => {
    expect(formatCurrency(1200000)).toBe('£1,200,000.00');
  });
});

describe('formatPct', () => {
  it('formats 82.12 as 82.1%', () => {
    expect(formatPct(82.12)).toBe('82.1%');
  });

  it('formats 0 as 0.0%', () => {
    expect(formatPct(0)).toBe('0.0%');
  });

  it('returns em-dash for null', () => {
    expect(formatPct(null)).toBe('—');
  });

  it('returns em-dash for undefined', () => {
    expect(formatPct(undefined)).toBe('—');
  });
});

describe('formatNum', () => {
  it('formats 3.14159 to 1 decimal by default', () => {
    expect(formatNum(3.14159)).toBe('3.1');
  });

  it('respects custom decimal places', () => {
    expect(formatNum(3.14159, 2)).toBe('3.14');
  });

  it('returns em-dash for null', () => {
    expect(formatNum(null)).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// PDF generation — buffer validity
// ---------------------------------------------------------------------------

describe('generateDashboardPdf', () => {
  it('produces a non-empty Buffer for firm-overview', async () => {
    const buf = await generateDashboardPdf('firm-1', 'firm-overview', {}, makeFirmConfig());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('PDF starts with the PDF magic bytes %PDF', async () => {
    const buf = await generateDashboardPdf('firm-1', 'firm-overview', {}, makeFirmConfig());
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('produces a valid buffer for fee-earner-performance', async () => {
    const buf = await generateDashboardPdf('firm-1', 'fee-earner-performance', {}, makeFirmConfig());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('produces a valid buffer for wip', async () => {
    const buf = await generateDashboardPdf('firm-1', 'wip', {}, makeFirmConfig());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('produces a valid buffer for billing', async () => {
    const buf = await generateDashboardPdf('firm-1', 'billing', {}, makeFirmConfig());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('produces a valid buffer for matters', async () => {
    const buf = await generateDashboardPdf('firm-1', 'matters', {}, makeFirmConfig());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('produces a valid buffer for clients', async () => {
    const buf = await generateDashboardPdf('firm-1', 'clients', {}, makeFirmConfig());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('still produces a buffer for an unknown dashboardId', async () => {
    const buf = await generateDashboardPdf('firm-1', 'unknown-dash', {}, makeFirmConfig());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('passes firmId to the dashboard service', async () => {
    await generateDashboardPdf('firm-99', 'firm-overview', {}, makeFirmConfig({ firmId: 'firm-99', firmName: 'Other Firm' }));
    expect(vi.mocked(svc.getFirmOverviewData)).toHaveBeenCalledWith('firm-99');
  });

  it('uses firmName from config in the document (service called with correct firmId)', async () => {
    const config = makeFirmConfig({ firmId: 'firm-42', firmName: 'Test Law LLP' });
    await generateDashboardPdf('firm-42', 'fee-earner-performance', {}, config);
    expect(vi.mocked(svc.getFeeEarnerPerformanceData)).toHaveBeenCalledWith('firm-42', expect.any(Object));
  });

  it('passes filters through to service calls', async () => {
    await generateDashboardPdf('firm-1', 'fee-earner-performance', { department: 'Property', limit: 25 }, makeFirmConfig());
    expect(vi.mocked(svc.getFeeEarnerPerformanceData)).toHaveBeenCalledWith(
      'firm-1',
      expect.objectContaining({ department: 'Property', limit: 25 }),
    );
  });

  it('handles empty leakage risks array without throwing', async () => {
    vi.mocked(svc.getFirmOverviewData).mockResolvedValue({
      ...makeFirmOverview(),
      topLeakageRisks: [],
      departmentSummary: [],
    } as never);
    const buf = await generateDashboardPdf('firm-1', 'firm-overview', {}, makeFirmConfig());
    expect(buf.length).toBeGreaterThan(0);
  });

  it('handles empty invoice list for billing without throwing', async () => {
    vi.mocked(svc.getBillingCollectionsData).mockResolvedValue({
      ...makeBillingData(),
      invoices: [],
    } as never);
    const buf = await generateDashboardPdf('firm-1', 'billing', {}, makeFirmConfig());
    expect(buf.length).toBeGreaterThan(0);
  });

  it('handles empty mattersAtRisk for matters without throwing', async () => {
    vi.mocked(svc.getMatterAnalysisData).mockResolvedValue({
      ...makeMatterData(),
      mattersAtRisk: [],
    } as never);
    const buf = await generateDashboardPdf('firm-1', 'matters', {}, makeFirmConfig());
    expect(buf.length).toBeGreaterThan(0);
  });

  it('handles null topClient and mostAtRisk for clients without throwing', async () => {
    vi.mocked(svc.getClientIntelligenceData).mockResolvedValue({
      ...makeClientData(),
      headlines: { totalClients: 0, topClient: null, mostAtRisk: null },
    } as never);
    const buf = await generateDashboardPdf('firm-1', 'clients', {}, makeFirmConfig());
    expect(buf.length).toBeGreaterThan(0);
  });
});
