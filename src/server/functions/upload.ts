/**
 * upload.ts — Netlify Function
 * POST /api/upload
 *
 * Accepts either:
 *   - multipart/form-data  { file: <binary>, fileType: <string> }  (from the frontend)
 *   - application/json     { fileType, originalFilename, parseResult, mappingSet }
 *
 * Receives file data, stores the raw upload in MongoDB, then runs the full
 * pipeline. Returns pipeline stats and data quality report.
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import { Readable } from 'stream';
import busboy from 'busboy';
import Papa from 'papaparse';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import { storeRawUpload, updateUploadStatus } from '../lib/mongodb-operations.js';
import { runFullPipeline } from '../pipeline/pipeline-orchestrator.js';
import { EntityType } from '../../shared/types/index.js';
import type { MappingSet, ColumnMapping } from '../../shared/mapping/types.js';
import type { ParseResult, ColumnInfo } from '../../client/parsers/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Valid file type keys (must match pipeline stage expectations)
const VALID_FILE_TYPES = new Set([
  'wipJson', 'fullMattersJson', 'closedMattersJson', 'feeEarner',
  'invoicesJson', 'contactsJson', 'disbursementsJson', 'tasksJson',
]);

// Frontend may omit the 'Json' suffix — normalise to the canonical key
const JSON_SUFFIX_MAP: Record<string, string> = {
  fullMatters:   'fullMattersJson',
  closedMatters: 'closedMattersJson',
  wip:           'wipJson',
  invoices:      'invoicesJson',
  contacts:      'contactsJson',
  disbursements: 'disbursementsJson',
  tasks:         'tasksJson',
};

const FILE_TYPE_TO_ENTITY: Record<string, EntityType> = {
  wipJson:           EntityType.TIME_ENTRY,
  fullMattersJson:   EntityType.MATTER,
  closedMattersJson: EntityType.MATTER,
  feeEarner:         EntityType.FEE_EARNER,
  invoicesJson:      EntityType.INVOICE,
  contactsJson:      EntityType.CLIENT,
  disbursementsJson: EntityType.DISBURSEMENT,
  tasksJson:         EntityType.TASK,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UploadRequestBody {
  fileType: string;
  originalFilename: string;
  parseResult: ParseResult;
  mappingSet: MappingSet;
  runFullPipeline?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeFileType(raw: string): string {
  if (VALID_FILE_TYPES.has(raw)) return raw;
  return JSON_SUFFIX_MAP[raw] ?? raw;
}

/**
 * Known Metabase/Yao column names that don't camelCase cleanly.
 * Applied after camelCase normalisation (key is the lowercased camelCase result).
 */
const COLUMN_OVERRIDES: Record<string, string> = {
  clients:   'clientIds',
  writeoff:  'writeOff',
  writtenoff: 'writtenOff',
  vat:       'vat',
};

/**
 * Converts any common column naming convention to camelCase:
 *   "Title Case With Spaces" → "titleCaseWithSpaces"
 *   "snake_case"             → "snakeCase"
 *   "PascalCase"             → "pascalCase"
 *   "alreadyCamel"           → "alreadyCamel"
 */
function normaliseToCamelCase(key: string): string {
  const trimmed = key.trim();

  // Split on spaces or underscores, then join as camelCase
  const words = trimmed.split(/[\s_]+/);
  const camel = words
    .map((word, i) =>
      i === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join('');

  // Check override map (lowercase the whole camelCase result for lookup)
  return COLUMN_OVERRIDES[camel.toLowerCase()] ?? camel;
}

/** Apply normaliseToCamelCase to every key in every record. */
function normaliseRecordKeys(
  records: Record<string, unknown>[],
): Record<string, unknown>[] {
  return records.map((record) =>
    Object.fromEntries(
      Object.entries(record).map(([k, v]) => [normaliseToCamelCase(k), v]),
    ),
  );
}

/** Extract file part and fileType field from a multipart/form-data body. */
async function parseMultipartBody(event: HandlerEvent): Promise<{
  fileType: string;
  filename: string;
  fileContent: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const contentType =
      event.headers['content-type'] ??
      event.headers['Content-Type'] ??
      '';

    const bb = busboy({ headers: { 'content-type': contentType } });

    let fileType = '';
    let filename = '';
    let fileBuffer: Buffer | null = null;

    bb.on('file', (_fieldname, fileStream, info) => {
      filename = info.filename;
      const chunks: Buffer[] = [];
      fileStream.on('data', (chunk: Buffer) => chunks.push(chunk));
      fileStream.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });

    bb.on('field', (name, value) => {
      if (name === 'fileType') fileType = value;
    });

    bb.on('finish', () => {
      if (!fileBuffer) {
        return reject(new Error('No file part found in multipart body'));
      }
      resolve({ fileType, filename, fileContent: fileBuffer });
    });

    bb.on('error', (err: Error) => reject(err));

    const bodyBuffer = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64')
      : Buffer.from(event.body ?? '', 'utf-8');

    const readable = new Readable();
    readable.push(bodyBuffer);
    readable.push(null);
    readable.pipe(bb);
  });
}

/** Derive minimal ColumnInfo array from the first row's keys. */
function buildColumns(rows: Record<string, unknown>[]): ColumnInfo[] {
  if (rows.length === 0) return [];
  return Object.keys(rows[0]).map((key) => ({
    originalHeader: key,
    detectedType: 'string' as const,
    sampleValues: rows.slice(0, 5).map((r) => String(r[key] ?? '')),
    nullCount: rows.filter((r) => r[key] == null || r[key] === '').length,
    totalCount: rows.length,
    nullPercent: rows.filter((r) => r[key] == null || r[key] === '').length / rows.length,
  }));
}

/** Build an identity MappingSet (rawColumn === mappedTo for every column). */
function buildIdentityMappingSet(
  fileType: string,
  rows: Record<string, unknown>[],
): MappingSet {
  const entityKey = FILE_TYPE_TO_ENTITY[fileType] ?? EntityType.MATTER;
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const mappings: ColumnMapping[] = columns.map((col) => ({
    rawColumn: col,
    mappedTo: col,
    entityKey,
    isRequired: false,
    confidence: 'auto' as const,
  }));
  return {
    fileType,
    entityKey,
    mappings,
    missingRequiredFields: [],
    unmappedColumns: [],
    customFieldSuggestions: [],
    isComplete: true,
  };
}

/** Parse file buffer into rows based on fileType, with column name normalisation. */
function parseFileContent(
  fileType: string,
  content: Buffer,
): Record<string, unknown>[] {
  const text = content.toString('utf-8');
  const trimmed = text.trimStart();

  // Detect format: content-first, then fall back to fileType convention.
  // Any file starting with '{' or '[' is treated as JSON regardless of fileType.
  // Anything else (including feeEarner and non-Json fileTypes) is treated as CSV.
  const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  const isJsonFileType = fileType.endsWith('Json');
  const treatAsJson = looksLikeJson || isJsonFileType;

  let rows: Record<string, unknown>[];

  if (treatAsJson) {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      rows = parsed as Record<string, unknown>[];
    } else if (parsed !== null && typeof parsed === 'object') {
      // Handle wrapped objects e.g. { data: [...] }
      const obj = parsed as Record<string, unknown>;
      const firstArray = Object.values(obj).find(Array.isArray);
      if (firstArray) {
        rows = firstArray as Record<string, unknown>[];
      } else {
        throw new Error('File content is not a JSON array');
      }
    } else {
      throw new Error('File content is not a JSON array');
    }
  } else {
    // CSV — feeEarner and any non-Json fileType
    const result = Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: true,
    });
    rows = result.data;
  }

  return normaliseRecordKeys(rows);
}

/** Build a complete ParseResult from raw rows. */
function buildParseResult(
  fileType: string,
  originalFilename: string,
  rows: Record<string, unknown>[],
): ParseResult {
  const columns = buildColumns(rows);
  return {
    fileType,
    originalFilename,
    rowCount: rows.length,
    columns,
    previewRows: rows.slice(0, 10),
    fullRows: rows,
    parseErrors: [],
    parsedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

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

    // ------------------------------------------------------------------
    // Multipart/form-data path
    // ------------------------------------------------------------------
    const contentType =
      event.headers['content-type'] ??
      event.headers['Content-Type'] ??
      '';

    if (contentType.includes('multipart/form-data')) {
      let multipart: { fileType: string; filename: string; fileContent: Buffer };
      try {
        multipart = await parseMultipartBody(event);
      } catch (err) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: `Multipart parse error: ${err instanceof Error ? err.message : String(err)}` }),
        };
      }

      const fileType = normalizeFileType(multipart.fileType);

      let rows: Record<string, unknown>[];
      try {
        rows = parseFileContent(fileType, multipart.fileContent);
      } catch (err) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: `File parse error: ${err instanceof Error ? err.message : String(err)}` }),
        };
      }

      body = {
        fileType,
        originalFilename: multipart.filename || `upload.${fileType === 'feeEarner' ? 'csv' : 'json'}`,
        parseResult: buildParseResult(fileType, multipart.filename, rows),
        mappingSet: buildIdentityMappingSet(fileType, rows),
        runFullPipeline: true,
      };

    } else {
      // ------------------------------------------------------------------
      // JSON body path (existing behaviour)
      // ------------------------------------------------------------------
      try {
        body = JSON.parse(event.body) as UploadRequestBody;
      } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
      }
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
      userId,
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
