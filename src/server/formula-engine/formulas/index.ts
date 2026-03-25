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
import {
  realisationRate,
  effectiveHourlyRate,
  revenuePerFeeEarner,
  billingVelocity,
} from './revenue.js';
import {
  wipAge,
  writeOffAnalysis,
  disbursementRecovery,
  lockUpDays,
} from './wip-leakage.js';
import {
  matterProfitability,
  feeEarnerProfitability,
  departmentProfitability,
  clientProfitability,
  firmProfitability,
} from './profitability.js';

/**
 * Register all built-in formula implementations with the engine.
 * Safe to call multiple times — each call replaces existing registrations.
 */
export function registerAllBuiltInFormulas(engine: FormulaEngine): void {
  // Utilisation & Time (1C-02)
  engine.registerFormula('F-TU-01', chargeableUtilisationRate);
  engine.registerFormula('F-TU-02', recordingConsistency);
  engine.registerFormula('F-TU-03', nonChargeableBreakdown);

  // Revenue & Billing (1C-03)
  engine.registerFormula('F-RB-01', realisationRate);
  engine.registerFormula('F-RB-02', effectiveHourlyRate);
  engine.registerFormula('F-RB-03', revenuePerFeeEarner);
  engine.registerFormula('F-RB-04', billingVelocity);

  // WIP & Leakage (1C-04)
  engine.registerFormula('F-WL-01', wipAge);
  engine.registerFormula('F-WL-02', writeOffAnalysis);
  engine.registerFormula('F-WL-03', disbursementRecovery);
  engine.registerFormula('F-WL-04', lockUpDays);

  // Profitability (1C-05)
  engine.registerFormula('F-PR-01', matterProfitability);
  engine.registerFormula('F-PR-02', feeEarnerProfitability);
  engine.registerFormula('F-PR-03', departmentProfitability);
  engine.registerFormula('F-PR-04', clientProfitability);
  engine.registerFormula('F-PR-05', firmProfitability);
}
