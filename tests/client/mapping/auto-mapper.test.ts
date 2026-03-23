import { describe, it, expect } from 'vitest';
import {
  autoMap,
  levenshteinDistance,
} from '../../../src/client/mapping/auto-mapper.js';
import {
  validateMappingSet,
  getMappingSummary,
  updateMapping,
} from '../../../src/client/mapping/mapping-service.js';
import { getBuiltInEntityDefinition } from '../../../src/shared/entities/registry.js';
import { EntityType } from '../../../src/shared/types/index.js';
import type { ParseResult, ColumnInfo } from '../../../src/client/parsers/types.js';
import type { MappingSet, MappingTemplate } from '../../../src/shared/mapping/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParseResult(
  cols: Array<{ name: string; nullPercent?: number; type?: ColumnInfo['detectedType'] }>,
  fileType = 'json'
): ParseResult {
  return {
    fileType,
    originalFilename: `test.${fileType}`,
    rowCount: 20,
    columns: cols.map(c => ({
      originalHeader: c.name,
      detectedType: c.type ?? 'string',
      sampleValues: ['val1', 'val2'],
      nullCount: Math.round(((c.nullPercent ?? 5) / 100) * 20),
      totalCount: 20,
      nullPercent: c.nullPercent ?? 5,
    })),
    previewRows: [],
    fullRows: [],
    parseErrors: [],
    parsedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// levenshteinDistance
// ---------------------------------------------------------------------------

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('rate', 'rate')).toBe(0);
  });

  it('returns 1 for a single substitution', () => {
    expect(levenshteinDistance('rade', 'rate')).toBe(1);
  });

  it('returns 1 for a single insertion', () => {
    expect(levenshteinDistance('lawyerid', 'lawyerids')).toBe(1);
  });

  it('returns 1 for a single deletion', () => {
    expect(levenshteinDistance('lawyerids', 'lawyerid')).toBe(1);
  });

  it('handles empty strings', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('abc', '')).toBe(3);
    expect(levenshteinDistance('', '')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// autoMap — exact matching
// ---------------------------------------------------------------------------

describe('autoMap — exact match', () => {
  it('maps all WIP JSON required fields when column names exactly match entity field keys', () => {
    const entity = getBuiltInEntityDefinition(EntityType.TIME_ENTRY)!;
    const result = autoMap(
      makeParseResult([
        { name: 'entryId' },
        { name: 'doNotBill', type: 'boolean' },
        { name: 'rate', type: 'currency' },
        { name: 'durationMinutes', type: 'number' },
        { name: 'billableValue', type: 'currency' },
        { name: 'matterId' },
        { name: 'matterNumber', type: 'number' },
        { name: 'lawyerId' },
        { name: 'date', type: 'date' },
      ]),
      'wipJson',
      entity,
      []
    );

    expect(result.isComplete).toBe(true);
    expect(result.missingRequiredFields).toHaveLength(0);

    const rateMapping = result.mappings.find(m => m.rawColumn === 'rate');
    expect(rateMapping?.mappedTo).toBe('rate');
    expect(rateMapping?.confidence).toBe('auto');
    expect(rateMapping?.isRequired).toBe(true);
  });

  it('maps via case normalisation — AnnualSalary maps to annualSalary', () => {
    const entity = getBuiltInEntityDefinition(EntityType.FEE_EARNER)!;
    const result = autoMap(
      makeParseResult([
        { name: 'ID' },
        { name: 'Name' },
        { name: 'Department' },
        { name: 'Pay Model' },
        { name: 'Is Active', type: 'boolean' },
        { name: 'AnnualSalary', type: 'currency' },
      ]),
      'feeEarnerCsv',
      entity,
      []
    );

    // All 5 required fields must map (id, name, department, payModel, isActive)
    expect(result.isComplete).toBe(true);

    const salaryMapping = result.mappings.find(m => m.rawColumn === 'AnnualSalary');
    expect(salaryMapping?.mappedTo).toBe('annualSalary');
    expect(salaryMapping?.confidence).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// autoMap — alias matching
// ---------------------------------------------------------------------------

describe('autoMap — alias matching', () => {
  it('resolves Billable via COLUMN_NAME_ALIASES to billableValue', () => {
    const entity = getBuiltInEntityDefinition(EntityType.TIME_ENTRY)!;
    const result = autoMap(
      makeParseResult([
        { name: 'entryId' },
        { name: 'doNotBill', type: 'boolean' },
        { name: 'rate', type: 'currency' },
        { name: 'durationMinutes', type: 'number' },
        { name: 'Billable', type: 'currency' }, // alias for billableValue
        { name: 'matterId' },
        { name: 'matterNumber', type: 'number' },
        { name: 'lawyerId' },
        { name: 'date', type: 'date' },
      ]),
      'wipJson',
      entity,
      []
    );

    const billableMapping = result.mappings.find(m => m.rawColumn === 'Billable');
    expect(billableMapping?.mappedTo).toBe('billableValue');
    expect(billableMapping?.confidence).toBe('auto');
    expect(result.isComplete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// autoMap — template matching
// ---------------------------------------------------------------------------

describe('autoMap — template matching', () => {
  it('uses a saved template when the column has no exact or alias match', () => {
    const entity = getBuiltInEntityDefinition(EntityType.FEE_EARNER)!;
    const template: MappingTemplate = {
      id: 'tmpl1',
      firmId: 'firm1',
      name: 'My Template',
      fileType: 'feeEarnerCsv',
      mappings: { 'Salary Amount': 'annualSalary' },
      typeOverrides: {},
      createdAt: '2024-01-01T00:00:00Z',
    };

    const result = autoMap(
      makeParseResult([
        { name: 'ID' },
        { name: 'Name' },
        { name: 'Department' },
        { name: 'PayModel' },
        { name: 'IsActive', type: 'boolean' },
        { name: 'Salary Amount', type: 'currency' }, // no direct field match, no alias
      ]),
      'feeEarnerCsv',
      entity,
      [template]
    );

    const salaryMapping = result.mappings.find(m => m.rawColumn === 'Salary Amount');
    expect(salaryMapping?.mappedTo).toBe('annualSalary');
    expect(salaryMapping?.confidence).toBe('template');
  });

  it('only uses templates matching the current fileType', () => {
    const entity = getBuiltInEntityDefinition(EntityType.FEE_EARNER)!;
    const wrongTypeTemplate: MappingTemplate = {
      id: 'tmpl2',
      firmId: 'firm1',
      name: 'Wrong Type',
      fileType: 'wipJson', // different file type
      mappings: { 'Salary Amount': 'annualSalary' },
      typeOverrides: {},
      createdAt: '2024-01-01T00:00:00Z',
    };

    const result = autoMap(
      makeParseResult([{ name: 'Salary Amount', type: 'currency' }]),
      'feeEarnerCsv',
      entity,
      [wrongTypeTemplate]
    );

    const salaryMapping = result.mappings.find(m => m.rawColumn === 'Salary Amount');
    expect(salaryMapping?.mappedTo).toBeNull(); // template not applied — wrong fileType
  });
});

// ---------------------------------------------------------------------------
// autoMap — fuzzy matching
// ---------------------------------------------------------------------------

describe('autoMap — fuzzy matching', () => {
  it('fuzzy-matches a 1-character typo to the closest entity field', () => {
    const entity = getBuiltInEntityDefinition(EntityType.TIME_ENTRY)!;
    // 'rade' is distance 1 from 'rate' (r-a-d-e vs r-a-t-e)
    const result = autoMap(
      makeParseResult([
        { name: 'entryId' },
        { name: 'doNotBill', type: 'boolean' },
        { name: 'rade', type: 'currency' }, // typo for 'rate'
        { name: 'durationMinutes', type: 'number' },
        { name: 'billableValue', type: 'currency' },
        { name: 'matterId' },
        { name: 'matterNumber', type: 'number' },
        { name: 'lawyerId' },
        { name: 'date', type: 'date' },
      ]),
      'wipJson',
      entity,
      []
    );

    const radeMapping = result.mappings.find(m => m.rawColumn === 'rade');
    expect(radeMapping?.mappedTo).toBe('rate');
    expect(radeMapping?.confidence).toBe('auto');
  });

  it('does not fuzzy-match if distance > 2', () => {
    const entity = getBuiltInEntityDefinition(EntityType.TIME_ENTRY)!;
    const result = autoMap(
      makeParseResult([{ name: 'totalFeesBilled' }]), // no field within distance 2
      'wipJson',
      entity,
      []
    );

    const m = result.mappings.find(m => m.rawColumn === 'totalFeesBilled');
    expect(m?.mappedTo).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// autoMap — unmapped / custom field suggestions
// ---------------------------------------------------------------------------

describe('autoMap — custom field suggestions', () => {
  it('adds non-null unmapped columns to customFieldSuggestions', () => {
    const entity = getBuiltInEntityDefinition(EntityType.TIME_ENTRY)!;
    const result = autoMap(
      makeParseResult([
        { name: 'entryId' },
        { name: 'doNotBill', type: 'boolean' },
        { name: 'rate', type: 'currency' },
        { name: 'durationMinutes', type: 'number' },
        { name: 'billableValue', type: 'currency' },
        { name: 'matterId' },
        { name: 'matterNumber', type: 'number' },
        { name: 'lawyerId' },
        { name: 'date', type: 'date' },
        { name: 'PracticeArea', type: 'string', nullPercent: 5 },   // good candidate
        { name: 'OriginatingPartner', type: 'string', nullPercent: 10 }, // good candidate
        { name: 'InternalRef', type: 'string', nullPercent: 80 },    // too sparse — no suggestion
      ]),
      'wipJson',
      entity,
      []
    );

    expect(result.unmappedColumns).toContain('PracticeArea');
    expect(result.unmappedColumns).toContain('OriginatingPartner');
    expect(result.unmappedColumns).toContain('InternalRef');

    const suggestions = result.customFieldSuggestions.map(s => s.rawColumn);
    expect(suggestions).toContain('PracticeArea');
    expect(suggestions).toContain('OriginatingPartner');
    expect(suggestions).not.toContain('InternalRef'); // > 50% null
  });

  it('records the detected type in customFieldSuggestions', () => {
    const entity = getBuiltInEntityDefinition(EntityType.TIME_ENTRY)!;
    const result = autoMap(
      makeParseResult([{ name: 'BillingNotes', type: 'string', nullPercent: 10 }]),
      'wipJson',
      entity,
      []
    );

    const suggestion = result.customFieldSuggestions.find(s => s.rawColumn === 'BillingNotes');
    expect(suggestion?.suggestedType).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// validateMappingSet
// ---------------------------------------------------------------------------

describe('validateMappingSet', () => {
  it('returns valid:true for a complete, duplicate-free mapping', () => {
    const entity = getBuiltInEntityDefinition(EntityType.TIME_ENTRY)!;
    const mappingSet = autoMap(
      makeParseResult([
        { name: 'entryId' },
        { name: 'doNotBill', type: 'boolean' },
        { name: 'rate', type: 'currency' },
        { name: 'durationMinutes', type: 'number' },
        { name: 'billableValue', type: 'currency' },
        { name: 'matterId' },
        { name: 'matterNumber', type: 'number' },
        { name: 'lawyerId' },
        { name: 'date', type: 'date' },
      ]),
      'wipJson',
      entity,
      []
    );

    const validation = validateMappingSet(mappingSet, entity);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  it('returns an error when two raw columns map to the same canonical field', () => {
    const entity = getBuiltInEntityDefinition(EntityType.TIME_ENTRY)!;

    // Construct a MappingSet with a duplicate manually
    const duplicateSet: MappingSet = {
      fileType: 'wipJson',
      entityKey: EntityType.TIME_ENTRY,
      mappings: [
        {
          rawColumn: 'entryId',
          mappedTo: 'entryId',
          entityKey: EntityType.TIME_ENTRY,
          isRequired: true,
          confidence: 'auto',
        },
        {
          rawColumn: 'EntryID', // different raw column, same target
          mappedTo: 'entryId',
          entityKey: EntityType.TIME_ENTRY,
          isRequired: false,
          confidence: 'manual',
        },
      ],
      missingRequiredFields: [],
      unmappedColumns: [],
      customFieldSuggestions: [],
      isComplete: true,
    };

    const validation = validateMappingSet(duplicateSet, entity);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some(e => e.toLowerCase().includes('duplicate'))).toBe(true);
  });

  it('returns an error when a required field has no mapping', () => {
    const entity = getBuiltInEntityDefinition(EntityType.TIME_ENTRY)!;

    const incompleteSet: MappingSet = {
      fileType: 'wipJson',
      entityKey: EntityType.TIME_ENTRY,
      mappings: [
        {
          rawColumn: 'entryId',
          mappedTo: 'entryId',
          entityKey: EntityType.TIME_ENTRY,
          isRequired: true,
          confidence: 'auto',
        },
        // lawyerId missing — it's required
      ],
      missingRequiredFields: ['lawyerId'],
      unmappedColumns: [],
      customFieldSuggestions: [],
      isComplete: false,
    };

    const validation = validateMappingSet(incompleteSet, entity);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some(e => e.includes('lawyerId'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getMappingSummary
// ---------------------------------------------------------------------------

describe('getMappingSummary', () => {
  it('returns a human-readable string describing the mapping state', () => {
    const entity = getBuiltInEntityDefinition(EntityType.TIME_ENTRY)!;
    const mappingSet = autoMap(
      makeParseResult([
        { name: 'entryId' },
        { name: 'doNotBill', type: 'boolean' },
        { name: 'rate', type: 'currency' },
        { name: 'durationMinutes', type: 'number' },
        { name: 'billableValue', type: 'currency' },
        { name: 'matterId' },
        { name: 'matterNumber', type: 'number' },
        { name: 'lawyerId' },
        { name: 'date', type: 'date' },
        { name: 'CustomColumn', nullPercent: 5 },
      ]),
      'wipJson',
      entity,
      []
    );

    const summary = getMappingSummary(mappingSet);
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(10);
    // Should mention mapped count and unmapped
    expect(summary).toMatch(/\d+ column/);
  });
});

// ---------------------------------------------------------------------------
// updateMapping
// ---------------------------------------------------------------------------

describe('updateMapping', () => {
  it('returns a new MappingSet with the updated mapping (immutable)', () => {
    const entity = getBuiltInEntityDefinition(EntityType.TIME_ENTRY)!;
    const original = autoMap(
      makeParseResult([{ name: 'someColumn' }]),
      'wipJson',
      entity,
      []
    );

    const updated = updateMapping(original, 'someColumn', 'writeOffValue');

    // Immutability: original unchanged
    const origMapping = original.mappings.find(m => m.rawColumn === 'someColumn');
    expect(origMapping?.mappedTo).toBeNull();

    // Updated mapping is set
    const updatedMapping = updated.mappings.find(m => m.rawColumn === 'someColumn');
    expect(updatedMapping?.mappedTo).toBe('writeOffValue');
    expect(updatedMapping?.confidence).toBe('manual');
  });
});
