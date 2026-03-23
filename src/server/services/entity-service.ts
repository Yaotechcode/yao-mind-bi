/**
 * entity-service.ts
 *
 * Custom entity type management. All operations take firmId as their first
 * parameter — never trusted from the request body.
 *
 * PATTERNS:
 *   - Supabase (entity_registry, formula_registry, custom_fields, audit_log)
 *   - MongoDB (custom_entity_records for record storage, enriched_* for pipeline data)
 *   - Built-in entities are seeded into entity_registry — treated identically to custom
 *   - Return type is StoredEntity (entityKey: string) not EntityDefinition (EntityType enum)
 */

import { getServerClient } from '../lib/supabase.js';
import { getCollection } from '../lib/mongodb.js';
import { AuditAction, FieldDefinition } from '../../shared/types/index.js';

// =============================================================================
// Types
// =============================================================================

/**
 * A relationship stored in entity_registry.relationships (JSONB).
 * Uses `targetEntityKey: string` rather than `targetEntity: EntityType` to
 * support custom entity targets that are not in the EntityType enum.
 */
export interface StoredRelationship {
  key: string;
  type: string;
  targetEntityKey: string;
  localKey: string;
  foreignKey: string;
  label?: string;
}

/**
 * Points to the source entity and field that drive a derived entity's records.
 * Stored as JSONB in entity_registry.derived_from.
 */
export interface DerivedFromSpec {
  sourceEntityKey: string;
  sourceFieldKey: string;
}

/**
 * An entity definition as stored in / returned from entity_registry.
 * Uses `entityKey: string` because custom entities cannot use the EntityType enum.
 */
export interface StoredEntity {
  id?: string;
  firmId: string;
  entityKey: string;
  isBuiltIn: boolean;
  label: string;
  pluralLabel: string;
  icon?: string;
  description?: string;
  fields: FieldDefinition[];
  relationships: StoredRelationship[];
  dataSource?: string;
  derivedFrom?: DerivedFromSpec;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Input for creating a new custom entity. */
export interface CreateCustomEntityInput {
  entityKey: string;
  label: string;
  pluralLabel: string;
  icon?: string;
  description?: string;
  /** Must contain at least one field with required: true. */
  fields: FieldDefinition[];
  relationships: StoredRelationship[];
  dataSource?: string;
  /** Required when dataSource is 'derived'. */
  derivedFrom?: DerivedFromSpec;
}

/** Fields that can be changed on an existing custom entity. */
export interface UpdateCustomEntityInput {
  label?: string;
  pluralLabel?: string;
  icon?: string;
  description?: string;
  /** Full replacement — pass the complete intended fields array. */
  fields?: FieldDefinition[];
  /** Full replacement — pass the complete intended relationships array. */
  relationships?: StoredRelationship[];
}

// =============================================================================
// Internal helpers
// =============================================================================

const ENTITY_KEY_REGEX = /^[a-z][a-zA-Z0-9_]*$/;

function rowToStoredEntity(row: Record<string, unknown>): StoredEntity {
  return {
    id: row['id'] as string,
    firmId: row['firm_id'] as string,
    entityKey: row['entity_key'] as string,
    isBuiltIn: row['is_built_in'] as boolean,
    label: row['label'] as string,
    pluralLabel: row['plural_label'] as string,
    icon: row['icon'] as string | undefined,
    description: row['description'] as string | undefined,
    fields: (row['fields'] as FieldDefinition[]) ?? [],
    relationships: (row['relationships'] as StoredRelationship[]) ?? [],
    dataSource: row['data_source'] as string | undefined,
    derivedFrom: row['derived_from'] as DerivedFromSpec | undefined,
    createdAt: row['created_at'] ? new Date(row['created_at'] as string) : undefined,
    updatedAt: row['updated_at'] ? new Date(row['updated_at'] as string) : undefined,
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
    entity_type: 'entity_registry',
    entity_id: entityId,
    description,
    created_at: new Date().toISOString(),
  });

  if (error) {
    console.error(`[audit_log] Failed to write entry: ${error.message}`);
  }
}

// =============================================================================
// Registry reads
// =============================================================================

/**
 * Returns all entity definitions (built-in + custom) for the firm.
 * Built-in entities are returned from the seeded entity_registry rows.
 */
export async function getEntityRegistry(firmId: string): Promise<StoredEntity[]> {
  const db = getServerClient();

  const { data, error } = await db
    .from('entity_registry')
    .select('*')
    .eq('firm_id', firmId)
    .order('is_built_in', { ascending: false })
    .order('entity_key', { ascending: true });

  if (error) {
    throw new Error(`getEntityRegistry failed for firm ${firmId}: ${error.message}`);
  }

  return ((data ?? []) as Record<string, unknown>[]).map(rowToStoredEntity);
}

/**
 * Returns a single entity definition, or null if not found.
 */
export async function getEntityDefinition(
  firmId: string,
  entityKey: string,
): Promise<StoredEntity | null> {
  const db = getServerClient();

  const { data, error } = await db
    .from('entity_registry')
    .select('*')
    .eq('firm_id', firmId)
    .eq('entity_key', entityKey)
    .maybeSingle();

  if (error) {
    throw new Error(`getEntityDefinition failed for "${entityKey}": ${error.message}`);
  }

  return data ? rowToStoredEntity(data as Record<string, unknown>) : null;
}

// =============================================================================
// Custom entity CRUD
// =============================================================================

/**
 * Creates a new custom entity type.
 * Validates uniqueness, naming convention, relationship targets, derived-from spec,
 * and required-field presence. Creates the entity_registry row and an initial
 * custom_entity_records document in MongoDB.
 */
export async function createCustomEntity(
  firmId: string,
  entity: CreateCustomEntityInput,
  userId: string,
): Promise<StoredEntity> {
  const db = getServerClient();
  const now = new Date().toISOString();

  // Validate entity_key naming convention
  if (!ENTITY_KEY_REGEX.test(entity.entityKey)) {
    throw new Error(
      'entity_key must be lowercase, start with a letter, and contain only alphanumeric characters and underscores',
    );
  }

  // Validate entity_key uniqueness
  const { data: existing } = await db
    .from('entity_registry')
    .select('entity_key')
    .eq('firm_id', firmId)
    .eq('entity_key', entity.entityKey)
    .maybeSingle();

  if (existing) {
    throw new Error(`entity_key "${entity.entityKey}" already exists in the registry for this firm`);
  }

  // Validate at least one required field
  if (!entity.fields.some((f) => f.required)) {
    throw new Error('Entity must have at least one field with required: true');
  }

  // Validate all relationship targets exist
  for (const rel of entity.relationships) {
    const { data: targetRow } = await db
      .from('entity_registry')
      .select('entity_key')
      .eq('firm_id', firmId)
      .eq('entity_key', rel.targetEntityKey)
      .maybeSingle();

    if (!targetRow) {
      throw new Error(
        `Relationship target entity "${rel.targetEntityKey}" does not exist in the registry`,
      );
    }
  }

  // Validate derived_from spec
  if (entity.dataSource === 'derived') {
    if (!entity.derivedFrom) {
      throw new Error('derived_from is required when data_source is "derived"');
    }

    const { data: sourceRow, error: sourceError } = await db
      .from('entity_registry')
      .select('fields')
      .eq('firm_id', firmId)
      .eq('entity_key', entity.derivedFrom.sourceEntityKey)
      .single();

    if (sourceError || !sourceRow) {
      throw new Error(
        `Source entity "${entity.derivedFrom.sourceEntityKey}" not found in the registry`,
      );
    }

    const sourceFields = (sourceRow as Record<string, unknown>)['fields'] as FieldDefinition[];
    const fieldExists = (sourceFields ?? []).some(
      (f) => f.key === entity.derivedFrom!.sourceFieldKey,
    );

    if (!fieldExists) {
      throw new Error(
        `Source field "${entity.derivedFrom.sourceFieldKey}" does not exist on entity "${entity.derivedFrom.sourceEntityKey}"`,
      );
    }
  }

  // Insert entity_registry row
  const { data: inserted, error: insertError } = await db
    .from('entity_registry')
    .insert({
      firm_id: firmId,
      entity_key: entity.entityKey,
      is_built_in: false,
      label: entity.label,
      plural_label: entity.pluralLabel,
      icon: entity.icon ?? null,
      description: entity.description ?? null,
      fields: entity.fields,
      relationships: entity.relationships,
      data_source: entity.dataSource ?? null,
      derived_from: entity.derivedFrom ?? null,
      created_at: now,
      updated_at: now,
    })
    .select('*')
    .single();

  if (insertError || !inserted) {
    throw new Error(
      `createCustomEntity: insert failed: ${insertError?.message ?? 'no data returned'}`,
    );
  }

  const created = rowToStoredEntity(inserted as Record<string, unknown>);

  // Create initial custom_entity_records document in MongoDB
  const collection = await getCollection<Record<string, unknown>>('custom_entity_records');
  await collection.updateOne(
    { firmId, entityKey: entity.entityKey },
    {
      $setOnInsert: {
        firmId,
        entityKey: entity.entityKey,
        records: [],
        updatedAt: new Date(),
        updatedBy: userId,
      },
    },
    { upsert: true },
  );

  await writeAuditEntry(
    db,
    firmId,
    userId,
    AuditAction.CREATE,
    entity.entityKey,
    `Created custom entity "${entity.entityKey}"`,
  );

  return created;
}

/**
 * Updates a custom entity's mutable fields.
 * entity_key and is_built_in cannot be changed.
 * New relationships are validated to ensure their target entities exist.
 */
export async function updateCustomEntity(
  firmId: string,
  entityKey: string,
  updates: UpdateCustomEntityInput,
  userId: string,
): Promise<StoredEntity> {
  const db = getServerClient();
  const now = new Date().toISOString();

  // Verify the entity exists and is not built-in
  const { data: currentRow, error: readError } = await db
    .from('entity_registry')
    .select('*')
    .eq('firm_id', firmId)
    .eq('entity_key', entityKey)
    .single();

  if (readError || !currentRow) {
    throw new Error(`Entity "${entityKey}" not found for this firm`);
  }

  const current = rowToStoredEntity(currentRow as Record<string, unknown>);

  if (current.isBuiltIn) {
    throw new Error(`Cannot update built-in entity "${entityKey}"`);
  }

  // If relationships are being updated, validate new targets
  if (updates.relationships) {
    const currentKeys = new Set(current.relationships.map((r) => r.targetEntityKey));

    for (const rel of updates.relationships) {
      if (!currentKeys.has(rel.targetEntityKey)) {
        const { data: targetRow } = await db
          .from('entity_registry')
          .select('entity_key')
          .eq('firm_id', firmId)
          .eq('entity_key', rel.targetEntityKey)
          .maybeSingle();

        if (!targetRow) {
          throw new Error(
            `Relationship target entity "${rel.targetEntityKey}" does not exist in the registry`,
          );
        }
      }
    }
  }

  // Build update payload — only columns that are present in updates
  const updatePayload: Record<string, unknown> = { updated_at: now };
  if (updates.label !== undefined) updatePayload['label'] = updates.label;
  if (updates.pluralLabel !== undefined) updatePayload['plural_label'] = updates.pluralLabel;
  if (updates.icon !== undefined) updatePayload['icon'] = updates.icon;
  if (updates.description !== undefined) updatePayload['description'] = updates.description;
  if (updates.fields !== undefined) updatePayload['fields'] = updates.fields;
  if (updates.relationships !== undefined) updatePayload['relationships'] = updates.relationships;

  const { data: updatedRow, error: updateError } = await db
    .from('entity_registry')
    .update(updatePayload)
    .eq('firm_id', firmId)
    .eq('entity_key', entityKey)
    .select('*')
    .single();

  if (updateError || !updatedRow) {
    throw new Error(
      `updateCustomEntity: update failed: ${updateError?.message ?? 'no data returned'}`,
    );
  }

  await writeAuditEntry(
    db,
    firmId,
    userId,
    AuditAction.UPDATE,
    entityKey,
    `Updated custom entity "${entityKey}"`,
  );

  return rowToStoredEntity(updatedRow as Record<string, unknown>);
}

/**
 * Deletes a custom entity if it is not referenced by any formula or other entity.
 * Built-in entities cannot be deleted.
 * Returns warnings if referenced — the entity is NOT deleted in that case.
 * On successful delete: removes entity_registry row, custom_entity_records, and
 * all custom_fields for this entity.
 */
export async function deleteCustomEntity(
  firmId: string,
  entityKey: string,
  userId: string,
): Promise<{ warnings: string[] }> {
  const db = getServerClient();

  // Read entity to verify it exists and check is_built_in
  const { data: entityRow, error: readError } = await db
    .from('entity_registry')
    .select('entity_key, is_built_in')
    .eq('firm_id', firmId)
    .eq('entity_key', entityKey)
    .single();

  if (readError || !entityRow) {
    throw new Error(`Entity "${entityKey}" not found for this firm`);
  }

  if ((entityRow as Record<string, unknown>)['is_built_in']) {
    throw new Error(`Cannot delete built-in entity "${entityKey}"`);
  }

  const warnings: string[] = [];

  // Check formula_registry for direct entity_type references
  const { data: formulas } = await db
    .from('formula_registry')
    .select('formula_id, name')
    .eq('firm_id', firmId)
    .eq('entity_type', entityKey);

  for (const formula of (formulas ?? []) as Record<string, unknown>[]) {
    warnings.push(
      `Cannot delete: entity "${entityKey}" is referenced by formula "${String(formula['name'] ?? formula['formula_id'])}". Remove the reference first.`,
    );
  }

  // Check other entities' relationships JSONB for references to this entityKey
  const { data: allEntities } = await db
    .from('entity_registry')
    .select('entity_key, relationships')
    .eq('firm_id', firmId)
    .neq('entity_key', entityKey);

  for (const row of (allEntities ?? []) as Record<string, unknown>[]) {
    const relsStr = JSON.stringify(row['relationships'] ?? []);
    if (relsStr.includes(`"${entityKey}"`)) {
      warnings.push(
        `Cannot delete: entity "${String(row['entity_key'])}" has a relationship targeting "${entityKey}". Remove the relationship first.`,
      );
    }
  }

  if (warnings.length > 0) {
    return { warnings };
  }

  // Delete entity_registry row
  const { error: deleteError } = await db
    .from('entity_registry')
    .delete()
    .eq('firm_id', firmId)
    .eq('entity_key', entityKey);

  if (deleteError) {
    throw new Error(`deleteCustomEntity: delete failed: ${deleteError.message}`);
  }

  // Delete all custom_fields for this entity
  await db
    .from('custom_fields')
    .delete()
    .eq('firm_id', firmId)
    .eq('entity_key', entityKey);

  // Delete custom_entity_records from MongoDB
  const collection = await getCollection<Record<string, unknown>>('custom_entity_records');
  await collection.deleteOne({ firmId, entityKey });

  await writeAuditEntry(
    db,
    firmId,
    userId,
    AuditAction.DELETE,
    entityKey,
    `Deleted custom entity "${entityKey}"`,
  );

  return { warnings: [] };
}

// =============================================================================
// Record management (MongoDB)
// =============================================================================

/**
 * Returns all records for a custom entity from MongoDB.
 */
export async function getCustomEntityRecords(
  firmId: string,
  entityKey: string,
): Promise<Record<string, unknown>[]> {
  const collection = await getCollection<Record<string, unknown>>('custom_entity_records');
  const doc = await collection.findOne({ firmId, entityKey });
  return (doc?.['records'] as Record<string, unknown>[]) ?? [];
}

/**
 * Replaces all records for a custom entity.
 * Each record is stored as-is — validation against field definitions is the
 * caller's responsibility (see addCustomEntityRecord for per-record validation).
 */
export async function setCustomEntityRecords(
  firmId: string,
  entityKey: string,
  records: Record<string, unknown>[],
  userId: string,
): Promise<void> {
  const collection = await getCollection<Record<string, unknown>>('custom_entity_records');
  await collection.updateOne(
    { firmId, entityKey },
    { $set: { records, updatedAt: new Date(), updatedBy: userId } },
    { upsert: true },
  );
}

/**
 * Appends a single record to the entity's record list.
 */
export async function addCustomEntityRecord(
  firmId: string,
  entityKey: string,
  record: Record<string, unknown>,
  userId: string,
): Promise<void> {
  const collection = await getCollection<Record<string, unknown>>('custom_entity_records');
  await collection.updateOne(
    { firmId, entityKey },
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      $push: { records: record } as any,
      $set: { updatedAt: new Date(), updatedBy: userId },
    },
    { upsert: true },
  );
}

/**
 * Replaces a record at a specific index using array update operators.
 */
export async function updateCustomEntityRecord(
  firmId: string,
  entityKey: string,
  recordIndex: number,
  updates: Record<string, unknown>,
  userId: string,
): Promise<void> {
  const collection = await getCollection<Record<string, unknown>>('custom_entity_records');
  const doc = await collection.findOne({ firmId, entityKey });

  if (!doc) {
    throw new Error(`No records document found for entity "${entityKey}"`);
  }

  const records = (doc['records'] as Record<string, unknown>[]) ?? [];

  if (recordIndex < 0 || recordIndex >= records.length) {
    throw new Error(
      `Record index ${recordIndex} is out of bounds (document has ${records.length} records)`,
    );
  }

  records[recordIndex] = { ...records[recordIndex], ...updates };

  await collection.updateOne(
    { firmId, entityKey },
    { $set: { records, updatedAt: new Date(), updatedBy: userId } },
  );
}

/**
 * Removes a record at a specific index.
 */
export async function deleteCustomEntityRecord(
  firmId: string,
  entityKey: string,
  recordIndex: number,
  userId: string,
): Promise<void> {
  const collection = await getCollection<Record<string, unknown>>('custom_entity_records');
  const doc = await collection.findOne({ firmId, entityKey });

  if (!doc) {
    throw new Error(`No records document found for entity "${entityKey}"`);
  }

  const records = (doc['records'] as Record<string, unknown>[]) ?? [];

  if (recordIndex < 0 || recordIndex >= records.length) {
    throw new Error(
      `Record index ${recordIndex} is out of bounds (document has ${records.length} records)`,
    );
  }

  records.splice(recordIndex, 1);

  await collection.updateOne(
    { firmId, entityKey },
    { $set: { records, updatedAt: new Date(), updatedBy: userId } },
  );
}

// =============================================================================
// Derived entity refresh
// =============================================================================

/**
 * Re-scans the source entity's enriched pipeline data for unique values of the
 * source field, then merges with existing records:
 *   - New unique values → appended as new records
 *   - Existing records whose source value still exists → kept unchanged
 *   - Existing records whose source value is gone → kept with `_flagged: true`
 *
 * Returns the updated record list.
 *
 * NOTE: Returns `[]` (or existing records unchanged) when pipeline data does not
 * exist yet (Phase 1B+). This is an expected, non-error condition at this stage
 * of development. The return value always reflects the current persisted state.
 */
export async function refreshDerivedEntity(
  firmId: string,
  entityKey: string,
  userId: string,
): Promise<Record<string, unknown>[]> {
  const db = getServerClient();

  // Read derived_from spec from entity_registry
  const { data: entityRow, error } = await db
    .from('entity_registry')
    .select('derived_from, data_source')
    .eq('firm_id', firmId)
    .eq('entity_key', entityKey)
    .single();

  if (error || !entityRow) {
    throw new Error(`Entity "${entityKey}" not found for this firm`);
  }

  const row = entityRow as Record<string, unknown>;

  if (row['data_source'] !== 'derived' || !row['derived_from']) {
    throw new Error(`Entity "${entityKey}" is not a derived entity`);
  }

  const derivedFrom = row['derived_from'] as DerivedFromSpec;

  // Read existing records from MongoDB
  const collection = await getCollection<Record<string, unknown>>('custom_entity_records');
  const existingDoc = await collection.findOne({ firmId, entityKey });
  const existingRecords = (existingDoc?.['records'] as Record<string, unknown>[]) ?? [];

  // Query enriched pipeline data (populated by pipeline Phase 1B+).
  // Collection naming convention: enriched_{sourceEntityKey}.
  // Returns [] gracefully when the pipeline has not run yet — expected at this stage.
  const enrichedCollection = await getCollection<Record<string, unknown>>(
    `enriched_${derivedFrom.sourceEntityKey}`,
  );
  const enrichedDocs = await enrichedCollection.find({ firmId }).toArray();

  if (enrichedDocs.length === 0) {
    // Pipeline data not yet available — return existing records unchanged.
    return existingRecords;
  }

  // Extract unique non-null values of the source field
  const uniqueValues = new Set<string>();
  for (const doc of enrichedDocs) {
    const val = doc[derivedFrom.sourceFieldKey];
    if (val != null && String(val).trim() !== '') {
      uniqueValues.add(String(val));
    }
  }

  // Merge: flag records whose source value is gone, append newly discovered values
  const existingValueSet = new Set(
    existingRecords.map((r) => String(r[derivedFrom.sourceFieldKey] ?? '')),
  );

  const merged: Record<string, unknown>[] = [
    ...existingRecords.map((r) => {
      const val = String(r[derivedFrom.sourceFieldKey] ?? '');
      return uniqueValues.has(val)
        ? r
        : { ...r, _flagged: true, _flagReason: 'source value no longer exists' };
    }),
    ...[...uniqueValues]
      .filter((v) => !existingValueSet.has(v))
      .map((v) => ({ [derivedFrom.sourceFieldKey]: v })),
  ];

  // Persist merged records
  await collection.updateOne(
    { firmId, entityKey },
    { $set: { records: merged, updatedAt: new Date(), updatedBy: userId } },
    { upsert: true },
  );

  return merged;
}
