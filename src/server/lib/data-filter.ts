/**
 * data-filter.ts — Generic in-memory filter utility for data retrieval endpoints.
 */

export type FilterMatchType = 'exact' | 'contains' | 'boolean';

export interface FilterFieldConfig {
  /** The field name on the record to filter on. */
  field: string;
  /** How to compare the filter value against the record value. */
  matchType: FilterMatchType;
}

export type FilterConfig = FilterFieldConfig[];

/**
 * Apply query parameter filters to an in-memory array of records.
 *
 * - 'exact'    — strict equality (string, number, boolean)
 * - 'contains' — case-insensitive substring match on string values
 * - 'boolean'  — coerces both sides to boolean before comparing
 *
 * Filters whose value is undefined or null are skipped (treated as "no filter").
 */
export function applyFilters<T extends Record<string, unknown>>(
  records: T[],
  filters: Record<string, unknown>,
  filterConfig: FilterConfig
): T[] {
  return records.filter(record => {
    for (const cfg of filterConfig) {
      const filterValue = filters[cfg.field];
      if (filterValue === undefined || filterValue === null || filterValue === '') continue;

      const recordValue = record[cfg.field];

      switch (cfg.matchType) {
        case 'exact':
          if (recordValue !== filterValue) return false;
          break;
        case 'contains': {
          const rv = typeof recordValue === 'string' ? recordValue.toLowerCase() : '';
          const fv = typeof filterValue === 'string' ? filterValue.toLowerCase() : String(filterValue).toLowerCase();
          if (!rv.includes(fv)) return false;
          break;
        }
        case 'boolean':
          if (Boolean(recordValue) !== Boolean(filterValue)) return false;
          break;
      }
    }
    return true;
  });
}
