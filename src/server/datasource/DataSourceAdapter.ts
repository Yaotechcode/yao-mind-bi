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

  constructor(firmId: string) {
    this.firmId = firmId;
    this.baseUrl = requireEnv('YAO_API_BASE_URL');
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
    const { email, password } = await getCredentials(this.firmId);

    const code = Number(process.env['YAO_API_CODE']);

    const response = await fetch(`${this.baseUrl}/attorneys/login`, {
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

    const execute = () => fetch(url.toString(), init);

    let response = await execute();

    // 429 — wait and retry once
    if (response.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
      response = await execute();
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
   * @param path       API path, e.g. '/matters'
   * @param params     Base query params (page will be added/overwritten each iteration)
   * @param resultKey  Field in the response containing the records array
   * @param limit      Page size; used both as the request `limit` param and stop condition
   */
  async paginateGet<T>(
    path: string,
    params: Record<string, string>,
    resultKey: string,
    limit = 100,
  ): Promise<T[]> {
    const all: T[] = [];
    let page = 1;

    while (true) {
      const response = await this.request<Record<string, unknown>>('GET', path, {
        params: { ...params, page: String(page), limit: String(limit) },
      });

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
  // Lookup table fetchers
  // ---------------------------------------------------------------------------

  /**
   * Fetches all attorneys (active, pending, and disabled — needed for historical data).
   * Strips password and email_default_signature from every record before returning.
   */
  async fetchAttorneys(): Promise<YaoAttorney[]> {
    const raw = await this.request<Record<string, unknown>[]>('GET', '/attorneys');
    return raw.map((a) => stripNestedSensitiveFields(a)) as unknown as YaoAttorney[];
  }

  /**
   * Fetches all departments. Includes deleted ones — callers filter by is_deleted.
   */
  async fetchDepartments(): Promise<YaoDepartment[]> {
    return this.request<YaoDepartment[]>('GET', '/departments');
  }

  /**
   * Fetches active case types.
   */
  async fetchCaseTypes(): Promise<YaoCaseType[]> {
    return this.request<YaoCaseType[]>('GET', '/case-types/active');
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
        email: a.email,
        status: a.status,
        defaultRate: a.rates?.find((r) => r.default)?.value ?? null,
        allRates: a.rates ?? [],
        integrationAccountId: a.integration_account_id ?? null,
        integrationAccountCode: a.integration_account_code ?? null,
        jobTitle: a.job_title ?? null,
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
   * Strips password and email_default_signature from any nested attorney objects.
   */
  async fetchMatters(): Promise<YaoMatter[]> {
    const raw = await this.paginateGet<Record<string, unknown>>(
      '/matters',
      {},
      'rows',
      50,
    );
    return raw.map((m) => stripNestedSensitiveFields(m)) as unknown as YaoMatter[];
  }

  // ---------------------------------------------------------------------------
  // Time entries
  // ---------------------------------------------------------------------------

  /**
   * Fetches time entries via cursor pagination (POST /time-entries/search).
   * Strips password and email_default_signature from assignee objects.
   * Excludes CONSOLIDATED and CONSOLIDATION_TARGET records — only ACTIVE entries
   * are relevant for KPI calculation. If a future firm config option requires
   * including consolidated entries, add an options param here and pass it through.
   */
  async fetchTimeEntries(): Promise<YaoTimeEntry[]> {
    const raw = await this.paginatePost<Record<string, unknown>>(
      '/time-entries/search',
      {},
      'result',
      'page',
      50,
    );
    return raw
      .map((e) => stripNestedSensitiveFields(e) as unknown as YaoTimeEntry)
      .filter((e) => e.status === 'ACTIVE');
  }

  // ---------------------------------------------------------------------------
  // Invoices
  // ---------------------------------------------------------------------------

  /**
   * Fetches all invoices via page-based pagination.
   * POST /invoices/search returns a root-level array — resultKey is ''.
   * All statuses are included (DRAFT, ISSUED, PAID, CREDITED, WRITTEN_OFF, CANCELED).
   */
  async fetchInvoices(): Promise<YaoInvoice[]> {
    return this.paginatePost<YaoInvoice>(
      '/invoices/search',
      {},
      '',       // root-level array response — no wrapper key
      'page',
      50,
    );
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
   * Fetches OFFICE_PAYMENT, CLIENT_TO_OFFICE, and OFFICE_RECEIPT ledger records
   * via page-based pagination. Response is a root-level array.
   */
  async fetchLedgers(): Promise<YaoLedger[]> {
    return this.paginatePost<YaoLedger>(
      '/ledgers/search',
      {},
      '',       // root-level array response
      'page',
      50,
    );
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
   * Excludes DELETED tasks. Strips sensitive fields from assigned_to.
   */
  async fetchTasks(): Promise<YaoTask[]> {
    const raw = await this.paginateGet<Record<string, unknown>>(
      '/tasks',
      {},
      'rows',
      50,
    );
    return raw
      .map((t) => stripNestedSensitiveFields(t) as unknown as YaoTask)
      .filter((t) => t.status !== 'DELETED');
  }

  // ---------------------------------------------------------------------------
  // Contacts
  // ---------------------------------------------------------------------------

  /**
   * Fetches active (non-archived) contacts via page-based GET pagination.
   */
  async fetchContacts(): Promise<YaoContact[]> {
    return this.paginateGet<YaoContact>(
      '/contacts',
      { is_archived: 'false' },
      'rows',
      50,
    );
  }

  // ---------------------------------------------------------------------------
  // fetchAll — full pull orchestration
  // ---------------------------------------------------------------------------

  /**
   * Executes a complete data pull for a firm in three sequential steps:
   *
   * Step 1 — Lookup tables (sequential prerequisite):
   *   attorneys, departments, case types fetched in parallel; maps built.
   *
   * Step 2 — Transactional data (all in parallel — independent of each other):
   *   matters, time entries, invoices, raw ledgers, tasks, contacts.
   *
   * Step 3 — Summary + routing (fast, single calls):
   *   invoice summary (single GET), ledger routing (pure function).
   *
   * Returns a single object containing all datasets and lookup maps.
   */
  async fetchAll(): Promise<{
    attorneys: YaoAttorney[];
    departments: YaoDepartment[];
    caseTypes: YaoCaseType[];
    matters: YaoMatter[];
    timeEntries: YaoTimeEntry[];
    invoices: YaoInvoice[];
    ledgers: RoutedLedgers;
    tasks: YaoTask[];
    contacts: YaoContact[];
    invoiceSummary: YaoInvoiceSummary;
    maps: {
      attorneyMap: AttorneyMap;
      departmentMap: DepartmentMap;
      caseTypeMap: CaseTypeMap;
    };
  }> {
    // Step 1: lookup tables — must complete before transactional fetches
    const { attorneys, departments, caseTypes, attorneyMap, departmentMap, caseTypeMap } =
      await this.fetchLookupTables();

    // Step 2: all transactional datasets in parallel
    const [matters, timeEntries, invoices, rawLedgers, tasks, contacts] = await Promise.all([
      this.fetchMatters(),
      this.fetchTimeEntries(),
      this.fetchInvoices(),
      this.fetchLedgers(),
      this.fetchTasks(),
      this.fetchContacts(),
    ]);

    // Step 3: summary + routing
    const [invoiceSummary] = await Promise.all([this.fetchInvoiceSummary()]);
    const ledgers = this.routeLedgers(rawLedgers);

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
      ledgers,
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
