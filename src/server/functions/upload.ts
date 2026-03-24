/**
 * upload.ts — Netlify Function
 * POST /api/upload
 *
 * Receives parsed file data from the client, stores the raw upload in MongoDB,
 * then runs the full pipeline. Returns pipeline stats and data quality report.
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { storeRawUpload, updateUploadStatus } from '../lib/mongodb-operations.js';
import { runFullPipeline } from '../pipeline/pipeline-orchestrator.js';
import type { MappingSet } from '../../shared/mapping/types.js';
import type { ParseResult } from '../../client/parsers/types.js';

// Valid file type keys (must match pipeline stage expectations)
const VALID_FILE_TYPES = new Set([
  'wipJson', 'fullMattersJson', 'closedMattersJson', 'feeEarner',
  'invoicesJson', 'contactsJson', 'disbursementsJson', 'tasksJson',
]);

interface UploadRequestBody {
  fileType: string;
  originalFilename: string;
  parseResult: ParseResult;
  mappingSet: MappingSet;
  runFullPipeline?: boolean;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { firmId, userId } = await authenticateRequest(event);

    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Request body is required' }) };
    }

    let body: UploadRequestBody;
    try {
      body = JSON.parse(event.body) as UploadRequestBody;
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { fileType, originalFilename, parseResult, mappingSet, runFullPipeline: shouldRunPipeline = true } = body;

    // Validate required fields
    if (!fileType || typeof fileType !== 'string') {
      return { statusCode: 400, body: JSON.stringify({ error: '"fileType" is required' }) };
    }
    if (!VALID_FILE_TYPES.has(fileType)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `Unknown fileType "${fileType}". Valid values: ${[...VALID_FILE_TYPES].join(', ')}`,
        }),
      };
    }
    if (!originalFilename || typeof originalFilename !== 'string') {
      return { statusCode: 400, body: JSON.stringify({ error: '"originalFilename" is required' }) };
    }
    if (!parseResult || !Array.isArray(parseResult.fullRows)) {
      return { statusCode: 400, body: JSON.stringify({ error: '"parseResult.fullRows" is required' }) };
    }
    if (!mappingSet || !Array.isArray(mappingSet.mappings)) {
      return { statusCode: 400, body: JSON.stringify({ error: '"mappingSet.mappings" is required' }) };
    }

    // Store raw upload FIRST (before running pipeline)
    const uploadId = await storeRawUpload(
      firmId,
      fileType,
      originalFilename,
      parseResult.fullRows,
      userId
    );

    // Mark as processing
    await updateUploadStatus(firmId, uploadId, 'processing');

    // Dry run (validate only)
    if (!shouldRunPipeline) {
      const dryResult = await runFullPipeline({
        firmId,
        userId,
        uploadId,
        fileType,
        parseResult,
        mappingSet,
        dryRun: true,
      });

      await updateUploadStatus(firmId, uploadId, 'processed');

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          uploadId,
          message: 'Dry run complete — no data persisted',
          pipeline: {
            stagesCompleted: dryResult.stagesCompleted,
            warnings: dryResult.warnings,
            recordsProcessed: dryResult.recordsProcessed,
            recordsPersisted: 0,
            duration_ms: dryResult.duration_ms,
          },
          previewData: dryResult.previewData,
        }),
      };
    }

    // Full pipeline run
    const result = await runFullPipeline({
      firmId,
      userId,
      uploadId,
      fileType,
      parseResult,
      mappingSet,
      dryRun: false,
    });

    if (result.aborted) {
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          uploadId,
          message: 'Upload aborted — too many rows rejected during normalisation',
          pipeline: {
            stagesCompleted: result.stagesCompleted,
            warnings: result.warnings,
            recordsProcessed: result.recordsProcessed,
            recordsPersisted: 0,
            duration_ms: result.duration_ms,
          },
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        uploadId,
        message: `${fileType} uploaded and processed successfully`,
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
    console.error('[upload]', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
