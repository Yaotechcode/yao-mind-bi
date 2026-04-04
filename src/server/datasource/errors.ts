/**
 * errors.ts — Custom error types for the Yao API client.
 */

/** Login request succeeded but credentials were rejected by the Yao API. */
export class YaoAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YaoAuthError';
  }
}

/**
 * Token was valid at authenticate() time but was rejected (401) during a
 * subsequent API call mid-pull. The pull should be aborted and rescheduled.
 */
export class YaoAuthExpiredError extends Error {
  constructor(message = 'Yao API token expired mid-pull') {
    super(message);
    this.name = 'YaoAuthExpiredError';
  }
}

/** The API returned a non-2xx, non-401, non-429 response. */
export class YaoApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'YaoApiError';
  }
}

/** The API returned 429 and the single retry also failed with 429. */
export class YaoRateLimitError extends Error {
  constructor(path: string) {
    super(`Rate limit exceeded after retry for path: ${path}`);
    this.name = 'YaoRateLimitError';
  }
}
