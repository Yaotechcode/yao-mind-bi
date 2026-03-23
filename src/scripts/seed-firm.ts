/**
 * seed-firm.ts
 *
 * Seeds a new firm's initial data in Supabase:
 *   1. entity_registry  — all 9 built-in entity definitions
 *   2. firm_config      — default configuration (all 3 tiers)
 *   3. formula_registry — 23 built-in formula + 5 snippet definitions
 *
 * Usage:
 *   FIRM_ID=<uuid> FIRM_NAME="My Law Firm" npx tsx src/scripts/seed-firm.ts
 *
 * Or call seedFirm() programmatically from the create_firm_with_owner flow.
 */

import { getServerClient } from '../server/lib/supabase.js';
import { getBuiltInEntityDefinitions } from '../shared/entities/registry.js';
import { getDefaultFirmConfig } from '../shared/entities/defaults.js';
import { seedFormulas } from './seed-formulas.js';
import { getBuiltInFormulaDefinitions } from '../shared/formulas/built-in-formulas.js';
import { getBuiltInSnippetDefinitions } from '../shared/formulas/built-in-snippets.js';

// ---------------------------------------------------------------------------
// Seed function
// ---------------------------------------------------------------------------

export interface SeedFirmOptions {
  firmId: string;
  firmName: string;
  /** User ID performing the seed (written to audit_log). Omit for system seeds. */
  seedUserId?: string;
}

export interface SeedFirmResult {
  success: boolean;
  firmId: string;
  entityCount: number;
  formulaCount: number;
  error?: string;
}

/**
 * Seeds a new firm with default entity definitions, config, and formula stubs.
 * Safe to call multiple times — upserts where possible.
 */
export async function seedFirm(options: SeedFirmOptions): Promise<SeedFirmResult> {
  const { firmId, firmName, seedUserId } = options;
  const db = getServerClient();
  const now = new Date().toISOString();

  try {
    // 1. Seed entity_registry
    // EntityDefinition uses entityType (the stable key) and labelPlural.
    // No entityKey or derivedFrom fields exist on the type.
    const entityDefs = getBuiltInEntityDefinitions();

    const entityRows = entityDefs.map((def) => ({
      firm_id: firmId,
      entity_key: def.entityType,
      is_built_in: true,
      label: def.label,
      plural_label: def.labelPlural,
      icon: def.icon ?? null,
      description: def.description ?? null,
      fields: def.fields,
      relationships: def.relationships,
      data_source: def.dataSource ?? null,
      derived_from: null,
      created_at: now,
      updated_at: now,
    }));

    const { error: entityError } = await db
      .from('entity_registry')
      .upsert(entityRows, { onConflict: 'firm_id,entity_key' });

    if (entityError) {
      throw new Error(`entity_registry seed failed: ${entityError.message}`);
    }

    // 2. Seed firm_config
    // FirmConfig is a flat object — the DB columns are grouped JSONB blobs.
    // We build each blob from the relevant flat fields.
    const config = getDefaultFirmConfig(firmId, firmName);

    const { error: configError } = await db
      .from('firm_config')
      .upsert(
        {
          firm_id: firmId,
          working_time_defaults: {
            workingDaysPerWeek: config.workingDaysPerWeek,
            dailyTargetHours: config.dailyTargetHours,
            weeklyTargetHours: config.weeklyTargetHours,
            chargeableWeeklyTarget: config.chargeableWeeklyTarget,
            annualLeaveEntitlement: config.annualLeaveEntitlement,
            bankHolidaysPerYear: config.bankHolidaysPerYear,
          },
          salaried_config: {
            costRateMethod: config.costRateMethod,
            utilisationApproach: config.utilisationApproach,
            fteCountMethod: config.fteCountMethod,
          },
          fee_share_config: {
            defaultFeeSharePercent: config.defaultFeeSharePercent,
            defaultFirmRetainPercent: config.defaultFirmRetainPercent,
          },
          revenue_attribution: config.revenueAttribution ?? null,
          data_trust_model: {},
          display_preferences: {
            showLawyerPerspective: config.showLawyerPerspective,
            showDiscrepancies: config.showDiscrepancies,
          },
          export_settings: {},
          rag_thresholds: config.ragThresholds,
          overhead_config: {},
          scorecard_weights: {},
          updated_at: now,
          updated_by: null,
        },
        { onConflict: 'firm_id' },
      );

    if (configError) {
      throw new Error(`firm_config seed failed: ${configError.message}`);
    }

    // 3. Seed formula_registry (23 formulas + 5 snippets)
    await seedFormulas(firmId);

    const formulaCount =
      getBuiltInFormulaDefinitions().length + getBuiltInSnippetDefinitions().length;

    // 4. Write audit log entry
    // audit_log columns: firm_id, user_id, action, entity_type, entity_id,
    //   path, old_value, new_value, description, created_at
    // Note: metadata and timestamp columns do NOT exist.
    if (seedUserId) {
      await db.from('audit_log').insert({
        firm_id: firmId,
        user_id: seedUserId,
        action: 'create',
        entity_type: 'firm',
        entity_id: firmId,
        description: 'Initial firm seed',
        created_at: now,
      });
      // Audit log errors are non-fatal — log but continue
    }

    return {
      success: true,
      firmId,
      entityCount: entityDefs.length,
      formulaCount,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, firmId, entityCount: 0, formulaCount: 0, error: message };
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const firmId = process.env['FIRM_ID'];
  const firmName = process.env['FIRM_NAME'] ?? '';

  if (!firmId) {
    console.error('Error: FIRM_ID environment variable is required');
    process.exit(1);
  }

  console.log(`Seeding firm ${firmId} (${firmName || 'unnamed'})...`);

  const result = await seedFirm({ firmId, firmName });

  if (result.success) {
    console.log(
      `✓ Seeded ${result.entityCount} entity definitions and ${result.formulaCount} formula/snippet definitions`,
    );
  } else {
    console.error(`✗ Seed failed: ${result.error}`);
    process.exit(1);
  }
}

// Run only when executed directly (not when imported)
if (process.argv[1] && process.argv[1].endsWith('seed-firm.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
