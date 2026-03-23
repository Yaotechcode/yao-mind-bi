import type { EntityDefinition } from '../../shared/types/index.js';
import type {
  MappingSet,
  MappingTemplate,
  MappingValidationResult,
} from '../../shared/mapping/types.js';

// ---------------------------------------------------------------------------
// validateMappingSet
// ---------------------------------------------------------------------------

/**
 * Validates a MappingSet against the entity definition.
 * Returns a list of errors and warnings.
 */
export function validateMappingSet(
  mappingSet: MappingSet,
  entity: EntityDefinition,
): MappingValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check for missing required fields
  const requiredFields = new Set(
    entity.fields.filter(f => f.required).map(f => f.key)
  );
  const mappedTargets = mappingSet.mappings
    .filter(m => m.mappedTo !== null)
    .map(m => m.mappedTo as string);

  for (const fieldKey of requiredFields) {
    if (!mappedTargets.includes(fieldKey)) {
      errors.push(`Required field "${fieldKey}" has no column mapping`);
    }
  }

  // Check for duplicate mappings (two raw columns → same canonical field)
  const targetCount = new Map<string, number>();
  for (const target of mappedTargets) {
    targetCount.set(target, (targetCount.get(target) ?? 0) + 1);
  }
  for (const [target, count] of targetCount) {
    if (count > 1) {
      errors.push(`Duplicate mapping: "${target}" is mapped from ${count} columns`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// getMappingSummary
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable summary of the current mapping state.
 */
export function getMappingSummary(mappingSet: MappingSet): string {
  const total = mappingSet.mappings.length;
  const mapped = mappingSet.mappings.filter(m => m.mappedTo !== null).length;
  const unmapped = mappingSet.unmappedColumns.length;
  const missing = mappingSet.missingRequiredFields.length;

  const parts: string[] = [
    `${mapped} of ${total} column${total !== 1 ? 's' : ''} mapped`,
  ];

  if (unmapped > 0) {
    parts.push(`${unmapped} unmapped`);
  }

  if (missing > 0) {
    parts.push(`${missing} required field${missing !== 1 ? 's' : ''} missing`);
  } else {
    parts.push('all required fields covered');
  }

  return parts.join(', ') + '.';
}

// ---------------------------------------------------------------------------
// updateMapping
// ---------------------------------------------------------------------------

/**
 * Returns a new MappingSet with the specified rawColumn mapped to mappedTo.
 * Immutable — the original MappingSet is not modified.
 */
export function updateMapping(
  mappingSet: MappingSet,
  rawColumn: string,
  mappedTo: string | null,
): MappingSet {
  const updatedMappings = mappingSet.mappings.map(m =>
    m.rawColumn === rawColumn
      ? { ...m, mappedTo, confidence: 'manual' as const }
      : m
  );

  const mappedTargets = updatedMappings
    .filter(m => m.mappedTo !== null)
    .map(m => m.mappedTo as string);

  const unmappedColumns = updatedMappings
    .filter(m => m.mappedTo === null)
    .map(m => m.rawColumn);

  // Recompute missingRequiredFields based on the isRequired flags in the original
  // mappings (they reflect the entity definition and don't change)
  const requiredTargets = new Set(
    updatedMappings.filter(m => m.isRequired).map(m =>
      // isRequired was set at autoMap time based on the original mappedTo —
      // find the required field keys from mappings that were originally required
      m.rawColumn
    )
  );
  // Simpler: re-derive from entity required fields that are now unmapped
  // We don't have the entity here, so use existing isRequired info:
  // A required field is missing when no mapping has isRequired:true AND mappedTo === that field.
  // Instead, track which required fields are now covered.
  const coveredRequired = new Set(
    updatedMappings
      .filter(m => m.mappedTo !== null && m.isRequired)
      .map(m => m.mappedTo as string)
  );

  // For the newly-mapped column, if it maps to a required field, update isRequired
  const finalMappings = updatedMappings.map(m => {
    if (m.rawColumn === rawColumn && mappedTo !== null) {
      // isRequired should reflect whether mappedTo is a required field.
      // We re-use the flag from the first mapping that targets this field (if any).
      const existingWithSameTarget = mappingSet.mappings.find(
        om => om.mappedTo === mappedTo
      );
      return {
        ...m,
        isRequired: existingWithSameTarget?.isRequired ?? false,
      };
    }
    return m;
  });

  // Rebuild missingRequiredFields: required fields that have no mapping
  const allRequiredFields = new Set(
    mappingSet.mappings
      .filter(m => m.isRequired && m.mappedTo !== null)
      .map(m => m.mappedTo as string)
  );
  // Also include required fields from the original missing list
  for (const f of mappingSet.missingRequiredFields) {
    allRequiredFields.add(f);
  }

  const finalMappedTargets = new Set(
    finalMappings.filter(m => m.mappedTo !== null).map(m => m.mappedTo as string)
  );
  const missingRequiredFields = [...allRequiredFields].filter(
    f => !finalMappedTargets.has(f)
  );

  return {
    ...mappingSet,
    mappings: finalMappings,
    unmappedColumns,
    missingRequiredFields,
    isComplete: missingRequiredFields.length === 0,
  };
}

// ---------------------------------------------------------------------------
// updateTypeOverride
// ---------------------------------------------------------------------------

/**
 * Returns a new MappingSet with a type override applied to the specified column.
 */
export function updateTypeOverride(
  mappingSet: MappingSet,
  rawColumn: string,
  typeOverride: NonNullable<(typeof mappingSet.mappings)[0]['typeOverride']>,
): MappingSet {
  return {
    ...mappingSet,
    mappings: mappingSet.mappings.map(m =>
      m.rawColumn === rawColumn ? { ...m, typeOverride } : m
    ),
  };
}

// ---------------------------------------------------------------------------
// saveMappingAsTemplate
// ---------------------------------------------------------------------------

/**
 * Converts a MappingSet into a MappingTemplate (without id/firmId — caller
 * assigns those before persisting to Supabase).
 */
export function buildTemplateFromMappingSet(
  mappingSet: MappingSet,
  name: string,
): Omit<MappingTemplate, 'id' | 'firmId'> {
  const mappings: Record<string, string> = {};
  const typeOverrides: Record<string, NonNullable<(typeof mappingSet.mappings)[0]['typeOverride']>> = {};

  for (const m of mappingSet.mappings) {
    if (m.mappedTo !== null) {
      mappings[m.rawColumn] = m.mappedTo;
    }
    if (m.typeOverride) {
      typeOverrides[m.rawColumn] = m.typeOverride;
    }
  }

  return {
    name,
    fileType: mappingSet.fileType,
    mappings,
    typeOverrides,
    createdAt: new Date().toISOString(),
  };
}
