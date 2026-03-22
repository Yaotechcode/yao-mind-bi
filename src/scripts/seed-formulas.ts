/**
 * seed-formulas.ts
 *
 * Seeds the formula_registry collection with all built-in formula and snippet definitions.
 * Safe to re-run — uses upsert on formulaId / snippetId.
 */

import { getCollection } from '../server/lib/mongodb.js';
import { getBuiltInFormulaDefinitions } from '../shared/formulas/built-in-formulas.js';
import { getBuiltInSnippetDefinitions } from '../shared/formulas/built-in-snippets.js';

// =============================================================================
// Types stored in MongoDB
// =============================================================================

interface StoredFormula {
  firmId: string | null;   // null = built-in (available to all firms)
  formulaId: string;
  formulaType: 'built_in';
  [key: string]: unknown;
}

interface StoredSnippet {
  firmId: string | null;
  snippetId: string;
  snippetType: 'built_in';
  [key: string]: unknown;
}

// =============================================================================
// Seed function
// =============================================================================

/**
 * Seeds built-in formulas and snippets into the formula_registry collection.
 * Pass `firmId` to seed for a specific firm, or leave undefined to seed
 * the global built-in definitions (firmId = null).
 */
export async function seedFormulas(firmId: string | null = null): Promise<void> {
  const collection = await getCollection('formula_registry');

  const formulas = getBuiltInFormulaDefinitions();
  const snippets = getBuiltInSnippetDefinitions();

  // Upsert all formula definitions
  for (const formula of formulas) {
    const doc: StoredFormula = {
      ...formula,
      firmId,
      formulaType: 'built_in',
    };

    await collection.updateOne(
      { formulaId: formula.formulaId, firmId },
      { $set: doc },
      { upsert: true },
    );
  }

  // Upsert all snippet definitions
  for (const snippet of snippets) {
    const doc: StoredSnippet = {
      ...snippet,
      firmId,
      snippetType: 'built_in',
    };

    await collection.updateOne(
      { snippetId: snippet.snippetId, firmId },
      { $set: doc },
      { upsert: true },
    );
  }

  console.log(
    `[seed-formulas] Upserted ${formulas.length} formulas and ${snippets.length} snippets ` +
    `(firmId=${firmId ?? 'null'}).`,
  );
}
