/**
 * DataManagementPage — Upload, review, and manage firm data.
 */

import { useState, useCallback, useRef, useMemo, useEffect, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Upload, FileJson, FileSpreadsheet, FileText, CheckCircle2, XCircle,
  Clock, Trash2, RefreshCw, ChevronDown, ChevronRight, Sparkles, Save,
  AlertTriangle, Info, Download, UploadCloud, Bot,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DashboardSection } from '@/components/common/DashboardSection';
import { SortableTable, type ColumnDef } from '@/components/common/SortableTable';
import { AlertCard } from '@/components/common/AlertCard';
import { EmptyState } from '@/components/common/EmptyState';
import { ProgressBar } from '@/components/common/ProgressBar';
import { useUpload } from '@/hooks/useUpload';
import { fetchConfig, updateConfig, fetchUploadStatus, type UploadStatusEntry } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DetectedFile {
  file: File;
  detectedType: string;
  confidence: 'high' | 'medium' | 'low';
  recordCount: number | null;
  mappingNeeded: boolean;
  columnMappings?: ColumnMappingRow[];
}

interface ColumnMappingRow {
  rawColumn: string;
  mappedTo: string | null;
  autoMatched: boolean;
  isCustomField: boolean;
}

interface LoadedDataset {
  fileType: string;
  recordCount: number;
  dateLoaded: string;
  status: 'loaded' | 'processing' | 'failed';
}

interface QualityIssue {
  severity: 'critical' | 'warning' | 'info';
  message: string;
  detail: string;
  fixLink?: string;
}

interface FeeEarnerRow {
  name: string;
  grade: string;
  payModel: string;
  rate: number | null;
  workingDays: number | null;
  issues: string[];
}

interface MappingTemplateRow {
  id: string;
  name: string;
  fileType: string;
  createdDate: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILE_TYPES = [
  { key: 'feeEarners', label: 'Fee Earners', required: true },
  { key: 'wip', label: 'WIP Entries', required: true },
  { key: 'fullMatters', label: 'Full Matters', required: true },
  { key: 'closedMatters', label: 'Closed Matters', required: false },
  { key: 'invoices', label: 'Invoices', required: true },
  { key: 'contacts', label: 'Contacts', required: false },
  { key: 'lawyers', label: 'Lawyers', required: false },
  { key: 'disbursements', label: 'Disbursements', required: false },
  { key: 'tasks', label: 'Tasks', required: false },
];

const ENTITY_FIELDS: Record<string, string[]> = {
  feeEarners: ['lawyerId', 'lawyerName', 'grade', 'payModel', 'workingDaysPerWeek', 'hourlyRate'],
  wip: ['matterId', 'lawyerId', 'date', 'hours', 'rate', 'value', 'description'],
  fullMatters: ['matterId', 'matterNumber', 'clientName', 'caseType', 'department', 'status', 'responsibleLawyer'],
  invoices: ['invoiceNumber', 'matterId', 'matterNumber', 'date', 'total', 'outstanding', 'paid'],
};

const DATASET_FILE_TYPE_MAP: Record<string, string> = {
  feeEarner: 'feeEarners',
  feeEarners: 'feeEarners',
  wipJson: 'wip',
  wip: 'wip',
  fullMattersJson: 'fullMatters',
  fullMatters: 'fullMatters',
  closedMattersJson: 'closedMatters',
  closedMatters: 'closedMatters',
  invoicesJson: 'invoices',
  invoices: 'invoices',
  contactsJson: 'contacts',
  contacts: 'contacts',
  contact: 'contacts',
  disbursementsJson: 'disbursements',
  disbursements: 'disbursements',
  tasksJson: 'tasks',
  tasks: 'tasks',
};

function normaliseDatasetFileType(fileType: string): string {
  return DATASET_FILE_TYPE_MAP[fileType] ?? fileType;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FileTypeIcon({ type }: { type: string }) {
  const ext = type.toLowerCase();
  if (ext.endsWith('.json') || ext === 'json') return <FileJson className="h-4 w-4 text-primary" />;
  if (ext.endsWith('.xlsx') || ext.endsWith('.xls') || ext === 'xlsx') return <FileSpreadsheet className="h-4 w-4 text-teal" />;
  return <FileText className="h-4 w-4 text-icon-main" />;
}

function StatusIndicator({ status }: { status: 'loaded' | 'processing' | 'failed' }) {
  switch (status) {
    case 'loaded':
      return <span className="inline-flex items-center gap-1 text-success text-xs font-medium"><CheckCircle2 className="h-3.5 w-3.5" /> Loaded</span>;
    case 'processing':
      return <span className="inline-flex items-center gap-1 text-warning text-xs font-medium"><Clock className="h-3.5 w-3.5" /> Processing</span>;
    case 'failed':
      return <span className="inline-flex items-center gap-1 text-error text-xs font-medium"><XCircle className="h-3.5 w-3.5" /> Failed</span>;
  }
}

function ConfidenceBadge({ confidence }: { confidence: 'high' | 'medium' | 'low' }) {
  const styles = {
    high: 'bg-accent text-success',
    medium: 'bg-muted text-warning',
    low: 'bg-muted text-error',
  };
  return (
    <span className={cn('px-2 py-0.5 rounded-sm text-[10px] font-semibold uppercase', styles[confidence])}>
      {confidence}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Upload Zone
// ---------------------------------------------------------------------------

function UploadZone({
  onFilesSelected,
  stagedFiles,
  onRemoveStaged,
  onUploadAll,
  isUploading,
  uploadProgress,
}: {
  onFilesSelected: (files: FileList) => void;
  stagedFiles: DetectedFile[];
  onRemoveStaged: (idx: number) => void;
  onUploadAll: () => void;
  isUploading: boolean;
  uploadProgress: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files.length) onFilesSelected(e.dataTransfer.files);
    },
    [onFilesSelected],
  );

  return (
    <div className="space-y-4">
      {/* Drop area */}
      <div
        className={cn(
          'border-2 border-dashed rounded-lg p-10 text-center transition-colors cursor-pointer',
          dragOver ? 'border-primary bg-accent/40' : 'border-border bg-standard-background hover:border-primary/50',
        )}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        <UploadCloud className="h-10 w-10 text-icon-main mx-auto mb-3" />
        <p className="text-sm font-medium text-foreground">Drop files here or click to browse</p>
        <p className="text-xs text-muted-foreground mt-1">Accepts .json, .csv, .xlsx files — upload multiple files at once</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".json,.csv,.xlsx,.xls"
          className="hidden"
          onChange={(e) => e.target.files && onFilesSelected(e.target.files)}
        />
      </div>

      {/* Staged files */}
      {stagedFiles.length > 0 && (
        <div className="space-y-3">
          {stagedFiles.map((sf, idx) => (
            <StagedFileCard key={idx} file={sf} onRemove={() => onRemoveStaged(idx)} />
          ))}

          {isUploading && (
            <div className="px-1">
              <ProgressBar value={uploadProgress} max={100} ragStatus="neutral" showLabel />
            </div>
          )}

          <div className="flex justify-end">
            <Button onClick={onUploadAll} disabled={isUploading}>
              {isUploading ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-1.5 animate-spin" />
                  Uploading…
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-1.5" />
                  Upload & Process
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function StagedFileCard({ file, onRemove }: { file: DetectedFile; onRemove: () => void }) {
  const [showMapping, setShowMapping] = useState(file.mappingNeeded);

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FileTypeIcon type={file.file.name} />
          <div>
            <p className="text-[13px] font-semibold text-foreground">{file.file.name}</p>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-xs text-muted-foreground">Detected: {file.detectedType}</span>
              <ConfidenceBadge confidence={file.confidence} />
              {file.recordCount !== null && (
                <span className="text-xs text-muted-foreground">{file.recordCount.toLocaleString()} records found</span>
              )}
            </div>
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onRemove}>
          <XCircle className="h-4 w-4 text-muted-foreground" />
        </Button>
      </div>

      {/* Column mapping */}
      {file.mappingNeeded && file.columnMappings && (
        <div className="mt-3">
          <button
            className="flex items-center gap-1 text-xs font-medium text-primary mb-2"
            onClick={() => setShowMapping(!showMapping)}
          >
            {showMapping ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            Column Mapping ({file.columnMappings.filter((m) => m.mappedTo).length}/{file.columnMappings.length} mapped)
          </button>
          {showMapping && (
            <div className="space-y-1.5 ml-1">
              {file.columnMappings.map((cm, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  {cm.autoMatched ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
                  ) : cm.isCustomField ? (
                    <Sparkles className="h-3.5 w-3.5 text-purple shrink-0" />
                  ) : (
                    <span className="h-3.5 w-3.5 rounded-full border border-border shrink-0" />
                  )}
                  <span className="text-foreground font-medium min-w-[120px]">{cm.rawColumn}</span>
                  <span className="text-muted-foreground">→</span>
                  {cm.mappedTo ? (
                    <span className="text-foreground">{cm.mappedTo}</span>
                  ) : (
                    <select className="h-6 rounded-input border border-input bg-background px-1.5 text-xs text-foreground">
                      <option value="">Select field…</option>
                      {(ENTITY_FIELDS[file.detectedType] ?? []).map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  )}
                </div>
              ))}
              <Button variant="outline" size="sm" className="mt-2">
                <Save className="h-3.5 w-3.5 mr-1" />
                Save as Template
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data Quality Report
// ---------------------------------------------------------------------------

function DataQualityReport({ issues }: { issues: QualityIssue[] }) {
  const critical = issues.filter((i) => i.severity === 'critical');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const info = issues.filter((i) => i.severity === 'info');

  return (
    <DashboardSection title="Data Quality Report">
      <div className="space-y-6">
        {/* Critical */}
        {critical.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-error uppercase tracking-wider flex items-center gap-1.5">
              <XCircle className="h-3.5 w-3.5" /> Critical — Blocks Analysis
            </h4>
            {critical.map((issue, i) => (
              <QualityIssueCard key={i} issue={issue} />
            ))}
          </div>
        )}

        {/* Warnings */}
        {warnings.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-warning uppercase tracking-wider flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" /> Warnings — May Affect Accuracy
            </h4>
            {warnings.map((issue, i) => (
              <QualityIssueCard key={i} issue={issue} />
            ))}
          </div>
        )}

        {/* Info */}
        {info.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-primary uppercase tracking-wider flex items-center gap-1.5">
              <Info className="h-3.5 w-3.5" /> Information — Features You Could Unlock
            </h4>
            {info.map((issue, i) => (
              <QualityIssueCard key={i} issue={issue} />
            ))}
          </div>
        )}

        {issues.length === 0 && (
          <p className="text-xs text-muted-foreground">No data quality issues detected.</p>
        )}
      </div>
    </DashboardSection>
  );
}

function QualityIssueCard({ issue }: { issue: QualityIssue }) {
  const [expanded, setExpanded] = useState(false);
  const typeMap: Record<string, 'error' | 'warning' | 'info'> = {
    critical: 'error',
    warning: 'warning',
    info: 'info',
  };

  return (
    <div className="bg-card border border-border rounded-lg p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] text-foreground">{issue.message}</p>
        <button
          className="text-xs text-primary font-medium whitespace-nowrap shrink-0"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Hide' : 'How to fix →'}
        </button>
      </div>
      {expanded && (
        <p className="text-xs text-muted-foreground mt-2 bg-standard-background rounded p-2">
          {issue.detail}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fee Earner Review
// ---------------------------------------------------------------------------

function FeeEarnerReview({ earners }: { earners: FeeEarnerRow[] }) {
  const columns: ColumnDef<FeeEarnerRow>[] = [
    { key: 'name', header: 'Name' },
    { key: 'grade', header: 'Grade' },
    { key: 'payModel', header: 'Pay Model' },
    {
      key: 'rate',
      header: 'Rate',
      align: 'right',
      render: (v) => v != null ? `£${Number(v).toLocaleString()}` : '—',
    },
    {
      key: 'workingDays',
      header: 'Working Days',
      align: 'right',
      render: (v) => v != null ? String(v) : '—',
    },
    {
      key: 'issues',
      header: 'Issues',
      render: (v) => {
        const arr = v as unknown as string[];
        if (!arr || arr.length === 0) return <span className="text-muted-foreground">—</span>;
        return (
          <div className="flex items-center gap-1.5 flex-wrap">
            {arr.map((issue, i) => {
              if (issue === 'system') return <span key={i} className="inline-flex items-center gap-0.5 text-[10px] text-purple"><Bot className="h-3 w-3" /> System</span>;
              if (issue === 'anomaly') return <span key={i} className="inline-flex items-center gap-0.5 text-[10px] text-warning"><AlertTriangle className="h-3 w-3" /> Anomaly</span>;
              return <span key={i} className="text-[10px] text-muted-foreground">{issue}</span>;
            })}
          </div>
        );
      },
    },
  ];

  return (
    <DashboardSection title="Fee Earner Review">
      {earners.length > 0 ? (
        <SortableTable columns={columns as unknown as ColumnDef[]} data={earners as unknown as Record<string, unknown>[]} />
      ) : (
        <EmptyState
          title="No fee earners loaded"
          message="Upload your fee earner CSV to review and validate the data."
        />
      )}
    </DashboardSection>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function DataManagementPage() {
  const navigate = useNavigate();
  const { uploadFile, uploadStatus, error: uploadError, reset: resetUpload } = useUpload();

  // Upload zone state
  const [stagedFiles, setStagedFiles] = useState<DetectedFile[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);

  // Upload status from API
  const [loadedDatasets, setLoadedDatasets] = useState<LoadedDataset[]>([]);

  const refreshUploadStatus = useCallback(async () => {
    try {
      const entries = await fetchUploadStatus();
      const datasets: LoadedDataset[] = entries
        .filter((e) => e.status === 'loaded')
        .map((e) => ({
          fileType: normaliseDatasetFileType(e.fileType),
          recordCount: e.recordCount ?? 0,
          dateLoaded: e.uploadedAt ?? '',
          status: 'loaded' as const,
        }));
      setLoadedDatasets(datasets);
    } catch {
      // Silently fail — table just stays empty
    }
  }, []);

  const markDatasetLoaded = useCallback((fileType: string, recordCount: number) => {
    const normalisedFileType = normaliseDatasetFileType(fileType);
    const dateLoaded = new Date().toISOString();

    setLoadedDatasets((prev) => {
      const next = prev.filter((dataset) => dataset.fileType !== normalisedFileType);
      next.push({
        fileType: normalisedFileType,
        recordCount,
        dateLoaded,
        status: 'loaded',
      });
      return next;
    });
  }, []);

  // Fetch on mount
  useEffect(() => {
    refreshUploadStatus();
  }, [refreshUploadStatus]);
  const [qualityIssues] = useState<QualityIssue[]>([]);
  const [feeEarners] = useState<FeeEarnerRow[]>([]);
  const [mappingTemplates] = useState<MappingTemplateRow[]>([]);
  const [lastExported] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Detect file type from name/extension
  const detectFileType = useCallback((file: File): DetectedFile => {
    const name = file.name.toLowerCase();
    let detectedType = 'unknown';
    let confidence: 'high' | 'medium' | 'low' = 'low';

    if (name.includes('fee') && name.includes('earner')) { detectedType = 'feeEarners'; confidence = 'high'; }
    else if (name.includes('wip') || name.includes('time')) { detectedType = 'wip'; confidence = 'high'; }
    else if (name.includes('full') && name.includes('matter')) { detectedType = 'fullMatters'; confidence = 'high'; }
    else if (name.includes('closed') && name.includes('matter')) { detectedType = 'closedMatters'; confidence = 'high'; }
    else if (name.includes('invoice')) { detectedType = 'invoices'; confidence = 'high'; }
    else if (name.includes('contact')) { detectedType = 'contacts'; confidence = 'medium'; }
    else if (name.includes('lawyer')) { detectedType = 'lawyers'; confidence = 'medium'; }
    else if (name.includes('disbursement')) { detectedType = 'disbursements'; confidence = 'medium'; }
    else if (name.includes('task')) { detectedType = 'tasks'; confidence = 'medium'; }
    else if (name.endsWith('.csv')) { confidence = 'low'; }

    const mappingNeeded = name.endsWith('.csv') && confidence !== 'high';

    return {
      file,
      detectedType,
      confidence,
      recordCount: null,
      mappingNeeded,
      columnMappings: mappingNeeded
        ? [
            { rawColumn: 'Column A', mappedTo: null, autoMatched: false, isCustomField: false },
            { rawColumn: 'Column B', mappedTo: null, autoMatched: false, isCustomField: false },
          ]
        : undefined,
    };
  }, []);

  const handleFilesSelected = useCallback(
    (files: FileList) => {
      const detected = Array.from(files).map(detectFileType);
      setStagedFiles((prev) => [...prev, ...detected]);
    },
    [detectFileType],
  );

  const handleRemoveStaged = useCallback((idx: number) => {
    setStagedFiles((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleUploadAll = useCallback(async () => {
    setUploadProgress(0);
    const total = stagedFiles.length;
    for (let i = 0; i < stagedFiles.length; i++) {
      const sf = stagedFiles[i];
      try {
        const result = await uploadFile(sf.file, sf.detectedType);
        await refreshUploadStatus();
        markDatasetLoaded(sf.detectedType, result.recordCount);
        setUploadProgress(Math.round(((i + 1) / total) * 100));
      } catch {
        toast.error(`Failed to upload ${sf.file.name}`);
      }
    }
    setStagedFiles([]);
    toast.success('Upload complete');
    resetUpload();
  }, [stagedFiles, uploadFile, resetUpload, refreshUploadStatus, markDatasetLoaded]);

  const handleExportConfig = useCallback(async () => {
    try {
      const config = await fetchConfig();
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `yao-config-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Configuration exported');
    } catch {
      toast.error('Failed to export configuration');
    }
  }, []);

  const handleImportConfig = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!confirm('This will overwrite your current configuration. Continue?')) return;
        await updateConfig('/', parsed);
        toast.success('Configuration imported successfully');
      } catch {
        toast.error('Invalid configuration file');
      }
    };
    input.click();
  }, []);

  const handleDeleteDataset = useCallback(
    (fileType: string) => {
      if (deleteConfirm !== fileType) {
        setDeleteConfirm(fileType);
        return;
      }
      // API call would go here
      toast.success(`${fileType} data deleted`);
      setDeleteConfirm(null);
    },
    [deleteConfirm],
  );

  // Build the datasets table — show all file types, loaded or not
  const datasetsTableData = useMemo(() => {
    const loaded = new Map(loadedDatasets.map((d) => [d.fileType, d]));
    return FILE_TYPES.map((ft) => {
      const ds = loaded.get(ft.key);
      return {
        fileType: ft.label,
        fileTypeKey: ft.key,
        recordCount: ds?.recordCount ?? null,
        dateLoaded: ds?.dateLoaded ?? null,
        status: ds?.status ?? null,
        required: ft.required,
      };
    });
  }, [loadedDatasets]);

  const datasetColumns: ColumnDef[] = [
    {
      key: 'fileType',
      header: 'File Type',
      render: (v, row) => {
        const r = row as Record<string, unknown>;
        const isLoaded = r.status != null;
        return (
          <span className={cn('inline-flex items-center gap-2', !isLoaded && 'text-muted-foreground')}>
            <FileText className="h-4 w-4" />
            {String(v)}
          </span>
        );
      },
    },
    {
      key: 'recordCount',
      header: 'Records',
      align: 'right',
      render: (v) => v != null ? Number(v).toLocaleString() : '—',
    },
    {
      key: 'dateLoaded',
      header: 'Date Loaded',
      render: (v) => v ? new Date(String(v)).toLocaleDateString() : '—',
    },
    {
      key: 'status',
      header: 'Status',
      render: (v, row) => {
        const r = row as Record<string, unknown>;
        if (v == null) {
          return (
            <span className="text-xs text-muted-foreground">
              Not loaded ({r.required ? 'recommended' : 'optional'})
            </span>
          );
        }
        return <StatusIndicator status={v as 'loaded' | 'processing' | 'failed'} />;
      },
    },
    {
      key: 'fileTypeKey',
      header: '',
      sortable: false,
      render: (v, row) => {
        const r = row as Record<string, unknown>;
        if (r.status == null) return null;
        return (
          <div className="flex items-center gap-1 justify-end">
            <Button variant="ghost" size="icon-sm" title="Re-upload">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Delete"
              onClick={() => handleDeleteDataset(String(v))}
              className={deleteConfirm === String(v) ? 'text-error' : ''}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        );
      },
    },
  ];

  // Mapping templates columns
  const templateColumns: ColumnDef[] = [
    { key: 'name', header: 'Template Name' },
    { key: 'fileType', header: 'File Type' },
    {
      key: 'createdDate',
      header: 'Created',
      render: (v) => v ? new Date(String(v)).toLocaleDateString() : '—',
    },
    {
      key: 'id',
      header: '',
      sortable: false,
      render: () => (
        <Button variant="ghost" size="icon-sm" title="Delete template">
          <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Data Management</h1>
        <p className="text-sm text-muted-foreground mt-1">Upload, review, and manage your practice data</p>
      </div>

      {/* Upload zone */}
      <UploadZone
        onFilesSelected={handleFilesSelected}
        stagedFiles={stagedFiles}
        onRemoveStaged={handleRemoveStaged}
        onUploadAll={handleUploadAll}
        isUploading={uploadStatus === 'uploading'}
        uploadProgress={uploadProgress}
      />

      {/* Upload error */}
      {uploadError && (
        <AlertCard
          type="error"
          title="Upload Error"
          message={uploadError.message}
          action={{ label: 'Dismiss', onClick: resetUpload }}
        />
      )}

      {/* Loaded datasets */}
      <DashboardSection title="Loaded Datasets">
        <SortableTable
          columns={datasetColumns}
          data={datasetsTableData as unknown as Record<string, unknown>[]}
        />
      </DashboardSection>

      {/* Data quality report */}
      <DataQualityReport issues={qualityIssues} />

      {/* Fee earner review */}
      <FeeEarnerReview earners={feeEarners} />

      {/* Configuration management */}
      <DashboardSection title="Configuration">
        <div className="flex items-center gap-3 flex-wrap">
          <Button variant="outline" onClick={handleExportConfig}>
            <Download className="h-4 w-4 mr-1.5" />
            Export Configuration
          </Button>
          <Button variant="outline" onClick={handleImportConfig}>
            <Upload className="h-4 w-4 mr-1.5" />
            Import Configuration
          </Button>
          <span className="text-xs text-muted-foreground">
            {lastExported ? `Last exported: ${new Date(lastExported).toLocaleDateString()}` : 'Never exported'}
          </span>
        </div>
      </DashboardSection>

      {/* Column mapping templates */}
      <DashboardSection title="Saved Column Mappings">
        {mappingTemplates.length > 0 ? (
          <SortableTable
            columns={templateColumns}
            data={mappingTemplates as unknown as Record<string, unknown>[]}
          />
        ) : (
          <EmptyState
            title="No saved mappings"
            message="Column mapping templates will appear here after you save one during upload."
          />
        )}
      </DashboardSection>
    </div>
  );
}
