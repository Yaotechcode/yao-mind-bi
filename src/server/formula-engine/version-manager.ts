/**
 * version-manager.ts — Formula Version Manager
 *
 * Tracks every change to a formula or snippet definition as an immutable
 * version row. KPI calculation documents stamp the version snapshot they
 * used so results can be reproduced or audited later.
 *
 * Key design decisions:
 *   - formula_versions rows are immutable (no DELETE/UPDATE via RLS).
 *     The service role updates is_current when a newer version is inserted.
 *   - version_number is per (firm_id, formula_id), starting at 1.
 *   - Breaking changes (definition, dependsOn, resultType, etc.) are flagged
 *     in FormulaVersionDiff.hasBreakingChanges.
 *   - createFormulaVersionSnapshot / hasFormulasChanged let orchestrators
 *     detect whether KPI results need to be recalculated.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { db } from '../lib/supabase.js';
import type {
  BuiltInFormulaDefinition,
  BuiltInSnippetDefinition,
  FormulaDefinitionObject,
  FormulaVariantDef,
  FormulaDisplayConfig,
} from '../../shared/formulas/types.js';

// =============================================================================
// Public Types
// =============================================================================

export interface FormulaVersion {
  id: string;
  firmId: string;
  formulaId: string;
  versionNumber: number;
  isCurrent: boolean;
  name: string;
  description: string | null;
  category: string | null;
  formulaType: string;
  entityType: string;
  resultType: string;
  definition: FormulaDefinitionObject;
  activeVariant: string | null;
  variants: Record<string, FormulaVariantDef> | null;
  modifiers: unknown[];
  dependsOn: string[];
  displayConfig: FormulaDisplayConfig | Record<string, unknown> | null;
  changeSummary: string | null;
  changedBy: string | null;
  createdAt: string;
}

export interface FormulaVersionDiff {
  formulaId: string;
  v1: number;
  v2: number;
  /** Names of fields (camelCase) that differ between the two versions. */
  changedFields: string[];
  /**
   * True if any changed field would affect calculation output.
   * Non-breaking changes: name, description, displayConfig.
   * Breaking changes: definition, dependsOn, activeVariant, variants,
   *   formulaType, resultType, entityType.
   */
  hasBreakingChanges: boolean;
  /** Human-readable summary of changes. */
  summary: string;
}

/**
 * Maps formulaId → versionNumber, stamped on every KPI calculation document.
 * Used by hasFormulasChanged to detect whether a recalculation is needed.
 */
export type FormulaVersionSnapshot = Record<string, number>;

// =============================================================================
// Internal DB row type (snake_case from Supabase)
// =============================================================================

interface FormulaVersionRow {
  id: string;
  firm_id: string;
  formula_id: string;
  version_number: number;
  is_current: boolean;
  name: string;
  description: string | null;
  category: string | null;
  formula_type: string;
  entity_type: string;
  result_type: string;
  definition: FormulaDefinitionObject;
  active_variant: string | null;
  variants: Record<string, FormulaVariantDef> | null;
  modifiers: unknown[];
  depends_on: string[];
  display_config: FormulaDisplayConfig | Record<string, unknown> | null;
  change_summary: string | null;
  changed_by: string | null;
  created_at: string;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Fields whose change would cause formula output to differ.
 * A diff containing any of these sets hasBreakingChanges = true.
 */
const BREAKING_FIELDS: Array<keyof FormulaVersion> = [
  'definition',
  'dependsOn',
  'activeVariant',
  'variants',
  'formulaType',
  'resultType',
  'entityType',
];

/** All fields compared during diffVersions. */
const DIFFABLE_FIELDS: Array<keyof FormulaVersion> = [
  'name',
  'description',
  'category',
  'formulaType',
  'entityType',
  'resultType',
  'definition',
  'activeVariant',
  'variants',
  'modifiers',
  'dependsOn',
  'displayConfig',
];

// =============================================================================
// FormulaVersionManager
// =============================================================================

export class FormulaVersionManager {
  constructor(private readonly client: SupabaseClient = db.server) {}

  // ---------------------------------------------------------------------------
  // createVersion
  // ---------------------------------------------------------------------------

  /**
   * Record a new version of a formula or snippet definition.
   *
   * Steps:
   *   1. Query the highest existing version_number for this formula.
   *   2. If a previous version exists, mark it as is_current = false.
   *   3. Insert the new version with version_number + 1 and is_current = true.
   *
   * @param firmId        Firm that owns this formula.
   * @param userId        User who made the change (stored as changed_by).
   * @param definition    Full formula or snippet definition to snapshot.
   * @param changeSummary Optional human-readable description of what changed.
   * @returns The newly created FormulaVersion.
   * @throws If the INSERT fails (e.g. constraint violation).
   */
  async createVersion(
    firmId: string,
    userId: string,
    definition: BuiltInFormulaDefinition | BuiltInSnippetDefinition,
    changeSummary?: string,
  ): Promise<FormulaVersion> {
    const formulaId =
      'formulaId' in definition ? definition.formulaId : definition.snippetId;
    const formulaType =
      'formulaId' in definition ? definition.formulaType : 'snippet';

    // Step 1: Find the current maximum version number.
    const { data: existing } = await this.client
      .from('formula_versions')
      .select('version_number')
      .eq('firm_id', firmId)
      .eq('formula_id', formulaId)
      .order('version_number', { ascending: false })
      .limit(1);

    const maxVersion =
      Array.isArray(existing) && existing.length > 0
        ? (existing[0] as { version_number: number }).version_number
        : 0;

    const newVersionNumber = maxVersion + 1;

    // Step 2: Mark the previous current version as no longer current.
    // The service role bypasses RLS — users cannot perform this UPDATE directly.
    if (maxVersion > 0) {
      await this.client
        .from('formula_versions')
        .update({ is_current: false })
        .eq('firm_id', firmId)
        .eq('formula_id', formulaId)
        .eq('is_current', true);
    }

    // Step 3: Insert the new version row.
    const row = {
      firm_id: firmId,
      formula_id: formulaId,
      version_number: newVersionNumber,
      is_current: true,
      name: definition.name,
      description: definition.description,
      category: 'category' in definition ? definition.category : null,
      formula_type: formulaType,
      entity_type: definition.entityType,
      result_type: definition.resultType,
      definition: definition.definition,
      active_variant:
        'activeVariant' in definition ? definition.activeVariant : null,
      variants: 'variants' in definition ? definition.variants : null,
      modifiers: 'modifiers' in definition ? definition.modifiers : [],
      depends_on: definition.dependsOn,
      display_config:
        'displayConfig' in definition ? definition.displayConfig : null,
      change_summary: changeSummary ?? null,
      changed_by: userId,
    };

    const { data, error } = await this.client
      .from('formula_versions')
      .insert(row)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create formula version: ${error.message}`);
    }

    return mapRow(data as FormulaVersionRow);
  }

  // ---------------------------------------------------------------------------
  // getCurrentVersion
  // ---------------------------------------------------------------------------

  /**
   * Retrieve the current (latest) version of a formula.
   * Returns null if no version has been created yet.
   */
  async getCurrentVersion(
    firmId: string,
    formulaId: string,
  ): Promise<FormulaVersion | null> {
    const { data, error } = await this.client
      .from('formula_versions')
      .select('*')
      .eq('firm_id', firmId)
      .eq('formula_id', formulaId)
      .eq('is_current', true)
      .single();

    if (error || !data) return null;
    return mapRow(data as FormulaVersionRow);
  }

  // ---------------------------------------------------------------------------
  // getVersionHistory
  // ---------------------------------------------------------------------------

  /**
   * Retrieve the complete version history for a formula, newest first.
   * Returns an empty array if no versions exist.
   */
  async getVersionHistory(
    firmId: string,
    formulaId: string,
  ): Promise<FormulaVersion[]> {
    const { data, error } = await this.client
      .from('formula_versions')
      .select('*')
      .eq('firm_id', firmId)
      .eq('formula_id', formulaId)
      .order('version_number', { ascending: false });

    if (error || !data) return [];
    return (data as FormulaVersionRow[]).map(mapRow);
  }

  // ---------------------------------------------------------------------------
  // getVersion
  // ---------------------------------------------------------------------------

  /**
   * Retrieve a specific version by number.
   * Returns null if that version does not exist.
   */
  async getVersion(
    firmId: string,
    formulaId: string,
    versionNumber: number,
  ): Promise<FormulaVersion | null> {
    const { data, error } = await this.client
      .from('formula_versions')
      .select('*')
      .eq('firm_id', firmId)
      .eq('formula_id', formulaId)
      .eq('version_number', versionNumber)
      .single();

    if (error || !data) return null;
    return mapRow(data as FormulaVersionRow);
  }

  // ---------------------------------------------------------------------------
  // diffVersions
  // ---------------------------------------------------------------------------

  /**
   * Compute a field-level diff between two version numbers of the same formula.
   *
   * @param v1 Earlier version number.
   * @param v2 Later version number.
   * @throws If either version does not exist.
   */
  async diffVersions(
    firmId: string,
    formulaId: string,
    v1: number,
    v2: number,
  ): Promise<FormulaVersionDiff> {
    const [version1, version2] = await Promise.all([
      this.getVersion(firmId, formulaId, v1),
      this.getVersion(firmId, formulaId, v2),
    ]);

    if (!version1) {
      throw new Error(
        `diffVersions: version ${v1} not found for formula ${formulaId}`,
      );
    }
    if (!version2) {
      throw new Error(
        `diffVersions: version ${v2} not found for formula ${formulaId}`,
      );
    }

    const changedFields = detectChangedFields(version1, version2);
    const hasBreakingChanges = BREAKING_FIELDS.some((f) =>
      changedFields.includes(f as string),
    );

    const summary =
      changedFields.length === 0
        ? 'No changes detected'
        : `${changedFields.length} field(s) changed: ${changedFields.join(', ')}${hasBreakingChanges ? ' (breaking)' : ''}`;

    return { formulaId, v1, v2, changedFields, hasBreakingChanges, summary };
  }

  // ---------------------------------------------------------------------------
  // createFormulaVersionSnapshot
  // ---------------------------------------------------------------------------

  /**
   * Build a version snapshot for a set of formulas.
   *
   * The snapshot is stored alongside KPI calculation results so that any
   * future recalculation can verify whether the formulas have changed.
   * Formulas with no version yet are omitted from the snapshot.
   */
  async createFormulaVersionSnapshot(
    firmId: string,
    formulaIds: string[],
  ): Promise<FormulaVersionSnapshot> {
    const snapshot: FormulaVersionSnapshot = {};

    await Promise.all(
      formulaIds.map(async (formulaId) => {
        const version = await this.getCurrentVersion(firmId, formulaId);
        if (version) {
          snapshot[formulaId] = version.versionNumber;
        }
      }),
    );

    return snapshot;
  }

  // ---------------------------------------------------------------------------
  // hasFormulasChanged
  // ---------------------------------------------------------------------------

  /**
   * Detect whether any formula has changed since a snapshot was taken.
   *
   * Returns true if:
   *   - A formula in the snapshot has no current version (it was deleted or
   *     the registry was reset), OR
   *   - A formula's current version number exceeds the snapshotted number.
   *
   * An empty snapshot always returns false.
   */
  async hasFormulasChanged(
    firmId: string,
    snapshot: FormulaVersionSnapshot,
  ): Promise<boolean> {
    const formulaIds = Object.keys(snapshot);
    if (formulaIds.length === 0) return false;

    const changed = await Promise.all(
      formulaIds.map(async (formulaId) => {
        const current = await this.getCurrentVersion(firmId, formulaId);
        return current === null || current.versionNumber !== snapshot[formulaId];
      }),
    );

    return changed.some(Boolean);
  }
}

// =============================================================================
// Private helpers
// =============================================================================

/** Map a database row (snake_case) to a FormulaVersion (camelCase). */
function mapRow(row: FormulaVersionRow): FormulaVersion {
  return {
    id: row.id,
    firmId: row.firm_id,
    formulaId: row.formula_id,
    versionNumber: row.version_number,
    isCurrent: row.is_current,
    name: row.name,
    description: row.description,
    category: row.category,
    formulaType: row.formula_type,
    entityType: row.entity_type,
    resultType: row.result_type,
    definition: row.definition,
    activeVariant: row.active_variant,
    variants: row.variants,
    modifiers: row.modifiers,
    dependsOn: row.depends_on,
    displayConfig: row.display_config,
    changeSummary: row.change_summary,
    changedBy: row.changed_by,
    createdAt: row.created_at,
  };
}

/** Return the names of fields that differ between two versions. */
function detectChangedFields(
  v1: FormulaVersion,
  v2: FormulaVersion,
): string[] {
  return DIFFABLE_FIELDS.filter((field) => {
    return JSON.stringify(v1[field]) !== JSON.stringify(v2[field]);
  });
}
