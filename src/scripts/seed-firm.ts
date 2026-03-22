/**
 * seed-firm.ts
 *
 * Seeds a new firm's initial data in Supabase:
 *   1. entity_registry  — all 9 built-in entity definitions
 *   2. firm_config      — default configuration (all 3 tiers)
 *   3. formula_registry — placeholder formula definitions (full impl in 1A-06)
 *
 * Usage:
 *   FIRM_ID=<uuid> FIRM_NAME="My Law Firm" npx tsx src/scripts/seed-firm.ts
 *
 * Or call seedFirm() programmatically from the create_firm_with_owner flow.
 */

import { getServerClient } from '../server/lib/supabase.js';
import { getBuiltInEntityDefinitions } from '../shared/entities/registry.js';
import { getDefaultFirmConfig } from '../shared/entities/defaults.js';
import {
  EntityType,
  FieldType,
  FormulaDefinition,
  FormulaType,
} from '../shared/types/index.js';

// ---------------------------------------------------------------------------
// Placeholder formula definitions (stubs — full impl in prompt 1A-06)
// ---------------------------------------------------------------------------

const PLACEHOLDER_FORMULAS: FormulaDefinition[] = [
  {
    id: 'SN-001',
    label: 'Utilisation Rate',
    description: 'Chargeable hours as a percentage of available working hours',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.PERCENTAGE,
    appliesTo: [EntityType.FEE_EARNER],
    variants: [],
  },
  {
    id: 'SN-002',
    label: 'Realisation Rate',
    description: 'Billed value as a percentage of recorded billable value',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.PERCENTAGE,
    appliesTo: [EntityType.FEE_EARNER, EntityType.MATTER],
    variants: [],
  },
  {
    id: 'SN-003',
    label: 'Write-Off Rate',
    description: 'Written-off value as a percentage of total billable value',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.PERCENTAGE,
    appliesTo: [EntityType.FEE_EARNER, EntityType.MATTER, EntityType.DEPARTMENT],
    variants: [],
  },
  {
    id: 'SN-004',
    label: 'WIP Age',
    description: 'Average age in days of unbilled work in progress',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.NUMBER,
    appliesTo: [EntityType.FEE_EARNER, EntityType.MATTER, EntityType.DEPARTMENT],
    variants: [],
  },
  {
    id: 'SN-005',
    label: 'Cost Rate',
    description: 'Cost per hour — branches on pay model (salaried vs fee share)',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.CURRENCY,
    appliesTo: [EntityType.FEE_EARNER],
    variants: [],
  },
  {
    id: 'SN-006',
    label: 'Debtor Days',
    description: 'Average days invoices remain unpaid',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.NUMBER,
    appliesTo: [EntityType.FEE_EARNER, EntityType.CLIENT, EntityType.FIRM],
    variants: [],
  },
  {
    id: 'SN-007',
    label: 'Lock-Up Days',
    description: 'Combined WIP age + debtor days',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.NUMBER,
    appliesTo: [EntityType.FEE_EARNER, EntityType.DEPARTMENT, EntityType.FIRM],
    variants: [],
  },
  {
    id: 'SN-008',
    label: 'Budget Burn Rate',
    description: 'Current WIP as a percentage of matter budget',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.PERCENTAGE,
    appliesTo: [EntityType.MATTER],
    variants: [],
  },
  {
    id: 'SN-009',
    label: 'Matter Margin',
    description: 'Net margin on a matter after costs',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.PERCENTAGE,
    appliesTo: [EntityType.MATTER],
    variants: [],
  },
  {
    id: 'SN-010',
    label: 'Revenue Multiple',
    description: 'Billed revenue as a multiple of fee earner cost',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.NUMBER,
    appliesTo: [EntityType.FEE_EARNER],
    variants: [],
  },
  {
    id: 'SN-011',
    label: 'Effective Rate',
    description: 'Actual achieved rate (billed value ÷ hours worked)',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.CURRENCY,
    appliesTo: [EntityType.FEE_EARNER, EntityType.MATTER],
    variants: [],
  },
  {
    id: 'SN-012',
    label: 'Disbursement Recovery Rate',
    description: 'Recovered disbursements as a percentage of total incurred',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.PERCENTAGE,
    appliesTo: [EntityType.MATTER, EntityType.CLIENT, EntityType.FIRM],
    variants: [],
  },
  {
    id: 'SN-013',
    label: 'Non-Chargeable Time Percent',
    description: 'Non-chargeable hours as a percentage of total recorded hours',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.PERCENTAGE,
    appliesTo: [EntityType.FEE_EARNER, EntityType.DEPARTMENT],
    variants: [],
  },
  {
    id: 'SN-014',
    label: 'Recording Gap',
    description: 'Days since the fee earner last recorded time',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.NUMBER,
    appliesTo: [EntityType.FEE_EARNER],
    variants: [],
  },
  {
    id: 'SN-015',
    label: 'Billed Hours',
    description: 'Total chargeable hours from billing units (units ÷ 10)',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.NUMBER,
    appliesTo: [EntityType.FEE_EARNER, EntityType.MATTER],
    variants: [],
  },
  {
    id: 'SN-016',
    label: 'Recorded Hours',
    description: 'Total hours from duration_minutes (÷ 60)',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.NUMBER,
    appliesTo: [EntityType.FEE_EARNER, EntityType.MATTER],
    variants: [],
  },
  {
    id: 'SN-017',
    label: 'Target Hours',
    description: 'Expected chargeable hours for a given period based on working time config',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.NUMBER,
    appliesTo: [EntityType.FEE_EARNER],
    variants: [],
  },
  {
    id: 'SN-018',
    label: 'Fee Share Cost',
    description: 'Firm cost of a fee share earner (1 - feeSharePercent) × billed value',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.CURRENCY,
    appliesTo: [EntityType.FEE_EARNER],
    variants: [],
  },
  {
    id: 'SN-019',
    label: 'Salaried Cost Rate',
    description: 'Fully-loaded cost per billable hour for salaried earners',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.CURRENCY,
    appliesTo: [EntityType.FEE_EARNER],
    variants: [],
  },
  {
    id: 'SN-020',
    label: 'Billable Value',
    description: 'rate × (units ÷ 10) — the value of recorded billable time',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.CURRENCY,
    appliesTo: [EntityType.TIME_ENTRY],
    variants: [],
  },
  {
    id: 'SN-021',
    label: 'Is Chargeable',
    description: '(doNotBill === false) && (billable > 0)',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.BOOLEAN,
    appliesTo: [EntityType.TIME_ENTRY],
    variants: [],
  },
  {
    id: 'SN-022',
    label: 'Scorecard Score',
    description: 'Weighted composite score across utilisation, realisation, write-off, debtor days',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.NUMBER,
    appliesTo: [EntityType.FEE_EARNER],
    variants: [],
  },
  {
    id: 'SN-023',
    label: 'Overhead Allocation',
    description: 'Firm overhead allocated to a fee earner based on allocation method',
    type: FormulaType.BUILT_IN,
    outputType: FieldType.CURRENCY,
    appliesTo: [EntityType.FEE_EARNER],
    variants: [],
  },
];

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

    // 3. Seed formula_registry with placeholders
    const formulaRows = PLACEHOLDER_FORMULAS.map((f) => ({
      firm_id: firmId,
      formula_id: f.id,
      definition: f,
      is_built_in: true,
      created_at: now,
      updated_at: now,
    }));

    const { error: formulaError } = await db
      .from('formula_registry')
      .upsert(formulaRows, { onConflict: 'firm_id,formula_id' });

    if (formulaError) {
      throw new Error(`formula_registry seed failed: ${formulaError.message}`);
    }

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
          formulaCount: PLACEHOLDER_FORMULAS.length,
        },
        timestamp: now,
      });
      // Audit log errors are non-fatal — log but continue
    }

    return {
      success: true,
      firmId,
      entityCount: entityDefs.length,
      formulaCount: PLACEHOLDER_FORMULAS.length,
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
      `✓ Seeded ${result.entityCount} entity definitions and ${result.formulaCount} formula stubs`,
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
