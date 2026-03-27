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
import { storeRawUpload, storeRawUploadChunk, updateUploadStatus } from '../lib/mongodb-operations.js';
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

// Frontend may omit the 'Json' suffix, or send plural/alternate forms.
// All variants normalise to the canonical VALID_FILE_TYPES key.
const JSON_SUFFIX_MAP: Record<string, string> = {
  // Without 'Json' suffix
  fullMatters:    'fullMattersJson',
  closedMatters:  'closedMattersJson',
  wip:            'wipJson',
  invoices:       'invoicesJson',
  contacts:       'contactsJson',
  disbursements:  'disbursementsJson',
  tasks:          'tasksJson',
  // Plural / alternate forms
  feeEarners:     'feeEarner',
  lawyers:        'feeEarner',
  matters:        'fullMattersJson',
  closedmatters:  'closedMattersJson',
  lawyerTime:     'wipJson',
  unbilledwip:    'wipJson',
  invoice:        'invoicesJson',
  contact:        'contactsJson',
  disbursement:   'disbursementsJson',
  task:           'tasksJson',
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

/** Global overrides applied to all file types after camelCase normalisation. */
const GLOBAL_OVERRIDES: Record<string, string> = {
  clients:               'clientIds',
  writtenoff:            'writtenOff',
  vat:                   'vat',
  matterstatus:          'status',
  matterbudget:          'budget',
  tasktitle:             'title',
  taskdescription:       'description',
  feeshare:              'feeSharePercent',
  firmlead:              'firmLeadPercent',
  workingdaysweek:       'workingDaysPerWeek',
  attorneyid:            'id',
  wipunits:              'totalUnits',
  wipdurationminutes:    'totalDurationMinutes',
  responsiblelawyerid:   'responsibleLawyerId',
};

/** Per-fileType overrides applied AFTER global overrides. */
const FILE_TYPE_OVERRIDES: Record<string, Record<string, string>> = {
  feeEarner: {
    responsiblelawyer: 'name',
    writeoff:          'writeOffValue',
    billable:          'billableValue',
  },
  wipJson: {
    billable: 'billableValue',
    writeoff: 'writeOffValue',
  },
  invoicesJson: {
    writeoff: 'writeOff',
  },
  contactsJson: {
    id: 'contactId',
  },
};

/**
 * Converts any common column naming convention to camelCase:
 *   "Title Case With Spaces" → "titleCaseWithSpaces"
 *   "snake_case"             → "snakeCase"
 *   "PascalCase"             → "pascalCase"
 *   "Fee Share %"            → checked via lowercased camel against overrides
 *   "alreadyCamel"           → "alreadyCamel"
 *
 * Strips trailing '%' and '#' before processing.
 * Does NOT apply overrides — that is handled by normaliseRecordKeys.
 */
function normaliseToCamelCase(key: string): string {
  // Trim whitespace and trailing special characters
  const trimmed = key.trim().replace(/[%#]+$/, '');

  // Split on spaces or underscores, then join as camelCase
  const words = trimmed.split(/[\s_]+/);
  return words
    .map((word, i) =>
      i === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join('');
}

/** Apply camelCase normalisation and both override tiers to every key in every record. */
function normaliseRecordKeys(
  records: Record<string, unknown>[],
  fileType: string,
): Record<string, unknown>[] {
  const fileOverrides = FILE_TYPE_OVERRIDES[fileType] ?? {};
  return records.map((record) =>
    Object.fromEntries(
      Object.entries(record).map(([k, v]) => {
        const camel = normaliseToCamelCase(k);
        const lower = camel.toLowerCase();
        const key = GLOBAL_OVERRIDES[lower] ?? camel;
        const finalKey = fileOverrides[key.toLowerCase()] ?? key;
        return [finalKey, v];
      }),
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

/** Parse file buffer into rows based on content, with column name normalisation. */
function parseFileContent(
  fileType: string,
  content: Buffer,
): Record<string, unknown>[] {
  const text = content.toString('utf-8');
  const trimmed = text.trimStart();

  // Detect format by content only — files starting with '{' or '[' are JSON,
  // everything else (CSV, feeEarner, unknown types) goes through Papa.parse.
  const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  const treatAsJson = isJson;

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
    // CSV — feeEarner, unknown types, and any non-JSON content
    const result = Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: true,
    });
    rows = result.data;
  }

  return normaliseRecordKeys(rows, fileType);
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
// Background trigger helper
// ---------------------------------------------------------------------------

function fireBackground(uploadId: string, firmId: string, fileType: string): void {
  const siteUrl = process.env['URL'] ?? 'http://localhost:8888';
  const bgUrl = `${siteUrl}/.netlify/functions/process-upload-background`;
  const internalSecret = process.env['INTERNAL_API_SECRET'] ?? '';
  void fetch(bgUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': internalSecret },
    body: JSON.stringify({ uploadId, firmId, fileType }),
  }).catch((err: unknown) => {
    console.error('[upload] failed to trigger background function', err);
  });
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
      // JSON body path
      // ------------------------------------------------------------------
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(event.body) as Record<string, unknown>;
      } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
      }

      // ── Pre-parsed records path (client-side chunked upload) ────────────────
      // Body shape: { fileType, originalFilename?, records: [...], isChunked?, chunkIndex?, totalChunks?, uploadId? }
      if (Array.isArray(parsed['records'])) {
        const rawRecords = parsed['records'] as Record<string, unknown>[];
        const ft = normalizeFileType(typeof parsed['fileType'] === 'string' ? parsed['fileType'] : '');
        const isChunked   = parsed['isChunked']   === true;
        const chunkIndex  = typeof parsed['chunkIndex']  === 'number' ? parsed['chunkIndex']  : 0;
        const totalChunks = typeof parsed['totalChunks'] === 'number' ? parsed['totalChunks'] : 1;
        const existingUploadId = typeof parsed['uploadId'] === 'string' ? parsed['uploadId'] : null;
        const originalFilename = typeof parsed['originalFilename'] === 'string'
          ? parsed['originalFilename']
          : `upload.${ft === 'feeEarner' ? 'csv' : 'json'}`;

        if (!ft || !VALID_FILE_TYPES.has(ft)) {
          return { statusCode: 400, body: JSON.stringify({ error: `Unknown fileType "${ft}". Valid values: ${[...VALID_FILE_TYPES].join(', ')}` }) };
        }

        // Normalise record keys server-side (same as multipart path)
        const records = normaliseRecordKeys(rawRecords, ft);

        // ── Chunked: first chunk — create upload document, return uploadId ──
        if (isChunked && chunkIndex === 0) {
          const uploadId = await storeRawUpload(firmId, ft, originalFilename, records, userId, totalChunks);
          await updateUploadStatus(firmId, uploadId, 'processing');
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: true, uploadId, chunkIndex: 0, totalChunks }),
          };
        }

        // ── Chunked: subsequent chunk — append, fire background on final ────
        if (chunkIndex > 0 && existingUploadId) {
          const { chunksReceived, totalChunks: tc } = await storeRawUploadChunk(
            firmId, existingUploadId, chunkIndex, ft, records,
          );
          if (chunksReceived >= tc) {
            fireBackground(existingUploadId, firmId, ft);
            return {
              statusCode: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ success: true, uploadId: existingUploadId, status: 'processing', recordCount: tc * records.length }),
            };
          }
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: true, uploadId: existingUploadId, chunkIndex }),
          };
        }

        // ── Non-chunked: single records POST — store and fire immediately ───
        const uploadId = await storeRawUpload(firmId, ft, originalFilename, records, userId);
        await updateUploadStatus(firmId, uploadId, 'processing');
        fireBackground(uploadId, firmId, ft);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true, uploadId, status: 'processing', recordCount: records.length }),
        };
      }

      // ── Legacy parseResult/mappingSet body (reprocess, dry-run, internal callers) ──
      body = parsed as unknown as UploadRequestBody;
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

    // Dry run (validate only) — runs full pipeline synchronously, no persistence
    if (!shouldRunPipeline) {
      await updateUploadStatus(firmId, uploadId, 'processing');

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

    // Mark as processing before firing background task
    await updateUploadStatus(firmId, uploadId, 'processing');
    fireBackground(uploadId, firmId, fileType);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        uploadId,
        status: 'processing',
        message: `${fileType} received — ${parseResult.fullRows.length} records queued, pipeline running in background`,
        recordCount: parseResult.fullRows.length,
      }),
    };

  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[upload]', err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: err instanceof Error ? err.message : 'Internal server error',
        stack: process.env['NODE_ENV'] !== 'production'
          ? (err instanceof Error ? err.stack : undefined)
          : undefined,
      }),
    };
  }
};
