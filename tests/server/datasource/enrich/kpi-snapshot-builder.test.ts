import { describe, it, expect } from 'vitest';
import {
  buildSnapshotsFromKpiResults,
  buildFirmLevelSnapshots,
} from '@/server/datasource/enrich/kpi-snapshot-builder';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFormulaResult(
  formulaId: string,
  entities: Array<{ id: string; name: string; value: number | null }>,
) {
  const entityResults: Record<string, {
    entityId: string; entityName: string; value: number | null;
    formattedValue: string | null; nullReason: string | null;
  }> = {};
  for (const e of entities) {
    entityResults[e.id] = {
      entityId: e.id,
      entityName: e.name,
      value: e.value,
      formattedValue: null,
      nullReason: e.value === null ? 'no data' : null,
    };
  }
  return {
    formulaId,
    formulaName: `Formula ${formulaId}`,
    variantUsed: null,
    resultType: 'percentage' as const,
    entityResults,
    summary: { mean: null, median: null, min: null, max: null, total: null, count: 0, nullCount: 0 },
    computedAt: '2024-03-01T10:00:00Z',
    metadata: { executionTimeMs: 1, inputsUsed: [], nullReasons: [], warnings: [] },
  };
}

const FIRM_ID = 'firm-test-001';
const PULLED_AT = '2024-03-15T10:00:00Z';

// ---------------------------------------------------------------------------
// buildSnapshotsFromKpiResults
// ---------------------------------------------------------------------------

describe('buildSnapshotsFromKpiResults()', () => {
  it('returns empty array when formulaResults is absent', () => {
    const result = buildSnapshotsFromKpiResults(FIRM_ID, PULLED_AT, { kpis: {} });
    expect(result).toHaveLength(0);
  });

  it('returns one row per entity per formula', () => {
    const kpiResults = {
      kpis: {
        formulaResults: {
          'F-TU-01': makeFormulaResult('F-TU-01', [
            { id: 'att-1', name: 'Alice Smith', value: 73.4 },
            { id: 'att-2', name: 'Bob Jones', value: 85.0 },
          ]),
        },
      },
    };
    const rows = buildSnapshotsFromKpiResults(FIRM_ID, PULLED_AT, kpiResults);
    expect(rows).toHaveLength(2);
  });

  it('sets firm_id and pulled_at on every row', () => {
    const kpiResults = {
      kpis: {
        formulaResults: {
          'F-TU-01': makeFormulaResult('F-TU-01', [{ id: 'att-1', name: 'Alice', value: 70 }]),
        },
      },
    };
    const rows = buildSnapshotsFromKpiResults(FIRM_ID, PULLED_AT, kpiResults);
    expect(rows[0].firm_id).toBe(FIRM_ID);
    expect(rows[0].pulled_at).toBe(PULLED_AT);
  });

  it('maps F-TU-01 to entity_type feeEarner (from formula definitions)', () => {
    const kpiResults = {
      kpis: {
        formulaResults: {
          'F-TU-01': makeFormulaResult('F-TU-01', [{ id: 'att-1', name: 'Alice', value: 70 }]),
        },
      },
    };
    const rows = buildSnapshotsFromKpiResults(FIRM_ID, PULLED_AT, kpiResults);
    expect(rows[0].entity_type).toBe('feeEarner');
  });

  it('maps F-RB-04 to entity_type matter', () => {
    const kpiResults = {
      kpis: {
        formulaResults: {
          'F-RB-04': makeFormulaResult('F-RB-04', [{ id: 'm-1', name: 'Matter 1', value: 5 }]),
        },
      },
    };
    const rows = buildSnapshotsFromKpiResults(FIRM_ID, PULLED_AT, kpiResults);
    expect(rows[0].entity_type).toBe('matter');
  });

  it('maps F-WL-04 to entity_type firm', () => {
    const kpiResults = {
      kpis: {
        formulaResults: {
          'F-WL-04': makeFormulaResult('F-WL-04', [{ id: 'firm', name: 'My Firm', value: 3.2 }]),
        },
      },
    };
    const rows = buildSnapshotsFromKpiResults(FIRM_ID, PULLED_AT, kpiResults);
    expect(rows[0].entity_type).toBe('firm');
  });

  it('sets kpi_key, entity_id, entity_name, and kpi_value correctly', () => {
    const kpiResults = {
      kpis: {
        formulaResults: {
          'F-TU-01': makeFormulaResult('F-TU-01', [{ id: 'att-1', name: 'Alice Smith', value: 73.4 }]),
        },
      },
    };
    const rows = buildSnapshotsFromKpiResults(FIRM_ID, PULLED_AT, kpiResults);
    expect(rows[0].kpi_key).toBe('F-TU-01');
    expect(rows[0].entity_id).toBe('att-1');
    expect(rows[0].entity_name).toBe('Alice Smith');
    expect(rows[0].kpi_value).toBe(73.4);
  });

  it('applies the period argument (defaults to current)', () => {
    const kpiResults = {
      kpis: {
        formulaResults: {
          'F-TU-01': makeFormulaResult('F-TU-01', [{ id: 'att-1', name: 'Alice', value: 70 }]),
        },
      },
    };
    const defaultRows = buildSnapshotsFromKpiResults(FIRM_ID, PULLED_AT, kpiResults);
    expect(defaultRows[0].period).toBe('current');

    const ytdRows = buildSnapshotsFromKpiResults(FIRM_ID, PULLED_AT, kpiResults, 'ytd');
    expect(ytdRows[0].period).toBe('ytd');
  });

  it('picks up rag_status from ragAssignments', () => {
    const kpiResults = {
      kpis: {
        formulaResults: {
          'F-TU-01': makeFormulaResult('F-TU-01', [{ id: 'att-1', name: 'Alice', value: 73.4 }]),
        },
        ragAssignments: {
          'F-TU-01': {
            'att-1': { status: 'green' as const, value: 73.4, threshold: 70, band: {} as never },
          },
        },
      },
    };
    const rows = buildSnapshotsFromKpiResults(FIRM_ID, PULLED_AT, kpiResults);
    expect(rows[0].rag_status).toBe('green');
  });

  it('sets rag_status to null when no ragAssignment exists for entity', () => {
    const kpiResults = {
      kpis: {
        formulaResults: {
          'F-TU-01': makeFormulaResult('F-TU-01', [{ id: 'att-1', name: 'Alice', value: 73.4 }]),
        },
        ragAssignments: {},
      },
    };
    const rows = buildSnapshotsFromKpiResults(FIRM_ID, PULLED_AT, kpiResults);
    expect(rows[0].rag_status).toBeNull();
  });

  it('sets kpi_value to null and rag_status to null for null entity values', () => {
    const kpiResults = {
      kpis: {
        formulaResults: {
          'F-TU-01': makeFormulaResult('F-TU-01', [{ id: 'att-1', name: 'Alice', value: null }]),
        },
      },
    };
    const rows = buildSnapshotsFromKpiResults(FIRM_ID, PULLED_AT, kpiResults);
    expect(rows[0].kpi_value).toBeNull();
    expect(rows[0].rag_status).toBeNull();
  });

  it('produces display_value for percentage formula (F-TU-01)', () => {
    const kpiResults = {
      kpis: {
        formulaResults: {
          'F-TU-01': makeFormulaResult('F-TU-01', [{ id: 'att-1', name: 'Alice', value: 73.4 }]),
        },
      },
    };
    const rows = buildSnapshotsFromKpiResults(FIRM_ID, PULLED_AT, kpiResults);
    expect(rows[0].display_value).toBe('73.4%');
  });

  it('produces display_value for currency formula (F-RB-02)', () => {
    const kpiResults = {
      kpis: {
        formulaResults: {
          'F-RB-02': makeFormulaResult('F-RB-02', [{ id: 'att-1', name: 'Alice', value: 42500 }]),
        },
      },
    };
    const rows = buildSnapshotsFromKpiResults(FIRM_ID, PULLED_AT, kpiResults);
    expect(rows[0].display_value).toBe('£42,500');
  });

  it('handles multiple formulas producing the correct total row count', () => {
    const kpiResults = {
      kpis: {
        formulaResults: {
          'F-TU-01': makeFormulaResult('F-TU-01', [
            { id: 'att-1', name: 'Alice', value: 70 },
            { id: 'att-2', name: 'Bob', value: 80 },
          ]),
          'F-RB-04': makeFormulaResult('F-RB-04', [
            { id: 'm-1', name: 'Matter 1', value: 5 },
          ]),
        },
      },
    };
    const rows = buildSnapshotsFromKpiResults(FIRM_ID, PULLED_AT, kpiResults);
    expect(rows).toHaveLength(3);
  });

  it('unknown formula id falls back to entity_type firm', () => {
    const kpiResults = {
      kpis: {
        formulaResults: {
          'F-CUSTOM-99': makeFormulaResult('F-CUSTOM-99', [{ id: 'x', name: 'X', value: 1 }]),
        },
      },
    };
    const rows = buildSnapshotsFromKpiResults(FIRM_ID, PULLED_AT, kpiResults);
    expect(rows[0].entity_type).toBe('firm');
  });
});

// ---------------------------------------------------------------------------
// buildFirmLevelSnapshots
// ---------------------------------------------------------------------------

describe('buildFirmLevelSnapshots()', () => {
  it('returns one row per kpi key', () => {
    const rows = buildFirmLevelSnapshots(FIRM_ID, PULLED_AT, {
      totalRevenue: 500000,
      totalWip: 150000,
    });
    expect(rows).toHaveLength(2);
  });

  it('sets entity_type to firm and entity_id to firmId on every row', () => {
    const rows = buildFirmLevelSnapshots(FIRM_ID, PULLED_AT, { totalRevenue: 500000 });
    expect(rows[0].entity_type).toBe('firm');
    expect(rows[0].entity_id).toBe(FIRM_ID);
  });

  it('uses firmName as entity_name when provided', () => {
    const rows = buildFirmLevelSnapshots(FIRM_ID, PULLED_AT, { x: 1 }, 'Acme LLP');
    expect(rows[0].entity_name).toBe('Acme LLP');
  });

  it('falls back to firmId as entity_name when firmName is omitted', () => {
    const rows = buildFirmLevelSnapshots(FIRM_ID, PULLED_AT, { x: 1 });
    expect(rows[0].entity_name).toBe(FIRM_ID);
  });

  it('sets kpi_key and kpi_value correctly', () => {
    const rows = buildFirmLevelSnapshots(FIRM_ID, PULLED_AT, { totalRevenue: 500000 });
    expect(rows[0].kpi_key).toBe('totalRevenue');
    expect(rows[0].kpi_value).toBe(500000);
  });

  it('sets rag_status to null for all rows', () => {
    const rows = buildFirmLevelSnapshots(FIRM_ID, PULLED_AT, { totalRevenue: 500000 });
    expect(rows[0].rag_status).toBeNull();
  });

  it('defaults period to current', () => {
    const rows = buildFirmLevelSnapshots(FIRM_ID, PULLED_AT, { x: 1 });
    expect(rows[0].period).toBe('current');
  });

  it('uses the supplied period', () => {
    const rows = buildFirmLevelSnapshots(FIRM_ID, PULLED_AT, { x: 1 }, undefined, 'ytd');
    expect(rows[0].period).toBe('ytd');
  });

  it('handles null kpi_value without throwing', () => {
    const rows = buildFirmLevelSnapshots(FIRM_ID, PULLED_AT, { totalRevenue: null });
    expect(rows[0].kpi_value).toBeNull();
    expect(rows[0].display_value).toBeNull();
  });

  it('returns empty array for empty kpi object', () => {
    const rows = buildFirmLevelSnapshots(FIRM_ID, PULLED_AT, {});
    expect(rows).toHaveLength(0);
  });

  it('sets firm_id and pulled_at on every row', () => {
    const rows = buildFirmLevelSnapshots(FIRM_ID, PULLED_AT, { x: 1 });
    expect(rows[0].firm_id).toBe(FIRM_ID);
    expect(rows[0].pulled_at).toBe(PULLED_AT);
  });
});
