/**
 * audit-service.ts
 *
 * Enhanced audit log operations: paginated retrieval with total count,
 * config change history by path, and config rollback.
 *
 * Uses created_at column (not timestamp) and description column (not diff/metadata).
 * Rollback only works for entries whose description contains a JSON rollback payload
 * in the format: { "path": string, "before": unknown }.
 */

import { getServerClient } from '../lib/supabase.js';
import { updateFirmConfig } from './config-service.js';
import { AuditAction } from '../../shared/types/index.js';

// =============================================================================
// Types
// =============================================================================

export interface AuditLogQuery {
  limit?: number;
  offset?: number;
  action?: string;
  entityType?: string;
  userId?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Full-text search in description field. */
  search?: string;
}

/** A row from the audit_log table. Uses string for entityType to support custom values. */
export interface AuditEntry {
  id: string;
  firmId: string;
  userId?: string;
  action: string;
  entityType: string;
  entityId: string;
  description?: string;
  createdAt: string;
}

// =============================================================================
// Internal helpers
// =============================================================================

function rowToAuditEntry(row: Record<string, unknown>): AuditEntry {
  return {
    id: row['id'] as string,
    firmId: row['firm_id'] as string,
    userId: row['user_id'] as string | undefined,
    action: row['action'] as string,
    entityType: row['entity_type'] as string,
    entityId: row['entity_id'] as string,
    description: row['description'] as string | undefined,
    createdAt: row['created_at'] as string,
  };
}

// =============================================================================
// Audit log retrieval
// =============================================================================

/**
 * Returns paginated audit log entries for a firm, with a total count for
 * pagination UI. Supports filtering by action, entityType, userId, date range,
 * and full-text search in the description field.
 */
export async function getAuditLog(
  firmId: string,
  options: AuditLogQuery = {},
): Promise<{ entries: AuditEntry[]; total: number }> {
  const {
    limit = 50,
    offset = 0,
    action,
    entityType,
    userId,
    dateFrom,
    dateTo,
    search,
  } = options;

  const db = getServerClient();

  // --- Count query ---
  let countQuery = db
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('firm_id', firmId);

  if (action) countQuery = (countQuery as typeof countQuery).eq('action', action);
  if (entityType) countQuery = (countQuery as typeof countQuery).eq('entity_type', entityType);
  if (userId) countQuery = (countQuery as typeof countQuery).eq('user_id', userId);
  if (dateFrom) countQuery = (countQuery as typeof countQuery).gte('created_at', dateFrom);
  if (dateTo) countQuery = (countQuery as typeof countQuery).lte('created_at', dateTo);
  if (search) countQuery = (countQuery as typeof countQuery).ilike('description', `%${search}%`);

  const { count, error: countError } = await countQuery;
  if (countError) {
    throw new Error(`getAuditLog count failed for firm ${firmId}: ${countError.message}`);
  }

  // --- Data query ---
  let dataQuery = db
    .from('audit_log')
    .select('*')
    .eq('firm_id', firmId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (action) dataQuery = (dataQuery as typeof dataQuery).eq('action', action);
  if (entityType) dataQuery = (dataQuery as typeof dataQuery).eq('entity_type', entityType);
  if (userId) dataQuery = (dataQuery as typeof dataQuery).eq('user_id', userId);
  if (dateFrom) dataQuery = (dataQuery as typeof dataQuery).gte('created_at', dateFrom);
  if (dateTo) dataQuery = (dataQuery as typeof dataQuery).lte('created_at', dateTo);
  if (search) dataQuery = (dataQuery as typeof dataQuery).ilike('description', `%${search}%`);

  const { data, error } = await dataQuery;
  if (error) {
    throw new Error(`getAuditLog failed for firm ${firmId}: ${error.message}`);
  }

  return {
    entries: ((data ?? []) as Record<string, unknown>[]).map(rowToAuditEntry),
    total: count ?? 0,
  };
}

// =============================================================================
// Config change history
// =============================================================================

/**
 * Returns the change history for a specific config path, most recent first.
 * Searches for audit entries where description contains the path as a JSON key.
 *
 * @example getConfigChangeHistory(firmId, 'ragThresholds.utilisation')
 */
export async function getConfigChangeHistory(
  firmId: string,
  configPath: string,
): Promise<AuditEntry[]> {
  const db = getServerClient();

  // Entries written by config-export-service store { "path": "...", "before": ... } in description
  const { data, error } = await db
    .from('audit_log')
    .select('*')
    .eq('firm_id', firmId)
    .eq('entity_type', 'firm_config')
    .eq('action', AuditAction.UPDATE)
    .ilike('description', `%"path":"${configPath}"%`)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(
      `getConfigChangeHistory failed for path "${configPath}": ${error.message}`,
    );
  }

  return ((data ?? []) as Record<string, unknown>[]).map(rowToAuditEntry);
}

// =============================================================================
// Config rollback
// =============================================================================

/**
 * Restores the "before" value from a firm_config audit entry.
 *
 * Requirements for the source entry:
 *   - action must be 'update'
 *   - entity_type must be 'firm_config'
 *   - description must be a JSON string with shape: { "path": string, "before": unknown }
 *
 * Creates a new audit entry recording the rollback.
 * Only works for config changes — data uploads, entity operations, etc. cannot be rolled back.
 */
export async function rollbackConfigChange(
  firmId: string,
  auditEntryId: string,
  userId: string,
): Promise<void> {
  const db = getServerClient();

  // Read the target audit entry
  const { data: entry, error } = await db
    .from('audit_log')
    .select('*')
    .eq('firm_id', firmId)
    .eq('id', auditEntryId)
    .single();

  if (error || !entry) {
    throw new Error(`Audit entry "${auditEntryId}" not found for this firm`);
  }

  const row = entry as Record<string, unknown>;

  if (row['action'] !== AuditAction.UPDATE || row['entity_type'] !== 'firm_config') {
    throw new Error(
      'Rollback is only supported for firm_config update entries ' +
        `(entry action: "${String(row['action'])}", entity_type: "${String(row['entity_type'])}")`,
    );
  }

  const description = row['description'] as string | undefined;
  if (!description) {
    throw new Error('Audit entry has no description — cannot determine rollback target');
  }

  // Parse rollback payload from description
  let rollbackData: { path?: string; before?: unknown };
  try {
    rollbackData = JSON.parse(description) as { path?: string; before?: unknown };
  } catch {
    throw new Error(
      'Audit entry description is not valid JSON — cannot roll back this entry. ' +
        'Only entries created by the config-export-service support rollback.',
    );
  }

  if (!rollbackData.path || rollbackData.before === undefined) {
    throw new Error(
      'Audit entry does not contain rollback data (path and before value required). ' +
        'Only entries created by the config-export-service support rollback.',
    );
  }

  // Restore the old value — updateFirmConfig logs a new audit entry for this change
  await updateFirmConfig(firmId, rollbackData.path, rollbackData.before, userId);

  // Log an additional entry recording the rollback source
  await db.from('audit_log').insert({
    firm_id: firmId,
    user_id: userId,
    action: AuditAction.UPDATE,
    entity_type: 'firm_config',
    entity_id: firmId,
    description: JSON.stringify({
      type: 'rollback',
      sourceEntryId: auditEntryId,
      path: rollbackData.path,
      restoredValue: rollbackData.before,
    }),
    created_at: new Date().toISOString(),
  });
}
