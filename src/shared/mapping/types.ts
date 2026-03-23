import type { EntityType } from '../types/index.js';
import type { ColumnInfo } from '../../client/parsers/types.js';

// ---------------------------------------------------------------------------
// Column-level mapping
// ---------------------------------------------------------------------------

export interface ColumnMapping {
  /** The original column header from the uploaded file */
  rawColumn: string;
  /** The entity field key this column maps to, or null if unmapped */
  mappedTo: string | null;
  /** Which entity this mapping belongs to */
  entityKey: EntityType;
  /** Whether the mapped field is required by the entity definition */
  isRequired: boolean;
  /** How the mapping was established */
  confidence: 'auto' | 'template' | 'manual';
  /** User-overridden type for this column (overrides detected type) */
  typeOverride?: ColumnInfo['detectedType'];
}

// ---------------------------------------------------------------------------
// Mapping set — the full mapping for one file upload
// ---------------------------------------------------------------------------

export interface CustomFieldSuggestion {
  rawColumn: string;
  suggestedType: ColumnInfo['detectedType'];
}

export interface MappingSet {
  fileType: string;
  entityKey: EntityType;
  /** All columns from the parse result, each with their mapping status */
  mappings: ColumnMapping[];
  /** Required entity fields that have no mapping */
  missingRequiredFields: string[];
  /** Raw columns that were not mapped to any entity field */
  unmappedColumns: string[];
  /** Non-null unmapped columns that are good candidates for custom fields */
  customFieldSuggestions: CustomFieldSuggestion[];
  /** True when all required fields have a mapping */
  isComplete: boolean;
}

// ---------------------------------------------------------------------------
// Mapping template — saved mapping for reuse across uploads
// ---------------------------------------------------------------------------

export interface MappingTemplate {
  id: string;
  firmId: string;
  name: string;
  fileType: string;
  /** Map of rawColumn → entityFieldKey */
  mappings: Record<string, string>;
  /** Map of rawColumn → overridden type */
  typeOverrides: Record<string, ColumnInfo['detectedType']>;
  createdAt: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface MappingValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
