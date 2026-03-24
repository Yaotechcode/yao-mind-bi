import { describe, it, expect } from 'vitest';
import { enrichRecords } from '../../../src/server/pipeline/enricher.js';
import type { JoinResult, JoinStats } from '../../../src/shared/types/pipeline.js';
import type { EnrichedTimeEntry, EnrichedMatter, EnrichedDepartment } from '../../../src/shared/types/enriched.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmptyJoinStats(): JoinStats {
  return {
    timeEntries: { total: 0, matched: 0, orphaned: 0, orphanedValue: 0, lawyerResolved: 0, lawyerUnresolved: 0 },
    matters: { total: 0, closedMattersMerged: 0, clientResolved: 0, clientUnresolved: 0 },
    invoices: { total: 0, matterResolved: 0, matterUnresolved: 0 },
    disbursements: { total: 0, matterResolved: 0, matterUnresolved: 0 },
  };
}

function makeJoinResult(overrides: Partial<JoinResult> = {}): JoinResult {
  return {
    timeEntries: [], matters: [], feeEarners: [], invoices: [],
    clients: [], disbursements: [], tasks: [], departments: [],
    joinStats: makeEmptyJoinStats(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Time entry derived fields
// ---------------------------------------------------------------------------

describe('enrichRecords — time entry derived fields', () => {
  it('derives durationHours from durationMinutes (4 decimal places)', () => {
    const today = new Date('2024-06-01');
    const entry: EnrichedTimeEntry = {
      _sourceRowIndex: 0, hasMatchedMatter: true, _lawyerResolved: true,
      durationMinutes: 90, billableValue: 450, doNotBill: false,
    };
    const joinResult = makeJoinResult({ timeEntries: [entry] });

    const result = enrichRecords(joinResult, today);

    expect(result.timeEntries[0].durationHours).toBeCloseTo(1.5, 4);
  });

  it('sets isChargeable: true when billableValue > 0 and doNotBill is false', () => {
    const today = new Date('2024-06-01');
    const entry: EnrichedTimeEntry = {
      _sourceRowIndex: 0, hasMatchedMatter: true, _lawyerResolved: true,
      durationMinutes: 60, billableValue: 500, doNotBill: false,
    };
    const joinResult = makeJoinResult({ timeEntries: [entry] });
    const result = enrichRecords(joinResult, today);
    expect(result.timeEntries[0].isChargeable).toBe(true);
  });

  it('sets isChargeable: false when doNotBill is true', () => {
    const today = new Date('2024-06-01');
    const entry: EnrichedTimeEntry = {
      _sourceRowIndex: 0, hasMatchedMatter: true, _lawyerResolved: true,
      durationMinutes: 60, billableValue: 500, doNotBill: true,
    };
    const joinResult = makeJoinResult({ timeEntries: [entry] });
    const result = enrichRecords(joinResult, today);
    expect(result.timeEntries[0].isChargeable).toBe(false);
  });

  it('derives recordedValue from rate × durationHours', () => {
    const today = new Date('2024-06-01');
    const entry: EnrichedTimeEntry = {
      _sourceRowIndex: 0, hasMatchedMatter: true, _lawyerResolved: true,
      durationMinutes: 120, rate: 300, billableValue: 600, doNotBill: false,
    };
    const joinResult = makeJoinResult({ timeEntries: [entry] });
    const result = enrichRecords(joinResult, today);
    expect(result.timeEntries[0].recordedValue).toBeCloseTo(600);
  });

  it('derives ageInDays from entry date to today', () => {
    const today = new Date('2024-06-01');
    const entry: EnrichedTimeEntry = {
      _sourceRowIndex: 0, hasMatchedMatter: true, _lawyerResolved: true,
      date: new Date('2024-05-25'), durationMinutes: 60, billableValue: 100, doNotBill: false,
    };
    const joinResult = makeJoinResult({ timeEntries: [entry] });
    const result = enrichRecords(joinResult, today);
    expect(result.timeEntries[0].ageInDays).toBe(7);
  });

  it('derives monthKey as YYYY-MM string', () => {
    const today = new Date('2024-06-01');
    const entry: EnrichedTimeEntry = {
      _sourceRowIndex: 0, hasMatchedMatter: true, _lawyerResolved: true,
      date: new Date('2024-03-15'), durationMinutes: 60, billableValue: 100, doNotBill: false,
    };
    const joinResult = makeJoinResult({ timeEntries: [entry] });
    const result = enrichRecords(joinResult, today);
    expect(result.timeEntries[0].monthKey).toBe('2024-03');
  });

  it('derives weekNumber as an integer 1–53', () => {
    const today = new Date('2024-06-01');
    const entry: EnrichedTimeEntry = {
      _sourceRowIndex: 0, hasMatchedMatter: true, _lawyerResolved: true,
      date: new Date('2024-01-08'), durationMinutes: 60, billableValue: 100, doNotBill: false,
    };
    const joinResult = makeJoinResult({ timeEntries: [entry] });
    const result = enrichRecords(joinResult, today);
    expect(result.timeEntries[0].weekNumber).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Department synthesis
// ---------------------------------------------------------------------------

describe('enrichRecords — department synthesis', () => {
  it('creates department records from unique department names in matters', () => {
    const today = new Date('2024-06-01');
    const matters: EnrichedMatter[] = [
      { _sourceRowIndex: 0, hasClosedMatterData: false, _clientResolved: false, isActive: true, isClosed: false, department: 'Litigation' },
      { _sourceRowIndex: 1, hasClosedMatterData: false, _clientResolved: false, isActive: true, isClosed: false, department: 'Corporate' },
      { _sourceRowIndex: 2, hasClosedMatterData: false, _clientResolved: false, isActive: true, isClosed: false, department: 'Litigation' },
    ];
    const joinResult = makeJoinResult({ matters });
    const result = enrichRecords(joinResult, today);

    const deptNames = result.departments.map(d => d.name);
    expect(deptNames).toContain('Litigation');
    expect(deptNames).toContain('Corporate');
    expect(result.departments.filter(d => d.name === 'Litigation')).toHaveLength(1);
  });

  it('creates department records from fee earners when no matter departments', () => {
    const today = new Date('2024-06-01');
    const feeEarners = [
      { _sourceRowIndex: 0, department: 'Employment' },
      { _sourceRowIndex: 1, department: 'Employment' },
    ];
    const joinResult = makeJoinResult({ feeEarners });
    const result = enrichRecords(joinResult, today);

    expect(result.departments.some(d => d.name === 'Employment')).toBe(true);
    expect(result.departments.filter(d => d.name === 'Employment')).toHaveLength(1);
  });

  it('passes through existing departments array from joinResult unchanged if no new depts found', () => {
    const today = new Date('2024-06-01');
    const existingDepts: EnrichedDepartment[] = [{ name: 'Conveyancing', departmentId: 'dept-001' }];
    const joinResult = makeJoinResult({ departments: existingDepts });
    const result = enrichRecords(joinResult, today);

    expect(result.departments.some(d => d.name === 'Conveyancing')).toBe(true);
  });
});
