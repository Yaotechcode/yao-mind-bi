/**
 * SortableTable — Full-featured data table with sorting, pagination,
 * expandable rows, column visibility, density toggle, and CSV export.
 */

import { useState, useMemo, useCallback } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown, ChevronLeft, ChevronRight, Columns3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from './EmptyState';
import { ExportButton } from './ExportButton';
import { ToggleControl } from './ToggleControl';
import { exportCsv } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ColumnDef<T = Record<string, unknown>> {
  key: string;
  header: string;
  sortable?: boolean;
  /** Custom render function */
  render?: (value: unknown, row: T, index: number) => React.ReactNode;
  /** Text alignment */
  align?: 'left' | 'center' | 'right';
  /** Min width */
  minWidth?: number;
}

export interface SortableTableProps<T = Record<string, unknown>> {
  columns: ColumnDef<T>[];
  data: T[];
  defaultSort?: { key: string; direction: 'asc' | 'desc' };
  expandable?: boolean;
  renderExpanded?: (row: T) => React.ReactNode;
  onRowClick?: (row: T) => void;
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    onPageChange: (page: number) => void;
  };
  columnVisibility?: {
    visible: string[];
    onToggle: (key: string) => void;
  };
  /** Filename for CSV export (enables export button) */
  exportFilename?: string;
}

type SortDir = 'asc' | 'desc';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SortableTable<T extends Record<string, unknown>>({
  columns,
  data,
  defaultSort,
  expandable = false,
  renderExpanded,
  onRowClick,
  pagination,
  columnVisibility,
  exportFilename,
}: SortableTableProps<T>) {
  const [sortKey, setSortKey] = useState(defaultSort?.key ?? '');
  const [sortDir, setSortDir] = useState<SortDir>(defaultSort?.direction ?? 'asc');
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [density, setDensity] = useState<'compact' | 'comfortable'>('comfortable');
  const [showColPicker, setShowColPicker] = useState(false);

  // Visible columns
  const visibleCols = useMemo(
    () =>
      columnVisibility
        ? columns.filter((c) => columnVisibility.visible.includes(c.key))
        : columns,
    [columns, columnVisibility],
  );

  // Sorting
  const sortedData = useMemo(() => {
    if (!sortKey) return data;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return data;
    return [...data].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [data, sortKey, sortDir, columns]);

  const handleSort = useCallback(
    (key: string) => {
      if (sortKey === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(key);
        setSortDir('asc');
      }
    },
    [sortKey],
  );

  const toggleExpand = (idx: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  const handleExportCsv = () => {
    if (!exportFilename) return;
    const colKeys = visibleCols.map((c) => c.key);
    exportCsv(sortedData, colKeys, exportFilename);
  };

  const rowPadding = density === 'compact' ? 'py-1.5 px-3' : 'py-2.5 px-3';

  if (data.length === 0) {
    return <EmptyState title="No data available" message="There's nothing to display yet." />;
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-2 gap-2">
        <div className="flex items-center gap-2">
          <ToggleControl
            options={[
              { key: 'comfortable', label: 'Comfortable' },
              { key: 'compact', label: 'Compact' },
            ]}
            value={density}
            onChange={(v) => setDensity(v as 'compact' | 'comfortable')}
          />

          {columnVisibility && (
            <div className="relative">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setShowColPicker(!showColPicker)}
                title="Toggle columns"
              >
                <Columns3 className="h-4 w-4" />
              </Button>
              {showColPicker && (
                <div className="absolute top-full left-0 mt-1 bg-popover border border-border rounded-md shadow-card p-2 z-20 min-w-[160px]">
                  {columns.map((col) => (
                    <label key={col.key} className="flex items-center gap-2 py-1 px-1 text-xs cursor-pointer hover:bg-muted rounded-sm">
                      <Checkbox
                        checked={columnVisibility.visible.includes(col.key)}
                        onCheckedChange={() => columnVisibility.onToggle(col.key)}
                      />
                      <span>{col.header}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {exportFilename && <ExportButton onExportCsv={handleExportCsv} />}
      </div>

      {/* Table */}
      <div className="overflow-x-auto border border-border rounded-lg">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-standard-background">
              {visibleCols.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    'px-3 py-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider text-left whitespace-nowrap',
                    col.align === 'right' && 'text-right',
                    col.align === 'center' && 'text-center',
                    col.sortable !== false && 'cursor-pointer select-none hover:text-foreground',
                  )}
                  style={col.minWidth ? { minWidth: col.minWidth } : undefined}
                  onClick={col.sortable !== false ? () => handleSort(col.key) : undefined}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.header}
                    {col.sortable !== false && (
                      sortKey === col.key
                        ? sortDir === 'asc'
                          ? <ChevronUp className="h-3 w-3" />
                          : <ChevronDown className="h-3 w-3" />
                        : <ChevronsUpDown className="h-3 w-3 opacity-30" />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedData.map((row, idx) => (
              <Fragment key={idx}>
                <tr
                  className={cn(
                    'border-b border-standard-background transition-colors',
                    idx % 2 === 0 ? 'bg-card' : 'bg-row-background',
                    (onRowClick || expandable) && 'cursor-pointer hover:bg-hover-record/30',
                  )}
                  onClick={() => {
                    if (expandable) toggleExpand(idx);
                    onRowClick?.(row);
                  }}
                >
                  {visibleCols.map((col) => (
                    <td
                      key={col.key}
                      className={cn(
                        rowPadding,
                        'text-foreground',
                        col.align === 'right' && 'text-right',
                        col.align === 'center' && 'text-center',
                      )}
                    >
                      {col.render
                        ? col.render(row[col.key], row, idx)
                        : String(row[col.key] ?? '—')}
                    </td>
                  ))}
                </tr>
                {expandable && expandedRows.has(idx) && renderExpanded && (
                  <tr className="bg-accent/30">
                    <td colSpan={visibleCols.length} className="px-3 py-3">
                      {renderExpanded(row)}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pagination && (
        <div className="flex items-center justify-between mt-3">
          <span className="text-[11px] text-muted-foreground">
            Showing {Math.min(pagination.page * pagination.pageSize + 1, pagination.total)}–
            {Math.min((pagination.page + 1) * pagination.pageSize, pagination.total)} of {pagination.total}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={pagination.page === 0}
              onClick={() => pagination.onPageChange(pagination.page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={(pagination.page + 1) * pagination.pageSize >= pagination.total}
              onClick={() => pagination.onPageChange(pagination.page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// Need Fragment for keyed fragments
import { Fragment } from 'react';
