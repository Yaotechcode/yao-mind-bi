import { describe, it, expect } from 'vitest';
import {
  getBuiltInEntityDefinitions,
  getBuiltInEntityDefinition,
} from '../../../src/shared/entities/registry.js';
import {
  EntityType,
  MissingBehaviour,
  RelationshipType,
} from '../../../src/shared/types/index.js';

const VALID_ENTITY_TYPES = new Set(Object.values(EntityType));

describe('getBuiltInEntityDefinitions', () => {
  it('returns exactly 9 entity definitions', () => {
    const defs = getBuiltInEntityDefinitions();
    expect(defs).toHaveLength(9);
  });

  it('includes all 9 required entity types', () => {
    const defs = getBuiltInEntityDefinitions();
    const types = new Set(defs.map((d) => d.entityType));

    expect(types.has(EntityType.FEE_EARNER)).toBe(true);
    expect(types.has(EntityType.MATTER)).toBe(true);
    expect(types.has(EntityType.TIME_ENTRY)).toBe(true);
    expect(types.has(EntityType.INVOICE)).toBe(true);
    expect(types.has(EntityType.CLIENT)).toBe(true);
    expect(types.has(EntityType.DISBURSEMENT)).toBe(true);
    expect(types.has(EntityType.DEPARTMENT)).toBe(true);
    expect(types.has(EntityType.TASK)).toBe(true);
    expect(types.has(EntityType.FIRM)).toBe(true);
  });

  it('marks all entities as built-in', () => {
    const defs = getBuiltInEntityDefinitions();
    for (const def of defs) {
      expect(def.isBuiltIn, `${def.entityType} should have isBuiltIn: true`).toBe(true);
    }
  });

  it('every entity has a non-empty label, labelPlural, icon, description, dataSource', () => {
    const defs = getBuiltInEntityDefinitions();
    for (const def of defs) {
      expect(def.label, `${def.entityType} missing label`).toBeTruthy();
      expect(def.labelPlural, `${def.entityType} missing labelPlural`).toBeTruthy();
      expect(def.icon, `${def.entityType} missing icon`).toBeTruthy();
      expect(def.description, `${def.entityType} missing description`).toBeTruthy();
      expect(def.dataSource, `${def.entityType} missing dataSource`).toBeTruthy();
    }
  });

  it('every entity has a non-empty primaryKey and displayField', () => {
    const defs = getBuiltInEntityDefinitions();
    for (const def of defs) {
      expect(def.primaryKey, `${def.entityType} missing primaryKey`).toBeTruthy();
      expect(def.displayField, `${def.entityType} missing displayField`).toBeTruthy();
    }
  });
});

describe('Field definitions', () => {
  it('every field has required properties: key, label, type, required, builtIn, missingBehaviour', () => {
    const defs = getBuiltInEntityDefinitions();
    for (const def of defs) {
      for (const field of def.fields) {
        expect(field.key, `${def.entityType}.field missing key`).toBeTruthy();
        expect(field.label, `${def.entityType}.${field.key} missing label`).toBeTruthy();
        expect(field.type, `${def.entityType}.${field.key} missing type`).toBeTruthy();
        expect(typeof field.required, `${def.entityType}.${field.key} required must be boolean`).toBe(
          'boolean',
        );
        expect(field.builtIn, `${def.entityType}.${field.key} builtIn must be true`).toBe(true);
        expect(
          field.missingBehaviour,
          `${def.entityType}.${field.key} missing missingBehaviour`,
        ).toBeTruthy();
      }
    }
  });

  it('no duplicate field keys within any entity', () => {
    const defs = getBuiltInEntityDefinitions();
    for (const def of defs) {
      const keys = def.fields.map((f) => f.key);
      const uniqueKeys = new Set(keys);
      expect(
        uniqueKeys.size,
        `${def.entityType} has duplicate field keys: ${keys.filter((k, i) => keys.indexOf(k) !== i).join(', ')}`,
      ).toBe(keys.length);
    }
  });

  it('SELECT fields always have options array', () => {
    const defs = getBuiltInEntityDefinitions();
    for (const def of defs) {
      for (const field of def.fields) {
        if (field.type === 'select') {
          expect(
            field.options,
            `${def.entityType}.${field.key} is SELECT but has no options`,
          ).toBeDefined();
          expect(
            (field.options ?? []).length,
            `${def.entityType}.${field.key} SELECT options must be non-empty`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it('REFERENCE fields have referencesEntity', () => {
    const defs = getBuiltInEntityDefinitions();
    for (const def of defs) {
      for (const field of def.fields) {
        if (field.type === 'reference') {
          expect(
            field.referencesEntity,
            `${def.entityType}.${field.key} is REFERENCE but missing referencesEntity`,
          ).toBeTruthy();
        }
      }
    }
  });

  describe('Extensible fields', () => {
    it('activityType on timeEntry has missingBehaviour and enablesFeatures', () => {
      const def = getBuiltInEntityDefinition(EntityType.TIME_ENTRY)!;
      const activityType = def.fields.find((f) => f.key === 'activityType');
      expect(activityType).toBeDefined();
      expect(activityType!.missingBehaviour).toBe(MissingBehaviour.EXCLUDE_FROM_ANALYSIS);
      expect(activityType!.enablesFeatures).toBeDefined();
      expect(activityType!.enablesFeatures!.length).toBeGreaterThan(0);
    });

    it('description on timeEntry has missingBehaviour and enablesFeatures', () => {
      const def = getBuiltInEntityDefinition(EntityType.TIME_ENTRY)!;
      const description = def.fields.find((f) => f.key === 'description');
      expect(description).toBeDefined();
      expect(description!.missingBehaviour).toBe(MissingBehaviour.HIDE_COLUMN);
      expect(description!.enablesFeatures).toBeDefined();
      expect(description!.enablesFeatures!.length).toBeGreaterThan(0);
    });

    it('datePaid on invoice has missingBehaviour and enablesFeatures', () => {
      const def = getBuiltInEntityDefinition(EntityType.INVOICE)!;
      const datePaid = def.fields.find((f) => f.key === 'datePaid');
      expect(datePaid).toBeDefined();
      expect(datePaid!.missingBehaviour).toBe(MissingBehaviour.EXCLUDE_FROM_ANALYSIS);
      expect(datePaid!.enablesFeatures).toBeDefined();
      expect(datePaid!.enablesFeatures!.length).toBeGreaterThan(0);
    });

    it('description on disbursement has missingBehaviour and enablesFeatures', () => {
      const def = getBuiltInEntityDefinition(EntityType.DISBURSEMENT)!;
      const description = def.fields.find((f) => f.key === 'description');
      expect(description).toBeDefined();
      expect(description!.missingBehaviour).toBe(MissingBehaviour.HIDE_COLUMN);
      expect(description!.enablesFeatures).toBeDefined();
      expect(description!.enablesFeatures!.length).toBeGreaterThan(0);
    });
  });
});

describe('Relationship definitions', () => {
  it('all relationships reference valid entity types', () => {
    const defs = getBuiltInEntityDefinitions();
    for (const def of defs) {
      for (const rel of def.relationships) {
        expect(
          VALID_ENTITY_TYPES.has(rel.targetEntity),
          `${def.entityType}.${rel.key} references invalid entity type "${rel.targetEntity}"`,
        ).toBe(true);
      }
    }
  });

  it('no duplicate relationship keys within any entity', () => {
    const defs = getBuiltInEntityDefinitions();
    for (const def of defs) {
      const keys = def.relationships.map((r) => r.key);
      const uniqueKeys = new Set(keys);
      expect(
        uniqueKeys.size,
        `${def.entityType} has duplicate relationship keys: ${keys.filter((k, i) => keys.indexOf(k) !== i).join(', ')}`,
      ).toBe(keys.length);
    }
  });

  it('every relationship has key, type, targetEntity, localKey, foreignKey', () => {
    const defs = getBuiltInEntityDefinitions();
    for (const def of defs) {
      for (const rel of def.relationships) {
        expect(rel.key, `${def.entityType} relationship missing key`).toBeTruthy();
        expect(rel.type, `${def.entityType}.${rel.key} missing type`).toBeTruthy();
        expect(rel.targetEntity, `${def.entityType}.${rel.key} missing targetEntity`).toBeTruthy();
        expect(rel.localKey, `${def.entityType}.${rel.key} missing localKey`).toBeTruthy();
        expect(rel.foreignKey, `${def.entityType}.${rel.key} missing foreignKey`).toBeTruthy();
      }
    }
  });

  it('hasMany and belongsTo relationships are correctly typed', () => {
    const defs = getBuiltInEntityDefinitions();
    for (const def of defs) {
      for (const rel of def.relationships) {
        expect(
          [RelationshipType.HAS_MANY, RelationshipType.BELONGS_TO, RelationshipType.HAS_ONE],
          `${def.entityType}.${rel.key} has unknown relationship type "${rel.type}"`,
        ).toContain(rel.type);
      }
    }
  });
});

describe('Specific entity structure', () => {
  it('feeEarner has payModel field with correct options', () => {
    const def = getBuiltInEntityDefinition(EntityType.FEE_EARNER)!;
    const payModel = def.fields.find((f) => f.key === 'payModel');
    expect(payModel).toBeDefined();
    expect(payModel!.required).toBe(true);
    expect(payModel!.options).toContain('Salaried');
    expect(payModel!.options).toContain('FeeShare');
  });

  it('matter has derived fields: isActive, isClosed, hasClosedMatterData', () => {
    const def = getBuiltInEntityDefinition(EntityType.MATTER)!;
    const keys = def.fields.map((f) => f.key);
    expect(keys).toContain('isActive');
    expect(keys).toContain('isClosed');
    expect(keys).toContain('hasClosedMatterData');
  });

  it('timeEntry has derived field hasMatchedMatter', () => {
    const def = getBuiltInEntityDefinition(EntityType.TIME_ENTRY)!;
    const field = def.fields.find((f) => f.key === 'hasMatchedMatter');
    expect(field).toBeDefined();
    expect(field!.missingBehaviour).toBe(MissingBehaviour.EXCLUDE_FROM_ANALYSIS);
  });

  it('invoice writtenOff field has a description explaining its numeric nature', () => {
    const def = getBuiltInEntityDefinition(EntityType.INVOICE)!;
    const writtenOff = def.fields.find((f) => f.key === 'writtenOff');
    expect(writtenOff).toBeDefined();
    expect(writtenOff!.description).toBeTruthy();
  });

  it('feeEarner primaryKey is "id" and displayField is "name"', () => {
    const def = getBuiltInEntityDefinition(EntityType.FEE_EARNER)!;
    expect(def.primaryKey).toBe('id');
    expect(def.displayField).toBe('name');
  });

  it('department is derived from matter.department', () => {
    const def = getBuiltInEntityDefinition(EntityType.DEPARTMENT)!;
    expect(def.dataSource).toBe('derived');
  });

  it('firm has supportsCustomFields = false', () => {
    const def = getBuiltInEntityDefinition(EntityType.FIRM)!;
    expect(def.supportsCustomFields).toBe(false);
  });

  it('task priority field has correct options', () => {
    const def = getBuiltInEntityDefinition(EntityType.TASK)!;
    const priority = def.fields.find((f) => f.key === 'priority');
    expect(priority).toBeDefined();
    expect(priority!.options).toEqual(expect.arrayContaining(['STANDARD', 'HIGH', 'URGENT']));
  });
});

describe('getBuiltInEntityDefinition', () => {
  it('returns correct entity for a valid type', () => {
    const def = getBuiltInEntityDefinition(EntityType.MATTER);
    expect(def).toBeDefined();
    expect(def!.entityType).toBe(EntityType.MATTER);
  });

  it('returns undefined for an unknown type', () => {
    const def = getBuiltInEntityDefinition('unknown' as EntityType);
    expect(def).toBeUndefined();
  });
});
