/**
 * custom-fields-service.ts
 *
 * All custom field CRUD operations.
 * Every function takes firmId as its first parameter — never trusted from the
 * request body.
 *
 * PATTERNS:
 *   - Supabase (custom_fields, entity_registry, formula_registry, audit_log)
 *   - MongoDB (custom_field_values collection for manual-sourced values)
 *   - Entity registry is kept in sync on every write operation
 *   - Deletion is blocked when the field is referenced by any formula
 */

import { getServerClient } from '../lib/supabase.js';
import { getCollection } from '../lib/mongodb.js';
import { AuditAction, FieldDefinition, FieldType, MissingBehaviour } from '../../shared/types/index.js';
import {
  CreateCustomFieldInput,
  CreateCustomFieldInputSchema,
  DataType,
  UpdateCustomFieldInput,
  UpdateCustomFieldInputSchema,
  validateCustomFieldValue,
} from '../../shared/validation/custom-field-validators.js';

// =============================================================================
// Types
// =============================================================================

/** A custom field row as returned by the service (camelCased from DB columns). */
export interface CustomField {
  id: string;
  firmId: string;
  entityKey: string;
  fieldKey: string;
  label: string;
  dataType: DataType;
  selectOptions?: string[];
  defaultValue?: string;
  description?: string;
  source: 'csv_mapping' | 'manual' | 'derived';
  displayConfig: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// Internal helpers
// =============================================================================

function rowToCustomField(row: Record<string, unknown>): CustomField {
  return {
    id: row['id'] as string,
    firmId: row['firm_id'] as string,
    entityKey: row['entity_key'] as string,
    fieldKey: row['field_key'] as string,
    label: row['label'] as string,
    dataType: row['data_type'] as DataType,
    selectOptions: row['select_options'] as string[] | undefined,
    defaultValue: row['default_value'] as string | undefined,
    description: row['description'] as string | undefined,
    source: (row['source'] as 'csv_mapping' | 'manual' | 'derived') ?? 'manual',
    displayConfig: (row['display_config'] as Record<string, unknown>) ?? {},
    createdAt: new Date(row['created_at'] as string),
    updatedAt: new Date(row['updated_at'] as string),
  };
}

const DATA_TYPE_TO_FIELD_TYPE: Record<DataType, FieldType> = {
  text: FieldType.STRING,
  number: FieldType.NUMBER,
  currency: FieldType.CURRENCY,
  percentage: FieldType.PERCENTAGE,
  date: FieldType.DATE,
  boolean: FieldType.BOOLEAN,
  select: FieldType.SELECT,
  reference: FieldType.REFERENCE,
};

function toFieldDefinition(field: CustomField): FieldDefinition {
  return {
    key: field.fieldKey,
    label: field.label,
    type: DATA_TYPE_TO_FIELD_TYPE[field.dataType],
    required: false,
    builtIn: false,
    missingBehaviour: MissingBehaviour.USE_DEFAULT,
    ...(field.selectOptions ? { options: field.selectOptions } : {}),
    ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
    ...(field.description ? { description: field.description } : {}),
  };
}

async function writeAuditEntry(
  db: ReturnType<typeof getServerClient>,
  firmId: string,
  userId: string,
  action: AuditAction,
  entityId: string,
  description: string,
): Promise<void> {
  const { error } = await db.from('audit_log').insert({
    firm_id: firmId,
    user_id: userId,
    action,
    entity_type: 'custom_field',
    entity_id: entityId,
    description,
    created_at: new Date().toISOString(),
  });

  if (error) {
    console.error(`[audit_log] Failed to write entry: ${error.message}`);
  }
}

// =============================================================================
// Operations
// =============================================================================

/**
 * Returns all custom fields for the firm, optionally filtered by entity.
 * Ordered by entity_key then created_at.
 */
export async function getCustomFields(
  firmId: string,
  entityKey?: string,
): Promise<CustomField[]> {
  const db = getServerClient();

  let query = db
    .from('custom_fields')
    .select('*')
    .eq('firm_id', firmId)
    .order('entity_key', { ascending: true })
    .order('created_at', { ascending: true });

  if (entityKey) {
    query = (query as typeof query).eq('entity_key', entityKey);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`getCustomFields failed for firm ${firmId}: ${error.message}`);
  }

  return ((data ?? []) as Record<string, unknown>[]).map(rowToCustomField);
}

/**
 * Creates a new custom field.
 * Validates input, inserts into custom_fields, syncs entity_registry, logs audit.
 */
export async function createCustomField(
  firmId: string,
  input: CreateCustomFieldInput,
  userId: string,
): Promise<CustomField> {
  const parsed = CreateCustomFieldInputSchema.safeParse(input);
  if (!parsed.success) {
    const messages = parsed.error.issues.map((i) => i.message).join('; ');
    throw new Error(`Invalid custom field: ${messages}`);
  }
  const field = parsed.data;

  const db = getServerClient();
  const now = new Date().toISOString();

  // Validate entity_key exists in entity_registry for this firm
  const { data: entityRow, error: entityLookupError } = await db
    .from('entity_registry')
    .select('entity_key, fields')
    .eq('firm_id', firmId)
    .eq('entity_key', field.entity_key)
    .single();

  if (entityLookupError || !entityRow) {
    throw new Error(
      `entity_key "${field.entity_key}" does not exist in entity_registry for this firm`,
    );
  }

  // Validate field_key uniqueness for this entity+firm
  const { data: existing } = await db
    .from('custom_fields')
    .select('id')
    .eq('firm_id', firmId)
    .eq('entity_key', field.entity_key)
    .eq('field_key', field.field_key)
    .maybeSingle();

  if (existing) {
    throw new Error(
      `field_key "${field.field_key}" already exists for entity "${field.entity_key}" in this firm`,
    );
  }

  // Insert and return the created row
  const { data: inserted, error: insertError } = await db
    .from('custom_fields')
    .insert({
      firm_id: firmId,
      entity_key: field.entity_key,
      field_key: field.field_key,
      label: field.label,
      data_type: field.data_type,
      select_options: field.select_options ?? null,
      default_value: field.default_value ?? null,
      description: field.description ?? null,
      source: field.source,
      display_config: field.display_config,
      created_at: now,
      updated_at: now,
    })
    .select('*')
    .single();

  if (insertError || !inserted) {
    throw new Error(
      `createCustomField: insert failed: ${insertError?.message ?? 'no data returned'}`,
    );
  }

  const created = rowToCustomField(inserted as Record<string, unknown>);

  // Sync entity_registry: append FieldDefinition to the entity's fields array
  const currentFields =
    ((entityRow as Record<string, unknown>)['fields'] as FieldDefinition[]) ?? [];

  const { error: registryError } = await db
    .from('entity_registry')
    .update({ fields: [...currentFields, toFieldDefinition(created)], updated_at: now })
    .eq('firm_id', firmId)
    .eq('entity_key', field.entity_key);

  if (registryError) {
    throw new Error(
      `createCustomField: entity_registry update failed: ${registryError.message}`,
    );
  }

  await writeAuditEntry(
    db,
    firmId,
    userId,
    AuditAction.CREATE,
    created.id,
    `Created custom field "${field.field_key}" on ${field.entity_key}`,
  );

  return created;
}

/**
 * Updates a custom field.
 * firm_id, entity_key, and field_key are structural and cannot be changed.
 */
export async function updateCustomField(
  firmId: string,
  fieldId: string,
  updates: UpdateCustomFieldInput,
  userId: string,
): Promise<CustomField> {
  const parsed = UpdateCustomFieldInputSchema.safeParse(updates);
  if (!parsed.success) {
    const messages = parsed.error.issues.map((i) => i.message).join('; ');
    throw new Error(`Invalid update: ${messages}`);
  }

  const db = getServerClient();
  const now = new Date().toISOString();

  // Read current field
  const { data: currentRow, error: readError } = await db
    .from('custom_fields')
    .select('*')
    .eq('firm_id', firmId)
    .eq('id', fieldId)
    .single();

  if (readError || !currentRow) {
    throw new Error(`Custom field "${fieldId}" not found for this firm`);
  }

  const current = rowToCustomField(currentRow as Record<string, unknown>);

  // If data_type changes to/stays select, select_options must be non-empty
  const effectiveDataType = parsed.data.data_type ?? current.dataType;
  if (effectiveDataType === 'select') {
    const effectiveOptions = parsed.data.select_options ?? current.selectOptions;
    if (!effectiveOptions || effectiveOptions.length === 0) {
      throw new Error(
        'select_options must be provided and non-empty when data_type is "select"',
      );
    }
  }

  // Build update payload — only set columns that are present in the request
  const updatePayload: Record<string, unknown> = { updated_at: now };
  if (parsed.data.label !== undefined) updatePayload['label'] = parsed.data.label;
  if (parsed.data.description !== undefined) updatePayload['description'] = parsed.data.description;
  if (parsed.data.data_type !== undefined) updatePayload['data_type'] = parsed.data.data_type;
  if (parsed.data.select_options !== undefined) updatePayload['select_options'] = parsed.data.select_options;
  if (parsed.data.default_value !== undefined) updatePayload['default_value'] = parsed.data.default_value;
  if (parsed.data.display_config !== undefined) updatePayload['display_config'] = parsed.data.display_config;
  if (parsed.data.source !== undefined) updatePayload['source'] = parsed.data.source;

  const { data: updatedRow, error: updateError } = await db
    .from('custom_fields')
    .update(updatePayload)
    .eq('firm_id', firmId)
    .eq('id', fieldId)
    .select('*')
    .single();

  if (updateError || !updatedRow) {
    throw new Error(
      `updateCustomField: update failed: ${updateError?.message ?? 'no data returned'}`,
    );
  }

  const updated = rowToCustomField(updatedRow as Record<string, unknown>);

  // Sync entity_registry: replace the matching FieldDefinition by key
  const { data: entityRow } = await db
    .from('entity_registry')
    .select('fields')
    .eq('firm_id', firmId)
    .eq('entity_key', updated.entityKey)
    .single();

  if (entityRow) {
    const currentFields =
      ((entityRow as Record<string, unknown>)['fields'] as FieldDefinition[]) ?? [];
    const syncedFields = currentFields.map((f) =>
      f.key === updated.fieldKey ? toFieldDefinition(updated) : f,
    );
    await db
      .from('entity_registry')
      .update({ fields: syncedFields, updated_at: now })
      .eq('firm_id', firmId)
      .eq('entity_key', updated.entityKey);
  }

  await writeAuditEntry(
    db,
    firmId,
    userId,
    AuditAction.UPDATE,
    fieldId,
    `Updated custom field "${updated.fieldKey}" on ${updated.entityKey}`,
  );

  return updated;
}

/**
 * Deletes a custom field if it is not referenced by any formula.
 * Returns warnings if the field is referenced — the field is NOT deleted in that case.
 */
export async function deleteCustomField(
  firmId: string,
  fieldId: string,
  userId: string,
): Promise<{ warnings: string[] }> {
  const db = getServerClient();
  const now = new Date().toISOString();

  // Read field to get entity_key and field_key
  const { data: fieldRow, error: readError } = await db
    .from('custom_fields')
    .select('*')
    .eq('firm_id', firmId)
    .eq('id', fieldId)
    .single();

  if (readError || !fieldRow) {
    throw new Error(`Custom field "${fieldId}" not found for this firm`);
  }

  const field = rowToCustomField(fieldRow as Record<string, unknown>);

  // Check all formula_registry rows for references to this field_key
  const { data: formulas } = await db
    .from('formula_registry')
    .select('formula_id, name, modifiers, depends_on')
    .eq('firm_id', firmId);

  const referencingFormulas: string[] = [];
  for (const formula of (formulas ?? []) as Record<string, unknown>[]) {
    const modifiersStr = JSON.stringify(formula['modifiers'] ?? []);
    const dependsOnStr = JSON.stringify(formula['depends_on'] ?? []);
    if (modifiersStr.includes(field.fieldKey) || dependsOnStr.includes(field.fieldKey)) {
      referencingFormulas.push(
        String(formula['name'] ?? formula['formula_id']),
      );
    }
  }

  if (referencingFormulas.length > 0) {
    return {
      warnings: referencingFormulas.map(
        (name) =>
          `Cannot delete: field "${field.fieldKey}" is referenced by formula "${name}". Remove the reference first.`,
      ),
    };
  }

  // Delete from custom_fields
  const { error: deleteError } = await db
    .from('custom_fields')
    .delete()
    .eq('firm_id', firmId)
    .eq('id', fieldId);

  if (deleteError) {
    throw new Error(`deleteCustomField: delete failed: ${deleteError.message}`);
  }

  // Remove from entity_registry.fields
  const { data: entityRow } = await db
    .from('entity_registry')
    .select('fields')
    .eq('firm_id', firmId)
    .eq('entity_key', field.entityKey)
    .single();

  if (entityRow) {
    const currentFields =
      ((entityRow as Record<string, unknown>)['fields'] as FieldDefinition[]) ?? [];
    const filteredFields = currentFields.filter((f) => f.key !== field.fieldKey);
    await db
      .from('entity_registry')
      .update({ fields: filteredFields, updated_at: now })
      .eq('firm_id', firmId)
      .eq('entity_key', field.entityKey);
  }

  await writeAuditEntry(
    db,
    firmId,
    userId,
    AuditAction.DELETE,
    fieldId,
    `Deleted custom field "${field.fieldKey}" from ${field.entityKey}`,
  );

  return { warnings: [] };
}

/**
 * Returns the values of a custom field keyed by entity record ID.
 *
 * - manual:      values from MongoDB custom_field_values collection
 * - csv_mapping: values live in enriched pipeline entity documents (Phase 1B+); returns {}
 * - derived:     calculated by the formula engine (Phase 1C); returns {}
 */
export async function getCustomFieldValues(
  firmId: string,
  entityKey: string,
  fieldKey: string,
): Promise<Record<string, unknown>> {
  const db = getServerClient();

  const { data: fieldRow } = await db
    .from('custom_fields')
    .select('source')
    .eq('firm_id', firmId)
    .eq('entity_key', entityKey)
    .eq('field_key', fieldKey)
    .maybeSingle();

  if (!fieldRow) {
    throw new Error(`Custom field "${fieldKey}" not found for entity "${entityKey}"`);
  }

  const source = (fieldRow as Record<string, unknown>)['source'] as string;

  // csv_mapping and derived values are not available until pipeline Phase 1B/1C
  if (source === 'csv_mapping' || source === 'derived') {
    return {};
  }

  // manual: query MongoDB
  const collection = await getCollection<Record<string, unknown>>('custom_field_values');
  const docs = await collection.find({ firmId, entityKey, fieldKey }).toArray();

  return Object.fromEntries(
    docs.map((doc) => [doc['recordId'] as string, doc['value']]),
  );
}

/**
 * Sets a manual value for a custom field on a specific entity record.
 * Validates the value against the field's data_type before storing.
 */
export async function setCustomFieldValue(
  firmId: string,
  entityKey: string,
  recordId: string,
  fieldKey: string,
  value: unknown,
  userId: string,
): Promise<void> {
  const db = getServerClient();

  const { data: fieldRow } = await db
    .from('custom_fields')
    .select('data_type')
    .eq('firm_id', firmId)
    .eq('entity_key', entityKey)
    .eq('field_key', fieldKey)
    .maybeSingle();

  if (!fieldRow) {
    throw new Error(`Custom field "${fieldKey}" not found for entity "${entityKey}"`);
  }

  const dataType = (fieldRow as Record<string, unknown>)['data_type'] as DataType;

  const validation = validateCustomFieldValue(dataType, value);
  if (!validation.valid) {
    throw new Error(
      `Invalid value for field "${fieldKey}" (${dataType}): ${validation.error}`,
    );
  }

  const collection = await getCollection<Record<string, unknown>>('custom_field_values');
  await collection.updateOne(
    { firmId, entityKey, recordId, fieldKey },
    {
      $set: {
        firmId,
        entityKey,
        recordId,
        fieldKey,
        value,
        updatedAt: new Date(),
        updatedBy: userId,
      },
    },
    { upsert: true },
  );
}
