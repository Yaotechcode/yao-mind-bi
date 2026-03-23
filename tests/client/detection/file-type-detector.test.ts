import { describe, it, expect } from 'vitest';
import {
  detectFileType,
  FILE_TYPE_SIGNATURES,
} from '../../../src/client/detection/file-type-detector.js';
import {
  normaliseColumnName,
  COLUMN_NAME_ALIASES,
} from '../../../src/client/detection/column-normaliser.js';
import type { ParseResult } from '../../../src/client/parsers/types.js';

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

function makeParseResult(columnNames: string[], fileType: string): ParseResult {
  return {
    fileType,
    originalFilename: `test.${fileType}`,
    rowCount: 5,
    columns: columnNames.map(name => ({
      originalHeader: name,
      detectedType: 'string' as const,
      sampleValues: [],
      nullCount: 0,
      totalCount: 5,
      nullPercent: 0,
    })),
    previewRows: [],
    fullRows: [],
    parseErrors: [],
    parsedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// detectFileType
// ---------------------------------------------------------------------------

describe('detectFileType', () => {
  it('detects WIP JSON from all strong signal columns with high confidence', () => {
    const result = detectFileType(
      makeParseResult(
        ['billableValue', 'durationMinutes', 'matterId', 'lawyerId', 'doNotBill', 'writeOffValue'],
        'json'
      )
    );

    expect(result.detected).toBe('wipJson');
    expect(result.confidence).toBe('high');
    expect(result.scores['wipJson']).toBeGreaterThanOrEqual(60);
  });

  it('detects Fee Earner CSV from PayModel and salary columns with high confidence', () => {
    const result = detectFileType(
      makeParseResult(
        ['PayModel', 'AnnualSalary', 'FeeShare', 'ChargeOutRate', 'Department', 'Name'],
        'csv'
      )
    );

    expect(result.detected).toBe('feeEarnerCsv');
    expect(result.confidence).toBe('high');
    expect(result.scores['feeEarnerCsv']).toBeGreaterThanOrEqual(60);
  });

  it('returns null with confidence none for entirely unrecognised columns', () => {
    const result = detectFileType(
      makeParseResult(['fooColumn', 'barData', 'randomField'], 'json')
    );

    expect(result.detected).toBeNull();
    expect(result.confidence).toBe('none');
    expect(Object.values(result.scores).every(s => s === 0)).toBe(true);
  });

  it('scores both fullMatters and closedMatters > 0 for ambiguous shared columns, neither high', () => {
    // matterNumber + responsibleLawyer + status → strong for fullMatters
    // invoiceNetBilling → strong for closedMatters only
    // fullMatters should win (3 strong vs 2 strong) but with medium confidence only
    const result = detectFileType(
      makeParseResult(
        ['matterNumber', 'invoiceNetBilling', 'responsibleLawyer', 'status'],
        'json'
      )
    );

    expect(result.scores['fullMattersJson']).toBeGreaterThan(0);
    expect(result.scores['closedMattersJson']).toBeGreaterThan(0);
    expect(result.confidence).not.toBe('high');
    expect(result.scores['fullMattersJson']).toBeGreaterThan(result.scores['closedMattersJson']);
    // Alternative candidates should include closedMattersJson
    expect(result.alternativeCandidates.some(c => c.fileType === 'closedMattersJson')).toBe(true);
  });

  it('includes reasoning strings describing strong signal matches and format', () => {
    const result = detectFileType(
      makeParseResult(
        ['billableValue', 'durationMinutes', 'matterId', 'lawyerId', 'doNotBill'],
        'json'
      )
    );

    expect(result.reasoning.length).toBeGreaterThan(0);
    expect(result.reasoning.some(r => r.toLowerCase().includes('strong'))).toBe(true);
  });

  it('applies COLUMN_NAME_ALIASES — Billable resolves to billablevalue covering wipJson required', () => {
    // 'Billable' → normalise → 'billable' → alias → 'billablevalue'
    const result = detectFileType(
      makeParseResult(
        ['Billable', 'durationMinutes', 'matterId', 'lawyerId', 'doNotBill'],
        'json'
      )
    );

    expect(result.detected).toBe('wipJson');
    expect(result.confidence).toBe('high');
  });

  it('gives format bonus to csv type for csv file, not json types', () => {
    const csvResult = detectFileType(
      makeParseResult(
        ['PayModel', 'AnnualSalary', 'FeeShare', 'ChargeOutRate'],
        'csv'
      )
    );
    const jsonResult = detectFileType(
      makeParseResult(
        ['PayModel', 'AnnualSalary', 'FeeShare', 'ChargeOutRate'],
        'json'
      )
    );

    // csv file should score higher for feeEarnerCsv (csv format bonus applies)
    expect(csvResult.scores['feeEarnerCsv']).toBeGreaterThan(jsonResult.scores['feeEarnerCsv']);
  });

  it('returns zero for wipJson when a required column is missing', () => {
    // doNotBill is in wipJson required columns — omit it
    const result = detectFileType(
      makeParseResult(
        ['billableValue', 'durationMinutes', 'matterId', 'lawyerId'],
        'json'
      )
    );

    expect(result.scores['wipJson']).toBe(0);
  });

  it('exports FILE_TYPE_SIGNATURES with all 8 file types', () => {
    const keys = Object.keys(FILE_TYPE_SIGNATURES);
    expect(keys).toContain('feeEarnerCsv');
    expect(keys).toContain('wipJson');
    expect(keys).toContain('fullMattersJson');
    expect(keys).toContain('closedMattersJson');
    expect(keys).toContain('invoicesJson');
    expect(keys).toContain('contactsJson');
    expect(keys).toContain('disbursementsJson');
    expect(keys).toContain('tasksJson');
    expect(keys).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// normaliseColumnName
// ---------------------------------------------------------------------------

describe('normaliseColumnName', () => {
  it('lowercases and strips underscores, spaces, hyphens, dots', () => {
    expect(normaliseColumnName('Matter_Number')).toBe('matternumber');
    expect(normaliseColumnName('Billable Value')).toBe('billablevalue');
    expect(normaliseColumnName('do-not-bill')).toBe('donotbill');
    expect(normaliseColumnName('client.id')).toBe('clientid');
  });

  it('strips the "total" prefix', () => {
    expect(normaliseColumnName('Total_Billing')).toBe('billing');
    expect(normaliseColumnName('TotalDisbursements')).toBe('disbursements');
  });

  it('strips the "is" prefix', () => {
    expect(normaliseColumnName('is_active')).toBe('active');
    expect(normaliseColumnName('IsPartner')).toBe('partner');
  });

  it('strips the "responsible" prefix', () => {
    expect(normaliseColumnName('Responsible Lawyer')).toBe('lawyer');
    expect(normaliseColumnName('ResponsibleSupervisor')).toBe('supervisor');
  });

  it('strips the "has" prefix', () => {
    expect(normaliseColumnName('has_budget')).toBe('budget');
  });
});

// ---------------------------------------------------------------------------
// COLUMN_NAME_ALIASES
// ---------------------------------------------------------------------------

describe('COLUMN_NAME_ALIASES', () => {
  it('maps lawyer/fee earner alternative names to lawyerid', () => {
    expect(COLUMN_NAME_ALIASES['lawyername']).toBe('lawyerid');
    expect(COLUMN_NAME_ALIASES['feeearner']).toBe('lawyerid');
    expect(COLUMN_NAME_ALIASES['feeearnername']).toBe('lawyerid');
  });

  it('maps matter reference alternatives to matternumber', () => {
    expect(COLUMN_NAME_ALIASES['matterref']).toBe('matternumber');
  });

  it('maps financial field shorthand to canonical names', () => {
    expect(COLUMN_NAME_ALIASES['billable']).toBe('billablevalue');
    expect(COLUMN_NAME_ALIASES['writeoff']).toBe('writeoffvalue');
    expect(COLUMN_NAME_ALIASES['invoiceamount']).toBe('subtotal');
  });

  it('maps date field alternatives', () => {
    expect(COLUMN_NAME_ALIASES['entrydate']).toBe('date');
    expect(COLUMN_NAME_ALIASES['dateofentry']).toBe('date');
  });

  it('maps contact display name alternatives', () => {
    expect(COLUMN_NAME_ALIASES['clientname']).toBe('displayname');
    expect(COLUMN_NAME_ALIASES['fullname']).toBe('displayname');
  });
});
