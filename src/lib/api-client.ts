/**
 * api-client.ts — Centralised API client for Yao Mind.
 * Attaches Supabase auth token, handles errors, returns typed responses.
 */

import { supabase } from '@/integrations/supabase/client';
import { parseFile } from '@/client/parsers';
import type {
  FirmOverviewPayload,
  FeeEarnerPerformancePayload,
  WipPayload,
  BillingPayload,
  MatterPayload,
  ClientPayload,
} from '@/shared/types/dashboard-payloads';
import type { FirmConfig } from '@/shared/types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/.netlify/functions';
const UPLOAD_STATUS_URL = import.meta.env.VITE_UPLOAD_STATUS_URL ?? '/.netlify/functions/upload-status';

// ---------------------------------------------------------------------------
// Dashboard type map
// ---------------------------------------------------------------------------

export type DashboardId =
  | 'firm-overview'
  | 'fee-earner-performance'
  | 'wip-leakage'
  | 'billing-collections'
  | 'matter-analysis'
  | 'client-intelligence';

export type DashboardPayloadMap = {
  'firm-overview': FirmOverviewPayload;
  'fee-earner-performance': FeeEarnerPerformancePayload;
  'wip-leakage': WipPayload;
  'billing-collections': BillingPayload;
  'matter-analysis': MatterPayload;
  'client-intelligence': ClientPayload;
};

export type DashboardPayload = DashboardPayloadMap[DashboardId];

// ---------------------------------------------------------------------------
// Shared response types
// ---------------------------------------------------------------------------

export interface CalculationStatus {
  lastCalculated: string | null;
  isStale: boolean;
  inProgress: boolean;
}

export interface CalculationResult {
  success: boolean;
  calculatedAt: string;
  formulaCount: number;
}

export interface UploadResult {
  success: boolean;
  uploadId: string;
  status: 'processing';
  recordCount: number;
  message?: string;
}

export type DashboardFilters = Record<string, string | string[] | number | boolean | undefined>;

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ---------------------------------------------------------------------------
// Core fetch wrapper
// ---------------------------------------------------------------------------

async function getAuthToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = await getAuthToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const url = `${API_BASE}${path}`;

  let response: Response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (err) {
    throw new ApiError(
      'Network error — please check your connection',
      0,
      err,
    );
  }

  if (response.status === 401) {
    // Session expired — redirect to login
    window.location.href = '/login';
    throw new ApiError('Session expired', 401);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(
      (body as { error?: string })?.error ?? `Request failed (${response.status})`,
      response.status,
      body,
    );
  }

  return response.json() as Promise<T>;
}

async function apiFetchBlob(
  path: string,
  options: RequestInit = {},
): Promise<Blob> {
  const token = await getAuthToken();

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const url = `${API_BASE}${path}`;

  let response: Response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (err) {
    throw new ApiError('Network error', 0, err);
  }

  if (response.status === 401) {
    window.location.href = '/login';
    throw new ApiError('Session expired', 401);
  }

  if (!response.ok) {
    throw new ApiError(`Export failed (${response.status})`, response.status);
  }

  return response.blob();
}

// ---------------------------------------------------------------------------
// Typed API functions
// ---------------------------------------------------------------------------

function buildQuery(filters?: DashboardFilters): string {
  if (!filters) return '';
  const params = new URLSearchParams();
  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      params.set(key, val.join(','));
    } else {
      params.set(key, String(val));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function fetchDashboard<D extends DashboardId>(
  dashboardId: D,
  filters?: DashboardFilters,
): Promise<DashboardPayloadMap[D]> {
  return apiFetch<DashboardPayloadMap[D]>(
    `/dashboard/${dashboardId}${buildQuery(filters)}`,
  );
}

export function fetchCalculationStatus(): Promise<CalculationStatus> {
  return apiFetch<CalculationStatus>('/calculate/status');
}

export function triggerCalculation(force = false): Promise<CalculationResult> {
  return apiFetch<CalculationResult>('/calculate', {
    method: 'POST',
    body: JSON.stringify({ force }),
  });
}

const CHUNK_SIZE = 5000;

export async function uploadFile(
  file: File,
  fileType: string,
): Promise<UploadResult> {
  // Parse file client-side using existing parsers
  const parseResult = await parseFile(file);
  if (parseResult.parseErrors.some(e => e.severity === 'error')) {
    throw new ApiError(
      parseResult.parseErrors.find(e => e.severity === 'error')?.message ?? 'File parse failed',
      400,
    );
  }

  const rows = parseResult.fullRows;
  const token = await getAuthToken();

  const postChunk = async <T>(body: unknown): Promise<T> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const url = `${API_BASE}/upload`;
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (err) {
      throw new ApiError('Upload failed — network error', 0, err);
    }
    if (response.status === 401) {
    window.location.href = '/login';
      throw new ApiError('Session expired', 401);
    }
    if (!response.ok) {
      const resBody = await response.json().catch(() => null);
      throw new ApiError(
        (resBody as { error?: string })?.error ?? `Upload failed (${response.status})`,
        response.status,
        resBody,
      );
    }
    return response.json() as Promise<T>;
  };

  // Non-chunked: single POST for files with <= CHUNK_SIZE records
  if (rows.length <= CHUNK_SIZE) {
    return postChunk<UploadResult>({
      fileType,
      originalFilename: file.name,
      records: rows,
    });
  }

  // Chunked: split into CHUNK_SIZE-record slices, upload sequentially
  const chunks: Record<string, unknown>[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    chunks.push(rows.slice(i, i + CHUNK_SIZE));
  }
  const totalChunks = chunks.length;

  // Chunk 0 — creates the upload document, returns uploadId
  const { uploadId } = await postChunk<{ uploadId: string }>({
    fileType,
    originalFilename: file.name,
    isChunked: true,
    chunkIndex: 0,
    totalChunks,
    records: chunks[0],
  });

  // Chunks 1 … totalChunks-1
  for (let i = 1; i < totalChunks; i++) {
    const result = await postChunk<UploadResult>({
      uploadId,
      fileType,
      chunkIndex: i,
      records: chunks[i],
    });
    if (i === totalChunks - 1) {
      return result;
    }
  }

  // Unreachable when totalChunks >= 2, but satisfies TypeScript
  throw new ApiError('Chunked upload completed without a final response', 500);
}

export interface UploadStatusEntry {
  fileType: string;
  label: string;
  recordCount: number | null;
  uploadedAt: string | null;
  uploadId: string | null;
  status: 'loaded' | 'not_loaded';
}

export function fetchUploadStatus(limit = 20): Promise<UploadStatusEntry[]> {
  return apiFetch<UploadStatusEntry[]>(`/upload-status?limit=${limit}`);
}

export function fetchConfig(): Promise<FirmConfig> {
  return apiFetch<FirmConfig>('/firm-config');
}

export function updateConfig(
  path: string,
  value: unknown,
): Promise<FirmConfig> {
  return apiFetch<FirmConfig>('/firm-config', {
    method: 'PATCH',
    body: JSON.stringify({ path, value }),
  });
}

export function exportPdf(
  dashboardId: DashboardId,
  filters?: DashboardFilters,
): Promise<Blob> {
  return apiFetchBlob(
    `/export/pdf/${dashboardId}${buildQuery(filters)}`,
  );
}

export function exportCsv(
  data: Record<string, unknown>[],
  columns: string[],
  filename: string,
): void {
  // Build CSV content client-side and trigger download
  const header = columns.join(',');
  const rows = data.map((row) =>
    columns
      .map((col) => {
        const val = row[col];
        if (val === null || val === undefined) return '';
        const str = String(val);
        // Escape values containing commas or quotes
        return str.includes(',') || str.includes('"')
          ? `"${str.replace(/"/g, '""')}"`
          : str;
      })
      .join(','),
  );
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
