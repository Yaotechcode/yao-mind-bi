/**
 * index.ts — Built-in formula registration
 *
 * Registers all built-in formula implementations with the FormulaEngine.
 * Called once during initialisation before any formula execution.
 *
 * Subsequent prompts (1C-03 … 1C-06) add further registrations here.
 */

import type { FormulaEngine } from '../engine.js';
import {
  chargeableUtilisationRate,
  recordingConsistency,
  nonChargeableBreakdown,
} from './utilisation.js';

/**
 * Register all built-in formula implementations with the engine.
 * Safe to call multiple times — each call replaces existing registrations.
 */
export function registerAllBuiltInFormulas(engine: FormulaEngine): void {
  // Utilisation & Time (1C-02)
  engine.registerFormula('F-TU-01', chargeableUtilisationRate);
  engine.registerFormula('F-TU-02', recordingConsistency);
  engine.registerFormula('F-TU-03', nonChargeableBreakdown);
}
