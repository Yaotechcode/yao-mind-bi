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

    const response = await fetch(`${this.baseUrl}/attorneys/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
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
   * @param resultKey Field in the response containing the records array
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

    if (pageKey === 'page') {
      let page = 1;
      while (true) {
        const response = await this.request<Record<string, unknown>>('POST', path, {
          body: { ...body, size, page },
        });

        const rows = (response[resultKey] ?? []) as T[];
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

        const response = await this.request<Record<string, unknown>>('POST', path, {
          body: requestBody,
        });

        const rows = (response[resultKey] ?? []) as T[];
        all.push(...rows);

        next = response['next'] ?? null;
        if (!next) break;
      }
    }

    return all;
  }
}
