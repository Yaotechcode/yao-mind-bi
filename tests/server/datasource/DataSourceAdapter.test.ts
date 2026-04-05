import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// credential-service mock — hoisted before imports that use it
// =============================================================================

const { mockGetCredentials } = vi.hoisted(() => ({
  mockGetCredentials: vi.fn(),
}));

vi.mock('../../../src/server/services/credential-service.js', () => ({
  getCredentials: mockGetCredentials,
}));

// =============================================================================
// Imports (after mocks)
// =============================================================================

import { DataSourceAdapter } from '../../../src/server/datasource/DataSourceAdapter.js';
import {
  YaoAuthError,
  YaoAuthExpiredError,
  YaoApiError,
  YaoRateLimitError,
} from '../../../src/server/datasource/errors.js';

// =============================================================================
// fetch mock
// =============================================================================

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  process.env['YAO_API_BASE_URL'] = 'https://api.yao.legal';
  process.env['YAO_API_CODE']     = '12345';
  mockGetCredentials.mockResolvedValue({ email: 'test@firm.com', password: 'secret' });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env['YAO_API_BASE_URL'];
  delete process.env['YAO_API_CODE'];
});

// =============================================================================
// Helpers
// =============================================================================

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// =============================================================================
// authenticate()
// =============================================================================

describe('authenticate()', () => {
  it('extracts token from access_token field', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ access_token: 'tok-abc' }));
    const adapter = new DataSourceAdapter('firm-1');
    await expect(adapter.authenticate()).resolves.not.toThrow();
  });

  it('extracts token from token field', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ token: 'tok-xyz' }));
    const adapter = new DataSourceAdapter('firm-1');
    await expect(adapter.authenticate()).resolves.not.toThrow();
  });

  it('extracts token from jwt field', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ jwt: 'tok-jwt' }));
    const adapter = new DataSourceAdapter('firm-1');
    await expect(adapter.authenticate()).resolves.not.toThrow();
  });

  it('extracts token from accessToken field', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ accessToken: 'tok-at' }));
    const adapter = new DataSourceAdapter('firm-1');
    await expect(adapter.authenticate()).resolves.not.toThrow();
  });

  it('extracts token from authToken field', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ authToken: 'tok-auth' }));
    const adapter = new DataSourceAdapter('firm-1');
    await expect(adapter.authenticate()).resolves.not.toThrow();
  });

  it('extracts token from an arbitrary key containing "token"', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ bearerToken: 'tok-bearer' }));
    const adapter = new DataSourceAdapter('firm-1');
    await expect(adapter.authenticate()).resolves.not.toThrow();
  });

  it('throws YaoAuthError on non-2xx login response', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ error: 'bad creds' }, 401));
    const adapter = new DataSourceAdapter('firm-1');
    await expect(adapter.authenticate()).rejects.toThrow(YaoAuthError);
  });

  it('throws YaoAuthError when no token found in response', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ user: { id: '123' } }));
    const adapter = new DataSourceAdapter('firm-1');
    await expect(adapter.authenticate()).rejects.toThrow(YaoAuthError);
  });

  it('sends code from credentials in login body', async () => {
    mockGetCredentials.mockResolvedValueOnce({ email: 'test@firm.com', password: 'secret', code: 99887 });
    mockFetch.mockResolvedValueOnce(makeResponse({ access_token: 'tok' }));
    const adapter = new DataSourceAdapter('firm-1');
    await adapter.authenticate();

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['code']).toBe(99887);
    expect(body['email']).toBe('test@firm.com');
    expect(body['password']).toBe('secret');
  });

  it('code is a number (not a string) in login body', async () => {
    mockGetCredentials.mockResolvedValueOnce({ email: 'test@firm.com', password: 'secret', code: 42 });
    mockFetch.mockResolvedValueOnce(makeResponse({ access_token: 'tok' }));
    const adapter = new DataSourceAdapter('firm-1');
    await adapter.authenticate();

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(typeof body['code']).toBe('number');
    expect(body['code']).toBe(42);
  });

  it('never logs credentials or token values', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy    = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy    = vi.spyOn(console, 'info').mockImplementation(() => {});

    mockFetch.mockResolvedValueOnce(makeResponse({ access_token: 'supersecret-token' }));
    const adapter = new DataSourceAdapter('firm-1');
    await adapter.authenticate();

    const allLogs = [
      ...consoleSpy.mock.calls.flat(),
      ...warnSpy.mock.calls.flat(),
      ...infoSpy.mock.calls.flat(),
    ].join(' ');

    expect(allLogs).not.toContain('secret');
    expect(allLogs).not.toContain('supersecret-token');
    expect(allLogs).not.toContain('test@firm.com');
  });
});

// =============================================================================
// request() — Authorization header
// =============================================================================

describe('request() Authorization header', () => {
  it('sends Bearer token on subsequent requests', async () => {
    // authenticate
    mockFetch.mockResolvedValueOnce(makeResponse({ access_token: 'my-token' }));
    // data request
    mockFetch.mockResolvedValueOnce(makeResponse({ rows: [] }));

    const adapter = new DataSourceAdapter('firm-1');
    await adapter.authenticate();
    // Access paginateGet to trigger request()
    await adapter.paginateGet('/matters', {}, 'rows', 100);

    const [, requestInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    const headers = requestInit.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer my-token');
  });

  it('throws if request() called before authenticate()', async () => {
    const adapter = new DataSourceAdapter('firm-1');
    await expect(adapter.paginateGet('/matters', {}, 'rows')).rejects.toThrow(
      'call authenticate() before making requests',
    );
  });
});

// =============================================================================
// paginateGet()
// =============================================================================

describe('paginateGet()', () => {
  async function authenticatedAdapter(): Promise<DataSourceAdapter> {
    mockFetch.mockResolvedValueOnce(makeResponse({ access_token: 'tok' }));
    const adapter = new DataSourceAdapter('firm-1');
    await adapter.authenticate();
    return adapter;
  }

  it('returns all records across multiple pages', async () => {
    const adapter = await authenticatedAdapter();

    // Page 1: full page
    mockFetch.mockResolvedValueOnce(makeResponse({ rows: Array(5).fill({ id: 1 }) }));
    // Page 2: partial — signals last page
    mockFetch.mockResolvedValueOnce(makeResponse({ rows: [{ id: 2 }] }));

    const results = await adapter.paginateGet('/matters', {}, 'rows', 5);
    expect(results).toHaveLength(6);
    expect(mockFetch).toHaveBeenCalledTimes(3); // 1 auth + 2 pages
  });

  it('stops after a single page when result < limit', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({ rows: [{ id: 1 }, { id: 2 }] }));

    const results = await adapter.paginateGet('/matters', {}, 'rows', 100);
    expect(results).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2); // 1 auth + 1 page
  });

  it('stops immediately when result array is empty', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({ rows: [] }));

    const results = await adapter.paginateGet('/matters', {}, 'rows', 100);
    expect(results).toHaveLength(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('passes limit and page as query params', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({ items: [] }));

    await adapter.paginateGet('/contacts', { tag: '' }, 'items', 50);

    const [url] = mockFetch.mock.calls[1] as [string];
    expect(url).toContain('limit=50');
    expect(url).toContain('page=1');
    expect(url).toContain('tag=');
  });
});

// =============================================================================
// paginatePost() — cursor pagination
// =============================================================================

describe('paginatePost() cursor (next)', () => {
  async function authenticatedAdapter(): Promise<DataSourceAdapter> {
    mockFetch.mockResolvedValueOnce(makeResponse({ access_token: 'tok' }));
    const adapter = new DataSourceAdapter('firm-1');
    await adapter.authenticate();
    return adapter;
  }

  it('follows cursor until next is absent', async () => {
    const adapter = await authenticatedAdapter();

    mockFetch.mockResolvedValueOnce(makeResponse({ result: [{ id: 1 }], next: 100 }));
    mockFetch.mockResolvedValueOnce(makeResponse({ result: [{ id: 2 }], next: 200 }));
    mockFetch.mockResolvedValueOnce(makeResponse({ result: [{ id: 3 }] })); // no next

    const results = await adapter.paginatePost('/time-entries/search', {}, 'result', 'next');
    expect(results).toHaveLength(3);
    expect(mockFetch).toHaveBeenCalledTimes(4); // 1 auth + 3 pages
  });

  it('stops immediately when first response has no next', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({ result: [{ id: 1 }] }));

    const results = await adapter.paginatePost('/time-entries/search', {}, 'result', 'next');
    expect(results).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('sends next cursor in subsequent request body', async () => {
    const adapter = await authenticatedAdapter();

    mockFetch.mockResolvedValueOnce(makeResponse({ result: [{ id: 1 }], next: 42 }));
    mockFetch.mockResolvedValueOnce(makeResponse({ result: [] }));

    await adapter.paginatePost('/time-entries/search', { size: 100 }, 'result', 'next');

    const secondCall = mockFetch.mock.calls[2] as [string, RequestInit];
    const sentBody = JSON.parse(secondCall[1].body as string) as Record<string, unknown>;
    expect(sentBody['next']).toBe(42);
  });
});

// =============================================================================
// paginatePost() — page-based
// =============================================================================

describe('paginatePost() page-based', () => {
  async function authenticatedAdapter(): Promise<DataSourceAdapter> {
    mockFetch.mockResolvedValueOnce(makeResponse({ access_token: 'tok' }));
    const adapter = new DataSourceAdapter('firm-1');
    await adapter.authenticate();
    return adapter;
  }

  it('increments page and stops when result < size', async () => {
    const adapter = await authenticatedAdapter();

    mockFetch.mockResolvedValueOnce(makeResponse({ result: Array(3).fill({ id: 1 }) }));
    mockFetch.mockResolvedValueOnce(makeResponse({ result: [{ id: 2 }] }));

    const results = await adapter.paginatePost('/invoices/search', {}, 'result', 'page', 3);
    expect(results).toHaveLength(4);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

// =============================================================================
// 429 retry logic
// =============================================================================

describe('429 retry logic', () => {
  it('retries once after 2s delay on 429', async () => {
    vi.useFakeTimers();

    mockFetch.mockResolvedValueOnce(makeResponse({ access_token: 'tok' }));
    // First attempt 429, second attempt succeeds
    mockFetch.mockResolvedValueOnce(makeResponse({}, 429));
    mockFetch.mockResolvedValueOnce(makeResponse({ rows: [] }));

    const adapter = new DataSourceAdapter('firm-1');
    await adapter.authenticate();

    const resultPromise = adapter.paginateGet('/matters', {}, 'rows');

    // Advance past the 2 s wait
    await vi.advanceTimersByTimeAsync(2000);
    const results = await resultPromise;

    expect(results).toHaveLength(0);
    // 2 data fetches (429 + retry) after 1 auth
    expect(mockFetch).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it('throws YaoRateLimitError when retry also returns 429', async () => {
    vi.useFakeTimers();

    mockFetch.mockResolvedValueOnce(makeResponse({ access_token: 'tok' }));
    mockFetch.mockResolvedValueOnce(makeResponse({}, 429));
    mockFetch.mockResolvedValueOnce(makeResponse({}, 429));

    const adapter = new DataSourceAdapter('firm-1');
    await adapter.authenticate();

    const resultPromise = adapter.paginateGet('/matters', {}, 'rows');
    // Attach a no-op catch immediately to prevent an unhandled-rejection warning
    // during the timer advance; we re-assert the rejection below.
    resultPromise.catch(() => {});

    await vi.advanceTimersByTimeAsync(2000);

    await expect(resultPromise).rejects.toThrow(YaoRateLimitError);

    vi.useRealTimers();
  });
});

// =============================================================================
// Error handling
// =============================================================================

describe('error handling', () => {
  async function authenticatedAdapter(): Promise<DataSourceAdapter> {
    mockFetch.mockResolvedValueOnce(makeResponse({ access_token: 'tok' }));
    const adapter = new DataSourceAdapter('firm-1');
    await adapter.authenticate();
    return adapter;
  }

  it('throws YaoAuthExpiredError on 401 mid-pull', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({}, 401));
    await expect(adapter.paginateGet('/matters', {}, 'rows')).rejects.toThrow(YaoAuthExpiredError);
  });

  it('throws YaoApiError on 500', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({}, 500));
    await expect(adapter.paginateGet('/matters', {}, 'rows')).rejects.toThrow(YaoApiError);
  });

  it('YaoApiError carries the status code', async () => {
    const adapter = await authenticatedAdapter();
    mockFetch.mockResolvedValueOnce(makeResponse({}, 503));
    try {
      await adapter.paginateGet('/matters', {}, 'rows');
    } catch (err) {
      expect(err).toBeInstanceOf(YaoApiError);
      expect((err as YaoApiError).statusCode).toBe(503);
    }
  });
});
