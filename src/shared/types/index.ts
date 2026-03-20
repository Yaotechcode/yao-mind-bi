import { z } from 'zod';

// =============================================================================
// Enums
// =============================================================================

export enum EntityType {
  FEE_EARNER = 'feeEarner',
  MATTER = 'matter',
  TIME_ENTRY = 'timeEntry',
  INVOICE = 'invoice',
  CLIENT = 'client',
  DISBURSEMENT = 'disbursement',
  DEPARTMENT = 'department',
  TASK = 'task',
  FIRM = 'firm',
}

export enum PayModel {
  SALARIED = 'Salaried',
  FEE_SHARE = 'FeeShare',
}

export enum RagStatus {
  GREEN = 'green',
  AMBER = 'amber',
  RED = 'red',
  NEUTRAL = 'neutral',
}

export enum FormulaType {
  BUILT_IN = 'built_in',
  CUSTOM = 'custom',
  SNIPPET = 'snippet',
}

export enum FieldType {
  STRING = 'string',
  NUMBER = 'number',
  CURRENCY = 'currency',
  PERCENTAGE = 'percentage',
  DATE = 'date',
  BOOLEAN = 'boolean',
  SELECT = 'select',
  REFERENCE = 'reference',
}

export enum MissingBehaviour {
  EXCLUDE_FROM_ANALYSIS = 'exclude_from_analysis',
  HIDE_COLUMN = 'hide_column',
  USE_DEFAULT = 'use_default',
}

export enum RelationshipType {
  HAS_MANY = 'hasMany',
  BELONGS_TO = 'belongsTo',
  HAS_ONE = 'hasOne',
}

export enum AuditAction {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  IMPORT = 'import',
  EXPORT = 'export',
}

// =============================================================================
// Field & Relationship Definitions
// =============================================================================

export interface FieldDefinition {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  builtIn: boolean;
  missingBehaviour: MissingBehaviour;
  /** Feature flags this field enables when present (e.g. 'burnRate', 'budgetTracking') */
  enablesFeatures?: string[];
  defaultValue?: unknown;
  /** For FieldType.SELECT — allowed values */
  options?: string[];
  /** For FieldType.REFERENCE — target entity type */
  referencesEntity?: EntityType;
  description?: string;
}

export interface RelationshipDefinition {
  key: string;
  type: RelationshipType;
  targetEntity: EntityType;
  /** Field on this entity used to join */
  localKey: string;
  /** Field on the target entity used to join */
  foreignKey: string;
  label?: string;
}

// =============================================================================
// Entity Registry
// =============================================================================

export interface EntityDefinition {
  entityType: EntityType;
  label: string;
  labelPlural: string;
  fields: FieldDefinition[];
  relationships: RelationshipDefinition[];
  /** Primary identifier field key */
  primaryKey: string;
  /** Human-readable display name field key */
  displayField: string;
  /** Whether this entity supports custom fields */
  supportsCustomFields: boolean;
}

// =============================================================================
// Formula Registry
// =============================================================================

export interface FormulaModifier {
  /** Field whose value gates this modifier (e.g. 'payModel') */
  target: string;
  /** 'equals' | 'notEquals' | 'greaterThan' | 'lessThan' */
  operation: 'equals' | 'notEquals' | 'greaterThan' | 'lessThan';
  /** Comparison value */
  value: unknown;
  /** Field to substitute when condition matches */
  sourceField: string;
}

export interface FormulaVariant {
  id: string;
  label: string;
  /** zod-parseable expression or function reference */
  expression: string;
  modifiers?: FormulaModifier[];
  /** Field keys this variant depends on */
  dependencies: string[];
}

export interface FormulaDefinition {
  id: string;
  label: string;
  description: string;
  type: FormulaType;
  outputType: FieldType;
  /** Applicable entity type(s) */
  appliesTo: EntityType[];
  variants: FormulaVariant[];
}

export interface SnippetDefinition {
  id: string;
  label: string;
  description: string;
  /** The raw expression string */
  expression: string;
  /** Field keys referenced */
  dependencies: string[];
  outputType: FieldType;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// RAG Thresholds
// =============================================================================

export interface RagGradeThreshold {
  /** Lower bound (inclusive). Omit for open lower end. */
  min?: number;
  /** Upper bound (exclusive). Omit for open upper end. */
  max?: number;
}

export interface RagThresholdSet {
  metricKey: string;
  label: string;
  /** Default thresholds applied to all entities */
  defaults: Record<RagStatus.GREEN | RagStatus.AMBER | RagStatus.RED, RagGradeThreshold>;
  /** Per-entity overrides keyed by entityId */
  overrides?: Record<string, Record<RagStatus.GREEN | RagStatus.AMBER | RagStatus.RED, RagGradeThreshold>>;
  /** Whether higher values are better (default true) */
  higherIsBetter: boolean;
}

// =============================================================================
// Custom Fields
// =============================================================================

export interface CustomFieldDefinition {
  id: string;
  firmId: string;
  entityType: EntityType;
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  missingBehaviour: MissingBehaviour;
  options?: string[];
  defaultValue?: unknown;
  enablesFeatures?: string[];
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// Column Mapping
// =============================================================================

export interface ColumnMapping {
  /** Source column name as it appears in the uploaded file */
  sourceColumn: string;
  /** Target field key in our schema */
  targetField: string;
  /** Transformation hint (e.g. 'parseCurrency', 'parseDate') */
  transform?: string;
}

export interface ColumnMappingTemplate {
  id: string;
  firmId: string;
  entityType: EntityType;
  label: string;
  /** Detected source (e.g. 'metabase', 'clio', 'leap') */
  source?: string;
  mappings: ColumnMapping[];
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// Fee Earner
// =============================================================================

export interface FeeEarnerOverride {
  id: string;
  firmId: string;
  feeEarnerId: string;
  /** Field key being overridden */
  field: string;
  /** Overridden value */
  value: unknown;
  /** ISO date string: when override becomes effective */
  effectiveFrom: string;
  /** ISO date string: when override expires. Omit for indefinite. */
  effectiveTo?: string;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// Firm Configuration (three tiers)
// =============================================================================

export interface FirmConfigTier1 {
  /** Core identity */
  firmId: string;
  firmName: string;
  jurisdiction: string;
  currency: string;
  financialYearStartMonth: number; // 1–12
  weekStartDay: 0 | 1; // 0 = Sunday, 1 = Monday
  timezone: string;
}

export interface FirmConfigTier2 {
  /** Data & schema */
  entityDefinitions: Partial<Record<EntityType, EntityDefinition>>;
  columnMappingTemplates: ColumnMappingTemplate[];
  customFields: CustomFieldDefinition[];
  ragThresholds: RagThresholdSet[];
}

export interface FirmConfigTier3 {
  /** Formulas & advanced */
  formulas: FormulaDefinition[];
  snippets: SnippetDefinition[];
  feeEarnerOverrides: FeeEarnerOverride[];
}

export interface FirmConfig extends FirmConfigTier1, FirmConfigTier2, FirmConfigTier3 {
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// Audit Log
// =============================================================================

export interface AuditLogEntry {
  id: string;
  firmId: string;
  userId?: string;
  action: AuditAction;
  entityType: EntityType;
  entityId: string;
  /** JSON patch of changes */
  diff?: Record<string, { before: unknown; after: unknown }>;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

// =============================================================================
// Data Quality
// =============================================================================

export interface DataQualityIssue {
  entityType: EntityType;
  entityId: string;
  fieldKey: string;
  issue: 'missing_required' | 'invalid_type' | 'out_of_range' | 'duplicate' | 'reference_broken';
  severity: 'error' | 'warning' | 'info';
  detail?: string;
}

export interface DataQualityReport {
  firmId: string;
  generatedAt: Date;
  totalEntities: number;
  issueCount: number;
  issues: DataQualityIssue[];
  /** Percentage of entities with no issues */
  qualityScore: number;
}

// =============================================================================
// Zod Schemas (runtime validation for key types)
// =============================================================================

export const FieldDefinitionSchema = z.object({
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

export const ColumnMappingSchema = z.object({
  sourceColumn: z.string().min(1),
  targetField: z.string().min(1),
  transform: z.string().optional(),
});

export const ColumnMappingTemplateSchema = z.object({
  id: z.string().uuid(),
  firmId: z.string().min(1),
  entityType: z.nativeEnum(EntityType),
  label: z.string().min(1),
  source: z.string().optional(),
  mappings: z.array(ColumnMappingSchema),
  isDefault: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const FirmConfigTier1Schema = z.object({
  firmId: z.string().min(1),
  firmName: z.string().min(1),
  jurisdiction: z.string().min(1),
  currency: z.string().length(3),
  financialYearStartMonth: z.number().int().min(1).max(12),
  weekStartDay: z.union([z.literal(0), z.literal(1)]),
  timezone: z.string().min(1),
});

export const RagGradeThresholdSchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
});

export const RagThresholdSetSchema = z.object({
  metricKey: z.string().min(1),
  label: z.string().min(1),
  defaults: z.object({
    [RagStatus.GREEN]: RagGradeThresholdSchema,
    [RagStatus.AMBER]: RagGradeThresholdSchema,
    [RagStatus.RED]: RagGradeThresholdSchema,
  }),
  overrides: z.record(z.object({
    [RagStatus.GREEN]: RagGradeThresholdSchema,
    [RagStatus.AMBER]: RagGradeThresholdSchema,
    [RagStatus.RED]: RagGradeThresholdSchema,
  })).optional(),
  higherIsBetter: z.boolean(),
});

export const AuditLogEntrySchema = z.object({
  id: z.string().uuid(),
  firmId: z.string().min(1),
  userId: z.string().optional(),
  action: z.nativeEnum(AuditAction),
  entityType: z.nativeEnum(EntityType),
  entityId: z.string().min(1),
  diff: z.record(z.object({ before: z.unknown(), after: z.unknown() })).optional(),
  metadata: z.record(z.unknown()).optional(),
  timestamp: z.coerce.date(),
});

export const DataQualityIssueSchema = z.object({
  entityType: z.nativeEnum(EntityType),
  entityId: z.string().min(1),
  fieldKey: z.string().min(1),
  issue: z.enum(['missing_required', 'invalid_type', 'out_of_range', 'duplicate', 'reference_broken']),
  severity: z.enum(['error', 'warning', 'info']),
  detail: z.string().optional(),
});

export const DataQualityReportSchema = z.object({
  firmId: z.string().min(1),
  generatedAt: z.coerce.date(),
  totalEntities: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
  issues: z.array(DataQualityIssueSchema),
  qualityScore: z.number().min(0).max(100),
});
