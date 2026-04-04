/**
 * config-service.ts
 *
 * All firm configuration CRUD operations. Every function takes firmId as its
 * first parameter. firmId must be derived from the authenticated user — never
 * trusted from the request body.
 *
 * PATTERNS:
 *   - All writes first read the current value for the audit log (old value)
 *   - All writes record to audit_log before or alongside the main update
 *   - Config updates go through this service — never raw JSONB writes
 *   - Deep merge handles schema evolution: new fields fall back to defaults
 */

import { db } from '../lib/supabase.js';
import { getBuiltInEntityDefinitions } from '../../shared/entities/registry.js';
import { getDefaultFirmConfig } from '../../shared/entities/defaults.js';
import {
  FirmConfig,
  RagThresholdSet,
  AuditLogEntry,
  AuditAction,
  FeeEarnerOverride,
} from '../../shared/types/index.js';
import {
  FirmConfigSchema,
  ExportedConfigSchema,
  RagThresholdSetSchema,
  collectImportWarnings,
  validateRagThresholdConsistency,
} from '../../shared/validation/config-validators.js';

const YAOMIND_VERSION = '1.0.0';

// =============================================================================
// Internal helpers
// =============================================================================

/** Sets a value at a dot-notation path in a (possibly nested) object/array. */
function setNestedValue(obj: unknown, path: string, value: unknown): unknown {
  if (!path) return value;

  const dotIdx = path.indexOf('.');
  const key = dotIdx === -1 ? path : path.slice(0, dotIdx);
  const rest = dotIdx === -1 ? '' : path.slice(dotIdx + 1);

  if (Array.isArray(obj)) {
    const index = parseInt(key, 10);
    if (!isNaN(index)) {
      // Numeric index — existing behaviour
      const arr = [...obj];
      arr[index] = rest ? setNestedValue(arr[index], rest, value) : value;
      return arr;
    }
    // Non-numeric segment: treat as metricKey lookup
    const arr = obj as Array<Record<string, unknown>>;
    const idx = arr.findIndex((el) => el['metricKey'] === key);
    if (idx === -1) {
      // Append new element with metricKey set to key
      const newEl: Record<string, unknown> = { metricKey: key };
      const inserted = rest ? setNestedValue(newEl, rest, value) : value;
      return [...arr, inserted];
    }
    const updated = [...arr];
    updated[idx] = rest
      ? (setNestedValue(updated[idx], rest, value) as Record<string, unknown>)
      : (value as Record<string, unknown>);
    return updated;
  }

  const record = (obj ?? {}) as Record<string, unknown>;
  return {
    ...record,
    [key]: rest ? setNestedValue(record[key], rest, value) : value,
  };
}

/** Gets a value at a dot-notation path. Returns undefined if path does not exist. */
function getNestedValue(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split('.').reduce((curr: unknown, key) => {
    if (curr == null || typeof curr !== 'object') return undefined;
    if (Array.isArray(curr)) {
      const index = parseInt(key, 10);
      if (!isNaN(index)) return curr[index];
      // Non-numeric segment: metricKey lookup
      return (curr as Array<Record<string, unknown>>).find(
        (el) => el['metricKey'] === key,
      );
    }
    return (curr as Record<string, unknown>)[key];
  }, obj);
}

/** Returns true only for plain (non-Date, non-Array) objects. */
function isPlainObject(val: unknown): val is Record<string, unknown> {
  return (
    val !== null &&
    typeof val === 'object' &&
    !Array.isArray(val) &&
    !(val instanceof Date)
  );
}

/**
 * Deep-merges `stored` on top of `defaults`.
 * Stored values override defaults; missing stored values fall back to defaults.
 * Arrays, Dates, and primitives are replaced wholesale; plain objects are merged recursively.
 */
function mergeWithDefaults<T extends Record<string, unknown>>(
  defaults: T,
  stored: Partial<T>,
): T {
  const result: Record<string, unknown> = { ...defaults };

  for (const key of Object.keys(stored) as Array<keyof T>) {
    const storedVal = stored[key];
    const defaultVal = defaults[key];

    if (isPlainObject(storedVal) && isPlainObject(defaultVal)) {
      result[key as string] = mergeWithDefaults(
        defaultVal as Record<string, unknown>,
        storedVal as Record<string, unknown>,
      );
    } else if (storedVal !== undefined) {
      result[key as string] = storedVal;
    }
  }

  return result as T;
}

/** Reads the current config from DB, throwing if the firm doesn't exist. */
async function readRawConfig(firmId: string): Promise<FirmConfig> {
  const { data, error } = await db.server
    .from('firm_config')
    .select('*')
    .eq('firm_id', firmId)
    .single();

  if (error) {
    throw new Error(`Failed to read config for firm ${firmId}: ${error.message}`);
  }
  if (!data) {
    throw new Error(`No config found for firm ${firmId}. Run seedFirm first.`);
  }

  // Config is stored as a single JSONB column named 'config'.
  const row = data as Record<string, unknown>;
  return ((row['config'] as FirmConfig) ?? {}) as FirmConfig;
}

/** Persists an updated config to DB. */
async function writeConfig(firmId: string, config: FirmConfig): Promise<void> {
  const { error } = await db.server
    .from('firm_config')
    .update({ config, updated_at: new Date().toISOString() })
    .eq('firm_id', firmId);

  if (error) {
    throw new Error(`Failed to write config for firm ${firmId}: ${error.message}`);
  }
}

// =============================================================================
// Audit log (internal)
// =============================================================================

async function writeAuditEntry(
  firmId: string,
  userId: string,
  action: AuditAction,
  entityType: string,
  entityId: string,
  diff?: Record<string, { before: unknown; after: unknown }>,
  metadata?: Record<string, unknown>,
): Promise<void> {
  // Extract old_value / new_value from the first diff entry (if any)
  const firstDiffEntry = diff ? Object.values(diff)[0] : undefined;
  const oldValue = firstDiffEntry?.before ?? null;
  const newValue = firstDiffEntry?.after ?? null;

  // Extract path and description from metadata
  const path = typeof metadata?.['path'] === 'string' ? metadata['path'] : null;
  const description =
    typeof metadata?.['action'] === 'string'
      ? metadata['action']
      : metadata
        ? JSON.stringify(metadata)
        : null;

  const { error } = await db.server.from('audit_log').insert({
    firm_id: firmId,
    user_id: userId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    path,
    old_value: oldValue,
    new_value: newValue,
    description,
    diff,
  });

  // Audit log errors are non-fatal: log but don't block the caller.
  if (error) {
    console.error(`[audit_log] Failed to write entry: ${error.message}`);
  }
}

// =============================================================================
// Firm Config Operations
// =============================================================================

/**
 * Returns the firm's complete config, deep-merged with defaults for any fields
 * that were added after the firm was originally created.
 */
export async function getFirmConfig(firmId: string): Promise<FirmConfig> {
  const stored = await readRawConfig(firmId);
  const defaults = getDefaultFirmConfig(firmId, stored.firmName ?? '');
  return mergeWithDefaults(
    defaults as unknown as Record<string, unknown>,
    stored as unknown as Record<string, unknown>,
  ) as unknown as FirmConfig;
}

/**
 * Updates a single value at `path` (dot-notation) within the firm config.
 * Validates the resulting config, writes it, and logs the change.
 *
 * @example updateFirmConfig(firmId, 'workingDaysPerWeek', 4, userId)
 * @example updateFirmConfig(firmId, 'ragThresholds.0.defaults.green.min', 0.80, userId)
 */
export async function updateFirmConfig(
  firmId: string,
  path: string,
  value: unknown,
  userId: string,
): Promise<FirmConfig> {
  if (path.endsWith('.__add__')) {
    const arrayPath = path.slice(0, -8); // remove '.__add__'
    const current = await getFirmConfig(firmId);
    const existingArray = getNestedValue(
      current as unknown as Record<string, unknown>,
      arrayPath,
    ) as unknown[] ?? [];
    const updated = setNestedValue(
      current as unknown as Record<string, unknown>,
      arrayPath,
      [...existingArray, value],
    ) as FirmConfig;
    await writeConfig(firmId, updated);
    await writeAuditEntry(firmId, userId, AuditAction.UPDATE, 'firm_config',
      firmId, undefined, { path: arrayPath, action: 'array_append' });
    return updated;
  }

  const current = await getFirmConfig(firmId);
  const oldValue = getNestedValue(current as unknown as Record<string, unknown>, path);
  const updated = setNestedValue(current as unknown as Record<string, unknown>, path, value) as FirmConfig;

  // Validate the resulting config
  const validation = FirmConfigSchema.safeParse(updated);
  if (!validation.success) {
    const messages = validation.error.issues.map((i) => i.message).join('; ');
    throw new Error(`Config update invalid at path "${path}": ${messages}`);
  }

  await writeConfig(firmId, updated);

  await writeAuditEntry(
    firmId,
    userId,
    AuditAction.UPDATE,
    'firm_config',
    firmId,
    { [path]: { before: oldValue, after: value } },
    { path },
  );

  return updated;
}

/**
 * Resets the firm's entire config to defaults. Previous config is logged.
 */
export async function resetFirmConfigToDefaults(
  firmId: string,
  userId: string,
): Promise<FirmConfig> {
  const current = await getFirmConfig(firmId);
  const defaults = getDefaultFirmConfig(firmId, current.firmName ?? '');

  await writeConfig(firmId, defaults);

  await writeAuditEntry(
    firmId,
    userId,
    AuditAction.UPDATE,
    'firm_config',
    firmId,
    undefined,
    { action: 'reset_to_defaults', firmName: current.firmName },
  );

  return defaults;
}

/**
 * Exports the firm's full configuration as a portable JSON object.
 * Suitable for download, backup, and cross-firm import.
 *
 * Includes: firm_config, entity_registry, custom_fields, formula_registry,
 *           fee_earner_overrides, column_mapping_templates
 * Excludes: raw data, calculated KPIs, user accounts, audit log
 */
export async function exportFirmConfig(
  firmId: string,
  exportedBy?: string,
): Promise<ExportedConfig> {
  // Read main config
  const firmConfig = await getFirmConfig(firmId);

  // Read entity_registry rows
  const { data: entityRows, error: entityError } = await db.server
    .from('entity_registry')
    .select('entity_type, definition, is_built_in')
    .eq('firm_id', firmId);

  if (entityError) {
    throw new Error(`exportFirmConfig: entity_registry read failed: ${entityError.message}`);
  }

  // Read formula_registry rows
  const { data: formulaRows, error: formulaError } = await db.server
    .from('formula_registry')
    .select('formula_id, definition, is_built_in')
    .eq('firm_id', firmId);

  if (formulaError) {
    throw new Error(`exportFirmConfig: formula_registry read failed: ${formulaError.message}`);
  }

  const exported: ExportedConfig = {
    metadata: {
      exportDate: new Date().toISOString(),
      exportedBy,
      yaomindVersion: YAOMIND_VERSION,
      firmId,
      firmName: firmConfig.firmName ?? '',
    },
    firmConfig: firmConfig as unknown as Record<string, unknown>,
    entityRegistry: (entityRows ?? []) as Array<{
      entity_type: string;
      definition: unknown;
      is_built_in: boolean;
    }>,
    customFields: firmConfig.customFields ?? [],
    formulaRegistry: (formulaRows ?? []) as Array<{
      formula_id: string;
      definition: unknown;
      is_built_in: boolean;
    }>,
    feeEarnerOverrides: firmConfig.feeEarnerOverrides ?? [],
    columnMappingTemplates: firmConfig.columnMappingTemplates ?? [],
  };

  return exported;
}

/** Shape of the exported config object returned by exportFirmConfig. */
export type ExportedConfig = {
  metadata: {
    exportDate: string;
    exportedBy?: string;
    yaomindVersion: string;
    firmId: string;
    firmName?: string;
  };
  firmConfig: Record<string, unknown>;
  entityRegistry: Array<{ entity_type: string; definition: unknown; is_built_in: boolean }>;
  customFields: unknown[];
  formulaRegistry: Array<{ formula_id: string; definition: unknown; is_built_in: boolean }>;
  feeEarnerOverrides: unknown[];
  columnMappingTemplates: unknown[];
};

/**
 * Imports a previously-exported config.
 *
 * Rules:
 *   - Replaces: firm_config (non-identity fields), custom entity_registry entries,
 *     custom formula_registry entries, custom_fields, fee_earner_overrides,
 *     column_mapping_templates
 *   - Does NOT replace built-in entity or formula definitions (those come from code)
 *   - Returns warnings for any unrecognised fields
 */
export async function importFirmConfig(
  firmId: string,
  configJson: Record<string, unknown>,
  userId: string,
): Promise<{ warnings: string[] }> {
  const warnings = collectImportWarnings(configJson);

  // Validate structure (passthrough strips nothing, just reports)
  const parseResult = ExportedConfigSchema.safeParse(configJson);
  if (!parseResult.success) {
    const messages = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Import validation failed:\n${messages.join('\n')}`);
  }

  const imported = parseResult.data;

  // --- firm_config ---
  const current = await getFirmConfig(firmId);
  // Preserve identity fields from the current config (firmId, firmName, etc.)
  const newConfig: FirmConfig = {
    ...(imported.firmConfig as Partial<FirmConfig>),
    firmId: current.firmId,     // always preserve the real firmId
    firmName: current.firmName, // preserve current name
    createdAt: current.createdAt,
    updatedAt: new Date(),
    schemaVersion: current.schemaVersion,
  } as FirmConfig;

  await writeConfig(firmId, newConfig);

  // --- entity_registry: custom entries only ---
  const customEntities = imported.entityRegistry.filter((r) => !r.is_built_in);
  if (customEntities.length > 0) {
    const rows = customEntities.map((r) => ({
      firm_id: firmId,
      entity_type: r.entity_type,
      definition: r.definition,
      is_built_in: false,
      updated_at: new Date().toISOString(),
    }));

    const { error: entityError } = await db.server
      .from('entity_registry')
      .upsert(rows, { onConflict: 'firm_id,entity_type' });

    if (entityError) {
      throw new Error(`importFirmConfig: entity_registry write failed: ${entityError.message}`);
    }
  }

  // --- formula_registry: custom entries only ---
  const customFormulas = imported.formulaRegistry.filter((r) => !r.is_built_in);
  if (customFormulas.length > 0) {
    const rows = customFormulas.map((r) => ({
      firm_id: firmId,
      formula_id: r.formula_id,
      definition: r.definition,
      is_built_in: false,
      updated_at: new Date().toISOString(),
    }));

    const { error: formulaError } = await db.server
      .from('formula_registry')
      .upsert(rows, { onConflict: 'firm_id,formula_id' });

    if (formulaError) {
      throw new Error(`importFirmConfig: formula_registry write failed: ${formulaError.message}`);
    }
  }

  await writeAuditEntry(
    firmId,
    userId,
    AuditAction.IMPORT,
    'firm_config',
    firmId,
    undefined,
    {
      action: 'config_import',
      sourceExportDate: imported.metadata.exportDate,
      sourceFirmId: imported.metadata.firmId,
      warnings,
    },
  );

  return { warnings };
}

// =============================================================================
// RAG Threshold Operations
// =============================================================================

/** Returns the complete RAG threshold config, merged with defaults. */
export async function getRagThresholds(firmId: string): Promise<RagThresholdSet[]> {
  const config = await getFirmConfig(firmId);
  return config.ragThresholds ?? [];
}

/**
 * Updates thresholds for a specific metric, validating logical consistency.
 */
export async function updateRagThreshold(
  firmId: string,
  metricKey: string,
  thresholds: {
    defaults: Record<string, { min?: number; max?: number }>;
    higherIsBetter: boolean;
    overrides?: Record<string, Record<string, { min?: number; max?: number }>>;
  },
  userId: string,
): Promise<void> {
  // Validate logical consistency before writing
  const consistencyErrors = validateRagThresholdConsistency({
    metricKey,
    defaults: thresholds.defaults,
    higherIsBetter: thresholds.higherIsBetter,
  });

  if (consistencyErrors.length > 0) {
    throw new Error(`RAG threshold validation failed: ${consistencyErrors.join('; ')}`);
  }

  // Full schema validation
  const parseResult = RagThresholdSetSchema.safeParse({ metricKey, label: metricKey, ...thresholds });
  if (!parseResult.success) {
    const messages = parseResult.error.issues.map((i) => i.message).join('; ');
    throw new Error(`Invalid RAG threshold for "${metricKey}": ${messages}`);
  }

  const config = await getFirmConfig(firmId);
  const existing = config.ragThresholds ?? [];
  const idx = existing.findIndex((t) => t.metricKey === metricKey);
  const oldValue = idx >= 0 ? existing[idx] : null;

  let updatedThresholds: RagThresholdSet[];
  if (idx >= 0) {
    updatedThresholds = existing.map((t, i) =>
      i === idx ? { ...t, ...parseResult.data } : t,
    );
  } else {
    updatedThresholds = [...existing, parseResult.data];
  }

  await writeConfig(firmId, { ...config, ragThresholds: updatedThresholds });

  await writeAuditEntry(
    firmId,
    userId,
    AuditAction.UPDATE,
    'rag_threshold',
    `${firmId}:${metricKey}`,
    { [metricKey]: { before: oldValue, after: parseResult.data } },
  );
}

/** Resets all RAG thresholds to the system defaults. */
export async function resetRagThresholds(firmId: string, userId: string): Promise<void> {
  const config = await getFirmConfig(firmId);
  const defaults = getDefaultFirmConfig(firmId);
  const updated = { ...config, ragThresholds: defaults.ragThresholds };

  await writeConfig(firmId, updated);

  await writeAuditEntry(
    firmId,
    userId,
    AuditAction.UPDATE,
    'rag_threshold',
    firmId,
    undefined,
    { action: 'reset_rag_thresholds_to_defaults' },
  );
}

// =============================================================================
// Fee Earner Override Operations
// =============================================================================

/** Returns all overrides keyed by fee_earner_id. */
export async function getFeeEarnerOverrides(
  firmId: string,
): Promise<Record<string, FeeEarnerOverride[]>> {
  const config = await getFirmConfig(firmId);
  const overrides = config.feeEarnerOverrides ?? [];

  // Group by feeEarnerId
  const grouped: Record<string, FeeEarnerOverride[]> = {};
  for (const override of overrides) {
    if (!grouped[override.feeEarnerId]) {
      grouped[override.feeEarnerId] = [];
    }
    grouped[override.feeEarnerId].push(override);
  }

  return grouped;
}

/**
 * Creates or replaces all overrides for a specific fee earner.
 * Validates override field names match the fee earner entity definition.
 */
export async function setFeeEarnerOverride(
  firmId: string,
  feeEarnerId: string,
  newOverrides: Array<Omit<FeeEarnerOverride, 'id' | 'firmId' | 'createdAt' | 'updatedAt'>>,
  userId: string,
): Promise<void> {
  // Validate that override fields exist on the feeEarner entity
  const feeEarnerEntity = getBuiltInEntityDefinitions().find(
    (e) => e.entityType === 'feeEarner',
  );
  const validFieldKeys = new Set(feeEarnerEntity?.fields.map((f) => f.key) ?? []);

  const invalidFields = newOverrides
    .map((o) => o.field)
    .filter((f) => !validFieldKeys.has(f));

  if (invalidFields.length > 0) {
    throw new Error(
      `Invalid override field(s) for feeEarner: ${invalidFields.join(', ')}. ` +
      `Valid fields: ${[...validFieldKeys].join(', ')}`,
    );
  }

  const config = await getFirmConfig(firmId);
  const now = new Date();
  const existing = config.feeEarnerOverrides ?? [];

  // Build the updated override list: remove old overrides for this earner, add new ones
  const withoutEarner = existing.filter((o) => o.feeEarnerId !== feeEarnerId);
  const withNew: FeeEarnerOverride[] = newOverrides.map((o, i) => ({
    id: `${feeEarnerId}-${Date.now()}-${i}`,
    firmId,
    feeEarnerId,
    field: o.field,
    value: o.value,
    effectiveFrom: o.effectiveFrom,
    effectiveTo: o.effectiveTo,
    createdAt: now,
    updatedAt: now,
  }));

  await writeConfig(firmId, { ...config, feeEarnerOverrides: [...withoutEarner, ...withNew] });

  await writeAuditEntry(
    firmId,
    userId,
    AuditAction.UPDATE,
    'fee_earner_override',
    feeEarnerId,
    undefined,
    { feeEarnerId, fieldCount: newOverrides.length },
  );
}

/** Removes all overrides for a specific fee earner. */
export async function clearFeeEarnerOverride(
  firmId: string,
  feeEarnerId: string,
  userId: string,
): Promise<void> {
  const config = await getFirmConfig(firmId);
  const existing = config.feeEarnerOverrides ?? [];
  const cleared = existing.filter((o) => o.feeEarnerId !== feeEarnerId);

  await writeConfig(firmId, { ...config, feeEarnerOverrides: cleared });

  await writeAuditEntry(
    firmId,
    userId,
    AuditAction.DELETE,
    'fee_earner_override',
    feeEarnerId,
    undefined,
    { feeEarnerId },
  );
}

// =============================================================================
// Audit Log Operations
// =============================================================================

export interface AuditLogOptions {
  limit?: number;
  offset?: number;
  action?: string;
  entityType?: string;
  dateFrom?: string;
  dateTo?: string;
}

/** Returns paginated, filterable audit log entries for a firm. */
export async function getAuditLog(
  firmId: string,
  options: AuditLogOptions = {},
): Promise<AuditLogEntry[]> {
  const { limit = 50, offset = 0, action, entityType, dateFrom, dateTo } = options;

  let query = db.server
    .from('audit_log')
    .select('*')
    .eq('firm_id', firmId)
    .order('timestamp', { ascending: false })
    .range(offset, offset + limit - 1);

  if (action) query = (query as typeof query).eq('action', action);
  if (entityType) query = (query as typeof query).eq('entity_type', entityType);
  if (dateFrom) query = (query as typeof query).gte('timestamp', dateFrom);
  if (dateTo) query = (query as typeof query).lte('timestamp', dateTo);

  const { data, error } = await query;

  if (error) {
    throw new Error(`getAuditLog failed for firm ${firmId}: ${error.message}`);
  }

  return (data ?? []) as AuditLogEntry[];
}

/** Creates a single audit log entry. */
export async function createAuditEntry(
  firmId: string,
  userId: string,
  entry: Partial<AuditLogEntry>,
): Promise<void> {
  await writeAuditEntry(
    firmId,
    userId,
    entry.action ?? AuditAction.UPDATE,
    String(entry.entityType ?? 'unknown'),
    entry.entityId ?? firmId,
    entry.diff,
    entry.metadata,
  );
}
