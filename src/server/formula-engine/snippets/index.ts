/**
 * index.ts — Built-in snippet registration
 *
 * Registers all 5 built-in snippet implementations with a SnippetEngine.
 * Registration order matters: dependencies (SN-002) must be registered
 * before dependents (SN-001, SN-005) so that Map iteration order matches
 * execution order in FormulaEngine.executeSingle.
 */

import type { SnippetEngine } from './snippet-engine.js';
import {
  availableWorkingHours,
  employmentCostAnnual,
  firmRetainAmount,
  fullyLoadedCostRate,
  costRateByPayModel,
} from './built-in-snippets.js';

/**
 * Register all 5 built-in snippet implementations with the given SnippetEngine.
 * Safe to call multiple times — each call replaces existing registrations.
 *
 * Registration order (dependency first):
 *   SN-002 → SN-003 → SN-004 → SN-001 (needs SN-002) → SN-005 (needs SN-001)
 */
export function registerAllBuiltInSnippets(engine: SnippetEngine): void {
  engine.registerSnippet('SN-002', availableWorkingHours);   // no deps
  engine.registerSnippet('SN-003', firmRetainAmount);         // modifier / no-op
  engine.registerSnippet('SN-004', employmentCostAnnual);     // no deps
  engine.registerSnippet('SN-001', fullyLoadedCostRate);      // needs SN-002
  engine.registerSnippet('SN-005', costRateByPayModel);       // needs SN-001
}
