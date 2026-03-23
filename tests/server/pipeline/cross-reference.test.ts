import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildCrossReferenceRegistry,
  applyRegistryToDatasets,
  serialiseRegistry,
  deserialiseRegistry,
  normaliseNameForLookup,
} from '../../../src/server/pipeline/cross-reference.js';
import type {
  NormaliseResult,
  NormalisedRecord,
  CrossReferenceRegistry,
} from '../../../src/shared/types/pipeline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNormaliseResult(
  fileType: string,
  records: NormalisedRecord[]
): NormaliseResult {
  return {
    fileType,
    records,
    recordCount: records.length,
    normalisedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 1. Name normalisation utility
// ---------------------------------------------------------------------------

describe('normaliseNameForLookup', () => {
  it('lowercases and trims', () => {
    expect(normaliseNameForLookup('  John Smith  ')).toBe('john smith');
  });

  it('strips Mr/Mrs/Dr/Prof titles', () => {
    expect(normaliseNameForLookup('Dr. Jane Doe')).toBe('jane doe');
    expect(normaliseNameForLookup('Mrs Jane Doe')).toBe('jane doe');
  });

  it("normalises 'J. Smith' to 'j. smith' for lookup", () => {
    expect(normaliseNameForLookup('J. Smith')).toBe('j. smith');
  });

  it("normalises 'JOHN SMITH' (all-caps) to 'john smith'", () => {
    expect(normaliseNameForLookup('JOHN SMITH')).toBe('john smith');
  });
});

// ---------------------------------------------------------------------------
// 2. buildCrossReferenceRegistry — matter extraction
// ---------------------------------------------------------------------------

describe('buildCrossReferenceRegistry — matters', () => {
  it('builds idToNumber and numberToId from a single dataset', () => {
    const datasets = {
      fullMattersJson: makeNormaliseResult('fullMattersJson', [
        { matterId: 'uuid-001', matterNumber: '1001' },
        { matterId: 'uuid-002', matterNumber: '1002' },
      ]),
    };

    const registry = buildCrossReferenceRegistry('firm-1', datasets);

    expect(registry.matters.idToNumber.get('uuid-001')).toBe('1001');
    expect(registry.matters.idToNumber.get('uuid-002')).toBe('1002');
    expect(registry.matters.numberToId.get('1001')).toBe('uuid-001');
    expect(registry.matters.numberToId.get('1002')).toBe('uuid-002');
  });

  it('marks fullMatters mappings as certain', () => {
    const datasets = {
      fullMattersJson: makeNormaliseResult('fullMattersJson', [
        { matterId: 'uuid-001', matterNumber: '1001' },
      ]),
    };

    const registry = buildCrossReferenceRegistry('firm-1', datasets);
    expect(registry.matters.confidence.get('uuid-001')).toBe('certain');
  });

  it('records which datasets contributed each mapping', () => {
    const datasets = {
      fullMattersJson: makeNormaliseResult('fullMattersJson', [
        { matterId: 'uuid-001', matterNumber: '1001' },
      ]),
      wipJson: makeNormaliseResult('wipJson', [
        { matterId: 'uuid-001', matterNumber: '1001' }, // same — corroborates
      ]),
    };

    const registry = buildCrossReferenceRegistry('firm-1', datasets);
    const sources = registry.matters.sourceDatasets.get('uuid-001') ?? [];
    expect(sources).toContain('fullMattersJson');
    expect(sources).toContain('wipJson');
  });

  it('extracts from wipJson when fullMatters not present', () => {
    const datasets = {
      wipJson: makeNormaliseResult('wipJson', [
        { matterId: 'uuid-003', matterNumber: '1003' },
      ]),
    };

    const registry = buildCrossReferenceRegistry('firm-1', datasets);
    expect(registry.matters.idToNumber.get('uuid-003')).toBe('1003');
  });

  it('extracts from closedMattersJson', () => {
    const datasets = {
      closedMattersJson: makeNormaliseResult('closedMattersJson', [
        { matterId: 'uuid-closed-001', matterNumber: '2001' },
      ]),
    };

    const registry = buildCrossReferenceRegistry('firm-1', datasets);
    expect(registry.matters.idToNumber.get('uuid-closed-001')).toBe('2001');
    expect(registry.matters.confidence.get('uuid-closed-001')).toBe('certain');
  });

  it('closedMatters takes priority over wipJson for the same matterId', () => {
    const datasets = {
      closedMattersJson: makeNormaliseResult('closedMattersJson', [
        { matterId: 'uuid-001', matterNumber: '100' },
      ]),
      wipJson: makeNormaliseResult('wipJson', [
        { matterId: 'uuid-001', matterNumber: '999' }, // lower priority — conflict
      ]),
    };

    const registry = buildCrossReferenceRegistry('firm-1', datasets);
    // closedMatters has higher priority than wip
    expect(registry.matters.idToNumber.get('uuid-001')).toBe('100');
    expect(registry.stats.matters.conflictingMappings).toBe(1);
  });

  it('skips records that only have one identifier form', () => {
    const datasets = {
      wipJson: makeNormaliseResult('wipJson', [
        { matterId: 'uuid-004' }, // no matterNumber
        { matterNumber: '1005' }, // no matterId
      ]),
    };

    const registry = buildCrossReferenceRegistry('firm-1', datasets);
    expect(registry.matters.idToNumber.size).toBe(0);
    expect(registry.matters.numberToId.size).toBe(0);
  });

  // Conflict handling
  it('detects a conflict when two datasets disagree on the same matterId', () => {
    const datasets = {
      fullMattersJson: makeNormaliseResult('fullMattersJson', [
        { matterId: 'uuid-001', matterNumber: '100' },
      ]),
      wipJson: makeNormaliseResult('wipJson', [
        { matterId: 'uuid-001', matterNumber: '200' }, // CONFLICT
      ]),
    };

    const registry = buildCrossReferenceRegistry('firm-1', datasets);

    expect(registry.stats.matters.conflictingMappings).toBe(1);
    expect(registry.stats.matters.conflicts).toHaveLength(1);
    const conflict = registry.stats.matters.conflicts[0];
    expect(conflict.entityType).toBe('matter');
    expect(conflict.idForm).toBe('uuid-001');
    expect(conflict.resolution).toBe('kept_a'); // fullMatters wins
    expect(conflict.sourceA).toBe('fullMattersJson');
    expect(conflict.sourceB).toBe('wipJson');
  });

  it('keeps the fullMatters value when a conflict is detected', () => {
    const datasets = {
      fullMattersJson: makeNormaliseResult('fullMattersJson', [
        { matterId: 'uuid-001', matterNumber: '100' },
      ]),
      wipJson: makeNormaliseResult('wipJson', [
        { matterId: 'uuid-001', matterNumber: '200' },
      ]),
    };

    const registry = buildCrossReferenceRegistry('firm-1', datasets);
    expect(registry.matters.idToNumber.get('uuid-001')).toBe('100'); // fullMatters wins
  });
});

// ---------------------------------------------------------------------------
// 3. buildCrossReferenceRegistry — fee earner extraction + name variants
// ---------------------------------------------------------------------------

describe('buildCrossReferenceRegistry — feeEarners', () => {
  it('builds idToName from feeEarnerCsv', () => {
    const datasets = {
      feeEarnerCsv: makeNormaliseResult('feeEarnerCsv', [
        { lawyerId: 'lawyer-001', lawyerName: 'John Smith' },
      ]),
    };

    const registry = buildCrossReferenceRegistry('firm-1', datasets);
    expect(registry.feeEarners.idToName.get('lawyer-001')).toBe('John Smith');
  });

  it('registers all name variants for lookup', () => {
    const datasets = {
      feeEarnerCsv: makeNormaliseResult('feeEarnerCsv', [
        { lawyerId: 'lawyer-001', lawyerName: 'John Smith' },
      ]),
    };

    const registry = buildCrossReferenceRegistry('firm-1', datasets);

    // All of these should resolve to lawyer-001
    expect(registry.feeEarners.nameToId.get('john smith')).toBe('lawyer-001');
    expect(registry.feeEarners.nameToId.get('j smith')).toBe('lawyer-001');
    expect(registry.feeEarners.nameToId.get('j. smith')).toBe('lawyer-001');
    expect(registry.feeEarners.nameToId.get('smith')).toBe('lawyer-001');
    expect(registry.feeEarners.nameToId.get('smith john')).toBe('lawyer-001');
    expect(registry.feeEarners.nameToId.get('smith, john')).toBe('lawyer-001');
  });

  it("resolves 'J. Smith' in WIP to lawyerId from feeEarner CSV", () => {
    const datasets = {
      feeEarnerCsv: makeNormaliseResult('feeEarnerCsv', [
        { lawyerId: 'lawyer-001', lawyerName: 'John Smith' },
      ]),
      wipJson: makeNormaliseResult('wipJson', [
        { lawyerName: 'J. Smith' }, // only name, no ID
      ]),
    };

    const registry = buildCrossReferenceRegistry('firm-1', datasets);
    // The nameToId map should have been built from the CSV
    expect(registry.feeEarners.nameToId.get('j. smith')).toBe('lawyer-001');
  });

  it("resolves 'SMITH, JOHN' to the correct lawyerId", () => {
    const datasets = {
      feeEarnerCsv: makeNormaliseResult('feeEarnerCsv', [
        { lawyerId: 'lawyer-001', lawyerName: 'John Smith' },
      ]),
    };

    const registry = buildCrossReferenceRegistry('firm-1', datasets);
    expect(registry.feeEarners.nameToId.get('smith, john')).toBe('lawyer-001');
  });

  it("resolves 'JOHN SMITH' (all-caps) to the correct lawyerId via normalisation", () => {
    const datasets = {
      feeEarnerCsv: makeNormaliseResult('feeEarnerCsv', [
        { lawyerId: 'lawyer-001', lawyerName: 'John Smith' },
      ]),
    };

    const registry = buildCrossReferenceRegistry('firm-1', datasets);
    // All-caps input should be normalised to 'john smith' before lookup
    const normalisedAllCaps = normaliseNameForLookup('JOHN SMITH');
    expect(registry.feeEarners.nameToId.get(normalisedAllCaps)).toBe('lawyer-001');
  });

  it('extracts responsibleLawyerId + responsibleLawyer from fullMattersJson', () => {
    const datasets = {
      fullMattersJson: makeNormaliseResult('fullMattersJson', [
        { responsibleLawyerId: 'lawyer-002', responsibleLawyer: 'Jane Doe' },
      ]),
    };

    const registry = buildCrossReferenceRegistry('firm-1', datasets);
    expect(registry.feeEarners.idToName.get('lawyer-002')).toBe('Jane Doe');
  });
});

// ---------------------------------------------------------------------------
// 4. buildCrossReferenceRegistry — clients
// ---------------------------------------------------------------------------

describe('buildCrossReferenceRegistry — clients', () => {
  it('builds idToName from contactsJson', () => {
    const datasets = {
      contactsJson: makeNormaliseResult('contactsJson', [
        { contactId: 'contact-001', displayName: 'Acme Corp' },
      ]),
    };

    const registry = buildCrossReferenceRegistry('firm-1', datasets);
    expect(registry.clients.idToName.get('contact-001')).toBe('Acme Corp');
    expect(registry.clients.nameToId.get('acme corp')).toBe('contact-001');
  });

  it('marks contactsJson mappings as certain', () => {
    const datasets = {
      contactsJson: makeNormaliseResult('contactsJson', [
        { contactId: 'contact-001', displayName: 'Acme Corp' },
      ]),
    };

    const registry = buildCrossReferenceRegistry('firm-1', datasets);
    expect(registry.clients.confidence.get('contact-001')).toBe('certain');
  });
});

// ---------------------------------------------------------------------------
// 5. buildCrossReferenceRegistry — departments
// ---------------------------------------------------------------------------

describe('buildCrossReferenceRegistry — departments', () => {
  it('builds idToName from fullMattersJson', () => {
    const datasets = {
      fullMattersJson: makeNormaliseResult('fullMattersJson', [
        { departmentId: 'dept-001', department: 'Conveyancing' },
      ]),
    };

    const registry = buildCrossReferenceRegistry('firm-1', datasets);
    expect(registry.departments.idToName.get('dept-001')).toBe('Conveyancing');
    expect(registry.departments.nameToId.get('conveyancing')).toBe('dept-001');
  });
});

// ---------------------------------------------------------------------------
// 6. applyRegistryToDatasets
// ---------------------------------------------------------------------------

describe('applyRegistryToDatasets', () => {
  let registry: CrossReferenceRegistry;

  beforeEach(() => {
    const datasets = {
      fullMattersJson: makeNormaliseResult('fullMattersJson', [
        { matterId: 'uuid-001', matterNumber: '1001' },
      ]),
      feeEarnerCsv: makeNormaliseResult('feeEarnerCsv', [
        { lawyerId: 'lawyer-001', lawyerName: 'John Smith' },
      ]),
    };
    registry = buildCrossReferenceRegistry('firm-1', datasets);
  });

  it('fills in matterNumber for a WIP record that only has matterId', () => {
    const datasets = {
      wipJson: makeNormaliseResult('wipJson', [
        { matterId: 'uuid-001' }, // missing matterNumber
      ]),
    };

    const result = applyRegistryToDatasets(datasets, registry);
    const record = result['wipJson'].records[0];

    expect(record.matterNumber).toBe('1001');
    expect(record._matterNumberSource).toBe('cross_reference');
  });

  it('fills in matterId for an invoice record that only has matterNumber', () => {
    const datasets = {
      invoicesJson: makeNormaliseResult('invoicesJson', [
        { matterNumber: '1001' }, // missing matterId
      ]),
    };

    const result = applyRegistryToDatasets(datasets, registry);
    const record = result['invoicesJson'].records[0];

    expect(record.matterId).toBe('uuid-001');
    expect(record._matterIdSource).toBe('cross_reference');
  });

  it('fills in lawyerName for a record that only has lawyerId', () => {
    const datasets = {
      wipJson: makeNormaliseResult('wipJson', [
        { lawyerId: 'lawyer-001' }, // missing lawyerName
      ]),
    };

    const result = applyRegistryToDatasets(datasets, registry);
    const record = result['wipJson'].records[0];

    expect(record.lawyerName).toBe('John Smith');
    expect(record._lawyerNameSource).toBe('cross_reference');
  });

  it('fills in lawyerId for a record that only has lawyerName', () => {
    const datasets = {
      wipJson: makeNormaliseResult('wipJson', [
        { lawyerName: 'J. Smith' }, // variant — missing lawyerId
      ]),
    };

    const result = applyRegistryToDatasets(datasets, registry);
    const record = result['wipJson'].records[0];

    expect(record.lawyerId).toBe('lawyer-001');
    expect(record._lawyerIdSource).toBe('cross_reference');
  });

  it('does NOT overwrite existing matterId when matterNumber already present', () => {
    const datasets = {
      fullMattersJson: makeNormaliseResult('fullMattersJson', [
        { matterId: 'uuid-001', matterNumber: '1001' }, // both present
      ]),
    };

    const result = applyRegistryToDatasets(datasets, registry);
    const record = result['fullMattersJson'].records[0];

    expect(record.matterId).toBe('uuid-001');
    expect(record.matterNumber).toBe('1001');
    // Source metadata should NOT be set (not cross-referenced)
    expect(record._matterIdSource).toBeUndefined();
    expect(record._matterNumberSource).toBeUndefined();
  });

  it('leaves a record unchanged if its matterId is not in the registry', () => {
    const datasets = {
      wipJson: makeNormaliseResult('wipJson', [
        { matterId: 'uuid-UNKNOWN' }, // not in registry
      ]),
    };

    const result = applyRegistryToDatasets(datasets, registry);
    const record = result['wipJson'].records[0];

    expect(record.matterId).toBe('uuid-UNKNOWN');
    expect(record.matterNumber).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. serialiseRegistry / deserialiseRegistry
// ---------------------------------------------------------------------------

describe('serialiseRegistry / deserialiseRegistry', () => {
  it('round-trips without data loss', () => {
    const datasets = {
      fullMattersJson: makeNormaliseResult('fullMattersJson', [
        { matterId: 'uuid-001', matterNumber: '1001' },
      ]),
      feeEarnerCsv: makeNormaliseResult('feeEarnerCsv', [
        { lawyerId: 'lawyer-001', lawyerName: 'John Smith' },
      ]),
      contactsJson: makeNormaliseResult('contactsJson', [
        { contactId: 'contact-001', displayName: 'Acme Corp' },
      ]),
    };

    const original = buildCrossReferenceRegistry('firm-1', datasets);
    const serialised = serialiseRegistry(original);
    const restored = deserialiseRegistry(serialised);

    expect(restored.matters.idToNumber.get('uuid-001')).toBe('1001');
    expect(restored.matters.numberToId.get('1001')).toBe('uuid-001');
    expect(restored.feeEarners.idToName.get('lawyer-001')).toBe('John Smith');
    expect(restored.clients.idToName.get('contact-001')).toBe('Acme Corp');
    expect(restored.firmId).toBe('firm-1');
    expect(restored.stats.matters.totalMappings).toBe(1);
  });

  it('serialised form contains only plain objects (no Maps)', () => {
    const datasets = {
      fullMattersJson: makeNormaliseResult('fullMattersJson', [
        { matterId: 'uuid-001', matterNumber: '1001' },
      ]),
    };

    const registry = buildCrossReferenceRegistry('firm-1', datasets);
    const serialised = serialiseRegistry(registry);

    // Should be JSON-serialisable without error
    expect(() => JSON.stringify(serialised)).not.toThrow();
    // The idToNumber in serialised form is a plain object, not a Map
    expect(serialised.matters.idToNumber).not.toBeInstanceOf(Map);
    expect(typeof serialised.matters.idToNumber).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// 8. Registry merging (existingRegistry parameter)
// ---------------------------------------------------------------------------

describe('buildCrossReferenceRegistry — merging with existing registry', () => {
  it('extends existing registry with new mappings — does not replace them', () => {
    // First run — only fullMatters
    const firstDatasets = {
      fullMattersJson: makeNormaliseResult('fullMattersJson', [
        { matterId: 'uuid-001', matterNumber: '1001' },
      ]),
    };
    const existingRegistry = buildCrossReferenceRegistry('firm-1', firstDatasets);

    // Second run — invoices contain a new matter
    const secondDatasets = {
      invoicesJson: makeNormaliseResult('invoicesJson', [
        { matterId: 'uuid-002', matterNumber: '1002' },
      ]),
    };
    const mergedRegistry = buildCrossReferenceRegistry('firm-1', secondDatasets, existingRegistry);

    // Both mappings should be present
    expect(mergedRegistry.matters.idToNumber.get('uuid-001')).toBe('1001'); // from first run
    expect(mergedRegistry.matters.idToNumber.get('uuid-002')).toBe('1002'); // from second run
  });

  it('detects a conflict when a new upload disagrees with persisted mapping', () => {
    const firstDatasets = {
      fullMattersJson: makeNormaliseResult('fullMattersJson', [
        { matterId: 'uuid-001', matterNumber: '100' },
      ]),
    };
    const existingRegistry = buildCrossReferenceRegistry('firm-1', firstDatasets);

    const secondDatasets = {
      invoicesJson: makeNormaliseResult('invoicesJson', [
        { matterId: 'uuid-001', matterNumber: '999' }, // CONFLICT with existing
      ]),
    };
    const mergedRegistry = buildCrossReferenceRegistry('firm-1', secondDatasets, existingRegistry);

    expect(mergedRegistry.stats.matters.conflicts.length).toBeGreaterThan(0);
    // Existing (higher priority) value should be kept
    expect(mergedRegistry.matters.idToNumber.get('uuid-001')).toBe('100');
  });

  it('preserves conflicts from the first run when merging a second registry', () => {
    // First run produces a conflict
    const firstDatasets = {
      fullMattersJson: makeNormaliseResult('fullMattersJson', [
        { matterId: 'uuid-001', matterNumber: '100' },
      ]),
      wipJson: makeNormaliseResult('wipJson', [
        { matterId: 'uuid-001', matterNumber: '200' }, // conflict on first run
      ]),
    };
    const firstRegistry = buildCrossReferenceRegistry('firm-1', firstDatasets);
    expect(firstRegistry.stats.matters.conflicts).toHaveLength(1);

    // Second run adds a new matter — no new conflicts
    const secondDatasets = {
      invoicesJson: makeNormaliseResult('invoicesJson', [
        { matterId: 'uuid-002', matterNumber: '1002' }, // no conflict
      ]),
    };
    const mergedRegistry = buildCrossReferenceRegistry('firm-1', secondDatasets, firstRegistry);

    // The original conflict from the first run must still be present
    expect(mergedRegistry.stats.matters.conflicts).toHaveLength(1);
    expect(mergedRegistry.stats.matters.conflicts[0].idForm).toBe('uuid-001');
  });
});

// ---------------------------------------------------------------------------
// 9. Coverage stats and KnownGap
// ---------------------------------------------------------------------------

describe('coverage stats', () => {
  it('calculates matterMappingCoverage as percentage of records with both forms', () => {
    // 2 out of 4 matter records have both forms after applying registry
    const buildDatasets = {
      fullMattersJson: makeNormaliseResult('fullMattersJson', [
        { matterId: 'uuid-001', matterNumber: '1001' }, // has both
        { matterId: 'uuid-002', matterNumber: '1002' }, // has both
      ]),
    };
    const registry = buildCrossReferenceRegistry('firm-1', buildDatasets);

    const applyDatasets = {
      wipJson: makeNormaliseResult('wipJson', [
        { matterId: 'uuid-001' },    // will get matterNumber from registry → both
        { matterId: 'uuid-002' },    // will get matterNumber from registry → both
        { matterId: 'uuid-UNKNOWN' }, // not in registry → only one form
        { matterNumber: '9999' },    // not in registry → only one form
      ]),
    };

    const applied = applyRegistryToDatasets(applyDatasets, registry);

    // Count records that now have both forms
    const records = applied['wipJson'].records;
    const withBoth = records.filter(r => r.matterId && r.matterNumber).length;
    const coverage = (withBoth / records.length) * 100;

    expect(coverage).toBe(50); // 2/4 = 50%
  });

  it('LOW_IDENTIFIER_COVERAGE gap is included when coverage < 70%', () => {
    // Build registry but with only 1 mapping
    const buildDatasets = {
      fullMattersJson: makeNormaliseResult('fullMattersJson', [
        { matterId: 'uuid-001', matterNumber: '1001' },
      ]),
    };
    const registry = buildCrossReferenceRegistry('firm-1', buildDatasets);

    // Apply to a dataset where only 1/4 records will get resolved
    const applyDatasets = {
      wipJson: makeNormaliseResult('wipJson', [
        { matterId: 'uuid-001' },     // resolved → both
        { matterId: 'uuid-X1' },      // not in registry
        { matterId: 'uuid-X2' },      // not in registry
        { matterId: 'uuid-X3' },      // not in registry
      ]),
    };

    const applied = applyRegistryToDatasets(applyDatasets, registry);
    const records = applied['wipJson'].records;
    const withBoth = records.filter(r => r.matterId && r.matterNumber).length;
    const coverage = (withBoth / records.length) * 100;

    expect(coverage).toBe(25); // 1/4 = 25% — below 70% threshold
  });
});

// ---------------------------------------------------------------------------
// 10. buildCrossRefQualityStats + LOW_IDENTIFIER_COVERAGE gap (orchestrator)
// ---------------------------------------------------------------------------

import { buildCrossRefQualityStats, buildKnownGaps } from '../../../src/server/pipeline/pipeline-orchestrator.js';

describe('buildCrossRefQualityStats', () => {
  it('returns 100% coverage when all records have both identifier forms', () => {
    const registry = buildCrossReferenceRegistry('firm-1', {});
    const datasets = {
      wipJson: makeNormaliseResult('wipJson', [
        { matterId: 'uuid-001', matterNumber: '1001' },
        { matterId: 'uuid-002', matterNumber: '1002' },
      ]),
    };

    const stats = buildCrossRefQualityStats(datasets, registry);
    expect(stats.matterMappingCoverage).toBe(100);
    expect(stats.unresolvedMatterIds).toBe(0);
  });

  it('counts unresolvedMatterIds correctly', () => {
    const registry = buildCrossReferenceRegistry('firm-1', {});
    const datasets = {
      wipJson: makeNormaliseResult('wipJson', [
        { matterId: 'uuid-001' },   // only ID — unresolved
        { matterNumber: '1002' },   // only number — unresolved
        { matterId: 'uuid-003', matterNumber: '1003' }, // both — resolved
      ]),
    };

    const stats = buildCrossRefQualityStats(datasets, registry);
    expect(stats.unresolvedMatterIds).toBe(1);
    expect(stats.unresolvedMatterNumbers).toBe(1);
  });
});

describe('buildKnownGaps', () => {
  const baseStats = {
    feeEarnerMappingCoverage: 90,
    conflicts: [],
    unresolvedMatterIds: 0,
    unresolvedMatterNumbers: 0,
    unresolvedLawyerNames: [],
    wipOrphanCount: 0,
    wipTotalCount: 0,
    wipOrphanRate: 0,
  };

  it('emits LOW_IDENTIFIER_COVERAGE gap when matterMappingCoverage < 70', () => {
    const gaps = buildKnownGaps({ ...baseStats, matterMappingCoverage: 45, unresolvedMatterIds: 3, unresolvedMatterNumbers: 2 });
    expect(gaps.some(g => g.code === 'LOW_IDENTIFIER_COVERAGE')).toBe(true);
    const gap = gaps.find(g => g.code === 'LOW_IDENTIFIER_COVERAGE')!;
    expect(gap.severity).toBe('warning');
    expect(gap.message).toContain('45%');
  });

  it('does NOT emit LOW_IDENTIFIER_COVERAGE gap when coverage >= 70', () => {
    const gaps = buildKnownGaps({ ...baseStats, matterMappingCoverage: 85 });
    expect(gaps.some(g => g.code === 'LOW_IDENTIFIER_COVERAGE')).toBe(false);
  });

  it('emits WIP_ORPHAN_GAP when orphan rate exceeds default threshold (20%)', () => {
    const gaps = buildKnownGaps({ ...baseStats, matterMappingCoverage: 90, wipOrphanCount: 49, wipTotalCount: 100, wipOrphanRate: 49 });
    expect(gaps.some(g => g.code === 'WIP_ORPHAN_GAP')).toBe(true);
    const gap = gaps.find(g => g.code === 'WIP_ORPHAN_GAP')!;
    expect(gap.severity).toBe('warning');
    expect(gap.affectedCount).toBe(49);
  });

  it('does NOT emit WIP_ORPHAN_GAP when orphan rate is at or below default threshold', () => {
    const gaps = buildKnownGaps({ ...baseStats, matterMappingCoverage: 90, wipOrphanCount: 10, wipTotalCount: 100, wipOrphanRate: 10 });
    expect(gaps.some(g => g.code === 'WIP_ORPHAN_GAP')).toBe(false);
  });

  it('respects custom wipOrphanThreshold', () => {
    const stats = { ...baseStats, matterMappingCoverage: 90, wipOrphanCount: 15, wipTotalCount: 100, wipOrphanRate: 15 };
    expect(buildKnownGaps(stats, { wipOrphanThreshold: 10 }).some(g => g.code === 'WIP_ORPHAN_GAP')).toBe(true);
    expect(buildKnownGaps(stats, { wipOrphanThreshold: 20 }).some(g => g.code === 'WIP_ORPHAN_GAP')).toBe(false);
  });

  it('does NOT emit WIP_ORPHAN_GAP when wipTotalCount is 0 (no WIP data uploaded)', () => {
    const gaps = buildKnownGaps({ ...baseStats, matterMappingCoverage: 90 });
    expect(gaps.some(g => g.code === 'WIP_ORPHAN_GAP')).toBe(false);
  });
});
