/**
 * upload-status.ts — Netlify Function
 * GET /api/upload-status            → all uploads for this firm (newest first)
 * GET /api/upload-status/:uploadId  → single upload status
 */

import type { Handler } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { getUploadHistory, getUploadById } from '../lib/mongodb-operations.js';

function extractId(path: string): string | null {
  const segments = path.replace(/\/$/, '').split('/');
  const last = segments[segments.length - 1];
  return last && last !== 'upload-status' ? last : null;
}

export const handler: Handler = async (event) => {
  try {
    const { firmId } = await authenticateRequest(event);

    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const uploadId = extractId(event.path ?? '');

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

    const limit = parseInt(event.queryStringParameters?.['limit'] ?? '20', 10);
    const uploads = await getUploadHistory(firmId, limit);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(uploads),
    };

  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[upload-status]', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
