/**
 * config-validators.ts
 *
 * Zod schemas for validating all firm configuration structures.
 * These validators are used by the config service for incoming writes
 * and for the import flow.
 */

import { z } from 'zod';
import {
  EntityType,
  FieldType,
  FormulaType,
  MissingBehaviour,
  RagStatus,
  RelationshipType,
} from '../types/index.js';

// =============================================================================
// Primitives
// =============================================================================

const positiveNumber = z.number().nonnegative('Must be a non-negative number');
const percent = z.number().min(0, 'Must be ≥ 0').max(100, 'Must be ≤ 100');
const proportion = z.number().min(0, 'Must be ≥ 0').max(1, 'Must be ≤ 1');

// =============================================================================
// Working Time Defaults
// =============================================================================

export const WorkingTimeDefaultsSchema = z.object({
  workingDaysPerWeek: z
    .number()
    .int('Must be a whole number')
    .min(1, 'Must be at least 1 day')
    .max(7, 'Cannot exceed 7 days'),
  dailyTargetHours: z
    .number()
    .min(0, 'Must be ≥ 0')
    .max(24, 'Cannot exceed 24 hours'),
  weeklyTargetHours: z
    .number()
    .min(0, 'Must be ≥ 0')
    .max(168, 'Cannot exceed 168 hours (7 × 24)'),
  chargeableWeeklyTarget: z
    .number()
    .min(0, 'Must be ≥ 0')
    .max(168, 'Cannot exceed 168 hours'),
  annualLeaveEntitlement: z
    .number()
    .int('Must be a whole number')
    .min(0, 'Must be ≥ 0')
    .max(365, 'Cannot exceed 365 days'),
  bankHolidaysPerYear: z
    .number()
    .int('Must be a whole number')
    .min(0, 'Must be ≥ 0')
    .max(30, 'Unusually high — check value'),
});

export type WorkingTimeDefaults = z.infer<typeof WorkingTimeDefaultsSchema>;

// =============================================================================
// Salaried Config
// =============================================================================

export const SalariedConfigSchema = z.object({
  annualSalary: positiveNumber.optional(),
  monthlySalary: positiveNumber.optional(),
  monthlyVariablePay: positiveNumber.optional(),
  monthlyPension: positiveNumber.optional(),
  monthlyEmployerNI: positiveNumber.optional(),
  annualTarget: positiveNumber.optional(),
  costRateMethod: z
    .enum(['fully_loaded', 'direct', 'market_rate'], {
      errorMap: () => ({ message: 'Must be one of: fully_loaded, direct, market_rate' }),
    })
    .optional(),
});

export type SalariedConfig = z.infer<typeof SalariedConfigSchema>;

// =============================================================================
// Fee Share Config
// =============================================================================

export const FeeShareConfigSchema = z
  .object({
    feeSharePercent: percent.optional().describe('Percentage retained by the fee earner (0–100)'),
    firmRetainPercent: percent.optional().describe('Percentage retained by the firm (0–100)'),
    defaultFeeSharePercent: percent.optional(),
    defaultFirmRetainPercent: percent.optional(),
  })
  .refine(
    (data) => {
      // If both are supplied, they should sum to 100
      if (
        data.feeSharePercent !== undefined &&
        data.firmRetainPercent !== undefined
      ) {
        return Math.abs(data.feeSharePercent + data.firmRetainPercent - 100) < 0.01;
      }
      return true;
    },
    { message: 'feeSharePercent and firmRetainPercent must sum to 100' },
  );

export type FeeShareConfig = z.infer<typeof FeeShareConfigSchema>;

// =============================================================================
// RAG Band — a single green/amber/red boundary
// =============================================================================

export const RagBandSchema = z
  .object({
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .refine(
    (band) => {
      if (band.min !== undefined && band.max !== undefined) {
        return band.min < band.max;
      }
      return true;
    },
    { message: 'Band min must be strictly less than max' },
  );

export type RagBand = z.infer<typeof RagBandSchema>;

// =============================================================================
// RAG Threshold — per-metric defaults (green + amber + red)
// Validates logical consistency: green must be "better" than red
// =============================================================================

const RagBandsShape = z.object({
  [RagStatus.GREEN]: RagBandSchema,
  [RagStatus.AMBER]: RagBandSchema,
  [RagStatus.RED]: RagBandSchema,
});

export const RagThresholdDefaultsSchema = z
  .object({
    defaults: RagBandsShape,
    higherIsBetter: z.boolean(),
  })
  .superRefine((data, ctx) => {
    const { defaults, higherIsBetter } = data;

    if (higherIsBetter) {
      // Green is best → green.min should be the highest boundary
      // Impossible: green.min < red.max  (green threshold is lower than red)
      const greenMin = defaults[RagStatus.GREEN].min;
      const redMax = defaults[RagStatus.RED].max;

      if (greenMin !== undefined && redMax !== undefined && greenMin <= redMax) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `For higher-is-better metrics, green threshold (${greenMin}) must be ` +
            `greater than red threshold (${redMax})`,
          path: ['defaults', RagStatus.GREEN, 'min'],
        });
      }

      // Amber should bridge green and red
      const amberMin = defaults[RagStatus.AMBER].min;
      const amberMax = defaults[RagStatus.AMBER].max;

      if (greenMin !== undefined && amberMax !== undefined && amberMax > greenMin) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Amber upper boundary (${amberMax}) must not exceed green threshold (${greenMin})`,
          path: ['defaults', RagStatus.AMBER, 'max'],
        });
      }

      if (redMax !== undefined && amberMin !== undefined && amberMin < redMax) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Amber lower boundary (${amberMin}) must not be below red threshold (${redMax})`,
          path: ['defaults', RagStatus.AMBER, 'min'],
        });
      }
    } else {
      // Lower is best → green.max should be the lowest boundary
      // Impossible: green.max > red.min  (green threshold is higher than red)
      const greenMax = defaults[RagStatus.GREEN].max;
      const redMin = defaults[RagStatus.RED].min;

      if (greenMax !== undefined && redMin !== undefined && greenMax >= redMin) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `For lower-is-better metrics, green threshold (${greenMax}) must be ` +
            `less than red threshold (${redMin})`,
          path: ['defaults', RagStatus.GREEN, 'max'],
        });
      }

      // Amber should bridge
      const amberMin = defaults[RagStatus.AMBER].min;
      const amberMax = defaults[RagStatus.AMBER].max;

      if (greenMax !== undefined && amberMin !== undefined && amberMin < greenMax) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Amber lower boundary (${amberMin}) must not be below green threshold (${greenMax})`,
          path: ['defaults', RagStatus.AMBER, 'min'],
        });
      }

      if (redMin !== undefined && amberMax !== undefined && amberMax > redMin) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Amber upper boundary (${amberMax}) must not exceed red threshold (${redMin})`,
          path: ['defaults', RagStatus.AMBER, 'max'],
        });
      }
    }
  });

// Full RagThresholdSet validator (includes metricKey, label, overrides)
export const RagThresholdSetSchema = z.object({
  metricKey: z.string().min(1, 'metricKey is required'),
  label: z.string().min(1, 'label is required'),
  higherIsBetter: z.boolean(),
  defaults: RagBandsShape,
  overrides: z.record(RagBandsShape).optional(),
});

export type RagThresholdSet = z.infer<typeof RagThresholdSetSchema>;

// =============================================================================
// Fee Earner Override
// =============================================================================

export const FeeEarnerOverrideSchema = z.object({
  id: z.string().min(1),
  firmId: z.string().min(1),
  feeEarnerId: z.string().min(1),
  field: z.string().min(1, 'field key is required'),
  value: z.unknown(),
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}/, 'effectiveFrom must be an ISO date string (YYYY-MM-DD)'),
  effectiveTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}/, 'effectiveTo must be an ISO date string')
    .optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type FeeEarnerOverride = z.infer<typeof FeeEarnerOverrideSchema>;

// =============================================================================
// Complete Firm Config
// =============================================================================

const FieldDefinitionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.nativeEnum(FieldType),
  required: z.boolean(),
  builtIn: z.boolean(),
  missingBehaviour: z.nativeEnum(MissingBehaviour),
  enablesFeatures: z.array(z.string()).optional(),
  defaultValue: z.unknown().optional(),
  options: z.array(z.string()).optional(),
  referencesEntity: z.nativeEnum(EntityType).optional(),
  description: z.string().optional(),
});

const RelationshipDefinitionSchema = z.object({
  key: z.string().min(1),
  type: z.nativeEnum(RelationshipType),
  targetEntity: z.nativeEnum(EntityType),
  localKey: z.string().min(1),
  foreignKey: z.string().min(1),
  label: z.string().optional(),
});

const EntityDefinitionSchema = z.object({
  entityType: z.nativeEnum(EntityType),
  label: z.string().min(1),
  labelPlural: z.string().min(1),
  icon: z.string().optional(),
  description: z.string().optional(),
  isBuiltIn: z.boolean().optional(),
  dataSource: z.string().optional(),
  fields: z.array(FieldDefinitionSchema),
  relationships: z.array(RelationshipDefinitionSchema),
  primaryKey: z.string().min(1),
  displayField: z.string().min(1),
  supportsCustomFields: z.boolean(),
});

const FormulaVariantSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  expression: z.string(),
  modifiers: z
    .array(
      z.object({
        target: z.string(),
        operation: z.enum(['equals', 'notEquals', 'greaterThan', 'lessThan']),
        value: z.unknown(),
        sourceField: z.string(),
      }),
    )
    .optional(),
  dependencies: z.array(z.string()),
});

const FormulaDefinitionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  type: z.nativeEnum(FormulaType),
  outputType: z.nativeEnum(FieldType),
  appliesTo: z.array(z.nativeEnum(EntityType)),
  variants: z.array(FormulaVariantSchema),
});

const SnippetDefinitionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  expression: z.string(),
  dependencies: z.array(z.string()),
  outputType: z.nativeEnum(FieldType),
  createdBy: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

const ColumnMappingSchema = z.object({
  sourceColumn: z.string().min(1),
  targetField: z.string().min(1),
  transform: z.string().optional(),
});

const ColumnMappingTemplateSchema = z.object({
  id: z.string().min(1),
  firmId: z.string().min(1),
  entityType: z.nativeEnum(EntityType),
  label: z.string().min(1),
  source: z.string().optional(),
  mappings: z.array(ColumnMappingSchema),
  isDefault: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

const CustomFieldDefinitionSchema = z.object({
  id: z.string().min(1),
  firmId: z.string().min(1),
  entityType: z.nativeEnum(EntityType),
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.nativeEnum(FieldType),
  required: z.boolean(),
  missingBehaviour: z.nativeEnum(MissingBehaviour),
  options: z.array(z.string()).optional(),
  defaultValue: z.unknown().optional(),
  enablesFeatures: z.array(z.string()).optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const FirmConfigSchema = z.object({
  // Tier 1
  firmId: z.string().min(1),
  firmName: z.string(),
  jurisdiction: z.string(),
  currency: z.string().length(3, 'Currency must be a 3-letter ISO code'),
  financialYearStartMonth: z.number().int().min(1).max(12),
  weekStartDay: z.union([z.literal(0), z.literal(1)]),
  timezone: z.string(),
  workingDaysPerWeek: z.number().optional(),
  dailyTargetHours: z.number().optional(),
  weeklyTargetHours: z.number().optional(),
  chargeableWeeklyTarget: z.number().optional(),
  annualLeaveEntitlement: z.number().optional(),
  bankHolidaysPerYear: z.number().optional(),
  costRateMethod: z.enum(['fully_loaded', 'direct', 'market_rate']).optional(),
  defaultFeeSharePercent: z.number().optional(),
  defaultFirmRetainPercent: z.number().optional(),
  utilisationApproach: z.enum(['assume_fulltime', 'fte_adjusted']).optional(),
  fteCountMethod: z.enum(['full', 'prorated']).optional(),
  revenueAttribution: z.enum(['responsible_lawyer', 'billing_lawyer', 'supervisor']).optional(),
  showLawyerPerspective: z.boolean().optional(),
  showDiscrepancies: z.boolean().optional(),

  // Tier 2
  entityDefinitions: z.record(z.nativeEnum(EntityType), EntityDefinitionSchema).optional().default({}),
  columnMappingTemplates: z.array(ColumnMappingTemplateSchema).default([]),
  customFields: z.array(CustomFieldDefinitionSchema).default([]),
  ragThresholds: z.array(RagThresholdSetSchema).default([]),

  // Tier 3
  formulas: z.array(FormulaDefinitionSchema).default([]),
  snippets: z.array(SnippetDefinitionSchema).default([]),
  feeEarnerOverrides: z.array(FeeEarnerOverrideSchema).default([]),

  schemaVersion: z.number().int().nonnegative(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type ValidatedFirmConfig = z.infer<typeof FirmConfigSchema>;

// =============================================================================
// Exported Config (for import/export round-trip)
// =============================================================================

const ExportMetadataSchema = z.object({
  exportDate: z.string(),
  exportedBy: z.string().optional(),
  yaomindVersion: z.string(),
  firmId: z.string(),
  firmName: z.string().optional(),
});

const EntityRegistryRowSchema = z.object({
  entity_type: z.string(),
  definition: z.unknown(),
  is_built_in: z.boolean(),
});

const FormulaRegistryRowSchema = z.object({
  formula_id: z.string(),
  definition: z.unknown(),
  is_built_in: z.boolean(),
});

export const ExportedConfigSchema = z.object({
  metadata: ExportMetadataSchema,
  firmConfig: z.record(z.unknown()),
  entityRegistry: z.array(EntityRegistryRowSchema),
  customFields: z.array(z.unknown()),
  formulaRegistry: z.array(FormulaRegistryRowSchema),
  feeEarnerOverrides: z.array(z.unknown()),
  columnMappingTemplates: z.array(z.unknown()),
});

export type ExportedConfig = z.infer<typeof ExportedConfigSchema>;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Validates a RagThresholdSet's logical consistency (green better than red).
 * Returns an array of human-readable error messages, empty if valid.
 */
export function validateRagThresholdConsistency(threshold: {
  metricKey: string;
  defaults: Record<string, { min?: number; max?: number }>;
  higherIsBetter: boolean;
}): string[] {
  const result = RagThresholdDefaultsSchema.safeParse({
    defaults: threshold.defaults,
    higherIsBetter: threshold.higherIsBetter,
  });

  if (result.success) return [];

  return result.error.issues.map((issue) => `${threshold.metricKey}: ${issue.message}`);
}

/**
 * Collects warnings for any top-level keys in `input` not present in the
 * ExportedConfigSchema shape. Used during import.
 */
export function collectImportWarnings(input: Record<string, unknown>): string[] {
  const knownKeys = new Set(Object.keys(ExportedConfigSchema.shape));
  const warnings: string[] = [];

  for (const key of Object.keys(input)) {
    if (!knownKeys.has(key)) {
      warnings.push(`Unknown field "${key}" was ignored during import`);
    }
  }

  // Check for unknown keys inside firmConfig
  const firmConfig = input['firmConfig'];
  if (firmConfig && typeof firmConfig === 'object' && !Array.isArray(firmConfig)) {
    const knownFirmConfigKeys = new Set(Object.keys(FirmConfigSchema.shape));
    for (const key of Object.keys(firmConfig as Record<string, unknown>)) {
      if (!knownFirmConfigKeys.has(key)) {
        warnings.push(`Unknown firmConfig field "${key}" was ignored during import`);
      }
    }
  }

  return warnings;
}
