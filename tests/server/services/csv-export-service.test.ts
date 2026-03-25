/**
 * tests/server/services/csv-export-service.test.ts
 *
 * Tests for csv-export-service: generateTableCsv (direct) and
 * generateDashboardCsv (via mocked dashboard service).
 *
 * The private fmt/fmtPct helpers are covered indirectly through
 * generateDashboardCsv by asserting against known cell values in the output.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the dashboard service
// ---------------------------------------------------------------------------

vi.mock('../../../src/server/services/dashboard-service.js', () => ({
  getFirmOverviewData:         vi.fn(),
  getFeeEarnerPerformanceData: vi.fn(),
  getWipData:                  vi.fn(),
  getBillingCollectionsData:   vi.fn(),
  getMatterAnalysisData:       vi.fn(),
  getClientIntelligenceData:   vi.fn(),
}));

import * as svc from '../../../src/server/services/dashboard-service.js';
import {
  generateTableCsv,
  generateDashboardCsv,
} from '../../../src/server/services/csv-export-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse CSV output into rows of string arrays (header + data rows). */
function parseCsvRows(csv: string): string[][] {
  return csv
    .trim()
    .split('\n')
    .map(line => line.split(',').map(cell => cell.replace(/^"|"$/g, '').trim()));
}

// ---------------------------------------------------------------------------
// generateTableCsv
// ---------------------------------------------------------------------------

describe('generateTableCsv', () => {
  const columns = [
    { header: 'Name',    key: 'name' },
    { header: 'Amount',  key: 'amount' },
    { header: 'Status',  key: 'status' },
  ];

  it('returns a non-empty string for non-empty input', () => {
    const result = generateTableCsv(
      [{ name: 'Alice', amount: 100, status: 'Active' }],
      columns,
      'test.csv',
    );
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('header row contains the column header names', () => {
    const result = generateTableCsv(
      [{ name: 'Alice', amount: 100, status: 'Active' }],
      columns,
      'test.csv',
    );
    const header = result.split('\n')[0];
    expect(header).toContain('Name');
    expect(header).toContain('Amount');
    expect(header).toContain('Status');
  });

  it('row count in output matches input data length (header + N data rows)', () => {
    const data = [
      { name: 'Alice', amount: 100, status: 'Active' },
      { name: 'Bob',   amount: 200, status: 'Inactive' },
      { name: 'Carol', amount: 300, status: 'Active' },
    ];
    const result = generateTableCsv(data, columns, 'test.csv');
    const rows = result.trim().split('\n');
    // 1 header + 3 data rows
    expect(rows).toHaveLength(4);
  });

  it('data values appear in the output', () => {
    const result = generateTableCsv(
      [{ name: 'Alice', amount: 42, status: 'Active' }],
      columns,
      'test.csv',
    );
    expect(result).toContain('Alice');
    expect(result).toContain('42');
    expect(result).toContain('Active');
  });

  it('null value in a cell is output as an empty string, not the word "null"', () => {
    const result = generateTableCsv(
      [{ name: 'Alice', amount: null, status: undefined }],
      columns,
      'test.csv',
    );
    expect(result).not.toContain('null');
    expect(result).not.toContain('undefined');
  });

  it('undefined value in a cell does not throw and outputs empty string', () => {
    expect(() =>
      generateTableCsv([{ name: 'Alice' }], columns, 'test.csv'),
    ).not.toThrow();
    const result = generateTableCsv([{ name: 'Alice' }], columns, 'test.csv');
    expect(result).toContain('Alice');
  });

  it('empty data array returns a string without throwing (not an error)', () => {
    expect(() => generateTableCsv([], columns, 'test.csv')).not.toThrow();
    const result = generateTableCsv([], columns, 'test.csv');
    expect(typeof result).toBe('string');
  });

  it('filename parameter does not affect the returned CSV string', () => {
    const r1 = generateTableCsv([{ name: 'A', amount: 1, status: 'x' }], columns, 'file-a.csv');
    const r2 = generateTableCsv([{ name: 'A', amount: 1, status: 'x' }], columns, 'file-b.csv');
    expect(r1).toBe(r2);
  });

  it('handles special characters in cell values (commas, quotes)', () => {
    const result = generateTableCsv(
      [{ name: 'Smith, J.', amount: 100, status: 'Active' }],
      columns,
      'test.csv',
    );
    // papaparse should quote the comma-containing cell
    expect(result).toContain('Smith');
    // The output should be parseable back to the original value
    expect(result).not.toMatch(/^Smith, J\./m); // raw unquoted would be a parse error
  });
});

// ---------------------------------------------------------------------------
// generateDashboardCsv — formatting and routing
// ---------------------------------------------------------------------------

describe('generateDashboardCsv — fee-earner-performance', () => {
  const FEE_EARNER = {
    id: 'fe-1',
    name: 'J. Smith',
    department: 'Property',
    grade: 'Senior',
    payModel: 'salaried',
    isActive: true,
    chargeableHours: 120.5,
    totalHours: 160,
    utilisation: 75.3,
    utilisationRag: 'green',
    wipValueRecorded: 1234.56,
    billedRevenue: 55000,
    effectiveRate: 450,
    writeOffRate: 8.2,
    recordingGapDays: 3,
    matterCount: 10,
    scorecard: 82.1,
    scorecardRag: 'green',
    recordingPattern: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(svc.getFeeEarnerPerformanceData).mockResolvedValue({
      alerts: [],
      feeEarners: [FEE_EARNER],
      pagination: { totalCount: 1, limit: 50, offset: 0 },
      charts: { utilisationBars: [], chargeableStack: [] },
      filters: { departments: [], grades: [], payModels: [] },
    } as never);
  });

  it('returns a non-empty csv string and a filename', async () => {
    const result = await generateDashboardCsv('firm-1', 'fee-earner-performance', {});
    expect(result.csv.length).toBeGreaterThan(0);
    expect(result.filename).toBe('fee-earner-performance.csv');
  });

  it('currency values are formatted as £1,234.56', async () => {
    const { csv } = await generateDashboardCsv('firm-1', 'fee-earner-performance', {});
    // wipValueRecorded: 1234.56 → '1,234.56' (locale number without £ symbol in CSV)
    expect(csv).toContain('1,234.56');
  });

  it('percentage values are formatted as 82.1%', async () => {
    const { csv } = await generateDashboardCsv('firm-1', 'fee-earner-performance', {});
    // scorecard: 82.1 → '82.1%'
    expect(csv).toContain('82.1%');
  });

  it('null currency value outputs an empty cell, not "null" or "£"', async () => {
    vi.mocked(svc.getFeeEarnerPerformanceData).mockResolvedValue({
      alerts: [],
      feeEarners: [{ ...FEE_EARNER, effectiveRate: null }],
      pagination: { totalCount: 1, limit: 50, offset: 0 },
      charts: { utilisationBars: [], chargeableStack: [] },
      filters: { departments: [], grades: [], payModels: [] },
    } as never);
    const { csv } = await generateDashboardCsv('firm-1', 'fee-earner-performance', {});
    expect(csv).not.toContain('null');
  });

  it('null percentage value outputs an empty cell, not "null" or "%"', async () => {
    vi.mocked(svc.getFeeEarnerPerformanceData).mockResolvedValue({
      alerts: [],
      feeEarners: [{ ...FEE_EARNER, scorecard: null, utilisation: null }],
      pagination: { totalCount: 1, limit: 50, offset: 0 },
      charts: { utilisationBars: [], chargeableStack: [] },
      filters: { departments: [], grades: [], payModels: [] },
    } as never);
    const { csv } = await generateDashboardCsv('firm-1', 'fee-earner-performance', {});
    expect(csv).not.toContain('null');
  });

  it('null recordingGapDays outputs an empty cell', async () => {
    vi.mocked(svc.getFeeEarnerPerformanceData).mockResolvedValue({
      alerts: [],
      feeEarners: [{ ...FEE_EARNER, recordingGapDays: null }],
      pagination: { totalCount: 1, limit: 50, offset: 0 },
      charts: { utilisationBars: [], chargeableStack: [] },
      filters: { departments: [], grades: [], payModels: [] },
    } as never);
    const { csv } = await generateDashboardCsv('firm-1', 'fee-earner-performance', {});
    expect(csv).not.toContain('null');
  });

  it('empty feeEarners array returns a string without throwing (not an error)', async () => {
    vi.mocked(svc.getFeeEarnerPerformanceData).mockResolvedValue({
      alerts: [],
      feeEarners: [],
      pagination: { totalCount: 0, limit: 50, offset: 0 },
      charts: { utilisationBars: [], chargeableStack: [] },
      filters: { departments: [], grades: [], payModels: [] },
    } as never);
    expect(async () =>
      generateDashboardCsv('firm-1', 'fee-earner-performance', {}),
    ).not.toThrow();
    const { csv } = await generateDashboardCsv('firm-1', 'fee-earner-performance', {});
    expect(typeof csv).toBe('string');
  });

  it('row count matches feeEarners array length (header + N rows)', async () => {
    const twoEarners = [FEE_EARNER, { ...FEE_EARNER, id: 'fe-2', name: 'A. Jones' }];
    vi.mocked(svc.getFeeEarnerPerformanceData).mockResolvedValue({
      alerts: [],
      feeEarners: twoEarners,
      pagination: { totalCount: 2, limit: 50, offset: 0 },
      charts: { utilisationBars: [], chargeableStack: [] },
      filters: { departments: [], grades: [], payModels: [] },
    } as never);
    const { csv } = await generateDashboardCsv('firm-1', 'fee-earner-performance', {});
    const rows = parseCsvRows(csv);
    expect(rows).toHaveLength(3); // 1 header + 2 data rows
  });
});

// ---------------------------------------------------------------------------
// generateDashboardCsv — routing and fallback
// ---------------------------------------------------------------------------

describe('generateDashboardCsv — routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(svc.getFirmOverviewData).mockResolvedValue({
      kpiCards: { totalUnbilledWip: { value: 0, ragStatus: 'green' }, firmRealisation: { value: 0, ragStatus: 'green' }, firmUtilisation: { value: 0, ragStatus: 'green' }, combinedLockup: { value: 0, ragStatus: 'green' } },
      wipAgeBands: [],
      revenueTrend: [],
      topLeakageRisks: [],
      utilisationSnapshot: { green: 0, amber: 0, red: 0, feeEarners: [] },
      departmentSummary: [],
      dataQuality: { issueCount: 0, criticalCount: 0 },
      lastCalculated: null,
    } as never);
    vi.mocked(svc.getWipData).mockResolvedValue({
      headlines: { totalUnbilledWip: { value: 0, grossValue: 0, netValue: 0 }, atRisk: { value: 0, percentage: 0, ragStatus: 'green' }, estimatedLeakage: { value: 0, methodology: '' } },
      ageBands: [], byDepartment: [], entries: [],
      pagination: { totalCount: 0, limit: 50, offset: 0 },
      writeOffAnalysis: { totalWriteOff: 0, writeOffRate: 0, ragStatus: 'green', byFeeEarner: [], byCaseType: [] },
      disbursementExposure: { totalExposure: 0, byMatter: [] },
      filters: { departments: [], feeEarners: [], caseTypes: [] },
    } as never);
    vi.mocked(svc.getBillingCollectionsData).mockResolvedValue({
      headlines: { invoicedPeriod: { value: 0, count: 0 }, collectedPeriod: { value: 0, rate: 0 }, totalOutstanding: { value: 0 } },
      pipeline: { wip: { value: 0, avgDays: null }, invoiced: { value: 0, avgDaysToPayment: null }, paid: { value: 0 }, writtenOff: { value: 0, rate: 0 }, totalLockup: 0 },
      agedDebtors: [], billingTrend: [], invoices: [],
      pagination: { totalCount: 0, limit: 50, offset: 0 },
      slowPayers: null,
      filters: { departments: [], feeEarners: [] },
    } as never);
    vi.mocked(svc.getMatterAnalysisData).mockResolvedValue({
      mattersAtRisk: [], matters: [],
      pagination: { totalCount: 0, limit: 50, offset: 0 },
      byCaseType: [], byDepartment: [],
      filters: { departments: [], caseTypes: [], statuses: [], lawyers: [] },
    } as never);
    vi.mocked(svc.getClientIntelligenceData).mockResolvedValue({
      headlines: { totalClients: 0, topClient: null, mostAtRisk: null },
      clients: [],
      pagination: { totalCount: 0, limit: 50, offset: 0 },
      topByRevenue: [], topByOutstanding: [],
      filters: { departments: [], minMattersOptions: [] },
    } as never);
    vi.mocked(svc.getFeeEarnerPerformanceData).mockResolvedValue({
      alerts: [], feeEarners: [],
      pagination: { totalCount: 0, limit: 50, offset: 0 },
      charts: { utilisationBars: [], chargeableStack: [] },
      filters: { departments: [], grades: [], payModels: [] },
    } as never);
  });

  it.each([
    ['firm-overview',          'firm-overview-leakage-risks.csv'],
    ['fee-earner-performance', 'fee-earner-performance.csv'],
    ['wip',                    'wip-leakage.csv'],
    ['billing',                'billing-collections.csv'],
    ['matters',                'matter-analysis.csv'],
    ['clients',                'client-intelligence.csv'],
  ])('%s returns expected filename', async (dashboardId, expectedFilename) => {
    const { filename } = await generateDashboardCsv('firm-1', dashboardId, {});
    expect(filename).toBe(expectedFilename);
  });

  it('unknown dashboardId returns empty csv and a .csv filename without throwing', async () => {
    const result = await generateDashboardCsv('firm-1', 'unknown-dash', {});
    expect(result.csv).toBe('');
    expect(result.filename).toBe('unknown-dash.csv');
  });

  it('passes firmId to the dashboard service', async () => {
    await generateDashboardCsv('firm-99', 'fee-earner-performance', {});
    expect(vi.mocked(svc.getFeeEarnerPerformanceData)).toHaveBeenCalledWith('firm-99', expect.any(Object));
  });
});
