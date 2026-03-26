// src/server/pipeline/normaliser.ts
// Stage 2: Normalise — pure functions only. No database calls.

import type { ColumnMapping, EntityDefinition, FieldDefinition } from '../../shared/types/index.js';
import { FieldType } from '../../shared/types/index.js';
import type {
  MappingSet,
  NormaliseOptions,
  NormaliseResult,
  NormalisedRecord,
  RejectedRow,
  NormaliseWarning,
  FieldStats,
} from '../../shared/types/pipeline.js';

// ---------------------------------------------------------------------------
// Type coercion helpers
// ---------------------------------------------------------------------------

function coerceString(
  value: unknown,
  _fieldDef: FieldDefinition,
  _options: NormaliseOptions,
): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === '') return null;
  return str;
}

function coerceNumber(
  value: unknown,
  _fieldDef: FieldDefinition,
  _options: NormaliseOptions,
): { result: number | null; warn: boolean } {
  if (value === null || value === undefined) return { result: null, warn: false };
  if (typeof value === 'number') {
    return isNaN(value) ? { result: null, warn: true } : { result: value, warn: false };
  }
  const raw = String(value).trim();
  if (raw === '') return { result: null, warn: false };
  const str = raw.replace(/[^0-9.\-]/g, '');
  if (str === '' || str === '-') return { result: null, warn: true };
  const n = parseFloat(str);
  if (isNaN(n)) return { result: null, warn: true };
  return { result: n, warn: false };
}

function coerceCurrency(
  value: unknown,
  _fieldDef: FieldDefinition,
  _options: NormaliseOptions,
): { result: number | null; warn: boolean } {
  if (value === null || value === undefined) return { result: null, warn: false };
  if (typeof value === 'number') {
    return isNaN(value) ? { result: null, warn: true } : { result: value, warn: false };
  }
  const raw = String(value).trim();
  if (raw === '') return { result: null, warn: false };
  const str = raw.replace(/[£$€,\s]/g, '');
  if (str === '' || str === '-') return { result: null, warn: true };
  const n = parseFloat(str);
  if (isNaN(n)) return { result: null, warn: true };
  return { result: n, warn: false };
}

function coercePercentage(
  value: unknown,
  _fieldDef: FieldDefinition,
  _options: NormaliseOptions,
): { result: number | null; warn: boolean } {
  if (value === null || value === undefined) return { result: null, warn: false };
  if (typeof value === 'number') {
    if (isNaN(value)) return { result: null, warn: true };
    // If already a numeric value (not from string), apply the <= 1 heuristic
    return { result: value <= 1 ? value * 100 : value, warn: false };
  }
  const raw = String(value).trim();
  if (raw === '') return { result: null, warn: false };
  // Strip trailing % if present
  const stripped = raw.endsWith('%') ? raw.slice(0, -1).trim() : raw;
  if (stripped === '') return { result: null, warn: true };
  const n = parseFloat(stripped);
  if (isNaN(n)) return { result: null, warn: true };
  // Key heuristic: if raw string contains a '.' AND result <= 1, it's a decimal fraction
  // If result > 1, keep as-is
  if (n <= 1) {
    return { result: n * 100, warn: false };
  }
  return { result: n, warn: false };
}

/** Parse a date string. Tries ISO, UK (DD/MM/YYYY), US (MM/DD/YYYY), then generic. */
function coerceDate(
  value: unknown,
  _fieldDef: FieldDefinition,
  _options: NormaliseOptions,
): { result: Date | null; warn: boolean } {
  if (value === null || value === undefined) return { result: null, warn: false };
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? { result: null, warn: true } : { result: value, warn: false };
  }
  const str = String(value).trim();
  if (str === '') return { result: null, warn: false };

  // ISO: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS...
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const d = new Date(str);
    if (!isNaN(d.getTime())) return { result: d, warn: false };
  }

  // UK: DD/MM/YYYY
  const ukMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ukMatch) {
    const day = parseInt(ukMatch[1], 10);
    const month = parseInt(ukMatch[2], 10);
    const year = parseInt(ukMatch[3], 10);
    const d = new Date(year, month - 1, day);
    if (!isNaN(d.getTime()) && d.getMonth() === month - 1) {
      return { result: d, warn: false };
    }
  }

  // US: MM/DD/YYYY
  const usMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const month = parseInt(usMatch[1], 10);
    const day = parseInt(usMatch[2], 10);
    const year = parseInt(usMatch[3], 10);
    const d = new Date(year, month - 1, day);
    if (!isNaN(d.getTime())) return { result: d, warn: false };
  }

  // Generic fallback
  const d = new Date(str);
  if (!isNaN(d.getTime())) return { result: d, warn: false };

  return { result: null, warn: true };
}

function coerceBoolean(
  value: unknown,
  _fieldDef: FieldDefinition,
  _options: NormaliseOptions,
): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (s === 'true' || s === 'yes' || s === '1') return true;
  if (s === 'false' || s === 'no' || s === '0') return false;
  return null;
}

function coerceSelect(
  value: unknown,
  fieldDef: FieldDefinition,
  _options: NormaliseOptions,
): { result: unknown; warn: boolean } {
  // Keep value as-is, but warn if not in options list
  if (value === null || value === undefined) return { result: null, warn: false };
  const str = String(value).trim();
  if (str === '') return { result: null, warn: false };
  if (fieldDef.options && fieldDef.options.length > 0 && !fieldDef.options.includes(str)) {
    return { result: str, warn: true };
  }
  return { result: str, warn: false };
}

function coerceReference(
  value: unknown,
  _fieldDef: FieldDefinition,
  _options: NormaliseOptions,
): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str === '' ? null : str;
}

// ---------------------------------------------------------------------------
// Apply type coercion to a single field value
// ---------------------------------------------------------------------------

interface CoercionResult {
  value: unknown;
  warn: boolean;
}

function applyCoercion(
  value: unknown,
  fieldDef: FieldDefinition,
  options: NormaliseOptions,
): CoercionResult {
  switch (fieldDef.type) {
    case FieldType.STRING: {
      const result = coerceString(value, fieldDef, options);
      return { value: result, warn: false };
    }
    case FieldType.NUMBER: {
      const { result, warn } = coerceNumber(value, fieldDef, options);
      return { value: result, warn };
    }
    case FieldType.CURRENCY: {
      const { result, warn } = coerceCurrency(value, fieldDef, options);
      return { value: result, warn };
    }
    case FieldType.PERCENTAGE: {
      const { result, warn } = coercePercentage(value, fieldDef, options);
      return { value: result, warn };
    }
    case FieldType.DATE: {
      const { result, warn } = coerceDate(value, fieldDef, options);
      return { value: result, warn };
    }
    case FieldType.BOOLEAN: {
      const result = coerceBoolean(value, fieldDef, options);
      return { value: result, warn: false };
    }
    case FieldType.SELECT: {
      const { result, warn } = coerceSelect(value, fieldDef, options);
      return { value: result, warn };
    }
    case FieldType.REFERENCE: {
      const result = coerceReference(value, fieldDef, options);
      return { value: result, warn: false };
    }
    default:
      return { value, warn: false };
  }
}

// ---------------------------------------------------------------------------
// Entity-specific rules
// ---------------------------------------------------------------------------

function applyFeeEarnerRules(record: NormalisedRecord): NormalisedRecord {
  const out = { ...record };

  // Extract rate from JSON array: [{"label":"...","value":295,"default":true}]
  if (typeof out.rate === 'string' && (out.rate as string).startsWith('[')) {
    try {
      const parsed = JSON.parse(out.rate as string) as Array<{
        label?: string;
        value?: number;
        default?: boolean;
      }>;
      if (Array.isArray(parsed)) {
        out.allRates = parsed;
        const defaultEntry = parsed.find((e) => e.default === true) ?? parsed[0];
        out.rate = defaultEntry?.value ?? null;
      }
    } catch {
      // Keep as-is if parse fails
    }
  }

  // payModel normalisation
  if (typeof out.payModel === 'string') {
    const pm = out.payModel.toLowerCase().replace(/[\s\-_]/g, '');
    if (pm.includes('feeshare') || pm.includes('fee')) {
      out.payModel = 'FeeShare';
    } else if (pm.includes('salary') || pm.includes('salaried')) {
      out.payModel = 'Salaried';
    }
  }

  // Derive monthlySalary from annualSalary
  if (
    typeof out.annualSalary === 'number' &&
    out.annualSalary !== null &&
    (out.monthlySalary === undefined || out.monthlySalary === null)
  ) {
    out.monthlySalary = (out.annualSalary as number) / 12;
  }

  // Default isSystemAccount to false
  if (out.isSystemAccount === undefined || out.isSystemAccount === null) {
    out.isSystemAccount = false;
  }

  return out;
}

function applyTimeEntryRules(record: NormalisedRecord): NormalisedRecord {
  const out = { ...record };

  // Derive durationMinutes from durationHours
  if (
    (out.durationMinutes === undefined || out.durationMinutes === null) &&
    typeof out.durationHours === 'number' &&
    out.durationHours !== null
  ) {
    out.durationMinutes = (out.durationHours as number) * 60;
  }

  // Derive billableValue from rate × durationMinutes
  if (
    (out.billableValue === undefined || out.billableValue === null) &&
    typeof out.rate === 'number' &&
    out.rate !== null &&
    typeof out.durationMinutes === 'number' &&
    out.durationMinutes !== null
  ) {
    out.billableValue = (out.rate as number) * ((out.durationMinutes as number) / 60);
  }

  // Default writeOffValue to 0
  if (out.writeOffValue === undefined || out.writeOffValue === null) {
    out.writeOffValue = 0;
  }

  // Default doNotBill to false
  if (out.doNotBill === undefined || out.doNotBill === null) {
    out.doNotBill = false;
  }

  return out;
}

function applyMatterRules(record: NormalisedRecord): NormalisedRecord {
  const out = { ...record };

  // Parse clientIds from JSON array string
  if (typeof out.clientIds === 'string') {
    try {
      out.clientIds = JSON.parse(out.clientIds as string);
    } catch {
      // Keep as-is if parse fails
    }
  }

  // Parse clientNames from JSON array string
  if (typeof out.clientNames === 'string') {
    try {
      out.clientNames = JSON.parse(out.clientNames as string);
    } catch {
      // Keep as-is if parse fails
    }
  }

  return out;
}

function applyInvoiceRules(record: NormalisedRecord): NormalisedRecord {
  const out = { ...record };

  // Default paid to 0
  if (out.paid === undefined || out.paid === null) {
    out.paid = 0;
  }

  // Default outstanding to 0
  if (out.outstanding === undefined || out.outstanding === null) {
    out.outstanding = 0;
  }

  // Derive total from paid + outstanding when total is absent
  if (
    (out.total === undefined || out.total === null) &&
    typeof out.paid === 'number' &&
    typeof out.outstanding === 'number'
  ) {
    out.total = (out.paid as number) + (out.outstanding as number);
  }

  return out;
}

function applyDisbursementRules(record: NormalisedRecord): NormalisedRecord {
  const out = { ...record };

  // Parse clientId from JSON array: [{"contact":"...","display_name":"..."}]
  if (typeof out.clientId === 'string' && (out.clientId as string).startsWith('[')) {
    try {
      const parsed = JSON.parse(out.clientId as string) as Array<{
        contact?: string;
        display_name?: string;
      }>;
      if (Array.isArray(parsed) && parsed.length > 0) {
        const first = parsed[0];
        if (first.contact !== undefined) out.clientId = first.contact;
        if (first.display_name !== undefined) out.clientName = first.display_name;
      }
    } catch {
      // Keep as-is if parse fails
    }
  }

  return out;
}

function applyEntitySpecificRules(record: NormalisedRecord, entityKey: string): NormalisedRecord {
  switch (entityKey) {
    case 'feeEarner':
      return applyFeeEarnerRules(record);
    case 'timeEntry':
      return applyTimeEntryRules(record);
    case 'matter':
      return applyMatterRules(record);
    case 'invoice':
      return applyInvoiceRules(record);
    case 'disbursement':
      return applyDisbursementRules(record);
    default:
      return record;
  }
}

// ---------------------------------------------------------------------------
// Warning aggregation helpers
// ---------------------------------------------------------------------------

type WarningMap = Map<string, { message: string; count: number }>;

function addWarning(warningMap: WarningMap, field: string, message: string): void {
  const existing = warningMap.get(field);
  if (existing) {
    existing.count += 1;
  } else {
    warningMap.set(field, { message, count: 1 });
  }
}

// ---------------------------------------------------------------------------
// FieldStats tracking
// ---------------------------------------------------------------------------

type FieldStatsAccumulator = {
  totalRows: number;
  nullCount: number;
  uniqueValues: Set<unknown>;
  sampleValues: unknown[];
};

function updateFieldStats(
  acc: FieldStatsAccumulator,
  value: unknown,
): void {
  acc.totalRows += 1;
  if (value === null || value === undefined) {
    acc.nullCount += 1;
  } else {
    acc.uniqueValues.add(value instanceof Date ? value.toISOString() : value);
    if (acc.sampleValues.length < 5) {
      acc.sampleValues.push(value);
    }
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function normaliseRecords(
  rawRows: Record<string, unknown>[],
  mappingSet: MappingSet,
  entityKey: string,
  entityDefinition: EntityDefinition,
  options: NormaliseOptions = {},
): NormaliseResult {
  const strictMode = options.strictMode ?? false;

  // Build a lookup from targetField → FieldDefinition for O(1) access
  const fieldDefByKey = new Map<string, FieldDefinition>();
  for (const fd of entityDefinition.fields) {
    fieldDefByKey.set(fd.key, fd);
  }

  // Build a lookup from sourceColumn → targetField
  const mappingBySource = new Map<string, string>();
  for (const m of mappingSet) {
    mappingBySource.set(m.sourceColumn, m.targetField);
  }

  const records: NormalisedRecord[] = [];
  const rejectedRows: RejectedRow[] = [];
  const warningMap: WarningMap = new Map();
  const fieldStatsAccMap = new Map<string, FieldStatsAccumulator>();

  // Initialise field stats accumulators for every mapped target field
  for (const [, targetField] of mappingBySource) {
    if (!fieldStatsAccMap.has(targetField)) {
      fieldStatsAccMap.set(targetField, {
        totalRows: 0,
        nullCount: 0,
        uniqueValues: new Set(),
        sampleValues: [],
      });
    }
  }

  // Track seen primary keys for deduplication
  const seenPrimaryKeys = new Set<unknown>();
  const primaryKey = entityDefinition.primaryKey;

  for (let rowIndex = 0; rowIndex < rawRows.length; rowIndex++) {
    const rawRow = rawRows[rowIndex];

    // --- Step 1: Column remapping ---
    const mapped: NormalisedRecord = { _sourceRowIndex: rowIndex };
    for (const [sourceColumn, targetField] of mappingBySource) {
      if (Object.prototype.hasOwnProperty.call(rawRow, sourceColumn)) {
        mapped[targetField] = rawRow[sourceColumn];
      }
    }

    // --- Step 2: Type coercion ---
    let hasNullRequiredField = false;
    const nullRequiredFields: string[] = [];

    for (const [, targetField] of mappingBySource) {
      const fieldDef = fieldDefByKey.get(targetField);
      if (!fieldDef) continue;

      const rawValue = mapped[targetField];
      const { value: coerced, warn } = applyCoercion(rawValue, fieldDef, options);
      mapped[targetField] = coerced;

      // Track warnings for coercion failures
      if (warn) {
        addWarning(warningMap, targetField, `Could not coerce value for field '${targetField}'`);
      }

      // Select field out-of-options warning
      if (fieldDef.type === FieldType.SELECT && warn) {
        // already added above
      }

      // Track field stats
      const acc = fieldStatsAccMap.get(targetField);
      if (acc) {
        updateFieldStats(acc, coerced);
      }
    }

    // --- Step 2b: Blank-row filter (unconditional) ---
    const allMappedNull = [...mappingBySource.values()].every(
      field => mapped[field] === null || mapped[field] === undefined,
    );
    if (allMappedNull) {
      rejectedRows.push({ rowIndex, rawRow, reason: 'blank row (all mapped fields null)' });
      continue;
    }

    // --- Step 3: Entity-specific rules ---
    const afterEntityRules = applyEntitySpecificRules(mapped, entityKey);

    // --- Step 4: Null handling for required fields ---
    for (const fieldDef of entityDefinition.fields) {
      if (!fieldDef.required) continue;
      const val = afterEntityRules[fieldDef.key];
      if (val === null || val === undefined) {
        hasNullRequiredField = true;
        nullRequiredFields.push(fieldDef.key);
        addWarning(
          warningMap,
          fieldDef.key,
          `Required field '${fieldDef.key}' is null`,
        );
      }
    }

    if (strictMode && hasNullRequiredField) {
      rejectedRows.push({
        rowIndex,
        rawRow,
        reason: `Required fields are null: ${nullRequiredFields.join(', ')}`,
      });
      continue;
    }

    // --- Step 5: Deduplication ---
    if (primaryKey) {
      const pkValue = afterEntityRules[primaryKey];
      if (pkValue !== null && pkValue !== undefined) {
        if (seenPrimaryKeys.has(pkValue)) {
          addWarning(
            warningMap,
            primaryKey,
            `Duplicate primary key '${String(pkValue)}' — keeping first occurrence`,
          );
          continue;
        }
        seenPrimaryKeys.add(pkValue);
      }
    }

    records.push(afterEntityRules);
  }

  // Build warnings array
  const warnings: NormaliseWarning[] = [];
  for (const [field, { message, count }] of warningMap) {
    warnings.push({ field, message, affectedRowCount: count });
  }

  // Build fieldStats
  const fieldStats: Record<string, FieldStats> = {};
  for (const [fieldKey, acc] of fieldStatsAccMap) {
    fieldStats[fieldKey] = {
      fieldKey,
      totalRows: acc.totalRows,
      nullCount: acc.nullCount,
      nullPercent: acc.totalRows > 0 ? (acc.nullCount / acc.totalRows) * 100 : 0,
      uniqueValueCount: acc.uniqueValues.size,
      sampleValues: acc.sampleValues,
    };
  }

  return {
    fileType: entityKey,
    records,
    recordCount: records.length,
    normalisedAt: new Date().toISOString(),
    rejectedRows: rejectedRows.length > 0 ? rejectedRows : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    fieldStats,
  };
}
