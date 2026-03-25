/**
 * rate-limiter.ts — In-memory sliding-window rate limiter
 *
 * Used by the formula-translate Netlify Function to cap translations at
 * max 10 per minute per firm to control Anthropic API costs.
 *
 * Note: In-memory state is lost between serverless function invocations.
 * For production multi-instance deployments, replace the Map with a
 * Redis/Supabase-backed store. The RateLimiter interface makes this easy.
 *
 * Design: injectable time function (Date.now) so tests can control time.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Present when allowed is false: milliseconds until the oldest request expires. */
  retryAfterMs?: number;
  /** How many requests remain in the current window. */
  remainingRequests: number;
}

export class TranslationRateLimiter {
  /** Keyed by firmId, value is array of request timestamps. */
  private readonly requests = new Map<string, number[]>();

  constructor(
    private readonly maxRequests: number = 10,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Check whether a firm is within the rate limit.
   * Does NOT record the request — call record() after a successful check.
   */
  check(firmId: string): RateLimitResult {
    const current = this.now();
    const windowStart = current - this.windowMs;
    const timestamps = this.pruned(firmId, windowStart);

    if (timestamps.length >= this.maxRequests) {
      // Oldest request expires at: timestamps[0] + windowMs
      const oldestExpiry = timestamps[0] + this.windowMs;
      return {
        allowed: false,
        retryAfterMs: oldestExpiry - current,
        remainingRequests: 0,
      };
    }

    return {
      allowed: true,
      remainingRequests: this.maxRequests - timestamps.length - 1,
    };
  }

  /** Record a translation request for rate-limiting purposes. */
  record(firmId: string): void {
    const current = this.now();
    const windowStart = current - this.windowMs;
    const timestamps = this.pruned(firmId, windowStart);
    this.requests.set(firmId, [...timestamps, current]);
  }

  /** Clear state for a firm (useful in tests). */
  clear(firmId?: string): void {
    if (firmId) {
      this.requests.delete(firmId);
    } else {
      this.requests.clear();
    }
  }

  // ---------------------------------------------------------------------------

  /** Return timestamps for firmId that fall within the window, pruning old ones. */
  private pruned(firmId: string, windowStart: number): number[] {
    const all = this.requests.get(firmId) ?? [];
    const active = all.filter((t) => t > windowStart);
    if (active.length !== all.length) {
      this.requests.set(firmId, active);
    }
    return active;
  }
}
