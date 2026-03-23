# Cross-Reference Resolution Engine (1B-03b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Pipeline Stage 3 — a cross-reference engine that scans all normalised datasets for co-occurring identifier pairs, builds mapping dictionaries (matterId↔matterNumber, lawyerId↔lawyerName, contactId↔displayName, departmentId↔name), applies them to fill missing identifiers across all records, and persists the registry to MongoDB so it survives future uploads.

**Architecture:** The engine is a pure function (`buildCrossReferenceRegistry`) that accepts all normalised datasets and an optional existing registry, then extracts co-occurrences in priority order and merges with any persisted data. A second function (`applyRegistryToDatasets`) mutates normalised records in-place to fill missing identifier forms without touching existing values. The registry is serialised to MongoDB (Maps → plain objects) with upsert semantics — one document per firm, extended on each pipeline run.

**Tech Stack:** TypeScript (strict), Vitest, MongoDB via existing `getCollection()`, no new packages required.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/shared/types/pipeline.ts` | **Create** | `NormalisedRecord`, `NormaliseResult`, `CrossReferenceRegistry`, `CrossReferenceStats`, `CrossReferenceConflict`, `CrossReferenceRegistrySerialised`, `CrossReferenceQualityStats` |
| `src/shared/types/index.ts` | **Modify** | Extend `DataQualityReport` with `crossReference` field |
| `src/shared/types/mongodb.ts` | **Modify** | Add `CrossReferenceRegistryDocument` |
| `src/server/pipeline/cross-reference.ts` | **Create** | `buildCrossReferenceRegistry`, `applyRegistryToDatasets`, `serialiseRegistry`, `deserialiseRegistry`, name-variant utilities |
| `src/server/lib/mongodb-operations.ts` | **Modify** | Add `storeCrossReferenceRegistry`, `getCrossReferenceRegistry` |
| `src/server/pipeline/pipeline-orchestrator.ts` | **Create** | Stub orchestrator that wires Stage 3 in between stubbed Stage 2 and Stage 4 |
| `tests/server/pipeline/cross-reference.test.ts` | **Create** | All tests from spec |

---

## Task 1: Pipeline Types

**Files:**
- Create: `src/shared/types/pipeline.ts`
- Modify: `src/shared/types/index.ts` (lines 346–354, extend `DataQualityReport`)
- Modify: `src/shared/types/mongodb.ts` (append new interface)

No test needed for pure type definitions — type-check is the verification.

- [ ] **Step 1: Create `src/shared/types/pipeline.ts`**

```typescript
// src/shared/types/pipeline.ts
// Pipeline-specific types for Stages 2–8.
// These are separate from /src/shared/types/index.ts (entity/config types)
// to keep the files focused and to avoid circular imports.

// =============================================================================
// Stage 2: Normalise
// =============================================================================

/**
 * A single normalised record. All identifier fields are optional — the
 * cross-reference engine fills in the missing forms. Fields prefixed with _
 * are metadata (data provenance) and must never be shown to end users.
 */
export interface NormalisedRecord {
  // --- Matter identifiers ---
  matterId?: string;
  matterNumber?: string;
  _matterIdSource?: 'original' | 'cross_reference';
  _matterNumberSource?: 'original' | 'cross_reference';

  // --- Fee earner identifiers (WIP / time entries) ---
  lawyerId?: string;
  lawyerName?: string;
  _lawyerIdSource?: 'original' | 'cross_reference';
  _lawyerNameSource?: 'original' | 'cross_reference';

  // --- Responsible lawyer (matters / invoices use this field name) ---
  responsibleLawyerId?: string;
  responsibleLawyer?: string;
  _responsibleLawyerIdSource?: 'original' | 'cross_reference';
  _responsibleLawyerNameSource?: 'original' | 'cross_reference';

  // --- Client identifiers ---
  contactId?: string;
  displayName?: string;
  _contactIdSource?: 'original' | 'cross_reference';
  _displayNameSource?: 'original' | 'cross_reference';

  // --- Department identifiers ---
  departmentId?: string;
  department?: string;
  _departmentIdSource?: 'original' | 'cross_reference';
  _departmentNameSource?: 'original' | 'cross_reference';

  // All other domain fields (billing, dates, etc.)
  [key: string]: unknown;
}

/** Output of Stage 2 (Normalise). One NormaliseResult per uploaded file type. */
export interface NormaliseResult {
  fileType: string;
  records: NormalisedRecord[];
  recordCount: number;
  normalisedAt: string; // ISO timestamp
}

// =============================================================================
// Stage 3: Cross-Reference
// =============================================================================

export interface CrossReferenceRegistry {
  firmId: string;
  builtAt: string; // ISO timestamp

  matters: {
    idToNumber: Map<string, string>;   // matterId (UUID) → matterNumber (string)
    numberToId: Map<string, string>;   // matterNumber → matterId
    confidence: Map<string, 'certain' | 'inferred'>;  // keyed by matterId
    sourceDatasets: Map<string, string[]>;             // matterId → dataset names
  };

  feeEarners: {
    idToName: Map<string, string>;     // lawyerId → canonical display name
    nameToId: Map<string, string>;     // normalised name variant → lawyerId
    nameVariants: Map<string, string>; // name variant → canonical name
    confidence: Map<string, 'certain' | 'inferred'>;
    sourceDatasets: Map<string, string[]>;
  };

  clients: {
    idToName: Map<string, string>;     // contactId → displayName
    nameToId: Map<string, string>;     // normalised displayName → contactId
    confidence: Map<string, 'certain' | 'inferred'>;
    sourceDatasets: Map<string, string[]>;
  };

  departments: {
    idToName: Map<string, string>;     // departmentId → name
    nameToId: Map<string, string>;     // normalised name → departmentId
    confidence: Map<string, 'certain' | 'inferred'>;
    sourceDatasets: Map<string, string[]>;
  };

  stats: CrossReferenceStats;
}

export interface CrossReferenceStats {
  matters: {
    totalMappings: number;
    certainMappings: number;
    inferredMappings: number;
    conflictingMappings: number;
    conflicts: CrossReferenceConflict[];
  };
  feeEarners: {
    totalMappings: number;
    certainMappings: number;
    nameVariantsResolved: number;
    unresolvedNames: string[];
  };
  clients: {
    totalMappings: number;
    certainMappings: number;
  };
  departments: {
    totalMappings: number;
    certainMappings: number;
  };
}

export interface CrossReferenceConflict {
  entityType: 'matter' | 'feeEarner' | 'client' | 'department';
  idForm: string;
  mappingA: string;
  sourceA: string;
  mappingB: string;
  sourceB: string;
  resolution: 'kept_a' | 'kept_b' | 'flagged';
  resolutionReason: string;
}

/**
 * Serialised form of CrossReferenceRegistry — all Maps converted to plain
 * objects so the registry can be stored as JSON in MongoDB.
 */
export interface CrossReferenceRegistrySerialised {
  firmId: string;
  builtAt: string;
  matters: {
    idToNumber: Record<string, string>;
    numberToId: Record<string, string>;
    confidence: Record<string, 'certain' | 'inferred'>;
    sourceDatasets: Record<string, string[]>;
  };
  feeEarners: {
    idToName: Record<string, string>;
    nameToId: Record<string, string>;
    nameVariants: Record<string, string>;
    confidence: Record<string, 'certain' | 'inferred'>;
    sourceDatasets: Record<string, string[]>;
  };
  clients: {
    idToName: Record<string, string>;
    nameToId: Record<string, string>;
    confidence: Record<string, 'certain' | 'inferred'>;
    sourceDatasets: Record<string, string[]>;
  };
  departments: {
    idToName: Record<string, string>;
    nameToId: Record<string, string>;
    confidence: Record<string, 'certain' | 'inferred'>;
    sourceDatasets: Record<string, string[]>;
  };
  stats: CrossReferenceStats;
}

/** Added to DataQualityReport.crossReference */
export interface CrossReferenceQualityStats {
  matterMappingCoverage: number;       // % of matter records with both ID forms
  feeEarnerMappingCoverage: number;    // % of fee earner refs with both ID + name
  conflicts: CrossReferenceConflict[];
  unresolvedMatterIds: number;
  unresolvedMatterNumbers: number;
  unresolvedLawyerNames: string[];
}
```

- [ ] **Step 2: Extend `DataQualityReport` in `src/shared/types/index.ts`**

Find the `DataQualityReport` interface (around line 346) and add the `crossReference` field and `KnownGap` type:

```typescript
// Add import at top of file (after existing imports):
import type { CrossReferenceQualityStats } from './pipeline.js';

// Extend the existing DataQualityReport interface:
export interface DataQualityReport {
  firmId: string;
  generatedAt: Date;
  totalEntities: number;
  issueCount: number;
  issues: DataQualityIssue[];
  qualityScore: number;
  // Added by Stage 3:
  crossReference?: CrossReferenceQualityStats;
  knownGaps?: KnownGap[];
}

// Add new KnownGap type after DataQualityIssue:
export type KnownGapCode = 'WIP_ORPHAN_GAP' | 'LOW_IDENTIFIER_COVERAGE';

export interface KnownGap {
  code: KnownGapCode;
  message: string;
  severity: 'warning' | 'info';
  affectedCount?: number;
}
```

- [ ] **Step 3: Add MongoDB document interface to `src/shared/types/mongodb.ts`**

```typescript
// Add to the imports at the top of the file:
import type { CrossReferenceRegistrySerialised } from './pipeline.js';

// Append to end of file:
/**
 * MongoDB document for cross_reference_registries collection.
 * One document per firm — upserted on every pipeline run.
 * The `data` field embeds the full serialised registry.
 * Uses `updated_at` (not `created_at`) because this is upserted — the field
 * always reflects the last write, not the original creation time.
 */
export interface CrossReferenceRegistryDocument {
  _id?: ObjectId;
  firm_id: string;
  data: CrossReferenceRegistrySerialised;
  updated_at: Date;
}
```

- [ ] **Step 4: Type-check only — no code to run yet**

```bash
cd C:\Projects\yao-mind && npx tsc --noEmit 2>&1 | head -30
```

Expected: zero errors (or only pre-existing errors unrelated to pipeline.ts).

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/pipeline.ts src/shared/types/index.ts src/shared/types/mongodb.ts
git commit -m "feat: add pipeline, cross-reference, and known-gap types"
```

---

## Task 2: Write Failing Tests

**Files:**
- Create: `tests/server/pipeline/cross-reference.test.ts`

Write ALL tests first. They will fail because `cross-reference.ts` doesn't exist yet. This defines the contract for the implementation.

- [ ] **Step 1: Create `tests/server/pipeline/cross-reference.test.ts`**

```typescript
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
  it('emits LOW_IDENTIFIER_COVERAGE gap when matterMappingCoverage < 70', () => {
    const gaps = buildKnownGaps({ matterMappingCoverage: 45, feeEarnerMappingCoverage: 80, conflicts: [], unresolvedMatterIds: 3, unresolvedMatterNumbers: 2, unresolvedLawyerNames: [] });
    expect(gaps.some(g => g.code === 'LOW_IDENTIFIER_COVERAGE')).toBe(true);
    const gap = gaps.find(g => g.code === 'LOW_IDENTIFIER_COVERAGE')!;
    expect(gap.severity).toBe('warning');
    expect(gap.message).toContain('45%');
  });

  it('does NOT emit LOW_IDENTIFIER_COVERAGE gap when coverage >= 70', () => {
    const gaps = buildKnownGaps({ matterMappingCoverage: 85, feeEarnerMappingCoverage: 90, conflicts: [], unresolvedMatterIds: 0, unresolvedMatterNumbers: 0, unresolvedLawyerNames: [] });
    expect(gaps.some(g => g.code === 'LOW_IDENTIFIER_COVERAGE')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to confirm they all fail (module not found)**

```bash
cd C:\Projects\yao-mind && npx vitest run tests/server/pipeline/cross-reference.test.ts 2>&1 | tail -20
```

Expected: errors like `Cannot find module '../../../src/server/pipeline/cross-reference.js'`

---

## Task 3: Name Normalisation + Core Engine Skeleton

**Files:**
- Create: `src/server/pipeline/cross-reference.ts`

Create the file with only the name normalisation utilities and exported function stubs. This unblocks the import errors in tests.

- [ ] **Step 1: Create `src/server/pipeline/cross-reference.ts` with stubs + name utilities**

```typescript
// src/server/pipeline/cross-reference.ts
//
// Pipeline Stage 3: Cross-Reference Resolution
//
// Scans normalised datasets for co-occurring identifier pairs and builds
// mapping dictionaries. Applies the dictionaries back to fill in missing
// identifier forms across every dataset.

import type {
  NormaliseResult,
  NormalisedRecord,
  CrossReferenceRegistry,
  CrossReferenceRegistrySerialised,
  CrossReferenceConflict,
  CrossReferenceStats,
} from '@shared/types/pipeline.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Dataset priority order for conflict resolution (highest quality first). */
const DATASET_PRIORITY: string[] = [
  'fullMattersJson',
  'closedMattersJson',
  'wipJson',
  'invoicesJson',
  'disbursementsJson',
  'tasksJson',
  'feeEarnerCsv',
  'contactsJson',
];

function datasetPriority(name: string): number {
  const idx = DATASET_PRIORITY.indexOf(name);
  return idx === -1 ? DATASET_PRIORITY.length : idx;
}

// ---------------------------------------------------------------------------
// Name normalisation
// ---------------------------------------------------------------------------

const TITLE_PATTERN = /^(mr|mrs|ms|dr|prof|sir)\.?\s+/i;

/**
 * Normalise a person's name for use as a dictionary key.
 * Strips titles, lowercases, and trims whitespace.
 */
export function normaliseNameForLookup(name: string): string {
  return name.trim().replace(TITLE_PATTERN, '').toLowerCase().trim();
}

/**
 * Generate all plausible lookup variants for a full name.
 * e.g., 'John Smith' → ['john smith', 'smith', 'j smith', 'j. smith',
 *                        'smith john', 'smith, john', 'smith j', 'smith, j.']
 */
export function generateNameVariants(name: string): string[] {
  const base = normaliseNameForLookup(name);
  const parts = base.split(/\s+/).filter(Boolean);

  if (parts.length < 2) {
    return [base]; // cannot derive variants from a single token
  }

  const first = parts[0];
  const last = parts[parts.length - 1];
  const initial = first[0];

  return [
    base,                            // 'john smith'
    last,                            // 'smith'
    `${initial} ${last}`,            // 'j smith'
    `${initial}. ${last}`,           // 'j. smith'
    `${last} ${first}`,              // 'smith john'
    `${last}, ${first}`,             // 'smith, john'
    `${last} ${initial}`,            // 'smith j'
    `${last}, ${initial}`,           // 'smith, j'
    `${last}, ${initial}.`,          // 'smith, j.'
  ].filter(v => v.length > 0);
}

// ---------------------------------------------------------------------------
// Empty registry factory
// ---------------------------------------------------------------------------

function emptyRegistry(firmId: string): CrossReferenceRegistry {
  return {
    firmId,
    builtAt: new Date().toISOString(),
    matters: {
      idToNumber: new Map(),
      numberToId: new Map(),
      confidence: new Map(),
      sourceDatasets: new Map(),
    },
    feeEarners: {
      idToName: new Map(),
      nameToId: new Map(),
      nameVariants: new Map(),
      confidence: new Map(),
      sourceDatasets: new Map(),
    },
    clients: {
      idToName: new Map(),
      nameToId: new Map(),
      confidence: new Map(),
      sourceDatasets: new Map(),
    },
    departments: {
      idToName: new Map(),
      nameToId: new Map(),
      confidence: new Map(),
      sourceDatasets: new Map(),
    },
    stats: emptyStats(),
  };
}

function emptyStats(): CrossReferenceStats {
  return {
    matters: {
      totalMappings: 0,
      certainMappings: 0,
      inferredMappings: 0,
      conflictingMappings: 0,
      conflicts: [],
    },
    feeEarners: {
      totalMappings: 0,
      certainMappings: 0,
      nameVariantsResolved: 0,
      unresolvedNames: [],
    },
    clients: {
      totalMappings: 0,
      certainMappings: 0,
    },
    departments: {
      totalMappings: 0,
      certainMappings: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API (stubs — implemented in following tasks)
// ---------------------------------------------------------------------------

export function buildCrossReferenceRegistry(
  firmId: string,
  normalisedDatasets: Record<string, NormaliseResult>,
  existingRegistry?: CrossReferenceRegistry
): CrossReferenceRegistry {
  const registry = existingRegistry
    ? cloneRegistry(existingRegistry, firmId)
    : emptyRegistry(firmId);

  // Extract matter mappings
  extractMatterMappings(registry, normalisedDatasets);

  // Extract fee earner mappings
  extractFeeEarnerMappings(registry, normalisedDatasets);

  // Extract client mappings
  extractClientMappings(registry, normalisedDatasets);

  // Extract department mappings
  extractDepartmentMappings(registry, normalisedDatasets);

  // Recompute stats
  registry.stats = computeStats(registry);
  registry.builtAt = new Date().toISOString();

  return registry;
}

export function applyRegistryToDatasets(
  normalisedDatasets: Record<string, NormaliseResult>,
  registry: CrossReferenceRegistry
): Record<string, NormaliseResult> {
  const result: Record<string, NormaliseResult> = {};

  for (const [fileType, dataset] of Object.entries(normalisedDatasets)) {
    const enrichedRecords = dataset.records.map(record =>
      applyRegistryToRecord(record, registry)
    );
    result[fileType] = { ...dataset, records: enrichedRecords };
  }

  return result;
}

export function serialiseRegistry(
  registry: CrossReferenceRegistry
): CrossReferenceRegistrySerialised {
  return {
    firmId: registry.firmId,
    builtAt: registry.builtAt,
    matters: {
      idToNumber: Object.fromEntries(registry.matters.idToNumber),
      numberToId: Object.fromEntries(registry.matters.numberToId),
      confidence: Object.fromEntries(registry.matters.confidence),
      sourceDatasets: Object.fromEntries(registry.matters.sourceDatasets),
    },
    feeEarners: {
      idToName: Object.fromEntries(registry.feeEarners.idToName),
      nameToId: Object.fromEntries(registry.feeEarners.nameToId),
      nameVariants: Object.fromEntries(registry.feeEarners.nameVariants),
      confidence: Object.fromEntries(registry.feeEarners.confidence),
      sourceDatasets: Object.fromEntries(registry.feeEarners.sourceDatasets),
    },
    clients: {
      idToName: Object.fromEntries(registry.clients.idToName),
      nameToId: Object.fromEntries(registry.clients.nameToId),
      confidence: Object.fromEntries(registry.clients.confidence),
      sourceDatasets: Object.fromEntries(registry.clients.sourceDatasets),
    },
    departments: {
      idToName: Object.fromEntries(registry.departments.idToName),
      nameToId: Object.fromEntries(registry.departments.nameToId),
      confidence: Object.fromEntries(registry.departments.confidence),
      sourceDatasets: Object.fromEntries(registry.departments.sourceDatasets),
    },
    stats: registry.stats,
  };
}

export function deserialiseRegistry(
  s: CrossReferenceRegistrySerialised
): CrossReferenceRegistry {
  return {
    firmId: s.firmId,
    builtAt: s.builtAt,
    matters: {
      idToNumber: new Map(Object.entries(s.matters.idToNumber)),
      numberToId: new Map(Object.entries(s.matters.numberToId)),
      confidence: new Map(Object.entries(s.matters.confidence)),
      sourceDatasets: new Map(Object.entries(s.matters.sourceDatasets)),
    },
    feeEarners: {
      idToName: new Map(Object.entries(s.feeEarners.idToName)),
      nameToId: new Map(Object.entries(s.feeEarners.nameToId)),
      nameVariants: new Map(Object.entries(s.feeEarners.nameVariants)),
      confidence: new Map(Object.entries(s.feeEarners.confidence)),
      sourceDatasets: new Map(Object.entries(s.feeEarners.sourceDatasets)),
    },
    clients: {
      idToName: new Map(Object.entries(s.clients.idToName)),
      nameToId: new Map(Object.entries(s.clients.nameToId)),
      confidence: new Map(Object.entries(s.clients.confidence)),
      sourceDatasets: new Map(Object.entries(s.clients.sourceDatasets)),
    },
    departments: {
      idToName: new Map(Object.entries(s.departments.idToName)),
      nameToId: new Map(Object.entries(s.departments.nameToId)),
      confidence: new Map(Object.entries(s.departments.confidence)),
      sourceDatasets: new Map(Object.entries(s.departments.sourceDatasets)),
    },
    stats: s.stats,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers (stubs — filled in below)
// ---------------------------------------------------------------------------

function cloneRegistry(src: CrossReferenceRegistry, firmId: string): CrossReferenceRegistry {
  // Deserialise from serialised form to deep-clone all Maps
  return deserialiseRegistry({ ...serialiseRegistry(src), firmId });
}

function extractMatterMappings(
  registry: CrossReferenceRegistry,
  datasets: Record<string, NormaliseResult>
): void {
  // Process datasets in priority order
  const orderedEntries = Object.entries(datasets).sort(
    ([a], [b]) => datasetPriority(a) - datasetPriority(b)
  );

  for (const [datasetName, dataset] of orderedEntries) {
    for (const record of dataset.records) {
      const matterId = asString(record.matterId);
      const matterNumber = asString(record.matterNumber);

      if (!matterId || !matterNumber) continue; // no co-occurrence

      const existingNumber = registry.matters.idToNumber.get(matterId);

      if (existingNumber === undefined) {
        // New mapping — add it
        registry.matters.idToNumber.set(matterId, matterNumber);
        registry.matters.numberToId.set(matterNumber, matterId);
        registry.matters.confidence.set(matterId, 'certain');
        registry.matters.sourceDatasets.set(matterId, [datasetName]);
      } else if (existingNumber !== matterNumber) {
        // Conflict — log it; keep the existing (higher priority) value
        const sources = registry.matters.sourceDatasets.get(matterId) ?? [];
        const sourceA = sources[0] ?? 'unknown';

        registry.stats.matters.conflicts.push({
          entityType: 'matter',
          idForm: matterId,
          mappingA: existingNumber,
          sourceA,
          mappingB: matterNumber,
          sourceB: datasetName,
          resolution: 'kept_a',
          resolutionReason: `${sourceA} has higher priority than ${datasetName}`,
        });
      } else {
        // Corroborating mapping — add source
        const sources = registry.matters.sourceDatasets.get(matterId) ?? [];
        if (!sources.includes(datasetName)) {
          registry.matters.sourceDatasets.set(matterId, [...sources, datasetName]);
        }
      }
    }
  }
}

function extractFeeEarnerMappings(
  registry: CrossReferenceRegistry,
  datasets: Record<string, NormaliseResult>
): void {
  const orderedEntries = Object.entries(datasets).sort(
    ([a], [b]) => datasetPriority(a) - datasetPriority(b)
  );

  for (const [datasetName, dataset] of orderedEntries) {
    for (const record of dataset.records) {
      // Primary: lawyerId + lawyerName
      tryRegisterFeeEarner(
        registry,
        asString(record.lawyerId),
        asString(record.lawyerName),
        datasetName
      );

      // Responsible lawyer fields (used in matters/invoices)
      tryRegisterFeeEarner(
        registry,
        asString(record.responsibleLawyerId),
        asString(record.responsibleLawyer),
        datasetName
      );
    }
  }
}

function tryRegisterFeeEarner(
  registry: CrossReferenceRegistry,
  lawyerId: string | null,
  lawyerName: string | null,
  datasetName: string
): void {
  if (!lawyerId || !lawyerName) return;

  const existing = registry.feeEarners.idToName.get(lawyerId);

  if (existing === undefined) {
    registry.feeEarners.idToName.set(lawyerId, lawyerName);
    registry.feeEarners.confidence.set(lawyerId, 'certain');
    registry.feeEarners.sourceDatasets.set(lawyerId, [datasetName]);

    // Register all name variants → lawyerId
    const variants = generateNameVariants(lawyerName);
    for (const variant of variants) {
      if (!registry.feeEarners.nameToId.has(variant)) {
        registry.feeEarners.nameToId.set(variant, lawyerId);
      }
      // Record canonical name for each variant
      if (!registry.feeEarners.nameVariants.has(variant)) {
        registry.feeEarners.nameVariants.set(variant, lawyerName);
      }
    }
  }
}

function extractClientMappings(
  registry: CrossReferenceRegistry,
  datasets: Record<string, NormaliseResult>
): void {
  const orderedEntries = Object.entries(datasets).sort(
    ([a], [b]) => datasetPriority(a) - datasetPriority(b)
  );

  for (const [datasetName, dataset] of orderedEntries) {
    for (const record of dataset.records) {
      const contactId = asString(record.contactId);
      const displayName = asString(record.displayName);

      if (!contactId || !displayName) continue;

      if (!registry.clients.idToName.has(contactId)) {
        registry.clients.idToName.set(contactId, displayName);
        registry.clients.nameToId.set(displayName.toLowerCase(), contactId);
        registry.clients.confidence.set(contactId, 'certain');
        registry.clients.sourceDatasets.set(contactId, [datasetName]);
      }
    }
  }
}

function extractDepartmentMappings(
  registry: CrossReferenceRegistry,
  datasets: Record<string, NormaliseResult>
): void {
  const orderedEntries = Object.entries(datasets).sort(
    ([a], [b]) => datasetPriority(a) - datasetPriority(b)
  );

  for (const [datasetName, dataset] of orderedEntries) {
    for (const record of dataset.records) {
      const departmentId = asString(record.departmentId);
      const departmentName = asString(record.department);

      if (!departmentId || !departmentName) continue;

      if (!registry.departments.idToName.has(departmentId)) {
        registry.departments.idToName.set(departmentId, departmentName);
        registry.departments.nameToId.set(departmentName.toLowerCase(), departmentId);
        registry.departments.confidence.set(departmentId, 'certain');
        registry.departments.sourceDatasets.set(departmentId, [datasetName]);
      }
    }
  }
}

function applyRegistryToRecord(
  record: NormalisedRecord,
  registry: CrossReferenceRegistry
): NormalisedRecord {
  const result = { ...record };

  // Matter: fill matterNumber from matterId
  if (result.matterId && !result.matterNumber) {
    const matterNumber = registry.matters.idToNumber.get(result.matterId);
    if (matterNumber) {
      result.matterNumber = matterNumber;
      result._matterNumberSource = 'cross_reference';
    }
  }

  // Matter: fill matterId from matterNumber
  if (result.matterNumber && !result.matterId) {
    const matterId = registry.matters.numberToId.get(String(result.matterNumber));
    if (matterId) {
      result.matterId = matterId;
      result._matterIdSource = 'cross_reference';
    }
  }

  // Fee earner: fill lawyerName from lawyerId
  if (result.lawyerId && !result.lawyerName) {
    const name = registry.feeEarners.idToName.get(result.lawyerId);
    if (name) {
      result.lawyerName = name;
      result._lawyerNameSource = 'cross_reference';
    }
  }

  // Fee earner: fill lawyerId from lawyerName
  if (result.lawyerName && !result.lawyerId) {
    const normalised = normaliseNameForLookup(String(result.lawyerName));
    const id = registry.feeEarners.nameToId.get(normalised);
    if (id) {
      result.lawyerId = id;
      result._lawyerIdSource = 'cross_reference';
    }
  }

  // Client: fill displayName from contactId
  if (result.contactId && !result.displayName) {
    const name = registry.clients.idToName.get(result.contactId);
    if (name) {
      result.displayName = name;
      result._displayNameSource = 'cross_reference';
    }
  }

  // Client: fill contactId from displayName
  if (result.displayName && !result.contactId) {
    const id = registry.clients.nameToId.get(String(result.displayName).toLowerCase());
    if (id) {
      result.contactId = id;
      result._contactIdSource = 'cross_reference';
    }
  }

  // Department: fill department name from departmentId
  if (result.departmentId && !result.department) {
    const name = registry.departments.idToName.get(result.departmentId);
    if (name) {
      result.department = name;
      result._departmentNameSource = 'cross_reference';
    }
  }

  // Department: fill departmentId from department name
  if (result.department && !result.departmentId) {
    const id = registry.departments.nameToId.get(String(result.department).toLowerCase());
    if (id) {
      result.departmentId = id;
      result._departmentIdSource = 'cross_reference';
    }
  }

  return result;
}

function computeStats(registry: CrossReferenceRegistry): CrossReferenceStats {
  const matters = registry.matters;
  const fe = registry.feeEarners;

  const totalMatterMappings = matters.idToNumber.size;
  let certainMatter = 0;
  let inferredMatter = 0;
  for (const [id] of matters.idToNumber) {
    const conf = matters.confidence.get(id);
    if (conf === 'certain') certainMatter++;
    else inferredMatter++;
  }

  const totalFeMappings = fe.idToName.size;
  let certainFe = 0;
  for (const [id] of fe.idToName) {
    if (fe.confidence.get(id) === 'certain') certainFe++;
  }

  return {
    matters: {
      totalMappings: totalMatterMappings,
      certainMappings: certainMatter,
      inferredMappings: inferredMatter,
      conflictingMappings: registry.stats.matters.conflicts.length,
      conflicts: registry.stats.matters.conflicts, // preserve accumulated conflicts
    },
    feeEarners: {
      totalMappings: totalFeMappings,
      certainMappings: certainFe,
      nameVariantsResolved: fe.nameToId.size,
      unresolvedNames: [], // populated in data-quality step
    },
    clients: {
      totalMappings: registry.clients.idToName.size,
      certainMappings: [...registry.clients.confidence.values()].filter(c => c === 'certain').length,
    },
    departments: {
      totalMappings: registry.departments.idToName.size,
      certainMappings: [...registry.departments.confidence.values()].filter(c => c === 'certain').length,
    },
  };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number') return String(value);
  return null;
}
```

- [ ] **Step 2: Run the tests**

```bash
cd C:\Projects\yao-mind && npx vitest run tests/server/pipeline/cross-reference.test.ts 2>&1 | tail -40
```

Expected: most tests pass. Fix any remaining failures before moving on.

- [ ] **Step 3: Type-check**

```bash
cd C:\Projects\yao-mind && npx tsc --noEmit 2>&1 | head -30
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/pipeline/cross-reference.ts tests/server/pipeline/cross-reference.test.ts
git commit -m "feat: cross-reference engine — extraction, apply, serialise, and name variants"
```

---

## Task 4: MongoDB Operations

**Files:**
- Modify: `src/server/lib/mongodb-operations.ts`

No unit tests for DB layer (requires MongoDB connection) — type-check is verification.

- [ ] **Step 1: Add imports to `mongodb-operations.ts`**

At the top of the file, add:

```typescript
import type { CrossReferenceRegistryDocument } from '@shared/types/mongodb.js';
import type { CrossReferenceRegistrySerialised } from '@shared/types/pipeline.js';
```

- [ ] **Step 2: Append to `mongodb-operations.ts`**

```typescript
// ---------------------------------------------------------------------------
// cross_reference_registries
// ---------------------------------------------------------------------------

/**
 * Persist (upsert) the cross-reference registry for a firm.
 * One document per firm — replaced on every pipeline run.
 * Maps must be serialised to plain objects before calling this.
 */
export async function storeCrossReferenceRegistry(
  firmId: string,
  registry: CrossReferenceRegistrySerialised
): Promise<void> {
  const col = await getCollection<CrossReferenceRegistryDocument>(
    'cross_reference_registries'
  );
  const doc: CrossReferenceRegistryDocument = {
    firm_id: firmId,
    data: registry,
    updated_at: new Date(),
  };
  await col.replaceOne(
    { firm_id: firmId },
    doc,
    { upsert: true }
  );
}

/**
 * Load the most recently persisted cross-reference registry for a firm.
 * Returns null if no registry has been built yet.
 */
export async function getCrossReferenceRegistry(
  firmId: string
): Promise<CrossReferenceRegistrySerialised | null> {
  const col = await getCollection<CrossReferenceRegistryDocument>(
    'cross_reference_registries'
  );
  const doc = await col.findOne({ firm_id: firmId });
  return doc?.data ?? null;
}
```

- [ ] **Step 3: Type-check**

```bash
cd C:\Projects\yao-mind && npx tsc --noEmit 2>&1 | head -30
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/lib/mongodb-operations.ts src/shared/types/mongodb.ts
git commit -m "feat: MongoDB operations for cross-reference registry persistence"
```

---

## Task 5: Pipeline Orchestrator Stub

**Files:**
- Create: `src/server/pipeline/pipeline-orchestrator.ts`

The orchestrator coordinates all 8 pipeline stages. Stages 1, 2, 4–8 are stubs for now. Stage 3 is fully implemented.

- [ ] **Step 1: Create `src/server/pipeline/pipeline-orchestrator.ts`**

```typescript
// src/server/pipeline/pipeline-orchestrator.ts
//
// Pipeline Orchestrator
//
// Coordinates the 8-stage processing pipeline:
//   1. Parse        (client-side — input arrives already parsed)
//   2. Normalise    (stub — implemented in 1B-04)
//   3. Cross-Reference ← IMPLEMENTED (this prompt, 1B-03b)
//   4. Index        (stub — implemented in 1B-05)
//   5. Join         (stub)
//   6. Enrich       (stub)
//   7. Aggregate    (stub)
//   8. Calculate    (stub)
//
// Stages run in sequence. Each stage receives the output of the previous one.

import {
  buildCrossReferenceRegistry,
  applyRegistryToDatasets,
  serialiseRegistry,
  deserialiseRegistry,
} from '../pipeline/cross-reference.js';
import {
  storeCrossReferenceRegistry,
  getCrossReferenceRegistry,
} from '../lib/mongodb-operations.js';
import type { NormaliseResult, CrossReferenceRegistry } from '@shared/types/pipeline.js';
import type { DataQualityReport } from '@shared/types/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PipelineInput {
  firmId: string;
  /**
   * One entry per uploaded file type. In production this comes from Stage 2
   * (Normalise). Until Stage 2 is implemented, callers can pass pre-normalised
   * records directly.
   */
  normalisedDatasets: Record<string, NormaliseResult>;
}

export interface PipelineResult {
  firmId: string;
  completedAt: string;
  crossReferenceRegistry: CrossReferenceRegistry;
  /** Enriched datasets after all stages have run. */
  enrichedDatasets: Record<string, NormaliseResult>;
  dataQuality: Partial<DataQualityReport>;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const { firmId, normalisedDatasets } = input;

  // -------------------------------------------------------------------------
  // Stage 2: Normalise — stub (pass-through until 1B-04)
  // -------------------------------------------------------------------------
  const stageOneOutput = normalisedDatasets;

  // -------------------------------------------------------------------------
  // Stage 3: Cross-Reference Resolution
  // -------------------------------------------------------------------------

  // Load existing registry from MongoDB (null if first run for this firm)
  const existing = await getCrossReferenceRegistry(firmId);
  const existingRegistry = existing ? deserialiseRegistry(existing) : undefined;

  // Build updated registry (merges with existing if present)
  const crossReferenceRegistry = buildCrossReferenceRegistry(
    firmId,
    stageOneOutput,
    existingRegistry
  );

  // Apply registry to fill in missing identifiers across all datasets
  const enrichedAfterCrossRef = applyRegistryToDatasets(
    stageOneOutput,
    crossReferenceRegistry
  );

  // Persist updated registry to MongoDB
  await storeCrossReferenceRegistry(firmId, serialiseRegistry(crossReferenceRegistry));

  // -------------------------------------------------------------------------
  // Stages 4–8: stubs (pass-through until implemented)
  // -------------------------------------------------------------------------
  const enrichedDatasets = enrichedAfterCrossRef;

  // -------------------------------------------------------------------------
  // Data quality report (partial — cross-reference section only for now)
  // -------------------------------------------------------------------------
  const crossRefStats = buildCrossRefQualityStats(enrichedDatasets, crossReferenceRegistry);
  const dataQuality: Partial<DataQualityReport> = {
    firmId,
    generatedAt: new Date(),
    crossReference: crossRefStats,
    knownGaps: buildKnownGaps(crossRefStats),
  };

  return {
    firmId,
    completedAt: new Date().toISOString(),
    crossReferenceRegistry,
    enrichedDatasets,
    dataQuality,
  };
}

// ---------------------------------------------------------------------------
// Exported helpers (also used in tests)
// ---------------------------------------------------------------------------

export function buildCrossRefQualityStats(
  datasets: Record<string, NormaliseResult>,
  registry: CrossReferenceRegistry
) {
  // Count matter records with both forms across all datasets
  let totalMatterRefs = 0;
  let matterRefsWithBoth = 0;
  let unresolvedMatterIds = 0;
  let unresolvedMatterNumbers = 0;

  // Count fee earner refs with both forms
  let totalFeRefs = 0;
  let feRefsWithBoth = 0;
  const unresolvedLawyerNames: string[] = [];

  for (const dataset of Object.values(datasets)) {
    for (const record of dataset.records) {
      const hasMatterId = Boolean(record.matterId);
      const hasMatterNumber = Boolean(record.matterNumber);

      if (hasMatterId || hasMatterNumber) {
        totalMatterRefs++;
        if (hasMatterId && hasMatterNumber) matterRefsWithBoth++;
        if (hasMatterId && !hasMatterNumber) unresolvedMatterIds++;
        if (hasMatterNumber && !hasMatterId) unresolvedMatterNumbers++;
      }

      const hasLawyerId = Boolean(record.lawyerId);
      const hasLawyerName = Boolean(record.lawyerName);

      if (hasLawyerId || hasLawyerName) {
        totalFeRefs++;
        if (hasLawyerId && hasLawyerName) feRefsWithBoth++;
        if (hasLawyerName && !hasLawyerId) {
          unresolvedLawyerNames.push(String(record.lawyerName));
        }
      }
    }
  }

  const matterMappingCoverage =
    totalMatterRefs === 0 ? 100 : (matterRefsWithBoth / totalMatterRefs) * 100;
  const feeEarnerMappingCoverage =
    totalFeRefs === 0 ? 100 : (feRefsWithBoth / totalFeRefs) * 100;

  return {
    matterMappingCoverage,
    feeEarnerMappingCoverage,
    conflicts: registry.stats.matters.conflicts,
    unresolvedMatterIds,
    unresolvedMatterNumbers,
    unresolvedLawyerNames: [...new Set(unresolvedLawyerNames)],
  };
}

export function buildKnownGaps(
  crossRef: ReturnType<typeof buildCrossRefQualityStats>
): import('@shared/types/index.js').KnownGap[] {
  const gaps: import('@shared/types/index.js').KnownGap[] = [];

  if (crossRef.matterMappingCoverage < 70) {
    const pct = Math.round(crossRef.matterMappingCoverage);
    gaps.push({
      code: 'LOW_IDENTIFIER_COVERAGE',
      message:
        `${pct}% of matter references across your datasets use inconsistent identifiers ` +
        `(some use matter ID, others use matter number). This reduces join accuracy. ` +
        `Ensure your Full Matters export includes both matterId and matterNumber columns.`,
      severity: 'warning',
      affectedCount: crossRef.unresolvedMatterIds,
    });
  }

  return gaps;
}
```

- [ ] **Step 2: Type-check**

```bash
cd C:\Projects\yao-mind && npx tsc --noEmit 2>&1 | head -30
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/pipeline/pipeline-orchestrator.ts
git commit -m "feat: pipeline orchestrator stub — stage 3 wired between stage 2 and 4"
```

---

## Task 6: Full Test Run + Verification

- [ ] **Step 1: Run all tests**

```bash
cd C:\Projects\yao-mind && npx vitest run 2>&1 | tail -40
```

Expected: all tests pass, zero failures.

- [ ] **Step 2: Final type-check**

```bash
cd C:\Projects\yao-mind && npx tsc --noEmit 2>&1
```

Expected: zero errors.

- [ ] **Step 3: Verify checklist from spec**

Run mentally through the spec's verification list:
- [ ] `buildCrossReferenceRegistry` extracts from all 6 matter datasets in priority order
- [ ] `applyRegistryToDatasets` fills missing identifiers, never overwrites existing
- [ ] `_fieldSource` metadata set on every cross-referenced fill
- [ ] 'J. Smith', 'Smith, J.', 'JOHN SMITH', 'John Smith' all map to same lawyerId
- [ ] Conflicts detected, logged with priority resolution
- [ ] Registry serialises/deserialises (Maps → plain objects → Maps)
- [ ] Existing registry + new dataset → merged, not replaced
- [ ] Pipeline orchestrator runs Stage 3 after Stage 2 stub, before Stage 4 stub
- [ ] Data quality report includes crossReference stats + LOW_IDENTIFIER_COVERAGE gap
- [ ] All tests pass

- [ ] **Step 4: Verify checklist from spec (expanded)**

- [ ] `buildCrossReferenceRegistry` extracts from all 6 matter datasets in priority order (fullMatters > closedMatters > wip > invoices > disbursements > tasks)
- [ ] `applyRegistryToDatasets` fills missing identifiers, never overwrites existing
- [ ] `_fieldSource` metadata set on every cross-referenced fill
- [ ] `normaliseNameForLookup('JOHN SMITH')` returns `'john smith'` ← tested explicitly
- [ ] `normaliseNameForLookup('J. Smith')` returns `'j. smith'` ← tested explicitly
- [ ] 'J. Smith', 'Smith, J.', 'JOHN SMITH', 'John Smith' all map to same lawyerId ← tested
- [ ] Conflicts detected, logged, resolved in priority order
- [ ] Conflicts from first registry run preserved in merged registry ← tested
- [ ] Registry serialises/deserialises (Maps → plain objects → Maps) ← tested
- [ ] Existing registry + new dataset → merged, not replaced ← tested
- [ ] Orchestrator at `src/server/pipeline/pipeline-orchestrator.ts`, imports cross-reference
- [ ] `buildCrossRefQualityStats` and `buildKnownGaps` exported for testability
- [ ] `LOW_IDENTIFIER_COVERAGE` gap emitted when coverage < 70% ← tested via `buildKnownGaps`
- [ ] `CrossReferenceRegistryDocument` has `_id?: ObjectId` and `updated_at`
- [ ] All tests pass

- [ ] **Step 5: Final commit and push**

```bash
cd C:\Projects\yao-mind && git add -A && git commit -m "feat: cross-reference resolution engine - identifier mapping dictionaries across all datasets" && git push
```
