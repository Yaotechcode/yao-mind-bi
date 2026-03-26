/**
 * upload-status.ts — Netlify Function
 *
 * GET /api/upload-status?limit=20   → per-fileType load status for all known datasets
 * GET /api/upload-status/:uploadId  → single upload document
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { getUploadHistory, getUploadById } from '../lib/mongodb-operations.js';

// ---------------------------------------------------------------------------
// Dataset catalogue
// ---------------------------------------------------------------------------

interface DatasetMeta {
  fileType: string;
  label: string;
}

const DATASETS: DatasetMeta[] = [
  { fileType: 'feeEarner',         label: 'Fee Earners' },
  { fileType: 'wipJson',           label: 'WIP Entries' },
  { fileType: 'fullMattersJson',   label: 'Full Matters' },
  { fileType: 'closedMattersJson', label: 'Closed Matters' },
  { fileType: 'invoicesJson',      label: 'Invoices' },
  { fileType: 'contactsJson',      label: 'Contacts' },
  { fileType: 'disbursementsJson', label: 'Disbursements' },
  { fileType: 'tasksJson',         label: 'Tasks' },
  { fileType: 'lawyersJson',       label: 'Lawyers' },
];

// ---------------------------------------------------------------------------
// Response type
// ---------------------------------------------------------------------------

interface DatasetStatus {
  fileType: string;
  label: string;
  recordCount: number | null;
  uploadedAt: string | null;
  uploadId: string | null;
  status: 'loaded' | 'processing' | 'not_loaded';
}

// ---------------------------------------------------------------------------
// Routing helper
// ---------------------------------------------------------------------------

function extractUploadId(path: string): string | null {
  const segments = path.replace(/\/$/, '').split('/');
  const last = segments[segments.length - 1];
  return last && last !== 'upload-status' ? last : null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { firmId } = await authenticateRequest(event);

    // Single-upload lookup: GET /api/upload-status/:uploadId
    const uploadId = extractUploadId(event.path ?? '');
    if (uploadId) {
      const upload = await getUploadById(firmId, uploadId);
      if (!upload) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Upload not found' }) };
      }
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(upload),
      };
    }

    // Dataset status summary: GET /api/upload-status
    const limitParam = event.queryStringParameters?.['limit'];
    const limit = limitParam ? parseInt(limitParam, 10) : 20;

    // Fetch enough history to cover at least one entry per dataset type
    const history = await getUploadHistory(firmId, Math.max(limit, DATASETS.length * 3));

    // Pick the most recent upload per fileType — prefer 'processed', fall back to
    // 'processing' or 'pending' (pending = stored but background function not yet started)
    const latestProcessedByType = new Map<string, typeof history[number]>();
    const latestProcessingByType = new Map<string, typeof history[number]>();
    for (const upload of history) {
      if (upload.status === 'processed' && !latestProcessedByType.has(upload.file_type)) {
        latestProcessedByType.set(upload.file_type, upload);
      }
      if (
        (upload.status === 'processing' || upload.status === 'pending') &&
        !latestProcessingByType.has(upload.file_type)
      ) {
        latestProcessingByType.set(upload.file_type, upload);
      }
    }

    const result: DatasetStatus[] = DATASETS.map(({ fileType, label }) => {
      const processed = latestProcessedByType.get(fileType);
      if (processed) {
        return {
          fileType,
          label,
          recordCount: processed.record_count,
          uploadedAt: processed.upload_date instanceof Date
            ? processed.upload_date.toISOString()
            : new Date(processed.upload_date).toISOString(),
          uploadId: processed._id ? String(processed._id) : null,
          status: 'loaded',
        };
      }

      const inProgress = latestProcessingByType.get(fileType);
      if (inProgress) {
        return {
          fileType,
          label,
          recordCount: inProgress.record_count,
          uploadedAt: inProgress.upload_date instanceof Date
            ? inProgress.upload_date.toISOString()
            : new Date(inProgress.upload_date).toISOString(),
          uploadId: inProgress._id ? String(inProgress._id) : null,
          status: 'processing',
        };
      }

      return { fileType, label, recordCount: null, uploadedAt: null, uploadId: null, status: 'not_loaded' };
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };

  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[upload-status]', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
