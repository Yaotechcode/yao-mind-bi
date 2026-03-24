/**
 * reprocess.ts — Netlify Function
 * POST /api/reprocess
 *
 * Re-runs the full pipeline for an existing upload using its stored raw_content
 * and a new (or updated) mappingSet supplied in the request body.
 * Useful when the user updates their column mapping and wants to re-derive
 * enriched data without re-uploading the file.
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { getUploadById, updateUploadStatus } from '../lib/mongodb-operations.js';
import { runFullPipeline } from '../pipeline/pipeline-orchestrator.js';
import type { MappingSet } from '../../shared/mapping/types.js';
import type { ParseResult } from '../../client/parsers/types.js';

export const handler: Handler = async (event) => {
  try {
    const { firmId, userId } = await authenticateRequest(event);

    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Request body is required' }) };
    }

    let body: { uploadId?: string; mappingSet?: MappingSet };
    try {
      body = JSON.parse(event.body) as { uploadId?: string; mappingSet?: MappingSet };
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { uploadId, mappingSet } = body;

    if (!uploadId || typeof uploadId !== 'string') {
      return { statusCode: 400, body: JSON.stringify({ error: '"uploadId" is required' }) };
    }
    if (!mappingSet || !Array.isArray(mappingSet.mappings)) {
      return { statusCode: 400, body: JSON.stringify({ error: '"mappingSet.mappings" is required' }) };
    }

    // Load the original upload
    const upload = await getUploadById(firmId, uploadId);
    if (!upload) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Upload not found' }) };
    }
    if (upload.status === 'deleted') {
      return { statusCode: 410, body: JSON.stringify({ error: 'Upload has been deleted and cannot be reprocessed' }) };
    }

    // Reconstruct a minimal ParseResult from stored raw content
    const parseResult: ParseResult = {
      fileType: 'json',
      originalFilename: upload.original_filename,
      rowCount: upload.raw_content.length,
      columns: [],
      previewRows: upload.raw_content.slice(0, 10),
      fullRows: upload.raw_content,
      parseErrors: [],
      parsedAt: new Date().toISOString(),
    };

    await updateUploadStatus(firmId, uploadId, 'processing');

    const result = await runFullPipeline({
      firmId,
      userId,
      uploadId,
      fileType: upload.file_type,
      parseResult,
      mappingSet,
      dryRun: false,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: !result.aborted,
        uploadId,
        message: result.aborted
          ? 'Reprocess aborted — too many rows rejected'
          : 'Reprocessed successfully',
        pipeline: {
          stagesCompleted: result.stagesCompleted,
          warnings: result.warnings,
          recordsProcessed: result.recordsProcessed,
          recordsPersisted: result.recordsPersisted,
          duration_ms: result.duration_ms,
        },
      }),
    };

  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[reprocess]', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
