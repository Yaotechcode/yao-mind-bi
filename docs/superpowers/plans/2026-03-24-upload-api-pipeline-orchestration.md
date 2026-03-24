# Upload API + Pipeline Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Upload API endpoints and a full-pipeline orchestrator that receives parsed file data from the client, runs Stages 2–7 in sequence, and persists enriched entities + cross-reference registry to MongoDB.

**Architecture:** The Netlify Function `upload.ts` validates + authenticates the request, then delegates all pipeline logic to `runFullPipeline()` in `pipeline-orchestrator.ts`. The orchestrator loads prior normalised datasets from MongoDB, runs all pipeline stages, persists results, and sets a recalculation flag. `upload-status.ts`, `upload-delete.ts`, and `reprocess.ts` are thin Netlify Functions over MongoDB operations.

**Tech Stack:** TypeScript strict, Netlify Functions (`@netlify/functions`), Vitest, Zod, MongoDB via existing `getCollection`, Supabase auth via existing `authenticateRequest`.

---

## Architecture Notes (Read Before Coding)

### File type keys vs entity type keys

The pipeline uses **file type keys** as the outer dictionary key in `normalisedDatasets`:
`'wipJson'`, `'fullMattersJson'`, `'feeEarner'`, `'invoicesJson'`, `'contactsJson'`, `'closedMattersJson'`, `'disbursementsJson'`, `'tasksJson'`

The normaliser's `entityKey` parameter (for entity-specific rules) uses **entity type keys**:
`'timeEntry'`, `'matter'`, `'feeEarner'`, `'invoice'`, `'client'`, `'disbursement'`, `'task'`

Map between them with:
```typescript
const FILE_TYPE_TO_ENTITY_KEY: Record<string, string> = {
  wipJson: 'timeEntry',
  fullMattersJson: 'matter',
  closedMattersJson: 'matter',
  feeEarner: 'feeEarner',
  invoicesJson: 'invoice',
  contactsJson: 'client',
  disbursementsJson: 'disbursement',
  tasksJson: 'task',
};
```

### MappingSet format mismatch

The client sends `MappingSet` from `src/shared/mapping/types.ts`:
```typescript
{ fileType, entityKey, mappings: [{ rawColumn, mappedTo, ... }], isComplete, ... }
```

The normaliser expects `ColumnMapping[]` from `src/shared/types/index.ts`:
```typescript
[{ sourceColumn: string, targetField: string, transform?: string }]
```

Convert with:
```typescript
function toNormaliserMappings(ms: ClientMappingSet): NormaliserColumnMapping[] {
  return ms.mappings
    .filter(m => m.mappedTo !== null)
    .map(m => ({ sourceColumn: m.rawColumn, targetField: m.mappedTo! }));
}
```

### Upload status values

`RawUploadDocument.status` type has: `'pending' | 'processing' | 'processed' | 'error'`
The spec uses `'complete'`/`'failed'` — map to `'processed'`/`'error'` to match the existing type.
Task 2 extends this type to also include `'deleted'`.

### Entity definition lookup

`getBuiltInEntityDefinition(entityType: EntityType)` from `src/shared/entities/registry.ts` returns the entity definition. Map from EntityType enum:
```typescript
const ENTITY_TYPE_ENUM: Record<string, EntityType> = {
  timeEntry: EntityType.TIME_ENTRY,
  matter: EntityType.MATTER,
  feeEarner: EntityType.FEE_EARNER,
  invoice: EntityType.INVOICE,
  client: EntityType.CLIENT,
  disbursement: EntityType.DISBURSEMENT,
  task: EntityType.TASK,
};
```

### Existing pipeline-orchestrator.ts

`src/server/pipeline/pipeline-orchestrator.ts` already exists as a stub. It exports `runPipeline(input: PipelineInput)` — keep this export unchanged. Add `runFullPipeline()` as a new export alongside it. Do NOT delete the existing function or change its signature; it is used by cross-reference.test.ts indirectly via `buildCrossRefQualityStats` and `buildKnownGaps` exports.

---

## Files Created / Modified

| File | Action | Purpose |
|------|--------|---------|
| `src/server/pipeline/pipeline-types.ts` | Create | `PipelineWarning`, `PipelineRunResult`, `PipelineStage` |
| `src/shared/types/mongodb.ts` | Modify | Add `NormalisedDatasetDocument`, extend `RawUploadDocument` status |
| `src/server/lib/mongodb-operations.ts` | Modify | Add `updateUploadStatus`, `storeNormalisedDataset`, `getAllNormalisedDatasets`, `setRecalculationFlag`, `getUploadById`, `deleteEnrichedEntitiesByType` |
| `src/server/pipeline/pipeline-orchestrator.ts` | Modify | Add `runFullPipeline()` export alongside existing `runPipeline()` |
| `src/server/functions/upload.ts` | Create | `POST /api/upload` |
| `src/server/functions/upload-status.ts` | Create | `GET /api/upload-status` and `GET /api/upload-status/:id` |
| `src/server/functions/upload-delete.ts` | Create | `DELETE /api/upload/:id` |
| `src/server/functions/reprocess.ts` | Create | `POST /api/reprocess` |
| `tests/server/pipeline/pipeline-orchestrator.test.ts` | Create | Orchestrator unit tests |
| `tests/server/functions/upload.test.ts` | Create | Upload endpoint unit tests |

---

## Task 1: Pipeline types

**Files:**
- Create: `src/server/pipeline/pipeline-types.ts`

- [ ] **Step 1: Write the file**

```typescript
// src/server/pipeline/pipeline-types.ts
// Shared types for pipeline orchestration results.
// No imports from pipeline modules — this file has no dependencies.

export type PipelineStage =
  | 'normalise'
  | 'crossReference'
  | 'index'
  | 'join'
  | 'enrich'
  | 'aggregate';

export interface PipelineWarning {
  stage: PipelineStage;
  message: string;
  severity: 'error' | 'warning' | 'info';
  count?: number;
}

export interface PipelineRunResult {
  uploadId: string;
  stagesCompleted: PipelineStage[];
  warnings: PipelineWarning[];
  recordsProcessed: number;
  recordsPersisted: number;
  duration_ms: number;
  dataQuality?: import('./aggregator.js').AggregateDataQualityReport_stub;
}
```

**Simpler — no re-export from aggregator yet:**
```typescript
// src/server/pipeline/pipeline-types.ts

export type PipelineStage =
  | 'normalise'
  | 'crossReference'
  | 'index'
  | 'join'
  | 'enrich'
  | 'aggregate';

export interface PipelineWarning {
  stage: PipelineStage;
  message: string;
  severity: 'error' | 'warning' | 'info';
  count?: number;
}

export interface PipelineRunResult {
  uploadId: string;
  stagesCompleted: PipelineStage[];
  warnings: PipelineWarning[];
  recordsProcessed: number;
  recordsPersisted: number;
  duration_ms: number;
}
```

- [ ] **Step 2: TypeScript check**
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**
```bash
git add src/server/pipeline/pipeline-types.ts
git commit -m "feat: pipeline-types - PipelineWarning, PipelineRunResult, PipelineStage"
```

---

## Task 2: MongoDB additions

**Files:**
- Modify: `src/shared/types/mongodb.ts`
- Modify: `src/server/lib/mongodb-operations.ts`

### 2a — Extend `RawUploadDocument` status and add `NormalisedDatasetDocument`

- [ ] **Step 1: Edit `src/shared/types/mongodb.ts`**

In `RawUploadDocument`, extend the status union:
```typescript
status: 'pending' | 'processing' | 'processed' | 'error' | 'deleted';
```

Add new document interface after `CrossReferenceRegistryDocument`:
```typescript
// normalised_datasets — one upserted document per (firm_id, file_type)
// Stores normalised records so subsequent uploads can incorporate prior data
// into cross-reference building without re-parsing raw files.
export interface NormalisedDatasetDocument {
  _id?: ObjectId;
  firm_id: string;
  /** Pipeline file-type key, e.g. 'wipJson', 'fullMattersJson' */
  file_type: string;
  /** Entity-type key used by normaliser rules, e.g. 'timeEntry', 'matter' */
  entity_key: string;
  /** Source upload _id that produced this normalised dataset */
  source_upload_id: string;
  records: Record<string, unknown>[];
  record_count: number;
  normalised_at: Date;
}

// recalculation_flags — one document per firm_id
// Set when new data is uploaded; cleared when formula engine runs.
export interface RecalculationFlagDocument {
  _id?: ObjectId;
  firm_id: string;
  is_stale: boolean;
  stale_since: Date;
}
```

### 2b — Add operations to `mongodb-operations.ts`

- [ ] **Step 2: Add imports at top of `mongodb-operations.ts`**

Add to the import of document types:
```typescript
import type {
  // ... existing ...
  NormalisedDatasetDocument,
  RecalculationFlagDocument,
} from '@shared/types/mongodb.js';
```

Add to pipeline types import:
```typescript
import type { NormaliseResult, NormalisedRecord } from '@shared/types/pipeline.js';
```

- [ ] **Step 3: Add the following functions at the bottom of `mongodb-operations.ts`**

```typescript
// ---------------------------------------------------------------------------
// raw_uploads — status updates
// ---------------------------------------------------------------------------

/**
 * Update the status of a raw_upload document.
 * Always filters by firm_id to enforce data isolation.
 */
export async function updateUploadStatus(
  firmId: string,
  uploadId: string,
  status: RawUploadDocument['status'],
  errorMessage?: string
): Promise<void> {
  const col = await getCollection<RawUploadDocument>('raw_uploads');
  const { ObjectId } = await import('mongodb');
  const update: Record<string, unknown> = { status };
  if (status === 'processing') update['processing_started_at'] = new Date();
  if (status === 'processed')  update['processing_completed_at'] = new Date();
  if (errorMessage)            update['error_message'] = errorMessage;
  await col.updateOne(
    { _id: new ObjectId(uploadId), firm_id: firmId },
    { $set: update }
  );
}

/**
 * Retrieve a single raw_upload document by id.
 * Returns null if not found or if the document belongs to a different firm.
 */
export async function getUploadById(
  firmId: string,
  uploadId: string
): Promise<RawUploadDocument | null> {
  const col = await getCollection<RawUploadDocument>('raw_uploads');
  const { ObjectId } = await import('mongodb');
  return col.findOne({ _id: new ObjectId(uploadId), firm_id: firmId });
}

// ---------------------------------------------------------------------------
// normalised_datasets
// ---------------------------------------------------------------------------

/**
 * Upsert the normalised dataset for a file type.
 * One document per (firm_id, file_type) — replaced on every new upload.
 */
export async function storeNormalisedDataset(
  firmId: string,
  fileType: string,
  entityKey: string,
  records: NormalisedRecord[],
  sourceUploadId: string
): Promise<void> {
  const col = await getCollection<NormalisedDatasetDocument>('normalised_datasets');
  const doc: NormalisedDatasetDocument = {
    firm_id: firmId,
    file_type: fileType,
    entity_key: entityKey,
    source_upload_id: sourceUploadId,
    records: records as Record<string, unknown>[],
    record_count: records.length,
    normalised_at: new Date(),
  };
  await col.replaceOne(
    { firm_id: firmId, file_type: fileType },
    doc,
    { upsert: true }
  );
}

/**
 * Load all normalised datasets for a firm as a Record<fileType, NormaliseResult>.
 * Returns empty record if no datasets have been stored yet.
 */
export async function getAllNormalisedDatasets(
  firmId: string
): Promise<Record<string, NormaliseResult>> {
  const col = await getCollection<NormalisedDatasetDocument>('normalised_datasets');
  const docs = await col.find({ firm_id: firmId }).toArray();
  const result: Record<string, NormaliseResult> = {};
  for (const doc of docs) {
    result[doc.file_type] = {
      fileType: doc.entity_key,
      records: doc.records as NormalisedRecord[],
      recordCount: doc.record_count,
      normalisedAt: doc.normalised_at.toISOString(),
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// enriched_entities — delete
// ---------------------------------------------------------------------------

/**
 * Delete all enriched entity snapshots for a firm + entity type.
 * Used when an upload is deleted to clear derived data.
 */
export async function deleteEnrichedEntitiesByType(
  firmId: string,
  entityType: string
): Promise<void> {
  const col = await getCollection<EnrichedEntitiesDocument>('enriched_entities');
  await col.deleteMany({ firm_id: firmId, entity_type: entityType });
}

// ---------------------------------------------------------------------------
// recalculation_flags
// ---------------------------------------------------------------------------

/**
 * Mark this firm's calculated KPIs as stale.
 * Called after every successful upload. The formula engine (1C) checks
 * this flag before running and clears it after completion.
 */
export async function setRecalculationFlag(firmId: string): Promise<void> {
  const col = await getCollection<RecalculationFlagDocument>('recalculation_flags');
  await col.replaceOne(
    { firm_id: firmId },
    { firm_id: firmId, is_stale: true, stale_since: new Date() },
    { upsert: true }
  );
}
```

- [ ] **Step 4: TypeScript check**
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Commit**
```bash
git add src/shared/types/mongodb.ts src/server/lib/mongodb-operations.ts
git commit -m "feat: mongodb-operations - updateUploadStatus, normalised_datasets, recalculation_flags"
```

---

## Task 3: Pipeline orchestrator — `runFullPipeline`

**Files:**
- Modify: `src/server/pipeline/pipeline-orchestrator.ts`

**Context:** The existing `runPipeline(input: PipelineInput)` must remain unchanged. Add `runFullPipeline` as a new named export below it.

### 3a — Write the failing tests first

- [ ] **Step 1: Write `tests/server/pipeline/pipeline-orchestrator.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MappingSet } from '../../../src/shared/mapping/types.js';
import type { ParseResult } from '../../../src/client/parsers/types.js';

// Mock all MongoDB operations before importing the orchestrator
vi.mock('../../../src/server/lib/mongodb-operations.js', () => ({
  getCrossReferenceRegistry: vi.fn().mockResolvedValue(null),
  storeCrossReferenceRegistry: vi.fn().mockResolvedValue(undefined),
  storeNormalisedDataset: vi.fn().mockResolvedValue(undefined),
  getAllNormalisedDatasets: vi.fn().mockResolvedValue({}),
  storeEnrichedEntities: vi.fn().mockResolvedValue(undefined),
  storeCalculatedKpis: vi.fn().mockResolvedValue(undefined),
  updateUploadStatus: vi.fn().mockResolvedValue(undefined),
  setRecalculationFlag: vi.fn().mockResolvedValue(undefined),
  deleteEnrichedEntitiesByType: vi.fn().mockResolvedValue(undefined),
}));

import { runFullPipeline } from '../../../src/server/pipeline/pipeline-orchestrator.js';
import * as mongoOps from '../../../src/server/lib/mongodb-operations.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParseResult(rows: Record<string, unknown>[]): ParseResult {
  return {
    fileType: 'json',
    originalFilename: 'test.json',
    rowCount: rows.length,
    columns: [],
    previewRows: rows.slice(0, 3),
    fullRows: rows,
    parseErrors: [],
    parsedAt: new Date().toISOString(),
  };
}

function makeMappingSet(fileType = 'wipJson'): MappingSet {
  return {
    fileType,
    entityKey: 'timeEntry' as any,
    mappings: [
      { rawColumn: 'Matter Number', mappedTo: 'matterNumber', entityKey: 'timeEntry' as any, isRequired: true, confidence: 'auto' },
      { rawColumn: 'Duration Minutes', mappedTo: 'durationMinutes', entityKey: 'timeEntry' as any, isRequired: false, confidence: 'auto' },
      { rawColumn: 'Lawyer', mappedTo: 'lawyerName', entityKey: 'timeEntry' as any, isRequired: false, confidence: 'auto' },
      { rawColumn: 'Billable', mappedTo: 'billable', entityKey: 'timeEntry' as any, isRequired: false, confidence: 'auto' },
    ],
    missingRequiredFields: [],
    unmappedColumns: [],
    customFieldSuggestions: [],
    isComplete: true,
  };
}

const WIP_ROWS = [
  { 'Matter Number': '1001', 'Duration Minutes': 60, Lawyer: 'Alice', Billable: 100 },
  { 'Matter Number': '1002', 'Duration Minutes': 30, Lawyer: 'Bob', Billable: 50 },
  { 'Matter Number': '1003', 'Duration Minutes': 120, Lawyer: 'Alice', Billable: 200 },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runFullPipeline — dry run', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns preview data without persisting to MongoDB', async () => {
    const result = await runFullPipeline({
      firmId: 'firm-001',
      userId: 'user-001',
      uploadId: 'upload-001',
      fileType: 'wipJson',
      parseResult: makeParseResult(WIP_ROWS),
      mappingSet: makeMappingSet('wipJson'),
      dryRun: true,
    });

    expect(result.previewData).toBeDefined();
    expect(result.previewData!.normalisedCount).toBeGreaterThan(0);
    // Dry run: nothing persisted
    expect(mongoOps.storeNormalisedDataset).not.toHaveBeenCalled();
    expect(mongoOps.storeEnrichedEntities).not.toHaveBeenCalled();
    expect(mongoOps.setRecalculationFlag).not.toHaveBeenCalled();
  });
});

describe('runFullPipeline — full run', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists normalised dataset and sets recalculation flag on success', async () => {
    const result = await runFullPipeline({
      firmId: 'firm-001',
      userId: 'user-001',
      uploadId: 'upload-001',
      fileType: 'wipJson',
      parseResult: makeParseResult(WIP_ROWS),
      mappingSet: makeMappingSet('wipJson'),
      dryRun: false,
    });

    expect(result.stagesCompleted).toContain('normalise');
    expect(result.stagesCompleted).toContain('crossReference');
    expect(mongoOps.storeNormalisedDataset).toHaveBeenCalledWith(
      'firm-001',
      'wipJson',
      'timeEntry',
      expect.any(Array),
      'upload-001'
    );
    expect(mongoOps.setRecalculationFlag).toHaveBeenCalledWith('firm-001');
  });

  it('marks upload as error when > 50% of rows are rejected', async () => {
    // Send 3 blank rows — all rejected
    const blankRows = [
      { 'Matter Number': null, 'Duration Minutes': null, Lawyer: null, Billable: null },
      { 'Matter Number': null, 'Duration Minutes': null, Lawyer: null, Billable: null },
      { 'Matter Number': null, 'Duration Minutes': null, Lawyer: null, Billable: null },
    ];

    const result = await runFullPipeline({
      firmId: 'firm-001',
      userId: 'user-001',
      uploadId: 'upload-001',
      fileType: 'wipJson',
      parseResult: makeParseResult(blankRows),
      mappingSet: makeMappingSet('wipJson'),
      dryRun: false,
    });

    expect(result.aborted).toBe(true);
    expect(mongoOps.updateUploadStatus).toHaveBeenCalledWith(
      'firm-001',
      'upload-001',
      'error',
      expect.stringContaining('rejected')
    );
    expect(mongoOps.storeNormalisedDataset).not.toHaveBeenCalled();
  });

  it('includes cross-reference and join stages when prior data exists', async () => {
    // Simulate a second upload where fullMattersJson was already uploaded
    vi.mocked(mongoOps.getAllNormalisedDatasets).mockResolvedValue({
      fullMattersJson: {
        fileType: 'matter',
        records: [{ matterId: 'm-001', matterNumber: '1001' }],
        recordCount: 1,
        normalisedAt: new Date().toISOString(),
      },
    });

    const result = await runFullPipeline({
      firmId: 'firm-001',
      userId: 'user-001',
      uploadId: 'upload-002',
      fileType: 'wipJson',
      parseResult: makeParseResult(WIP_ROWS),
      mappingSet: makeMappingSet('wipJson'),
      dryRun: false,
    });

    expect(result.stagesCompleted).toContain('join');
    expect(result.stagesCompleted).toContain('enrich');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**
```bash
npx vitest run tests/server/pipeline/pipeline-orchestrator.test.ts 2>&1 | head -20
```
Expected: FAIL — `runFullPipeline` not exported yet.

### 3b — Implement `runFullPipeline`

- [ ] **Step 3: Add `runFullPipeline` to `src/server/pipeline/pipeline-orchestrator.ts`**

Add these imports at the top (alongside existing ones):

```typescript
import { normaliseRecords } from './normaliser.js';
import { aggregate } from './aggregator.js';
import {
  updateUploadStatus,
  storeNormalisedDataset,
  getAllNormalisedDatasets,
  storeEnrichedEntities,
  storeCalculatedKpis,
  setRecalculationFlag,
} from '../lib/mongodb-operations.js';
import { getBuiltInEntityDefinition } from '../../shared/entities/registry.js';
import type { EntityType } from '../../shared/types/index.js';
import type { MappingSet as ClientMappingSet } from '../../shared/mapping/types.js';
import type { ParseResult } from '../../client/parsers/types.js';
import type { ColumnMapping, NormaliseResult } from '../../shared/types/pipeline.js';
import type { PipelineRunResult, PipelineWarning } from './pipeline-types.js';
```

Add the file-type-to-entity-key map and `runFullPipeline` function:

```typescript
// ---------------------------------------------------------------------------
// File type → entity key maps
// ---------------------------------------------------------------------------

const FILE_TYPE_TO_ENTITY_KEY: Record<string, string> = {
  wipJson: 'timeEntry',
  fullMattersJson: 'matter',
  closedMattersJson: 'matter',
  feeEarner: 'feeEarner',
  invoicesJson: 'invoice',
  contactsJson: 'client',
  disbursementsJson: 'disbursement',
  tasksJson: 'task',
};

const ENTITY_KEY_TO_ENUM: Record<string, EntityType> = {
  timeEntry: 'timeEntry' as EntityType,
  matter: 'matter' as EntityType,
  feeEarner: 'feeEarner' as EntityType,
  invoice: 'invoice' as EntityType,
  client: 'client' as EntityType,
  disbursement: 'disbursement' as EntityType,
  task: 'task' as EntityType,
};

// ---------------------------------------------------------------------------
// runFullPipeline — orchestrates Stages 2–7 for a single file upload
// ---------------------------------------------------------------------------

export interface FullPipelineParams {
  firmId: string;
  userId: string;
  uploadId: string;
  fileType: string;
  parseResult: ParseResult;
  mappingSet: ClientMappingSet;
  dryRun?: boolean;
}

export interface FullPipelineResult extends PipelineRunResult {
  aborted?: boolean;
  previewData?: {
    normalisedCount: number;
    rejectedCount: number;
    warnings: unknown[];
  };
}

export async function runFullPipeline(
  params: FullPipelineParams
): Promise<FullPipelineResult> {
  const { firmId, userId, uploadId, fileType, parseResult, mappingSet, dryRun = false } = params;
  const startTime = Date.now();
  const stagesCompleted: FullPipelineResult['stagesCompleted'] = [];
  const warnings: PipelineWarning[] = [];

  const entityKey = FILE_TYPE_TO_ENTITY_KEY[fileType];
  if (!entityKey) {
    throw new Error(`Unknown fileType: ${fileType}`);
  }

  const entityTypeEnum = ENTITY_KEY_TO_ENUM[entityKey];
  const entityDef = getBuiltInEntityDefinition(entityTypeEnum as EntityType);
  if (!entityDef) {
    throw new Error(`No entity definition for entityKey: ${entityKey}`);
  }

  // Convert client MappingSet to normaliser format
  const normaliserMappings: ColumnMapping[] = mappingSet.mappings
    .filter(m => m.mappedTo !== null)
    .map(m => ({ sourceColumn: m.rawColumn, targetField: m.mappedTo! }));

  // ── Stage 2: Normalise ────────────────────────────────────────────────────
  const normaliseResult = normaliseRecords(
    parseResult.fullRows,
    normaliserMappings,
    entityKey,
    entityDef
  );
  stagesCompleted.push('normalise');

  const rejectedCount = normaliseResult.rejectedRows?.length ?? 0;
  const totalCount = parseResult.fullRows.length;
  const rejectedPercent = totalCount > 0 ? (rejectedCount / totalCount) * 100 : 0;

  // Dry run: return preview, skip persistence
  if (dryRun) {
    return {
      uploadId,
      stagesCompleted,
      warnings,
      recordsProcessed: normaliseResult.recordCount,
      recordsPersisted: 0,
      duration_ms: Date.now() - startTime,
      previewData: {
        normalisedCount: normaliseResult.recordCount,
        rejectedCount,
        warnings: normaliseResult.warnings ?? [],
      },
    };
  }

  // Abort if > 50% rejected
  if (rejectedPercent > 50) {
    const msg = `${rejectedCount} of ${totalCount} rows rejected (${Math.round(rejectedPercent)}%) — exceeds 50% threshold`;
    await updateUploadStatus(firmId, uploadId, 'error', msg);
    return {
      uploadId,
      stagesCompleted,
      warnings,
      recordsProcessed: normaliseResult.recordCount,
      recordsPersisted: 0,
      duration_ms: Date.now() - startTime,
      aborted: true,
    };
  }

  if (normaliseResult.warnings?.length) {
    for (const w of normaliseResult.warnings) {
      warnings.push({ stage: 'normalise', message: w.message, severity: 'warning', count: w.affectedRowCount });
    }
  }

  // ── Stage 3: Cross-Reference ──────────────────────────────────────────────
  // Load existing normalised datasets for this firm
  const existingDatasets = await getAllNormalisedDatasets(firmId);
  // Merge new dataset with existing ones
  const allDatasets: Record<string, NormaliseResult> = {
    ...existingDatasets,
    [fileType]: normaliseResult,
  };

  const existingSerialised = await getCrossReferenceRegistry(firmId);
  const existingRegistry = existingSerialised ? deserialiseRegistry(existingSerialised) : undefined;
  const updatedRegistry = buildCrossReferenceRegistry(firmId, allDatasets, existingRegistry);
  const enrichedDatasets = applyRegistryToDatasets(allDatasets, updatedRegistry);
  await storeCrossReferenceRegistry(firmId, serialiseRegistry(updatedRegistry));
  stagesCompleted.push('crossReference');

  // ── Stage 4: Index ────────────────────────────────────────────────────────
  const indexes = buildIndexes(enrichedDatasets, Object.keys(enrichedDatasets));
  stagesCompleted.push('index');

  // ── Stage 5: Join ─────────────────────────────────────────────────────────
  const rawJoinResult = joinRecords(enrichedDatasets, indexes);
  stagesCompleted.push('join');

  // ── Stage 5 (enrich): Enrich ──────────────────────────────────────────────
  const joinResult = enrichRecords(rawJoinResult, new Date());
  stagesCompleted.push('enrich');

  // ── Stage 6: Aggregate ────────────────────────────────────────────────────
  const availableFileTypes = Object.keys(allDatasets);
  const aggregateResult = aggregate(joinResult, new Date(), availableFileTypes);
  stagesCompleted.push('aggregate');

  // ── Persist ───────────────────────────────────────────────────────────────
  // Store normalised dataset for this file type (for future cross-references)
  await storeNormalisedDataset(
    firmId,
    fileType,
    entityKey,
    enrichedDatasets[fileType]?.records ?? normaliseResult.records,
    uploadId
  );

  // Store enriched entities (time entries, matters, etc.)
  await storeEnrichedEntities(
    firmId,
    entityKey,
    normaliseResult.records as Record<string, unknown>[],
    [uploadId],
    {
      quality_score: aggregateResult.dataQuality.overallScore,
      issue_count: aggregateResult.dataQuality.entityIssues.length,
      issues: aggregateResult.dataQuality.entityIssues,
    }
  );

  // Store aggregate base data (KPI formula engine uses this in 1C)
  await storeCalculatedKpis(
    firmId,
    { aggregate: aggregateResult as unknown as Record<string, unknown>, generatedAt: new Date().toISOString() },
    'pending',
    new Date().toISOString()
  );

  // Set recalculation flag — formula engine (1C) will pick this up
  await setRecalculationFlag(firmId);

  // Update upload status to processed
  await updateUploadStatus(firmId, uploadId, 'processed');

  return {
    uploadId,
    stagesCompleted,
    warnings,
    recordsProcessed: normaliseResult.recordCount,
    recordsPersisted: normaliseResult.recordCount,
    duration_ms: Date.now() - startTime,
  };
}
```

- [ ] **Step 4: Run the failing tests**
```bash
npx vitest run tests/server/pipeline/pipeline-orchestrator.test.ts 2>&1
```
Expected: tests pass. Fix any type errors.

- [ ] **Step 5: Full test suite**
```bash
npm test 2>&1 | tail -10
```
Expected: all existing tests still pass.

- [ ] **Step 6: TypeScript check**
```bash
npx tsc --noEmit
```

- [ ] **Step 7: Commit**
```bash
git add src/server/pipeline/pipeline-orchestrator.ts tests/server/pipeline/pipeline-orchestrator.test.ts
git commit -m "feat: pipeline-orchestrator - runFullPipeline with stages 2-7 and dry-run support"
```

---

## Task 4: Upload function

**Files:**
- Create: `src/server/functions/upload.ts`
- Create: `tests/server/functions/upload.test.ts`

### 4a — Write the failing tests first

- [ ] **Step 1: Create `tests/server/functions/upload.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerEvent } from '@netlify/functions';

// Mock auth and pipeline before importing handler
vi.mock('../../../src/server/lib/auth-middleware.js', () => ({
  authenticateRequest: vi.fn(),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public readonly statusCode: number) { super(msg); }
  },
}));

vi.mock('../../../src/server/lib/mongodb-operations.js', () => ({
  storeRawUpload: vi.fn().mockResolvedValue('upload-123'),
  updateUploadStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/server/pipeline/pipeline-orchestrator.js', () => ({
  runFullPipeline: vi.fn().mockResolvedValue({
    uploadId: 'upload-123',
    stagesCompleted: ['normalise', 'crossReference', 'index', 'join', 'enrich', 'aggregate'],
    warnings: [],
    recordsProcessed: 3,
    recordsPersisted: 3,
    duration_ms: 42,
  }),
}));

import { handler } from '../../../src/server/functions/upload.js';
import * as auth from '../../../src/server/lib/auth-middleware.js';
import * as mongoOps from '../../../src/server/lib/mongodb-operations.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(body: unknown, method = 'POST'): HandlerEvent {
  return {
    httpMethod: method,
    path: '/api/upload',
    headers: { authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
    queryStringParameters: null,
    pathParameters: null,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    isBase64Encoded: false,
    rawUrl: '/api/upload',
    rawQuery: '',
  };
}

function makeValidBody() {
  return {
    fileType: 'wipJson',
    originalFilename: 'wip.json',
    parseResult: {
      fileType: 'json',
      originalFilename: 'wip.json',
      rowCount: 3,
      columns: [],
      previewRows: [],
      fullRows: [{ 'Matter Number': '1001', 'Duration Minutes': 60, Lawyer: 'Alice', Billable: 100 }],
      parseErrors: [],
      parsedAt: new Date().toISOString(),
    },
    mappingSet: {
      fileType: 'wipJson',
      entityKey: 'timeEntry',
      mappings: [
        { rawColumn: 'Matter Number', mappedTo: 'matterNumber', entityKey: 'timeEntry', isRequired: true, confidence: 'auto' },
      ],
      missingRequiredFields: [],
      unmappedColumns: [],
      customFieldSuggestions: [],
      isComplete: true,
    },
    runFullPipeline: true,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/upload — auth', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when no auth token', async () => {
    const { AuthError } = await import('../../../src/server/lib/auth-middleware.js');
    vi.mocked(auth.authenticateRequest).mockRejectedValue(
      new (AuthError as any)('Missing token', 401)
    );

    const response = await handler(makeEvent(makeValidBody()), {} as any);
    expect(response!.statusCode).toBe(401);
  });
});

describe('POST /api/upload — validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.authenticateRequest).mockResolvedValue({
      userId: 'user-001',
      firmId: 'firm-001',
      role: 'admin',
    });
  });

  it('returns 400 for unknown fileType', async () => {
    const body = { ...makeValidBody(), fileType: 'unknownFileType' };
    const response = await handler(makeEvent(body), {} as any);
    expect(response!.statusCode).toBe(400);
    const parsed = JSON.parse(response!.body!);
    expect(parsed.error).toMatch(/fileType/i);
  });

  it('returns 400 when body is missing', async () => {
    const event = makeEvent(null);
    event.body = null;
    const response = await handler(event, {} as any);
    expect(response!.statusCode).toBe(400);
  });
});

describe('POST /api/upload — success', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.authenticateRequest).mockResolvedValue({
      userId: 'user-001',
      firmId: 'firm-001',
      role: 'admin',
    });
  });

  it('returns 200 with pipeline stats for a valid upload', async () => {
    const response = await handler(makeEvent(makeValidBody()), {} as any);
    expect(response!.statusCode).toBe(200);
    const body = JSON.parse(response!.body!);
    expect(body.success).toBe(true);
    expect(body.uploadId).toBe('upload-123');
    expect(body.pipeline.stagesCompleted).toContain('normalise');
    expect(mongoOps.storeRawUpload).toHaveBeenCalledWith(
      'firm-001',
      'wipJson',
      'wip.json',
      expect.any(Array),
      'user-001'
    );
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**
```bash
npx vitest run tests/server/functions/upload.test.ts 2>&1 | head -15
```
Expected: FAIL — upload.ts doesn't exist.

### 4b — Implement `upload.ts`

- [ ] **Step 3: Create `src/server/functions/upload.ts`**

```typescript
/**
 * upload.ts — Netlify Function
 * POST /api/upload
 *
 * Receives parsed file data from the client, stores the raw upload in MongoDB,
 * then runs the full pipeline. Returns pipeline stats and data quality report.
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { storeRawUpload, updateUploadStatus } from '../lib/mongodb-operations.js';
import { runFullPipeline } from '../pipeline/pipeline-orchestrator.js';
import type { MappingSet } from '../../shared/mapping/types.js';
import type { ParseResult } from '../../client/parsers/types.js';

// Valid file type keys (must match pipeline stage expectations)
const VALID_FILE_TYPES = new Set([
  'wipJson', 'fullMattersJson', 'closedMattersJson', 'feeEarner',
  'invoicesJson', 'contactsJson', 'disbursementsJson', 'tasksJson',
]);

interface UploadRequestBody {
  fileType: string;
  originalFilename: string;
  parseResult: ParseResult;
  mappingSet: MappingSet;
  runFullPipeline?: boolean;
}

export const handler: Handler = async (event) => {
  try {
    const { firmId, userId } = await authenticateRequest(event);

    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Request body is required' }) };
    }

    let body: UploadRequestBody;
    try {
      body = JSON.parse(event.body) as UploadRequestBody;
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { fileType, originalFilename, parseResult, mappingSet, runFullPipeline: shouldRunPipeline = true } = body;

    // Validate required fields
    if (!fileType || typeof fileType !== 'string') {
      return { statusCode: 400, body: JSON.stringify({ error: '"fileType" is required' }) };
    }
    if (!VALID_FILE_TYPES.has(fileType)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `Unknown fileType "${fileType}". Valid values: ${[...VALID_FILE_TYPES].join(', ')}`,
        }),
      };
    }
    if (!originalFilename || typeof originalFilename !== 'string') {
      return { statusCode: 400, body: JSON.stringify({ error: '"originalFilename" is required' }) };
    }
    if (!parseResult || !Array.isArray(parseResult.fullRows)) {
      return { statusCode: 400, body: JSON.stringify({ error: '"parseResult.fullRows" is required' }) };
    }
    if (!mappingSet || !Array.isArray(mappingSet.mappings)) {
      return { statusCode: 400, body: JSON.stringify({ error: '"mappingSet.mappings" is required' }) };
    }

    // Store raw upload FIRST (before running pipeline)
    const uploadId = await storeRawUpload(
      firmId,
      fileType,
      originalFilename,
      parseResult.fullRows,
      userId
    );

    // Mark as processing
    await updateUploadStatus(firmId, uploadId, 'processing');

    // Dry run (validate only)
    if (!shouldRunPipeline) {
      const dryResult = await runFullPipeline({
        firmId,
        userId,
        uploadId,
        fileType,
        parseResult,
        mappingSet,
        dryRun: true,
      });

      await updateUploadStatus(firmId, uploadId, 'processed');

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          uploadId,
          message: 'Dry run complete — no data persisted',
          pipeline: {
            stagesCompleted: dryResult.stagesCompleted,
            warnings: dryResult.warnings,
            recordsProcessed: dryResult.recordsProcessed,
            recordsPersisted: 0,
            duration_ms: dryResult.duration_ms,
          },
          previewData: dryResult.previewData,
        }),
      };
    }

    // Full pipeline run
    const result = await runFullPipeline({
      firmId,
      userId,
      uploadId,
      fileType,
      parseResult,
      mappingSet,
      dryRun: false,
    });

    if (result.aborted) {
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          uploadId,
          message: 'Upload aborted — too many rows rejected during normalisation',
          pipeline: {
            stagesCompleted: result.stagesCompleted,
            warnings: result.warnings,
            recordsProcessed: result.recordsProcessed,
            recordsPersisted: 0,
            duration_ms: result.duration_ms,
          },
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        uploadId,
        message: `${fileType} uploaded and processed successfully`,
        pipeline: {
          stagesCompleted: result.stagesCompleted,
          warnings: result.warnings,
          recordsProcessed: result.recordsProcessed,
          recordsPersisted: result.recordsPersisted,
          duration_ms: result.duration_ms,
        },
      }),
    };

  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[upload]', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
```

- [ ] **Step 4: Run tests**
```bash
npx vitest run tests/server/functions/upload.test.ts 2>&1
```
Expected: all pass. Fix any type errors.

- [ ] **Step 5: TypeScript check + full suite**
```bash
npx tsc --noEmit && npm test 2>&1 | tail -10
```

- [ ] **Step 6: Commit**
```bash
git add src/server/functions/upload.ts tests/server/functions/upload.test.ts
git commit -m "feat: upload function - POST /api/upload with pipeline orchestration"
```

---

## Task 5: Upload status + delete functions

**Files:**
- Create: `src/server/functions/upload-status.ts`
- Create: `src/server/functions/upload-delete.ts`

### 5a — Upload status

- [ ] **Step 1: Create `src/server/functions/upload-status.ts`**

```typescript
/**
 * upload-status.ts — Netlify Function
 * GET /api/upload-status            → all uploads for this firm (newest first)
 * GET /api/upload-status/:uploadId  → single upload status
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { getUploadHistory, getUploadById } from '../lib/mongodb-operations.js';

function extractId(path: string): string | null {
  const segments = path.replace(/\/$/, '').split('/');
  const last = segments[segments.length - 1];
  return last && last !== 'upload-status' ? last : null;
}

export const handler: Handler = async (event) => {
  try {
    const { firmId } = await authenticateRequest(event);

    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const uploadId = extractId(event.path ?? '');

    if (uploadId) {
      const upload = await getUploadById(firmId, uploadId);
      if (!upload) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Upload not found' }) };
      }
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(upload),
      };
    }

    const limit = parseInt(event.queryStringParameters?.['limit'] ?? '20', 10);
    const uploads = await getUploadHistory(firmId, limit);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(uploads),
    };

  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[upload-status]', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
```

### 5b — Upload delete

- [ ] **Step 2: Create `src/server/functions/upload-delete.ts`**

```typescript
/**
 * upload-delete.ts — Netlify Function
 * DELETE /api/upload/:uploadId
 *
 * Soft-deletes a raw_upload record and removes its derived enriched entities.
 * Sets the recalculation flag so the formula engine (1C) re-runs.
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import {
  getUploadById,
  updateUploadStatus,
  deleteEnrichedEntitiesByType,
  setRecalculationFlag,
} from '../lib/mongodb-operations.js';

function extractId(path: string): string | null {
  const segments = path.replace(/\/$/, '').split('/');
  const last = segments[segments.length - 1];
  return last && last !== 'upload' ? last : null;
}

export const handler: Handler = async (event) => {
  try {
    const { firmId } = await authenticateRequest(event);

    if (event.httpMethod !== 'DELETE') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const uploadId = extractId(event.path ?? '');
    if (!uploadId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Upload ID is required' }) };
    }

    const upload = await getUploadById(firmId, uploadId);
    if (!upload) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Upload not found' }) };
    }

    // Soft-delete the raw upload record
    await updateUploadStatus(firmId, uploadId, 'deleted');

    // Remove derived enriched entities for this file type
    const FILE_TYPE_TO_ENTITY_KEY: Record<string, string> = {
      wipJson: 'timeEntry',
      fullMattersJson: 'matter',
      closedMattersJson: 'matter',
      feeEarner: 'feeEarner',
      invoicesJson: 'invoice',
      contactsJson: 'client',
      disbursementsJson: 'disbursement',
      tasksJson: 'task',
    };
    const entityKey = FILE_TYPE_TO_ENTITY_KEY[upload.file_type];
    if (entityKey) {
      await deleteEnrichedEntitiesByType(firmId, entityKey);
    }

    // Signal that KPIs need recalculation
    await setRecalculationFlag(firmId);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, message: 'Upload deleted and recalculation scheduled' }),
    };

  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[upload-delete]', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
```

- [ ] **Step 3: TypeScript check**
```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**
```bash
git add src/server/functions/upload-status.ts src/server/functions/upload-delete.ts
git commit -m "feat: upload-status and upload-delete Netlify functions"
```

---

## Task 6: Reprocess function

**Files:**
- Create: `src/server/functions/reprocess.ts`

- [ ] **Step 1: Create `src/server/functions/reprocess.ts`**

```typescript
/**
 * reprocess.ts — Netlify Function
 * POST /api/reprocess
 *
 * Re-runs the full pipeline for an existing upload using its stored raw_content
 * and a new (or updated) mappingSet supplied in the request body.
 * Useful when the user updates their column mapping and wants to re-derive
 * enriched data without re-uploading the file.
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { getUploadById, updateUploadStatus } from '../lib/mongodb-operations.js';
import { runFullPipeline } from '../pipeline/pipeline-orchestrator.js';
import type { MappingSet } from '../../shared/mapping/types.js';

export const handler: Handler = async (event) => {
  try {
    const { firmId, userId } = await authenticateRequest(event);

    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Request body is required' }) };
    }

    let body: { uploadId?: string; mappingSet?: MappingSet };
    try {
      body = JSON.parse(event.body) as { uploadId?: string; mappingSet?: MappingSet };
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { uploadId, mappingSet } = body;

    if (!uploadId || typeof uploadId !== 'string') {
      return { statusCode: 400, body: JSON.stringify({ error: '"uploadId" is required' }) };
    }
    if (!mappingSet || !Array.isArray(mappingSet.mappings)) {
      return { statusCode: 400, body: JSON.stringify({ error: '"mappingSet.mappings" is required' }) };
    }

    // Load the original upload
    const upload = await getUploadById(firmId, uploadId);
    if (!upload) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Upload not found' }) };
    }
    if (upload.status === 'deleted') {
      return { statusCode: 410, body: JSON.stringify({ error: 'Upload has been deleted and cannot be reprocessed' }) };
    }

    // Reconstruct a minimal ParseResult from stored raw content
    const parseResult = {
      fileType: 'json',
      originalFilename: upload.original_filename,
      rowCount: upload.raw_content.length,
      columns: [],
      previewRows: upload.raw_content.slice(0, 10),
      fullRows: upload.raw_content,
      parseErrors: [],
      parsedAt: new Date().toISOString(),
    };

    await updateUploadStatus(firmId, uploadId, 'processing');

    const result = await runFullPipeline({
      firmId,
      userId,
      uploadId,
      fileType: upload.file_type,
      parseResult,
      mappingSet,
      dryRun: false,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: !result.aborted,
        uploadId,
        message: result.aborted
          ? 'Reprocess aborted — too many rows rejected'
          : 'Reprocessed successfully',
        pipeline: {
          stagesCompleted: result.stagesCompleted,
          warnings: result.warnings,
          recordsProcessed: result.recordsProcessed,
          recordsPersisted: result.recordsPersisted,
          duration_ms: result.duration_ms,
        },
      }),
    };

  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[reprocess]', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
```

- [ ] **Step 2: TypeScript check + full test suite**
```bash
npx tsc --noEmit && npm test 2>&1 | tail -10
```

- [ ] **Step 3: Commit**
```bash
git add src/server/functions/reprocess.ts
git commit -m "feat: reprocess function - POST /api/reprocess with stored raw content"
```

---

## Task 7: Final verification and push

- [ ] **Step 1: Confirm all spec requirements are met**

| Requirement | Check |
|-------------|-------|
| Upload API orchestrates all pipeline stages | `runFullPipeline` in orchestrator |
| Raw content stored before pipeline runs | `storeRawUpload` called first |
| Status maintained: processing → processed/error | `updateUploadStatus` calls |
| Stale flag set after successful upload | `setRecalculationFlag` called |
| Dry-run validates without persisting | `dryRun: true` path |
| Reprocess endpoint uses stored raw content | `upload.raw_content` used |
| Auth blocks unauthenticated requests | `authenticateRequest` + `AuthError` handling |
| Tests pass | Vitest suite |

- [ ] **Step 2: Run full test suite one final time**
```bash
npm test 2>&1 | tail -15
```
Expected: all tests pass (previous 381 + new tests).

- [ ] **Step 3: TypeScript check**
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Git push**
```bash
git push
```

---

## Common Pitfalls

**MappingSet type collision:** Two different `MappingSet` types exist in the codebase — one in `src/shared/types/pipeline.ts` (the normaliser's `ColumnMapping[]`) and one in `src/shared/mapping/types.ts` (the client UI's full MappingSet object). Import from `src/shared/mapping/types.ts` in the orchestrator and Netlify functions; import from `src/shared/types/pipeline.ts` ONLY in the normaliser.

**`@shared` path alias:** Only safe for `import type` statements in server code (TypeScript erases these at runtime). For runtime imports, use relative paths (`'../../shared/entities/registry.js'`).

**ObjectId import:** MongoDB's `ObjectId` needs a dynamic `await import('mongodb')` in the operation functions, OR import statically at the top of the file. Look at how existing code does it.

**`getBuiltInEntityDefinition` returns `EntityDefinition | undefined`:** Always check for undefined and throw a clear error if the entity definition is not found.

**`FILE_TYPE_TO_ENTITY_KEY` is duplicated** between `pipeline-orchestrator.ts` and `upload-delete.ts`. If this becomes a problem, extract it to a shared constants file — but for now keep it in both places (YAGNI — it's two copies of 8 lines).
