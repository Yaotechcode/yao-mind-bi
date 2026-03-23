/**
 * custom-field-validators.ts
 *
 * Zod schemas for custom field creation and updates.
 * Value validators for each supported data type.
 */

import { z } from 'zod';

// =============================================================================
// Constants
// =============================================================================

/** Allowed data types — must match the DB CHECK constraint on custom_fields.data_type. */
export const DATA_TYPES = [
  'text',
  'number',
  'currency',
  'percentage',
  'date',
  'boolean',
  'select',
  'reference',
] as const;

export type DataType = (typeof DATA_TYPES)[number];

/** Allowed source values — must match DB CHECK constraint on custom_fields.source. */
export const FIELD_SOURCES = ['csv_mapping', 'manual', 'derived'] as const;

export type FieldSource = (typeof FIELD_SOURCES)[number];

// field_key must begin with 'cf_', followed by one or more lowercase alphanumeric/underscore chars
const FIELD_KEY_REGEX = /^cf_[a-z0-9_]+$/;

// =============================================================================
// CreateCustomFieldInput
// =============================================================================

export const CreateCustomFieldInputSchema = z
  .object({
    entity_key: z.string().min(1, 'entity_key is required'),
    field_key: z.string().regex(
      FIELD_KEY_REGEX,
      'field_key must start with "cf_" and contain only lowercase letters, digits, and underscores',
    ),
    label: z
      .string()
      .min(1, 'label is required')
      .max(100, 'label must be 100 characters or fewer'),
    data_type: z.enum(DATA_TYPES, {
      errorMap: () => ({ message: `data_type must be one of: ${DATA_TYPES.join(', ')}` }),
    }),
    select_options: z.array(z.string().min(1, 'option must be non-empty')).optional(),
    default_value: z.string().optional(),
    description: z.string().optional(),
    source: z.enum(FIELD_SOURCES).default('manual'),
    display_config: z.record(z.unknown()).default({}),
  })
  .refine(
    (d) =>
      d.data_type !== 'select' ||
      (d.select_options !== undefined && d.select_options.length > 0),
    {
      message: 'select_options must be provided and non-empty when data_type is "select"',
      path: ['select_options'],
    },
  )
  .refine(
    (d) =>
      d.source !== 'derived' ||
      Boolean((d.display_config as Record<string, unknown>)['derivationFormula']),
    {
      message: 'display_config.derivationFormula is required when source is "derived"',
      path: ['display_config'],
    },
  );

export type CreateCustomFieldInput = z.infer<typeof CreateCustomFieldInputSchema>;

// =============================================================================
// UpdateCustomFieldInput
// =============================================================================

/** firm_id, entity_key, and field_key are structural — they cannot be changed. */
export const UpdateCustomFieldInputSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  data_type: z.enum(DATA_TYPES).optional(),
  select_options: z.array(z.string().min(1)).optional(),
  default_value: z.string().optional(),
  display_config: z.record(z.unknown()).optional(),
  source: z.enum(FIELD_SOURCES).optional(),
});

export type UpdateCustomFieldInput = z.infer<typeof UpdateCustomFieldInputSchema>;

// =============================================================================
// Value validators per data type
// =============================================================================

export function validateCustomFieldValue(
  dataType: DataType,
  value: unknown,
): { valid: boolean; error?: string } {
  switch (dataType) {
    case 'text':
      return typeof value === 'string'
        ? { valid: true }
        : { valid: false, error: 'Value must be a string' };

    case 'number':
    case 'currency':
    case 'percentage':
      return typeof value === 'number' && !isNaN(value)
        ? { valid: true }
        : { valid: false, error: 'Value must be a number' };

    case 'date':
      return typeof value === 'string' && !isNaN(Date.parse(value))
        ? { valid: true }
        : { valid: false, error: 'Value must be a valid ISO date string' };

    case 'boolean':
      return typeof value === 'boolean'
        ? { valid: true }
        : { valid: false, error: 'Value must be a boolean' };

    case 'select':
      return typeof value === 'string'
        ? { valid: true }
        : { valid: false, error: 'Value must be a string (one of the select options)' };

    case 'reference':
      return typeof value === 'string' && value.length > 0
        ? { valid: true }
        : { valid: false, error: 'Value must be a non-empty string ID' };

    default:
      return { valid: false, error: `Unknown data type: ${String(dataType)}` };
  }
}
