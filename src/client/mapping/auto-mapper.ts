import type { ParseResult } from '../parsers/types.js';
import type { EntityDefinition } from '../../shared/types/index.js';
import type { MappingSet, MappingTemplate, ColumnMapping, CustomFieldSuggestion } from '../../shared/mapping/types.js';
import { COLUMN_NAME_ALIASES } from '../detection/column-normaliser.js';

// ---------------------------------------------------------------------------
// String utilities
// ---------------------------------------------------------------------------

/**
 * Levenshtein edit distance between two strings.
 * Used for fuzzy column-name matching (threshold ≤ 2).
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Build (m+1) × (n+1) matrix
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp[m][n];
}

// ---------------------------------------------------------------------------
// Normalisation (used only within auto-mapper)
// Lowercase + strip separators + camelCase-to-lowercase
// ---------------------------------------------------------------------------

function norm(name: string): string {
  return name.toLowerCase().replace(/[\s_\-\.]+/g, '');
}

// ---------------------------------------------------------------------------
// autoMap
// ---------------------------------------------------------------------------

const FUZZY_MAX_DISTANCE = 2;
const CUSTOM_FIELD_MAX_NULL_PERCENT = 50;

/**
 * Automatically maps columns from a ParseResult to an entity's field definitions.
 *
 * Priority order:
 *   1. Exact match (case-normalised)
 *   2. Alias match via COLUMN_NAME_ALIASES
 *   3. Template match (saved mapping for this fileType)
 *   4. Fuzzy match (Levenshtein distance ≤ 2)
 *   5. Unmapped
 */
export function autoMap(
  parseResult: ParseResult,
  fileType: string,
  entity: EntityDefinition,
  templates: MappingTemplate[],
): MappingSet {
  // Build normalised field key map: normKey → fieldKey
  const fieldKeyMap = new Map<string, string>();
  for (const field of entity.fields) {
    fieldKeyMap.set(norm(field.key), field.key);
  }

  // Build required field set
  const requiredFields = new Set(
    entity.fields.filter(f => f.required).map(f => f.key)
  );

  // Build alias map for this entity: normAlias → fieldKey
  // COLUMN_NAME_ALIASES maps normName → canonical detection name; we need to
  // resolve further to actual entity field keys where they match.
  const aliasToFieldKey = new Map<string, string>();
  for (const [aliasNorm, canonicalNorm] of Object.entries(COLUMN_NAME_ALIASES)) {
    // Check if the canonical name resolves to an entity field
    const fieldKey = fieldKeyMap.get(canonicalNorm) ?? fieldKeyMap.get(norm(canonicalNorm));
    if (fieldKey) {
      aliasToFieldKey.set(aliasNorm, fieldKey);
    }
  }

  // Build template lookup: rawColumn → fieldKey (only for matching fileType)
  const templateLookup = new Map<string, string>();
  for (const template of templates) {
    if (template.fileType === fileType) {
      for (const [rawCol, fieldKey] of Object.entries(template.mappings)) {
        templateLookup.set(rawCol, fieldKey);
      }
    }
  }

  const mappings: ColumnMapping[] = [];
  const mappedFieldKeys = new Set<string>();

  for (const col of parseResult.columns) {
    const rawColumn = col.originalHeader;
    const normed = norm(rawColumn);
    let mappedTo: string | null = null;
    let confidence: ColumnMapping['confidence'] = 'auto';

    // 1. Exact match (case-normalised)
    const exactMatch = fieldKeyMap.get(normed);
    if (exactMatch) {
      mappedTo = exactMatch;
    }

    // 2. Alias match
    if (!mappedTo) {
      const aliasMatch = aliasToFieldKey.get(normed);
      if (aliasMatch) {
        mappedTo = aliasMatch;
      }
    }

    // 3. Template match
    if (!mappedTo) {
      const tmplMatch = templateLookup.get(rawColumn);
      if (tmplMatch) {
        mappedTo = tmplMatch;
        confidence = 'template';
      }
    }

    // 4. Fuzzy match
    if (!mappedTo) {
      let bestKey: string | null = null;
      let bestDist = Infinity;

      for (const [fieldNorm, fieldKey] of fieldKeyMap) {
        const dist = levenshteinDistance(normed, fieldNorm);
        if (dist <= FUZZY_MAX_DISTANCE && dist < bestDist) {
          bestDist = dist;
          bestKey = fieldKey;
        }
      }

      if (bestKey) {
        mappedTo = bestKey;
        // Still 'auto' — fuzzy is automatic, just less precise
      }
    }

    const isRequired = mappedTo ? requiredFields.has(mappedTo) : false;
    if (mappedTo) mappedFieldKeys.add(mappedTo);

    mappings.push({ rawColumn, mappedTo, entityKey: entity.entityType, isRequired, confidence });
  }

  // Compute unmapped columns
  const unmappedColumns = mappings
    .filter(m => m.mappedTo === null)
    .map(m => m.rawColumn);

  // Compute missing required fields
  const missingRequiredFields = [...requiredFields].filter(
    key => !mappedFieldKeys.has(key)
  );

  // Compute custom field suggestions (unmapped + below null threshold)
  const columnNullPercent = new Map(
    parseResult.columns.map(c => [c.originalHeader, c.nullPercent])
  );
  const customFieldSuggestions: CustomFieldSuggestion[] = [];
  for (const rawColumn of unmappedColumns) {
    const nullPct = columnNullPercent.get(rawColumn) ?? 0;
    if (nullPct <= CUSTOM_FIELD_MAX_NULL_PERCENT) {
      const colInfo = parseResult.columns.find(c => c.originalHeader === rawColumn);
      customFieldSuggestions.push({
        rawColumn,
        suggestedType: colInfo?.detectedType ?? 'string',
      });
    }
  }

  return {
    fileType,
    entityKey: entity.entityType,
    mappings,
    missingRequiredFields,
    unmappedColumns,
    customFieldSuggestions,
    isComplete: missingRequiredFields.length === 0,
  };
}
