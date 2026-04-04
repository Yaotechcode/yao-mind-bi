import { describe, it, expect } from 'vitest';
import { scanForRiskFlags } from '@/server/datasource/enrich/risk-scanner';
import type { RiskScanInput } from '@/server/datasource/enrich/risk-scanner';
import type { FirmConfig } from '@/shared/types/index';
import type { KpiSnapshotRow } from '@/server/services/kpi-snapshot-service';
import { RagStatus } from '@/shared/types/index';

// =============================================================================
// Fixtures
// =============================================================================

const FIRM_ID  = 'firm-test-001';
const PULLED_AT = '2024-03-15T10:00:00Z';

function makeConfig(thresholds: FirmConfig['ragThresholds'] = []): FirmConfig {
  return {
    firmId: FIRM_ID,
    firmName: 'Test Firm',
    jurisdiction: 'England and Wales',
    currency: 'GBP',
    financialYearStartMonth: 4,
    weekStartDay: 1,
    timezone: 'Europe/London',
    schemaVersion: 1,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    entityDefinitions: {},
    columnMappingTemplates: [],
    customFields: [],
    ragThresholds: thresholds,
    formulas: [],
    snippets: [],
    feeEarnerOverrides: [],
  };
}

function makeRow(
  entityType: string,
  kpiKey: string,
  kpiValue: number | null,
  overrides: Partial<KpiSnapshotRow> = {},
): KpiSnapshotRow {
  return {
    firm_id:      FIRM_ID,
    pulled_at:    PULLED_AT,
    entity_type:  entityType,
    entity_id:    overrides.entity_id   ?? `${entityType}-1`,
    entity_name:  overrides.entity_name ?? `Test ${entityType}`,
    kpi_key:      kpiKey,
    kpi_value:    kpiValue,
    rag_status:   null,
    period:       overrides.period      ?? 'current',
    display_value: null,
    ...overrides,
  };
}

function makeInput(
  snapshots: KpiSnapshotRow[],
  config: FirmConfig = makeConfig(),
): RiskScanInput {
  return { firmId: FIRM_ID, kpiSnapshots: snapshots, config, pulledAt: PULLED_AT };
}

// Shorthand RAG threshold set
function ragThreshold(metricKey: string, amberMin: number, redMin: number) {
  return {
    metricKey,
    label: metricKey,
    higherIsBetter: false,
    defaults: {
      [RagStatus.GREEN]: { max: amberMin },
      [RagStatus.AMBER]: { min: amberMin, max: redMin },
      [RagStatus.RED]:   { min: redMin },
    },
  };
}

// =============================================================================
// Empty input
// =============================================================================

describe('empty input', () => {
  it('returns empty array when kpiSnapshots is empty', () => {
    expect(scanForRiskFlags(makeInput([]))).toHaveLength(0);
  });
});

// =============================================================================
// WIP_AGE_HIGH
// =============================================================================

describe('WIP_AGE_HIGH', () => {
  it('does NOT trigger below amber threshold', () => {
    const snapshots = [makeRow('matter', 'F-WL-01', 10)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    expect(flags.filter((f) => f.flag_type === 'WIP_AGE_HIGH')).toHaveLength(0);
  });

  it('triggers at medium severity when above amber (default 14) but below red (default 30)', () => {
    const snapshots = [makeRow('matter', 'F-WL-01', 20)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const wip = flags.filter((f) => f.flag_type === 'WIP_AGE_HIGH');
    expect(wip).toHaveLength(1);
    expect(wip[0].severity).toBe('medium');
  });

  it('triggers at high severity when above red threshold (default 30)', () => {
    const snapshots = [makeRow('matter', 'F-WL-01', 45)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const wip = flags.filter((f) => f.flag_type === 'WIP_AGE_HIGH');
    expect(wip).toHaveLength(1);
    expect(wip[0].severity).toBe('high');
  });

  it('uses configured red threshold from ragThresholds', () => {
    const config = makeConfig([ragThreshold('F-WL-01', 20, 40)]);
    // 35 days > amber(20) but < red(40) → medium
    const snapshots = [makeRow('matter', 'F-WL-01', 35)];
    const flags = scanForRiskFlags(makeInput(snapshots, config));
    const wip = flags.filter((f) => f.flag_type === 'WIP_AGE_HIGH');
    expect(wip).toHaveLength(1);
    expect(wip[0].severity).toBe('medium');
  });

  it('uses configured red threshold — value above red → high', () => {
    const config = makeConfig([ragThreshold('F-WL-01', 20, 40)]);
    const snapshots = [makeRow('matter', 'F-WL-01', 50)];
    const flags = scanForRiskFlags(makeInput(snapshots, config));
    const wip = flags.filter((f) => f.flag_type === 'WIP_AGE_HIGH');
    expect(wip[0].severity).toBe('high');
  });

  it('skips null kpi_value rows', () => {
    const snapshots = [makeRow('matter', 'F-WL-01', null)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    expect(flags.filter((f) => f.flag_type === 'WIP_AGE_HIGH')).toHaveLength(0);
  });

  it('sets entity_type, entity_id, entity_name on the flag', () => {
    const snapshots = [makeRow('matter', 'F-WL-01', 45, { entity_id: 'm-123', entity_name: 'Acme v Smith' })];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const f = flags.find((f) => f.flag_type === 'WIP_AGE_HIGH');
    expect(f?.entity_type).toBe('matter');
    expect(f?.entity_id).toBe('m-123');
    expect(f?.entity_name).toBe('Acme v Smith');
  });

  it('also triggers on firm-level F-WL-04 (lock-up days)', () => {
    const snapshots = [makeRow('firm', 'F-WL-04', 45, { entity_id: FIRM_ID })];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const wip = flags.filter((f) => f.flag_type === 'WIP_AGE_HIGH');
    expect(wip).toHaveLength(1);
    expect(wip[0].entity_type).toBe('firm');
  });
});

// =============================================================================
// BUDGET_BURN_CRITICAL
// =============================================================================

describe('BUDGET_BURN_CRITICAL', () => {
  it('does NOT trigger below 70%', () => {
    const snapshots = [makeRow('matter', 'F-BS-01', 65)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    expect(flags.filter((f) => f.flag_type === 'BUDGET_BURN_CRITICAL')).toHaveLength(0);
  });

  it('triggers at medium severity between 70% and 85%', () => {
    const snapshots = [makeRow('matter', 'F-BS-01', 75)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const bb = flags.filter((f) => f.flag_type === 'BUDGET_BURN_CRITICAL');
    expect(bb).toHaveLength(1);
    expect(bb[0].severity).toBe('medium');
  });

  it('triggers at high severity above 85%', () => {
    const snapshots = [makeRow('matter', 'F-BS-01', 90)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const bb = flags.filter((f) => f.flag_type === 'BUDGET_BURN_CRITICAL');
    expect(bb).toHaveLength(1);
    expect(bb[0].severity).toBe('high');
  });

  it('detail includes budget percentage and remaining', () => {
    const snapshots = [makeRow('matter', 'F-BS-01', 90)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const f = flags.find((f) => f.flag_type === 'BUDGET_BURN_CRITICAL')!;
    expect(f.detail).toContain('90.0%');
    expect(f.detail).toContain('remaining');
  });

  it('exactly at 85% does NOT trigger high (must be > 85)', () => {
    const snapshots = [makeRow('matter', 'F-BS-01', 85)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const bb = flags.filter((f) => f.flag_type === 'BUDGET_BURN_CRITICAL');
    expect(bb).toHaveLength(1);
    expect(bb[0].severity).toBe('medium');
  });
});

// =============================================================================
// DEBTOR_DAYS_HIGH
// =============================================================================

describe('DEBTOR_DAYS_HIGH', () => {
  it('does NOT trigger below red threshold (default 60)', () => {
    const snapshots = [makeRow('invoice', 'F-DM-01', 50)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    expect(flags.filter((f) => f.flag_type === 'DEBTOR_DAYS_HIGH')).toHaveLength(0);
  });

  it('triggers when invoice kpi_value > red threshold', () => {
    const snapshots = [makeRow('invoice', 'F-DM-01', 75)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const dd = flags.filter((f) => f.flag_type === 'DEBTOR_DAYS_HIGH');
    expect(dd).toHaveLength(1);
    expect(dd[0].severity).toBe('high');
  });

  it('uses configured threshold from ragThresholds', () => {
    const config = makeConfig([ragThreshold('F-DM-01', 45, 90)]);
    // 65 days < red(90) → no flag
    const snapshots = [makeRow('invoice', 'F-DM-01', 65)];
    const flags = scanForRiskFlags(makeInput(snapshots, config));
    expect(flags.filter((f) => f.flag_type === 'DEBTOR_DAYS_HIGH')).toHaveLength(0);
  });

  it('triggers for client entity type as well', () => {
    const snapshots = [makeRow('client', 'F-DM-01', 75)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const dd = flags.filter((f) => f.flag_type === 'DEBTOR_DAYS_HIGH');
    expect(dd).toHaveLength(1);
    expect(dd[0].entity_type).toBe('client');
  });
});

// =============================================================================
// UTILISATION_DROP
// =============================================================================

describe('UTILISATION_DROP', () => {
  it('skips when no previous-period data is present', () => {
    const snapshots = [makeRow('feeEarner', 'F-TU-01', 50, { period: 'current' })];
    const flags = scanForRiskFlags(makeInput(snapshots));
    expect(flags.filter((f) => f.flag_type === 'UTILISATION_DROP')).toHaveLength(0);
  });

  it('does NOT trigger when drop is below 20%', () => {
    const snapshots = [
      makeRow('feeEarner', 'F-TU-01', 75, { entity_id: 'att-1', period: 'current' }),
      makeRow('feeEarner', 'F-TU-01', 85, { entity_id: 'att-1', period: 'previous' }),
    ];
    // drop = (85-75)/85 = 11.8% < 20% → no flag
    const flags = scanForRiskFlags(makeInput(snapshots));
    expect(flags.filter((f) => f.flag_type === 'UTILISATION_DROP')).toHaveLength(0);
  });

  it('triggers at medium severity for a 20%–30% drop', () => {
    const snapshots = [
      makeRow('feeEarner', 'F-TU-01', 60, { entity_id: 'att-1', period: 'current' }),
      makeRow('feeEarner', 'F-TU-01', 80, { entity_id: 'att-1', period: 'previous' }),
    ];
    // drop = (80-60)/80 = 25% → medium
    const flags = scanForRiskFlags(makeInput(snapshots));
    const ud = flags.filter((f) => f.flag_type === 'UTILISATION_DROP');
    expect(ud).toHaveLength(1);
    expect(ud[0].severity).toBe('medium');
  });

  it('triggers at high severity for a drop > 30%', () => {
    const snapshots = [
      makeRow('feeEarner', 'F-TU-01', 50, { entity_id: 'att-1', period: 'current' }),
      makeRow('feeEarner', 'F-TU-01', 80, { entity_id: 'att-1', period: 'previous' }),
    ];
    // drop = (80-50)/80 = 37.5% → high
    const flags = scanForRiskFlags(makeInput(snapshots));
    const ud = flags.filter((f) => f.flag_type === 'UTILISATION_DROP');
    expect(ud).toHaveLength(1);
    expect(ud[0].severity).toBe('high');
  });

  it('detail includes both previous and current percentages', () => {
    const snapshots = [
      makeRow('feeEarner', 'F-TU-01', 50, { entity_id: 'att-1', period: 'current' }),
      makeRow('feeEarner', 'F-TU-01', 80, { entity_id: 'att-1', period: 'previous' }),
    ];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const f = flags.find((f) => f.flag_type === 'UTILISATION_DROP')!;
    expect(f.detail).toContain('80.0%');
    expect(f.detail).toContain('50.0%');
  });

  it('only flags entity when matched by entity_id in both periods', () => {
    // att-2 has no previous-period data → no flag for att-2
    const snapshots = [
      makeRow('feeEarner', 'F-TU-01', 40, { entity_id: 'att-1', period: 'current' }),
      makeRow('feeEarner', 'F-TU-01', 80, { entity_id: 'att-1', period: 'previous' }),
      makeRow('feeEarner', 'F-TU-01', 40, { entity_id: 'att-2', period: 'current' }),
    ];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const ud = flags.filter((f) => f.flag_type === 'UTILISATION_DROP');
    expect(ud).toHaveLength(1);
    expect(ud[0].entity_id).toBe('att-1');
  });
});

// =============================================================================
// DORMANT_MATTER
// =============================================================================

describe('DORMANT_MATTER', () => {
  it('does NOT trigger when WIP age <= 14 days', () => {
    const snapshots = [makeRow('matter', 'F-WL-01', 14)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    expect(flags.filter((f) => f.flag_type === 'DORMANT_MATTER')).toHaveLength(0);
  });

  it('triggers when WIP age > 14 days', () => {
    const snapshots = [makeRow('matter', 'F-WL-01', 15)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const dm = flags.filter((f) => f.flag_type === 'DORMANT_MATTER');
    expect(dm).toHaveLength(1);
  });

  it('sets severity to medium', () => {
    const snapshots = [makeRow('matter', 'F-WL-01', 30)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const dm = flags.find((f) => f.flag_type === 'DORMANT_MATTER')!;
    expect(dm.severity).toBe('medium');
  });

  it('detail includes the number of days', () => {
    const snapshots = [makeRow('matter', 'F-WL-01', 21)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const f = flags.find((f) => f.flag_type === 'DORMANT_MATTER')!;
    expect(f.detail).toContain('21');
    expect(f.detail).toContain('days');
  });

  it('skips null kpi_value', () => {
    const snapshots = [makeRow('matter', 'F-WL-01', null)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    expect(flags.filter((f) => f.flag_type === 'DORMANT_MATTER')).toHaveLength(0);
  });
});

// =============================================================================
// BAD_DEBT_RISK
// =============================================================================

describe('BAD_DEBT_RISK', () => {
  it('does NOT trigger below 90 days', () => {
    const snapshots = [makeRow('invoice', 'F-DM-01', 89)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    expect(flags.filter((f) => f.flag_type === 'BAD_DEBT_RISK')).toHaveLength(0);
  });

  it('triggers at medium severity between 90 and 120 days', () => {
    const snapshots = [makeRow('invoice', 'F-DM-01', 100)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const bd = flags.filter((f) => f.flag_type === 'BAD_DEBT_RISK');
    expect(bd).toHaveLength(1);
    expect(bd[0].severity).toBe('medium');
  });

  it('triggers at high severity above 120 days', () => {
    const snapshots = [makeRow('invoice', 'F-DM-01', 150)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const bd = flags.filter((f) => f.flag_type === 'BAD_DEBT_RISK');
    expect(bd).toHaveLength(1);
    expect(bd[0].severity).toBe('high');
  });

  it('detail includes the number of days and bad debt language', () => {
    const snapshots = [makeRow('invoice', 'F-DM-01', 150)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const f = flags.find((f) => f.flag_type === 'BAD_DEBT_RISK')!;
    expect(f.detail).toContain('150');
    expect(f.detail.toLowerCase()).toContain('bad debt');
  });

  it('exactly at 90 days does NOT trigger (must be > 90)', () => {
    const snapshots = [makeRow('invoice', 'F-DM-01', 90)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    expect(flags.filter((f) => f.flag_type === 'BAD_DEBT_RISK')).toHaveLength(0);
  });
});

// =============================================================================
// WRITE_OFF_SPIKE
// =============================================================================

describe('WRITE_OFF_SPIKE', () => {
  it('does NOT trigger below amber threshold (default 5%)', () => {
    const snapshots = [makeRow('feeEarner', 'F-WL-02', 3)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    expect(flags.filter((f) => f.flag_type === 'WRITE_OFF_SPIKE')).toHaveLength(0);
  });

  it('triggers at medium severity between amber (default 5%) and red (default 10%)', () => {
    const snapshots = [makeRow('feeEarner', 'F-WL-02', 7)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const wo = flags.filter((f) => f.flag_type === 'WRITE_OFF_SPIKE');
    expect(wo).toHaveLength(1);
    expect(wo[0].severity).toBe('medium');
  });

  it('triggers at high severity above red threshold (default 10%)', () => {
    const snapshots = [makeRow('feeEarner', 'F-WL-02', 15)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const wo = flags.filter((f) => f.flag_type === 'WRITE_OFF_SPIKE');
    expect(wo).toHaveLength(1);
    expect(wo[0].severity).toBe('high');
  });

  it('uses configured red threshold from ragThresholds', () => {
    const config = makeConfig([ragThreshold('F-WL-02', 8, 20)]);
    // 12% > amber(8) but < red(20) → medium
    const snapshots = [makeRow('feeEarner', 'F-WL-02', 12)];
    const flags = scanForRiskFlags(makeInput(snapshots, config));
    const wo = flags.filter((f) => f.flag_type === 'WRITE_OFF_SPIKE');
    expect(wo).toHaveLength(1);
    expect(wo[0].severity).toBe('medium');
  });

  it('detail includes write-off percentage', () => {
    const snapshots = [makeRow('feeEarner', 'F-WL-02', 15)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const f = flags.find((f) => f.flag_type === 'WRITE_OFF_SPIKE')!;
    expect(f.detail).toContain('15.0%');
  });

  it('also triggers for firm entity type', () => {
    const snapshots = [makeRow('firm', 'F-WL-02', 12, { entity_id: FIRM_ID })];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const wo = flags.filter((f) => f.flag_type === 'WRITE_OFF_SPIKE');
    expect(wo).toHaveLength(1);
    expect(wo[0].entity_type).toBe('firm');
  });
});

// =============================================================================
// General / cross-cutting
// =============================================================================

describe('general', () => {
  it('ai_summary is undefined on all flags', () => {
    const snapshots = [makeRow('matter', 'F-BS-01', 90)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    for (const f of flags) {
      expect(f.ai_summary).toBeUndefined();
    }
  });

  it('firm_id matches input firmId on every flag', () => {
    const snapshots = [makeRow('matter', 'F-BS-01', 90)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    for (const f of flags) {
      expect(f.firm_id).toBe(FIRM_ID);
    }
  });

  it('flagged_at is a Date parsed from pulledAt', () => {
    const snapshots = [makeRow('matter', 'F-BS-01', 90)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    for (const f of flags) {
      expect(f.flagged_at).toBeInstanceOf(Date);
      expect(f.flagged_at.getTime()).toBe(new Date(PULLED_AT).getTime());
    }
  });

  it('multiple rules fire independently on same snapshot data', () => {
    // WIP_AGE_HIGH (45 days > 30) + DORMANT_MATTER (>14)  — same F-WL-01 row
    const snapshots = [makeRow('matter', 'F-WL-01', 45)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const types = flags.map((f) => f.flag_type);
    expect(types).toContain('WIP_AGE_HIGH');
    expect(types).toContain('DORMANT_MATTER');
  });

  it('kpi_value on flag matches snapshot value', () => {
    const snapshots = [makeRow('matter', 'F-BS-01', 91.5)];
    const flags = scanForRiskFlags(makeInput(snapshots));
    const f = flags.find((f) => f.flag_type === 'BUDGET_BURN_CRITICAL')!;
    expect(f.kpi_value).toBe(91.5);
  });
});
