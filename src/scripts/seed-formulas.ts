/**
 * seed-formulas.ts
 *
 * Seeds the formula_registry Supabase table with all built-in formula and
 * snippet definitions. Safe to re-run — upserts on (firm_id, formula_id).
 */

import { getServerClient } from '../server/lib/supabase.js';
import { getBuiltInFormulaDefinitions } from '../shared/formulas/built-in-formulas.js';
import { getBuiltInSnippetDefinitions } from '../shared/formulas/built-in-snippets.js';

/**
 * Seeds built-in formulas and snippets into the formula_registry table.
 * Pass `firmId` to seed for a specific firm, or leave undefined to seed
 * the global built-in definitions (firmId = null).
 */
export async function seedFormulas(firmId: string | null = null): Promise<void> {
  const db = getServerClient();
  const now = new Date().toISOString();

  const formulas = getBuiltInFormulaDefinitions();
  const snippets = getBuiltInSnippetDefinitions();

  // Map formula definitions to table columns
  const formulaRows = formulas.map((f) => ({
    firm_id: firmId,
    formula_id: f.formulaId,
    name: f.name,
    description: f.description,
    category: f.category,
    formula_type: f.formulaType,
    entity_type: f.entityType,
    result_type: f.resultType,
    definition: f.definition,
    active_variant: f.activeVariant,
    variants: f.variants,
    modifiers: f.modifiers,
    depends_on: f.dependsOn,
    display_config: f.displayConfig,
    is_active: true,
    created_at: now,
    updated_at: now,
  }));

  // Map snippet definitions to table columns (formula_type = 'snippet')
  // BuiltInSnippetDefinition has no category field — default to 'snippet'.
  const snippetRows = snippets.map((s) => ({
    firm_id: firmId,
    formula_id: s.snippetId,
    name: s.name,
    description: s.description,
    category: 'snippet',
    formula_type: 'snippet' as const,
    entity_type: s.entityType,
    result_type: s.resultType,
    definition: s.definition,
    active_variant: null,
    variants: null,
    modifiers: [],
    depends_on: s.dependsOn,
    display_config: {},
    is_active: true,
    created_at: now,
    updated_at: now,
  }));

  const allRows = [...formulaRows, ...snippetRows];

  const { error } = await db
    .from('formula_registry')
    .upsert(allRows, { onConflict: 'firm_id,formula_id' });

  if (error) {
    throw new Error(`formula_registry seed failed: ${error.message}`);
  }

  console.log(
    `[seed-formulas] Upserted ${formulas.length} formulas and ${snippets.length} snippets ` +
    `(firmId=${firmId ?? 'null'}).`,
  );
}
