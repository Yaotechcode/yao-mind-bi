/**
 * DataSourceAdapter.ts
 *
 * Orchestrates all Yao API interactions for one pull of one firm.
 * Instantiate once per pull: new DataSourceAdapter(firmId)
 * Then call authenticate() before any data-fetch methods.
 *
 * Rules enforced here:
 *  - Credentials and tokens are never logged
 *  - authenticate() re-fetches credentials on every pull — tokens are never cached
 *  - Every request carries the Authorization: Bearer header
 *  - 429 → wait 2 s → retry once
 *  - 401 mid-pull → YaoAuthExpiredError (token expired)
 *  - 5xx → YaoApiError
 */

import { getCredentials } from '../services/credential-service.js';
import {
  YaoAuthError,
  YaoAuthExpiredError,
  YaoApiError,
  YaoRateLimitError,
} from './errors.js';
import type { FirmConfig } from '../../shared/types/index.js';
import type {
  YaoAttorney,
  YaoDepartment,
  YaoCaseType,
  YaoMatter,
  YaoTimeEntry,
  YaoInvoice,
  YaoInvoiceSummary,
  YaoLedger,
  RoutedLedgers,
  YaoTask,
  YaoContact,
  AttorneyMap,
  DepartmentMap,
  CaseTypeMap,
  LookupTables,
} from './types.js';
import {
  pruneArray,
  ATTORNEY_KEEP_FIELDS,
  DEPARTMENT_KEEP_FIELDS,
  CASE_TYPE_KEEP_FIELDS,
  MATTER_KEEP_FIELDS,
  TIME_ENTRY_KEEP_FIELDS,
  INVOICE_KEEP_FIELDS,
  LEDGER_KEEP_FIELDS,
  TASK_KEEP_FIELDS,
  CONTACT_KEEP_FIELDS,
} from './pruner.js';

// =============================================================================
// Helpers
// =============================================================================

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

/**
 * Searches a response object for the JWT token.
 * Checks common key names first, then falls back to any key containing 'token'.
 */
function extractToken(body: Record<string, unknown>): string | null {
  const preferred = ['access_token', 'token', 'jwt', 'accessToken', 'authToken'];
  for (const key of preferred) {
    if (typeof body[key] === 'string' && body[key]) return body[key] as string;
  }
  // Fallback: any key containing 'token' (case-insensitive)
  for (const key of Object.keys(body)) {
    if (key.toLowerCase().includes('token') && typeof body[key] === 'string' && body[key]) {
      return body[key] as string;
    }
  }
  return null;
}

const RATE_LIMIT_WAIT_MS = 2000;

const SENSITIVE_FIELDS = ['password', 'email_default_signature'] as const;

/**
 * Recursively strips sensitive fields from an object and any nested objects/arrays.
 * Used to sanitise matters (which embed attorney sub-objects) before returning.
 */
function stripNestedSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripNestedSensitiveFields);
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      if (SENSITIVE_FIELDS.includes(key as typeof SENSITIVE_FIELDS[number])) continue;
      result[key] = stripNestedSensitiveFields(obj[key]);
    }
    return result;
  }
  return value;
}

// =============================================================================
// DataSourceAdapter
// =============================================================================

export class DataSourceAdapter {
  private readonly firmId: string;
  private token: string | null = null;
  private readonly baseUrl: string;
  private readonly _warnings: string[] = [];
  private readonly REQUEST_TIMEOUT_MS = 45_000;

  constructor(firmId: string) {
    this.firmId = firmId;
    this.baseUrl = requireEnv('YAO_API_BASE_URL');
  }

  /** Returns any non-fatal warnings accumulated during the pull (e.g. early pagination stop). */
  getWarnings(): string[] {
    return [...this._warnings];
  }

  // ---------------------------------------------------------------------------
  // Timeout-aware fetch + helpers
  // ---------------------------------------------------------------------------

  /**
   * Wraps the global fetch with an AbortController timeout.
   * Throws a plain Error with "Request timed out after Xs: <url>" on timeout
   * so callers can distinguish it from other network errors.
   */
  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Request timed out after ${this.REQUEST_TIMEOUT_MS / 1000}s: ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Returns true when err is a timeout thrown by fetchWithTimeout. */
  private static isTimeoutError(err: unknown): boolean {
    return err instanceof Error && err.message.startsWith('Request timed out after');
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  /**
   * Fetches credentials from the encrypted store and authenticates against the
   * Yao API. Stores the JWT for use in subsequent requests.
   * Must be called before any data-fetch method.
   * Never logs credentials or token values.
   */
  async authenticate(): Promise<void> {
    const { email, password, code } = await getCredentials(this.firmId);

    const response = await this.fetchWithTimeout(`${this.baseUrl}/attorneys/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, code }),
    });

    if (!response.ok) {
      throw new YaoAuthError(
        `Yao API login failed with status ${response.status}`,
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new YaoAuthError('Yao API login response was not valid JSON');
    }

    const token = extractToken(body);
    if (!token) {
      throw new YaoAuthError(
        'Yao API login succeeded but no token found in response',
      );
    }

    this.token = token;
  }

  // ---------------------------------------------------------------------------
  // Core request
  // ---------------------------------------------------------------------------

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options?: { params?: Record<string, string>; body?: object },
  ): Promise<T> {
    if (!this.token) {
      throw new Error('DataSourceAdapter: call authenticate() before making requests');
    }

    const url = new URL(`${this.baseUrl}${path}`);
    if (options?.params) {
      for (const [k, v] of Object.entries(options.params)) {
        url.searchParams.set(k, v);
      }
    }

    const init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
    };
    if (method === 'POST' && options?.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }

    const urlString = url.toString();
    const executeWithTimeout = () => this.fetchWithTimeout(urlString, init);

    let response = await executeWithTimeout();

    // 429 — wait and retry once
    if (response.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
      response = await executeWithTimeout();
      if (response.status === 429) {
        throw new YaoRateLimitError(path);
      }
    }

    // 401 mid-pull — token expired
    if (response.status === 401) {
      throw new YaoAuthExpiredError();
    }

    // 5xx
    if (response.status >= 500) {
      throw new YaoApiError(
        `Yao API server error on ${method} ${path}: ${response.status}`,
        response.status,
      );
    }

    // Other non-2xx
    if (!response.ok) {
      throw new YaoApiError(
        `Yao API error on ${method} ${path}: ${response.status}`,
        response.status,
      );
    }

    return response.json() as Promise<T>;
  }

  // ---------------------------------------------------------------------------
  // Pagination helpers
  // ---------------------------------------------------------------------------

  /**
   * Paginated GET: increments `page` param, stops when result array < limit.
   * @param path              API path, e.g. '/matters'
   * @param params            Base query params (page will be added/overwritten each iteration)
   * @param resultKey         Field in the response containing the records array
   * @param limit             Page size; used both as the request `limit` param and stop condition
   * @param stopOnServerError When true, a 5xx on any page logs a warning and stops pagination
   *                          rather than throwing. Use for endpoints known to 500 on later pages.
   */
  async paginateGet<T>(
    path: string,
    params: Record<string, string>,
    resultKey: string,
    limit = 100,
    stopOnServerError = false,
  ): Promise<T[]> {
    const all: T[] = [];
    let page = 1;

    while (true) {
      let response: Record<string, unknown>;
      try {
        response = await this.request<Record<string, unknown>>('GET', path, {
          params: { ...params, page: String(page), limit: String(limit) },
        });
      } catch (err) {
        if (stopOnServerError && err instanceof YaoApiError && err.statusCode >= 500) {
          const msg = `${path} page ${page} returned ${err.statusCode} — stopping pagination early with ${all.length} records`;
          console.warn(`[DataSourceAdapter] WARNING: ${msg}`);
          this._warnings.push(msg);
          break;
        }
        throw err;
      }

      const rows = (response[resultKey] ?? []) as T[];
      all.push(...rows);

      if (rows.length < limit) break;
      page++;
    }

    return all;
  }

  /**
   * Paginated POST with either page-based or cursor-based pagination.
   *
   * pageKey='page': increments a `page` field in the body, stops when result < size.
   * pageKey='next':  cursor pagination — passes the `next` value from the previous
   *                  response back into the body, stops when `next` is absent/null.
   *
   * @param path      API path, e.g. '/time-entries/search'
   * @param body      Base request body (page/next will be merged in each iteration)
   * @param resultKey Field in the response containing the records array.
   *                  Pass '' (empty string) when the response itself is a root-level
   *                  array rather than a wrapped object (e.g. POST /invoices/search).
   * @param pageKey   Pagination strategy: 'page' or 'next'
   * @param size      Page size; used as request `size` param and stop condition for page-mode
   */
  async paginatePost<T>(
    path: string,
    body: object,
    resultKey: string,
    pageKey: 'page' | 'next',
    size = 100,
  ): Promise<T[]> {
    const all: T[] = [];

    // Helper: extract the records array from a response.
    // When resultKey is '' the response IS the array (root-level array response).
    const extractRows = (response: unknown): T[] => {
      if (resultKey === '') return (response as T[] | null) ?? [];
      return ((response as Record<string, unknown>)[resultKey] ?? []) as T[];
    };

    if (pageKey === 'page') {
      let page = 1;
      while (true) {
        const response = await this.request<unknown>('POST', path, {
          body: { ...body, size, page },
        });

        const rows = extractRows(response);
        all.push(...rows);

        if (rows.length < size) break;
        page++;
      }
    } else {
      // Cursor pagination
      let next: unknown = undefined;
      while (true) {
        const requestBody: Record<string, unknown> = { ...body, size };
        if (next !== undefined && next !== null) requestBody['next'] = next;

        const response = await this.request<unknown>('POST', path, {
          body: requestBody,
        });

        const rows = extractRows(response);
        all.push(...rows);

        next = (response as Record<string, unknown>)?.['next'] ?? null;
        if (!next) break;
      }
    }

    return all;
  }

  // ---------------------------------------------------------------------------
  // Parallel pagination helpers (batch=5 concurrent pages)
  // ---------------------------------------------------------------------------

  /**
   * Parallel page-based GET pagination.
   * Phase A fetches page 1. If a full page is returned, Phase B fetches the next
   * `batchSize` pages concurrently and repeats until a short/null page is found.
   * This significantly reduces wall-clock time for endpoints with many pages.
   *
   * @param stopOnServerError  When true, a 5xx on any page returns null for that
   *                           page (stops that batch) rather than throwing.
   */
  private async parallelPaginateGet<T>(
    path: string,
    params: Record<string, string>,
    resultKey: string,
    limit = 50,
    stopOnServerError = false,
    batchSize = 5,
  ): Promise<T[]> {
    const all: T[] = [];

    // Phase A: page 1
    let firstRows: T[];
    try {
      const response = await this.request<Record<string, unknown>>('GET', path, {
        params: { ...params, page: '1', limit: String(limit) },
      });
      firstRows = (response[resultKey] ?? []) as T[];
    } catch (err) {
      const isTimeout = DataSourceAdapter.isTimeoutError(err);
      if (isTimeout || (stopOnServerError && err instanceof YaoApiError && (err as YaoApiError).statusCode >= 500)) {
        const reason = isTimeout ? 'timed out' : `returned ${(err as YaoApiError).statusCode}`;
        const msg = `${path} page 1 ${reason} — stopping pagination early with 0 records`;
        console.warn(`[DataSourceAdapter] WARNING: ${msg}`);
        this._warnings.push(msg);
        return [];
      }
      throw err;
    }
    all.push(...firstRows);
    if (firstRows.length < limit) return all;

    // Phase B: batches of batchSize concurrent pages
    let nextPage = 2;
    while (true) {
      const pageNumbers = Array.from({ length: batchSize }, (_, i) => nextPage + i);

      const results = await Promise.all(
        pageNumbers.map(async (p): Promise<T[] | null> => {
          try {
            const response = await this.request<Record<string, unknown>>('GET', path, {
              params: { ...params, page: String(p), limit: String(limit) },
            });
            return (response[resultKey] ?? []) as T[];
          } catch (err) {
            const isTimeout = DataSourceAdapter.isTimeoutError(err);
            if (isTimeout || (stopOnServerError && err instanceof YaoApiError && (err as YaoApiError).statusCode >= 500)) {
              const reason = isTimeout ? 'timed out' : `returned ${(err as YaoApiError).statusCode}`;
              const msg = `${path} page ${p} ${reason} — stopping pagination early`;
              console.warn(`[DataSourceAdapter] WARNING: ${msg}`);
              this._warnings.push(msg);
              return null;
            }
            throw err;
          }
        }),
      );

      let done = false;
      for (let i = 0; i < results.length; i++) {
        const rows = results[i];
        if (rows === null) {
          // Retry this page once sequentially before stopping
          const timedOutPage = pageNumbers[i];
          console.log(`[DataSourceAdapter] retrying ${path} page ${timedOutPage} sequentially after timeout`);
          try {
            const retryResponse = await this.request<Record<string, unknown>>('GET', path, {
              params: { ...params, page: String(timedOutPage), limit: String(limit) },
            });
            const retryRows = (retryResponse[resultKey] ?? []) as T[];
            all.push(...retryRows);
            if (retryRows.length < limit) { done = true; break; }
            // Full page on retry — continue processing remaining batch results
          } catch (retryErr) {
            const msg = `${path} page ${timedOutPage} failed on retry — stopping pagination`;
            console.warn(`[DataSourceAdapter] WARNING: ${msg}`);
            this._warnings.push(msg);
            done = true;
            break;
          }
        } else {
          all.push(...rows);
          if (rows.length < limit) { done = true; break; }
        }
      }
      if (done) break;
      nextPage += batchSize;
    }

    return all;
  }

  /**
   * Parallel page-based POST pagination.
   * Same two-phase strategy as parallelPaginateGet but uses POST with a `page`
   * field in the request body. Supports root-level array responses (resultKey='').
   */
  private async parallelPaginatePost<T>(
    path: string,
    body: object,
    resultKey: string,
    size = 50,
    batchSize = 5,
  ): Promise<T[]> {
    const all: T[] = [];

    const extractRows = (response: unknown): T[] => {
      if (resultKey === '') return (response as T[] | null) ?? [];
      return ((response as Record<string, unknown>)[resultKey] ?? []) as T[];
    };

    // Phase A: page 1
    const response1 = await this.request<unknown>('POST', path, {
      body: { ...body, size, page: 1 },
    });
    const firstRows = extractRows(response1);
    all.push(...firstRows);
    if (firstRows.length < size) return all;

    // Phase B: batches of batchSize concurrent pages
    let nextPage = 2;
    while (true) {
      const pageNumbers = Array.from({ length: batchSize }, (_, i) => nextPage + i);

      const results = await Promise.all(
        pageNumbers.map(async (p): Promise<T[] | null> => {
          try {
            const response = await this.request<unknown>('POST', path, {
              body: { ...body, size, page: p },
            });
            return extractRows(response);
          } catch (err) {
            if (DataSourceAdapter.isTimeoutError(err)) {
              const msg = `${path} page ${p} timed out — stopping pagination early`;
              console.warn(`[DataSourceAdapter] WARNING: ${msg}`);
              this._warnings.push(msg);
              return null;
            }
            throw err;
          }
        }),
      );

      let done = false;
      for (let i = 0; i < results.length; i++) {
        const rows = results[i];
        if (rows === null) {
          // Retry this page once sequentially before stopping
          const timedOutPage = pageNumbers[i];
          console.log(`[DataSourceAdapter] retrying ${path} page ${timedOutPage} sequentially after timeout`);
          try {
            const retryResponse = await this.request<unknown>('POST', path, {
              body: { ...body, size, page: timedOutPage },
            });
            const retryRows = extractRows(retryResponse);
            all.push(...retryRows);
            if (retryRows.length < size) { done = true; break; }
            // Full page on retry — continue processing remaining batch results
          } catch (retryErr) {
            const msg = `${path} page ${timedOutPage} failed on retry — stopping pagination`;
            console.warn(`[DataSourceAdapter] WARNING: ${msg}`);
            this._warnings.push(msg);
            done = true;
            break;
          }
        } else {
          all.push(...rows);
          if (rows.length < size) { done = true; break; }
        }
      }
      if (done) break;
      nextPage += batchSize;
    }

    return all;
  }

  // ---------------------------------------------------------------------------
  // Lookup table fetchers
  // ---------------------------------------------------------------------------

  /**
   * Fetches all attorneys (active, pending, and disabled — needed for historical data).
   * Prunes to keep only fields needed for KPI calculation.
   */
  async fetchAttorneys(): Promise<YaoAttorney[]> {
    const raw = await this.request<Record<string, unknown>[]>('GET', '/attorneys');
    const pruned = pruneArray(raw, ATTORNEY_KEEP_FIELDS) as unknown as YaoAttorney[];
    const active = pruned.filter(
      (a) => (a.status as string)?.toLowerCase() === 'active'
    );
    console.log(
      `[fetchAttorneys] total=${pruned.length} active=${active.length} ` +
      `disabled=${pruned.length - active.length}`
    );
    return active;
  }

  /**
   * Fetches all departments. Includes deleted ones — callers filter by is_deleted.
   */
  async fetchDepartments(): Promise<YaoDepartment[]> {
    const raw = await this.request<Record<string, unknown>[]>('GET', '/departments');
    return pruneArray(raw, DEPARTMENT_KEEP_FIELDS) as unknown as YaoDepartment[];
  }

  /**
   * Fetches active case types.
   */
  async fetchCaseTypes(): Promise<YaoCaseType[]> {
    const raw = await this.request<Record<string, unknown>[]>('GET', '/case-types/active');
    return pruneArray(raw, CASE_TYPE_KEEP_FIELDS) as unknown as YaoCaseType[];
  }

  // ---------------------------------------------------------------------------
  // Map builders (pure — no network calls)
  // ---------------------------------------------------------------------------

  buildAttorneyMap(attorneys: YaoAttorney[]): AttorneyMap {
    const map: AttorneyMap = {};
    for (const a of attorneys) {
      map[a._id] = {
        fullName: `${a.name} ${a.surname}`,
        firstName: a.name,
        lastName: a.surname,
        status: a.status,
        defaultRate: a.rates?.find((r) => r.default)?.value ?? null,
        allRates: a.rates ?? [],
        jobTitle: a.job_title ?? null,
        email: a.email ?? null,
        integrationAccountId: a.integration_account_id ?? null,
      };
    }
    return map;
  }

  buildDepartmentMap(departments: YaoDepartment[]): DepartmentMap {
    const map: DepartmentMap = {};
    for (const d of departments) {
      if (!d.is_deleted) map[d._id] = d.title;
    }
    return map;
  }

  buildCaseTypeMap(caseTypes: YaoCaseType[]): CaseTypeMap {
    const map: CaseTypeMap = {};
    for (const ct of caseTypes) {
      map[ct._id] = {
        title: ct.title,
        departmentId: ct.department._id,
        departmentTitle: ct.department.title,
        isFixedFee: (ct.fixed_fee ?? 0) > 0,
        fixedFeeValue: ct.fixed_fee ?? null,
      };
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // Matters
  // ---------------------------------------------------------------------------

  /**
   * Fetches all matters via page-based pagination.
   * Prunes to keep only fields needed for KPI calculation. Also strips any
   * sensitive nested fields (password, email_default_signature) as a belt-and-suspenders measure.
   */
  async fetchMatters(): Promise<YaoMatter[]> {
    const raw = await this.parallelPaginateGet<Record<string, unknown>>('/matters', {}, 'rows', 50);
    const pruned = pruneArray(raw, MATTER_KEEP_FIELDS);
    return pruned.map(m => stripNestedSensitiveFields(m)) as unknown as YaoMatter[];
  }

  // ---------------------------------------------------------------------------
  // Time entries
  // ---------------------------------------------------------------------------

  /**
   * Fetches time entries via page-based pagination (POST /time-entries/search).
   * Excludes CONSOLIDATED and CONSOLIDATION_TARGET records — only ACTIVE entries
   * are relevant for KPI calculation. Status is filtered on raw records before pruning.
   * @param fromDate  Optional ISO date string ('YYYY-MM-DD') to limit results to records on/after this date.
   */
  async fetchTimeEntries(fromDate?: string): Promise<YaoTimeEntry[]> {
    const body: Record<string, unknown> = {};
    if (fromDate) body['date_from'] = fromDate;
    const raw = await this.parallelPaginatePost<Record<string, unknown>>(
      '/time-entries/search',
      body,
      'result',
      50,
      3, // batchSize=3: reduces concurrent load on later pages (400+)
    );
    // Filter for ACTIVE before pruning (status field is not in the pruned shape)
    const active = raw.filter(e => e['status'] === 'ACTIVE');
    const pageCount = Math.ceil(raw.length / 50);
    console.log(`[fetchTimeEntries] fetched ${raw.length} total entries across ~${pageCount} pages (${active.length} ACTIVE)`);
    return pruneArray(active, TIME_ENTRY_KEEP_FIELDS)
      .map(e => stripNestedSensitiveFields(e)) as unknown as YaoTimeEntry[];
  }

  // ---------------------------------------------------------------------------
  // Invoices
  // ---------------------------------------------------------------------------

  /**
   * Fetches all invoices via page-based pagination.
   * POST /invoices/search returns a root-level array — resultKey is ''.
   * All statuses are included (DRAFT, ISSUED, PAID, CREDITED, WRITTEN_OFF, CANCELED).
   * @param fromDate  Optional ISO date string ('YYYY-MM-DD') to limit results to records on/after this date.
   */
  async fetchInvoices(fromDate?: string): Promise<YaoInvoice[]> {
    const body: Record<string, unknown> = {};
    if (fromDate) body['date_from'] = fromDate;
    const raw = await this.parallelPaginatePost<Record<string, unknown>>(
      '/invoices/search',
      body,
      '',       // root-level array response — no wrapper key
      50,
    );
    return pruneArray(raw, INVOICE_KEEP_FIELDS) as unknown as YaoInvoice[];
  }

  /**
   * Fetches the invoice summary totals for a firm (single call, no pagination).
   * Returns { unpaid, paid, total }.
   */
  async fetchInvoiceSummary(): Promise<YaoInvoiceSummary> {
    return this.request<YaoInvoiceSummary>('GET', '/invoices/summary');
  }

  // ---------------------------------------------------------------------------
  // Ledgers
  // ---------------------------------------------------------------------------

  /**
   * Fetches ledger records via page-based pagination with client-side filtering applied
   * per page to reduce peak memory usage.
   *
   * Filters applied in order after each page is pruned:
   *   1. Type filter  — keep only OFFICE_PAYMENT, CLIENT_TO_OFFICE, OFFICE_RECEIPT
   *   2. Archived matter filter — discard records whose matter is in archivedMatterIds
   *   3. Old-recovered filter — for OFFICE_PAYMENT only: discard if outstanding=0 AND date < fromDate
   *
   * Logs reduction statistics after all pages complete.
   *
   * @param fromDate          ISO date string ('YYYY-MM-DD'). Passed as date_from to the API and
   *                          used as the cutoff for the old-recovered filter. Defaults to '' (no cutoff).
   * @param archivedMatterIds Set of matter._id values for archived matters to exclude.
   */
  async fetchLedgers(
    fromDate: string = '',
    archivedMatterIds: Set<string> = new Set(),
  ): Promise<YaoLedger[]> {
    const KEPT_TYPES = new Set(['OFFICE_PAYMENT', 'CLIENT_TO_OFFICE', 'OFFICE_RECEIPT']);
    const LIMIT = 50;
    const BATCH_SIZE = 5;

    const requestBody: Record<string, unknown> = {};
    if (fromDate) requestBody['date_from'] = fromDate;

    let total = 0;
    let typeDiscarded = 0;
    let archivedDiscarded = 0;
    let oldRecoveredDiscarded = 0;
    const all: YaoLedger[] = [];

    /** Prune then apply all three client-side filters. Mutates the counters. */
    const filterPage = (raw: Record<string, unknown>[]): YaoLedger[] => {
      const pruned = pruneArray(raw, LEDGER_KEEP_FIELDS) as unknown as YaoLedger[];
      total += raw.length;
      const kept: YaoLedger[] = [];
      for (const r of pruned) {
        if (!KEPT_TYPES.has(r.type)) { typeDiscarded++; continue; }
        if (r.matter?._id && archivedMatterIds.has(r.matter._id)) { archivedDiscarded++; continue; }
        if (
          r.type === 'OFFICE_PAYMENT' &&
          r.outstanding === 0 &&
          fromDate !== '' &&
          r.date < fromDate
        ) {
          oldRecoveredDiscarded++;
          continue;
        }
        kept.push(r);
      }
      return kept;
    };

    const extractRows = (response: unknown): Record<string, unknown>[] =>
      (response as Record<string, unknown>[] | null) ?? [];

    // Phase A: page 1
    const response1 = await this.request<unknown>('POST', '/ledgers/search', {
      body: { ...requestBody, size: LIMIT, page: 1 },
    });
    const rawFirstPage = extractRows(response1);
    all.push(...filterPage(rawFirstPage));

    if (rawFirstPage.length >= LIMIT) {
      // Phase B: batches of BATCH_SIZE concurrent pages
      let nextPage = 2;
      while (true) {
        const pageNumbers = Array.from({ length: BATCH_SIZE }, (_, i) => nextPage + i);
        const results = await Promise.all(
          pageNumbers.map(async (p): Promise<Record<string, unknown>[] | null> => {
            try {
              const res = await this.request<unknown>('POST', '/ledgers/search', {
                body: { ...requestBody, size: LIMIT, page: p },
              });
              return extractRows(res);
            } catch (err) {
              if (DataSourceAdapter.isTimeoutError(err)) {
                const msg = `/ledgers/search page ${p} timed out — stopping pagination early`;
                console.warn(`[DataSourceAdapter] WARNING: ${msg}`);
                this._warnings.push(msg);
                return null;
              }
              throw err;
            }
          }),
        );
        let done = false;
        for (const rawPage of results) {
          if (rawPage === null) { done = true; break; }
          all.push(...filterPage(rawPage));
          if (rawPage.length < LIMIT) { done = true; break; }
        }
        if (done) break;
        nextPage += BATCH_SIZE;
      }
    }

    const kept = all.length;
    console.log(
      `[fetchLedgers] fetched ${total} total | kept ${kept} ` +
      `(type filter: -${typeDiscarded}, archived: -${archivedDiscarded}, ` +
      `old-recovered: -${oldRecoveredDiscarded})`,
    );

    return all;
  }

  /**
   * Routes ledger records into three destination buckets.
   * Pure function — no async, no side effects.
   *
   * Routing rules:
   *   OFFICE_PAYMENT                                   → disbursements
   *   CLIENT_TO_OFFICE | OFFICE_RECEIPT:
   *     invoice populated, disbursements empty         → invoicePayments
   *     disbursements[] populated, invoice empty       → disbursementRecoveries
   *     BOTH invoice AND disbursements[] populated     → BOTH lists (same record)
   *     NEITHER                                        → discarded (logged)
   */
  routeLedgers(ledgers: YaoLedger[]): RoutedLedgers {
    const result: RoutedLedgers = {
      disbursements: [],
      invoicePayments: [],
      disbursementRecoveries: [],
    };

    let discarded = 0;

    for (const ledger of ledgers) {
      if (ledger.type === 'OFFICE_PAYMENT') {
        result.disbursements.push(ledger);
        continue;
      }

      if (ledger.type === 'CLIENT_TO_OFFICE' || ledger.type === 'OFFICE_RECEIPT') {
        const hasInvoice = !!ledger.invoice;
        const hasDisbursements = Array.isArray(ledger.disbursements) && ledger.disbursements.length > 0;

        if (!hasInvoice && !hasDisbursements) {
          discarded++;
          continue;
        }

        if (hasInvoice) result.invoicePayments.push(ledger);
        if (hasDisbursements) result.disbursementRecoveries.push(ledger);
        continue;
      }

      // Any type outside the three fetched types — should not occur, but discard safely
      discarded++;
    }

    if (discarded > 0) {
      console.log(`[DataSourceAdapter] routeLedgers: discarded ${discarded} unroutable ledger record(s)`);
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------------

  /**
   * Fetches tasks via page-based GET pagination.
   * Excludes DELETED tasks. Prunes to keep only fields needed for KPI calculation.
   */
  async fetchTasks(): Promise<YaoTask[]> {
    const raw = await this.parallelPaginateGet<Record<string, unknown>>(
      '/tasks',
      {},
      'rows',
      50,
      true, // stopOnServerError: Yao API returns 500 on page 3
    );
    // Filter DELETED before pruning (status is in TASK_KEEP_FIELDS so can filter after too, but safer before)
    const notDeleted = raw.filter(t => t['status'] !== 'DELETED');
    return pruneArray(notDeleted, TASK_KEEP_FIELDS)
      .map(t => stripNestedSensitiveFields(t)) as unknown as YaoTask[];
  }

  // ---------------------------------------------------------------------------
  // Contacts
  // ---------------------------------------------------------------------------

  /**
   * Fetches active (non-archived) contacts via page-based GET pagination.
   * Prunes to keep only fields needed for KPI calculation.
   */
  async fetchContacts(): Promise<YaoContact[]> {
    const raw = await this.parallelPaginateGet<Record<string, unknown>>(
      '/contacts',
      { is_archived: 'false' },
      'rows',
      50,
    );
    return pruneArray(raw, CONTACT_KEEP_FIELDS) as unknown as YaoContact[];
  }

  // ---------------------------------------------------------------------------
  // fetchAll — full pull orchestration
  // ---------------------------------------------------------------------------

  /**
   * Executes a complete data pull for a firm in three sequential steps.
   * Ledgers are excluded — they must be fetched separately via fetchLedgers()
   * after this call returns, to avoid holding all large arrays in memory simultaneously.
   *
   * Step 1 — Lookup tables (sequential prerequisite):
   *   attorneys, departments, case types fetched in parallel; maps built.
   *
   * Step 2 — Transactional data (parallel, excluding ledgers):
   *   matters, time entries, invoices, tasks, contacts.
   *
   * Step 3 — Summary (single call):
   *   invoice summary.
   *
   * @param firmConfig  Optional firm config. dataPullLookbackMonths controls how far
   *                    back time entries and invoices are fetched (default: 3).
   */
  async fetchAll(firmConfig?: Partial<FirmConfig>): Promise<{
    attorneys: YaoAttorney[];
    departments: YaoDepartment[];
    caseTypes: YaoCaseType[];
    matters: YaoMatter[];
    timeEntries: YaoTimeEntry[];
    invoices: YaoInvoice[];
    tasks: YaoTask[];
    contacts: YaoContact[];
    invoiceSummary: YaoInvoiceSummary;
    maps: {
      attorneyMap: AttorneyMap;
      departmentMap: DepartmentMap;
      caseTypeMap: CaseTypeMap;
    };
  }> {
    // Calculate lookback date for transactional datasets
    const lookbackMonths = firmConfig?.dataPullLookbackMonths ?? 3;
    const fromDate = new Date();
    fromDate.setMonth(fromDate.getMonth() - lookbackMonths);
    const dateFrom = fromDate.toISOString().split('T')[0];

    // Step 1: lookup tables — must complete before transactional fetches
    const { attorneys, departments, caseTypes, attorneyMap, departmentMap, caseTypeMap } =
      await this.fetchLookupTables();

    // Step 2: transactional datasets in parallel (ledgers fetched separately by caller)
    const [matters, timeEntries, invoices, tasks, contacts] = await Promise.all([
      this.fetchMatters(),
      this.fetchTimeEntries(dateFrom),
      this.fetchInvoices(dateFrom),
      this.fetchTasks(),
      this.fetchContacts(),
    ]);

    // Step 3: invoice summary
    const invoiceSummary = await this.fetchInvoiceSummary();

    console.log(
      `[DataSourceAdapter] fetchAll complete — matters: ${matters.length}, ` +
        `timeEntries: ${timeEntries.length}, invoices: ${invoices.length}, ` +
        `tasks: ${tasks.length}, contacts: ${contacts.length}`,
    );

    return {
      attorneys,
      departments,
      caseTypes,
      matters,
      timeEntries,
      invoices,
      tasks,
      contacts,
      invoiceSummary,
      maps: { attorneyMap, departmentMap, caseTypeMap },
    };
  }

  // ---------------------------------------------------------------------------
  // fetchLookupTables — orchestrates all three in parallel
  // ---------------------------------------------------------------------------

  /**
   * Fetches attorneys, departments, and case types in parallel and builds
   * all three in-memory maps. Call this at the start of every pull, before
   * fetching transactional data.
   */
  async fetchLookupTables(): Promise<LookupTables> {
    const [attorneys, departments, caseTypes] = await Promise.all([
      this.fetchAttorneys(),
      this.fetchDepartments(),
      this.fetchCaseTypes(),
    ]);

    console.log(
      `[DataSourceAdapter] Lookup tables fetched — attorneys: ${attorneys.length}, ` +
        `departments: ${departments.length}, caseTypes: ${caseTypes.length}`,
    );

    return {
      attorneys,
      departments,
      caseTypes,
      attorneyMap: this.buildAttorneyMap(attorneys),
      departmentMap: this.buildDepartmentMap(departments),
      caseTypeMap: this.buildCaseTypeMap(caseTypes),
    };
  }
}
