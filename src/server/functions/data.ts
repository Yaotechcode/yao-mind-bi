/**
 * data.ts — Netlify Function
 * GET /api/data/* — read-only data retrieval endpoints
 *
 * All endpoints:
 *   1. Authenticate the request
 *   2. Derive firmId from the authenticated user
 *   3. Query MongoDB with firm_id isolation on every operation
 *   4. Return paginated/filtered results
 */

import type { Handler, HandlerResponse } from '@netlify/functions';
import { authenticateRequest, AuthError } from '../lib/auth-middleware.js';
import {
  getLatestEnrichedEntities,
  getLatestCalculatedKpis,
  getUploadHistory,
  getAllNormalisedDatasets,
} from '../lib/mongodb-operations.js';
import { successResponse, errorResponse, paginatedResponse } from '../lib/response-helpers.js';
import { applyFilters } from '../lib/data-filter.js';
import type { AggregateResult, AggregatedFeeEarner, AggregatedMatter } from '@shared/types/pipeline.js';
import type { EnrichedTimeEntry, EnrichedInvoice, EnrichedDisbursement } from '@shared/types/enriched.js';

// =============================================================================
// Types
// =============================================================================

export interface UploadHistorySummary {
  uploadId: string;
  fileType: string;
  originalFilename: string;
  uploadDate: string;
  status: string;
  recordCount: number;
  errorMessage?: string;
}

export interface WipAggregates {
  totalHours: number;
  totalChargeableHours: number;
  totalValue: number;
  orphanedHours: number;
  orphanedValue: number;
}

// =============================================================================
// Routing helper
// =============================================================================

function getDataPathSegments(path: string): string[] {
  const normalized = path.replace(/\/$/, '');
  const parts = normalized.split('/');
  const dataIdx = parts.findIndex(p => p === 'data');
  if (dataIdx === -1) return [];
  return parts.slice(dataIdx + 1).filter(Boolean);
}

// =============================================================================
// Pagination helper
// =============================================================================

function paginate<T>(
  records: T[],
  limitStr: string | null | undefined,
  offsetStr: string | null | undefined,
  defaultLimit = 500,
  maxLimit = 2000
): { data: T[]; total: number; limit: number; offset: number } {
  const limit = Math.min(
    Math.max(1, parseInt(limitStr ?? String(defaultLimit), 10)),
    maxLimit
  );
  const offset = Math.max(0, parseInt(offsetStr ?? '0', 10));
  return { data: records.slice(offset, offset + limit), total: records.length, limit, offset };
}

// =============================================================================
// Aggregate accessor helper
// =============================================================================

async function getAggregate(firmId: string): Promise<AggregateResult | null> {
  const doc = await getLatestCalculatedKpis(firmId);
  if (!doc?.kpis) return null;
  const kpis = doc.kpis as Record<string, unknown>;
  return (kpis['aggregate'] ?? null) as AggregateResult | null;
}

// =============================================================================
// WIP aggregates computation
// =============================================================================

function computeWipAggregates(entries: EnrichedTimeEntry[]): WipAggregates {
  let totalHours = 0;
  let totalChargeableHours = 0;
  let totalValue = 0;
  let orphanedHours = 0;
  let orphanedValue = 0;

  for (const entry of entries) {
    const hours = (entry.durationHours as number | null | undefined) ?? 0;
    const value = (entry.recordedValue as number | null | undefined) ?? 0;
    totalHours += hours;
    totalValue += value;
    if (entry.isChargeable) totalChargeableHours += hours;
    if (entry.hasMatchedMatter === false) {
      orphanedHours += hours;
      orphanedValue += value;
    }
  }

  return { totalHours, totalChargeableHours, totalValue, orphanedHours, orphanedValue };
}

// =============================================================================
// Handlers
// =============================================================================

async function handleFirmSummary(firmId: string): Promise<HandlerResponse> {
  const [kpisDoc, uploads, datasets] = await Promise.all([
    getLatestCalculatedKpis(firmId),
    getUploadHistory(firmId, 1),
    getAllNormalisedDatasets(firmId),
  ]);

  const availableEntities = Object.keys(datasets);
  const hasFirmData = availableEntities.length > 0;
  const aggregate = kpisDoc?.kpis
    ? (kpisDoc.kpis as Record<string, unknown>)['aggregate'] as AggregateResult | undefined
    : undefined;

  return successResponse({
    hasFirmData,
    availableEntities,
    dataVersion: kpisDoc?.data_version ?? null,
    lastUpdated: uploads[0]?.upload_date
      ? new Date(uploads[0].upload_date).toISOString()
      : null,
    dataQuality: aggregate?.dataQuality ?? null,
    aggregatedFirm: aggregate?.firm ?? null,
  });
}

async function handleFeeEarners(
  firmId: string,
  qp: Record<string, string | undefined>
): Promise<HandlerResponse> {
  const aggregate = await getAggregate(firmId);
  if (!aggregate) return successResponse([]);

  let records = aggregate.feeEarners as AggregatedFeeEarner[];
  if (qp['includeInactive'] !== 'true') {
    // Filter out fee earners with no recent activity (no wip entries)
    records = records.filter(fe => (fe.wipEntryCount ?? 0) > 0);
  }

  return successResponse(records);
}

async function handleFeeEarner(firmId: string, id: string): Promise<HandlerResponse> {
  const [aggregate, timeEntryDoc] = await Promise.all([
    getAggregate(firmId),
    getLatestEnrichedEntities(firmId, 'timeEntry'),
  ]);

  if (!aggregate) return successResponse(null);

  const feeEarner = aggregate.feeEarners.find(
    fe => fe.lawyerId === id || fe.lawyerName === id
  ) ?? null;

  if (!feeEarner) return successResponse(null);

  // Use the resolved identifier forms from the aggregate record so that time
  // entries are matched regardless of which form the URL id was in.
  const resolvedLawyerId = feeEarner.lawyerId;
  const resolvedLawyerName = feeEarner.lawyerName;

  const allTimeEntries = (timeEntryDoc?.records ?? []) as EnrichedTimeEntry[];
  const timeEntries = allTimeEntries.filter(te =>
    (resolvedLawyerId && te.lawyerId === resolvedLawyerId) ||
    (resolvedLawyerName && te.lawyerName === resolvedLawyerName)
  );

  return successResponse({ ...feeEarner, timeEntries });
}

async function handleMatters(
  firmId: string,
  qp: Record<string, string | undefined>
): Promise<HandlerResponse> {
  const aggregate = await getAggregate(firmId);
  if (!aggregate) return paginatedResponse([], 0, 500, 0);

  let records = aggregate.matters as AggregatedMatter[];

  // Cross-reference enriched matters for filtering by status/department/lawyerId
  const enrichedDoc = await getLatestEnrichedEntities(firmId, 'matter');
  const enrichedMatters = (enrichedDoc?.records ?? []) as Array<Record<string, unknown>>;

  // Build a lookup of matterNumber → enriched matter for metadata
  const enrichedByNumber = new Map<string, Record<string, unknown>>();
  for (const em of enrichedMatters) {
    if (typeof em['matterNumber'] === 'string') {
      enrichedByNumber.set(em['matterNumber'], em);
    }
    if (typeof em['matterId'] === 'string') {
      enrichedByNumber.set(em['matterId'], em);
    }
  }

  // Apply filters using enriched matter fields
  if (qp['status'] || qp['department'] || qp['lawyerId']) {
    records = records.filter(m => {
      // Skip unidentifiable records rather than silently matching against key ''
      if (!m.matterNumber && !m.matterId) return false;

      const em = (m.matterNumber ? enrichedByNumber.get(m.matterNumber) : undefined) ??
                 (m.matterId ? enrichedByNumber.get(m.matterId) : undefined) ?? {};

      if (qp['status']) {
        const status = em['matterStatus'] ?? em['status'];
        if (typeof status !== 'string' || status !== qp['status']) return false;
      }
      if (qp['department']) {
        const dept = em['department'];
        if (typeof dept !== 'string' || dept !== qp['department']) return false;
      }
      if (qp['lawyerId']) {
        const lid = em['responsibleLawyerId'] ?? em['lawyerId'];
        if (lid !== qp['lawyerId']) return false;
      }
      return true;
    });
  }

  const { data, total, limit, offset } = paginate(records, qp['limit'], qp['offset']);
  return paginatedResponse(data, total, limit, offset);
}

async function handleMatter(firmId: string, id: string): Promise<HandlerResponse> {
  const [aggregate, timeEntryDoc, invoiceDoc] = await Promise.all([
    getAggregate(firmId),
    getLatestEnrichedEntities(firmId, 'timeEntry'),
    getLatestEnrichedEntities(firmId, 'invoice'),
  ]);

  if (!aggregate) return successResponse(null);

  const matter = aggregate.matters.find(
    m => m.matterId === id || m.matterNumber === id
  ) ?? null;

  if (!matter) return successResponse(null);

  const allTimeEntries = (timeEntryDoc?.records ?? []) as EnrichedTimeEntry[];
  const allInvoices = (invoiceDoc?.records ?? []) as EnrichedInvoice[];

  // Use the resolved identifier forms from the aggregate record so that related
  // records are found regardless of which form the URL id was in.
  const resolvedMatterId = matter.matterId;
  const resolvedMatterNumber = matter.matterNumber;

  const timeEntries = allTimeEntries.filter(te =>
    (resolvedMatterId && te.matterId === resolvedMatterId) ||
    (resolvedMatterNumber && te.matterNumber === resolvedMatterNumber)
  );
  const invoices = allInvoices.filter(inv =>
    (resolvedMatterId && inv.matterId === resolvedMatterId) ||
    (resolvedMatterNumber && inv.matterNumber === resolvedMatterNumber)
  );

  return successResponse({ ...matter, timeEntries, invoices });
}

async function handleWip(
  firmId: string,
  qp: Record<string, string | undefined>
): Promise<HandlerResponse> {
  const doc = await getLatestEnrichedEntities(firmId, 'timeEntry');
  const allEntries = (doc?.records ?? []) as EnrichedTimeEntry[];

  const orphanedOnly = qp['orphanedOnly'] === 'true';

  const filtered = applyFilters(
    allEntries as unknown as Array<Record<string, unknown>>,
    {
      lawyerId: qp['lawyerId'],
      department: qp['department'],
      matterId: qp['matterId'],
      ...(orphanedOnly ? { hasMatchedMatter: false } : {}),
    },
    [
      { field: 'lawyerId', matchType: 'exact' },
      { field: 'department', matchType: 'exact' },
      { field: 'matterId', matchType: 'exact' },
      { field: 'hasMatchedMatter', matchType: 'boolean' },
    ]
  ) as unknown as EnrichedTimeEntry[];

  const aggregates = computeWipAggregates(filtered);
  const { data, total, limit, offset } = paginate(filtered, qp['limit'], qp['offset'], 1000);

  return successResponse({ entries: data, total, aggregates });
}

async function handleInvoices(
  firmId: string,
  qp: Record<string, string | undefined>
): Promise<HandlerResponse> {
  const doc = await getLatestEnrichedEntities(firmId, 'invoice');
  const allInvoices = (doc?.records ?? []) as EnrichedInvoice[];

  // Map 'status' query param to field filters
  let records = allInvoices;
  const status = qp['status'];
  if (status && status !== 'all') {
    if (status === 'overdue') {
      records = records.filter(inv => inv.isOverdue === true);
    } else if (status === 'outstanding') {
      records = records.filter(inv => {
        const outstanding = inv['outstanding'] as number | null | undefined;
        return (outstanding ?? 0) > 0 && inv.isOverdue !== true;
      });
    } else if (status === 'paid') {
      records = records.filter(inv => {
        const writtenOff = inv['writtenOff'];
        const outstanding = inv['outstanding'] as number | null | undefined;
        return (outstanding ?? 0) === 0 && writtenOff !== 1;
      });
    }
  }

  const filtered = applyFilters(
    records as unknown as Array<Record<string, unknown>>,
    {
      lawyerId: qp['lawyerId'],
      department: qp['department'],
    },
    [
      { field: 'lawyerId', matchType: 'exact' },
      { field: 'department', matchType: 'exact' },
    ]
  ) as unknown as EnrichedInvoice[];

  const { data, total, limit, offset } = paginate(filtered, qp['limit'], qp['offset']);
  return paginatedResponse(data, total, limit, offset);
}

async function handleClients(
  firmId: string,
  qp: Record<string, string | undefined>
): Promise<HandlerResponse> {
  const aggregate = await getAggregate(firmId);
  if (!aggregate) return paginatedResponse([], 0, 500, 0);

  const { data, total, limit, offset } = paginate(
    aggregate.clients,
    qp['limit'],
    qp['offset']
  );
  return paginatedResponse(data, total, limit, offset);
}

async function handleDepartments(firmId: string): Promise<HandlerResponse> {
  const aggregate = await getAggregate(firmId);
  if (!aggregate) return successResponse([]);
  return successResponse(aggregate.departments);
}

async function handleDisbursements(
  firmId: string,
  qp: Record<string, string | undefined>
): Promise<HandlerResponse> {
  const doc = await getLatestEnrichedEntities(firmId, 'disbursement');
  const allDisbursements = (doc?.records ?? []) as EnrichedDisbursement[];

  const filtered = applyFilters(
    allDisbursements as unknown as Array<Record<string, unknown>>,
    {
      matterId: qp['matterId'],
      lawyerId: qp['lawyerId'],
    },
    [
      { field: 'matterId', matchType: 'exact' },
      { field: 'lawyerId', matchType: 'exact' },
    ]
  ) as unknown as EnrichedDisbursement[];

  const { data, total, limit, offset } = paginate(filtered, qp['limit'], qp['offset']);
  return paginatedResponse(data, total, limit, offset);
}

async function handleDataQuality(firmId: string): Promise<HandlerResponse> {
  const aggregate = await getAggregate(firmId);
  if (!aggregate) return successResponse(null);
  return successResponse(aggregate.dataQuality);
}

async function handleUploadHistory(firmId: string): Promise<HandlerResponse> {
  const uploads = await getUploadHistory(firmId, 50);
  const summaries: UploadHistorySummary[] = uploads.map(u => ({
    uploadId: String(u['_id'] ?? ''),
    fileType: u.file_type,
    originalFilename: u.original_filename,
    uploadDate: new Date(u.upload_date).toISOString(),
    status: u.status,
    recordCount: u.record_count,
    ...(u.error_message ? { errorMessage: u.error_message } : {}),
  }));
  return successResponse(summaries);
}

// =============================================================================
// Main handler
// =============================================================================

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return errorResponse('Method not allowed', 405);
  }

  try {
    const { firmId } = await authenticateRequest(event);
    const segments = getDataPathSegments(event.path ?? '');
    const [resource, id] = segments;
    const qp = (event.queryStringParameters ?? {}) as Record<string, string | undefined>;

    switch (resource) {
      case 'firm-summary':   return handleFirmSummary(firmId);
      case 'fee-earners':    return handleFeeEarners(firmId, qp);
      case 'fee-earner':
        if (!id) return errorResponse('Missing fee earner ID', 400);
        return handleFeeEarner(firmId, id);
      case 'matters':        return handleMatters(firmId, qp);
      case 'matter':
        if (!id) return errorResponse('Missing matter ID', 400);
        return handleMatter(firmId, id);
      case 'wip':            return handleWip(firmId, qp);
      case 'invoices':       return handleInvoices(firmId, qp);
      case 'clients':        return handleClients(firmId, qp);
      case 'departments':    return handleDepartments(firmId);
      case 'disbursements':  return handleDisbursements(firmId, qp);
      case 'data-quality':   return handleDataQuality(firmId);
      case 'upload-history': return handleUploadHistory(firmId);
      default:               return errorResponse('Not found', 404);
    }
  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, body: JSON.stringify({ error: err.message }) };
    }
    console.error('[data]', err);
    return errorResponse('Internal server error', 500);
  }
};
