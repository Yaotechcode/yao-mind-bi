/**
 * seed-firm.ts
 *
 * Seeds a new firm's initial data in Supabase and MongoDB:
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
    const entityDefs = getBuiltInEntityDefinitions();

    const entityRows = entityDefs.map((def) => ({
      firm_id: firmId,
      entity_type: def.entityType,
      definition: def,
      is_built_in: true,
      created_at: now,
      updated_at: now,
    }));

    const { error: entityError } = await db
      .from('entity_registry')
      .upsert(entityRows, { onConflict: 'firm_id,entity_type' });

    if (entityError) {
      throw new Error(`entity_registry seed failed: ${entityError.message}`);
    }

    // 2. Seed firm_config
    const defaultConfig = getDefaultFirmConfig(firmId, firmName);

    const { error: configError } = await db
      .from('firm_config')
      .upsert(
        {
          firm_id: firmId,
          config: defaultConfig,
          schema_version: defaultConfig.schemaVersion,
          created_at: now,
          updated_at: now,
        },
        { onConflict: 'firm_id' },
      );

    if (configError) {
      throw new Error(`firm_config seed failed: ${configError.message}`);
    }

    // 3. Seed formula_registry (23 formulas + 5 snippets via MongoDB)
    await seedFormulas(firmId);

    const formulaCount =
      getBuiltInFormulaDefinitions().length + getBuiltInSnippetDefinitions().length;

    // 4. Write audit log entry
    if (seedUserId) {
      await db.from('audit_log').insert({
        firm_id: firmId,
        user_id: seedUserId,
        action: 'create',
        entity_type: 'firm',
        entity_id: firmId,
        metadata: {
          seedType: 'initial_firm_seed',
          entityCount: entityDefs.length,
          formulaCount,
        },
        timestamp: now,
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
