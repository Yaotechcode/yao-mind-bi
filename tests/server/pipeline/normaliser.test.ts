import { describe, it, expect } from 'vitest';
import { normaliseRecords } from '../../../src/server/pipeline/normaliser.js';
import { FieldType, MissingBehaviour, EntityType } from '../../../src/shared/types/index.js';
import type { EntityDefinition, ColumnMapping } from '../../../src/shared/types/index.js';
import type { MappingSet, NormaliseOptions } from '../../../src/shared/types/pipeline.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEntityDef(
  entityType: EntityType,
  fields: Array<{ key: string; type: FieldType; required?: boolean; options?: string[] }>
): EntityDefinition {
  return {
    entityType,
    label: 'Test',
    labelPlural: 'Tests',
    fields: fields.map(f => ({
      key: f.key,
      label: f.key,
      type: f.type,
      required: f.required ?? false,
      builtIn: true,
      missingBehaviour: MissingBehaviour.EXCLUDE_FROM_ANALYSIS,
      options: f.options,
    })),
    relationships: [],
    primaryKey: 'id',
    displayField: 'name',
    supportsCustomFields: false,
  };
}

function makeMapping(sourceColumn: string, targetField: string): ColumnMapping {
  return { sourceColumn, targetField };
}

// ---------------------------------------------------------------------------
// 1. Column remapping
// ---------------------------------------------------------------------------

describe('normaliseRecords — column remapping', () => {
  it('maps source columns to target field keys', () => {
    const rows = [{ 'Matter Number': '1001', 'Responsible Lawyer': 'John Smith' }];
    const mappings: MappingSet = [
      makeMapping('Matter Number', 'matterNumber'),
      makeMapping('Responsible Lawyer', 'responsibleLawyer'),
    ];
    const entity = makeEntityDef(EntityType.MATTER, [
      { key: 'matterNumber', type: FieldType.STRING },
      { key: 'responsibleLawyer', type: FieldType.STRING },
    ]);

    const result = normaliseRecords(rows, mappings, 'matter', entity);

    expect(result.records).toHaveLength(1);
    expect(result.records[0].matterNumber).toBe('1001');
    expect(result.records[0].responsibleLawyer).toBe('John Smith');
  });

  it('sets _sourceRowIndex on each record', () => {
    const rows = [{ Name: 'Alice' }, { Name: 'Bob' }];
    const mappings: MappingSet = [makeMapping('Name', 'name')];
    const entity = makeEntityDef(EntityType.FEE_EARNER, [
      { key: 'name', type: FieldType.STRING },
    ]);

    const result = normaliseRecords(rows, mappings, 'feeEarner', entity);

    expect(result.records[0]._sourceRowIndex).toBe(0);
    expect(result.records[1]._sourceRowIndex).toBe(1);
  });

  it('ignores unmapped columns', () => {
    const rows = [{ 'Known Field': 'value', 'Unknown Field': 'should be ignored' }];
    const mappings: MappingSet = [makeMapping('Known Field', 'knownField')];
    const entity = makeEntityDef(EntityType.MATTER, [
      { key: 'knownField', type: FieldType.STRING },
    ]);

    const result = normaliseRecords(rows, mappings, 'matter', entity);

    expect(result.records[0]).not.toHaveProperty('Unknown Field');
    expect(result.records[0]).not.toHaveProperty('unknownField');
  });
});

// ---------------------------------------------------------------------------
// 2. Type coercion
// ---------------------------------------------------------------------------

describe('normaliseRecords — type coercion', () => {
  it('coerces string: trims whitespace', () => {
    const rows = [{ name: '  Alice  ' }];
    const mappings: MappingSet = [makeMapping('name', 'name')];
    const entity = makeEntityDef(EntityType.FEE_EARNER, [{ key: 'name', type: FieldType.STRING }]);

    const result = normaliseRecords(rows, mappings, 'feeEarner', entity);

    expect(result.records[0].name).toBe('Alice');
  });

  it('coerces string: empty string → null', () => {
    const rows = [{ name: '', lawyerId: 'fe-001' }];
    const mappings: MappingSet = [makeMapping('name', 'name'), makeMapping('lawyerId', 'lawyerId')];
    const entity = makeEntityDef(EntityType.FEE_EARNER, [
      { key: 'name', type: FieldType.STRING },
      { key: 'lawyerId', type: FieldType.STRING },
    ]);

    const result = normaliseRecords(rows, mappings, 'feeEarner', entity);

    expect(result.records[0].name).toBeNull();
  });

  it('coerces number: strips non-numeric chars and parses', () => {
    const rows = [{ units: '42.5 hrs' }];
    const mappings: MappingSet = [makeMapping('units', 'units')];
    const entity = makeEntityDef(EntityType.TIME_ENTRY, [{ key: 'units', type: FieldType.NUMBER }]);

    const result = normaliseRecords(rows, mappings, 'timeEntry', entity);

    expect(result.records[0].units).toBe(42.5);
  });

  it('coerces number: non-parseable → null + warning', () => {
    const rows = [{ units: 'n/a', entryId: 'e-001' }];
    const mappings: MappingSet = [makeMapping('units', 'units'), makeMapping('entryId', 'entryId')];
    const entity = makeEntityDef(EntityType.TIME_ENTRY, [
      { key: 'units', type: FieldType.NUMBER },
      { key: 'entryId', type: FieldType.STRING },
    ]);

    const result = normaliseRecords(rows, mappings, 'timeEntry', entity);

    expect(result.records[0].units).toBeNull();
    expect(result.warnings?.some(w => w.field === 'units')).toBe(true);
  });

  it('coerces currency: strips £ and commas', () => {
    const rows = [{ billable: '£1,234.56' }];
    const mappings: MappingSet = [makeMapping('billable', 'billable')];
    const entity = makeEntityDef(EntityType.TIME_ENTRY, [{ key: 'billable', type: FieldType.CURRENCY }]);

    const result = normaliseRecords(rows, mappings, 'timeEntry', entity);

    expect(result.records[0].billable).toBeCloseTo(1234.56);
  });

  it('coerces percentage: whole number (75.5) → kept as-is', () => {
    const rows = [{ utilisation: '75.5' }];
    const mappings: MappingSet = [makeMapping('utilisation', 'utilisation')];
    const entity = makeEntityDef(EntityType.FEE_EARNER, [{ key: 'utilisation', type: FieldType.PERCENTAGE }]);

    const result = normaliseRecords(rows, mappings, 'feeEarner', entity);

    expect(result.records[0].utilisation).toBeCloseTo(75.5);
  });

  it('coerces percentage: decimal (0.755) → multiplied by 100', () => {
    const rows = [{ utilisation: '0.755' }];
    const mappings: MappingSet = [makeMapping('utilisation', 'utilisation')];
    const entity = makeEntityDef(EntityType.FEE_EARNER, [{ key: 'utilisation', type: FieldType.PERCENTAGE }]);

    const result = normaliseRecords(rows, mappings, 'feeEarner', entity);

    expect(result.records[0].utilisation).toBeCloseTo(75.5);
  });

  it('coerces boolean: "yes" → true, "no" → false, "1" → true, "0" → false', () => {
    const rows = [
      { active: 'yes' },
      { active: 'no' },
      { active: '1' },
      { active: '0' },
    ];
    const mappings: MappingSet = [makeMapping('active', 'active')];
    const entity = makeEntityDef(EntityType.FEE_EARNER, [{ key: 'active', type: FieldType.BOOLEAN }]);

    const result = normaliseRecords(rows, mappings, 'feeEarner', entity);

    expect(result.records[0].active).toBe(true);
    expect(result.records[1].active).toBe(false);
    expect(result.records[2].active).toBe(true);
    expect(result.records[3].active).toBe(false);
  });

  it('coerces date: ISO string → Date object', () => {
    const rows = [{ createdDate: '2024-01-15' }];
    const mappings: MappingSet = [makeMapping('createdDate', 'createdDate')];
    const entity = makeEntityDef(EntityType.MATTER, [{ key: 'createdDate', type: FieldType.DATE }]);

    const result = normaliseRecords(rows, mappings, 'matter', entity);

    expect(result.records[0].createdDate).toBeInstanceOf(Date);
    const d = result.records[0].createdDate as Date;
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(0); // January
    expect(d.getDate()).toBe(15);
  });

  it('coerces date: UK format dd/mm/yyyy → Date object', () => {
    const rows = [{ createdDate: '15/01/2024' }];
    const mappings: MappingSet = [makeMapping('createdDate', 'createdDate')];
    const entity = makeEntityDef(EntityType.MATTER, [{ key: 'createdDate', type: FieldType.DATE }]);

    const result = normaliseRecords(rows, mappings, 'matter', entity);

    expect(result.records[0].createdDate).toBeInstanceOf(Date);
    const d = result.records[0].createdDate as Date;
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(15);
  });

  it('select: warns when value not in options but keeps the value', () => {
    const rows = [{ status: 'Unknown Status' }];
    const mappings: MappingSet = [makeMapping('status', 'status')];
    const entity = makeEntityDef(EntityType.MATTER, [
      { key: 'status', type: FieldType.SELECT, options: ['Active', 'Closed'] },
    ]);

    const result = normaliseRecords(rows, mappings, 'matter', entity);

    expect(result.records[0].status).toBe('Unknown Status');
    expect(result.warnings?.some(w => w.field === 'status')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Entity-specific normalisations — feeEarner
// ---------------------------------------------------------------------------

describe('normaliseRecords — feeEarner entity-specific rules', () => {
  it('normalises payModel: "Fee Share" → "FeeShare"', () => {
    const rows = [{ payModel: 'Fee Share' }];
    const mappings: MappingSet = [makeMapping('payModel', 'payModel')];
    const entity = makeEntityDef(EntityType.FEE_EARNER, [{ key: 'payModel', type: FieldType.STRING }]);

    const result = normaliseRecords(rows, mappings, 'feeEarner', entity);

    expect(result.records[0].payModel).toBe('FeeShare');
  });

  it('normalises payModel: "fee-share" → "FeeShare"', () => {
    const rows = [{ payModel: 'fee-share' }];
    const mappings: MappingSet = [makeMapping('payModel', 'payModel')];
    const entity = makeEntityDef(EntityType.FEE_EARNER, [{ key: 'payModel', type: FieldType.STRING }]);

    const result = normaliseRecords(rows, mappings, 'feeEarner', entity);

    expect(result.records[0].payModel).toBe('FeeShare');
  });

  it('normalises payModel: "salary" → "Salaried"', () => {
    const rows = [{ payModel: 'salary' }];
    const mappings: MappingSet = [makeMapping('payModel', 'payModel')];
    const entity = makeEntityDef(EntityType.FEE_EARNER, [{ key: 'payModel', type: FieldType.STRING }]);

    const result = normaliseRecords(rows, mappings, 'feeEarner', entity);

    expect(result.records[0].payModel).toBe('Salaried');
  });

  it('normalises payModel: "salaried" → "Salaried"', () => {
    const rows = [{ payModel: 'salaried' }];
    const mappings: MappingSet = [makeMapping('payModel', 'payModel')];
    const entity = makeEntityDef(EntityType.FEE_EARNER, [{ key: 'payModel', type: FieldType.STRING }]);

    const result = normaliseRecords(rows, mappings, 'feeEarner', entity);

    expect(result.records[0].payModel).toBe('Salaried');
  });

  it('derives monthlySalary from annualSalary when monthly is absent', () => {
    const rows = [{ annualSalary: 60000 }];
    const mappings: MappingSet = [makeMapping('annualSalary', 'annualSalary')];
    const entity = makeEntityDef(EntityType.FEE_EARNER, [
      { key: 'annualSalary', type: FieldType.CURRENCY },
      { key: 'monthlySalary', type: FieldType.CURRENCY },
    ]);

    const result = normaliseRecords(rows, mappings, 'feeEarner', entity);

    expect(result.records[0].monthlySalary).toBeCloseTo(5000);
  });

  it('defaults isSystemAccount to false when missing', () => {
    const rows = [{ name: 'Alice' }];
    const mappings: MappingSet = [makeMapping('name', 'name')];
    const entity = makeEntityDef(EntityType.FEE_EARNER, [
      { key: 'name', type: FieldType.STRING },
      { key: 'isSystemAccount', type: FieldType.BOOLEAN },
    ]);

    const result = normaliseRecords(rows, mappings, 'feeEarner', entity);

    expect(result.records[0].isSystemAccount).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Entity-specific normalisations — timeEntry
// ---------------------------------------------------------------------------

describe('normaliseRecords — timeEntry entity-specific rules', () => {
  it('derives durationMinutes from durationHours when minutes absent', () => {
    const rows = [{ durationHours: '2.5' }];
    const mappings: MappingSet = [makeMapping('durationHours', 'durationHours')];
    const entity = makeEntityDef(EntityType.TIME_ENTRY, [
      { key: 'durationHours', type: FieldType.NUMBER },
      { key: 'durationMinutes', type: FieldType.NUMBER },
    ]);

    const result = normaliseRecords(rows, mappings, 'timeEntry', entity);

    expect(result.records[0].durationMinutes).toBeCloseTo(150);
  });

  it('derives billableValue from rate × durationMinutes when absent', () => {
    const rows = [{ rate: '300', durationMinutes: '60' }];
    const mappings: MappingSet = [
      makeMapping('rate', 'rate'),
      makeMapping('durationMinutes', 'durationMinutes'),
    ];
    const entity = makeEntityDef(EntityType.TIME_ENTRY, [
      { key: 'rate', type: FieldType.CURRENCY },
      { key: 'durationMinutes', type: FieldType.NUMBER },
      { key: 'billableValue', type: FieldType.CURRENCY },
    ]);

    const result = normaliseRecords(rows, mappings, 'timeEntry', entity);

    expect(result.records[0].billableValue).toBeCloseTo(300);
  });

  it('defaults writeOffValue to 0 when missing', () => {
    const rows = [{ entryId: 'e1' }];
    const mappings: MappingSet = [makeMapping('entryId', 'entryId')];
    const entity = makeEntityDef(EntityType.TIME_ENTRY, [
      { key: 'entryId', type: FieldType.STRING },
      { key: 'writeOffValue', type: FieldType.CURRENCY },
    ]);

    const result = normaliseRecords(rows, mappings, 'timeEntry', entity);

    expect(result.records[0].writeOffValue).toBe(0);
  });

  it('defaults doNotBill to false when missing', () => {
    const rows = [{ entryId: 'e1' }];
    const mappings: MappingSet = [makeMapping('entryId', 'entryId')];
    const entity = makeEntityDef(EntityType.TIME_ENTRY, [
      { key: 'entryId', type: FieldType.STRING },
      { key: 'doNotBill', type: FieldType.BOOLEAN },
    ]);

    const result = normaliseRecords(rows, mappings, 'timeEntry', entity);

    expect(result.records[0].doNotBill).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Entity-specific normalisations — invoice
// ---------------------------------------------------------------------------

describe('normaliseRecords — invoice entity-specific rules', () => {
  it('derives total from paid + outstanding when total is absent', () => {
    const rows = [{ paid: '5000', outstanding: '2500' }];
    const mappings: MappingSet = [
      makeMapping('paid', 'paid'),
      makeMapping('outstanding', 'outstanding'),
    ];
    const entity = makeEntityDef(EntityType.INVOICE, [
      { key: 'paid', type: FieldType.CURRENCY },
      { key: 'outstanding', type: FieldType.CURRENCY },
      { key: 'total', type: FieldType.CURRENCY },
    ]);

    const result = normaliseRecords(rows, mappings, 'invoice', entity);

    expect(result.records[0].total).toBeCloseTo(7500);
  });

  it('defaults outstanding and paid to 0 when missing', () => {
    const rows = [{ invoiceId: 'INV-001' }];
    const mappings: MappingSet = [makeMapping('invoiceId', 'invoiceId')];
    const entity = makeEntityDef(EntityType.INVOICE, [
      { key: 'invoiceId', type: FieldType.STRING },
      { key: 'outstanding', type: FieldType.CURRENCY },
      { key: 'paid', type: FieldType.CURRENCY },
    ]);

    const result = normaliseRecords(rows, mappings, 'invoice', entity);

    expect(result.records[0].outstanding).toBe(0);
    expect(result.records[0].paid).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Entity-specific normalisations — disbursement
// ---------------------------------------------------------------------------

describe('normaliseRecords — disbursement entity-specific rules', () => {
  it('parses clientId from JSON array format', () => {
    const rows = [{ clientId: '[{"contact":"contact-uuid-123","display_name":"Acme Corp"}]' }];
    const mappings: MappingSet = [makeMapping('clientId', 'clientId')];
    const entity = makeEntityDef(EntityType.DISBURSEMENT, [
      { key: 'clientId', type: FieldType.STRING },
      { key: 'clientName', type: FieldType.STRING },
    ]);

    const result = normaliseRecords(rows, mappings, 'disbursement', entity);

    expect(result.records[0].clientId).toBe('contact-uuid-123');
    expect(result.records[0].clientName).toBe('Acme Corp');
  });
});

// ---------------------------------------------------------------------------
// 7. Null handling
// ---------------------------------------------------------------------------

describe('normaliseRecords — null handling', () => {
  it('default mode: null required field → row kept + warning added', () => {
    const rows = [{ name: '', lawyerId: 'fe-001' }];
    const mappings: MappingSet = [makeMapping('name', 'name'), makeMapping('lawyerId', 'lawyerId')];
    const entity = makeEntityDef(EntityType.FEE_EARNER, [
      { key: 'name', type: FieldType.STRING, required: true },
      { key: 'lawyerId', type: FieldType.STRING },
    ]);

    const result = normaliseRecords(rows, mappings, 'feeEarner', entity);

    expect(result.records).toHaveLength(1);
    expect(result.warnings?.some(w => w.field === 'name')).toBe(true);
    expect(result.rejectedRows ?? []).toHaveLength(0);
  });

  it('blank row (all mapped fields null) → always rejected regardless of strictMode', () => {
    const rows = [
      { name: '', salary: '' },
      { name: 'Alice', salary: '50000' },
    ];
    const mappings: MappingSet = [
      makeMapping('name', 'name'),
      makeMapping('salary', 'salary'),
    ];
    const entity = makeEntityDef(EntityType.FEE_EARNER, [
      { key: 'name', type: FieldType.STRING },
      { key: 'salary', type: FieldType.CURRENCY },
    ]);

    const result = normaliseRecords(rows, mappings, 'feeEarner', entity);

    expect(result.records).toHaveLength(1);
    expect(result.records[0].name).toBe('Alice');
    expect(result.rejectedRows).toHaveLength(1);
    expect(result.rejectedRows![0].rowIndex).toBe(0);
    expect(result.rejectedRows![0].reason).toBe('blank row (all mapped fields null)');
  });

  it('strictMode: null required field → row rejected', () => {
    const rows = [{ name: '' }];
    const mappings: MappingSet = [makeMapping('name', 'name')];
    const entity = makeEntityDef(EntityType.FEE_EARNER, [
      { key: 'name', type: FieldType.STRING, required: true },
    ]);
    const options: NormaliseOptions = { strictMode: true };

    const result = normaliseRecords(rows, mappings, 'feeEarner', entity, options);

    expect(result.records).toHaveLength(0);
    expect(result.rejectedRows).toHaveLength(1);
    expect(result.rejectedRows![0].rowIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Deduplication
// ---------------------------------------------------------------------------

describe('normaliseRecords — deduplication', () => {
  it('keeps first occurrence of duplicate primary key, adds warning', () => {
    const rows = [
      { entryId: 'e1', billable: '100' },
      { entryId: 'e1', billable: '200' },
    ];
    const mappings: MappingSet = [
      makeMapping('entryId', 'entryId'),
      makeMapping('billable', 'billable'),
    ];
    const entity: EntityDefinition = {
      entityType: EntityType.TIME_ENTRY,
      label: 'Time Entry',
      labelPlural: 'Time Entries',
      fields: [
        { key: 'entryId', label: 'Entry ID', type: FieldType.STRING, required: true, builtIn: true, missingBehaviour: MissingBehaviour.EXCLUDE_FROM_ANALYSIS },
        { key: 'billable', label: 'Billable', type: FieldType.CURRENCY, required: false, builtIn: true, missingBehaviour: MissingBehaviour.EXCLUDE_FROM_ANALYSIS },
      ],
      relationships: [],
      primaryKey: 'entryId',
      displayField: 'entryId',
      supportsCustomFields: false,
    };

    const result = normaliseRecords(rows, mappings, 'timeEntry', entity);

    expect(result.records).toHaveLength(1);
    expect(result.records[0].billable).toBeCloseTo(100);
    expect(result.warnings?.some(w => w.field === 'entryId')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. fieldStats
// ---------------------------------------------------------------------------

describe('normaliseRecords — fieldStats', () => {
  it('tracks null count and percent per field', () => {
    const rows = [
      { name: 'Alice', salary: '50000' },
      { name: '', salary: '' },
    ];
    const mappings: MappingSet = [
      makeMapping('name', 'name'),
      makeMapping('salary', 'salary'),
    ];
    const entity = makeEntityDef(EntityType.FEE_EARNER, [
      { key: 'name', type: FieldType.STRING },
      { key: 'salary', type: FieldType.CURRENCY },
    ]);

    const result = normaliseRecords(rows, mappings, 'feeEarner', entity);

    expect(result.fieldStats?.name.nullCount).toBe(1);
    expect(result.fieldStats?.name.nullPercent).toBeCloseTo(50);
    expect(result.fieldStats?.salary.nullCount).toBe(1);
  });
});
