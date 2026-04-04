/**
 * stripper.ts — Defensive sensitive field stripper.
 *
 * Belt-and-suspenders protection: sensitive fields should already be stripped
 * at fetch time, but this final normalise step catches anything that slipped
 * through from unexpected API response shapes or future API changes.
 *
 * Rules:
 *  - Case-insensitive key matching
 *  - Recursive — walks nested objects and arrays
 *  - Never mutates input — always returns new objects/arrays
 */

// =============================================================================
// Sensitive field registry
// =============================================================================

const SENSITIVE_FIELDS = ['password', 'email_default_signature'] as const;

const SENSITIVE_FIELDS_LOWER = new Set(
  (SENSITIVE_FIELDS as readonly string[]).map((f) => f.toLowerCase()),
);

function isSensitive(key: string): boolean {
  return SENSITIVE_FIELDS_LOWER.has(key.toLowerCase());
}

// =============================================================================
// Recursive strip
// =============================================================================

/**
 * Removes any keys matching SENSITIVE_FIELDS (case-insensitive) at any depth.
 * Recursively processes nested objects and arrays.
 * Returns a new object — input is not mutated.
 */
export function stripSensitiveFields<T extends object>(record: T): T {
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(record)) {
    if (isSensitive(key)) continue;

    const value = (record as Record<string, unknown>)[key];
    result[key] = stripValue(value);
  }

  return result as T;
}

function stripValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripValue);
  }
  if (value !== null && typeof value === 'object') {
    return stripSensitiveFields(value as object);
  }
  return value;
}

/**
 * Maps stripSensitiveFields over an array of records.
 * Returns a new array — inputs are not mutated.
 */
export function stripSensitiveFromArray<T extends object>(records: T[]): T[] {
  return records.map((r) => stripSensitiveFields(r));
}

// =============================================================================
// Audit
// =============================================================================

/**
 * Scans records for any remaining sensitive fields BEFORE stripping.
 * Returns a list of found sensitive fields with their occurrence counts.
 *
 * Use this before stripping to log a warning if any sensitive data is found —
 * it means the upstream fetch layer has a gap that needs fixing.
 */
export function auditSensitiveFieldPresence(
  records: object[],
): { fieldName: string; count: number }[] {
  const counts = new Map<string, number>();

  for (const record of records) {
    countSensitiveIn(record, counts);
  }

  return Array.from(counts.entries())
    .map(([fieldName, count]) => ({ fieldName, count }))
    .sort((a, b) => a.fieldName.localeCompare(b.fieldName));
}

function countSensitiveIn(value: unknown, counts: Map<string, number>): void {
  if (Array.isArray(value)) {
    for (const item of value) countSensitiveIn(item, counts);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as object)) {
      if (isSensitive(key)) {
        counts.set(key.toLowerCase(), (counts.get(key.toLowerCase()) ?? 0) + 1);
      }
      countSensitiveIn((value as Record<string, unknown>)[key], counts);
    }
  }
}
