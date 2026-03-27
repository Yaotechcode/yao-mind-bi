/**
 * process-upload-background.ts — Netlify Background Function
 * POST /.netlify/functions/process-upload-background
 *
 * Triggered by upload.ts after the raw file is stored.
 * Runs ALL pipeline stages (2–7):
 *   Stage 2: Normalise  — from raw_uploads record
 *   Stage 3: Cross-Reference
 *   Stage 4: Index
 *   Stage 5: Join
 *   Stage 6: Enrich
 *   Stage 7: Aggregate
 * Persists normalised dataset, enriched entities, and KPIs, then marks
 * the upload as 'processed'.
 *
 * Background functions have up to 15 minutes to complete. The HTTP response
 * is not read by the caller — it fires and forgets.
 *
 * Authentication: shared secret via x-internal-secret header.
 */

import type { Handler } from '@netlify/functions';
import { normaliseFromRaw, runPipelineFromStored } from '../pipeline/pipeline-orchestrator.js';
import { getRawUpload, storeNormalisedDataset, updateUploadStatus } from '../lib/mongodb-operations.js';

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Verify internal shared secret
  const internalSecret = process.env['INTERNAL_API_SECRET'] ?? '';
  const provided = event.headers['x-internal-secret'] ?? '';
  if (!internalSecret || provided !== internalSecret) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let uploadId: string | undefined;
  let firmId: string | undefined;
  let fileType: string | undefined;

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>;
    uploadId = typeof body['uploadId'] === 'string' ? body['uploadId'] : undefined;
    firmId   = typeof body['firmId']   === 'string' ? body['firmId']   : undefined;
    fileType = typeof body['fileType'] === 'string' ? body['fileType'] : undefined;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!uploadId || !firmId || !fileType) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'uploadId, firmId, and fileType are required' }),
    };
  }

  try {
    // ── Stage 2: Normalise ────────────────────────────────────────────────────
    // Fetch raw records stored by upload.ts, then normalise in-process.
    const rawRecords = await getRawUpload(firmId, uploadId);
    if (!rawRecords) {
      await updateUploadStatus(firmId, uploadId, 'error', `Raw upload not found: ${uploadId}`);
      return { statusCode: 404, body: JSON.stringify({ error: 'Raw upload not found', uploadId }) };
    }

    const normaliseResult = normaliseFromRaw({ fileType, rawRecords });

    if (normaliseResult.aborted) {
      await updateUploadStatus(firmId, uploadId, 'error', normaliseResult.abortReason);
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, aborted: true, reason: normaliseResult.abortReason, uploadId }),
      };
    }

    await storeNormalisedDataset(
      firmId,
      fileType,
      normaliseResult.entityKey,
      normaliseResult.normaliseResult.records,
      uploadId,
    );

    // ── Stages 3–7 + persist ──────────────────────────────────────────────────
    const result = await runPipelineFromStored({ firmId, uploadId, fileType });

    await updateUploadStatus(firmId, uploadId, 'processed');

    console.log(
      `[process-upload-background] firmId=${firmId} uploadId=${uploadId} fileType=${fileType}`,
      `stages=${result.stagesCompleted.join(',')}`,
      `records=${result.recordsProcessed}`,
      `duration=${result.duration_ms}ms`,
    );

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, uploadId, stagesCompleted: result.stagesCompleted }),
    };

  } catch (err) {
    console.error('[process-upload-background] pipeline error', { firmId, uploadId, fileType, err });

    // Best-effort status update — don't let a secondary failure mask the first
    try {
      if (firmId && uploadId) {
        await updateUploadStatus(firmId, uploadId, 'error');
      }
    } catch (updateErr) {
      console.error('[process-upload-background] failed to update upload status', updateErr);
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Pipeline failed', uploadId }),
    };
  }
};
