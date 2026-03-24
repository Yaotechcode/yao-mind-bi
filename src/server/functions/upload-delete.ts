/**
 * upload-delete.ts — Netlify Function
 * DELETE /api/upload/:uploadId
 *
 * Soft-deletes a raw_upload record and removes its derived enriched entities.
 * Sets the recalculation flag so the formula engine (1C) re-runs.
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import {
  getUploadById,
  updateUploadStatus,
  deleteEnrichedEntitiesByType,
  setRecalculationFlag,
} from '../lib/mongodb-operations.js';

function extractId(path: string): string | null {
  const segments = path.replace(/\/$/, '').split('/');
  const last = segments[segments.length - 1];
  return last && last !== 'upload' ? last : null;
}

export const handler: Handler = async (event) => {
  try {
    const { firmId } = await authenticateRequest(event);

    if (event.httpMethod !== 'DELETE') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const uploadId = extractId(event.path ?? '');
    if (!uploadId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Upload ID is required' }) };
    }

    const upload = await getUploadById(firmId, uploadId);
    if (!upload) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Upload not found' }) };
    }

    // Soft-delete the raw upload record
    await updateUploadStatus(firmId, uploadId, 'deleted');

    // Remove derived enriched entities for this file type
    const FILE_TYPE_TO_ENTITY_KEY: Record<string, string> = {
      wipJson: 'timeEntry',
      fullMattersJson: 'matter',
      closedMattersJson: 'matter',
      feeEarner: 'feeEarner',
      invoicesJson: 'invoice',
      contactsJson: 'client',
      disbursementsJson: 'disbursement',
      tasksJson: 'task',
    };
    const entityKey = FILE_TYPE_TO_ENTITY_KEY[upload.file_type];
    if (entityKey) {
      await deleteEnrichedEntitiesByType(firmId, entityKey);
    }

    // Signal that KPIs need recalculation
    await setRecalculationFlag(firmId);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, message: 'Upload deleted and recalculation scheduled' }),
    };

  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[upload-delete]', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
