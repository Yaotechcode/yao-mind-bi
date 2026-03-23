/**
 * config-export-service.ts
 *
 * Full configuration export and import for Yao Mind.
 * Covers all Supabase configuration tables: firm_config, entity_registry,
 * custom_fields, formula_registry, plus fee_earner_overrides and
 * column_mapping_templates (stored inside firm_config).
 *
 * PATTERNS:
 *   - exportFullConfiguration: reads all config tables in parallel, adds entity counts
 *   - importFullConfiguration: validates, backs up, then replaces custom config only
 *   - Built-in entities and built-in formulas are NEVER overwritten on import
 *   - A pre-import backup is written to audit_log before any data is changed
 */

import { z } from 'zod';
import { getServerClient } from '../lib/supabase.js';
import { getFirmConfig } from './config-service.js';
import { AuditAction } from '../../shared/types/index.js';

// Version kept in sync with package.json
const YAOMIND_VERSION = '0.1.0';

// =============================================================================
// Types
// =============================================================================

export interface EntityCounts {
  builtInEntities: number;
  customEntities: number;
  customFields: number;
  builtInFormulas: number;
  customFormulas: number;
  snippets: number;
  overrides: number;
  mappingTemplates: number;
}

export interface ExportedFullConfig {
  metadata: {
    exportDate: string;
    exportedBy: string;
    yaomindVersion: string;
    firmId: string;
    firmName: string;
    entityCounts: EntityCounts;
  };
  firmConfig: Record<string, unknown>;
  entityRegistry: Record<string, unknown>[];
  customFields: Record<string, unknown>[];
  formulaRegistry: Record<string, unknown>[];
  feeEarnerOverrides: unknown[];
  columnMappingTemplates: unknown[];
}

export interface ImportResult {
  success: boolean;
  warnings: string[];
  imported: {
    firms: number;
    customEntities: number;
    customFields: number;
    customFormulas: number;
    overrides: number;
    mappingTemplates: number;
  };
  skipped: {
    builtInEntities: number;
    builtInFormulas: number;
  };
  /** ID of the backup audit log entry created before the import. */
  backup: string;
}

// =============================================================================
// Validation schema for imported config files
// =============================================================================

const ImportedConfigSchema = z.object({
  metadata: z.object({
    exportDate: z.string(),
    exportedBy: z.string().optional(),
    yaomindVersion: z.string(),
    firmId: z.string(),
    firmName: z.string().optional(),
    entityCounts: z.record(z.unknown()).optional(),
  }),
  firmConfig: z.record(z.unknown()),
  entityRegistry: z.array(z.record(z.unknown())),
  customFields: z.array(z.record(z.unknown())),
  formulaRegistry: z.array(z.record(z.unknown())),
  feeEarnerOverrides: z.array(z.unknown()),
  columnMappingTemplates: z.array(z.unknown()),
});

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Writes an audit entry and returns the new row's id (or undefined on failure).
 * Failures are non-fatal: logged to console but do not throw.
 */
async function writeAuditEntry(
  db: ReturnType<typeof getServerClient>,
  firmId: string,
  userId: string,
  action: AuditAction,
  entityType: string,
  entityId: string,
  description: string,
): Promise<string | undefined> {
  const { data, error } = await db
    .from('audit_log')
    .insert({
      firm_id: firmId,
      user_id: userId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      description,
      created_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) {
    console.error(`[audit_log] Failed to write entry: ${error.message}`);
    return undefined;
  }

  return (data as Record<string, unknown>)?.['id'] as string | undefined;
}

// =============================================================================
// Export
// =============================================================================

/**
 * Gathers all configuration tables for a firm and returns them as a single
 * portable object. Suitable for JSON.stringify and download.
 *
 * Includes: firm_config, entity_registry, custom_fields, formula_registry,
 *           fee_earner_overrides, column_mapping_templates
 * Excludes: raw uploads, enriched pipeline data, calculated KPIs,
 *           user accounts, audit log
 *
 * Logs the export in audit_log.
 */
export async function exportFullConfiguration(
  firmId: string,
  userId: string,
): Promise<ExportedFullConfig> {
  const db = getServerClient();

  // Parallel reads — getFirmConfig is independent of the table reads
  const [firmConfig, entityResult, customFieldsResult, formulaResult] = await Promise.all([
    getFirmConfig(firmId),
    db.from('entity_registry').select('*').eq('firm_id', firmId),
    db.from('custom_fields').select('*').eq('firm_id', firmId),
    db.from('formula_registry').select('*').eq('firm_id', firmId),
  ]);

  if (entityResult.error) {
    throw new Error(
      `exportFullConfiguration: entity_registry read failed: ${entityResult.error.message}`,
    );
  }
  if (customFieldsResult.error) {
    throw new Error(
      `exportFullConfiguration: custom_fields read failed: ${customFieldsResult.error.message}`,
    );
  }
  if (formulaResult.error) {
    throw new Error(
      `exportFullConfiguration: formula_registry read failed: ${formulaResult.error.message}`,
    );
  }

  const entityRows = (entityResult.data ?? []) as Record<string, unknown>[];
  const customFieldRows = (customFieldsResult.data ?? []) as Record<string, unknown>[];
  const formulaRows = (formulaResult.data ?? []) as Record<string, unknown>[];
  const feeEarnerOverrides = (firmConfig.feeEarnerOverrides ?? []) as unknown[];
  const columnMappingTemplates = (firmConfig.columnMappingTemplates ?? []) as unknown[];

  const entityCounts: EntityCounts = {
    builtInEntities: entityRows.filter((r) => r['is_built_in']).length,
    customEntities: entityRows.filter((r) => !r['is_built_in']).length,
    customFields: customFieldRows.length,
    builtInFormulas: formulaRows.filter((r) => r['formula_type'] === 'built_in').length,
    customFormulas: formulaRows.filter((r) => r['formula_type'] === 'custom').length,
    snippets: formulaRows.filter((r) => r['formula_type'] === 'snippet').length,
    overrides: feeEarnerOverrides.length,
    mappingTemplates: columnMappingTemplates.length,
  };

  const exported: ExportedFullConfig = {
    metadata: {
      exportDate: new Date().toISOString(),
      exportedBy: userId,
      yaomindVersion: YAOMIND_VERSION,
      firmId,
      firmName: firmConfig.firmName ?? '',
      entityCounts,
    },
    firmConfig: firmConfig as unknown as Record<string, unknown>,
    entityRegistry: entityRows,
    customFields: customFieldRows,
    formulaRegistry: formulaRows,
    feeEarnerOverrides,
    columnMappingTemplates,
  };

  await writeAuditEntry(
    db,
    firmId,
    userId,
    AuditAction.EXPORT,
    'firm_config',
    firmId,
    `Configuration exported by user ${userId}`,
  );

  return exported;
}

// =============================================================================
// Import
// =============================================================================

/**
 * Imports a previously-exported configuration file.
 *
 * Strategy:
 *   - firm_config:            REPLACE (preserving identity fields: firmId, firmName, etc.)
 *   - entity_registry:        REPLACE custom entities only; built-ins are skipped
 *   - custom_fields:          REPLACE all fields for entities present in the import
 *   - formula_registry:       REPLACE custom formulas/snippets only; built-ins are skipped
 *   - fee_earner_overrides:   REPLACE via firm_config update
 *   - column_mapping_templates: REPLACE via firm_config update
 *
 * A pre-import backup of firm_config is stored in audit_log before any write.
 * Warnings are returned for referential inconsistencies; they do NOT abort the import.
 */
export async function importFullConfiguration(
  firmId: string,
  configJson: string,
  userId: string,
): Promise<ImportResult> {
  const db = getServerClient();
  const warnings: string[] = [];

  // --- Parse ---
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    throw new Error('Invalid JSON: could not parse configuration file');
  }

  // --- Validate schema ---
  const validation = ImportedConfigSchema.safeParse(parsed);
  if (!validation.success) {
    const messages = validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Import validation failed:\n${messages.join('\n')}`);
  }

  const imported = validation.data;

  // --- Version compatibility (major version must match) ---
  const importedMajor = parseInt(imported.metadata.yaomindVersion.split('.')[0] ?? '0', 10);
  const currentMajor = parseInt(YAOMIND_VERSION.split('.')[0] ?? '0', 10);
  if (importedMajor !== currentMajor) {
    throw new Error(
      `Version incompatible: import is from v${imported.metadata.yaomindVersion}, ` +
        `current is v${YAOMIND_VERSION}. Only same-major-version imports are supported.`,
    );
  }

  // --- Pre-import backup: store current firm_config in audit_log ---
  const currentForBackup = await getFirmConfig(firmId);
  const backupId = await writeAuditEntry(
    db,
    firmId,
    userId,
    AuditAction.EXPORT,
    'firm_config',
    firmId,
    `config_backup:${JSON.stringify(currentForBackup)}`,
  );

  // --- firm_config: merge imported values, preserving identity fields ---
  const current = await getFirmConfig(firmId);
  const newConfig = {
    ...(imported.firmConfig as Record<string, unknown>),
    firmId: current.firmId,
    firmName: current.firmName,
    createdAt: current.createdAt,
    updatedAt: new Date(),
    schemaVersion: current.schemaVersion,
  };

  const { error: configError } = await db
    .from('firm_config')
    .update({ config: newConfig, updated_at: new Date().toISOString() })
    .eq('firm_id', firmId);

  if (configError) {
    throw new Error(
      `importFullConfiguration: firm_config write failed: ${configError.message}`,
    );
  }

  // --- entity_registry: custom entities only ---
  const customEntities = imported.entityRegistry.filter((r) => !r['is_built_in']);
  const builtInEntitiesSkipped = imported.entityRegistry.filter((r) => r['is_built_in']).length;

  let importedCustomEntities = 0;
  if (customEntities.length > 0) {
    const entityRows = customEntities.map((r) => ({
      ...r,
      firm_id: firmId,
      is_built_in: false,
      updated_at: new Date().toISOString(),
    }));

    const { error: entityError } = await db
      .from('entity_registry')
      .upsert(entityRows, { onConflict: 'firm_id,entity_key' });

    if (entityError) {
      throw new Error(
        `importFullConfiguration: entity_registry write failed: ${entityError.message}`,
      );
    }
    importedCustomEntities = customEntities.length;
  }

  // --- custom_fields: REPLACE all fields for entities in this import ---
  const importedEntityKeys = new Set(
    imported.entityRegistry
      .map((r) => r['entity_key'] as string)
      .filter(Boolean),
  );

  // Warn if any custom field references an entity not in the imported set
  const customFieldEntityKeys = new Set(
    imported.customFields
      .map((r) => r['entity_key'] as string)
      .filter(Boolean),
  );
  for (const entityKey of customFieldEntityKeys) {
    if (!importedEntityKeys.has(entityKey)) {
      warnings.push(
        `Custom field references entity "${entityKey}" which is not included in the imported config`,
      );
    }
  }

  // Delete existing custom_fields for all entities present in the import
  for (const entityKey of importedEntityKeys) {
    await db
      .from('custom_fields')
      .delete()
      .eq('firm_id', firmId)
      .eq('entity_key', entityKey);
  }

  let importedCustomFields = 0;
  if (imported.customFields.length > 0) {
    const fieldRows = imported.customFields.map((r) => ({
      ...r,
      firm_id: firmId,
      updated_at: new Date().toISOString(),
    }));

    const { error: fieldsError } = await db.from('custom_fields').insert(fieldRows);
    if (fieldsError) {
      throw new Error(
        `importFullConfiguration: custom_fields write failed: ${fieldsError.message}`,
      );
    }
    importedCustomFields = imported.customFields.length;
  }

  // --- formula_registry: custom formulas and snippets only ---
  const customFormulas = imported.formulaRegistry.filter(
    (r) => r['formula_type'] !== 'built_in',
  );
  const builtInFormulasSkipped = imported.formulaRegistry.filter(
    (r) => r['formula_type'] === 'built_in',
  ).length;

  let importedCustomFormulas = 0;
  if (customFormulas.length > 0) {
    const formulaRows = customFormulas.map((r) => ({
      ...r,
      firm_id: firmId,
      is_built_in: false,
      updated_at: new Date().toISOString(),
    }));

    const { error: formulaError } = await db
      .from('formula_registry')
      .upsert(formulaRows, { onConflict: 'firm_id,formula_id' });

    if (formulaError) {
      throw new Error(
        `importFullConfiguration: formula_registry write failed: ${formulaError.message}`,
      );
    }
    importedCustomFormulas = customFormulas.length;
  }

  // --- Log the import ---
  await writeAuditEntry(
    db,
    firmId,
    userId,
    AuditAction.IMPORT,
    'firm_config',
    firmId,
    `Configuration imported from export dated ${imported.metadata.exportDate}. ` +
      `Backup entry ID: ${backupId ?? 'unavailable'}`,
  );

  return {
    success: true,
    warnings,
    imported: {
      firms: 1,
      customEntities: importedCustomEntities,
      customFields: importedCustomFields,
      customFormulas: importedCustomFormulas,
      overrides: imported.feeEarnerOverrides.length,
      mappingTemplates: imported.columnMappingTemplates.length,
    },
    skipped: {
      builtInEntities: builtInEntitiesSkipped,
      builtInFormulas: builtInFormulasSkipped,
    },
    backup: backupId ?? '',
  };
}
