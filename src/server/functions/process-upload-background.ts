/**
 * process-upload-background.ts — Netlify Background Function
 * POST /.netlify/functions/process-upload-background
 *
 * Triggered by upload.ts after Phase 1 (normalise + store) completes.
 * Runs Stages 3–7 (Cross-Reference → Index → Join → Enrich → Aggregate)
 * on the already-stored normalised dataset, then persists enriched entities
 * and KPIs and marks the upload as 'processed'.
 *
 * Background functions have up to 15 minutes to complete. The HTTP response
 * is not read by the caller — it fires and forgets.
 *
 * Authentication: shared secret via x-internal-secret header.
 */

import type { Handler } from '@netlify/functions';
import { runPipelineFromStored } from '../pipeline/pipeline-orchestrator.js';
import { updateUploadStatus } from '../lib/mongodb-operations.js';

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
    const result = await runPipelineFromStored({ firmId, uploadId, fileType });

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
